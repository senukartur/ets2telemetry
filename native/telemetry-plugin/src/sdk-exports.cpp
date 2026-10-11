#include "sdk-adapter.hpp"

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* const params) {
  try { return ets2telemetry::sdk::adapter().initialize(version, params); }
  catch (...) { return SCS_RESULT_generic_error; }
}
SCSAPI_VOID scs_telemetry_shutdown() {
  try { ets2telemetry::sdk::adapter().shutdown(); }
  catch (...) { /* SDK exports never propagate a C++ exception into the game. */ }
}
// There is deliberately no DllMain and no worker/thread/file/transport initialization here.
