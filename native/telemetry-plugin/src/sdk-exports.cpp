#include "sdk-adapter.hpp"
#include "pipe-server.hpp"
#include "game-window-monitor.hpp"

namespace {
// Explicit SDK shutdown owns joining; no static destructor joins under DLL unload.
ets2telemetry::window::Monitor* monitor = nullptr;
void retire() noexcept {
  ets2telemetry::transport::server().stop();
  if (monitor) { monitor->stop(); delete monitor; monitor = nullptr; }
  ets2telemetry::sdk::adapter().shutdown();
}
}

#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
namespace { std::wstring test_directory; }
// This isolated-console test seam is absent from the production game's DLL.
extern "C" __declspec(dllexport) int ets2telemetry_test_directory(const wchar_t* directory) noexcept {
  try { if (!directory || wcslen(directory) > 4096) return 0; test_directory = directory; return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_endpoint(wchar_t* output, unsigned capacity) noexcept {
  try { const auto endpoint = ets2telemetry::transport::server().endpoint(); if (!output || endpoint.empty() || endpoint.size()+1 > capacity) return 0; wcscpy_s(output,capacity,endpoint.c_str()); return 1; } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int ets2telemetry_test_write_pending() noexcept { return ets2telemetry::transport::server().write_pending() ? 1 : 0; }
#endif

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* const params) {
  try {
    auto result = ets2telemetry::sdk::adapter().initialize(version, params);
    if (result != SCS_RESULT_ok) return result;
    ets2telemetry::sdk::Snapshot initial;
    if (!ets2telemetry::sdk::adapter().read_current(initial)) { retire(); return SCS_RESULT_generic_error; }
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
    if (failure != ets2telemetry::transport::StartupFailure::none) {
      // Completion/join precedes return even when cancellation exceeds the startup wait budget.
      retire();
      // SDK readme permits game calls only during the direct game caller's invocation.
      const auto log = static_cast<const scs_telemetry_init_params_v100_t*>(params)->common.log;
      if (log) log(SCS_LOG_TYPE_error,ets2telemetry::transport::startup_failure_message(failure));
      return SCS_RESULT_generic_error;
    }
    return result;
  }
  catch (...) { retire(); return SCS_RESULT_generic_error; }
}
SCSAPI_VOID scs_telemetry_shutdown() {
  try { retire(); }
  catch (...) { /* SDK exports never propagate a C++ exception into the game. */ }
}
// No DllMain: start/stop/join belongs to the explicit SDK lifecycle, outside the loader lock.
