#include "v1-server.hpp"
#include <algorithm>
#include <array>
#include <stdexcept>
#include <utility>
#include <vector>

namespace ets2telemetry::v1 {
namespace {
using transport::Handle;
// The live loop runs at least every 10 ms: drain, expiry, inbound, one write.
constexpr ULONGLONG poll_ms = 10;
constexpr ULONGLONG snapshot_interval_ms = limits.snapshot_interval_ms, write_deadline_ms = limits.write_deadline_ms;
// Shutdown budget, measured from the stop request: `end` is written within 250 ms, and retained items only in its first
// 150 ms. Outside shutdown, `end` gets the ordinary write deadline and the items all but its last 100 ms.
constexpr ULONGLONG end_budget_ms = 250, end_items_ms = 150, end_reserve_ms = 100;
// After the channel's last eventSeq, its open loss run reaches the worker with the next frame_end flush.
constexpr ULONGLONG exhaustion_flush_ms = 250;
// The only game-log entry of the v1 endpoint, handed to the SDK thread (Caller sequence step 4).
const sdk::DeferredLog invariant_log{SCS_LOG_TYPE_error, "ETS2Telemetry: protocol v1 endpoint retired: invariant violation"};

// The v1 session cannot continue: `end` with this reason where a connection can still carry it, then the endpoint retires.
struct Retire : std::runtime_error {
  EndReason reason; bool log;
  Retire(EndReason r, bool l) : std::runtime_error("v1-retire"), reason(r), log(l) {}
};
// The outbound message seq of the plugin session is spent; nothing more, not even `end`, can be sent.
struct SequenceSpent : std::runtime_error { SequenceSpent() : std::runtime_error("v1-message-seq") {} };

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
std::atomic<std::int64_t> clock_offset_for_test{0};
#endif

struct Operation {
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)}; OVERLAPPED overlapped{};
  Operation() { if (!event) throw std::runtime_error("v1-io-event"); overlapped.hEvent = event.get(); }
};

// One overlapped read or write on the connected pipe, with the buffer it uses. Cancellation always observes completion
// (GetOverlappedResult with bWait) before the OVERLAPPED or the buffer is reused or released, including a CancelIoEx that
// races completion.
class Io final {
 public:
  enum class State { idle, pending, done, failed };
  explicit Io(HANDLE pipe) : pipe_(pipe), event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) { if (!event_) throw std::runtime_error("v1-io-event"); }
  ~Io() { cancel(); }
  Io(const Io&) = delete;
  Io& operator=(const Io&) = delete;
  HANDLE event() const noexcept { return event_.get(); }
  bool active() const noexcept { return active_; }
  ULONGLONG deadline() const noexcept { return deadline_; }
  bool read(std::uint8_t* buffer, DWORD size) noexcept { return begin(false, buffer, size, UINT64_MAX); }
  // The frame stays owned here until its completion has been observed.
  bool write(std::vector<std::uint8_t> frame, ULONGLONG deadline) noexcept {
    frame_ = std::move(frame); return begin(true, frame_.data(), static_cast<DWORD>(frame_.size()), deadline);
  }
  State poll(DWORD& transferred) noexcept {
    if (!active_) return State::idle;
    if (GetOverlappedResult(pipe_, &overlapped_, &transferred, FALSE)) { active_ = false; return State::done; }
    if (GetLastError() == ERROR_IO_INCOMPLETE) return State::pending;
    // Completed with an error, such as a departed client.
    active_ = false; return State::failed;
  }
  bool whole(DWORD transferred) const noexcept { return transferred == frame_.size(); }
  void cancel() noexcept {
    if (!active_) return;
    DWORD transferred = 0; CancelIoEx(pipe_, &overlapped_);
    GetOverlappedResult(pipe_, &overlapped_, &transferred, TRUE); active_ = false;
  }
 private:
  bool begin(bool write, std::uint8_t* buffer, DWORD size, ULONGLONG deadline) noexcept {
    overlapped_ = OVERLAPPED{}; overlapped_.hEvent = event_.get();
    const auto ok = write ? WriteFile(pipe_, buffer, size, nullptr, &overlapped_) : ReadFile(pipe_, buffer, size, nullptr, &overlapped_);
    // An immediate completion still signals the event and is reported by poll().
    if (!ok && GetLastError() != ERROR_IO_PENDING) return false;
    active_ = true; deadline_ = deadline; return true;
  }
  HANDLE pipe_; Handle event_; OVERLAPPED overlapped_{}; std::vector<std::uint8_t> frame_; bool active_ = false; ULONGLONG deadline_ = 0;
};
std::uint64_t saturating_increment(std::uint64_t value) noexcept { return value == UINT64_MAX ? value : value + 1; }
} // namespace

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
void set_clock_offset_for_test(std::int64_t offset_ns) noexcept { clock_offset_for_test.store(offset_ns); }
#endif

// One authorized client from its hello to its last frame. The worker owns it; the destructor closes the event gate, starts
// the retention window of a durable consumer and observes the completion of every operation before the run loop resets
// or closes the pipe.
struct Server::Connection {
  Connection(Server& s, HANDLE p, bool durable_events, transport::PeerIdentity identity)
    : server(s), pipe(p), durable(durable_events), peer(std::move(identity)), validator(s.plugin_session_id_, durable_events),
      inbound(p), outbound(p), pending(std::make_unique<sdk::V1Current>()), scratch(std::make_unique<sdk::V1Current>()) {}
  ~Connection() { close(); }
  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;
  Outcome run();

 private:
  enum class Phase { welcome, checkpoint, live };
  Outcome loop();
  bool receive();
  void handle(const Message&, std::uint64_t received_ns);
  bool send();
  void poll_state();
  bool write(Json wire) { return outbound.write(encode(std::move(wire)), GetTickCount64() + write_deadline_ms); }
  bool complete_write(ULONGLONG deadline);
  Outcome finish(EndReason, ULONGLONG deadline, ULONGLONG items_until);
  const window::Snapshot* window_now(window::Snapshot& storage) const noexcept;
  void close() noexcept;

  Server& server; HANDLE pipe; const bool durable; transport::PeerIdentity peer;
  AckValidator validator; FrameDecoder decoder{Sender::client};
  // Declared before the operations, so each operation observes its completion before this buffer is released.
  std::array<std::uint8_t, limits.client_frame_bytes + 4> input{};
  Io inbound, outbound;
  CaptureStamp capture;
  Phase phase = Phase::welcome; bool gate_open = false, finished = false, ended = false;
  // The probe whose reply is unsent, with its receipt time, and the last probe ID of this connection.
  std::optional<std::pair<std::uint64_t, std::uint64_t>> probe; std::uint64_t last_probe = 0;
  // One replaceable unsent snapshot (§7), and a scratch copy of the v1 slot.
  std::unique_ptr<sdk::V1Current> pending, scratch; bool has_pending = false;
  std::uint64_t sent_boundary = 0, sent_window_revision = 0; bool sent_window_available = false;
  ULONGLONG next_poll = 0, next_snapshot = 0;
};

Server::Outcome Server::Connection::run() {
  // OD-5 S6: the inbound read is posted at once, so a client byte sent before the checkpoint is observed.
  if (!inbound.read(input.data(), static_cast<DWORD>(input.size()))) return Outcome::reset;
  // Caller sequence step 2: connect the store before the gate opens, so every record copied for this consumer is
  // retained. A live-only client never connects the store; its events become noDurableConsumer coverage (OD-4).
  if (durable) server.store_->connect();
  server.channel_->set_gate(durable ? Gate::durable : Gate::live); gate_open = true;
  try { return loop(); }
  catch (const Retire& retire) {
    // An invariant violation or sequence exhaustion: `end` where the connection can carry it, then the endpoint retires.
    // A stop already requested keeps its 250 ms `end` budget.
    const auto now = GetTickCount64();
    auto deadline = now + write_deadline_ms, items_until = deadline - end_reserve_ms;
    if (const auto requested = server.stop_requested_.load()) {
      deadline = (std::min)(deadline, requested + end_budget_ms); items_until = (std::min)(items_until, requested + end_items_ms);
    }
    // A violation found while ending (the final drain) still logs.
    bool log = retire.log;
    try { finish(retire.reason, deadline, items_until); } catch (const Retire& later) { log = log || later.log; } catch (...) {}
    throw Retire(retire.reason, log);
  }
}

Server::Outcome Server::Connection::loop() {
  for (;;) {
    if (server.stopped()) {
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
      // Console tests hold the worker here, after its last loop drain and before the shutdown drain in finish().
      transport::transport_test_hook("v1-finish", nullptr, server.stop_event_.get());
#endif
      const auto requested = server.stop_requested_.load();
      return finish(EndReason::plugin_shutdown, requested + end_budget_ms, requested + end_items_ms);
    }
    // The inspected peer process is rechecked while connected: an exit or a reused PID ends the connection.
    if (WaitForSingleObject(peer.process.get(), 0) != WAIT_TIMEOUT || transport::creation_time(peer.process.get()) != peer.creation) return Outcome::reset;
    server.tick();
    DWORD transferred = 0; const auto state = outbound.poll(transferred);
    // One write in flight with a 1 s deadline; the destructor cancels it and observes its completion.
    if (state == Io::State::failed || (state == Io::State::done && !outbound.whole(transferred))) return Outcome::reset;
    if (state == Io::State::pending && GetTickCount64() >= outbound.deadline()) return Outcome::reset;
    server.write_pending_.store(state == Io::State::pending);
    if (!receive()) return Outcome::reset;
    // Writes that complete at once (the kernel buffer has room) continue the burst, up to 32 per iteration, so delivery
    // does not wait for the next drain. A pending write ends it; the poll above then tracks its deadline.
    for (unsigned burst = 0; burst < 32 && !outbound.active(); ++burst) {
      if (!send()) return Outcome::reset;
      if (!outbound.active()) break;
      const auto written = outbound.poll(transferred);
      if (written == Io::State::failed || (written == Io::State::done && !outbound.whole(transferred))) return Outcome::reset;
    }
    HANDLE waits[]{server.stop_event_.get(), inbound.event(), outbound.event()};
    WaitForMultipleObjects(outbound.active() ? 3 : 2, waits, FALSE, static_cast<DWORD>(poll_ms));
  }
}

bool Server::Connection::receive() {
  DWORD bytes = 0; const auto state = inbound.poll(bytes);
  if (state == Io::State::pending) return true;
  // EOF, a failed read and (OD-5 S6) any client byte before the checkpoint end the connection.
  if (state != Io::State::done || !bytes || phase != Phase::live) return false;
  // The receipt time of a clock probe is taken when its read completion is observed.
  const auto received_ns = server.now_ns();
  decoder.push(input.data(), bytes, [&](Message m) { handle(m, received_ns); });
  return inbound.read(input.data(), static_cast<DWORD>(input.size()));
}

void Server::Connection::handle(const Message& m, std::uint64_t received_ns) {
  if (m.kind == "ack") {
    // AckValidator rejects every ACK of a live-only client, a foreign session, an ACK beyond the written coverage and a
    // regression; receipt is never an ACK. An accepted ACK releases whole entries only (decision (c)).
    if (const auto through = validator.accept(m))
      if (!server.store_->release(*through)) throw Retire(EndReason::source_retired, true);
    return;
  }
  if (m.kind == "clock.probe") {
    // The producer-side probe check: after the checkpoint and at the connection minor (ET-050b B1).
    const auto id = validator.probe(m);
    // OD-5 S6: probe IDs strictly increase, and no probe may arrive while the reply to the previous one is unsent.
    if (id <= last_probe || probe) throw ProtocolError("v1-clock-probe");
    last_probe = id; probe = std::make_pair(id, received_ns); return;
  }
  // After the checkpoint the client sends only ack and clock.probe (OD-5 S6).
  throw ProtocolError("v1-client-message");
}

const window::Snapshot* Server::Connection::window_now(window::Snapshot& storage) const noexcept {
  if (!server.monitor_) return nullptr;
  storage = server.monitor_->latest(); return &storage;
}

void Server::Connection::poll_state() {
  const auto now = GetTickCount64();
  if (now < next_poll) return;
  next_poll = now + snapshot_interval_ms;
  if (!server.adapter_.read_v1_current(*scratch)) return;
  if (scratch->source_retired || scratch->exhausted || !scratch->active) throw Retire(EndReason::source_retired, false);
  window::Snapshot storage; const auto* w = window_now(storage);
  const auto window_available = window_field(*scratch, w, server.process_creation_, now).available();
  const auto window_revision = w ? w->revision : 0;
  if (scratch->state.boundary_order == sent_boundary && window_revision == sent_window_revision && window_available == sent_window_available) return;
  // A later publication replaces the unsent snapshot, and the replacement is counted (§7).
  if (has_pending && scratch->state.boundary_order != pending->state.boundary_order) server.coalesced_ = saturating_increment(server.coalesced_);
  std::swap(pending, scratch); has_pending = true;
}

bool Server::Connection::send() {
  auto& store = *server.store_; const auto& encoder = *server.encoder_;
  if (phase == Phase::welcome) {
    auto info = server.welcome_; info.durable_events = durable;
    if (!write(encoder.welcome(server.next_seq(), capture.stamp(server.now_ns()), info))) return false;
    phase = Phase::checkpoint; return true;
  }
  if (phase == Phase::checkpoint) {
    // OD-5 S6: a client byte that arrived before the checkpoint is issued ends the connection.
    if (WaitForSingleObject(inbound.event(), 0) == WAIT_OBJECT_0) return false;
    // One coherent copy of the v1 slot, the monitor's latest window and the store's status (OD-5 S11).
    if (!server.adapter_.read_v1_current(*pending) || pending->source_retired || pending->exhausted || !pending->active)
      throw Retire(EndReason::source_retired, false);
    const auto now = GetTickCount64(); window::Snapshot storage; const auto* w = window_now(storage);
    pending->state.window = window_field(*pending, w, server.process_creation_, now);
    StatusInfo info; info.durable = durable; info.delivery = store.status(); info.continuity = continuity(*pending, server.coalesced_);
    if (!write(encoder.checkpoint(server.next_seq(), capture.stamp(server.now_ns(), info.delivery.oldest_retained_ns.value_or(0)), pending->state, info))) return false;
    validator.checkpoint(info.delivery.acked_through_event_seq);
    sent_boundary = pending->state.boundary_order; sent_window_revision = w ? w->revision : 0; sent_window_available = pending->state.window.available();
    next_poll = next_snapshot = now + snapshot_interval_ms; phase = Phase::live;
    server.hydrations_.fetch_add(1); server.status_.store(ServerStatus::connected);
    return true;
  }
  if (probe) {
    // received <= sent <= capture: the send time is the encode time, which is the capture time.
    const auto sent = capture.stamp(server.now_ns(), probe->second);
    if (!write(encoder.clock_reply(server.next_seq(), sent, probe->first, probe->second, sent))) return false;
    probe.reset(); return true;
  }
  poll_state();
  const auto now = GetTickCount64();
  if (has_pending && now >= next_snapshot) {
    window::Snapshot storage; const auto* w = window_now(storage);
    pending->state.window = window_field(*pending, w, server.process_creation_, now);
    StatusInfo info; info.durable = durable; info.delivery = store.status(); info.continuity = continuity(*pending, server.coalesced_);
    if (!write(encoder.snapshot(server.next_seq(), capture.stamp(server.now_ns(), info.delivery.oldest_retained_ns.value_or(0)), pending->state, info))) return false;
    sent_boundary = pending->state.boundary_order; sent_window_revision = w ? w->revision : 0; sent_window_available = pending->state.window.available();
    has_pending = false; next_snapshot = now + snapshot_interval_ms;
    return true;
  }
  // Caller sequence step 5: durable connections only, in coverage order. Returning an item marks it written (OD-5 S9).
  if (!durable) return true;
  const auto item = store.next_outbound();
  if (!item) return true;
  std::vector<std::uint8_t> frame;
  try { frame = encode(encoder.outbound(server.next_seq(), capture.stamp(server.now_ns(), carried_ns(*item)), *item)); }
  catch (const SequenceSpent&) { throw; }
  // A retained item that cannot be encoded would leave a hole in this connection's coverage.
  catch (...) { throw Retire(EndReason::source_retired, true); }
  if (!outbound.write(std::move(frame), now + write_deadline_ms)) return false;
  validator.sent(item->last_event_seq());
  return true;
}

bool Server::Connection::complete_write(ULONGLONG deadline) {
  for (;;) {
    DWORD transferred = 0; const auto state = outbound.poll(transferred);
    if (state == Io::State::idle) return true;
    if (state == Io::State::done) return outbound.whole(transferred);
    if (state == Io::State::failed) return false;
    // Once a stop is requested, the 250 ms `end` budget bounds every wait, also one that started before the request.
    auto limit = deadline;
    if (const auto requested = server.stop_requested_.load()) limit = (std::min)(limit, requested + end_budget_ms);
    const auto now = GetTickCount64();
    if (now >= limit) { outbound.cancel(); return false; }
    WaitForSingleObject(outbound.event(), static_cast<DWORD>((std::min)(limit - now, poll_ms)));
  }
}

Server::Outcome Server::Connection::finish(EndReason reason, ULONGLONG deadline, ULONGLONG items_until) {
  // finish() runs once per connection: a later call never writes again, whether the first one wrote `end`, cut a frame
  // or wrote nothing. A cancelled write may have left a partial frame, and nothing may follow it.
  if (finished) return ended ? Outcome::ended : Outcome::reset;
  finished = true;
  // An in-flight write may complete within the budget. A cancelled write may have cut a frame, so then nothing follows.
  if (!complete_write(deadline)) return Outcome::reset;
  // Before the welcome there is nothing to end; `end` may replace the checkpoint (§4).
  if (phase == Phase::welcome) return Outcome::reset;
  // Records already in the ring become store coverage until the item cut-off; a record still in the ring after it, like a
  // run still open in the channel, is plugin-exit loss at or above the reported nextEventSeq (OD-5 S11).
  // A violation found by this final drain still retires the endpoint and logs: `end` then carries source-retired, and
  // no further item is written, because the store's coverage stopped before the rejected record.
  std::optional<Retire> violation;
  try { server.drain(server.now_ns(), items_until, false); }
  catch (const Retire& retire) { violation = retire; reason = EndReason::source_retired; }
  catch (...) {}
  const auto outcome = [&] {
    auto& store = *server.store_; const auto& encoder = *server.encoder_;
    if (durable && phase == Phase::live && reason != EndReason::source_retired) {
      // Best effort: retained items the consumer has not received yet, while the budget allows. Never waits for an ACK (D14).
      while (GetTickCount64() < items_until) {
        const auto item = store.next_outbound();
        if (!item) break;
        std::vector<std::uint8_t> frame;
        try { frame = encode(encoder.outbound(server.next_seq(), capture.stamp(server.now_ns(), carried_ns(*item)), *item)); } catch (...) { break; }
        if (!outbound.write(std::move(frame), deadline)) return Outcome::reset;
        validator.sent(item->last_event_seq());
        if (!complete_write(deadline)) return Outcome::reset;
      }
    }
    auto end = encode(encoder.end(server.next_seq(), capture.stamp(server.now_ns()), reason, store.end_cursor()));
    server.end_attempts_.fetch_add(1);
    if (!outbound.write(std::move(end), deadline) || !complete_write(deadline))
      return Outcome::reset;
    ended = true; server.ends_.fetch_add(1);
    return Outcome::ended;
  }();
  if (violation) throw *violation;
  return outcome;
}

void Server::Connection::close() noexcept {
  // Caller sequence step 2: the gate closes first, then the durable consumer's retention window starts, then the pipe
  // is reset by the run loop.
  if (gate_open) {
    server.channel_->set_gate(Gate::none); gate_open = false;
    if (durable) {
      std::uint64_t now = capture.last();
      try { now = server.now_ns(); } catch (...) {}
      server.store_->disconnect(now);
    }
  }
  outbound.cancel(); inbound.cancel(); server.write_pending_.store(false);
}

Server::~Server() { stop(); }

EventChannel* Server::prepare() noexcept {
  try {
    if (worker_.joinable()) return nullptr;
    if (!channel_) channel_ = std::make_unique<EventChannel>();
    // A fresh store per plugin session: its coverage restarts at eventSeq 1 with the channel (§9).
    store_ = std::make_unique<EventStore>(); encoder_.reset();
    if (!channel_->prepare()) return nullptr;
    seq_ = 0; coalesced_ = 0; exhausted_since_ = 0;
    return channel_.get();
  } catch (...) { return nullptr; }
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
bool Server::skip_store_for_test(std::uint64_t next) noexcept {
  if (worker_.joinable() || !store_ || next <= store_->next_event_seq()) return false;
  return store_->lose(store_->next_event_seq(), next - 1, LossCause::offline, std::nullopt, std::nullopt, 0);
}
#endif

bool Server::start(std::wstring directory, const window::Monitor* monitor) noexcept {
  try {
    if (worker_.joinable() || !channel_ || !channel_->prepared() || !store_) return false;
    monitor_ = monitor; process_creation_ = transport::creation_time(GetCurrentProcess());
    stop_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!stop_event_) throw std::runtime_error("v1-stop-event");
    shutdown_ms_.store(0); stop_requested_.store(0); deadline_exceeded_.store(false); write_pending_.store(false);
    status_.store(ServerStatus::starting);
    worker_ = std::thread([this, directory = std::move(directory)] { run(directory); });
    return true;
  } catch (...) { monitor_ = nullptr; status_.store(ServerStatus::failed); stop_event_.reset(); return false; }
}

void Server::signal_stop() noexcept {
  if (!worker_.joinable() || !stop_event_) return;
  std::uint64_t expected = 0; stop_requested_.compare_exchange_strong(expected, GetTickCount64());
  SetEvent(stop_event_.get());
}

void Server::stop() noexcept {
  try {
    if (!worker_.joinable()) return;
    signal_stop();
    // Policy and image inspection may perform synchronous reads on this owned worker only. A read can start after a
    // cancellation request, so the request is repeated until this exact worker exits; join still owns its lifetime.
    // Outside an inspection window nothing is cancelled: the exit path's record deletion must complete.
    cancel_window_.cancel(worker_.native_handle());
    while (WaitForSingleObject(worker_.native_handle(), 10) == WAIT_TIMEOUT) cancel_window_.cancel(worker_.native_handle());
    worker_.join();
    // Diagnostics only, recorded after the mandatory join: the deadline never releases ownership early.
    const auto elapsed = GetTickCount64() - stop_requested_.load();
    shutdown_ms_.store(elapsed); deadline_exceeded_.store(elapsed > 1000);
    monitor_ = nullptr; stop_event_.reset(); write_pending_.store(false);
    const auto current = status_.load();
    if (current != ServerStatus::failed && current != ServerStatus::retired) status_.store(ServerStatus::stopped);
  } catch (...) { status_.store(ServerStatus::failed); }
}

std::wstring Server::endpoint() const { std::lock_guard<std::mutex> lock(endpoint_mutex_); return endpoint_; }

bool Server::stopped() const noexcept { return WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0; }

std::uint64_t Server::now_ns() const {
  std::uint64_t value = 0;
  if (!adapter_.source_monotonic_ns(value)) throw std::runtime_error("v1-source-clock");
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
  const auto offset = clock_offset_for_test.load();
  if (offset >= 0) value = value > UINT64_MAX - static_cast<std::uint64_t>(offset) ? UINT64_MAX : value + static_cast<std::uint64_t>(offset);
  else { const auto back = static_cast<std::uint64_t>(-(offset + 1)) + 1; value = value > back ? value - back : 0; }
#endif
  return value;
}

std::uint64_t Server::next_seq() { if (seq_ == UINT64_MAX) throw SequenceSpent(); return ++seq_; }

void Server::drain(std::uint64_t now, ULONGLONG until, bool yield_to_stop) {
  // At most one ring's worth per call, so the loop still services its I/O every poll interval. Each drained record is
  // measured by a full encode, so the stop and time bounds are checked between slots, after the first one.
  for (std::size_t i = 0; i < channel_slots; ++i) {
    if (i && ((yield_to_stop && stopped()) || GetTickCount64() >= until)) return;
    const auto* slot = channel_->front();
    if (!slot) return;
    if (slot->has_loss) {
      // Caller sequence step 3: one lose() per nonzero cause in a fixed order, each with the run's lost times. The parts
      // are contiguous, so the store merges them into one gap record with exact counts.
      const auto& run = slot->loss_before;
      const auto first_ns = run.times_available ? std::optional<std::uint64_t>(run.first_lost_ns) : std::nullopt;
      const auto last_ns = run.times_available ? std::optional<std::uint64_t>(run.last_lost_ns) : std::nullopt;
      const std::pair<LossCause, std::uint64_t> parts[]{{LossCause::offline, run.causes.offline},
        {LossCause::no_durable_consumer, run.causes.no_durable_consumer}, {LossCause::queue_count, run.causes.queue_count}};
      auto first = run.first_event_seq;
      for (const auto& part : parts) {
        if (!part.second) continue;
        // Caller sequence step 4: `rejected` cannot happen while this order is kept; it is an invariant violation.
        if (!store_->lose(first, first + part.second - 1, part.first, first_ns, last_ns, now)) throw Retire(EndReason::source_retired, true);
        first += part.second;
      }
    }
    if (slot->has_record && ingest_event(*store_, *encoder_, slot->record, now) == Ingest::rejected) throw Retire(EndReason::source_retired, true);
    channel_->pop();
  }
}

void Server::tick() {
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
  // Console tests hold the worker here, so callbacks fill the ring while nothing drains it.
  transport::transport_test_hook("v1-tick", nullptr, stop_event_.get());
#endif
  const auto now = now_ns();
  drain(now, UINT64_MAX, true);
  store_->expire(now);
  if (channel_->exhausted()) {
    // §9: after the last eventSeq the session ends with sequence-exhausted. The store is given a short time to record the
    // channel's last loss run, which the next frame_end flushes.
    const auto t = GetTickCount64();
    if (!exhausted_since_) exhausted_since_ = t;
    if (store_->exhausted() || t - exhausted_since_ >= exhaustion_flush_ms) throw Retire(EndReason::sequence_exhausted, false);
  }
}

bool Server::wait_io(HANDLE pipe, OVERLAPPED& operation, DWORD& transferred, ULONGLONG deadline) {
  for (;;) {
    if (GetOverlappedResult(pipe, &operation, &transferred, FALSE)) return true;
    if (GetLastError() != ERROR_IO_INCOMPLETE) return false;
    if (stopped() || GetTickCount64() >= deadline) {
      CancelIoEx(pipe, &operation);
      // ERROR_NOT_FOUND can race completion: completion is observed before the OVERLAPPED or its buffer is released.
      GetOverlappedResult(pipe, &operation, &transferred, TRUE); return false;
    }
    // The ring is drained while the worker waits for a client or its hello.
    try { tick(); } catch (...) { CancelIoEx(pipe, &operation); GetOverlappedResult(pipe, &operation, &transferred, TRUE); throw; }
    const auto now = GetTickCount64();
    HANDLE handles[]{operation.hEvent, stop_event_.get()};
    WaitForMultipleObjects(2, handles, FALSE, static_cast<DWORD>((std::min)(poll_ms, deadline > now ? deadline - now : 0)));
  }
}

Server::Outcome Server::serve(HANDLE pipe, const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user) {
  const auto hello_deadline = GetTickCount64() + limits.hello_timeout_ms;
  ULONG pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid)) return Outcome::reset;
  // The v0 connected-peer authority (§12): token user, Windows session and the protected v1 service policy. These reads
  // are the worker's only synchronous I/O that stop() cancels.
  transport::PeerIdentity peer; std::vector<transport::AllowedPeer> policy;
  {
    transport::CancelWindow::Scope window(cancel_window_);
    peer = transport::inspect_peer(pid, stop_event_.get());
    if (peer.sid != user.sid || peer.session != user.session) return Outcome::reset;
    policy = transport::read_service_policy(directory, security, user, stop_event_.get());
  }
  bool allowed = false;
  for (const auto& candidate : policy) if (!_wcsicmp(candidate.image.c_str(), peer.image.c_str()) && candidate.sha256 == peer.sha256) allowed = true;
  if (!allowed || GetTickCount64() >= hello_deadline) return Outcome::reset;
  // The 4,096-byte client bound is enforced at the prefix, before a larger payload is retained. A byte beyond the hello
  // in the same read is a violation (OD-5 S6).
  std::array<std::uint8_t, limits.client_frame_bytes + 4> hello{}; std::size_t received = 0; std::uint32_t length = 0;
  while (!length || received < static_cast<std::size_t>(length) + 4) {
    Operation read; DWORD bytes = 0;
    const auto ok = ReadFile(pipe, hello.data() + received, static_cast<DWORD>(hello.size() - received), &bytes, &read.overlapped);
    if (!ok && GetLastError() != ERROR_IO_PENDING) return Outcome::reset;
    if (!ok && !wait_io(pipe, read.overlapped, bytes, hello_deadline)) return Outcome::reset;
    if (!bytes) return Outcome::reset;
    received += bytes;
    if (received >= 4) {
      length = static_cast<std::uint32_t>(hello[0]) | (static_cast<std::uint32_t>(hello[1]) << 8) | (static_cast<std::uint32_t>(hello[2]) << 16) | (static_cast<std::uint32_t>(hello[3]) << 24);
      if (!length || length > limits.client_frame_bytes || received > static_cast<std::size_t>(length) + 4) return Outcome::reset;
    }
  }
  // Another major, another envelope minor or any other kind closes the connection without an error frame (§2).
  const auto message = decode_payload(std::string(reinterpret_cast<const char*>(hello.data()) + 4, length), Sender::client);
  if (message.kind != "hello") return Outcome::reset;
  Connection connection(*this, pipe, negotiate(message).durable_events, std::move(peer));
  return connection.run();
}

void Server::run(std::wstring directory) noexcept {
  try {
    const auto user = transport::current_user(); transport::OwnerSecurity security(user.sid);
    if (directory.empty()) directory = transport::local_transport_directory(security, L"v1"); else security.ensure_directory(directory);
    auto source = std::make_unique<sdk::Snapshot>(); auto current = std::make_unique<sdk::V1Current>();
    if (!adapter_.read_current(*source) || source->source_retired || source->identity.windows_session_id != user.session) throw std::runtime_error("v1-source-identity");
    if (!adapter_.read_v1_current(*current) || current->source_retired || std::string(current->identity.plugin_session_id.c_str()) != source->identity.plugin_session_id.c_str())
      throw std::runtime_error("v1-source-identity");
    encoder_.emplace(session_identity(current->identity, origin_)); welcome_ = welcome_info(*current, false);
    plugin_session_id_ = current->identity.plugin_session_id.c_str();
    const auto name = transport::endpoint_name(*source, user, protocol_major);
    // One instance, remote clients rejected, an explicit protected current-user DACL; a pre-existing endpoint is never adopted.
    Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, 65540, 0, security.attributes()));
    if (!pipe) throw std::runtime_error("v1-endpoint-collision");
    // A foreign record is never overwritten: publication fails and the endpoint closes.
    transport::Discovery discovery(directory, security, user, *source, name, protocol_major);
    source.reset(); current.reset();
    { std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_ = name; }
    while (!stopped()) {
      status_.store(ServerStatus::listening);
      Operation connect; DWORD transferred = 0;
      auto connected = ConnectNamedPipe(pipe.get(), &connect.overlapped);
      auto error = connected ? ERROR_SUCCESS : GetLastError();
      if (!connected && error == ERROR_IO_PENDING) {
        connected = wait_io(pipe.get(), connect.overlapped, transferred, UINT64_MAX);
        // The completion failure is saved before anything else can change last-error.
        error = connected ? ERROR_SUCCESS : GetLastError();
      } else if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
      if (!connected) {
        if (stopped()) break;
        // A client that left before acceptance owns only that connection, never the endpoint.
        if (error != ERROR_NO_DATA && error != ERROR_BROKEN_PIPE) throw std::runtime_error("v1-endpoint-accept");
        if (!DisconnectNamedPipe(pipe.get()) && GetLastError() != ERROR_PIPE_NOT_CONNECTED) throw std::runtime_error("v1-endpoint-reset");
        continue;
      }
      if (stopped()) break;
      auto outcome = Outcome::reset;
      try { outcome = serve(pipe.get(), directory, security, user); }
      catch (const Retire&) { throw; }
      catch (const SequenceSpent&) { throw; }
      catch (...) { /* A rejected, malformed or failed client retires only its connection. */ }
      // After `end` the handle is closed instead: DisconnectNamedPipe would discard bytes the client has not read yet.
      if (outcome == Outcome::ended || stopped()) break;
      if (!DisconnectNamedPipe(pipe.get()) && GetLastError() != ERROR_PIPE_NOT_CONNECTED) throw std::runtime_error("v1-endpoint-reset");
    }
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    // Console tests run synchronous I/O here, in the exit path that next deletes the discovery record.
    transport::transport_test_hook("v1-exit", nullptr, stop_event_.get());
#endif
  } catch (const Retire& retire) {
    // Only this endpoint retires; v0 and CAP0 continue. The fixed log entry is written by the SDK thread.
    status_.store(ServerStatus::retired);
    if (retire.log) adapter_.defer_log(&invariant_log, sdk::DeferredLogSlot::transport_v1);
  } catch (const SequenceSpent&) {
    status_.store(ServerStatus::retired);
  } catch (...) {
    // Startup and runtime failures are fail-closed and not reported to the game (OD-2).
    status_.store(ServerStatus::failed);
  }
  // Without a worker the callbacks keep only state and loss counters.
  if (channel_) channel_->set_gate(Gate::none);
  write_pending_.store(false);
  std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_.clear();
}
} // namespace ets2telemetry::v1
