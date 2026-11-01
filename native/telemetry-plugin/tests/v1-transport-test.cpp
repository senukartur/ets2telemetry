// Protocol v1 endpoint controls (ET-004b). Fake SDK callbacks, isolated temporary directories and actual local Windows
// pipes only; no game, game directory or user history is touched, and %LOCALAPPDATA% is never used. The controlled client
// is the ET-002b C++ Consumer and DurableAckCursor; expected values are written by hand from docs/protocol/v1.md and
// docs/native-transport-v1.md.
#include "channel-identity.hpp"
#include "v1-server.hpp"
#include "pipe-server.hpp"
#include "capture-server.hpp"
#include "capture-wire.hpp"
#include "snapshot-wire.hpp"
#include "protocol-json.hpp"
#include "native-fuzz-multiplier.hpp"
#include "common/scssdk_telemetry_common_gameplay_events.h"
#include <psapi.h>
#include <tlhelp32.h>
#include <objbase.h>
#include <sddl.h>
#include <array>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

using namespace ets2telemetry;
using transport::Handle;

namespace ets2telemetry::v1 {
// Test-only access to the SDK-thread side of the channel: moves the next eventSeq close to the end of the range.
struct EventChannelTestAccess {
  static void set_next(EventChannel& channel, std::uint64_t next) { channel.assigned_next_.store(next); }
};
}

namespace {
unsigned assertions = 0;
// Sanitized builds on small hosted runners are slower; functional assertions are unchanged, only wall-clock bounds widen.
#if defined(__SANITIZE_ADDRESS__)
constexpr ULONGLONG timing_scale = 3;
#else
constexpr ULONGLONG timing_scale = 1;
#endif
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
bool until(const std::function<bool()>& predicate, ULONGLONG ms = 3000) {
  const auto end = GetTickCount64() + ms * timing_scale; do { if (predicate()) return true; Sleep(2); } while (GetTickCount64() < end); return false;
}

// Fake official SDK host. Every SDK API entry records whether it ran on the SDK caller thread.
struct Host {
  static Host* active;
  std::thread::id caller = std::this_thread::get_id(); std::atomic<unsigned> wrong_thread{0};
  std::vector<std::string> logs; std::vector<scs_log_type_t> log_types;
  std::map<scs_event_t, std::pair<scs_telemetry_event_callback_t, scs_context_t>> events;
  struct Channel { scs_telemetry_channel_callback_t cb; scs_context_t ctx; };
  std::map<std::string, Channel> channels; std::uint64_t frames = 0;
  // ET-052: the value `mandatory.break` delivers in every frame (nothing when unset; NULL when `break_null`), and a channel name the host refuses with not_found.
  std::optional<std::int32_t> break_minutes; bool break_null = false; std::string refuse;
  Host() { active = this; }
  static void check() { if (active->caller != std::this_thread::get_id()) ++active->wrong_thread; }
  static SCSAPI_VOID log(scs_log_type_t type, scs_string_t message) { check(); active->log_types.push_back(type); active->logs.emplace_back(message); }
  static SCSAPI_RESULT reg_event(scs_event_t id, scs_telemetry_event_callback_t cb, scs_context_t ctx) { check(); active->events[id] = {cb, ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_event(scs_event_t id) { check(); active->events.erase(id); return SCS_RESULT_ok; }
  static SCSAPI_RESULT reg_channel(scs_string_t name, scs_u32_t, scs_value_type_t, scs_u32_t, scs_telemetry_channel_callback_t cb, scs_context_t ctx) {
    check(); if (name == active->refuse) return SCS_RESULT_not_found;
    active->channels[name] = {cb, ctx}; return SCS_RESULT_ok;
  }
  static SCSAPI_RESULT unreg_channel(scs_string_t name, scs_u32_t, scs_value_type_t) { check(); active->channels.erase(name); return SCS_RESULT_ok; }
  scs_telemetry_init_params_v100_t params(const char* game = "eut2") {
    scs_telemetry_init_params_v100_t p{}; p.common.game_id = game; p.common.game_version = SCS_MAKE_VERSION(1, 20); p.common.log = log;
    p.register_for_event = reg_event; p.unregister_from_event = unreg_event; p.register_for_channel = reg_channel; p.unregister_from_channel = unreg_channel; return p;
  }
  void event(scs_event_t id, const void* value = nullptr) { auto entry = events.at(id); entry.first(id, value, entry.second); }
  void channel(const char* name, const scs_value_t& v) { const auto entry = channels.at(name); entry.cb(name, SCS_U32_NIL, &v, entry.ctx); }
  // One frame: frame_start, the speed channel and frame_end, which flushes an open loss run and publishes both slots.
  void frame(float speed = 10) {
    scs_telemetry_frame_start_t f{}; f.render_time = f.simulation_time = f.paused_simulation_time = ++frames * 50000;
    event(SCS_TELEMETRY_EVENT_frame_start, &f);
    scs_value_t v{}; v.type = SCS_VALUE_TYPE_float; v.value_float.value = speed; channel("truck.speed", v);
    if (channels.count("mandatory.break")) {
      if (break_null) { const auto entry = channels.at("mandatory.break"); entry.cb("mandatory.break", SCS_U32_NIL, nullptr, entry.ctx); }
      else if (break_minutes) { scs_value_t b{}; b.type = SCS_VALUE_TYPE_s32; b.value_s32.value = *break_minutes; channel("mandatory.break", b); }
    }
    event(SCS_TELEMETRY_EVENT_frame_end);
  }
  void config(const char* id, const scs_named_value_t* attributes) { scs_telemetry_configuration_t c{id, attributes}; event(SCS_TELEMETRY_EVENT_configuration, &c); }
  void gameplay(const char* id, const scs_named_value_t* attributes) { scs_telemetry_gameplay_event_t g{id, attributes}; event(SCS_TELEMETRY_EVENT_gameplay, &g); }
};
Host* Host::active = nullptr;
scs_value_t value_of(scs_value_type_t type) { scs_value_t v{}; v.type = type; return v; }
scs_value_t text(const char* s) { auto v = value_of(SCS_VALUE_TYPE_string); v.value_string.value = s; return v; }
scs_value_t s64(std::int64_t n) { auto v = value_of(SCS_VALUE_TYPE_s64); v.value_s64.value = n; return v; }
scs_value_t u32(std::uint32_t n) { auto v = value_of(SCS_VALUE_TYPE_u32); v.value_u32.value = n; return v; }
scs_named_value_t named(const char* name, scs_value_t value) { scs_named_value_t n{}; n.name = name; n.index = SCS_U32_NIL; n.value = value; return n; }
scs_named_value_t indexed(const char* name, scs_value_t value, scs_u32_t index) { auto n = named(name, value); n.index = index; return n; }
// Gameplay events of one fixed shape: job.cancelled with a penalty.
struct Penalty { scs_named_value_t attributes[2]; explicit Penalty(std::int64_t amount) : attributes{named("cancel.penalty", s64(amount)), scs_named_value_t{}} {} };
void cancelled(Host& host, unsigned count, std::int64_t amount = 5) { Penalty p(amount); for (unsigned i = 0; i < count; ++i) host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled, p.attributes); }
// Text at the D12 limits for large configuration records; the borrowed SDK strings must outlive every callback.
const std::string long_id(128, 'c'), long_name_n(256, 'n'), long_name_s(256, 's'), long_name_d(256, 'd'), long_name_o(256, 'o');

std::string utf8(const std::wstring& w) { const auto n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr); std::string s(static_cast<std::size_t>(n), '\0'); WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr); return s; }
std::wstring wide(const std::string& s) { return std::wstring(s.begin(), s.end()); }
void write_file(const std::wstring& path, const transport::OwnerSecurity& security, const std::string& bytes) {
  Handle f(CreateFileW(path.c_str(), GENERIC_WRITE, 0, security.attributes(), CREATE_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(static_cast<bool>(f), "fixture file create"); DWORD written = 0; require(WriteFile(f.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size(), "fixture file write");
}
void write_policy(const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user, const transport::PeerIdentity& peer, const std::string& digest = "") {
  v0::Json j{v0::Json::Object{{"schemaVersion", v0::Json{1.0}}, {"userTag", v0::Json{user.tag}}, {"windowsSessionId", v0::Json{static_cast<double>(user.session)}},
    {"allowedExecutables", v0::Json{v0::Json::Array{v0::Json{v0::Json::Object{{"path", v0::Json{utf8(peer.image)}}, {"sha256", v0::Json{digest.empty() ? peer.sha256 : digest}}}}}}}}};
  write_file(directory + L"\\service-policy.json", security, v0::detail::serialize(j));
}
std::wstring temporary_directory(const transport::OwnerSecurity& security, const wchar_t* prefix) {
  WCHAR temporary[MAX_PATH]{}; require(GetTempPathW(MAX_PATH, temporary) > 0, "temp path"); GUID id{}; require(CoCreateGuid(&id) == S_OK, "guid"); WCHAR label[40]{}; StringFromGUID2(id, label, 40);
  const auto directory = std::wstring(temporary) + prefix + label; security.ensure_directory(directory); return directory;
}
// Removes the files of one owned temporary directory, then the directory.
void remove_directory(const std::wstring& directory) {
  WIN32_FIND_DATAW data{}; const auto find = FindFirstFileW((directory + L"\\*").c_str(), &data);
  if (find != INVALID_HANDLE_VALUE) {
    do { const std::wstring name = data.cFileName; if (name != L"." && name != L"..") DeleteFileW((directory + L"\\" + name).c_str()); } while (FindNextFileW(find, &data));
    FindClose(find);
  }
  RemoveDirectoryW(directory.c_str());
}
std::vector<std::uint8_t> framed(const std::string& payload) {
  const auto n = static_cast<std::uint32_t>(payload.size());
  std::vector<std::uint8_t> out{static_cast<std::uint8_t>(n), static_cast<std::uint8_t>(n >> 8), static_cast<std::uint8_t>(n >> 16), static_cast<std::uint8_t>(n >> 24)};
  out.insert(out.end(), payload.begin(), payload.end()); return out;
}
// A hello is always version 1.0; `max_minor` is the highest minor it offers. ACKs and probes carry the connection minor.
std::string hello_payload(bool durable, unsigned max_minor = 0) {
  return std::string("{\"version\":{\"major\":1,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"50000000-0000-4000-8000-000000000001\",\"minMinor\":0,\"maxMinor\":") +
    std::to_string(max_minor) + ",\"durableEvents\":" + (durable ? "true" : "false") + "}}";
}
std::string ack_payload(const std::string& session, std::uint64_t through, unsigned minor = 0) {
  return "{\"version\":{\"major\":1,\"minor\":" + std::to_string(minor) + "},\"kind\":\"ack\",\"data\":{\"pluginSessionId\":\"" + session + "\",\"throughEventSeq\":\"" + std::to_string(through) + "\"}}";
}
std::string probe_payload(std::uint64_t id, unsigned minor = 0) { return "{\"version\":{\"major\":1,\"minor\":" + std::to_string(minor) + "},\"kind\":\"clock.probe\",\"data\":{\"probeId\":\"" + std::to_string(id) + "\"}}"; }
const char* v0_hello = "{\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"00000000-0000-4000-8000-000000000001\",\"minMinor\":0,\"maxMinor\":0,\"diagnostics\":true}}";

enum class ReadResult { data, timeout, closed };
// One overlapped read with a deadline. Bytes of a read that completes while it is cancelled are still reported.
ReadResult read_some(HANDLE pipe, std::vector<std::uint8_t>& out, ULONGLONG ms, DWORD limit = 65540) {
  out.assign(limit, 0); Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED op{}; op.hEvent = event.get(); DWORD count = 0;
  if (!ReadFile(pipe, out.data(), static_cast<DWORD>(out.size()), nullptr, &op) && GetLastError() != ERROR_IO_PENDING) { out.clear(); return ReadResult::closed; }
  if (WaitForSingleObject(event.get(), static_cast<DWORD>(ms)) != WAIT_OBJECT_0) {
    CancelIoEx(pipe, &op);
    if (GetOverlappedResult(pipe, &op, &count, TRUE) && count) { out.resize(count); return ReadResult::data; }
    out.clear(); return GetLastError() == ERROR_OPERATION_ABORTED ? ReadResult::timeout : ReadResult::closed;
  }
  if (!GetOverlappedResult(pipe, &op, &count, FALSE) || !count) { out.clear(); return ReadResult::closed; }
  out.resize(count); return ReadResult::data;
}
bool write_all(HANDLE pipe, const std::vector<std::uint8_t>& bytes) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED op{}; op.hEvent = event.get(); DWORD count = 0;
  if (!WriteFile(pipe, bytes.data(), static_cast<DWORD>(bytes.size()), nullptr, &op) && GetLastError() != ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.get(), 3000) != WAIT_OBJECT_0) { CancelIoEx(pipe, &op); GetOverlappedResult(pipe, &op, &count, TRUE); return false; }
  return GetOverlappedResult(pipe, &op, &count, FALSE) && count == bytes.size();
}
void send(HANDLE pipe, const std::vector<std::uint8_t>& bytes) { require(write_all(pipe, bytes), "client write"); }
Handle open_pipe(const std::wstring& name) {
  Handle h; require(until([&] { h.reset(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)); return static_cast<bool>(h); }), "client connect"); return h;
}

// The controlled v1 client: every server message passes through the ET-002b Consumer, which enforces identity, order,
// contiguous eventSeq coverage, the durable grant and a terminal `end`.
// `max_minor` is the highest minor its hello offers (default 0); its decoder and Consumer accept the same.
struct Client {
  Handle pipe; v1::FrameDecoder decoder; v1::Consumer consumer; bool durable; unsigned max_minor; bool eof = false;
  std::vector<v1::Message> messages; std::vector<v1::Applied> applied;
  Client(Handle h, bool durable_events, unsigned minor = 0)
    : pipe(std::move(h)), decoder(v1::Sender::server, minor), consumer(durable_events, minor), durable(durable_events), max_minor(minor) {}
  void hello() { send(pipe.get(), framed(hello_payload(durable, max_minor))); }
  // Reads until `predicate` holds; false on timeout or EOF.
  bool read_until(const std::function<bool()>& predicate, ULONGLONG ms = 3000) {
    const auto end = GetTickCount64() + ms * timing_scale; std::vector<std::uint8_t> bytes;
    while (!predicate()) {
      const auto now = GetTickCount64(); if (now >= end || eof) return false;
      const auto result = read_some(pipe.get(), bytes, end - now);
      if (result == ReadResult::closed) { eof = true; return predicate(); }
      if (result == ReadResult::timeout) continue;
      decoder.push(bytes.data(), bytes.size(), [&](v1::Message m) { applied.push_back(consumer.accept(m)); messages.push_back(std::move(m)); });
    }
    return true;
  }
  bool read(std::size_t count, ULONGLONG ms = 3000) { return read_until([&] { return messages.size() >= count; }, ms); }
  // Reads while frames keep running, as in a game: a loss run left open by a full ring reaches the worker at a later frame_end.
  bool pump(Host& host, const std::function<bool()>& predicate, ULONGLONG ms = 5000) {
    const auto end = GetTickCount64() + ms * timing_scale;
    while (!predicate()) { if (GetTickCount64() >= end || eof) return false; host.frame(); read_until(predicate, 20); }
    return true;
  }
  // True when the server closes the connection within `ms`; messages before the close still pass through the Consumer.
  bool closed(ULONGLONG ms = 3000) { read_until([] { return false; }, ms); return eof; }
  void handshake() { hello(); require(read(2), "welcome and checkpoint"); require(messages[0].kind == "welcome" && messages[1].kind == "checkpoint" && applied[1].hydration, "welcome, then a hydrating checkpoint"); }
  const v1::Message& last(const char* kind) const { for (auto i = messages.size(); i-- > 0;) if (messages[i].kind == kind) return messages[i]; throw std::runtime_error(std::string("no message ") + kind); }
  std::size_t count(const char* kind) const { std::size_t n = 0; for (const auto& m : messages) if (m.kind == kind) ++n; return n; }
  // The highest eventSeq covered by an event or gap on this connection, 0 before any.
  std::uint64_t covered() const { std::uint64_t n = 0; for (const auto& a : applied) if (a.coverage) n = a.coverage->last_event_seq; return n; }
  const std::string& session() const { return *consumer.plugin_session_id(); }
  void ack(std::uint64_t through) { send(pipe.get(), framed(ack_payload(session(), through))); }
  // Waits for a snapshot whose status satisfies `predicate`; frames are published meanwhile so snapshots keep coming.
  bool status_until(Host& host, const std::function<bool(const v1::StateView&)>& predicate, ULONGLONG ms = 3000) {
    const auto end = GetTickCount64() + ms * timing_scale; std::size_t seen = messages.size();
    while (GetTickCount64() < end) {
      host.frame();
      read_until([&] { return messages.size() > seen; }, 100);
      for (; seen < messages.size(); ++seen) if (messages[seen].kind == "snapshot" && predicate(*messages[seen].state)) return true;
      if (eof) return false;
    }
    return false;
  }
};
// Commits every coverage item received so far and sends the cursor's cumulative ACK, as ET-006b will after its storage
// transaction. Returns the ACK sent, or 0.
std::uint64_t commit_and_ack(Client& client, v1::DurableAckCursor& cursor, std::size_t& committed) {
  for (; committed < client.applied.size(); ++committed) if (const auto& c = client.applied[committed].coverage) { cursor.received(c->first_event_seq, c->last_event_seq); cursor.commit(c->first_event_seq, c->last_event_seq); }
  if (auto ack = cursor.ack()) { send(client.pipe.get(), v1::encode_frame(*ack, v1::highest_minor)); return ack->ack->through_event_seq; }
  return 0;
}

struct Fixture {
  transport::UserIdentity user = transport::current_user(); transport::OwnerSecurity security{user.sid}; transport::PeerIdentity self = transport::inspect_peer(GetCurrentProcessId());
  Host host; std::unique_ptr<sdk::Adapter> adapter = std::make_unique<sdk::Adapter>();
  std::unique_ptr<v1::Server> server; std::wstring directory, v0_directory;
  explicit Fixture(bool policy = true, const char* refuse = "") {
    host.refuse = refuse;
    directory = temporary_directory(security, L"ET004b-v1-"); v0_directory = temporary_directory(security, L"ET004b-v0-");
    auto p = host.params(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &p) == SCS_RESULT_ok, "SDK initialize");
    // The endpoint's lifecycle in sdk-exports.cpp: initialize, prepare, attach, then start.
    server = std::make_unique<v1::Server>(*adapter, v1::Origin::synthetic);
    auto* channel = server->prepare(); require(channel != nullptr, "v1 channel prepared"); adapter->attach_events(channel);
    if (policy) write_policy(directory, security, user, self);
    write_policy(v0_directory, security, user, self);
  }
  ~Fixture() {
    server->stop(); adapter->shutdown(); adapter->attach_events(nullptr);
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    v1::set_clock_offset_for_test(0); transport::set_transport_test_hook(nullptr);
#endif
    remove_directory(directory); remove_directory(v0_directory);
  }
  void start() { require(server->start(directory), "v1 worker start"); require(until([&] { return server->status() == v1::ServerStatus::listening; }), "v1 listening"); }
  Handle connect() { return open_pipe(server->endpoint()); }
  std::unique_ptr<Client> client(bool durable, unsigned max_minor = 0) { auto c = std::make_unique<Client>(connect(), durable, max_minor); return c; }
  std::unique_ptr<sdk::V1Current> current() const { auto c = std::make_unique<sdk::V1Current>(); require(adapter->read_v1_current(*c), "v1 slot"); return c; }
  std::wstring record() const { const auto c = current(); return directory + L"\\" + wide(c->identity.process_instance_id.c_str()) + L".json"; }
  bool listening() const { return until([&] { return server->status() == v1::ServerStatus::listening; }); }
  // The worker counts a hydration and then stores `connected`, both after the checkpoint write has completed, so a client
  // can read the checkpoint before either happens. Once `connected` is observed, the count of this and every earlier
  // connection is visible: read hydrations() only after this.
  bool hydrated() const { return until([&] { return server->status() == v1::ServerStatus::connected; }); }
};

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Holds the v1 worker at the start of its loop iteration ("v1-tick") until released or stopped, so SDK callbacks can
// fill the ring while nothing drains it. Other phases are ignored. With phase "v1-finish" it holds the worker after a
// stop request, before the shutdown drain; the stop event is then already set, so only the release ends that hold.
struct Hold {
  static Hold* active;
  Handle held{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, release{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::atomic<bool> holding{false}, timed_out{false}; std::string phase = "v1-tick";
  Hold() { active = this; transport::set_transport_test_hook(hook); }
  ~Hold() { SetEvent(release.get()); transport::set_transport_test_hook(nullptr); active = nullptr; }
  void engage() { ResetEvent(held.get()); ResetEvent(release.get()); holding.store(true); }
  void disengage() { holding.store(false); SetEvent(release.get()); }
  static DWORD hook(const char* at, HANDLE, HANDLE stop, DWORD result) {
    auto* self = active;
    if (!self || !stop || self->phase != at || !self->holding.load()) return result;
    SetEvent(self->held.get()); HANDLE waits[]{self->release.get(), stop};
    if (WaitForMultipleObjects(self->phase == "v1-finish" ? 1 : 2, waits, FALSE, 10000) == WAIT_TIMEOUT) self->timed_out.store(true);
    return result;
  }
};
Hold* Hold::active = nullptr;

// A synchronous one-byte read on the v1 worker at one hook point. Only CancelSynchronousIo or the test's fallback write
// ends it, so the result tells whether stop() cancelled synchronous I/O at that point.
struct BlockedRead {
  static BlockedRead* active;
  std::string at; Handle read_end, write_end, reached{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::atomic<bool> fired{false}; std::atomic<DWORD> error{ERROR_INVALID_FUNCTION};
  explicit BlockedRead(std::string phase) : at(std::move(phase)) {
    HANDLE r = nullptr, w = nullptr; require(CreatePipe(&r, &w, nullptr, 0) != FALSE, "owned synchronous read fixture");
    read_end.reset(r); write_end.reset(w); active = this; transport::set_transport_test_hook(hook);
  }
  ~BlockedRead() { transport::set_transport_test_hook(nullptr); active = nullptr; }
  // Ends the read after `ms` unless it already ended; returns whether this fallback was needed.
  bool fallback(DWORD ms) { if (WaitForSingleObject(done.get(), ms) == WAIT_OBJECT_0) return false; char byte = 1; DWORD n = 0; WriteFile(write_end.get(), &byte, 1, &n, nullptr); return true; }
  static DWORD hook(const char* phase, HANDLE, HANDLE stop, DWORD result) {
    auto* self = active;
    if (!self || !stop || self->at != phase || self->fired.exchange(true)) return result;
    SetEvent(self->reached.get()); char byte = 0; DWORD n = 0;
    const auto ok = ReadFile(self->read_end.get(), &byte, 1, &n, nullptr);
    self->error.store(ok ? ERROR_SUCCESS : GetLastError()); SetEvent(self->done.get());
    return result;
  }
};
BlockedRead* BlockedRead::active = nullptr;
#endif

std::string type_of(const v1::Message& m) { return m.event ? m.event->record_type : std::string(); }
std::vector<const v1::Message*> coverage_messages(const Client& c) { std::vector<const v1::Message*> out; for (const auto& m : c.messages) if (m.event || m.gap) out.push_back(&m); return out; }
std::string serialize(const v1::Json& j) { return v0::detail::serialize(j); }

// v1::window_field keeps the v0 identity and freshness rules of transport::current_window: both agree on every
// mutation of one valid window and at both age limits, and an available window keeps the exact physical geometry.
void window_mapping(Fixture& f) {
  sdk::Snapshot source; require(f.adapter->read_current(source), "v0 slot"); const auto c = f.current();
  window::Snapshot w{}; w.status = window::Status::available; w.process_id = c->identity.process_id; w.windows_session_id = c->identity.windows_session_id;
  w.process_creation_time = 42; w.plugin_session_id = c->identity.plugin_session_id.bytes; w.per_monitor_v2 = w.visible = w.client_bounds_available = true;
  w.handle = UINT64_MAX; w.client = {-400, -300, 640, 480}; w.dpi = 144; w.capture_monotonic_ms = 1000; w.foreground = true;
  auto agree = [&](const window::Snapshot& candidate, std::uint64_t creation, std::uint64_t now) {
    const auto v0_window = transport::current_window(source, &candidate, creation, now); const auto v1_window = v1::window_field(*c, &candidate, creation, now);
    require(v0_window.value.has_value() == v1_window.available(), "v0 and v1 window availability agree");
    if (v1_window.available()) {
      const auto& a = *v0_window.value; const auto& b = v1_window.value;
      require(a.handle == b.handle && a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height && a.dpi == b.dpi && a.foreground == b.foreground && a.minimized == b.minimized && b.display_mode == v1::DisplayMode::unknown, "exact geometry");
    }
    return v1_window.available();
  };
  require(agree(w, 42, 1250) && agree(w, 42, 1000) && !agree(w, 42, 1251) && !agree(w, 42, 999), "age limits");
  for (unsigned i = 0; i < 13; ++i) {
    auto bad = w;
    switch (i) {
      case 0: bad.process_id++; break; case 1: bad.windows_session_id++; break; case 2: bad.process_creation_time++; break; case 3: bad.plugin_session_id[0] = 'x'; break;
      case 4: bad.handle = 0; break; case 5: bad.dpi = 0; break; case 6: bad.client.width = 0; break; case 7: bad.client.height = 0; break; case 8: bad.visible = false; break;
      case 9: bad.minimized = true; bad.client = {}; bad.client_bounds_available = false; break; case 10: bad.per_monitor_v2 = false; break;
      case 11: bad.status = window::Status::ambiguous; break; default: bad.status = window::Status::stopped; break;
    }
    require(!agree(bad, 42, 1000), "every identity or availability mismatch is unavailable in both");
  }
  require(!agree(w, 0, 1000), "an unknown process creation time is unavailable");
  require(v1::window_field(*c, nullptr, 42, 1000).state == v1::FieldState::not_supported && transport::current_window(source, nullptr, 42, 1000).reason == v0::AvailabilityReason::not_supported, "no monitor: not-supported in both");
}

// Discovery, DACL, naming and the welcome capabilities on an actual pipe.
void handshake() {
  Fixture f; window_mapping(f); f.start();
  const auto c = f.current(); sdk::Snapshot source; require(f.adapter->read_current(source), "v0 slot");
  const auto expected = std::wstring(channel::active.pipe_prefix_wide) + L"ets2-v1-" + wide(f.user.tag) + L"-" + std::to_wstring(f.user.session) + L"-" + wide(c->identity.process_instance_id.c_str());
  require(f.server->endpoint() == expected, "v1 pipe name: game, v1, userTag, Windows session, process instance");
  require(transport::endpoint_name(source, f.user) == std::wstring(channel::active.pipe_prefix_wide) + L"ets2-v0-" + wide(f.user.tag) + L"-" + std::to_wstring(f.user.session) + L"-" + wide(c->identity.process_instance_id.c_str()),
    "v0 pipe name unchanged by the defaulted protocol parameter");
  // The discovery record: exact v0 schema with protocolMajor 1, owner-only, in the v1 directory.
  const auto record = f.record(); f.security.verify_owner_only(record);
  Handle file(CreateFileW(record.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr)); require(static_cast<bool>(file), "v1 discovery record readable");
  std::array<char, 4096> bytes{}; DWORD read = 0; require(ReadFile(file.get(), bytes.data(), 4096, &read, nullptr) && read > 0, "v1 discovery bytes"); file.reset();
  const auto j = v0::detail::Parser(std::string(bytes.data(), read)).parse();
  require(std::get<v0::Json::Object>(j.value).size() == 10 && j.at("schemaVersion").number() == 1 && j.at("protocolMajor").number() == 1 && j.at("game").string() == "ets2" &&
    j.at("userTag").string() == f.user.tag && j.at("windowsSessionId").number() == f.user.session && j.at("processId").number() == GetCurrentProcessId() &&
    j.at("processCreationTime").string() == std::to_string(transport::creation_time(GetCurrentProcess())) && j.at("processInstanceId").string() == c->identity.process_instance_id.c_str() &&
    j.at("pluginSessionId").string() == c->identity.plugin_session_id.c_str() && j.at("pipeName").string() == utf8(expected), "v1 discovery: exact fields, protocolMajor 1");
  // The v0 record bytes from the defaulted parameter equal the pre-ET-004b serialization, built here by hand.
  {
    const auto v0_name = transport::endpoint_name(source, f.user);
    { transport::Discovery v0_record(f.v0_directory, f.security, f.user, source, v0_name);
      Handle v0_file(CreateFileW((f.v0_directory + L"\\" + wide(c->identity.process_instance_id.c_str()) + L".json").c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
      require(static_cast<bool>(v0_file), "v0 record readable"); std::array<char, 4096> v0_bytes{}; DWORD v0_read = 0; require(ReadFile(v0_file.get(), v0_bytes.data(), 4096, &v0_read, nullptr), "v0 record bytes");
      using J = v0::Json;
      const J legacy{J::Object{{"schemaVersion", J{1.0}}, {"protocolMajor", J{0.0}}, {"game", J{std::string("ets2")}}, {"userTag", J{f.user.tag}},
        {"windowsSessionId", J{static_cast<double>(f.user.session)}}, {"processId", J{static_cast<double>(GetCurrentProcessId())}},
        {"processCreationTime", J{std::to_string(transport::creation_time(GetCurrentProcess()))}}, {"processInstanceId", J{std::string(c->identity.process_instance_id.c_str())}},
        {"pluginSessionId", J{std::string(c->identity.plugin_session_id.c_str())}}, {"pipeName", J{utf8(v0_name)}}}};
      require(std::string(v0_bytes.data(), v0_read) == v0::detail::serialize(legacy), "v0 discovery bytes identical with the defaulted parameter"); }
    require(GetFileAttributesW((f.v0_directory + L"\\" + wide(c->identity.process_instance_id.c_str()) + L".json").c_str()) == INVALID_FILE_ATTRIBUTES, "v0 record retired");
  }
  auto client = f.client(true);
  // The pipe's own security descriptor, read from the connected handle: protected, owned by and granting only the current user.
  f.security.verify_handle(client->pipe.get());
  ULONG flags = 0, instances = 0; require(GetNamedPipeInfo(client->pipe.get(), &flags, nullptr, nullptr, &instances) && instances == 1 && (flags & PIPE_TYPE_MESSAGE) == 0, "one byte-mode instance");
  Handle second(CreateFileW(f.server->endpoint().c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
  require(!second && GetLastError() == ERROR_PIPE_BUSY, "a second client is refused, not displacing the first");
  client->handshake();
  const auto& welcome = client->messages[0]; const auto& w = *welcome.welcome;
  require(welcome.source->origin == "synthetic" && welcome.source->game == "ets2" && welcome.source->plugin_session_id == c->identity.plugin_session_id.c_str() &&
    welcome.source->process_id == GetCurrentProcessId() && welcome.capture.clock_id == c->identity.capture_clock_id.c_str(), "welcome source identity and clock");
  std::set<std::string> types(w.event_types.begin(), w.event_types.end());
  require(w.durable_events && w.gameplay_events_registered && types.size() == 16 && !types.count("source.gameMode") && types.count("job.delivered") && types.count("trailer.cleared"), "OD-3 event types: all but source.gameMode");
  require(w.game_mode.mode == "unknown" && w.game_mode.method == "none" && w.game_mode.confidence == "none" && !w.game_mode.module.value, "OD-3 game mode unknown/none/none");
  const auto& versions = welcome.wire.at("data").at("versions");
  require(versions.at("telemetryApi").at("major").number() == 1 && versions.at("telemetryApi").at("minor").number() == 1 && versions.at("gameTelemetry").at("major").number() == 1 &&
    versions.at("gameTelemetry").at("minor").number() == 20 && versions.at("sdkArchive").string() == "scs-sdk-1.15", "versions from the SDK identity; archive distinct");
  const auto& checkpoint = *client->messages[1].state;
  require(checkpoint.status.delivery.durable && checkpoint.status.delivery.acked_through_event_seq == 0 && checkpoint.status.delivery.next_event_seq == 1 && checkpoint.status.delivery.retained_events == 0,
    "checkpoint delivery: durable, A = 0, N = 1, nothing retained");
  require(client->messages[1].wire.at("data").at("state").at("configuration").at("trailers").value.index() == 5 && std::get<v0::Json::Array>(client->messages[1].wire.at("data").at("state").at("configuration").at("trailers").value).size() == 10, "OD-6: ten trailer slots");
  // Snapshots at most every 50 ms while frames run continuously.
  const auto before = client->count("snapshot"); const auto started = GetTickCount64();
  while (GetTickCount64() - started < 1000) { f.host.frame(); client->read_until([] { return false; }, 5); }
  client->read_until([] { return false; }, 100);
  const auto snapshots = client->count("snapshot") - before; std::cout << "snapshotsPerSecond=" << snapshots << '\n';
  require(snapshots >= 5 && snapshots <= 22, "snapshot cadence bounded at 20 Hz");
  require(f.host.wrong_thread == 0, "the worker never calls the SDK");
}

// ET-050b PR-4: minor 1 over an actual pipe. A hello offering maxMinor 1 selects minor 1: every message in both
// directions carries it and checkpoints and snapshots carry `state.gearbox`. A hello offering only minor 0 gets minor 0
// without a gearbox, and a client frame at the other minor closes the connection.
struct HShifterAttributes {
  // A two-selector layout over handle positions 0-3: reverse at position 1, forward 1-8 at positions 2 and 3.
  std::vector<scs_named_value_t> list;
  HShifterAttributes() {
    const std::int32_t gears[16]{0, 0, 0, 0, -1, -3, -2, -4, 1, 5, 2, 6, 3, 7, 4, 8};
    list.push_back(named("selector.count", u32(2)));
    for (std::uint32_t i = 0; i < 16; ++i) {
      auto gear = value_of(SCS_VALUE_TYPE_s32); gear.value_s32.value = gears[i];
      list.push_back(indexed("slot.gear", gear, i)); list.push_back(indexed("slot.handle.position", u32(i / 4), i)); list.push_back(indexed("slot.selectors", u32(i % 4), i));
    }
    list.push_back({});
  }
};
void gearbox() {
  Fixture f; HShifterAttributes layout;
  scs_named_value_t truck[]{named("id", text("vehicle.synthetic_truck")), named("gears.forward", u32(8)), named("gears.reverse", u32(4)), scs_named_value_t{}};
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("truck", truck); f.host.config("hshifter", layout.list.data()); f.host.frame();
  f.start();
  auto c = f.client(true, 1); c->handshake();
  // Copies: later reads grow the message list.
  const auto welcome = c->messages[0]; const auto checkpoint = c->messages[1];
  require(welcome.minor == 1 && welcome.welcome->minor == 1 && checkpoint.minor == 1 && c->consumer.minor() == 1u, "maxMinor 1 selects minor 1");
  const auto g = *checkpoint.state->gearbox;
  require(g.forward_gears.value == 8u && g.reverse_gears.value == 4u && g.hshifter.value && g.hshifter.value->selector_count == 2 && g.hshifter.value->slots.size() == 12, "the checkpoint carries the gear counts and the layout");
  require(g.hshifter.value->slots.front().gear == -1 && g.hshifter.value->slots.front().handle_position == 1 && g.hshifter.value->slots.back().gear == 8 && g.hshifter.value->slots.back().handle_position == 3 && g.hshifter.value->slots.back().selectors == 3, "SDK slot order, neutral slots omitted");
  // A changed layout reaches the next snapshot; the callback itself emits no event.
  const auto events_before = c->count("event");
  scs_named_value_t empty[]{scs_named_value_t{}};
  f.host.config("hshifter", empty);
  require(c->status_until(f.host, [](const v1::StateView& s) { return s.gearbox && !s.gearbox->hshifter.value && s.gearbox->hshifter.reason == v1::Reason::not_observed && s.gearbox->forward_gears.value == 8u; }), "an empty hshifter callback: a not-observed layout in the next snapshot");
  require(c->count("event") == events_before, "the hshifter callback emits no event");
  // Events, a clock probe and an ACK at minor 1.
  cancelled(f.host, 2); f.host.frame();
  require(c->pump(f.host, [&] { return c->count("event") >= events_before + 2; }), "events delivered at minor 1");
  c->consumer.expect_clock_reply(1); send(c->pipe.get(), framed(probe_payload(1, 1)));
  require(c->read_until([&] { return c->count("clock.reply") == 1; }), "a minor-1 probe gets a clock reply");
  v1::DurableAckCursor cursor(c->session()); cursor.begin_connection(checkpoint.state->status.delivery.acked_through_event_seq, 1); std::size_t committed = 0;
  const auto through = commit_and_ack(*c, cursor, committed);
  require(through >= 2 && c->status_until(f.host, [&](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == through; }), "a minor-1 ACK releases the store");
  for (const auto& m : c->messages) require(m.minor == 1, "every server message of the connection carries minor 1");
  // An ACK at minor 0 on the minor-1 connection closes it.
  send(c->pipe.get(), framed(ack_payload(c->session(), through))); require(c->closed(), "an ACK at another minor closes the connection");
  require(f.listening(), "endpoint relistens");
  // A maxMinor-0 hello gets minor 0 and no gearbox, with the original minor-0 checkpoint shape.
  auto old = f.client(true); old->handshake();
  require(old->messages[0].minor == 0 && old->messages[0].welcome->minor == 0 && old->messages[1].minor == 0 && !old->messages[1].state->gearbox, "maxMinor 0 selects minor 0");
  require(!std::get<v0::Json::Object>(old->messages[1].wire.at("data").at("state").value).count("gearbox"), "a minor-0 checkpoint has no gearbox key");
  f.host.config("hshifter", layout.list.data());
  require(old->status_until(f.host, [](const v1::StateView& s) { return !s.gearbox; }), "minor-0 snapshots carry no gearbox");
  send(old->pipe.get(), framed(probe_payload(1, 1))); require(old->closed(), "a minor-1 probe on a minor-0 connection closes it");
  require(f.listening(), "endpoint relistens after the minor-0 client");
  // ET-052: the endpoint serves minor 2. A hello offering 2, or 3 (valid, and clamped to the endpoint maximum), is served
  // minor 2: a welcome and a checkpoint at minor 2 with the gearbox and `nextMandatoryBreak`, and snapshots stay at minor 2.
  for (const unsigned offered : {2U, 3U}) {
    auto wide = f.client(true, 2); wide->max_minor = offered; wide->handshake();
    const auto label = "maxMinor " + std::to_string(offered) + " offer";
    require(wide->messages[0].minor == 2 && wide->messages[0].welcome->minor == 2 && wide->messages[1].minor == 2 && wide->consumer.minor() == 2u, (label + " is served minor 2").c_str());
    require(wide->messages[1].state->gearbox && wide->messages[1].state->gearbox->forward_gears.value == 8u && wide->messages[1].state->next_mandatory_break, (label + ": a gearbox and a break").c_str());
    require(std::get<v0::Json::Object>(wide->messages[1].wire.at("data").at("state").value).count("nextMandatoryBreak") == 1, (label + ": a nextMandatoryBreak key").c_str());
    require(wide->status_until(f.host, [](const v1::StateView& s) { return s.gearbox && s.next_mandatory_break; }), (label + ": snapshots stay at minor 2").c_str());
    wide.reset(); require(f.listening(), "endpoint relistens after the wide offer");
  }
  require(f.host.wrong_thread == 0, "the worker never calls the SDK");
}

// ET-052 PR-3: minor 2 over an actual pipe. The hello's maxMinor selects min(offer, 2): 0 and 1 keep their original bytes
// (no break), 2 and 3 get minor 2 with `state.nextMandatoryBreak`. The expected values are written by hand.
std::set<std::string> state_keys(const v1::Message& message) {
  std::set<std::string> keys; for (const auto& entry : std::get<v0::Json::Object>(message.wire.at("data").at("state").value)) keys.insert(entry.first); return keys;
}
void mandatory_break() {
  Fixture f; f.host.break_minutes = 95;
  scs_named_value_t truck[]{named("id", text("vehicle.synthetic_truck")), named("gears.forward", u32(8)), named("gears.reverse", u32(4)), scs_named_value_t{}};
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("truck", truck); f.host.frame();
  f.start();
  std::set<std::string> keys[3];
  for (const unsigned offered : {0U, 1U, 2U, 3U}) {
    const unsigned minor = offered > 2 ? 2 : offered; const auto label = "maxMinor " + std::to_string(offered);
    auto c = f.client(true, minor); c->max_minor = offered; c->handshake();
    const auto welcome = c->messages[0], checkpoint = c->messages[1];
    require(welcome.minor == minor && welcome.welcome->minor == minor && checkpoint.minor == minor && c->consumer.minor() == minor, (label + " selects min(offer, 2)").c_str());
    require(static_cast<bool>(checkpoint.state->gearbox) == (minor >= 1) && static_cast<bool>(checkpoint.state->next_mandatory_break) == (minor >= 2), (label + ": gearbox from minor 1, break from minor 2").c_str());
    keys[minor] = state_keys(checkpoint);
    const std::pair<const char*, bool> expected_keys[]{{"gearbox", minor >= 1}, {"nextMandatoryBreak", minor >= 2}};
    for (const auto& entry : expected_keys) require(keys[minor].count(entry.first) == (entry.second ? 1U : 0U), (label + ": the state key set").c_str());
    if (minor == 2) {
      const auto& b = *checkpoint.state->next_mandatory_break;
      require(b.unit == "min" && b.reading.value && *b.reading.value == 95, "the checkpoint carries 95 minutes");
      // The break changes from snapshot to snapshot: positive, zero (a value), negative.
      for (const std::int32_t minutes : {94, 0, -15, 2147483647, -2147483647 - 1}) {
        f.host.break_minutes = minutes;
        require(c->status_until(f.host, [&](const v1::StateView& s) { return s.next_mandatory_break && s.next_mandatory_break->reading.value && *s.next_mandatory_break->reading.value == minutes; }), "a changed break reaches the next snapshot");
      }
      // NULL from the game is not-observed, never zero.
      f.host.break_null = true;
      require(c->status_until(f.host, [](const v1::StateView& s) { return s.next_mandatory_break && !s.next_mandatory_break->reading.value && s.next_mandatory_break->reading.reason == v1::Reason::not_observed; }), "a NULL break is not-observed on the next snapshot");
      f.host.break_null = false; f.host.break_minutes = 95;
      require(c->status_until(f.host, [](const v1::StateView& s) { return s.next_mandatory_break && s.next_mandatory_break->reading.value && *s.next_mandatory_break->reading.value == 95; }), "and recovers");
      // Probe, events and ACK at minor 2; a minor-1 probe on a minor-2 connection closes it.
      const auto events_before = c->count("event");
      cancelled(f.host, 2); f.host.frame();
      require(c->pump(f.host, [&] { return c->count("event") >= events_before + 2; }), "events delivered at minor 2");
      c->consumer.expect_clock_reply(1); send(c->pipe.get(), framed(probe_payload(1, 2)));
      require(c->read_until([&] { return c->count("clock.reply") == 1; }), "a minor-2 probe gets a clock reply");
      // The offer-3 pass reconnects after the offer-2 pass acknowledged its events, so the cursor starts from the producer's cursor.
      const auto acked = checkpoint.state->status.delivery.acked_through_event_seq; v1::DurableAckCursor cursor(c->session(), acked); cursor.begin_connection(acked, 2); std::size_t committed = 0;
      const auto through = commit_and_ack(*c, cursor, committed);
      require(through >= 2 && c->status_until(f.host, [&](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == through; }), "a minor-2 ACK releases the store");
      for (const auto& m : c->messages) require(m.minor == 2, "every server message of the connection carries minor 2");
      send(c->pipe.get(), framed(probe_payload(2, 1))); require(c->closed(), "a minor-1 probe on a minor-2 connection closes it");
    } else {
      // Lower minors keep serving snapshots without the break while the game delivers it.
      require(c->status_until(f.host, [&](const v1::StateView& s) { return !s.next_mandatory_break && static_cast<bool>(s.gearbox) == (minor >= 1); }), (label + ": snapshots carry no break").c_str());
      for (const auto& m : c->messages) require(m.minor == minor, "every server message of the connection carries its minor");
    }
    c.reset(); require(f.listening(), "endpoint relistens");
  }
  // The key sets differ exactly by the added key: minor 1 = minor 0 + gearbox, minor 2 = minor 1 + nextMandatoryBreak.
  auto minor1_plus = keys[0]; minor1_plus.insert("gearbox"); auto minor2_plus = keys[1]; minor2_plus.insert("nextMandatoryBreak");
  require(keys[1] == minor1_plus && keys[2] == minor2_plus, "the state key sets differ only by the minor's own key");
  require(f.host.wrong_thread == 0, "the worker never calls the SDK");
}
// A game that does not provide the channel: the minor-2 break is not-supported, and the connection is otherwise whole.
void mandatory_break_unsupported() {
  Fixture f(true, "mandatory.break"); f.host.break_minutes = 95;
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.frame();
  require(f.host.channels.count("mandatory.break") == 0 && f.host.channels.count("truck.speed") == 1, "the refused channel is not registered; the others are");
  f.start();
  auto c = f.client(true, 2); c->handshake();
  require(c->messages[1].minor == 2 && c->messages[1].state->next_mandatory_break && !c->messages[1].state->next_mandatory_break->reading.value && c->messages[1].state->next_mandatory_break->reading.reason == v1::Reason::not_supported, "the checkpoint carries a not-supported break");
  require(c->status_until(f.host, [](const v1::StateView& s) { return s.next_mandatory_break && s.next_mandatory_break->reading.reason == v1::Reason::not_supported && s.status.delivery.durable; }), "snapshots carry a not-supported break");
  require(f.host.wrong_thread == 0, "the worker never calls the SDK");
}

// ET-052: the v0 snapshot bytes of a game that provides `mandatory.break` and of one that refuses it are identical. The run
// is scripted (a job, a truck, a timer restart, changing values), and only the random identities and the capture time are
// normalized, because they differ between two plugin sessions by design.
std::vector<std::vector<std::uint8_t>> v0_snapshot_bytes(bool provide) {
  Fixture f(false, provide ? "" : "mandatory.break");
  scs_named_value_t job[]{named("cargo.id", text("synthetic_cargo")), named("planned_distance.km", u32(700)), scs_named_value_t{}};
  scs_named_value_t truck[]{named("id", text("vehicle.synthetic_truck")), named("fuel.capacity", value_of(SCS_VALUE_TYPE_float)), scs_named_value_t{}};
  std::vector<std::vector<std::uint8_t>> frames;
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("job", job);
  for (unsigned i = 0; i < 8; ++i) {
    f.host.break_minutes = 100 - static_cast<std::int32_t>(i) * 7;
    if (i == 3) f.host.config("truck", truck);
    f.host.frame(static_cast<float>(i) * 3);
    sdk::Snapshot snapshot; require(f.adapter->read_latest(snapshot), "a v0 publication per frame");
    snapshot.capture_monotonic_ns = (i + 1) * 1000000ULL;
    snapshot.identity.plugin_session_id.assign("10000000-0000-4000-8000-000000000001"); snapshot.identity.capture_clock_id.assign("30000000-0000-4000-8000-000000000001");
    snapshot.state.game_clock_id.assign("40000000-0000-4000-8000-000000000000");
    const v0::Continuity continuity{snapshot.continuity.coalesced_snapshots, snapshot.continuity.lost_observations, snapshot.continuity.offline_transitions};
    frames.push_back(v0::encode_frame(transport::current_message(snapshot, "snapshot", i + 1, continuity)));
  }
  const auto v1_break = f.current()->state.next_mandatory_break_min;
  require(provide ? (v1_break.available() && v1_break.value == 100 - 7 * 7) : v1_break.state == v1::FieldState::not_supported, "the scripted game provided or refused the break channel");
  return frames;
}
void mandatory_break_v0() {
  const auto refused = v0_snapshot_bytes(false), provided = v0_snapshot_bytes(true);
  require(refused.size() == 8 && refused == provided, "v0 snapshot bytes are identical with and without the break channel");
}

void live_only() {
  Fixture f; Penalty penalty(7);
  scs_named_value_t job[]{named("cargo.id", text("synthetic_cargo")), named("planned_distance.km", u32(700)), scs_named_value_t{}};
  // Without a client: three events become offline loss; only state and counters are kept.
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("job", job); f.host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled, penalty.attributes); f.host.frame();
  f.start();
  auto live = f.client(false); live->handshake();
  require(!live->messages[0].welcome->durable_events && !live->messages[1].state->status.delivery.durable, "live-only grant");
  require(live->messages[1].state->status.delivery.next_event_seq == 4 && live->messages[1].state->status.event_loss.offline == 3, "N = 4 after three offline events");
  // A live-only client receives state only: no event and no gap, and its events count as noDurableConsumer loss.
  cancelled(f.host, 5); f.host.frame();
  require(live->status_until(f.host, [](const v1::StateView& s) { return s.status.event_loss.no_durable_consumer == 5 && s.status.delivery.next_event_seq == 9; }), "noDurableConsumer counted on snapshots");
  require(live->count("event") == 0 && live->count("gap") == 0, "no event or gap reaches a live-only client");
  // A live-only client never ACKs; even A is rejected and closes the connection.
  live->ack(0); require(live->closed(), "live-only ACK closes the connection");
  require(f.listening(), "endpoint relistens");
  // Late attach: the durable checkpoint hydrates the earlier job without an event, then one gap covers [1, 8].
  auto durable = f.client(true); durable->handshake();
  const auto& state = durable->messages[1].wire.at("data").at("state");
  require(state.at("configuration").at("job").at("available").boolean() && state.at("configuration").at("job").at("value").at("cargoId").at("value").string() == "synthetic_cargo", "hydration carries the job");
  require(durable->applied[1].hydration && !durable->applied[1].coverage, "hydration has no coverage");
  require(durable->read_until([&] { return durable->count("gap") >= 1; }), "late-attach gap");
  const auto& gap = *durable->last("gap").gap;
  require(gap.first_event_seq == 1 && gap.last_event_seq == 8 && gap.causes.offline == 3 && gap.causes.no_durable_consumer == 5 && !gap.redelivered, "one gap: offline 3, noDurableConsumer 5");
  require(durable->count("event") == 0, "no job event derived from the checkpoint");
  require(f.host.wrong_thread == 0, "no SDK calls from the worker");
}

void durable_delivery() {
  Fixture f; f.start(); auto client = f.client(true); client->handshake();
  v1::DurableAckCursor cursor(client->session()); cursor.begin_connection(0); std::size_t committed = 0;
  scs_named_value_t job[]{named("cargo.id", text("cargo")), scs_named_value_t{}}, truck[]{named("brand_id", text("brand")), scs_named_value_t{}}, trailer[]{named("id", text("trailer")), scs_named_value_t{}};
  Penalty penalty(9); scs_named_value_t fine[]{named("fine.offence", text("speeding")), named("fine.amount", s64(-1)), scs_named_value_t{}};
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("job", job); f.host.config("truck", truck); f.host.config("trailer.0", trailer);
  for (int i = 0; i < 5; ++i) f.host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled, penalty.attributes);
  f.host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_player_fined, fine); f.host.event(SCS_TELEMETRY_EVENT_paused); f.host.frame();
  require(client->read_until([&] { return client->covered() >= 11; }), "eleven events delivered");
  const std::vector<std::string> expected{"simulation.started", "job.configured", "truck.configured", "trailer.configured", "job.cancelled", "job.cancelled", "job.cancelled", "job.cancelled", "job.cancelled", "player.fined", "simulation.paused"};
  const auto items = coverage_messages(*client); require(items.size() == 11, "eleven coverage items");
  for (std::size_t i = 0; i < items.size(); ++i) require(items[i]->event && items[i]->event->event_seq == i + 1 && type_of(*items[i]) == expected[i] && !items[i]->event->redelivered, "callback order, identity and type");
  require(items[10]->event->occurred.simulation == "paused" && items[0]->event->occurred.simulation == "running", "occurred.simulation after the callback");
  // Receipt is never an ACK: everything stays retained until the cursor commits.
  require(client->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.retained_events == 11 && s.status.delivery.acked_through_event_seq == 0; }), "received but unacknowledged events stay retained");
  require(commit_and_ack(*client, cursor, committed) == 11, "cumulative ACK 11");
  require(client->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.retained_events == 0 && s.status.delivery.acked_through_event_seq == 11 && s.status.delivery.next_event_seq == 12; }), "ACK releases");
  // An equal ACK is a no-op; the connection continues.
  client->ack(11); cancelled(f.host, 1); f.host.frame();
  require(client->read_until([&] { return client->covered() >= 12; }), "equal ACK keeps the connection");
  require(f.host.wrong_thread == 0, "no SDK calls from the worker");
}

// Reconnection redelivers retained events whole and in order with the redelivered flag; offline events become a gap.
void redelivery() {
  Fixture f; f.start(); auto first = f.client(true); first->handshake();
  v1::DurableAckCursor cursor(first->session()); cursor.begin_connection(0); std::size_t committed = 0;
  for (std::int64_t i = 1; i <= 6; ++i) { Penalty p(i * 100); f.host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled, p.attributes); }
  f.host.frame(); require(first->read_until([&] { return first->covered() >= 6; }), "six events");
  std::map<std::uint64_t, std::string> records;
  for (const auto* m : coverage_messages(*first)) records[m->event->event_seq] = serialize(m->wire.at("data").at("record")) + serialize(m->wire.at("data").at("occurred"));
  // Commit everything but acknowledge only through 3: the ACK of 4..6 is lost with the connection.
  for (; committed < first->applied.size(); ++committed) if (const auto& c = first->applied[committed].coverage) { cursor.received(c->first_event_seq, c->last_event_seq); cursor.commit(c->first_event_seq, c->last_event_seq); }
  first->ack(3);
  require(first->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == 3 && s.status.delivery.retained_events == 3; }), "release point 3");
  first.reset(); require(f.listening(), "relisten after disconnect");
  // Two events while no client is connected: offline coverage.
  cancelled(f.host, 2); f.host.frame();
  auto second = f.client(true); second->handshake();
  require(second->messages[1].state->status.delivery.acked_through_event_seq == 3 && second->messages[1].state->status.delivery.next_event_seq == 9, "checkpoint A = 3, N = 9");
  cursor.begin_connection(3); committed = 0;
  cancelled(f.host, 1); f.host.frame();
  require(second->read_until([&] { return second->covered() >= 9; }), "redelivery, gap and a live event");
  const auto items = coverage_messages(*second);
  require(items.size() == 5 && items[0]->event && items[0]->event->event_seq == 4, "coverage starts at A + 1");
  for (std::size_t i = 0; i < 3; ++i) {
    const auto& e = *items[i]->event;
    require(e.redelivered && records.at(e.event_seq) == serialize(items[i]->wire.at("data").at("record")) + serialize(items[i]->wire.at("data").at("occurred")), "redelivered whole, identical and flagged");
  }
  require(items[3]->gap && items[3]->gap->first_event_seq == 7 && items[3]->gap->last_event_seq == 8 && items[3]->gap->causes.offline == 2 && !items[3]->gap->redelivered, "offline gap at its position");
  require(items[4]->event && items[4]->event->event_seq == 9 && !items[4]->event->redelivered, "new event not flagged");
  // The cursor reports the redelivered, already committed events as duplicates and acknowledges once they are received again.
  require(commit_and_ack(*second, cursor, committed) == 9 && cursor.through_event_seq() == 9, "lost ACK repeated after redelivery");
  require(second->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == 9 && s.status.delivery.retained_events == 0; }), "all released");
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Counts the worker's ticks ("v1-tick", at the start of Server::tick()). Retention expires only in a tick, and a durable
// client cancels the disconnect window before its connection's first tick, so expiry must be evaluated by a tick of the
// listening worker before the client connects. offset() sets the clock offset and waits until a tick that began after it
// has completed: the second tick counted after the change, since ticks run one at a time on the worker.
struct TickCounter {
  static std::atomic<std::uint64_t> ticks;
  TickCounter() { transport::set_transport_test_hook(hook); }
  ~TickCounter() { transport::set_transport_test_hook(nullptr); }
  static DWORD hook(const char* at, HANDLE, HANDLE, DWORD result) { if (std::string(at) == "v1-tick") ticks.fetch_add(1); return result; }
  static bool offset(std::int64_t ns) {
    v1::set_clock_offset_for_test(ns); const auto base = ticks.load();
    return until([&] { return ticks.load() >= base + 2; });
  }
};
std::atomic<std::uint64_t> TickCounter::ticks{0};

// The 300 s disconnect retention, driven by the worker's clock offset; gap records never age. Each offset change waits for
// a worker tick that read it (TickCounter), never for wall time.
void retention() {
  TickCounter counter;
  Fixture f; f.start(); auto first = f.client(true); first->handshake();
  cancelled(f.host, 4); f.host.frame(); require(first->read_until([&] { return first->covered() >= 4; }), "four events");
  std::uint64_t first_ns = UINT64_MAX, last_ns = 0;
  for (const auto* m : coverage_messages(*first)) { const auto t = *m->event->occurred.monotonic_ns.value; first_ns = (std::min)(first_ns, t); last_ns = (std::max)(last_ns, t); }
  first.reset(); require(f.listening(), "relisten");
  // Just inside the window nothing expires.
  require(TickCounter::offset(299LL * 1000 * 1000 * 1000), "a worker tick at 299 s");
  auto inside = f.client(true); inside->handshake();
  require(inside->messages[1].state->status.delivery.retained_events == 4 && inside->messages[1].state->status.event_loss.retention_expired == 0, "inside the window: retained");
  require(inside->read_until([&] { return inside->covered() >= 4; }) && coverage_messages(*inside)[0]->event->redelivered, "redelivered after reconnection inside the window");
  inside.reset(); require(f.listening(), "relisten");
  // The reconnection cancelled the window; a new one starts at this disconnect. Past it, every retained event expires.
  require(TickCounter::offset(299LL * 1000 * 1000 * 1000 + 301LL * 1000 * 1000 * 1000), "a worker tick past the new window");
  auto after = f.client(true); after->handshake();
  const auto& status = after->messages[1].state->status;
  require(status.delivery.retained_events == 1 && status.delivery.retained_bytes == 1024 && status.event_loss.retention_expired == 4 && status.delivery.acked_through_event_seq == 0 && status.delivery.next_event_seq == 5, "expiry: one gap record of 1,024 bytes");
  require(after->read_until([&] { return after->covered() >= 4; }), "expired coverage delivered");
  const auto& gap = *coverage_messages(*after)[0]->gap;
  require(gap.first_event_seq == 1 && gap.last_event_seq == 4 && gap.causes.retention_expired == 4 && gap.redelivered, "retentionExpired gap, redelivered range");
  require(*gap.first_lost_monotonic_ns.value == first_ns && *gap.last_lost_monotonic_ns.value == last_ns, "S1: lost times of the first and last expired event");
  // Gap records never age: another window passes without a connection, and the gap record stays.
  after.reset(); require(f.listening(), "relisten");
  require(TickCounter::offset(299LL * 1000 * 1000 * 1000 + 700LL * 1000 * 1000 * 1000), "a worker tick another window later");
  auto last = f.client(true); last->handshake();
  require(last->messages[1].state->status.delivery.retained_events == 1 && last->messages[1].state->status.event_loss.retention_expired == 4, "the gap record never ages");
  // The capture clamp is exercised next, on a fresh session (one Fixture at a time: the fake host is process-global).
  last.reset();
}

// A worker clock behind the SDK clock: retained events and gaps carry later source times than the worker's reading. The
// capture clamp keeps every write valid (docs/native-transport-v1.md, Caller sequence step 5).
void capture_clamp(Fixture& f) {
  v1::set_clock_offset_for_test(-5LL * 1000 * 1000 * 1000);
  auto client = f.client(true); client->handshake();
  cancelled(f.host, 3); f.host.frame();
  require(client->read_until([&] { return client->covered() >= 3; }, 2000), "events carrying later source times are written");
  for (const auto* m : coverage_messages(*client)) require(m->capture.monotonic_ns >= *m->event->occurred.monotonic_ns.value, "capture not before the occurrence");
  client.reset(); require(f.listening(), "relisten"); v1::set_clock_offset_for_test(0);
}
#endif

// A durable client that never reads: callbacks stay non-blocking, the write deadline closes the connection after about
// 1 s, and the store, the ring and private memory stay bounded.
void stalled_reader() {
  Fixture f; f.start(); auto client = f.client(true); client->handshake();
  // The worker marks the connection connected only after it has issued the checkpoint, which the client may already
  // have read; the loop below relies on that state, so it is awaited first.
  require(until([&] { return f.server->status() == v1::ServerStatus::connected; }), "connection established");
  PROCESS_MEMORY_COUNTERS_EX before{}; require(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&before), sizeof(before)), "memory before");
  scs_named_value_t big[]{named("cargo.id", text(long_id.c_str())), named("cargo", text(long_name_n.c_str())), named("source.city", text(long_name_s.c_str())),
    named("destination.city", text(long_name_d.c_str())), named("source.company", text(long_name_o.c_str())), scs_named_value_t{}};
  // Kernel backpressure is observed from the client side, not by sampling the worker: the bytes waiting in the client's
  // pipe reach 48 KiB of the 65,540-byte quota and nothing reads them. Callbacks keep producing, so a later server write
  // stays pending, and only the 1 s write deadline can then close the connection of a client that is alive and silent.
  constexpr DWORD backpressure_bytes = 48 * 1024;
  auto buffered = [&] { DWORD n = 0; return PeekNamedPipe(client->pipe.get(), nullptr, 0, nullptr, &n, nullptr) ? n : 0ul; };
  ULONGLONG slowest = 0, full_at = 0; DWORD peak = 0; unsigned frames = 0; bool pending_seen = false;
  const auto end = GetTickCount64() + 6000 * timing_scale;
  while (GetTickCount64() < end && f.server->status() == v1::ServerStatus::connected) {
    const auto t = GetTickCount64();
    for (int i = 0; i < 4; ++i) f.host.config("job", big);
    cancelled(f.host, 20); f.host.frame(static_cast<float>(frames++ % 50));
    slowest = (std::max)(slowest, GetTickCount64() - t);
    const auto bytes = buffered(); peak = (std::max)(peak, bytes);
    if (!full_at && bytes >= backpressure_bytes) full_at = GetTickCount64();
    pending_seen = pending_seen || f.server->write_pending();
    Sleep(1);
  }
  require(full_at != 0, "actual kernel backpressure: 48 KiB wait unread in the client's pipe");
  require(f.listening(), "the write deadline closes the stalled connection");
  f.host.frame();
  require(!f.host.logs.empty() && f.host.logs.back().find("V1_CONNECTION_CLOSED reason=WRITE_TIMEOUT phase=live") != std::string::npos &&
    f.host.logs.back().find(" win32=0 durable=1 connection=1 utcMs=") != std::string::npos, "a stalled write has a precise, payload-free SDK-thread diagnostic");
  const auto closed_after = GetTickCount64() - full_at;
  std::cout << "stalledCloseMs=" << closed_after << " peakBufferedBytes=" << peak << " pendingSampled=" << pending_seen << " slowestFrameMs=" << slowest << " frames=" << frames << '\n';
  require(closed_after <= 2000 * timing_scale, "closed about 1 s after the pipe filled");
  require(slowest < 200 * timing_scale, "callbacks never wait for the stalled client");
  PROCESS_MEMORY_COUNTERS_EX after{}; require(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&after), sizeof(after)), "memory after");
  const auto growth = after.PrivateUsage > before.PrivateUsage ? after.PrivateUsage - before.PrivateUsage : 0; std::cout << "privateGrowthBytes=" << growth << '\n';
#if defined(__SANITIZE_ADDRESS__)
  // AddressSanitizer keeps freed memory in quarantine and maps shadow memory, so its private bytes do not measure the
  // endpoint; the bound is asserted in the uninstrumented build only.
#else
  require(growth < 32u * 1024 * 1024, "private bytes stay bounded");
#endif
  // Reconnect: the store stayed within its bounds and the overflow is counted.
  client.reset(); auto again = f.client(true); again->handshake();
  const auto& s = again->messages[1].state->status;
  std::cout << "retained=" << s.delivery.retained_events << " bytes=" << s.delivery.retained_bytes << " queueCount=" << s.event_loss.queue_count << " queueBytes=" << s.event_loss.queue_bytes << '\n';
  require(s.delivery.retained_events <= 256 && s.delivery.retained_bytes <= 1048576 && s.event_loss.queue_count + s.event_loss.queue_bytes > 0, "store bounded, overflow counted");
  require(f.host.wrong_thread == 0, "no SDK calls from the worker");
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Store overflow without ACKs, then ring overflow while the worker is held: both are gap coverage at their position.
void overflow() {
  Fixture f; Hold hold; f.start(); auto client = f.client(true); client->handshake();
  v1::DurableAckCursor cursor(client->session()); cursor.begin_connection(0); std::size_t committed = 0;
  // Only the store may overflow here, whatever the host's speed: each batch of 100 is below the 128-slot ring, and the
  // next one starts only after the client has received coverage of every eventSeq so far, so the ring is empty again.
  for (std::uint64_t through = 100; through <= 300; through += 100) {
    cancelled(f.host, 100); f.host.frame();
    require(client->pump(f.host, [&] { return client->covered() >= through; }), "batch covered before the next one");
  }
  std::uint64_t events = 0, queue_count = 0;
  for (const auto* m : coverage_messages(*client)) { if (m->event) ++events; else queue_count += m->gap->causes.queue_count; }
  require(events == 255 && queue_count == 45, "255 events retained (one entry reserved), 45 lost as queueCount");
  const auto& first_gap = *client->last("gap").gap;
  require(coverage_messages(*client)[255]->gap && coverage_messages(*client)[255]->gap->first_event_seq == 256 && first_gap.last_event_seq == 300, "gap at its stream position");
  require(client->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.retained_events == 256 && s.status.event_loss.queue_count == 45; }), "full store: 256 entries");
  require(commit_and_ack(*client, cursor, committed) == 300, "ACK 300");
  require(client->status_until(f.host, [](const v1::StateView& s) { return s.status.delivery.retained_events == 0 && s.status.delivery.acked_through_event_seq == 300; }), "released");
  // Ring overflow: the worker is held while 200 events are observed; 128 fit the ring and 72 become one queueCount run.
  hold.engage(); require(WaitForSingleObject(hold.held.get(), static_cast<DWORD>(3000 * timing_scale)) == WAIT_OBJECT_0, "worker held");
  const auto t = GetTickCount64(); cancelled(f.host, 200); f.host.frame(); const auto elapsed = GetTickCount64() - t;
  require(elapsed < 500 * timing_scale, "callbacks complete while the worker is held");
  hold.disengage(); require(!hold.timed_out.load(), "hold released");
  require(client->pump(f.host, [&] { return client->covered() >= 500; }), "500 eventSeqs covered");
  events = 0; queue_count = 0;
  const auto items = coverage_messages(*client);
  for (std::size_t i = 0; i < items.size(); ++i) if (items[i]->event ? items[i]->event->event_seq > 300 : items[i]->gap->first_event_seq > 300) { if (items[i]->event) ++events; else queue_count += items[i]->gap->causes.queue_count; }
  require(events == 128 && queue_count == 72, "ring: 128 copied, 72 queueCount in one run");
}

// ACK and control framing: every violation closes the connection, and the endpoint relistens.
void ack_control() {
  Fixture f; Hold hold; f.start();
  auto relisten = [&] { require(f.listening(), "endpoint relistens"); };
  // (a) S6: a clock probe sent right after the hello, before the checkpoint. A probe is otherwise valid, so only the S6
  // rule closes this connection (an early ACK would also fail the validator).
  {
    hold.engage(); auto c = f.client(true); send(c->pipe.get(), framed(hello_payload(true))); Sleep(20); send(c->pipe.get(), framed(probe_payload(1)));
    hold.disengage(); require(c->closed() && c->count("checkpoint") == 0, "bytes before the checkpoint close the connection"); relisten();
  }
  // (b) A live-only ACK, (c) a foreign session and (d) an ACK beyond the written coverage.
  {
    auto c = f.client(false); c->handshake(); c->ack(0); require(c->closed(), "live-only ACK rejected"); relisten();
  }
  {
    auto c = f.client(true); c->handshake(); send(c->pipe.get(), framed(ack_payload("10000000-0000-4000-8000-000000000001", 0))); require(c->closed(), "foreign session ACK rejected"); relisten();
  }
  {
    auto c = f.client(true); c->handshake(); c->ack(1); require(c->closed(), "ACK beyond the written coverage rejected"); relisten();
  }
  // (e) A regressing ACK and (f) an equal one.
  {
    auto c = f.client(true); c->handshake(); const auto base = c->messages[1].state->status.delivery.acked_through_event_seq;
    cancelled(f.host, 3); f.host.frame(); require(c->read_until([&] { return c->covered() >= base + 3; }), "three events");
    c->ack(base + 3); c->ack(base + 3);
    require(c->status_until(f.host, [&](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == base + 3; }), "ACK and equal ACK accepted");
    c->ack(base + 2); require(c->closed(), "regressing ACK rejected"); relisten();
  }
  // (g) An ACK inside a retained gap record keeps it whole; the release point is its first eventSeq - 1 (decision (c)).
  {
    auto c = f.client(true); c->handshake(); const auto a = c->messages[1].state->status.delivery.acked_through_event_seq;
    c.reset(); relisten(); cancelled(f.host, 3); f.host.frame();
    auto d = f.client(true); d->handshake(); require(d->read_until([&] { return d->covered() >= a + 3; }), "offline gap");
    d->ack(a + 2);
    require(d->status_until(f.host, [&](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == a && s.status.delivery.retained_events == 1; }), "release point stays before the gap record");
    d.reset(); relisten();
    auto e = f.client(true); e->handshake();
    require(e->messages[1].state->status.delivery.acked_through_event_seq == a && e->read_until([&] { return e->covered() >= a + 3; }), "checkpoint carries the release point");
    const auto& gap = *coverage_messages(*e)[0]->gap; require(gap.first_event_seq == a + 1 && gap.last_event_seq == a + 3 && gap.redelivered && gap.causes.offline == 3, "the gap record is redelivered whole");
    e->ack(a + 3); require(e->status_until(f.host, [&](const v1::StateView& s) { return s.status.delivery.acked_through_event_seq == a + 3; }), "released at its last eventSeq"); e.reset(); relisten();
  }
  // (h) A clock probe: received <= sent <= capture, and a mapping from the client's QPC clock.
  {
    auto c = f.client(true); c->handshake();
    auto qpc_ns = [] { LARGE_INTEGER n{}, q{}; QueryPerformanceCounter(&n); QueryPerformanceFrequency(&q); return static_cast<std::uint64_t>(static_cast<long double>(n.QuadPart) * 1e9L / static_cast<long double>(q.QuadPart)); };
    c->consumer.expect_clock_reply(1); const auto t0 = qpc_ns(); send(c->pipe.get(), framed(probe_payload(1)));
    require(c->read_until([&] { return c->count("clock.reply") == 1; }), "clock reply"); const auto t3 = qpc_ns();
    const auto& reply = c->last("clock.reply");
    require(reply.clock_reply->probe_id == 1 && reply.clock_reply->received_monotonic_ns <= reply.clock_reply->sent_monotonic_ns && reply.clock_reply->sent_monotonic_ns <= reply.capture.monotonic_ns, "received <= sent <= capture");
    const auto mapping = v1::compute_clock_mapping(reply, 1, "60000000-0000-4000-8000-000000000001", t0, t3);
    require(mapping && mapping->uncertainty_ns < 1000000000ULL * timing_scale, "a mapping with bounded uncertainty");
    // (i) A probe ID that does not increase closes the connection.
    send(c->pipe.get(), framed(probe_payload(1))); require(c->closed(), "non-increasing probe ID rejected"); relisten();
  }
  {
    // (j) A second probe while the reply to the first is unsent: both arrive in one read.
    auto c = f.client(true); c->handshake(); auto two = framed(probe_payload(2)); const auto three = framed(probe_payload(3)); two.insert(two.end(), three.begin(), three.end());
    send(c->pipe.get(), two); require(c->closed(), "probe while a reply is unsent rejected"); relisten();
  }
  // (k) Any other client kind after the checkpoint and (l) an oversized client frame prefix.
  {
    auto c = f.client(true); c->handshake(); c->hello(); require(c->closed(), "a second hello closes"); relisten();
  }
  {
    auto c = f.client(true); c->handshake(); send(c->pipe.get(), {1, 16, 0, 0}); require(c->closed(), "client frame over 4,096 bytes closes"); relisten();
  }
  auto valid = f.client(true); valid->handshake(); require(f.hydrated() && f.server->hydrations() >= 11, "every valid handshake hydrated");
  for (int i = 0; i < 4; ++i) f.host.frame();
  auto logged = [&](const char* reason) { for (const auto& log : f.host.logs) if (log.find(reason) != std::string::npos) return true; return false; };
  require(logged("reason=INVALID_ACK") && logged("reason=INVALID_PROBE") && logged("reason=CLIENT_PROTOCOL"), "control rejections keep distinct close codes");
  require(f.host.wrong_thread == 0, "control diagnostics only use the SDK logger from its caller thread");
}
#endif

// Seeded mutations of the hello and of post-checkpoint client frames: each closes or is a valid frame; the endpoint relistens.
void fuzz() {
  // ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER multiplies both loops (40 mutated hellos and 40 mutated frames on a PR run).
  const unsigned multiplier = ets2telemetry::test::native_fuzz_multiplier(), rounds = 40 * multiplier;
  std::cout << "fuzzMultiplier=" << multiplier << " rounds=" << rounds << std::endl;
  Fixture f; f.start(); std::uint32_t random = 0x5a17c0de; auto next = [&] { random = random * 1664525U + 1013904223U; return random; };
  unsigned hello_closed = 0, hello_served = 0;
  for (unsigned i = 0; i < rounds; ++i) {
    auto bytes = framed(hello_payload(true)); const auto offset = 4 + next() % (bytes.size() - 4);
    switch (next() % 3) { case 0: bytes[offset] = static_cast<std::uint8_t>(1 + next() % 7); break; case 1: bytes[offset] ^= static_cast<std::uint8_t>(1u << (next() % 8)); break; default: bytes.resize(offset); bytes[0] = static_cast<std::uint8_t>(bytes.size() - 4); break; }
    auto c = f.client(true); send(c->pipe.get(), bytes);
    if (c->closed(1500)) ++hello_closed; else ++hello_served;
    c.reset(); require(f.listening(), "relisten after a mutated hello");
  }
  unsigned frame_closed = 0, frame_kept = 0;
  for (unsigned i = 0; i < rounds; ++i) {
    auto c = f.client(true); c->handshake();
    auto bytes = framed(i % 2 ? ack_payload(c->session(), 0) : probe_payload(1 + i)); const auto offset = next() % bytes.size();
    bytes[offset] ^= static_cast<std::uint8_t>(1u << (next() % 8));
    // The client is no longer a strict Consumer for a reply it did not register, so only closure is observed.
    std::vector<std::uint8_t> sink; send(c->pipe.get(), bytes);
    const auto end = GetTickCount64() + 400 * timing_scale; bool closed = false;
    while (GetTickCount64() < end) { const auto r = read_some(c->pipe.get(), sink, 50); if (r == ReadResult::closed) { closed = true; break; } }
    if (closed) ++frame_closed; else ++frame_kept;
    c.reset(); require(f.listening(), "relisten after a mutated frame");
  }
  std::cout << "mutatedHelloClosed=" << hello_closed << " served=" << hello_served << " mutatedFrameClosed=" << frame_closed << " kept=" << frame_kept << '\n';
  require(hello_closed > 0 && frame_closed > 0, "mutations are rejected");
  auto valid = f.client(true); valid->handshake(); cancelled(f.host, 2); f.host.frame();
  require(valid->read_until([&] { return valid->covered() == valid->messages[1].state->status.delivery.next_event_seq + 1; }), "a valid client is served after the fuzz");
}

// Handshake rejection: sizes, versions, other contracts, a duplicate hello and the real 5 s hello deadline.
void rejection() {
  Fixture f; f.start();
  {
    auto c = f.client(true); const auto t = GetTickCount64(); require(c->closed(7000) && c->messages.empty(), "no hello: closed"); const auto elapsed = GetTickCount64() - t;
    std::cout << "helloTimeoutMs=" << elapsed << '\n'; require(elapsed >= 4900 && elapsed < 5900 * timing_scale, "real 5 s hello deadline");
  }
  require(f.listening(), "relisten after the deadline");
  auto rejected = [&](std::vector<std::uint8_t> bytes, const char* message) { auto c = f.client(true); send(c->pipe.get(), bytes); require(c->closed() && c->messages.empty(), message); c.reset(); require(f.listening(), "relisten after rejection"); };
  auto exact = hello_payload(true); exact.resize(4096, ' ');
  { auto c = f.client(true); send(c->pipe.get(), framed(exact)); require(c->read(2), "exact 4,096-byte hello accepted"); }
  require(f.listening(), "relisten");
  auto over = hello_payload(true); over.resize(4097, ' '); rejected(framed(over), "4,097-byte hello rejected");
  { auto c = f.client(true); const auto t = GetTickCount64(); send(c->pipe.get(), {1, 16, 0, 0}); require(c->closed(1000) && GetTickCount64() - t < 1000 * timing_scale, "oversized prefix rejected without waiting for the payload"); }
  require(f.listening(), "relisten");
  rejected({0, 0, 0, 0}, "empty hello rejected");
  rejected(framed(v0_hello), "v0 hello rejected");
  auto major2 = hello_payload(true); major2.replace(major2.find("\"major\":1"), 9, "\"major\":2"); rejected(framed(major2), "major 2 rejected");
  auto minor1 = hello_payload(true); minor1.replace(minor1.find("\"minor\":0"), 9, "\"minor\":1"); rejected(framed(minor1), "envelope minor 1 rejected");
  rejected(cap0::frame(cap0::hello_payload("0cab0000-0000-4000-8000-0000000000a1")), "CAP0 hello rejected");
  rejected(framed("{"), "malformed hello rejected");
  auto extra = hello_payload(true); extra.insert(extra.size() - 2, ",\"extra\":true"); rejected(framed(extra), "unknown field rejected");
  auto twice = framed(hello_payload(true)); const auto copy = twice; twice.insert(twice.end(), copy.begin(), copy.end()); rejected(twice, "a duplicate hello rejected (S6)");
  rejected(framed(ack_payload("50000000-0000-4000-8000-000000000001", 0)), "an ACK instead of the hello rejected");
  // A local rejection loop must not spend the negotiated-connection diagnostic budget or fill the entire SDK queue.
  for (unsigned i = 0; i < 32; ++i) rejected(framed("{"), "repeated invalid hello rejected");
  auto valid = f.client(false); valid->handshake(); valid->ack(0); require(valid->closed() && f.listening(), "post-checkpoint ACK rejection");
  for (unsigned i = 0; i < 4; ++i) f.host.frame();
  require(std::any_of(f.host.logs.begin(), f.host.logs.end(), [](const std::string& row) {
    return row.find("reason=HELLO_TIMEOUT phase=hello write=none end=none win32=0 durable=unknown") != std::string::npos;
  }), "a hello timeout is distinguished from an I/O error before negotiation");
  require(std::any_of(f.host.logs.begin(), f.host.logs.end(), [](const std::string& row) {
    return row.find("reason=INVALID_ACK phase=live") != std::string::npos && row.find(" session=") != std::string::npos;
  }), "the real post-checkpoint failure survives many rejected connections and carries its session identity");
}

// A foreign pipe, a foreign record and a broad-ACL directory make v1 fail closed; v0 still serves.
void collision() {
  for (unsigned scenario = 0; scenario < 3; ++scenario) {
    Fixture f; transport::Server v0{*f.adapter};
    sdk::Snapshot source; require(f.adapter->read_current(source), "v0 slot"); const auto name = transport::endpoint_name(source, f.user, 1);
    Handle foreign_pipe, foreign_record; const auto record = f.record();
    if (scenario == 0) { foreign_pipe.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, f.security.attributes())); require(static_cast<bool>(foreign_pipe), "foreign v1 pipe"); }
    if (scenario == 1) {
      foreign_record.reset(CreateFileW(record.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ, f.security.attributes(), CREATE_NEW, 0, nullptr)); require(static_cast<bool>(foreign_record), "foreign v1 record");
      DWORD written = 0; require(WriteFile(foreign_record.get(), "foreign", 7, &written, nullptr) && written == 7, "foreign sentinel");
    }
    if (scenario == 2) {
      PSECURITY_DESCRIPTOR insecure = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)", SDDL_REVISION_1, &insecure, nullptr) != FALSE, "broad ACL descriptor");
      require(SetFileSecurityW(f.directory.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, insecure) != FALSE, "broad ACL v1 directory"); LocalFree(insecure);
    }
    require(f.server->start(f.directory), "v1 worker starts");
    require(until([&] { return f.server->status() == v1::ServerStatus::failed; }), "v1 fails closed");
    require(f.server->endpoint().empty(), "no v1 endpoint published");
    require(v0.start(f.v0_directory) && v0.await_startup() != transport::StartupFailure::endpoint_creation, "v0 starts beside the failed v1 endpoint");
    require(until([&] { return v0.status() == transport::Status::listening; }, 10000), "v0 listening");
    auto live = open_pipe(v0.endpoint()); send(live.get(), framed(v0_hello)); v0::FrameDecoder decoder; std::vector<v0::Message> messages; std::vector<std::uint8_t> bytes;
    const auto end = GetTickCount64() + 3000 * timing_scale;
    while (messages.size() < 2 && GetTickCount64() < end) if (read_some(live.get(), bytes, 500) == ReadResult::data) decoder.push(bytes.data(), bytes.size(), [&](v0::Message m) { messages.push_back(std::move(m)); });
    require(messages.size() >= 2 && messages[0].kind == "welcome" && messages[1].kind == "checkpoint", "v0 serves while v1 failed closed");
    live.reset(); v0.stop(); f.server->stop();
    if (scenario == 0) { Handle replacement(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE, 1, 4096, 4096, 0, f.security.attributes())); require(!replacement, "foreign pipe preserved, never adopted"); }
    if (scenario == 1) {
      std::array<char, 7> sentinel{}; LARGE_INTEGER zero{}; DWORD read = 0;
      require(SetFilePointerEx(foreign_record.get(), zero, nullptr, FILE_BEGIN) && ReadFile(foreign_record.get(), sentinel.data(), 7, &read, nullptr) && read == 7 && std::string(sentinel.data(), 7) == "foreign", "foreign record never overwritten");
      FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(foreign_record.get(), FileDispositionInfo, &remove, sizeof(remove)); foreign_record.reset();
    }
    std::cout << "collision scenario=" << scenario << " v1 failed closed, v0 served\n";
  }
}

// The v1 service policy: missing, broad-ACL, wrong digest and malformed policies reject the client; the endpoint stays.
void policy() {
  Fixture f(false); f.start();
  // The peer is rejected when it connects, before its hello is read, so the hello write itself may already fail.
  auto denied = [&](const char* message) { auto c = f.client(true); write_all(c->pipe.get(), framed(hello_payload(true))); require(c->closed() && c->messages.empty(), message); c.reset(); require(f.listening(), "endpoint stays listening"); };
  denied("missing policy rejects the client");
  f.host.frame();
  require(f.host.logs.size() == 1 && f.host.logs[0].find("reason=POLICY_READ_FAILED") != std::string::npos,
    "a missing policy is an inspection failure, not evidence that the peer was forbidden");
  write_policy(f.directory, f.security, f.user, f.self, std::string(64, '0')); denied("digest mismatch rejected");
  write_file(f.directory + L"\\service-policy.json", f.security, "{\"schemaVersion\":1}"); denied("malformed policy rejected");
  write_policy(f.directory, f.security, f.user, f.self);
  PSECURITY_DESCRIPTOR insecure = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)", SDDL_REVISION_1, &insecure, nullptr) != FALSE, "broad ACL descriptor");
  require(SetFileSecurityW((f.directory + L"\\service-policy.json").c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, insecure) != FALSE, "broad ACL policy"); LocalFree(insecure);
  denied("broad-ACL policy rejected");
  require(DeleteFileW((f.directory + L"\\service-policy.json").c_str()) != FALSE, "remove broad policy");
  // The v0 policy in its own directory does not authorize the v1 endpoint.
  denied("the v0 directory's policy does not apply to v1");
  write_policy(f.directory, f.security, f.user, f.self);
  auto valid = f.client(true); valid->handshake();
  require(f.hydrated() && f.server->hydrations() == 1, "only the authorized client hydrated");
  // v0, with its own valid policy, serves throughout.
  transport::Server v0{*f.adapter}; require(v0.start(f.v0_directory) && until([&] { return v0.status() == transport::Status::listening; }, 10000), "v0 listening");
  auto live = open_pipe(v0.endpoint()); send(live.get(), framed(v0_hello)); std::vector<std::uint8_t> bytes;
  require(read_some(live.get(), bytes, 3000 * timing_scale) == ReadResult::data, "v0 serves beside the v1 policy rejections"); live.reset(); v0.stop();
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// The last assignable eventSeqs, then end(sequence-exhausted); the endpoint retires and v0 is unaffected.
void exhaustion() {
  Fixture f; constexpr auto max = v1::max_event_seq;
  v1::EventChannelTestAccess::set_next(*f.server->channel(), max - 1); require(f.server->skip_store_for_test(max - 1), "store at max - 1");
  f.start(); auto client = f.client(true); client->handshake();
  require(client->messages[1].state->status.delivery.next_event_seq == max - 1 && client->messages[1].state->status.event_loss.offline == max - 2, "checkpoint near the end of the range");
  cancelled(f.host, 3); f.host.frame();
  require(f.server->channel()->exhausted(), "the channel assigned its last eventSeq");
  require(client->read_until([&] { return client->count("end") == 1; }, 5000), "end received");
  const auto items = coverage_messages(*client);
  require(items.size() == 3 && items[0]->gap && items[0]->gap->last_event_seq == max - 2 && items[1]->event->event_seq == max - 1 && items[2]->event->event_seq == max, "the last two events precede end");
  const auto& end = *client->last("end").end;
  require(end.reason == "sequence-exhausted" && end.next_event_seq == UINT64_MAX && end.acked_through_event_seq == 0 && end.retained_unacked == 2, "end(sequence-exhausted) with N = 2^64 - 1");
  require(client->closed(), "the connection ends after end");
  require(until([&] { return f.server->status() == v1::ServerStatus::retired && f.server->endpoint().empty(); }), "v1 retires");
  require(GetFileAttributesW(f.record().c_str()) == INVALID_FILE_ATTRIBUTES, "v1 discovery record retired");
  for (int i = 0; i < 3; ++i) f.host.frame();
  require(f.host.logs.size() == 1 && f.host.logs[0].find("V1_CONNECTION_CLOSED reason=SEQUENCE_EXHAUSTED") != std::string::npos, "exhaustion has one connection diagnostic");
  require(f.server->ends() == 1, "one end written");
}

// `rejected` from the store is an invariant violation: end(source-retired), one deferred fixed log entry, v1 retires.
void invariant() {
  Fixture f; transport::Server v0{*f.adapter};
  // The store moves ahead of the channel, so the next drained eventSeq is not the store's N.
  require(f.server->skip_store_for_test(5), "store at 5, channel at 1");
  f.start(); auto client = f.client(true); client->handshake();
  require(client->read_until([&] { return client->covered() >= 4; }), "gap [1, 4]");
  cancelled(f.host, 1); f.host.frame();
  require(client->read_until([&] { return client->count("end") == 1; }), "end after the violation");
  const auto& end = *client->last("end").end;
  require(end.reason == "source-retired" && end.next_event_seq == 5, "end(source-retired) with the store's cursor");
  require(until([&] { return f.server->status() == v1::ServerStatus::retired && f.server->endpoint().empty(); }), "v1 retires");
  require(f.host.logs.empty(), "the worker never logs");
  f.host.frame();
  require(f.host.logs.size() == 2 && f.host.log_types[0] == SCS_LOG_TYPE_error && f.host.logs[0] == ETS2TELEMETRY_GAME_LOG_PREFIX " protocol v1 endpoint retired: invariant violation" && f.host.wrong_thread == 0,
    "one fixed log entry, written by the SDK thread at frame_end");
  for (int i = 0; i < 3; ++i) f.host.frame();
  require(f.host.logs.size() == 2, "invariant and close diagnostic each logged once");
  // v0 is unaffected.
  require(v0.start(f.v0_directory) && until([&] { return v0.status() == transport::Status::listening; }, 10000), "v0 listening after the v1 retirement");
  auto live = open_pipe(v0.endpoint()); send(live.get(), framed(v0_hello)); std::vector<std::uint8_t> bytes;
  require(read_some(live.get(), bytes, 3000 * timing_scale) == ReadResult::data, "v0 serves after the v1 retirement");
  live.reset(); v0.stop();
}

// A violation found by the shutdown drain itself: `end` carries source-retired, the endpoint retires, and its fixed entry
// is logged beside a v0 transport entry that arrived in the same frame interval (separate deferred-log slots).
void invariant_at_shutdown() {
  static const sdk::DeferredLog v0_entry{SCS_LOG_TYPE_message, ETS2TELEMETRY_GAME_LOG_PREFIX " transport started after the startup wait"};
  Fixture f; Hold hold; hold.phase = "v1-finish";
  require(f.server->skip_store_for_test(5), "store at 5, channel at 1");
  f.start(); auto client = f.client(true); client->handshake();
  require(client->read_until([&] { return client->covered() >= 4; }), "gap [1, 4]");
  hold.engage(); f.server->signal_stop();
  require(WaitForSingleObject(hold.held.get(), static_cast<DWORD>(3000 * timing_scale)) == WAIT_OBJECT_0, "worker held before its shutdown drain");
  // Copied for the durable consumer after the last loop drain: only the shutdown drain sees it, and rejects it.
  cancelled(f.host, 1); f.adapter->defer_log(&v0_entry);
  hold.disengage();
  require(client->read_until([&] { return client->count("end") == 1; }), "end at shutdown");
  const auto& end = *client->last("end").end;
  require(end.reason == "source-retired" && end.next_event_seq == 5 && end.retained_unacked == 0, "end(source-retired) with the store's cursor");
  f.server->stop();
  require(f.server->status() == v1::ServerStatus::retired && f.server->shutdown_ms() < 1000 && !hold.timed_out.load(), "retired and joined");
  // The retirement calls finish() again after the written `end`; nothing more is written. A second `end` would also make
  // the client's Consumer reject the stream while it reads to the close.
  require(client->closed() && client->count("end") == 1 && f.server->ends() == 1 && f.server->end_attempts() == 1, "exactly one end, then the pipe closes");
  require(f.host.logs.empty(), "workers never log");
  f.host.frame();
  require(f.host.logs.size() == 3 && f.host.logs[0] == v0_entry.message && f.host.log_types[0] == SCS_LOG_TYPE_message &&
    f.host.logs[1] == ETS2TELEMETRY_GAME_LOG_PREFIX " protocol v1 endpoint retired: invariant violation" && f.host.log_types[1] == SCS_LOG_TYPE_error && f.host.wrong_thread == 0,
    "both deferred entries logged once on the SDK thread, in slot order");
  f.host.frame(); require(f.host.logs.size() == 3, "static and connection entries logged once");
}

// A shutdown-drain violation whose `end` write fails: the retirement's second finish() call writes nothing, so no `end`
// can follow a frame that may have been cut. The client closes its pipe while the worker is held, so the write fails.
void invariant_end_failed() {
  Fixture f; Hold hold; hold.phase = "v1-finish";
  require(f.server->skip_store_for_test(5), "store at 5, channel at 1");
  f.start(); auto client = f.client(true); client->handshake();
  require(client->read_until([&] { return client->covered() >= 4; }), "gap [1, 4]");
  hold.engage(); f.server->signal_stop();
  require(WaitForSingleObject(hold.held.get(), static_cast<DWORD>(3000 * timing_scale)) == WAIT_OBJECT_0, "worker held before its shutdown drain");
  cancelled(f.host, 1); client.reset();
  hold.disengage(); f.server->stop();
  std::cout << "failedEndAttempts=" << f.server->end_attempts() << " ends=" << f.server->ends() << '\n';
  require(f.server->end_attempts() == 1 && f.server->ends() == 0, "one end attempt, which failed, and no second one");
  require(f.server->status() == v1::ServerStatus::retired && !hold.timed_out.load(), "retired");
  f.host.frame(); require(f.host.logs.size() == 2 && f.host.logs[0] == ETS2TELEMETRY_GAME_LOG_PREFIX " protocol v1 endpoint retired: invariant violation", "invariant and close diagnostic logged once");
}

// A violation after a stop request keeps the 250 ms `end` budget: with the client's buffer full, the endpoint gives up the
// `end` write at the stop budget instead of the 1 s write deadline.
void invariant_stop_budget() {
  Fixture f; Hold hold;
  require(f.server->skip_store_for_test(5), "store at 5, channel at 1");
  f.start(); auto client = f.client(true); client->handshake();
  // Snapshots alone fill the kernel buffer of a client that no longer reads; no event is observed yet.
  const auto deadline = GetTickCount64() + 10000 * timing_scale; unsigned frames = 0;
  while (!f.server->write_pending() && GetTickCount64() < deadline) { f.host.frame(static_cast<float>(frames++ % 50)); Sleep(1); }
  require(f.server->write_pending(), "kernel-backpressured write");
  hold.engage(); require(WaitForSingleObject(hold.held.get(), static_cast<DWORD>(3000 * timing_scale)) == WAIT_OBJECT_0, "worker held");
  cancelled(f.host, 1); f.server->signal_stop(); hold.disengage();
  f.server->stop(); std::cout << "retireAfterStopShutdownMs=" << f.server->shutdown_ms() << '\n';
  require(f.server->status() == v1::ServerStatus::retired && f.server->ends() == 0, "retired; no end after the stalled write");
  require(f.server->shutdown_ms() < 700, "the stop budget, not the 1 s write deadline, bounds the retirement's end");
  f.host.frame(); require(f.host.logs.size() == 2 && f.host.logs[0] == ETS2TELEMETRY_GAME_LOG_PREFIX " protocol v1 endpoint retired: invariant violation", "invariant and close diagnostic logged once");
}
#endif

// v0 frames continue at their cadence while a v1 client is active and then stalled; the contracts reject each other.
void v0_isolation() {
  Fixture f; transport::Server v0{*f.adapter}; f.start();
  require(v0.start(f.v0_directory) && until([&] { return v0.status() == transport::Status::listening; }, 10000), "v0 listening");
  auto live = open_pipe(v0.endpoint()); send(live.get(), framed(v0_hello)); v0::FrameDecoder decoder; v0::Consumer consumer(true);
  std::vector<v0::Message> messages; std::vector<std::uint8_t> bytes;
  auto read_v0 = [&](ULONGLONG ms) { if (read_some(live.get(), bytes, ms) == ReadResult::data) decoder.push(bytes.data(), bytes.size(), [&](v0::Message m) { consumer.accept(m); messages.push_back(std::move(m)); }); };
  while (messages.size() < 2) read_v0(500);
  auto client = f.client(true); client->handshake();
  // The v1 client reads for one second, then stops reading entirely.
  unsigned v0_snapshots = 0; std::uint64_t offline = UINT64_MAX; bool stalled_seen = false;
  const auto end = GetTickCount64() + 3000;
  while (GetTickCount64() < end) {
    cancelled(f.host, 5); f.host.frame(static_cast<float>(v0_snapshots % 40));
    if (GetTickCount64() + 2000 < end) client->read_until([] { return false; }, 5);
    const auto before = messages.size(); read_v0(20);
    for (auto i = before; i < messages.size(); ++i) if (messages[i].kind == "snapshot") {
      ++v0_snapshots; if (offline == UINT64_MAX) offline = messages[i].continuity.offline_transitions;
      require(messages[i].continuity.offline_transitions == offline, "v0 continuity unaffected by v1");
    }
    stalled_seen = stalled_seen || f.server->write_pending();
    Sleep(10);
  }
  std::cout << "v0SnapshotsDuringV1=" << v0_snapshots << " v1Stalled=" << stalled_seen << '\n';
  require(v0_snapshots >= 15, "v0 snapshots continue while v1 is active and stalled");
  require(f.listening(), "the stalled v1 connection retires independently");
  live.reset(); require(until([&] { return v0.status() == transport::Status::listening; }), "v0 listening");
  // Mutual rejection of the handshakes.
  { auto on_v0 = open_pipe(v0.endpoint()); send(on_v0.get(), framed(hello_payload(true))); std::vector<std::uint8_t> sink; require(read_some(on_v0.get(), sink, 2000 * timing_scale) == ReadResult::closed, "v0 rejects a v1 hello"); }
  { auto on_v1 = f.client(true); send(on_v1->pipe.get(), framed(v0_hello)); require(on_v1->closed() && on_v1->messages.empty(), "v1 rejects a v0 hello"); }
  v0.stop(); require(f.host.wrong_thread == 0, "no SDK calls from either worker");
}

// CAP0 captures every callback without loss while a v1 client is stalled; the contracts reject each other.
void cap0_isolation() {
  Fixture f; cap0::CaptureServer capture{*f.adapter, "synthetic"}; f.start();
  require(capture.start(f.v0_directory) && until([&] { return capture.status() == cap0::CaptureStatus::listening; }), "CAP0 listening");
  const std::string session = "0cab0000-0000-4000-8000-0000000000a1";
  auto evidence = open_pipe(capture.endpoint()); send(evidence.get(), cap0::frame(cap0::hello_payload(session)));
  std::vector<std::uint8_t> buffer, bytes; std::vector<std::string> kinds;
  auto read_cap0 = [&](ULONGLONG ms) {
    if (read_some(evidence.get(), bytes, ms) != ReadResult::data) return;
    buffer.insert(buffer.end(), bytes.begin(), bytes.end());
    while (buffer.size() >= 4) {
      const auto n = static_cast<std::uint32_t>(buffer[0]) | (static_cast<std::uint32_t>(buffer[1]) << 8) | (static_cast<std::uint32_t>(buffer[2]) << 16) | (static_cast<std::uint32_t>(buffer[3]) << 24);
      if (buffer.size() < n + 4) break;
      kinds.push_back(v0::detail::Parser(std::string(buffer.begin() + 4, buffer.begin() + 4 + n)).parse().at("kind").string()); buffer.erase(buffer.begin(), buffer.begin() + 4 + n);
    }
  };
  require(until([&] { read_cap0(50); return !kinds.empty(); }), "CAP0 header");
  auto client = f.client(true); client->handshake();
  // The v1 client stops reading; 600 gameplay events are captured by both endpoints' queues.
  // Batches of 60 stay below the 128-envelope CAP0 queue, and each starts only after the CAP0 worker has emptied the queue,
  // whatever the host's speed: any drop would then come from interference with the stalled v1 client.
  for (int batch = 0; batch < 10; ++batch) {
    cancelled(f.host, 60); f.host.frame();
    require(until([&] { read_cap0(5); return capture.queue().queued_envelopes() == 0; }, 5000), "CAP0 queue emptied before the next batch");
  }
  require(until([&] { read_cap0(20); return capture.queue().counters().attempted >= 600 && capture.queue().queued_envelopes() == 0; }, 5000), "CAP0 drained every envelope");
  const auto counters = capture.queue().counters();
  std::cout << "cap0Attempted=" << counters.attempted << " dropped=" << counters.dropped << " packets=" << kinds.size() << '\n';
  require(counters.dropped == 0, "CAP0 drops nothing while v1 is stalled");
  client.reset(); require(f.listening(), "v1 relistens");
  { auto on_v1 = f.client(true); send(on_v1->pipe.get(), cap0::frame(cap0::hello_payload(session))); require(on_v1->closed() && on_v1->messages.empty(), "v1 rejects a CAP0 hello"); }
  require(f.listening(), "v1 relistens");
  evidence.reset(); require(until([&] { return capture.status() == cap0::CaptureStatus::listening; }), "CAP0 listening");
  { auto on_cap0 = open_pipe(capture.endpoint()); send(on_cap0.get(), framed(hello_payload(true))); std::vector<std::uint8_t> sink; require(read_some(on_cap0.get(), sink, 2000 * timing_scale) == ReadResult::closed, "CAP0 rejects a v1 hello"); }
  capture.stop(); require(f.host.wrong_thread == 0, "no SDK calls from either worker");
}

// Deterministic shutdown: `end` within 250 ms to a reading client, bounded joins with a pending hello read, a stalled write
// and no client.
void shutdown() {
  {
    Fixture f; f.start(); auto client = f.client(true); client->handshake();
    cancelled(f.host, 4); f.host.frame(); require(client->read_until([&] { return client->covered() >= 4; }), "four events");
    // Two more are observed but not yet written when the stop arrives; `end` follows them within the budget.
    cancelled(f.host, 2);
    const auto t = GetTickCount64(); f.server->signal_stop();
    require(client->read_until([&] { return client->count("end") == 1; }, 1000), "end received");
    const auto arrived = GetTickCount64() - t; f.server->stop();
    const auto& end = *client->last("end").end;
    std::cout << "endMs=" << arrived << " shutdownMs=" << f.server->shutdown_ms() << '\n';
    require(arrived <= 250 * timing_scale, "end delivered within 250 ms");
    // The two late events reach the store only while the shutdown drain is within its 150 ms cut-off; on a loaded host the
    // second may stay in the ring (plugin-exit loss above nextEventSeq, OD-5 S11). Every drained event is retained, none
    // is acknowledged, and `end` follows the last item written.
    std::cout << "endNextEventSeq=" << end.next_event_seq << " covered=" << client->covered() << '\n';
    require(end.reason == "plugin-shutdown" && end.next_event_seq >= 5 && end.next_event_seq <= 7 && end.acked_through_event_seq == 0 && end.retained_unacked == end.next_event_seq - 1 &&
      client->covered() >= 4 && client->covered() <= end.next_event_seq - 1, "end after the last written event, nothing waits for an ACK");
    require(client->closed(), "the handle closes after end");
    f.host.frame();
    require(f.host.logs.size() == 1 && f.host.logs[0].find("reason=SHUTDOWN phase=live write=end end=plugin-shutdown win32=0") != std::string::npos,
      "a clean shutdown keeps its intentional reason after the final write");
    require(f.server->shutdown_ms() < 1000 && !f.server->shutdown_deadline_exceeded() && f.server->status() == v1::ServerStatus::stopped, "joined under the deadline");
    require(f.server->endpoint().empty() && GetFileAttributesW(f.record().c_str()) == INVALID_FILE_ATTRIBUTES, "endpoint and record retired");
  }
  {
    Fixture f; f.start(); auto pending = f.connect(); Sleep(100);
    f.server->stop(); std::cout << "pendingHelloShutdownMs=" << f.server->shutdown_ms() << '\n';
    require(f.server->shutdown_ms() < 1000 && !f.server->shutdown_deadline_exceeded(), "pending hello read cancelled and joined");
  }
  {
    Fixture f; f.start(); auto client = f.client(true); client->handshake();
    scs_named_value_t big[]{named("cargo", text(long_name_n.c_str())), named("source.city", text(long_name_s.c_str())), scs_named_value_t{}};
    const auto end = GetTickCount64() + 5000 * timing_scale;
    // The client's pipe holds its whole 65,540-byte quota unread, so no further write, `end` included, can complete: the
    // in-flight write at the stop is cancelled at the budget, or the write deadline has already closed the connection.
    auto full = [&] { DWORD n = 0; return PeekNamedPipe(client->pipe.get(), nullptr, 0, nullptr, &n, nullptr) && n >= 65540; };
    while (!full() && GetTickCount64() < end) { f.host.config("job", big); cancelled(f.host, 10); f.host.frame(); Sleep(1); }
    require(full(), "kernel-backpressured connection before the stop");
    f.server->stop(); std::cout << "stalledWriteShutdownMs=" << f.server->shutdown_ms() << '\n';
    require(f.server->shutdown_ms() < 1000 && !f.server->shutdown_deadline_exceeded() && f.server->ends() == 0, "a stalled write is cancelled, observed and joined; no end after a cut frame");
  }
  {
    Fixture f; f.start(); f.server->stop(); require(f.server->shutdown_ms() < 1000 && f.server->status() == v1::ServerStatus::stopped, "idle endpoint joins");
  }
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
  {
    // stop() must not cancel synchronous I/O in the worker's exit path: a cancelled record deletion would leave the
    // discovery record behind. The read here ends only through the 750 ms fallback write.
    Fixture f; f.start(); const auto record = f.record(); BlockedRead exit("v1-exit");
    bool fallback = false; std::thread guard([&] { fallback = exit.fallback(750); });
    f.server->stop(); guard.join();
    std::cout << "exitReadError=" << exit.error.load() << " fallback=" << fallback << " shutdownMs=" << f.server->shutdown_ms() << '\n';
    require(exit.fired.load() && exit.error.load() == ERROR_SUCCESS && fallback, "stop never cancels synchronous I/O in the exit path");
    require(f.server->endpoint().empty() && GetFileAttributesW(record.c_str()) == INVALID_FILE_ATTRIBUTES && f.server->shutdown_ms() < 1000, "the record is deleted and the worker joined");
  }
  {
    // stop() still cancels a synchronous read while the worker inspects a connecting peer's image.
    Fixture f; f.start(); BlockedRead inspect("hash-before-read"); auto client = f.connect();
    require(WaitForSingleObject(inspect.reached.get(), static_cast<DWORD>(3000 * timing_scale)) == WAIT_OBJECT_0, "worker inspecting the peer");
    bool fallback = false; std::thread guard([&] { fallback = inspect.fallback(750); });
    f.server->stop(); guard.join();
    std::cout << "inspectReadError=" << inspect.error.load() << " fallback=" << fallback << " shutdownMs=" << f.server->shutdown_ms() << '\n';
    require(!fallback && inspect.error.load() == ERROR_OPERATION_ABORTED && f.server->shutdown_ms() < 1000, "stop cancels a synchronous read during peer inspection");
  }
#endif
}

// Threads of this process whose start address lies inside `module`.
std::size_t module_threads(HMODULE module) {
  using Query = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationThread"));
  MODULEINFO info{}; if (!query || !GetModuleInformation(GetCurrentProcess(), module, &info, sizeof(info))) return SIZE_MAX;
  const auto base = reinterpret_cast<std::uintptr_t>(info.lpBaseOfDll), limit = base + info.SizeOfImage;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)); THREADENTRY32 entry{}; entry.dwSize = sizeof(entry); std::size_t count = 0;
  if (!snapshot || !Thread32First(snapshot.get(), &entry)) return SIZE_MAX;
  do {
    if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
    Handle thread(OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID)); void* start = nullptr;
    // ThreadQuerySetWin32StartAddress.
    if (thread && query(thread.get(), 9, &start, sizeof(start), nullptr) >= 0) { const auto address = reinterpret_cast<std::uintptr_t>(start); if (address >= base && address < limit) ++count; }
  } while (Thread32Next(snapshot.get(), &entry));
  return count;
}
// The start module of each thread of this process, for the record when a thread count differs from its baseline.
void describe_threads() {
  using Query = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationThread"));
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)); THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
  if (!query || !snapshot || !Thread32First(snapshot.get(), &entry)) return;
  do {
    if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
    Handle thread(OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID)); void* start = nullptr; HMODULE module = nullptr; std::array<char, MAX_PATH> name{};
    if (thread && query(thread.get(), 9, &start, sizeof(start), nullptr) >= 0 &&
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, static_cast<LPCSTR>(start), &module))
      GetModuleFileNameA(module, name.data(), static_cast<DWORD>(name.size()));
    std::cout << "thread " << entry.th32ThreadID << " start=" << start << " module=" << name.data() << '\n';
  } while (Thread32Next(snapshot.get(), &entry));
}
// Threads of this process, except ntdll thread-pool workers: Windows creates those on demand (for the loader and I/O),
// they belong to the process and exit on their own idle timeout, and the DLL never starts one. Counting them would make a
// baseline depend on the host's scheduling rather than on the DLL.
std::size_t process_threads() {
  using Query = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto query = reinterpret_cast<Query>(GetProcAddress(ntdll, "NtQueryInformationThread"));
  MODULEINFO info{}; if (!query || !GetModuleInformation(GetCurrentProcess(), ntdll, &info, sizeof(info))) return SIZE_MAX;
  const auto base = reinterpret_cast<std::uintptr_t>(info.lpBaseOfDll), limit = base + info.SizeOfImage;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)); THREADENTRY32 entry{}; entry.dwSize = sizeof(entry); std::size_t count = 0;
  if (!snapshot || !Thread32First(snapshot.get(), &entry)) return SIZE_MAX;
  do {
    if (entry.th32OwnerProcessID != GetCurrentProcessId()) continue;
    Handle thread(OpenThread(THREAD_QUERY_INFORMATION, FALSE, entry.th32ThreadID)); void* start = nullptr;
    // ThreadQuerySetWin32StartAddress. A thread whose start cannot be read is counted.
    const bool pool = thread && query(thread.get(), 9, &start, sizeof(start), nullptr) >= 0 &&
      reinterpret_cast<std::uintptr_t>(start) >= base && reinterpret_cast<std::uintptr_t>(start) < limit;
    if (!pool) ++count;
  } while (Thread32Next(snapshot.get(), &entry));
  return count;
}

// The official SDK lifecycle in the isolated test DLL: shutdown with a pending hello read, a live read, a kernel-
// backpressured v1 write, and v0 and v1 stalled together, each under 1,000 ms, then FreeLibrary and a reload.
void dll_lifecycle(const char* path) {
  Host host; const auto user = transport::current_user(); transport::OwnerSecurity security(user.sid); const auto self = transport::inspect_peer(GetCurrentProcessId());
  const auto baseline = process_threads(); std::set<std::string> sessions;
  for (unsigned scenario = 0; scenario < 4; ++scenario) {
    const auto v0_directory = temporary_directory(security, L"ET004b-dll-v0-"), v1_directory = temporary_directory(security, L"ET004b-dll-v1-");
    write_policy(v0_directory, security, user, self); write_policy(v1_directory, security, user, self);
    HMODULE module = LoadLibraryA(path); require(module != nullptr, "isolated test DLL load");
    auto init = reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module, "scs_telemetry_init"));
    auto shutdown_export = reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module, "scs_telemetry_shutdown"));
    using SetDirectory = int (*)(const wchar_t*); using GetEndpoint = int (*)(wchar_t*, unsigned); using Flag = int (*)();
    auto set_v0 = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_directory"));
    auto set_v1 = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_v1_directory"));
    auto v0_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_endpoint"));
    auto v1_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_v1_endpoint"));
    auto v0_pending = reinterpret_cast<Flag>(GetProcAddress(module, "ets2telemetry_test_write_pending"));
    auto v1_pending = reinterpret_cast<Flag>(GetProcAddress(module, "ets2telemetry_test_v1_write_pending"));
    auto attached = reinterpret_cast<Flag>(GetProcAddress(module, "ets2telemetry_test_v1_attached"));
    require(init && shutdown_export && set_v0 && set_v1 && v0_endpoint && v1_endpoint && v0_pending && v1_pending && attached, "official exports and test-only seams");
    require(set_v0(v0_directory.c_str()) && set_v1(v1_directory.c_str()), "isolated DLL directories");
    const auto before_init = process_threads(); auto params = host.params(); require(init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "official initialization");
    require(attached() == 1, "the channel is attached after initialize");
    std::array<wchar_t, 512> name{}; require(until([&] { return v1_endpoint(name.data(), static_cast<unsigned>(name.size())) != 0; }), "v1 endpoint ready");
    const auto owned = module_threads(module); std::cout << "dllOwnedThreads=" << owned << " processThreads=" << process_threads() << " beforeInit=" << before_init << '\n';
    require(process_threads() >= before_init + 3 && (owned == 0 || owned >= 3), "the DLL runs its workers");
    std::unique_ptr<Client> client; Handle live;
    if (scenario == 0) { client = std::make_unique<Client>(open_pipe(name.data()), true); Sleep(50); } // The hello read stays pending.
    else {
      // ET-052: scenario 1 connects at minor 2 to the real DLL, whose captured break (61 minutes, delivered in one frame
      // before the connection) is in the checkpoint; the other scenarios keep a minor-0 client.
      if (scenario == 1) { host.break_minutes = 61; host.frame(); }
      client = std::make_unique<Client>(open_pipe(name.data()), true, scenario == 1 ? 2U : 0U); client->handshake();
      require(sessions.insert(client->session()).second, "a new pluginSessionId per reload");
      if (scenario == 1) {
        const auto& break_reading = client->messages[1].state->next_mandatory_break;
        require(client->messages[0].minor == 2 && client->messages[1].minor == 2 && client->messages[1].state->gearbox && break_reading && break_reading->reading.value && *break_reading->reading.value == 61, "the DLL serves minor 2 with the captured break");
      }
      cancelled(host, 2); host.frame();
      require(client->read_until([&] { return client->covered() >= 2; }), "events from the DLL");
      require(coverage_messages(*client)[0]->event && coverage_messages(*client)[0]->event->event_seq == 1, "eventSeq starts at 1 in the new plugin session");
      if (scenario == 1) {
        // A second initialization of the same session fails in the adapter; the channel is neither re-prepared nor re-attached.
        require(init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_already_registered && attached() == 1, "no second initialization in one session");
        cancelled(host, 1); host.frame(); require(client->read_until([&] { return client->covered() >= 3; }) && coverage_messages(*client)[2]->event->event_seq == 3, "the session continues");
      }
      if (scenario == 3) {
        std::array<wchar_t, 512> v0_name{}; require(until([&] { return v0_endpoint(v0_name.data(), static_cast<unsigned>(v0_name.size())) != 0; }), "v0 endpoint ready");
        live = open_pipe(v0_name.data()); send(live.get(), framed(v0_hello));
      }
      if (scenario >= 2) {
        scs_named_value_t big[]{named("cargo", text(long_name_n.c_str())), named("source.city", text(long_name_s.c_str())), scs_named_value_t{}};
        const auto end = GetTickCount64() + 10000 * timing_scale;
        const auto stall_started = GetTickCount64(); unsigned iterations = 0; ULONGLONG v0_since = 0, v1_since = 0;
        // Backpressure is observed from the client side: 48 KiB wait unread in a client's pipe while callbacks keep
        // producing, so the server's next write on that connection stays pending. The workers' own pending flags are only
        // reported: under load a worker may first poll a write after its 1 s deadline and never report it as pending.
        static constexpr DWORD backpressure_bytes = 48 * 1024;
        auto full = [](HANDLE pipe) { DWORD n = 0; return PeekNamedPipe(pipe, nullptr, 0, nullptr, &n, nullptr) && n >= backpressure_bytes; };
        // Each endpoint retires a write that stays pending for 1 s, and v0 fills its pipe far more slowly than v1. A pipe
        // that has stayed full for 500 ms gets 16 KiB read, so its pending write finishes and the next one stalls again:
        // both connections stay backpressured until both pipes are full at once. The raw bytes are discarded.
        auto trickle = [](HANDLE pipe) { std::vector<std::uint8_t> sink; read_some(pipe, sink, 20, 16384); };
        auto keep = [&](HANDLE pipe, ULONGLONG& since) {
          const auto now = GetTickCount64();
          if (!full(pipe)) since = 0; else if (!since) since = now; else if (now - since >= 500) { trickle(pipe); since = 0; }
        };
        // Paced bursts of large job records: a flood would keep the worker measuring events instead of writing them.
        while (!(full(client->pipe.get()) && (scenario == 2 || full(live.get()))) && GetTickCount64() < end) {
          for (int k = 0; k < 10; ++k) host.config("job", big);
          host.frame(); ++iterations; Sleep(1);
          if (scenario == 3) { keep(client->pipe.get(), v1_since); keep(live.get(), v0_since); }
        }
        std::cout << "stallMs=" << GetTickCount64() - stall_started << " iterations=" << iterations << " v0Pending=" << v0_pending() << " v1Pending=" << v1_pending() << std::endl;
        require(full(client->pipe.get()) && (scenario == 2 || full(live.get())), scenario == 2 ? "DLL kernel-backpressured v1 connection" : "DLL v0 and v1 connections backpressured together");
      }
    }
    const auto started = GetTickCount64(); shutdown_export(); const auto elapsed = GetTickCount64() - started;
    std::cout << "dll scenario=" << scenario << " shutdownMs=" << elapsed << '\n';
    require(elapsed < 1000, "official shutdown joins every worker under 1,000 ms");
    require(attached() == 0, "explicit attach_events(nullptr) before shutdown returns");
    // Every worker the DLL started has exited. Where the sanitizer intercepts thread creation, start addresses are not
    // attributable to the module, and the process thread count is the evidence.
    if (owned) require(module_threads(module) == 0, "no DLL-owned thread survives shutdown");
    require(until([&] { return process_threads() <= before_init; }, 2000), "the process thread count returns to its value before initialization");
    client.reset(); live.reset();
    require(FreeLibrary(module) != FALSE, "test DLL unload after joined workers");
    require(host.wrong_thread == 0, "the DLL's workers make no SDK API call");
    remove_directory(v0_directory); remove_directory(v1_directory);
  }
  const bool returned = until([&] { return process_threads() <= baseline; }, 5000); if (!returned) describe_threads();
  require(returned, "the thread count returns to its baseline");
  std::cout << "threads baseline=" << baseline << " after=" << process_threads() << '\n';
}
} // namespace

int main(int argc, char** argv) {
  try {
    const std::map<std::string, std::function<void()>> cases{
      {"handshake", handshake}, {"gearbox", gearbox}, {"mandatory-break", mandatory_break}, {"mandatory-break-unsupported", mandatory_break_unsupported}, {"mandatory-break-v0", mandatory_break_v0}, {"live-only", live_only}, {"durable", durable_delivery}, {"redelivery", redelivery}, {"stalled-reader", stalled_reader},
      {"fuzz", fuzz}, {"rejection", rejection}, {"collision", collision}, {"policy", policy}, {"v0-isolation", v0_isolation}, {"cap0-isolation", cap0_isolation}, {"shutdown", shutdown}
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
      , {"retention", [] { retention(); Fixture clamp; clamp.start(); capture_clamp(clamp); }}, {"overflow", overflow}, {"ack-control", ack_control}, {"exhaustion", exhaustion}, {"invariant", [] { invariant(); invariant_at_shutdown(); invariant_end_failed(); invariant_stop_budget(); }}
#endif
    };
    auto timed = [](const std::string& name, const std::function<void()>& fn) { const auto start = GetTickCount64(); std::cout << name << '\n' << std::flush; fn(); std::cout << name << " elapsedMs=" << GetTickCount64() - start << '\n' << std::flush; };
    if (argc == 3 && std::string(argv[1]) == "dll") timed("dll", [&] { dll_lifecycle(argv[2]); });
    else if (argc == 2) timed(argv[1], cases.at(argv[1]));
    else for (const auto& entry : cases) timed(entry.first, entry.second);
    std::cout << "Actual Windows protocol v1 endpoint: " << assertions << " assertions passed; second-user/remote/game checks pending\n"; return 0;
  } catch (const std::exception& e) { std::cerr << "v1 transport failure after " << assertions << " assertions: " << e.what() << '\n'; return 1; }
}
