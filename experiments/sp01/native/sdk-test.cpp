#include "transport.hpp"
#include <scssdk_telemetry.h>
#include <map>
#include <iostream>
#include <stdexcept>
#include <cstring>
namespace {
std::map<scs_event_t, scs_telemetry_event_callback_t> events;
scs_telemetry_channel_callback_t speed = nullptr, fuel = nullptr;
scs_context_t fuel_context = nullptr;
DWORD sdk_thread = 0;
bool thread_violation = false, fail_registration = false;
void require(bool condition, const char* text) { if (!condition) throw std::runtime_error(text); }
void check_thread() { if (GetCurrentThreadId() != sdk_thread) thread_violation = true; }
SCSAPI_VOID log_message(scs_log_type_t, scs_string_t) { check_thread(); }
SCSAPI_RESULT register_event(scs_event_t event, scs_telemetry_event_callback_t callback, scs_context_t) {
  check_thread(); if (fail_registration) return SCS_RESULT_generic_error;
  events[event] = callback; return SCS_RESULT_ok;
}
SCSAPI_RESULT register_channel(scs_string_t name, scs_u32_t, scs_value_type_t type, scs_u32_t flags,
                               scs_telemetry_channel_callback_t callback, scs_context_t context) {
  check_thread();
  require(type == SCS_VALUE_TYPE_float && flags == SCS_TELEMETRY_CHANNEL_FLAG_no_value, "channel type/unavailable flag");
  if (std::strcmp(name, "truck.speed") == 0) speed = callback;
  else if (std::strcmp(name, "truck.fuel.amount") == 0) { fuel = callback; fuel_context = context; }
  else return SCS_RESULT_not_found;
  return SCS_RESULT_ok;
}
}
int main() {
  try {
    sdk_thread = GetCurrentThreadId();
    scs_telemetry_init_params_v101_t params{};
    params.common.game_id = "eut2"; params.common.game_name = "Synthetic SDK harness"; params.common.log = log_message;
    params.register_for_event = register_event; params.register_for_channel = register_channel;
    require(scs_telemetry_init(SCS_TELEMETRY_VERSION_1_00, &params) == SCS_RESULT_unsupported, "API rejection");
    params.common.game_id = "other";
    require(scs_telemetry_init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_unsupported, "unknown game rejection");
    params.common.game_id = "eut2"; fail_registration = true;
    require(scs_telemetry_init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_generic_error, "registration failure");
    fail_registration = false;
    for (const auto* game : {"eut2", "ats"}) {
      events.clear(); params.common.game_id = game;
      require(scs_telemetry_init(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "SDK init");
      require(events.size() == 4 && speed && fuel, "required registrations");
      require(scs_telemetry_init(SCS_TELEMETRY_VERSION_1_01, &params) != SCS_RESULT_ok, "duplicate init rejected");
      scs_value_t value{}; value.type = SCS_VALUE_TYPE_float; value.value_float.value = 25;
      speed("truck.speed", SCS_U32_NIL, &value, nullptr);
      value.value_float.value = 0; fuel("truck.fuel.amount", SCS_U32_NIL, &value, fuel_context);
      scs_telemetry_frame_start_t frame{}; frame.render_time = 100; frame.simulation_time = 80;
      frame.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart;
      events.at(SCS_TELEMETRY_EVENT_frame_start)(SCS_TELEMETRY_EVENT_frame_start, &frame, nullptr);
      events.at(SCS_TELEMETRY_EVENT_started)(SCS_TELEMETRY_EVENT_started, nullptr, nullptr);
      events.at(SCS_TELEMETRY_EVENT_frame_end)(SCS_TELEMETRY_EVENT_frame_end, nullptr, nullptr);
      HANDLE client = INVALID_HANDLE_VALUE;
      const auto name = sp01::pipe_name(game) + L".sdk-test." + std::to_wstring(GetCurrentProcessId());
      for (int i = 0; i < 50 && client == INVALID_HANDLE_VALUE; ++i) {
        client = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (client == INVALID_HANDLE_VALUE) Sleep(10);
      }
      require(client != INVALID_HANDLE_VALUE, "SDK pipe connects");
      char buffer[2048]{}; DWORD bytes = 0;
      require(ReadFile(client, buffer, sizeof buffer, &bytes, nullptr) && bytes > 0, "SDK frame received");
      auto line = std::string(buffer, bytes);
      require(line.find("\"speedMps\":25") != std::string::npos && line.find("\"fuelLitres\":0") != std::string::npos, "SDK values and zero copied");
      require(line.find("\"timerRestart\":true") != std::string::npos, "timer restart copied");
      speed("truck.speed", SCS_U32_NIL, nullptr, nullptr);
      events.at(SCS_TELEMETRY_EVENT_paused)(SCS_TELEMETRY_EVENT_paused, nullptr, nullptr);
      events.at(SCS_TELEMETRY_EVENT_frame_end)(SCS_TELEMETRY_EVENT_frame_end, nullptr, nullptr);
      Sleep(80);
      require(ReadFile(client, buffer, sizeof buffer, &bytes, nullptr), "unavailable frame received");
      line = std::string(buffer, bytes);
      require(line.find("\"speedMps\":null") != std::string::npos && line.find("\"paused\":true") != std::string::npos, "unavailable/pause copied");
      CloseHandle(client); scs_telemetry_shutdown(); scs_telemetry_shutdown();
    }
    require(!thread_violation, "SCS calls remain on allowed thread");
    std::cout << "Synthetic SDK registration/error, both game IDs, callback units, missing values, pause/reset, repeated shutdown passed\n";
    return 0;
  } catch (const std::exception& error) { scs_telemetry_shutdown(); std::cerr << error.what() << '\n'; return 1; }
}
