// Two plugins in one game process (ET-055 UP14). A production and a staging installation each install their own plugin
// DLL, and the game loads every library in its plugins folder, so one game process initializes both. This fake SDK host
// loads the isolated test DLLs of both build channels into one process, initializes both, and shows that each serves its
// own v0, v1 and CAP0 endpoints under its own pipe prefix while the other runs: separate discovery records, separate
// authorized v0 clients, and frame values that never cross between the two. A copy of the first DLL under another file
// name is the control: with the same prefix it collides with the first plugin's endpoint, fails closed and leaves the
// first plugin serving. Per-callback time of each plugin is printed as an observation only, with no threshold (ET-019
// plan decision D3); the real cost in a game, frame time and CPU stay pending real-game measurement.
//
// Test DLLs only: their directories come from the test seams, so %LOCALAPPDATA%, game folders and user history are never
// touched. Temporary directories and the DLL copy are removed at the end.
// Protects REG-011 and REG-015 in part: bounded callbacks and clean joins with two plugins, each serving only its own
// endpoints.
#include "channel-identity.hpp"
#include "pipe-security.hpp"
#include "protocol-json.hpp"
#include "protocol-v0.hpp"
#include "scssdk_telemetry.h"
#include <objbase.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace ets2telemetry;
using transport::Handle;
namespace {
// Hang guards only, never product bounds: endpoint publication, a client read, and the collision control's deferred
// startup report. The product's fixed 1 s SDK-initialization wait is not replaced by any of them.
constexpr ULONGLONG publication_guard_ms = 10000, read_guard_ms = 5000, deferred_report_guard_ms = 10000;
// How long both hosts drive frames side by side, interleaved one frame each.
constexpr ULONGLONG side_by_side_ms = 1500;

unsigned assertions = 0;
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
bool until(const std::function<bool()>& predicate, ULONGLONG ms) {
  const auto end = GetTickCount64() + ms; do { if (predicate()) return true; Sleep(5); } while (GetTickCount64() < end); return predicate();
}
std::int64_t ticks() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return value.QuadPart; }
std::string utf8(const std::wstring& w) {
  const auto n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<std::size_t>(n), '\0'); WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr); return s;
}

// The SDK passes no host context to its registration functions, so each plugin gets its own host type with its own static
// callbacks, as the game keeps a separate registration table per plugin.
template<unsigned N> struct PluginHost {
  static inline PluginHost* self = nullptr;
  std::thread::id caller = std::this_thread::get_id(); unsigned wrong_thread = 0;
  std::vector<std::string> logs;
  std::map<scs_event_t, std::pair<scs_telemetry_event_callback_t, scs_context_t>> events;
  struct Channel { scs_telemetry_channel_callback_t cb; scs_context_t ctx; };
  std::map<std::string, Channel> channels; std::uint64_t frames = 0;
  bool timing = false; std::vector<std::int64_t> callback_ticks;
  PluginHost() { self = this; }
  ~PluginHost() { self = nullptr; }
  PluginHost(const PluginHost&) = delete;
  static void check() { if (self->caller != std::this_thread::get_id()) ++self->wrong_thread; }
  static SCSAPI_VOID log(scs_log_type_t, scs_string_t message) { check(); self->logs.emplace_back(message); }
  static SCSAPI_RESULT reg_event(scs_event_t id, scs_telemetry_event_callback_t cb, scs_context_t ctx) { check(); self->events[id] = {cb, ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_event(scs_event_t id) { check(); self->events.erase(id); return SCS_RESULT_ok; }
  static SCSAPI_RESULT reg_channel(scs_string_t name, scs_u32_t, scs_value_type_t, scs_u32_t, scs_telemetry_channel_callback_t cb, scs_context_t ctx) { check(); self->channels[name] = {cb, ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_channel(scs_string_t name, scs_u32_t, scs_value_type_t) { check(); self->channels.erase(name); return SCS_RESULT_ok; }
  scs_telemetry_init_params_v100_t params() {
    scs_telemetry_init_params_v100_t p{}; p.common.game_id = "eut2"; p.common.game_version = SCS_MAKE_VERSION(1, 20); p.common.log = log;
    p.register_for_event = reg_event; p.unregister_from_event = unreg_event; p.register_for_channel = reg_channel; p.unregister_from_channel = unreg_channel; return p;
  }
  void event(scs_event_t id, const void* value = nullptr) {
    const auto entry = events.at(id); const auto start = ticks(); entry.first(id, value, entry.second); if (timing) callback_ticks.push_back(ticks() - start);
  }
  void channel(const char* name, const scs_value_t& v) {
    const auto entry = channels.at(name); const auto start = ticks(); entry.cb(name, SCS_U32_NIL, &v, entry.ctx); if (timing) callback_ticks.push_back(ticks() - start);
  }
  void frame(float speed) {
    scs_telemetry_frame_start_t f{}; f.render_time = f.simulation_time = f.paused_simulation_time = ++frames * 50000; event(SCS_TELEMETRY_EVENT_frame_start, &f);
    scs_value_t v{}; v.type = SCS_VALUE_TYPE_float; v.value_float.value = speed; channel("truck.speed", v); v.value_float.value = 20; channel("truck.fuel.amount", v);
    v = {}; v.type = SCS_VALUE_TYPE_dplacement; channel("truck.world.placement", v); event(SCS_TELEMETRY_EVENT_frame_end);
  }
};

std::wstring temporary_directory(const transport::OwnerSecurity& security, const wchar_t* label) {
  WCHAR temporary[MAX_PATH]{}; require(GetTempPathW(MAX_PATH, temporary) > 0, "temp path");
  GUID id{}; require(CoCreateGuid(&id) == S_OK, "directory GUID"); WCHAR text[40]{}; StringFromGUID2(id, text, 40);
  const auto directory = std::wstring(temporary) + L"ET055-" + label + L"-" + text; security.ensure_directory(directory); return directory;
}
// The v0 service policy approves this test process, so the fixture's own pipe clients are authorized peers.
void write_policy(const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user, const transport::PeerIdentity& peer) {
  v0::Json j{v0::Json::Object{{"schemaVersion", v0::Json{1.0}}, {"userTag", v0::Json{user.tag}}, {"windowsSessionId", v0::Json{static_cast<double>(user.session)}},
    {"allowedExecutables", v0::Json{v0::Json::Array{v0::Json{v0::Json::Object{{"path", v0::Json{utf8(peer.image)}}, {"sha256", v0::Json{peer.sha256}}}}}}}}};
  const auto bytes = v0::detail::serialize(j);
  Handle f(CreateFileW((directory + L"\\service-policy.json").c_str(), GENERIC_WRITE, 0, security.attributes(), CREATE_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(static_cast<bool>(f), "policy create"); DWORD written = 0; require(WriteFile(f.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size(), "policy write");
}
std::string read_file(const std::wstring& file) {
  Handle h(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr)); require(static_cast<bool>(h), "discovery record readable");
  std::array<char, 8192> bytes{}; DWORD read = 0; require(ReadFile(h.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) != FALSE && read > 0, "discovery record read");
  return std::string(bytes.data(), read);
}
bool io(HANDLE pipe, bool read, std::uint8_t* bytes, DWORD count, DWORD& transferred, DWORD deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED op{}; op.hEvent = event.get();
  const auto ok = read ? ReadFile(pipe, bytes, count, &transferred, &op) : WriteFile(pipe, bytes, count, &transferred, &op);
  if (ok) return true; if (GetLastError() != ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.get(), deadline) != WAIT_OBJECT_0) { CancelIoEx(pipe, &op); return GetOverlappedResult(pipe, &op, &transferred, TRUE) != FALSE; }
  return GetOverlappedResult(pipe, &op, &transferred, FALSE) != FALSE;
}
const char* hello_payload = "{\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"00000000-0000-4000-8000-000000000055\",\"minMinor\":0,\"maxMinor\":0,\"diagnostics\":false}}";

// One authorized v0 client. Messages accumulate; reads stop as soon as a predicate holds.
struct Client {
  Handle pipe; v0::FrameDecoder decoder; std::vector<v0::Message> messages;
  explicit Client(const std::wstring& endpoint) {
    require(until([&] { pipe.reset(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)); return static_cast<bool>(pipe); }, read_guard_ms), "v0 client connect");
    const std::string payload(hello_payload); const auto n = static_cast<std::uint32_t>(payload.size());
    std::vector<std::uint8_t> frame{static_cast<std::uint8_t>(n), static_cast<std::uint8_t>(n >> 8), static_cast<std::uint8_t>(n >> 16), static_cast<std::uint8_t>(n >> 24)};
    frame.insert(frame.end(), payload.begin(), payload.end()); DWORD written = 0;
    require(io(pipe.get(), false, frame.data(), static_cast<DWORD>(frame.size()), written, 2000) && written == frame.size(), "v0 hello write");
  }
  bool read_until(const std::function<bool()>& predicate) {
    const auto deadline = GetTickCount64() + read_guard_ms;
    while (!predicate() && GetTickCount64() < deadline) {
      std::array<std::uint8_t, 65540> bytes{}; DWORD count = 0;
      require(io(pipe.get(), true, bytes.data(), static_cast<DWORD>(bytes.size()), count, 1000), "v0 frame read");
      decoder.push(bytes.data(), count, [&](v0::Message m) { messages.push_back(std::move(m)); });
    }
    return predicate();
  }
  bool saw_speed(double speed) const {
    return std::any_of(messages.begin(), messages.end(), [&](const v0::Message& m) { return m.state && m.state->speed.reading.value == speed; });
  }
};

using SetDirectory = int (*)(const wchar_t*);
using GetEndpoint = int (*)(wchar_t*, unsigned);
// One loaded test DLL with its exports and isolated directories.
struct Plugin {
  const channel::Identity& identity; std::wstring v0_directory, v1_directory; HMODULE module = nullptr;
  decltype(&scs_telemetry_init) init = nullptr; decltype(&scs_telemetry_shutdown) shutdown = nullptr;
  GetEndpoint v0_endpoint = nullptr, v1_endpoint = nullptr, capture_endpoint = nullptr; bool initialized = false;
  Plugin(const std::wstring& path, const channel::Identity& id, const transport::OwnerSecurity& security, const transport::UserIdentity& user, const transport::PeerIdentity& self, const wchar_t* label, bool serve_v1)
      : identity(id), v0_directory(temporary_directory(security, label)) {
    write_policy(v0_directory, security, user, self);
    if (serve_v1) v1_directory = temporary_directory(security, (std::wstring(label) + L"-v1").c_str());
    module = LoadLibraryW(path.c_str()); require(module != nullptr, "test DLL load");
    init = reinterpret_cast<decltype(init)>(GetProcAddress(module, "scs_telemetry_init")); shutdown = reinterpret_cast<decltype(shutdown)>(GetProcAddress(module, "scs_telemetry_shutdown"));
    auto set_v0 = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_directory")); auto set_v1 = reinterpret_cast<SetDirectory>(GetProcAddress(module, "ets2telemetry_test_v1_directory"));
    v0_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_endpoint")); v1_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_v1_endpoint"));
    capture_endpoint = reinterpret_cast<GetEndpoint>(GetProcAddress(module, "ets2telemetry_test_capture_endpoint"));
    require(init && shutdown && set_v0 && set_v1 && v0_endpoint && v1_endpoint && capture_endpoint, "official exports and test seams");
    require(set_v0(v0_directory.c_str()) != 0 && (!serve_v1 || set_v1(v1_directory.c_str()) != 0), "isolated test directories");
  }
  ~Plugin() {
    if (initialized) shutdown(); if (module) FreeLibrary(module);
    for (const auto& directory : {v0_directory, v1_directory}) if (!directory.empty()) { DeleteFileW((directory + L"\\service-policy.json").c_str()); RemoveDirectoryW(directory.c_str()); }
  }
  Plugin(const Plugin&) = delete;
  static std::wstring read(GetEndpoint get) { std::array<wchar_t, 512> name{}; return get(name.data(), static_cast<unsigned>(name.size())) ? std::wstring(name.data()) : std::wstring(); }
  std::wstring published(GetEndpoint get) const { std::wstring name; require(until([&] { name = read(get); return !name.empty(); }, publication_guard_ms), "endpoint published"); return name; }
  void retire() { const auto start = GetTickCount64(); shutdown(); initialized = false; std::cout << "plugin channel=" << identity.name << " shutdownMs=" << GetTickCount64() - start << '\n'; }
};
std::wstring after_prefix(const std::wstring& name, const channel::Identity& identity) {
  const std::wstring prefix(identity.pipe_prefix_wide); require(name.rfind(prefix, 0) == 0, "endpoint name starts with its own channel's prefix"); return name.substr(prefix.size());
}
// The discovery record for an endpoint: {processInstanceId}.json in that plugin's directory, naming exactly that pipe.
void own_record(const std::wstring& directory, const std::wstring& endpoint) {
  const auto instance = endpoint.substr(endpoint.size() - 36);
  const auto record = v0::detail::Parser(read_file(directory + L"\\" + instance + L".json")).parse();
  require(record.at("pipeName").string() == utf8(endpoint), "discovery record in the plugin's own directory names its own pipe");
}
bool listening(const std::wstring& endpoint) { return WaitNamedPipeW(endpoint.c_str(), 1000) != FALSE || GetLastError() == ERROR_SEM_TIMEOUT; }

template<unsigned N> void report(const PluginHost<N>& host, const channel::Identity& identity) {
  LARGE_INTEGER frequency{}; QueryPerformanceFrequency(&frequency); auto samples = host.callback_ticks; std::sort(samples.begin(), samples.end());
  require(!samples.empty(), "callbacks timed");
  const auto us = [&](std::int64_t t) { return static_cast<double>(t) * 1e6 / static_cast<double>(frequency.QuadPart); };
  double total = 0; for (auto t : samples) total += us(t);
  const auto at = [&](double q) { return us(samples[(std::min)(samples.size() - 1, static_cast<std::size_t>(q * static_cast<double>(samples.size())))]); };
  // Observation only (ET-019 D3): no threshold is asserted on these numbers.
  std::cout << "observation plugin channel=" << identity.name << " frames=" << host.frames << " callbacks=" << samples.size() << " meanUs=" << total / static_cast<double>(samples.size())
            << " p50Us=" << at(0.5) << " p99Us=" << at(0.99) << " maxUs=" << us(samples.back()) << '\n';
}
const channel::Identity& identity_named(const std::string& name) {
  if (name == channel::production.name) return channel::production; if (name == channel::staging.name) return channel::staging;
  throw std::runtime_error("unknown channel name");
}

void two_plugins(const std::wstring& first_path, const channel::Identity& first_identity, const std::wstring& second_path, const channel::Identity& second_identity) {
  require(&first_identity != &second_identity, "the two DLLs belong to different channels");
  const auto user = transport::current_user(); transport::OwnerSecurity security(user.sid); const auto self = transport::inspect_peer(GetCurrentProcessId());
  PluginHost<0> host_a; PluginHost<1> host_b;
  Plugin a(first_path, first_identity, security, user, self, L"a", true), b(second_path, second_identity, security, user, self, L"b", true);
  require(a.module != b.module, "two distinct modules in one process");
  auto pa = host_a.params(); require(a.init(SCS_TELEMETRY_VERSION_1_01, &pa) == SCS_RESULT_ok, "first plugin initializes"); a.initialized = true;
  auto pb = host_b.params(); require(b.init(SCS_TELEMETRY_VERSION_1_01, &pb) == SCS_RESULT_ok, "second plugin initializes beside the first"); b.initialized = true;

  // Every endpoint of each plugin carries its own prefix, and the rest of each v0 and v1 name is identical: the prefix is
  // the only thing that keeps them apart in one process.
  const auto a_v0 = a.published(a.v0_endpoint), b_v0 = b.published(b.v0_endpoint), a_v1 = a.published(a.v1_endpoint), b_v1 = b.published(b.v1_endpoint);
  const auto a_cap = a.published(a.capture_endpoint), b_cap = b.published(b.capture_endpoint);
  require(after_prefix(a_v0, a.identity) == after_prefix(b_v0, b.identity) && after_prefix(a_v1, a.identity) == after_prefix(b_v1, b.identity), "same game, user, session and process instance");
  after_prefix(a_cap, a.identity); after_prefix(b_cap, b.identity);
  const std::vector<std::wstring> names{a_v0, b_v0, a_v1, b_v1, a_cap, b_cap};
  for (std::size_t i = 0; i < names.size(); ++i) for (std::size_t j = i + 1; j < names.size(); ++j) require(_wcsicmp(names[i].c_str(), names[j].c_str()) != 0, "six distinct endpoint names");
  for (const auto& name : {a_v1, b_v1, a_cap, b_cap}) require(listening(name), "v1 and CAP0 endpoints listening concurrently");
  own_record(a.v0_directory, a_v0); own_record(b.v0_directory, b_v0); own_record(a.v1_directory, a_v1); own_record(b.v1_directory, b_v1);

  // Both plugins serve an authorized v0 client at the same time, and each client sees only its own plugin's frames.
  Client client_a(a_v0), client_b(b_v0);
  require(client_a.read_until([&] { return client_a.messages.size() >= 2; }) && client_b.read_until([&] { return client_b.messages.size() >= 2; }), "both handshakes complete");
  host_a.event(SCS_TELEMETRY_EVENT_started); host_b.event(SCS_TELEMETRY_EVENT_started);
  host_a.timing = host_b.timing = true;
  const auto start = GetTickCount64();
  while (GetTickCount64() - start < side_by_side_ms) { host_a.frame(11); host_b.frame(22); Sleep(1); }
  host_a.timing = host_b.timing = false;
  require(client_a.read_until([&] { return client_a.saw_speed(11); }) && client_b.read_until([&] { return client_b.saw_speed(22); }), "each client receives its own plugin's frames");
  const auto own_values = [](const Client& c, double speed, const std::string& session) {
    return std::all_of(c.messages.begin(), c.messages.end(), [&](const v0::Message& m) {
      return (!m.source || m.source->plugin_session_id == session) && (!m.state || !m.state->speed.reading.value || *m.state->speed.reading.value == speed); });
  };
  const auto first_source = [](const Client& c) { for (const auto& m : c.messages) if (m.source) return *m.source; throw std::runtime_error("no source identity"); };
  const auto source_a = first_source(client_a), source_b = first_source(client_b);
  require(source_a.plugin_session_id != source_b.plugin_session_id && source_a.process_instance_id == source_b.process_instance_id, "two plugin sessions in one game process");
  require(own_values(client_a, 11, source_a.plugin_session_id) && own_values(client_b, 22, source_b.plugin_session_id), "no frame crosses between the plugins");

  // Control: the first DLL again under another file name loads as a third module with the same prefix. Its v0 endpoint
  // collides with the first plugin's, so its startup fails closed, now or as a deferred report, and the first plugin keeps serving.
  {
    const auto copy = std::filesystem::temp_directory_path() / (L"ET055-collision-" + std::to_wstring(GetCurrentProcessId()) + L".dll");
    require(CopyFileW(first_path.c_str(), copy.c_str(), FALSE) != FALSE, "control DLL copy");
    {
      PluginHost<2> host_c; Plugin c(copy.wstring(), first_identity, security, user, self, L"c", false);
      require(c.module != a.module, "control loads as a separate module");
      auto pc = host_c.params(); const auto result = c.init(SCS_TELEMETRY_VERSION_1_01, &pc); c.initialized = result == SCS_RESULT_ok;
      const std::string expected = std::string(first_identity.game_log_prefix) + " transport startup failed: endpoint-creation";
      const auto reported = [&] { return std::find(host_c.logs.begin(), host_c.logs.end(), expected) != host_c.logs.end(); };
      if (result == SCS_RESULT_ok) require(until([&] { host_c.frame(1); return reported(); }, deferred_report_guard_ms), "same-prefix control reports its collision on a later callback");
      else require(result == SCS_RESULT_generic_error && reported(), "same-prefix control fails initialization with the collision");
      require(host_c.wrong_thread == 0, "control worker makes no SDK calls");
    }
    DeleteFileW(copy.c_str());
    host_a.frame(33); require(client_a.read_until([&] { return client_a.saw_speed(33); }), "first plugin still serves after the control");
  }

  report(host_a, a.identity); report(host_b, b.identity);
  client_a.pipe.reset(); client_b.pipe.reset();
  a.retire(); b.retire();
  require(host_a.wrong_thread == 0 && host_b.wrong_thread == 0, "workers make no SDK calls");
}
}
int main(int argc, char** argv) {
  try {
    if (argc != 5) throw std::runtime_error("usage: two-plugin-host-test <test DLL> <channel> <test DLL> <channel>");
    // Command-line paths arrive in the ANSI code page; std::filesystem::path converts them as Windows does.
    two_plugins(std::filesystem::path(argv[1]).wstring(), identity_named(argv[2]), std::filesystem::path(argv[3]).wstring(), identity_named(argv[4]));
    std::cout << "Two plugins in one process: " << assertions << " assertions passed; real game, frame time and CPU pending\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << "Two-plugin failure after " << assertions << " assertions: " << e.what() << '\n'; return 1; }
}
