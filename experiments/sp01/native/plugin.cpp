// Registration and channel handling derive from the official SDK telemetry example.
// See ../SCS-SDK-LICENSE.txt. This experimental DLL does not implement a recorder.
#include "transport.hpp"
#include <scssdk_telemetry.h>
#include <common/scssdk_telemetry_truck_common_channels.h>
#include <cstring>
#include <cstdio>

namespace {
sp01::Snapshot state;
// SDK shutdown owns cleanup. No thread join runs from a CRT destructor under the loader lock.
sp01::Transport* transport = nullptr;
SCSAPI_VOID channel(const scs_string_t, const scs_u32_t, const scs_value_t* value, const scs_context_t context) {
  const bool valid = value && value->type == SCS_VALUE_TYPE_float;
  if (context) { state.fuel_available = valid; if (valid) state.fuel = value->value_float.value; }
  else { state.speed_available = valid; if (valid) state.speed = value->value_float.value; }
}
SCSAPI_VOID frame_start(const scs_event_t, const void* info, const scs_context_t) {
  const auto* frame = static_cast<const scs_telemetry_frame_start_t*>(info);
  state.render_us = frame->render_time; state.simulation_us = frame->simulation_time;
  state.timer_restart = (frame->flags & SCS_TELEMETRY_FRAME_START_FLAG_timer_restart) != 0;
}
SCSAPI_VOID frame_end(const scs_event_t, const void*, const scs_context_t) {
  ++state.frame; if (transport) transport->publish(state);
}
SCSAPI_VOID pause(const scs_event_t event, const void*, const scs_context_t) {
  state.paused = event == SCS_TELEMETRY_EVENT_paused;
  if (transport) transport->publish(state);
}
}
SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* params) {
  if (version != SCS_TELEMETRY_VERSION_1_01 || !params || transport) return SCS_RESULT_unsupported;
  const auto* api = static_cast<const scs_telemetry_init_params_v101_t*>(params);
  const char* id = api->common.game_id;
  if (!id || (std::strcmp(id, "eut2") != 0 && std::strcmp(id, "ats") != 0)) return SCS_RESULT_unsupported;
  state = {};
  if (api->register_for_event(SCS_TELEMETRY_EVENT_frame_start, frame_start, nullptr) != SCS_RESULT_ok ||
      api->register_for_event(SCS_TELEMETRY_EVENT_frame_end, frame_end, nullptr) != SCS_RESULT_ok ||
      api->register_for_event(SCS_TELEMETRY_EVENT_paused, pause, nullptr) != SCS_RESULT_ok ||
      api->register_for_event(SCS_TELEMETRY_EVENT_started, pause, nullptr) != SCS_RESULT_ok) return SCS_RESULT_generic_error;
  // Failure leaves a channel unavailable rather than inventing zero.
  api->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_speed, SCS_U32_NIL, SCS_VALUE_TYPE_float,
    SCS_TELEMETRY_CHANNEL_FLAG_no_value, channel, nullptr);
  api->register_for_channel(SCS_TELEMETRY_TRUCK_CHANNEL_fuel, SCS_U32_NIL, SCS_VALUE_TYPE_float,
    SCS_TELEMETRY_CHANNEL_FLAG_no_value, channel, reinterpret_cast<void*>(1));
  try {
    auto name = sp01::pipe_name(id);
#ifdef SP01_SDK_TEST
    // Only the console harness compiles this suffix; the game DLL has no test override.
    name += L".sdk-test." + std::to_wstring(GetCurrentProcessId());
#endif
    transport = new sp01::Transport(name, id);
  }
  catch (...) { api->common.log(SCS_LOG_TYPE_error, "SP-01 transport initialization failed"); return SCS_RESULT_generic_error; }
  api->common.log(SCS_LOG_TYPE_message, "ETS2Telemetry SP-01 loaded: experimental speed/fuel only; API 1.01");
  char version_message[128]{};
  std::snprintf(version_message, sizeof version_message, "SP-01 SDK game ID %s; telemetry game API version %u.%u", id,
    SCS_GET_MAJOR_VERSION(api->common.game_version), SCS_GET_MINOR_VERSION(api->common.game_version));
  api->common.log(SCS_LOG_TYPE_message, version_message);
  return SCS_RESULT_ok;
}
SCSAPI_VOID scs_telemetry_shutdown() { delete transport; transport = nullptr; state = {}; }
