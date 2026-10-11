#include "sdk-adapter.hpp"
#include "game-window-monitor.hpp"
#include <memory>

namespace {
// Created and retired only in the official SDK lifecycle, outside loader lock.
// No CRT static destructor may join a thread while DLL detach holds loader lock.
ets2telemetry::window::Monitor* window_monitor = nullptr;
void retire_monitor() noexcept {
  std::unique_ptr<ets2telemetry::window::Monitor> retiring(window_monitor);
  window_monitor = nullptr;
  if (retiring) retiring->stop();
}
}

SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* const params) {
  bool initialized = false;
  try {
    const auto result = ets2telemetry::sdk::adapter().initialize(version, params);
    if (result == SCS_RESULT_ok) {
      initialized = true;
      auto state = std::make_unique<ets2telemetry::sdk::Snapshot>();
      if (ets2telemetry::sdk::adapter().read_current(*state)) {
        auto starting = std::make_unique<ets2telemetry::window::Monitor>();
        starting->start(state->identity.game_id.c_str(), state->identity.plugin_session_id.c_str());
        window_monitor = starting.release();
      }
    }
    return result;
  }
  catch (...) {
    if (initialized) { retire_monitor(); ets2telemetry::sdk::adapter().shutdown(); }
    return SCS_RESULT_generic_error;
  }
}
SCSAPI_VOID scs_telemetry_shutdown() {
  try {
    retire_monitor();
    ets2telemetry::sdk::adapter().shutdown();
  }
  catch (...) { /* SDK exports never propagate a C++ exception into the game. */ }
}
// There is no DllMain. The monitor never calls the SCS API.
