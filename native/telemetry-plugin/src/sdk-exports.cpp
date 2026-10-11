#include "sdk-adapter.hpp"
#include "pipe-server.hpp"

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
    if (result == SCS_RESULT_ok && !ets2telemetry::transport::server().start(
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_DLL
      test_directory
#endif
    )) {
      ets2telemetry::sdk::adapter().shutdown(); return SCS_RESULT_generic_error;
    }
    return result;
  }
  catch (...) { return SCS_RESULT_generic_error; }
}
SCSAPI_VOID scs_telemetry_shutdown() {
  try { ets2telemetry::transport::server().stop(); ets2telemetry::sdk::adapter().shutdown(); }
  catch (...) { /* SDK exports never propagate a C++ exception into the game. */ }
}
// No DllMain: start/stop/join belongs to the explicit SDK lifecycle, outside the loader lock.
