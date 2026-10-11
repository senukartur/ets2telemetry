#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "scssdk_telemetry.h"
#include <iostream>

namespace {
unsigned registrations = 0, unregistrations = 0;
SCSAPI_RESULT register_event(scs_event_t, scs_telemetry_event_callback_t, scs_context_t) { ++registrations; return SCS_RESULT_ok; }
SCSAPI_RESULT unregister_event(scs_event_t) { ++unregistrations; return SCS_RESULT_ok; }
SCSAPI_RESULT register_channel(scs_string_t, scs_u32_t, scs_value_type_t, scs_u32_t, scs_telemetry_channel_callback_t, scs_context_t) { ++registrations; return SCS_RESULT_not_found; }
SCSAPI_RESULT unregister_channel(scs_string_t, scs_u32_t, scs_value_type_t) { return SCS_RESULT_ok; }
}
int main(int argc, char** argv) {
  if (argc != 2 || sizeof(void*) != 8) return 1;
  HMODULE module = LoadLibraryA(argv[1]); if (!module) { std::cerr << "DLL load error " << GetLastError() << '\n'; return 1; }
  using Init = decltype(&scs_telemetry_init); using Shutdown = decltype(&scs_telemetry_shutdown);
  auto init = reinterpret_cast<Init>(GetProcAddress(module, "scs_telemetry_init"));
  auto shutdown = reinterpret_cast<Shutdown>(GetProcAddress(module, "scs_telemetry_shutdown"));
  bool passed = init && shutdown;
  if (passed) {
    passed = init(SCS_MAKE_VERSION(2,0), nullptr) == SCS_RESULT_unsupported && init(SCS_TELEMETRY_VERSION_1_01, nullptr) == SCS_RESULT_invalid_parameter;
    scs_telemetry_init_params_v100_t params{}; params.common.game_id = "eut2"; params.common.game_version = SCS_MAKE_VERSION(1,20);
    params.register_for_event = register_event; params.unregister_from_event = unregister_event; params.register_for_channel = register_channel; params.unregister_from_channel = unregister_channel;
    passed = passed && init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok;
    shutdown(); shutdown(); passed = passed && registrations == 16 && unregistrations == 6;
    passed = passed && init(SCS_TELEMETRY_VERSION_1_00, &params) == SCS_RESULT_ok; shutdown();
    passed = passed && registrations == 31 && unregistrations == 11;
  }
  FreeLibrary(module);
  std::cout << "Exact official SDK ABI exports/lifecycle: " << (passed ? "passed" : "failed") << '\n'; return passed ? 0 : 1;
}
