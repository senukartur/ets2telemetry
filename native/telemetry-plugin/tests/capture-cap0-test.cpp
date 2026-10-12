// CAP0 evidence capture controls. Fake SDK callbacks, isolated temporary directories and actual
// local pipes only; no game, game directory or user history is touched.
#include "capture-server.hpp"
#include "capture-wire.hpp"
#include "pipe-server.hpp"
#include "pipe-discovery.hpp"
#include "protocol-json.hpp"
#include "common/scssdk_telemetry_common_gameplay_events.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <deque>
#include <limits>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <objbase.h>
#include <set>
#include <string>
#include <thread>
#include <vector>

using namespace ets2telemetry;
using transport::Handle;
namespace {
unsigned assertions = 0;
// Sanitized builds on small hosted runners are slower; functional assertions are unchanged, only wall-clock bounds widen.
#if defined(__SANITIZE_ADDRESS__)
constexpr unsigned long long timing_scale = 4;
#else
constexpr unsigned long long timing_scale = 1;
#endif
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
bool until(const std::function<bool()>& predicate, DWORD ms = 3000) {
  const auto end = GetTickCount64() + ms; do { if (predicate()) return true; Sleep(2); } while (GetTickCount64() < end); return false;
}
// Fake official SDK host. Every SDK API entry records whether it ran on the SDK caller thread.
struct Host {
  static Host* active;
  std::thread::id caller = std::this_thread::get_id(); std::atomic<unsigned> wrong_thread{0}, api_calls{0};
  std::map<scs_event_t, std::pair<scs_telemetry_event_callback_t, scs_context_t>> events;
  struct Channel { scs_telemetry_channel_callback_t cb; scs_context_t ctx; };
  std::map<std::string, Channel> channels; std::uint64_t frames = 0;
  Host() { active = this; }
  static void check() { ++active->api_calls; if (active->caller != std::this_thread::get_id()) ++active->wrong_thread; }
  static SCSAPI_VOID log(scs_log_type_t, scs_string_t) { check(); }
  static SCSAPI_RESULT reg_event(scs_event_t id, scs_telemetry_event_callback_t cb, scs_context_t ctx) { check(); active->events[id] = {cb, ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_event(scs_event_t id) { check(); active->events.erase(id); return SCS_RESULT_ok; }
  static SCSAPI_RESULT reg_channel(scs_string_t name, scs_u32_t, scs_value_type_t, scs_u32_t, scs_telemetry_channel_callback_t cb, scs_context_t ctx) { check(); active->channels[name] = {cb, ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_channel(scs_string_t name, scs_u32_t, scs_value_type_t) { check(); active->channels.erase(name); return SCS_RESULT_ok; }
  scs_telemetry_init_params_v100_t params(const char* game = "eut2") {
    scs_telemetry_init_params_v100_t p{}; p.common.game_id = game; p.common.game_version = SCS_MAKE_VERSION(1, 20); p.common.log = log;
    p.register_for_event = reg_event; p.unregister_from_event = unreg_event; p.register_for_channel = reg_channel; p.unregister_from_channel = unreg_channel; return p;
  }
  void event(scs_event_t id, const void* value = nullptr) { auto entry = events.at(id); entry.first(id, value, entry.second); }
  void channel(const char* name, const scs_value_t& v) { const auto entry = channels.at(name); entry.cb(name, SCS_U32_NIL, &v, entry.ctx); }
  void frame(float speed, std::uint32_t flags = 0, std::uint64_t at = 0) {
    scs_telemetry_frame_start_t f{}; f.flags = flags; f.render_time = f.simulation_time = f.paused_simulation_time = at ? at : ++frames * 50000;
    event(SCS_TELEMETRY_EVENT_frame_start, &f);
    scs_value_t v{}; v.type = SCS_VALUE_TYPE_float; v.value_float.value = speed; channel("truck.speed", v); event(SCS_TELEMETRY_EVENT_frame_end);
  }
  void config(const char* id, const scs_named_value_t* attributes) { scs_telemetry_configuration_t c{id, attributes}; event(SCS_TELEMETRY_EVENT_configuration, &c); }
  void gameplay(const char* id, const scs_named_value_t* attributes) { scs_telemetry_gameplay_event_t g{id, attributes}; event(SCS_TELEMETRY_EVENT_gameplay, &g); }
};
Host* Host::active = nullptr;
scs_value_t value_of(scs_value_type_t type) { scs_value_t v{}; v.type = type; return v; }
scs_value_t text(const char* s) { auto v = value_of(SCS_VALUE_TYPE_string); v.value_string.value = s; return v; }
scs_value_t u64(std::uint64_t n) { auto v = value_of(SCS_VALUE_TYPE_u64); v.value_u64.value = n; return v; }
scs_value_t s64(std::int64_t n) { auto v = value_of(SCS_VALUE_TYPE_s64); v.value_s64.value = n; return v; }
scs_value_t u32(std::uint32_t n) { auto v = value_of(SCS_VALUE_TYPE_u32); v.value_u32.value = n; return v; }
scs_value_t s32(std::int32_t n) { auto v = value_of(SCS_VALUE_TYPE_s32); v.value_s32.value = n; return v; }
scs_value_t f32(float n) { auto v = value_of(SCS_VALUE_TYPE_float); v.value_float.value = n; return v; }
scs_named_value_t named(const char* name, scs_value_t value, scs_u32_t index = SCS_U32_NIL) { scs_named_value_t n{}; n.name = name; n.index = index; n.value = value; return n; }
// A borrowed SDK-like configuration whose strings are owned here and can be mutated after callbacks.
struct BigConfiguration {
  std::vector<std::string> names, values; std::vector<scs_named_value_t> attributes;
  BigConfiguration(std::size_t count, std::size_t bytes, char fill = 'x', bool terminate = true) {
    names.resize(count); values.resize(count); attributes.resize(count + (terminate ? 1 : 0));
    for (std::size_t i = 0; i < count; ++i) { names[i] = "attribute." + std::to_string(i); values[i] = std::string(bytes, fill); attributes[i] = named(names[i].c_str(), text(values[i].c_str())); }
    if (terminate) attributes[count] = scs_named_value_t{};
  }
};
std::string utf8(const std::wstring& w) { const auto n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr); std::string s(static_cast<std::size_t>(n), '\0'); WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr); return s; }
void write_policy(const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user, const transport::PeerIdentity& peer, const std::string& digest = "") {
  v0::Json j{v0::Json::Object{{"schemaVersion", v0::Json{1.0}}, {"userTag", v0::Json{user.tag}}, {"windowsSessionId", v0::Json{static_cast<double>(user.session)}},
    {"allowedExecutables", v0::Json{v0::Json::Array{v0::Json{v0::Json::Object{{"path", v0::Json{utf8(peer.image)}}, {"sha256", v0::Json{digest.empty() ? peer.sha256 : digest}}}}}}}}};
  const auto bytes = v0::detail::serialize(j);
  Handle f(CreateFileW((directory + L"\\service-policy.json").c_str(), GENERIC_WRITE, 0, security.attributes(), CREATE_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(static_cast<bool>(f), "policy create"); DWORD written = 0; require(WriteFile(f.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size(), "policy write");
}
std::wstring temporary_directory(const transport::OwnerSecurity& security) {
  WCHAR temporary[MAX_PATH]{}; require(GetTempPathW(MAX_PATH, temporary) > 0, "temp path"); GUID id{}; require(CoCreateGuid(&id) == S_OK, "guid"); WCHAR label[40]{}; StringFromGUID2(id, label, 40);
  const auto directory = std::wstring(temporary) + L"CAP01a-" + label; security.ensure_directory(directory); return directory;
}
struct Fixture {
  transport::UserIdentity user = transport::current_user(); transport::OwnerSecurity security{user.sid}; transport::PeerIdentity self = transport::inspect_peer(GetCurrentProcessId());
  Host host; std::unique_ptr<sdk::Adapter> adapter = std::make_unique<sdk::Adapter>();
  cap0::CaptureServer capture{*adapter, "synthetic"}; transport::Server live{*adapter}; std::wstring directory;
  Fixture() { directory = temporary_directory(security); auto p = host.params(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &p) == SCS_RESULT_ok, "SDK initialize"); write_policy(directory, security, user, self); }
  ~Fixture() { capture.stop(); live.stop(); adapter->shutdown(); DeleteFileW((directory + L"\\service-policy.json").c_str()); RemoveDirectoryW(directory.c_str()); }
  void start() { require(capture.start(directory), "capture worker start"); require(until([&] { return capture.status() == cap0::CaptureStatus::listening; }), "capture listening"); }
  Handle connect(const std::wstring& endpoint) { Handle h; require(until([&] { h.reset(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)); return static_cast<bool>(h); }), "client connect"); return h; }
};
bool io(HANDLE pipe, bool read, std::uint8_t* bytes, DWORD count, DWORD& transferred, DWORD deadline = 3000) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED op{}; op.hEvent = event.get();
  const auto ok = read ? ReadFile(pipe, bytes, count, &transferred, &op) : WriteFile(pipe, bytes, count, &transferred, &op);
  if (ok) return true; if (GetLastError() != ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.get(), deadline) != WAIT_OBJECT_0) { CancelIoEx(pipe, &op); GetOverlappedResult(pipe, &op, &transferred, TRUE); return false; }
  return GetOverlappedResult(pipe, &op, &transferred, FALSE) != FALSE;
}
void send(HANDLE h, const std::vector<std::uint8_t>& bytes) { DWORD written = 0; auto copy = bytes; require(io(h, false, copy.data(), static_cast<DWORD>(copy.size()), written) && written == copy.size(), "client write"); }
const std::string session_id = "0cab0000-0000-4000-8000-0000000000a1";
struct Packets {
  std::vector<std::uint8_t> buffer; std::vector<v0::Json> items; std::vector<std::size_t> sizes;
  // Reads until `minimum` packets are complete; returns false on EOF/timeout.
  bool read(HANDLE h, std::size_t minimum, DWORD ms = 3000) {
    const auto deadline = GetTickCount64() + ms;
    while (items.size() < minimum) {
      const auto now = GetTickCount64(); if (now >= deadline) return false;
      std::vector<std::uint8_t> chunk(65540); DWORD count = 0;
      if (!io(h, true, chunk.data(), static_cast<DWORD>(chunk.size()), count, static_cast<DWORD>(deadline - now)) || !count) return false;
      buffer.insert(buffer.end(), chunk.begin(), chunk.begin() + count);
      while (buffer.size() >= 4) {
        const auto n = static_cast<std::uint32_t>(buffer[0]) | (static_cast<std::uint32_t>(buffer[1]) << 8) | (static_cast<std::uint32_t>(buffer[2]) << 16) | (static_cast<std::uint32_t>(buffer[3]) << 24);
        require(n > 0 && n <= cap0::max_packet_bytes, "CAP0 packet bound");
        if (buffer.size() < n + 4) break;
        const std::string payload(buffer.begin() + 4, buffer.begin() + 4 + n); buffer.erase(buffer.begin(), buffer.begin() + 4 + n);
        items.push_back(v0::detail::Parser(payload).parse()); sizes.push_back(n);
        require(items.back().at("format").string() == cap0::format && items.back().at("captureSessionId").string() == session_id, "packet format and session");
        require(items.back().at("packetSeq").string() == std::to_string(items.size() - 1), "packet sequence contiguous from header");
      }
    }
    return true;
  }
  const v0::Json& last() const { return items.back(); }
  std::vector<const v0::Json*> of(const char* kind) const { std::vector<const v0::Json*> out; for (const auto& i : items) if (i.at("kind").string() == kind) out.push_back(&i); return out; }
};
void hello(HANDLE h) { send(h, cap0::frame(cap0::hello_payload(session_id))); }
const v0::Json& observation(const v0::Json& packet, const char* name) {
  for (const auto& o : std::get<v0::Json::Array>(packet.at("data").at("observations").value))
    if (o.at("name").at("available").boolean() && o.at("name").at("value").string() == name) return o;
  throw std::runtime_error(std::string("observation missing: ") + name);
}

// Mirrors the TypeScript CAP0 loss validator (capture-cap0.ts): the decoder rejects any violation.
bool loss_consistent(const v0::Json& data) {
  const auto attempted = std::stoull(data.at("attemptedEnvelopes").string()), dropped = std::stoull(data.at("droppedEnvelopes").string());
  const auto slots = std::stoull(data.at("droppedQueueFull").string()), bytes = std::stoull(data.at("droppedBytesFull").string());
  return dropped <= attempted && slots + bytes == dropped && (!data.at("lastDroppedEnvelopeSeq").at("available").boolean() || std::stoull(data.at("lastDroppedEnvelopeSeq").at("value").string()) <= attempted);
}
bool counters_consistent(const cap0::Counters& c) {
  return c.attempted == c.enqueued + c.dropped && c.dropped == c.dropped_full_slots + c.dropped_full_bytes && (!c.dropped || (c.last_dropped_seq && c.last_dropped_seq <= c.attempted)) &&
    (c.last_drop_available || c.last_drop_monotonic_ns == 0);
}

void queue_bounds() {
  cap0::EvidenceQueue q; cap0::Context c; c.kind = cap0::Kind::lifecycle; c.id = "simulation.started";
  q.capture(c); require(q.counters().attempted == 0 && q.queued_envelopes() == 0, "closed gate copies nothing before opt-in");
  require(q.prepare(), "prepare allocates outside callbacks"); q.open();
  for (unsigned i = 0; i < cap0::queue_envelopes; ++i) { c.boundary_order = i + 1; q.capture(c); }
  require(q.queued_envelopes() == 128 && q.counters().dropped == 0, "128 envelopes fit");
  c.boundary_order = 129; q.capture(c);
  auto counters = q.counters();
  require(counters.dropped == 1 && counters.dropped_full_slots == 1 && counters.last_dropped_seq == 129 && q.queued_envelopes() == 128, "129th envelope newest-dropped with slot loss counter");
  cap0::Envelope e; require(q.pop(e) && e.seq == 1 && e.dropped_before == 0 && e.boundary_order == 1, "FIFO oldest retained");
  c.boundary_order = 130; q.capture(c);
  std::uint64_t expected = 2; cap0::Envelope last;
  while (q.pop(e)) { if (expected == 129) expected = 130; require(e.seq == expected, "FIFO order preserved after drop"); ++expected; last = e; }
  require(last.seq == 130 && last.dropped_before == 1 && last.boundary_order == 130, "explicit drop boundary precedes next retained envelope");
  // Byte bound: large configuration envelopes exhaust 2 MiB before 128 slots.
  BigConfiguration big(255, 1024); cap0::Context b; b.kind = cap0::Kind::configuration; b.id = "job"; b.attributes = big.attributes.data(); b.attributes_expected = true;
  const auto size = cap0::EvidenceQueue::encoded_size(b); require(size > 250000 && size < 400000, "large envelope size measured exactly");
  unsigned accepted = 0; while (q.counters().dropped_full_bytes == 0) { q.capture(b); if (q.counters().dropped_full_bytes == 0) ++accepted; require(accepted < 128, "byte bound reached"); }
  require(accepted == cap0::queue_bytes / size && q.queued_bytes() <= cap0::queue_bytes, "byte cap admits exactly what fits in 2 MiB");
  counters = q.counters(); require(counters.dropped == 2 && counters.dropped_bytes >= size + 0, "byte drop counted with its encoded size");
  // Wrap-around keeps record contents and FIFO identity intact across many reuse cycles. A record
  // that cannot fit contiguously after wrap padding is newest-dropped and counted, never torn.
  std::deque<std::string> expected_markers(accepted, std::string(1024, 'x')); unsigned wrapped_drops = 0;
  for (unsigned cycle = 0; cycle < 400; ++cycle) {
    big.values[0] = "cycle-" + std::to_string(cycle); big.attributes[0] = named(big.names[0].c_str(), text(big.values[0].c_str()));
    if (!expected_markers.empty()) {
      require(q.pop(e), "wrap pop");
      require(e.attributes.size() == 255 && e.attributes[254].value.text == std::string(1024, 'x'), "wrap record content intact");
      require(e.attributes[0].value.text == expected_markers.front(), "wrap record order and identity"); expected_markers.pop_front();
    }
    const auto drops = q.counters().dropped; q.capture(b);
    if (q.counters().dropped == drops) expected_markers.push_back(big.values[0]); else ++wrapped_drops;
    require(q.queued_bytes() <= cap0::queue_bytes && q.queued_envelopes() <= cap0::queue_envelopes, "bounds hold while wrapping");
  }
  require(wrapped_drops < 200, "most wrapped records fit");
  while (q.pop(e)) { require(e.attributes[0].value.text == expected_markers.front(), "final FIFO drain"); expected_markers.pop_front(); }
  require(expected_markers.empty(), "every accepted wrapped record retained");
  q.close(); const auto before = q.counters().attempted; q.capture(c); require(q.counters().attempted == before, "closed gate stops copying");
  require(q.prepare() && q.counters().attempted == 0 && q.queued_envelopes() == 0, "prepare resets per-capture state");
  std::cout << "largeEnvelopeBytes=" << size << " acceptedBeforeByteDrop=" << accepted << " wrappedDrops=" << wrapped_drops << "/400\n";
}

void adapter_copy() {
  // Two isolated fake hosts drive an evidence-enabled adapter and a reference adapter identically.
  Host reference_host; sdk::Adapter reference; auto rp = reference_host.params(); require(reference.initialize(SCS_TELEMETRY_VERSION_1_01, &rp) == SCS_RESULT_ok, "reference init");
  Host host; sdk::Adapter adapter; auto p = host.params(); require(adapter.initialize(SCS_TELEMETRY_VERSION_1_01, &p) == SCS_RESULT_ok, "init");
  cap0::EvidenceQueue q; adapter.attach_evidence(&q);
  auto both = [&](const std::function<void(Host&)>& action) { action(host); action(reference_host); };
  std::string cargo = "cargo.fixture", invalid_utf8 = "\xff\xfe", too_long(1025, 'a'), long_name(129, 'n'), control = "a\tb";
  std::vector<scs_named_value_t> job{named("cargo.id", text(cargo.c_str())), named("income", u64(UINT64_MAX)), named("planned_distance.km", u32(1234)),
    named("wheel.position", value_of(SCS_VALUE_TYPE_fvector), 3), named("bad.utf8", text(invalid_utf8.c_str())), named("too.long", text(too_long.c_str())),
    named(long_name.c_str(), s32(-5)), named("control.text", text(control.c_str())), named("nan", f32(std::numeric_limits<float>::quiet_NaN())), scs_named_value_t{}};
  job[3].value.value_fvector.x = 1.5F; job[3].value.value_fvector.y = -2.25F; job[3].value.value_fvector.z = 0.1F;
  auto place = value_of(SCS_VALUE_TYPE_dplacement); place.value_dplacement.position.x = 123456.789; place.value_dplacement.orientation.heading = 0.25;
  std::vector<scs_named_value_t> delivered{named("revenue", s64(INT64_MIN)), named("earned.xp", s32(250)), named("distance.km", f32(12.5F)), named("auto.park.used", value_of(SCS_VALUE_TYPE_bool)), named("placement", place), scs_named_value_t{}};
  delivered[3].value.value_bool.value = 1;
  // Before opt-in nothing is copied.
  both([&](Host& h) { h.config("job", job.data()); });
  require(q.counters().attempted == 0 && q.queued_envelopes() == 0, "no evidence before the gate opens");
  require(q.prepare(), "prepare"); q.open();
  adapter.set_consumer(true, true); reference.set_consumer(true, true);
  both([&](Host& h) { h.config("job", job.data()); });
  cargo.assign("mutated.after.callback"); // The envelope copied bytes, not SDK pointers.
  both([&](Host& h) { h.gameplay("job.delivered", delivered.data()); h.event(SCS_TELEMETRY_EVENT_started); });
  scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = frame.paused_simulation_time = 1000;
  scs_telemetry_frame_start_t restart{}; restart.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart; restart.render_time = 5;
  both([&](Host& h) { h.event(SCS_TELEMETRY_EVENT_frame_start, &frame); h.event(SCS_TELEMETRY_EVENT_frame_end); h.event(SCS_TELEMETRY_EVENT_frame_start, &restart); h.event(SCS_TELEMETRY_EVENT_frame_end); h.event(SCS_TELEMETRY_EVENT_paused); });
  BigConfiguration unterminated(256, 4, 'u', false);
  both([&](Host& h) { h.config("truck", unterminated.attributes.data()); h.config("trailer", nullptr); h.gameplay("player.fined", nullptr); h.event(SCS_TELEMETRY_EVENT_configuration); });
  both([&](Host& h) { h.channel("game.time", u32(100)); h.channel("game.time", u32(50)); });
  std::vector<cap0::Envelope> envelopes; cap0::Envelope e; while (q.pop(e)) envelopes.push_back(e);
  require(envelopes.size() == 10, "every configuration/gameplay/lifecycle callback copied once");
  const auto& j = envelopes[0];
  require(j.kind == cap0::Kind::configuration && j.id.value == "job" && j.seq == 1 && j.dropped_before == 0 && j.attributes.size() == 9 && j.terminated && j.attributes_expected && !j.attributes_null, "configuration envelope header");
  require(j.configuration_revision == 2, "configuration revision follows the adapter boundary");
  require(j.attributes[0].value.text == "cargo.fixture", "copied string independent of later SDK memory");
  require(j.attributes[1].value.type == SCS_VALUE_TYPE_u64 && j.attributes[1].value.unsigned_integer == UINT64_MAX, "exact u64 copied");
  require(j.attributes[2].value.type == SCS_VALUE_TYPE_u32 && j.attributes[2].value.unsigned_integer == 1234, "u32 copied unconverted");
  require(j.attributes[3].index == 3 && j.attributes[3].value.numbers[0] == 1.5 && j.attributes[3].value.numbers[1] == -2.25 && j.attributes[3].value.numbers[2] == static_cast<double>(0.1F), "indexed fvector copied exactly");
  require(j.attributes[4].value.status == cap0::Status::invalid && j.attributes[4].value.detail == cap0::Detail::invalid_utf8, "invalid UTF-8 explicit");
  require(j.attributes[5].value.status == cap0::Status::invalid && j.attributes[5].value.detail == cap0::Detail::too_long, "oversized string explicit, not truncated");
  require(j.attributes[6].name.status == cap0::Status::invalid && j.attributes[6].name.detail == cap0::Detail::too_long && j.attributes[6].value.signed_integer == -5, "oversized name explicit while value retained");
  require(j.attributes[7].value.text == control, "valid control characters preserved for JSON escaping");
  require(j.attributes[8].value.status == cap0::Status::invalid && j.attributes[8].value.detail == cap0::Detail::non_finite, "non-finite float explicit");
  const auto& d = envelopes[1];
  require(d.kind == cap0::Kind::gameplay && d.id.value == "job.delivered" && d.attributes.size() == 5, "gameplay envelope");
  require(d.attributes[0].value.type == SCS_VALUE_TYPE_s64 && d.attributes[0].value.signed_integer == INT64_MIN, "exact s64 copied");
  require(d.attributes[2].value.numbers[0] == 12.5 && d.attributes[3].value.boolean, "float/bool copied");
  require(d.attributes[4].value.numbers[0] == 123456.789 && d.attributes[4].value.numbers[3] == 0.25, "dplacement copied");
  require(envelopes[2].kind == cap0::Kind::lifecycle && envelopes[2].id.value == "simulation.started" && envelopes[2].simulation == cap0::Simulation::running && !envelopes[2].frame_available, "started lifecycle before any SDK frame");
  require(envelopes[3].id.value == "timers.restart" && envelopes[3].frame_available && envelopes[3].render_us == 5 && envelopes[3].game_clock_id != j.game_clock_id, "timer restart with rotated game clock and new SDK time");
  require(envelopes[4].id.value == "simulation.paused" && envelopes[4].simulation == cap0::Simulation::paused, "paused lifecycle");
  require(envelopes[5].id.value == "truck" && envelopes[5].attributes.size() == 256 && !envelopes[5].terminated, "unterminated scan bounded and marked");
  require(envelopes[6].id.value == "trailer" && envelopes[6].attributes_null && envelopes[6].attributes.empty(), "null configuration attributes explicit");
  require(envelopes[7].id.value == "player.fined" && envelopes[7].attributes_null, "gameplay without attributes explicit");
  require(envelopes[8].kind == cap0::Kind::configuration && envelopes[8].id.status == cap0::Status::invalid && envelopes[8].id.detail == cap0::Detail::null_name, "missing configuration info explicit");
  require(envelopes[9].id.value == "game.time.regression" && envelopes[9].game_time_status == cap0::Status::available && envelopes[9].game_time_minutes == 50 && envelopes[9].game_clock_id != envelopes[3].game_clock_id, "game time regression carries regressed reading under rotated clock");
  for (std::size_t i = 1; i < envelopes.size(); ++i) require(envelopes[i].seq == i + 1 && envelopes[i].boundary_order > envelopes[i - 1].boundary_order && envelopes[i].monotonic_available, "ordered copies with source monotonic time");
  // v0 publication and diagnostics are identical with and without the open evidence gate.
  auto with = std::make_unique<sdk::Snapshot>(), without = std::make_unique<sdk::Snapshot>();
  require(adapter.read_current(*with) && reference.read_current(*without), "current snapshots");
  require(with->boundary_order == without->boundary_order && with->state.configuration_revision == without->state.configuration_revision && with->state.simulation == without->state.simulation, "v0 boundary/revision/simulation unchanged");
  require(with->continuity.lost_observations == without->continuity.lost_observations && with->continuity.coalesced_snapshots == without->continuity.coalesced_snapshots &&
    with->continuity.offline_transitions == without->continuity.offline_transitions && with->continuity.callback_failures == without->continuity.callback_failures, "v0 continuity unchanged");
  require(with->state.game_time_minutes.value == without->state.game_time_minutes.value && with->state.game_time_minutes.status == without->state.game_time_minutes.status, "v0 game time unchanged");
  auto latest_with = std::make_unique<sdk::Snapshot>(), latest_without = std::make_unique<sdk::Snapshot>();
  require(adapter.read_latest(*latest_with) == reference.read_latest(*latest_without) && latest_with->observation_count == latest_without->observation_count, "v0 diagnostic batch unchanged");
  require(host.wrong_thread == 0 && reference_host.wrong_thread == 0, "SDK API calls only on SDK thread");
  adapter.attach_evidence(nullptr); adapter.shutdown(); reference.shutdown();
}

void wire() {
  cap0::Envelope e; e.kind = cap0::Kind::gameplay; e.id = {cap0::Status::available, cap0::Detail::none, "job.delivered"}; e.seq = 7; e.dropped_before = 2; e.boundary_order = UINT64_MAX; e.configuration_revision = 3;
  e.monotonic_available = true; e.monotonic_ns = 12345; e.game_clock_id = "00000000-0000-4000-8000-000000000001"; e.game_time_status = cap0::Status::available; e.game_time_minutes = UINT32_MAX;
  e.attributes_expected = true; e.terminated = true;
  cap0::Attribute revenue; revenue.name = {cap0::Status::available, cap0::Detail::none, "revenue"}; revenue.value.type = SCS_VALUE_TYPE_s64; revenue.value.status = cap0::Status::available; revenue.value.signed_integer = INT64_MIN;
  cap0::Attribute income = revenue; income.name.value = "income"; income.value.type = SCS_VALUE_TYPE_u64; income.value.unsigned_integer = UINT64_MAX;
  cap0::Attribute distance = revenue; distance.name.value = "distance.km"; distance.value.type = SCS_VALUE_TYPE_float; distance.value.numbers[0] = static_cast<double>(0.1F);
  cap0::Attribute missing = revenue; missing.name.value = "bad"; missing.value.status = cap0::Status::invalid; missing.value.detail = cap0::Detail::too_long; missing.value.type = SCS_VALUE_TYPE_string; missing.index = 4;
  e.attributes = {revenue, income, distance, missing};
  std::uint64_t seq = 5; auto packets = cap0::envelope_packets(session_id, e, seq, 99);
  require(packets.size() == 1 && seq == 6, "single packet envelope");
  const auto p = v0::detail::Parser(packets[0]).parse();
  require(p.at("kind").string() == "envelope" && p.at("packetSeq").string() == "5" && p.at("publishMonotonicNs").string() == "99", "packet header");
  const auto& data = p.at("data");
  require(data.at("envelopeSeq").string() == "7" && data.at("droppedBefore").string() == "2" && data.at("sharedBoundaryOrder").string() == "18446744073709551615", "exact counters as strings");
  require(data.at("gameTime").at("minutes").at("value").string() == "4294967295", "game minutes exact");
  require(observation(p, "revenue").at("value").at("value").string() == "-9223372036854775808" && observation(p, "revenue").at("sdkType").string() == "s64", "s64 exact decimal string");
  require(observation(p, "income").at("value").at("value").string() == "18446744073709551615", "u64 exact decimal string");
  require(static_cast<float>(observation(p, "distance.km").at("value").at("value").number()) == 0.1F, "float round-trips exactly");
  require(observation(p, "bad").at("value").at("detail").string() == "too-long" && observation(p, "bad").at("arrayIndex").at("value").number() == 4, "unavailable detail and array index");
  require(!observation(p, "revenue").at("arrayIndex").at("available").boolean(), "non-indexed attribute explicit");
  // Splitting: all 255 attributes appear once across bounded, contiguous, ordered packets.
  cap0::Envelope big = e; big.attributes.clear();
  for (unsigned i = 0; i < 255; ++i) { cap0::Attribute a = missing; a.name.value = "attribute." + std::to_string(i); a.value.status = cap0::Status::available; a.value.detail = cap0::Detail::none; a.value.text = std::string(1024, '\x01'); big.attributes.push_back(a); }
  for (std::size_t limit : {std::size_t{8192}, cap0::max_packet_bytes}) {
    seq = 0; const auto split = cap0::envelope_packets(session_id, big, seq, 1, limit);
    require(split.size() > 1 && seq == split.size(), "large envelope split into several packets");
    std::uint32_t next = 0;
    for (std::size_t i = 0; i < split.size(); ++i) {
      require(split[i].size() <= limit, "packet byte limit enforced");
      const auto part = v0::detail::Parser(split[i]).parse(); const auto& attributes = part.at("data").at("attributes");
      require(static_cast<std::uint32_t>(attributes.at("first").number()) == next && attributes.at("total").number() == 255 && attributes.at("final").boolean() == (i + 1 == split.size()), "contiguous attribute ranges");
      const auto& observations = std::get<v0::Json::Array>(part.at("data").at("observations").value);
      require(observations.size() == attributes.at("count").number(), "count matches observations");
      for (const auto& o : observations) { require(static_cast<std::uint32_t>(o.at("position").number()) == next && o.at("value").at("value").string().size() == 1024, "attribute position and content"); ++next; }
    }
    require(next == 255, "no attribute silently dropped by packet limit");
    std::cout << "limit=" << limit << " packets=" << split.size() << '\n';
  }
  bool rejected = false; try { seq = 0; cap0::envelope_packets(session_id, big, seq, 1, 256); } catch (const std::exception&) { rejected = true; } require(rejected, "unrepresentable packet limit fails explicitly");
  cap0::HeaderInfo h; h.capture_session_id = session_id; h.origin = "synthetic"; h.game = "ets2"; h.sdk_game_id = "eut2"; h.process_instance_id = h.plugin_session_id = h.source_clock_id = h.game_clock_id = "00000000-0000-4000-8000-000000000001";
  h.process_id = 1; h.api_version = SCS_TELEMETRY_VERSION_1_01; h.game_telemetry_version = SCS_MAKE_VERSION(1, 20);
  const auto header = v0::detail::Parser(cap0::header_packet(h, 0, 1)).parse();
  require(header.at("kind").string() == "header" && header.at("data").at("origin").string() == "synthetic" && header.at("data").at("versions").at("telemetryApi").at("minor").number() == 1 && header.at("data").at("bounds").at("queueBytes").number() == 2097152, "header identity/bounds");
  cap0::Counters c; c.attempted = 10; c.dropped = 3; c.last_dropped_seq = 9;
  require(v0::detail::Parser(cap0::loss_packet(session_id, c, 1, 2)).parse().at("data").at("droppedEnvelopes").string() == "3", "loss packet");
  require(v0::detail::Parser(cap0::end_packet(session_id, {cap0::EndReason::plugin_shutdown, c, 7, 0}, 2, 3)).parse().at("data").at("reason").string() == "plugin-shutdown", "end packet");
  // Hello acceptance and fail-closed rejections.
  require(cap0::validate_hello(cap0::hello_payload(session_id)) == session_id, "valid hello");
  const std::string valid = cap0::hello_payload(session_id);
  auto rejects = [](const std::string& payload) { try { cap0::validate_hello(payload); } catch (const v0::ProtocolError&) { return true; } return false; };
  auto variant = [&](const std::string& from, const std::string& to) { auto copy = valid; copy.replace(copy.find(from), from.size(), to); return copy; };
  require(rejects(variant("\"major\":0", "\"major\":1")) && rejects(variant("ets2telemetry-cap0", "ets2telemetry-cap1")) && rejects(variant("\"evidenceOnly\":true", "\"evidenceOnly\":false")) &&
    rejects(variant("\"kind\":\"hello\"", "\"kind\":\"hello\",\"kind\":\"hello\"")) && rejects(variant("{\"evidenceOnly\":true}", "{\"evidenceOnly\":true,\"diagnostics\":true}")) &&
    rejects(variant("0cab0000", "0CAB0000")) && rejects(valid + std::string(4097 - valid.size(), ' ')) && rejects("{"), "invalid CAP0 hello variants fail closed");
  require(!rejects(valid + std::string(4096 - valid.size(), ' ')), "exact 4096-byte hello accepted");
  // The frozen v0 parser never accepts CAP0 packets or hello.
  for (const auto& payload : {packets[0], cap0::header_packet(h, 0, 1), valid}) { bool v0_rejected = false; try { v0::decode_payload(payload); } catch (const v0::ProtocolError&) { v0_rejected = true; } require(v0_rejected, "v0 parser rejects CAP0"); }
}

void server_capture() {
  Fixture f; f.host.event(SCS_TELEMETRY_EVENT_started); f.host.frame(10);
  f.start(); const auto endpoint = f.capture.endpoint();
  sdk::Snapshot current; f.adapter->read_current(current);
  require(endpoint == cap0::capture_endpoint_name(current, f.user) && endpoint.find(L"-cap0-") != std::wstring::npos, "separate keyed capture namespace");
  std::vector<scs_named_value_t> pre{named("income", u64(42)), scs_named_value_t{}}; f.host.config("job", pre.data());
  require(f.capture.queue().counters().attempted == 0, "no evidence before authenticated opt-in");
  auto client = f.connect(endpoint); f.security.verify_handle(client.get()); hello(client.get());
  Packets packets; require(packets.read(client.get(), 1), "header received");
  const auto& header = packets.items[0].at("data");
  require(packets.items[0].at("kind").string() == "header" && header.at("origin").string() == "synthetic" && header.at("source").at("pluginSessionId").string() == current.identity.plugin_session_id.c_str() &&
    header.at("source").at("processId").number() == GetCurrentProcessId() && header.at("clocks").at("sourceMonotonicClockId").string() == current.identity.capture_clock_id.c_str(), "header binds source identity and clock");
  require(header.at("versions").at("pluginImage").at("available").boolean() && header.at("versions").at("pluginImage").at("value").at("sha256").string() == f.self.sha256, "producer image hash recorded");
  Handle busy(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)); require(!busy && GetLastError() == ERROR_PIPE_BUSY, "second capture client refused");
  std::vector<scs_named_value_t> job{named("income", u64(UINT64_MAX)), named("cargo.id", text("cargo")), scs_named_value_t{}};
  std::vector<scs_named_value_t> delivered{named("revenue", s64(-1)), scs_named_value_t{}};
  f.host.config("job", job.data()); f.host.gameplay("job.delivered", delivered.data()); f.host.event(SCS_TELEMETRY_EVENT_paused);
  require(packets.read(client.get(), 4), "three envelopes received");
  const auto& config = packets.items[1]; const auto& gameplay = packets.items[2]; const auto& paused = packets.items[3];
  require(config.at("data").at("envelopeSeq").string() == "1" && config.at("data").at("callback").at("group").string() == "configuration" && observation(config, "income").at("value").at("value").string() == "18446744073709551615", "configuration evidence over actual pipe");
  require(gameplay.at("data").at("envelopeSeq").string() == "2" && observation(gameplay, "revenue").at("value").at("value").string() == "-1", "gameplay evidence over actual pipe");
  require(paused.at("data").at("callback").at("id").at("value").string() == "simulation.paused" && paused.at("data").at("simulation").string() == "paused", "lifecycle evidence over actual pipe");
  require(std::stoull(gameplay.at("data").at("sharedBoundaryOrder").string()) > std::stoull(config.at("data").at("sharedBoundaryOrder").string()), "shared boundary order increases");
  require(std::stoull(paused.at("publishMonotonicNs").string()) >= std::stoull(paused.at("data").at("callbackMonotonicNs").at("value").string()), "publication follows callback in the source clock domain");
  // Disconnect closes the capture; a new client starts a new capture without offline contents.
  client.reset(); require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening; }), "listening after client close");
  const auto prior = f.capture.queue().counters().attempted;
  f.host.config("job", job.data()); require(!f.capture.queue().is_open() && f.capture.queue().counters().attempted == prior && f.capture.queue().queued_envelopes() == 0, "no offline spool between captures");
  auto again = f.connect(endpoint); hello(again.get()); Packets second; require(second.read(again.get(), 1), "second header");
  f.host.event(SCS_TELEMETRY_EVENT_started); require(second.read(again.get(), 2) && second.items[1].at("data").at("envelopeSeq").string() == "1", "new capture restarts envelope sequence");
  require(f.capture.sessions() == 2, "two authorized sessions");
  f.host.config("job", job.data());
  const auto started = GetTickCount64(); f.capture.stop(); const auto elapsed = GetTickCount64() - started;
  require(second.read(again.get(), 4), "drained envelope and end marker on shutdown");
  require(second.last().at("kind").string() == "end" && second.last().at("data").at("reason").string() == "plugin-shutdown" && second.last().at("data").at("unsentEnvelopes").string() == "0", "explicit shutdown end marker");
  require(elapsed < 1000 * timing_scale && f.capture.status() == cap0::CaptureStatus::stopped, "bounded capture shutdown");
  require(f.host.wrong_thread == 0, "capture worker never calls SDK API");
  std::cout << "captureShutdownMs=" << elapsed << '\n';
}

void stall_and_loss() {
  Fixture f; f.start(); auto client = f.connect(f.capture.endpoint()); hello(client.get()); Packets packets; require(packets.read(client.get(), 1), "header");
  BigConfiguration big(255, 1024, 'q');
  // The client stops reading. Callbacks must stay short while the worker blocks in pipe I/O.
  double worst_ms = 0; const auto started = GetTickCount64();
  for (unsigned i = 0; i < 200; ++i) {
    const auto before = std::chrono::steady_clock::now(); f.host.config("job", big.attributes.data());
    worst_ms = (std::max)(worst_ms, std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - before).count());
  }
  const auto produced_ms = GetTickCount64() - started; const auto counters = f.capture.queue().counters();
  require(counters.attempted == 200 && counters.dropped > 0 && counters.dropped_full_bytes > 0, "newest-drop loss counted while client stalled");
  require(produced_ms < 600 * timing_scale && worst_ms < 100.0 * timing_scale, "callbacks bounded and nonblocking under stalled capture client");
  require(f.capture.queue().queued_bytes() <= cap0::queue_bytes && f.capture.queue().queued_envelopes() <= cap0::queue_envelopes, "queue bounds hold");
  // Resume reading within the 1 s write deadline and account for every attempted envelope.
  std::set<std::uint64_t> seen; std::uint64_t dropped_marked = 0, previous = 0; bool loss = false;
  require(until([&] {
    packets.read(client.get(), packets.items.size() + 1, 300);
    std::uint64_t finals = 0; bool complete_loss = false;
    for (const auto& item : packets.items) {
      const auto kind = item.at("kind").string();
      if (kind == "envelope" && item.at("data").at("attributes").at("final").boolean()) ++finals;
      if (kind == "loss" && std::stoull(item.at("data").at("droppedEnvelopes").string()) == counters.dropped) complete_loss = true;
    }
    return complete_loss && finals == counters.enqueued;
  }, 5000), "every retained envelope and the complete loss count received");
  for (const auto& item : packets.items) {
    const auto kind = item.at("kind").string();
    if (kind == "loss") { loss = true; require(loss_consistent(item.at("data")), "every emitted loss packet is internally consistent"); }
    if (kind != "envelope" || !item.at("data").at("attributes").at("final").boolean()) continue;
    const auto seq = std::stoull(item.at("data").at("envelopeSeq").string()), gap = std::stoull(item.at("data").at("droppedBefore").string());
    require(seq - previous - 1 == gap, "droppedBefore equals the exact sequence gap"); previous = seq; dropped_marked += gap; seen.insert(seq);
  }
  require(loss, "loss marker emitted");
  require(seen.size() == counters.enqueued && dropped_marked + (counters.attempted - previous) == counters.dropped, "received envelopes and explicit gaps account for every attempt");
  std::cout << "stallAttempted=" << counters.attempted << " dropped=" << counters.dropped << " worstCallbackMs=" << worst_ms << " producedMs=" << produced_ms << '\n';
  // A client that stops reading longer than the write deadline loses its capture, not the source.
  for (unsigned i = 0; i < 40; ++i) f.host.config("job", big.attributes.data());
  require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening; }, 4000), "write deadline closes stalled capture");
  require(f.host.wrong_thread == 0, "no SDK calls from worker");
}

void rejection() {
  Fixture f; f.start(); const auto endpoint = f.capture.endpoint();
  auto closed = [&](std::vector<std::uint8_t> bytes) {
    auto h = f.connect(endpoint); if (!bytes.empty()) send(h.get(), bytes);
    std::array<std::uint8_t, 64> response{}; DWORD read = 0; const bool got = io(h.get(), true, response.data(), 64, read, static_cast<DWORD>(5000 + 1500 * timing_scale));
    h.reset(); require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening; }), "listening after rejection"); return !got;
  };
  const auto v0_hello = std::string("{\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"00000000-0000-4000-8000-000000000001\",\"minMinor\":0,\"maxMinor\":0,\"diagnostics\":true}}");
  require(closed(cap0::frame(v0_hello)), "v0 hello rejected by capture endpoint");
  auto wrong = cap0::hello_payload(session_id); wrong.replace(wrong.find("\"minor\":0"), 9, "\"minor\":1"); require(closed(cap0::frame(wrong)), "unsupported CAP0 version rejected");
  require(closed({1, 16, 0, 0}), "oversized hello prefix rejected before payload");
  auto trailing = cap0::frame(cap0::hello_payload(session_id)); trailing.push_back(0); require(closed(trailing), "byte after hello rejected");
  require(closed(cap0::frame("{")), "malformed hello rejected");
  const auto started = GetTickCount64(); require(closed({}), "missing hello times out"); const auto waited = GetTickCount64() - started;
  require(waited >= 4900 && waited < 5000 + 1400 * timing_scale, "five-second hello deadline");
  write_policy(f.directory, f.security, f.user, f.self, std::string(64, '0')); require(closed(cap0::frame(cap0::hello_payload(session_id))), "unapproved client image rejected");
  require(f.capture.sessions() == 0 && f.capture.queue().counters().attempted == 0, "rejected clients never opened the evidence gate");
}

void v0_isolation() {
  Fixture f; f.start(); require(f.live.start(f.directory) && f.live.await_startup() == transport::StartupFailure::none, "v0 server start");
  auto live = f.connect(f.live.endpoint());
  const auto v0_hello = std::string("{\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"00000000-0000-4000-8000-000000000001\",\"minMinor\":0,\"maxMinor\":0,\"diagnostics\":true}}");
  send(live.get(), cap0::frame(v0_hello));
  auto capture = f.connect(f.capture.endpoint()); hello(capture.get()); Packets header; require(header.read(capture.get(), 1), "capture header");
  // Capture client now stalls completely while large evidence and v0 frames continue.
  BigConfiguration big(255, 1024, 'z'); v0::FrameDecoder decoder; v0::Consumer consumer(true); unsigned snapshots = 0;
  const auto end = GetTickCount64() + 2000;
  while (GetTickCount64() < end) {
    f.host.event(SCS_TELEMETRY_EVENT_started); f.host.config("job", big.attributes.data()); f.host.frame(static_cast<float>(snapshots % 50));
    std::array<std::uint8_t, 65540> bytes{}; DWORD count = 0;
    if (io(live.get(), true, bytes.data(), static_cast<DWORD>(bytes.size()), count, 60) && count)
      decoder.push(bytes.data(), count, [&](v0::Message m) { consumer.accept(m); if (m.kind == "snapshot") ++snapshots; });
    Sleep(20);
  }
  require(snapshots >= 10, "v0 live snapshots continue while the capture client is stalled");
  require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening; }, 3000), "stalled capture retired independently by its write deadline");
  // The v0 endpoint still rejects a CAP0 hello; the frozen v0 handshake is unchanged.
  live.reset(); require(until([&] { return f.live.status() == transport::Status::listening; }), "v0 listening");
  auto cap_on_v0 = f.connect(f.live.endpoint()); send(cap_on_v0.get(), cap0::frame(cap0::hello_payload(session_id)));
  std::array<std::uint8_t, 32> response{}; DWORD read = 0; require(!io(cap_on_v0.get(), true, response.data(), 32, read, 2000), "v0 server rejects CAP0 hello");
  require(f.host.wrong_thread == 0, "no SDK calls from either worker");
  std::cout << "v0SnapshotsDuringCaptureStall=" << snapshots << '\n';
}

void dll_lifecycle(const char* path) {
  Fixture f; f.adapter->shutdown();
  HMODULE module = LoadLibraryA(path); require(module != nullptr, "isolated test DLL load");
  auto init = reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module, "scs_telemetry_init"));
  auto shutdown = reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module, "scs_telemetry_shutdown"));
  using SetDirectory = int (*)(const wchar_t*); using GetEndpoint = int (*)(wchar_t*, unsigned);
  auto directory = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_directory"));
  auto endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_capture_endpoint"));
  require(init && shutdown && directory && endpoint && directory(f.directory.c_str()), "test-only capture seam");
  auto p = f.host.params(); require(init(SCS_TELEMETRY_VERSION_1_01, &p) == SCS_RESULT_ok, "official initialization");
  std::array<wchar_t, 512> name{}; require(until([&] { return endpoint(name.data(), static_cast<unsigned>(name.size())) != 0; }), "DLL capture endpoint ready");
  auto client = f.connect(name.data()); hello(client.get()); Packets packets; require(packets.read(client.get(), 1), "DLL header");
  require(packets.items[0].at("data").at("origin").string() == "synthetic", "test DLL marks evidence synthetic");
  std::vector<scs_named_value_t> job{named("income", u64(UINT64_MAX)), scs_named_value_t{}}; f.host.config("job", job.data());
  require(packets.read(client.get(), 2), "DLL envelope");
  const auto started = GetTickCount64(); shutdown(); const auto elapsed = GetTickCount64() - started;
  require(packets.read(client.get(), 3) && packets.last().at("kind").string() == "end" && packets.last().at("data").at("reason").string() == "plugin-shutdown", "official shutdown end marker");
  require(elapsed < 1500 * timing_scale, "official shutdown joins capture and live workers"); require(FreeLibrary(module) != FALSE, "unload after joined workers");
  require(f.host.wrong_thread == 0, "DLL workers make no SDK calls");
  std::cout << "dllShutdownMs=" << elapsed << '\n';
}

void counter_snapshots() {
  // A live producer bursts drops while the worker-side reader samples; every sample must be one
  // coherent version, and every loss packet built from it must satisfy the decoder.
  cap0::EvidenceQueue q; require(q.prepare(), "prepare"); q.open();
  std::atomic<bool> done{false}, enough{false}; std::atomic<std::uint64_t> produced{0};
  std::thread producer([&] {
    cap0::Context c; c.kind = cap0::Kind::lifecycle; c.id = "simulation.started"; c.monotonic_available = true;
    // The burst lasts at least one second and until the reader has 1,000 overlapping samples (bounded
    // by 20 s). No attempt count is required, so slow sanitized runners cannot fail it spuriously.
    const auto started = GetTickCount64(), minimum = started + 1000, limit = started + 20000;
    for (std::uint64_t i = 0; (GetTickCount64() < minimum || !enough.load(std::memory_order_relaxed)) && GetTickCount64() < limit; ++i) { c.boundary_order = i + 1; c.monotonic_ns = i + 1; c.monotonic_available = (i % 3) != 0; q.capture(c); produced.store(i + 1, std::memory_order_relaxed);
      // Real SDK callbacks are spaced by game work; a short pause keeps the reader from being starved by
      // an artificially back-to-back writer while drops still race every sample.
      for (int k = 0; k < 64; ++k) YieldProcessor(); }
    done.store(true);
  });
  std::uint64_t samples = 0, concurrent = 0, previous_attempted = 0, previous_dropped = 0, popped = 0; cap0::Envelope e; bool inconsistent = false;
  while (!done.load() || samples < 1000) {
    const bool live = !done.load(); const auto c = q.counters(); ++samples; if (live && ++concurrent >= 1000) enough.store(true, std::memory_order_relaxed);
    if (!counters_consistent(c) || c.attempted < previous_attempted || c.dropped < previous_dropped) inconsistent = true;
    if (!loss_consistent(v0::detail::Parser(cap0::loss_packet(session_id, c, samples, samples)).parse().at("data"))) inconsistent = true;
    previous_attempted = c.attempted; previous_dropped = c.dropped;
    if (samples % 64 == 0) while (q.pop(e)) ++popped; // Mix enqueue and drop outcomes.
    if (done.load() && samples >= 1000) break;
  }
  producer.join();
  const auto final = q.counters();
  require(!inconsistent, "every concurrent counter sample and loss packet is internally consistent");
  if (concurrent < 1000) std::cout << "concurrentSamples=" << concurrent << " produced=" << produced.load() << '\n';
  require(concurrent >= 1000, "samples overlapped the live producer burst"); require(final.attempted == produced.load() && counters_consistent(final) && final.dropped > 0 && final.enqueued > 0, "burst mixed retained and dropped envelopes");
  std::cout << "counterSamples=" << samples << " concurrent=" << concurrent << " attempted=" << final.attempted << " dropped=" << final.dropped << " popped=" << popped << '\n';
}

void stop_during_write() {
  // A stop while a frame write is in flight lets that frame finish, then drains and ends explicitly.
  Fixture f; f.start(); auto client = f.connect(f.capture.endpoint()); hello(client.get()); Packets packets; require(packets.read(client.get(), 1), "header");
  BigConfiguration big(255, 1024, 's');
  for (unsigned i = 0; i < 12; ++i) f.host.config("job", big.attributes.data());
  require(until([&] { return f.capture.queue().queued_envelopes() > 0; }), "worker blocked behind a full pipe with queued evidence");
  Sleep(50);
  std::thread stopper([&] { f.capture.stop(); });
  Sleep(30); // The stop is now pending while the worker's write is in flight; the client resumes reading.
  packets.read(client.get(), 10000, 4000 * static_cast<DWORD>(timing_scale));
  stopper.join();
  require(!packets.items.empty() && packets.last().at("kind").string() == "end" && packets.last().at("data").at("reason").string() == "plugin-shutdown", "stop during an in-flight write still ends with plugin-shutdown");
  for (const auto& item : packets.items) if (item.at("kind").string() == "loss") require(loss_consistent(item.at("data")), "loss consistent");
  require(f.capture.shutdown_ms() < 1000 * timing_scale && f.host.wrong_thread == 0, "bounded stop and no SDK calls on worker");
  std::cout << "stopDuringWritePackets=" << packets.items.size() << " unsent=" << packets.last().at("data").at("unsentEnvelopes").string() << " shutdownMs=" << f.capture.shutdown_ms() << '\n';
}

// Parses everything a client received. Every complete frame must be a valid, contiguous CAP0 packet; an
// end marker may only follow complete envelopes. Returns "end" when the stream ends with a marker,
// "partial" when it ends inside a frame, or "clean" when it ends on a frame boundary without a marker.
std::string verify_stream(const std::vector<std::uint8_t>& bytes, std::string& end_detail) {
  std::size_t offset = 0, index = 0; bool open_split = false, ended = false;
  while (bytes.size() - offset >= 4) {
    const auto n = static_cast<std::uint32_t>(bytes[offset]) | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
    require(n > 0 && n <= cap0::max_packet_bytes, "received frame length valid");
    if (bytes.size() - offset - 4 < n) break;
    const auto packet = v0::detail::Parser(std::string(bytes.begin() + static_cast<std::ptrdiff_t>(offset + 4), bytes.begin() + static_cast<std::ptrdiff_t>(offset + 4 + n))).parse();
    require(!ended, "nothing after the end marker");
    require(packet.at("packetSeq").string() == std::to_string(index), "received packets contiguous");
    const auto kind = packet.at("kind").string();
    if (kind == "envelope") open_split = !packet.at("data").at("attributes").at("final").boolean();
    if (kind == "loss") require(!open_split && loss_consistent(packet.at("data")), "loss marker after complete envelopes and consistent");
    if (kind == "end") {
      require(!open_split, "end marker never follows a partial envelope"); ended = true;
      end_detail = packet.at("data").at("reason").string() + " unsent=" + packet.at("data").at("unsentEnvelopes").string();
    }
    offset += 4 + n; ++index;
  }
  return ended ? "end" : offset == bytes.size() ? "clean" : "partial";
}
void stop_with_reader(DWORD pause_ms, const char* label, std::size_t attributes = 255, unsigned envelopes = 12, bool expect_end = false) {
  // A client that keeps reading, but slowly, must not stretch shutdown write by write: the whole
  // stop is bounded by one 550 ms budget even while a split envelope is being written. Drain writes
  // stop at 450 ms so the last 100 ms remain for markers.
  Fixture f; f.start(); auto client = f.connect(f.capture.endpoint()); hello(client.get());
  require(until([&] { return f.capture.queue().is_open(); }), "capture gate open before evidence is produced");
  BigConfiguration big(attributes, 1024, 'w');
  for (unsigned i = 0; i < envelopes; ++i) f.host.config("job", big.attributes.data());
  std::atomic<bool> slow{true}; std::atomic<std::uint64_t> received{0}; std::vector<std::uint8_t> stream;
  std::thread reader([&] {
    std::vector<std::uint8_t> chunk(8192); DWORD count = 0;
    // While capturing, 8 KiB per pause; after stop returns, read the rest at full speed until EOF.
    while (io(client.get(), true, chunk.data(), static_cast<DWORD>(chunk.size()), count, 3000) && count) {
      stream.insert(stream.end(), chunk.begin(), chunk.begin() + count); received += count;
      if (slow.load()) Sleep(pause_ms);
    }
  });
  // A failed assertion still joins the reader instead of terminating the process.
  struct Join { std::thread& t; std::atomic<bool>& slow; ~Join() { slow.store(false); if (t.joinable()) t.join(); } } join{reader, slow};
  require(until([&] { return received.load() > 100000; }, 5000), "client is reading a split envelope");
  const auto started = GetTickCount64(); f.capture.stop(); const auto elapsed = GetTickCount64() - started;
  slow.store(false); reader.join();
  std::string detail; const auto outcome = verify_stream(stream, detail);
  std::cout << label << "StopMs=" << elapsed << " workerShutdownMs=" << f.capture.shutdown_ms() << " receivedBytes=" << stream.size() << " outcome=" << outcome << (detail.empty() ? "" : " end=") << detail << '\n';
  require(elapsed < (550 + 150) * timing_scale, "stop stays within the single stop budget");
  if (outcome == "end") require(detail.rfind("plugin-shutdown", 0) == 0, "shutdown end marker reason");
  if (expect_end) require(outcome == "end", "drain cut at an envelope boundary keeps the reserved marker window");
  require(f.host.wrong_thread == 0, "no SDK calls from worker");
}
void stop_slow_reader() { stop_with_reader(25, "slowReader"); }
// Single-packet envelopes (about 55 KiB each) and a reader that drains the pipe buffer well within
// 100 ms: whether the drain finishes or is cut at 450 ms, the cut falls on an envelope boundary,
// so the reserved window must deliver the plugin-shutdown end marker.
void stop_drain_boundary() { stop_with_reader(2, "drainBoundary", 50, 40, true); }


void v0_continuity() {
  // A connected, polling capture worker must not perturb v0 publication: compare with a reference.
  Fixture f; Host reference_host; sdk::Adapter reference; auto rp = reference_host.params(); require(reference.initialize(SCS_TELEMETRY_VERSION_1_01, &rp) == SCS_RESULT_ok, "reference init");
  Host::active = &f.host;
  f.start(); auto client = f.connect(f.capture.endpoint()); hello(client.get()); Packets packets; require(packets.read(client.get(), 1), "header");
  const auto end = GetTickCount64() + 1500 * timing_scale; unsigned frames = 0;
  while (GetTickCount64() < end) { f.host.frame(static_cast<float>(frames % 40)); reference_host.frame(static_cast<float>(frames % 40)); ++frames; if (frames % 20 == 0) Sleep(1); }
  auto with = std::make_unique<sdk::Snapshot>(), without = std::make_unique<sdk::Snapshot>();
  require(f.adapter->read_current(*with) && reference.read_current(*without), "snapshots");
  require(with->continuity.coalesced_snapshots == without->continuity.coalesced_snapshots && with->continuity.lost_observations == without->continuity.lost_observations &&
    with->continuity.offline_transitions == without->continuity.offline_transitions && with->boundary_order == without->boundary_order, "v0 continuity identical with a running capture worker");
  reference.shutdown();
  std::cout << "v0ContinuityFrames=" << frames << " coalesced=" << with->continuity.coalesced_snapshots << '\n';
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
void clock_unavailable() {
  // Without the source clock nothing is stamped with a fabricated time: no header, or the capture ends.
  struct Reset { ~Reset() { cap0::set_capture_clock_failure_for_test(false); } } reset;
  Fixture f; f.start();
  cap0::set_capture_clock_failure_for_test(true);
  { auto client = f.connect(f.capture.endpoint()); hello(client.get()); Packets packets; require(!packets.read(client.get(), 1, 2000) && packets.items.empty(), "no header without a source clock"); }
  require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening; }), "listening after clock refusal");
  require(f.capture.sessions() == 0 && !f.capture.queue().is_open(), "gate never opened without a clock");
  cap0::set_capture_clock_failure_for_test(false);
  auto client = f.connect(f.capture.endpoint()); hello(client.get()); Packets packets; require(packets.read(client.get(), 1), "header with clock");
  cap0::set_capture_clock_failure_for_test(true);
  f.host.event(SCS_TELEMETRY_EVENT_paused);
  require(!packets.read(client.get(), 2, 2000) && packets.items.size() == 1, "capture closes without a fabricated publication time");
  require(until([&] { return f.capture.status() == cap0::CaptureStatus::listening && !f.capture.queue().is_open(); }), "capture closed after clock loss");
}
#endif

// Tests-only fake SDK host for the cross-package chain check (broker capture mode + TypeScript).
int controlled_host(const char* dll_path, const char* directory_utf8) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE); require(GetFileType(input) == FILE_TYPE_PIPE, "piped stdin");
  const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, directory_utf8, -1, nullptr, 0); require(length > 1 && length < 4096, "directory encoding");
  std::wstring directory(static_cast<std::size_t>(length), L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, directory_utf8, -1, directory.data(), length); directory.resize(static_cast<std::size_t>(length - 1));
  auto user = transport::current_user(); transport::OwnerSecurity security(user.sid);
  const auto parent = directory.substr(0, directory.find_last_of(L'\\')); security.ensure_directory(parent); security.ensure_directory(directory);
  Host host; HMODULE module = LoadLibraryA(dll_path); require(module != nullptr, "controlled DLL load");
  auto init = reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module, "scs_telemetry_init"));
  auto shutdown = reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module, "scs_telemetry_shutdown"));
  using SetDirectory = int (*)(const wchar_t*); using GetEndpoint = int (*)(wchar_t*, unsigned);
  auto set_directory = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_directory"));
  auto capture_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_capture_endpoint"));
  bool initialized = false;
  try {
    require(init && shutdown && set_directory && capture_endpoint && set_directory(directory.c_str()), "controlled exports");
    auto p = host.params(); require(init(SCS_TELEMETRY_VERSION_1_01, &p) == SCS_RESULT_ok, "controlled init"); initialized = true;
    host.event(SCS_TELEMETRY_EVENT_started); host.frame(10);
    std::array<wchar_t, 512> endpoint{}; require(until([&] { return capture_endpoint(endpoint.data(), static_cast<unsigned>(endpoint.size())) != 0; }), "capture endpoint publication");
    v0::Json ready{v0::Json::Object{{"ready", v0::Json{true}}, {"fixture", v0::Json{std::string("fake-sdk-host")}}, {"processId", v0::Json{static_cast<double>(GetCurrentProcessId())}}, {"captureEndpoint", v0::Json{utf8(endpoint.data())}}}};
    std::cout << v0::detail::serialize(ready) << '\n' << std::flush;
    std::vector<scs_named_value_t> job{named("cargo.id", text("cargo.fixture")), named("income", u64(UINT64_MAX)), named("planned_distance.km", u32(321)), scs_named_value_t{}};
    std::vector<scs_named_value_t> delivered{named("revenue", s64(INT64_MIN)), named("distance.km", f32(12.5F)), scs_named_value_t{}};
    BigConfiguration big(255, 1024, 'b');
    const auto deadline = GetTickCount64() + 30000; std::string commands; bool exit = false;
    while (!exit && GetTickCount64() < deadline) {
      DWORD available = 0; if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) break;
      if (available) {
        std::array<char, 256> command{}; DWORD read = 0; if (!ReadFile(input, command.data(), static_cast<DWORD>(command.size()), &read, nullptr) || !read) break; commands.append(command.data(), read); require(commands.size() <= 1024, "command bound");
        for (auto newline = commands.find('\n'); newline != std::string::npos; newline = commands.find('\n')) {
          auto action = commands.substr(0, newline); commands.erase(0, newline + 1); if (!action.empty() && action.back() == '\r') action.pop_back();
          if (action == "exit") { exit = true; break; }
          if (action == "job") host.config("job", job.data());
          else if (action == "deliver") host.gameplay("job.delivered", delivered.data());
          else if (action == "pause") host.event(SCS_TELEMETRY_EVENT_paused);
          else if (action == "start") host.event(SCS_TELEMETRY_EVENT_started);
          else if (action == "burst") for (unsigned i = 0; i < 64; ++i) host.config("job", big.attributes.data());
          else require(false, "unknown controlled command");
          std::cout << "{\"phase\":\"" << action << "\"}\n" << std::flush;
        }
      }
      host.frame(10); Sleep(20);
    }
    shutdown(); initialized = false; require(host.wrong_thread == 0, "controlled host SDK thread"); require(FreeLibrary(module) != FALSE, "controlled unload"); return 0;
  } catch (...) { if (initialized && shutdown) shutdown(); FreeLibrary(module); throw; }
}
}
int main(int argc, char** argv) {
  try {
    if (argc == 4 && std::string(argv[1]) == "host") return controlled_host(argv[2], argv[3]);
    const std::map<std::string, std::function<void()>> cases{{"queue", queue_bounds}, {"adapter", adapter_copy}, {"wire", wire}, {"server", server_capture}, {"stall", stall_and_loss}, {"rejection", rejection}, {"v0-isolation", v0_isolation}, {"counters", counter_snapshots}, {"stop-inflight", stop_during_write}, {"stop-slow-reader", stop_slow_reader}, {"stop-drain-boundary", stop_drain_boundary}, {"v0-continuity", v0_continuity}
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
      , {"clock", clock_unavailable}
#endif
    };
    auto timed = [](const std::string& name, const std::function<void()>& fn) { const auto start = GetTickCount64(); std::cout << name << '\n' << std::flush; fn(); std::cout << name << " elapsedMs=" << GetTickCount64() - start << '\n' << std::flush; };
    if (argc == 3 && std::string(argv[1]) == "dll") timed("dll", [&] { dll_lifecycle(argv[2]); });
    else if (argc == 2) timed(argv[1], cases.at(argv[1]));
    else for (const auto& entry : cases) timed(entry.first, entry.second);
    std::cout << "CAP0 capture controls: " << assertions << " assertions passed; synthetic fake-SDK evidence only, real-game CAP-01 evidence pending\n"; return 0;
  } catch (const std::exception& e) { std::cerr << "CAP0 failure after " << assertions << " assertions: " << e.what() << '\n'; return 1; }
}
