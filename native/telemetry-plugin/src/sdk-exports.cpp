#include "sdk-adapter.hpp"
#include "pipe-server.hpp"
#include "game-window-monitor.hpp"
#include "capture-server.hpp"
#include "v1-server.hpp"
#include "game-mode-detector.hpp"

namespace {
// Explicit SDK shutdown owns joining; no static destructor joins under DLL unload.
ets2telemetry::window::Monitor* monitor = nullptr;
// CAP0 evidence origin is fixed per artifact: the isolated test DLL is never game evidence.
ets2telemetry::cap0::CaptureServer& capture() noexcept {
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
  static ets2telemetry::cap0::CaptureServer value(ets2telemetry::sdk::adapter(), "synthetic");
#else
  static ets2telemetry::cap0::CaptureServer value(ets2telemetry::sdk::adapter(), "game");
#endif
  return value;
}
// The protocol v1 endpoint (ET-004b). Its origin is fixed per artifact like CAP0's; the server holds its event channel
// by pointer, so the over-aligned channel never lives inside a static of this translation unit.
ets2telemetry::v1::Server& v1_endpoint() noexcept {
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
  static ets2telemetry::v1::Server value(ets2telemetry::sdk::adapter(), ets2telemetry::v1::Origin::synthetic);
#else
  static ets2telemetry::v1::Server value(ets2telemetry::sdk::adapter(), ets2telemetry::v1::Origin::game);
#endif
  return value;
}
void retire() noexcept {
  // v1 first learns of the stop, so its `end` is written while the CAP0 drain and end marker run; then CAP0 joins, then
  // v1, then v0. The adapter shuts down after every worker has joined, and the channel is detached last (Caller
  // sequence step 7), so no callback can reach a channel whose worker is gone.
  v1_endpoint().signal_stop();
  capture().stop();
  v1_endpoint().stop();
  ets2telemetry::transport::server().stop();
  if (monitor) { monitor->stop(); delete monitor; monitor = nullptr; }
  ets2telemetry::sdk::adapter().shutdown();
  ets2telemetry::sdk::adapter().attach_events(nullptr);
}
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
namespace { std::wstring test_directory, test_v1_directory; }
// This isolated-console test seam is absent from the production game's DLL.
extern "C" __declspec(dllexport) int ets2telemetry_test_directory(const wchar_t* directory) noexcept {
  try { if (!directory || wcslen(directory) > 4096) return 0; test_directory = directory; return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_endpoint(wchar_t* output, unsigned capacity) noexcept {
  try { const auto endpoint = ets2telemetry::transport::server().endpoint(); if (!output || endpoint.empty() || endpoint.size()+1 > capacity) return 0; wcscpy_s(output,capacity,endpoint.c_str()); return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_write_pending() noexcept { return ets2telemetry::transport::server().write_pending() ? 1 : 0; }
extern "C" __declspec(dllexport) int ets2telemetry_test_capture_endpoint(wchar_t* output, unsigned capacity) noexcept {
  try { const auto endpoint = capture().endpoint(); if (!output || endpoint.empty() || endpoint.size()+1 > capacity) return 0; wcscpy_s(output,capacity,endpoint.c_str()); return 1; } catch (...) { return 0; }
}
// Protocol v1 seams. A test DLL serves v1 only after a directory is set here, so the earlier DLL and CAP0 tests, which
// never set it, load a DLL whose v1 endpoint is neither prepared nor started.
extern "C" __declspec(dllexport) int ets2telemetry_test_v1_directory(const wchar_t* directory) noexcept {
  try { if (!directory || wcslen(directory) > 4096) return 0; test_v1_directory = directory; return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_v1_endpoint(wchar_t* output, unsigned capacity) noexcept {
  try { const auto endpoint = v1_endpoint().endpoint(); if (!output || endpoint.empty() || endpoint.size()+1 > capacity) return 0; wcscpy_s(output,capacity,endpoint.c_str()); return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_v1_write_pending() noexcept { return v1_endpoint().write_pending() ? 1 : 0; }
// Reads the adapter's own channel pointer, so the seam shows what the callbacks would actually use.
extern "C" __declspec(dllexport) int ets2telemetry_test_v1_attached() noexcept { return ets2telemetry::sdk::adapter().events_attached() ? 1 : 0; }
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Present only in the separately hooked test DLL: the console test owns the hook until unload.
extern "C" __declspec(dllexport) void ets2telemetry_test_transport_hook(ets2telemetry::transport::TransportTestHook hook) noexcept { ets2telemetry::transport::set_transport_test_hook(hook); }
#endif
#endif

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* const params) {
  try {
    auto result = ets2telemetry::sdk::adapter().initialize(version, params);
    if (result != SCS_RESULT_ok) return result;
    ets2telemetry::sdk::Snapshot initial;
    if (!ets2telemetry::sdk::adapter().read_current(initial)) { retire(); return SCS_RESULT_generic_error; }
    ets2telemetry::sdk::adapter().set_game_mode(ets2telemetry::game_mode::detect(
      std::string_view(initial.identity.game.c_str()) == "ats" ? ets2telemetry::v1::GameId::ats : ets2telemetry::v1::GameId::ets2));
    // Protocol v1 (OD-2): the channel is prepared and attached right after initialize(), once per plugin session, so every
    // event of the session gets an eventSeq. Its endpoint starts asynchronously below; until a client is authorized the
    // callbacks keep only state and loss counters.
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
    const bool serve_v1 = !test_v1_directory.empty();
#else
    const bool serve_v1 = true;
#endif
    bool v1_attached = false;
    if (serve_v1) if (auto* channel = v1_endpoint().prepare()) { ets2telemetry::sdk::adapter().attach_events(channel); v1_attached = true; }
    if (!monitor) monitor = new ets2telemetry::window::Monitor();
    // Identity rejection leaves telemetry available and window metadata unavailable.
    monitor->start(initial.identity.game_id.c_str(), initial.identity.plugin_session_id.c_str());
    auto& transport = ets2telemetry::transport::server();
    auto failure = ets2telemetry::transport::StartupFailure::worker_creation;
    if (transport.start(
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
      test_directory,
#else
      {},
#endif
      monitor
    )) failure = transport.await_startup();
    // SDK readme permits game calls only during the direct game caller's invocation.
    const auto log = static_cast<const scs_telemetry_init_params_v100_t*>(params)->common.log;
    if (failure == ets2telemetry::transport::StartupFailure::timeout) {
      // A slow host must not cost the whole session: the game waited its fixed budget, the worker keeps
      // starting, and the adapter logs its eventual result once from a later SDK callback.
      if (log) log(SCS_LOG_TYPE_warning,ets2telemetry::transport::startup_pending_message());
    } else if (failure != ets2telemetry::transport::StartupFailure::none) {
      // Completion/join precedes return even when cancellation exceeds the startup wait budget.
      retire();
      if (log) log(SCS_LOG_TYPE_error,ets2telemetry::transport::startup_failure_message(failure));
      return SCS_RESULT_generic_error;
    }
    // Optional evidence endpoint: its startup is asynchronous and its failure never disables v0.
    capture().start(
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
      test_directory
#endif
    );
    // The v1 endpoint starts beside CAP0. A failure never fails initialization and is not logged to the game (OD-2); a
    // channel without a worker is detached again.
    if (v1_attached && !v1_endpoint().start(
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
      test_v1_directory,
#else
      {},
#endif
      monitor)) ets2telemetry::sdk::adapter().attach_events(nullptr);
    return result;
  }
  catch (...) { retire(); return SCS_RESULT_generic_error; }
}
SCSAPI_VOID scs_telemetry_shutdown() {
  try { retire(); }
  catch (...) { /* SDK exports never propagate a C++ exception into the game. */ }
}
// No DllMain: start/stop/join belongs to the explicit SDK lifecycle, outside the loader lock.
