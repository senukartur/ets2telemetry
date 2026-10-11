#include "sdk-adapter.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <cmath>
#include <cstring>
#include <limits>
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "amtrucks/scssdk_ats.h"

namespace ets2telemetry::sdk {
namespace {
constexpr std::size_t fields = static_cast<std::size_t>(Field::count);
constexpr std::array<ChannelSpec, fields> specs{{
  {SCS_TELEMETRY_TRUCK_CHANNEL_speed, SCS_VALUE_TYPE_float, "m/s", 1, -1000, 1000},
  {SCS_TELEMETRY_TRUCK_CHANNEL_fuel, SCS_VALUE_TYPE_float, "L", 1, 0, 1000000},
  {SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm, SCS_VALUE_TYPE_float, "rpm", 1, 0, 100000},
  {SCS_TELEMETRY_TRUCK_CHANNEL_displayed_gear, SCS_VALUE_TYPE_s32, "index", 1, -100, 100},
  {SCS_TELEMETRY_TRUCK_CHANNEL_odometer, SCS_VALUE_TYPE_float, "m", 1000, 0, 1e12},
  {SCS_TELEMETRY_TRUCK_CHANNEL_fuel_average_consumption, SCS_VALUE_TYPE_float, "L/100km", 100, 0, 1000000},
  {SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range, SCS_VALUE_TYPE_float, "m", 1000, 0, 1e12},
  {SCS_TELEMETRY_CHANNEL_game_time, SCS_VALUE_TYPE_u32, "min", 1, 0, 4294967295.0},
  {SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, SCS_VALUE_TYPE_float, "m", 1, 0, 1e12},
  {SCS_TELEMETRY_TRUCK_CHANNEL_world_placement, SCS_VALUE_TYPE_dplacement, "game-world", 1, 0, 0}
}};
void increment(std::uint64_t& value) noexcept { if (value != UINT64_MAX) ++value; }
void add(std::uint64_t& value, std::uint64_t count) noexcept { value = count > UINT64_MAX - value ? UINT64_MAX : value + count; }
void add(std::atomic<std::uint64_t>& value, std::uint64_t count) noexcept {
  auto previous = value.load(std::memory_order_relaxed);
  while (!value.compare_exchange_weak(previous, count > UINT64_MAX - previous ? UINT64_MAX : previous + count, std::memory_order_relaxed)) {}
}
bool equal(const char* a, const char* b) noexcept {
  if (!a || !b) return false;
  for (std::size_t i = 0; i <= 128; ++i) { if (a[i] != b[i]) return false; if (!a[i]) return true; }
  return false;
}
// Bounded byte copy and Unicode validation. Reject truncation rather than change source identity.
bool unicode(const char* data, std::size_t size) noexcept {
  std::size_t i = 0;
  while (i < size) {
    auto byte = static_cast<unsigned char>(data[i++]);
    if (byte < 32 || byte == 127) return false;
    if (byte < 128) continue;
    unsigned count = 0; std::uint32_t code = 0, minimum = 0;
    if (byte >= 0xc2 && byte <= 0xdf) { count = 1; code = byte & 31; minimum = 0x80; }
    else if (byte >= 0xe0 && byte <= 0xef) { count = 2; code = byte & 15; minimum = 0x800; }
    else if (byte >= 0xf0 && byte <= 0xf4) { count = 3; code = byte & 7; minimum = 0x10000; }
    else return false;
    if (i + count > size) return false;
    for (unsigned j = 0; j < count; ++j) { byte = static_cast<unsigned char>(data[i++]); if ((byte & 0xc0) != 0x80) return false; code = (code << 6) | (byte & 63); }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
bool uuid(Uuid& output) noexcept {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
  bytes[6] = static_cast<unsigned char>((bytes[6] & 15) | 64); bytes[8] = static_cast<unsigned char>((bytes[8] & 63) | 128);
  constexpr char hex[] = "0123456789abcdef";
  std::size_t cursor = 0;
  for (std::size_t i = 0; i < bytes.size(); ++i) { if (i == 4 || i == 6 || i == 8 || i == 10) output.bytes[cursor++] = '-'; output.bytes[cursor++] = hex[bytes[i] >> 4]; output.bytes[cursor++] = hex[bytes[i] & 15]; }
  output.bytes[36] = 0; output.status = Availability::available; return true;
}
Scalar scalar(const scs_value_t* input) noexcept {
  Scalar result;
  if (!input) return result;
  result.type = input->type; result.status = Availability::available;
  switch (input->type) {
    case SCS_VALUE_TYPE_bool: result.boolean = input->value_bool.value != 0; break;
    case SCS_VALUE_TYPE_s32: result.signed_integer = input->value_s32.value; break;
    case SCS_VALUE_TYPE_s64: result.signed_integer = input->value_s64.value; break;
    case SCS_VALUE_TYPE_u32: result.unsigned_integer = input->value_u32.value; break;
    case SCS_VALUE_TYPE_u64: result.unsigned_integer = input->value_u64.value; break;
    case SCS_VALUE_TYPE_float: result.number = input->value_float.value; if (!std::isfinite(result.number)) result.status = Availability::invalid; break;
    case SCS_VALUE_TYPE_double: result.number = input->value_double.value; if (!std::isfinite(result.number)) result.status = Availability::invalid; break;
    case SCS_VALUE_TYPE_string: result.string.assign(input->value_string.value); result.status = result.string.status; break;
    case SCS_VALUE_TYPE_dplacement:
      result.placement = input->value_dplacement;
      if (!std::isfinite(result.placement.position.x) || !std::isfinite(result.placement.position.y) || !std::isfinite(result.placement.position.z) || !std::isfinite(result.placement.orientation.heading) || !std::isfinite(result.placement.orientation.pitch) || !std::isfinite(result.placement.orientation.roll)) result.status = Availability::invalid;
      break;
    default: result.status = Availability::not_supported; break;
  }
  return result;
}
Reading<double> measurement(const scs_value_t* value, scs_value_type_t type, double multiplier, double minimum, double maximum) noexcept {
  Reading<double> output;
  if (!value) return output;
  if (value->type != type) { output.status = Availability::invalid; return output; }
  double raw = 0;
  if (type == SCS_VALUE_TYPE_float) raw = value->value_float.value;
  else if (type == SCS_VALUE_TYPE_s32) raw = value->value_s32.value;
  else if (type == SCS_VALUE_TYPE_u32) raw = value->value_u32.value;
  output.value = raw * multiplier;
  output.status = std::isfinite(output.value) && output.value >= minimum && output.value <= maximum ? Availability::available : Availability::invalid;
  if (output.status != Availability::available) output.value = 0;
  return output;
}
void identifier(Identifier& target, const scs_value_t& input) noexcept {
  target = {};
  if (input.type != SCS_VALUE_TYPE_string) { target.status = Availability::invalid; return; }
  target.assign(input.value_string.value);
  if (target.status == Availability::available && !target.bytes[0]) target.status = Availability::not_observed;
}
}
template<std::size_t N> bool Text<N>::assign(const char* input) noexcept {
  bytes.fill(0); status = Availability::invalid;
  if (!input) return false;
  std::size_t length = 0;
  while (length <= N && input[length]) ++length;
  if (length > N || !unicode(input, length)) return false;
  std::memcpy(bytes.data(), input, length); status = Availability::available; return true;
}
template struct Text<3>;
template struct Text<36>;
template struct Text<128>;
template struct Text<1024>;
const std::array<ChannelSpec, fields>& channel_specs() noexcept { return specs; }
Adapter& adapter() noexcept { static Adapter instance; return instance; }

scs_result_t Adapter::initialize(scs_u32_t version, const scs_telemetry_init_params_t* params) noexcept {
  try {
    if (initialized_) return SCS_RESULT_already_registered;
    if (version != SCS_TELEMETRY_VERSION_1_00 && version != SCS_TELEMETRY_VERSION_1_01) return SCS_RESULT_unsupported;
    if (!params) return SCS_RESULT_invalid_parameter;
    const auto& input = *static_cast<const scs_telemetry_init_params_v100_t*>(params);
    if (!input.register_for_event || !input.unregister_from_event || !input.register_for_channel || !input.unregister_from_channel) return SCS_RESULT_invalid_parameter;
    bool ets2 = equal(input.common.game_id, SCS_GAME_ID_EUT2), ats = equal(input.common.game_id, SCS_GAME_ID_ATS);
    if ((!ets2 && !ats) || SCS_GET_MAJOR_VERSION(input.common.game_version) != 1) return SCS_RESULT_unsupported;
    {
      std::unique_lock<std::mutex> pending_lock(pending_mutex_, std::try_to_lock);
      if (!pending_lock.owns_lock()) return SCS_RESULT_not_now;
      std::unique_lock<std::mutex> lock(publication_mutex_, std::try_to_lock);
      if (!lock.owns_lock()) return SCS_RESULT_not_now;
      published_ = {}; unread_ = false;
      producer_ = {}; consumer_.store(0, std::memory_order_release); discarded_observations_.store(0, std::memory_order_relaxed);
    }
    clock_epoch_ = 0; observed_in_frame_.fill(false); in_frame_ = false;
    producer_.identity.game_id.assign(input.common.game_id); producer_.identity.game.assign(ets2 ? "ets2" : "ats");
    producer_.identity.api_version = version; producer_.identity.game_telemetry_version = input.common.game_version;
    producer_.identity.process_id = GetCurrentProcessId();
    DWORD windows_session = 0;
    if (!ProcessIdToSessionId(producer_.identity.process_id, &windows_session)) return SCS_RESULT_generic_error;
    producer_.identity.windows_session_id = windows_session;
    // Deterministic process lifetime UUID: creation FILETIME + PID. It is an identity discriminator, not a secret.
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return SCS_RESULT_generic_error;
    auto& process_instance = producer_.identity.process_instance_id;
    process_instance.assign("00000000-0000-4000-8000-000000000000");
    const std::uint64_t creation_time = (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    constexpr char hex[] = "0123456789abcdef";
    // Preserve every FILETIME/PID bit in 24 non-version/variant digits.
    constexpr std::array<unsigned, 24> positions{{0,1,2,3,4,5,6,7,9,10,11,12,15,16,17,20,21,22,24,25,26,27,28,29}};
    for (unsigned i = 0; i < 16; ++i) process_instance.bytes[positions[i]] = hex[(creation_time >> ((15 - i) * 4)) & 15];
    for (unsigned i = 0; i < 8; ++i) process_instance.bytes[positions[16 + i]] = hex[(producer_.identity.process_id >> ((7 - i) * 4)) & 15];
    if (!uuid(producer_.identity.plugin_session_id) || !uuid(producer_.identity.capture_clock_id) || !uuid(producer_.state.game_clock_id)) return SCS_RESULT_generic_error;
    for (unsigned i = 24; i < 36; ++i) producer_.state.game_clock_id.bytes[i] = '0';
    LARGE_INTEGER frequency{}, origin{};
    if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&origin) || frequency.QuadPart <= 0) return SCS_RESULT_generic_error;
    monotonic_origin_ = origin.QuadPart; monotonic_frequency_ = frequency.QuadPart;
    producer_.identity.currency.assign(ets2 ? "EUR" : "USD");
    producer_.identity.currency_source.assign(ets2 ? "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units" : "scs-sdk-1.15/include/amtrucks/scssdk_telemetry_ats.h#game-specific-units");
    producer_.state.simulation = Simulation::paused; producer_.active = true; source_live_.store(true, std::memory_order_release);
    api_ = input; initialized_ = true;
    for (scs_event_t event_id = SCS_TELEMETRY_EVENT_frame_start; event_id <= SCS_TELEMETRY_EVENT_configuration; ++event_id) {
      const auto result = api_.register_for_event(event_id, event_callback, this);
      if (result != SCS_RESULT_ok) { cleanup(); return result; }
      registered_events_[event_id] = true;
    }
    if (version == SCS_TELEMETRY_VERSION_1_01) {
      producer_.gameplay_result = api_.register_for_event(SCS_TELEMETRY_EVENT_gameplay, event_callback, this);
      registered_events_[SCS_TELEMETRY_EVENT_gameplay] = producer_.gameplay_result == SCS_RESULT_ok;
      if (producer_.gameplay_result != SCS_RESULT_ok && producer_.gameplay_result != SCS_RESULT_unsupported && producer_.gameplay_result != SCS_RESULT_not_found) { const auto result = producer_.gameplay_result; cleanup(); return result; }
    }
    for (std::size_t i = 0; i < fields; ++i) {
      contexts_[i] = {this, static_cast<Field>(i)};
      const auto& spec = specs[i];
      const auto result = api_.register_for_channel(spec.name, SCS_U32_NIL, spec.type, SCS_TELEMETRY_CHANNEL_FLAG_each_frame | SCS_TELEMETRY_CHANNEL_FLAG_no_value, channel_callback, &contexts_[i]);
      producer_.channel_results[i] = result; registered_channels_[i] = result == SCS_RESULT_ok;
      if (result == SCS_RESULT_not_found || result == SCS_RESULT_unsupported_type || result == SCS_RESULT_unsupported) {
        if (i == static_cast<std::size_t>(Field::world_placement)) producer_.state.world_placement.status = Availability::not_supported;
        else producer_.state.channels[i].status = Availability::not_supported;
      }
      else if (result != SCS_RESULT_ok) { cleanup(); return result; }
    }
    producer_.state.game_time_minutes.status = producer_.state.channels[static_cast<std::size_t>(Field::game_time)].status;
    publish(); return SCS_RESULT_ok;
  } catch (...) { failure(); cleanup(); return SCS_RESULT_generic_error; }
}
void Adapter::cleanup() noexcept {
  // Each unregister is isolated: one throwing host/test callback must not skip remaining cleanup.
  for (std::size_t i = 0; i < fields; ++i) if (registered_channels_[i]) {
    registered_channels_[i] = false;
    try { api_.unregister_from_channel(specs[i].name, SCS_U32_NIL, specs[i].type); } catch (...) { failure(); }
  }
  for (scs_event_t i = 1; i < registered_events_.size(); ++i) if (registered_events_[i]) {
    registered_events_[i] = false;
    try { api_.unregister_from_event(i); } catch (...) { failure(); }
  }
  initialized_ = false; api_ = {}; observed_in_frame_.fill(false); in_frame_ = false; producer_.active = false; source_live_.store(false, std::memory_order_release); producer_.state.simulation = Simulation::unavailable;
  increment(producer_.continuity.lost_observations); // Shutdown boundary itself is not durable evidence.
  consumer_.store(0, std::memory_order_release); gate_diagnostics();
  publish();
}
void Adapter::shutdown() noexcept { try { if (initialized_) cleanup(); } catch (...) { failure(); } }
void Adapter::failure() noexcept { increment(producer_.continuity.callback_failures); increment(producer_.continuity.lost_observations); }
bool Adapter::next_order() noexcept {
  gate_diagnostics();
  if (producer_.boundary_order == UINT64_MAX) { producer_.exhausted = true; producer_.active = false; source_live_.store(false, std::memory_order_release); return false; }
  ++producer_.boundary_order; return true;
}
void Adapter::clock_restart() noexcept {
  if (clock_epoch_ == 0xffffffffffffULL) { producer_.exhausted = true; producer_.active = false; source_live_.store(false, std::memory_order_release); return; }
  ++clock_epoch_;
  constexpr char hex[] = "0123456789abcdef";
  for (unsigned i = 0; i < 12; ++i) producer_.state.game_clock_id.bytes[35 - i] = hex[(clock_epoch_ >> (i * 4)) & 15];
  const auto game_time = static_cast<std::size_t>(Field::game_time);
  const auto placement = static_cast<std::size_t>(Field::world_placement);
  if (!(in_frame_ && observed_in_frame_[game_time])) {
    producer_.state.game_time_minutes = {};
    if (!registered_channels_[game_time]) producer_.state.game_time_minutes.status = Availability::not_supported;
  }
  if (!(in_frame_ && observed_in_frame_[placement])) {
    producer_.state.world_placement = {};
    if (!registered_channels_[placement]) producer_.state.world_placement.status = Availability::not_supported;
  }
  // Channel order is unspecified: retain observations from this actual frame,
  // while invalidating only prior cache values from an ambiguous continuation.
  for (std::size_t i = 0; i < producer_.state.channels.size(); ++i) if (registered_channels_[i] && !(in_frame_ && observed_in_frame_[i])) producer_.state.channels[i] = {};
}
bool Adapter::diagnostics_enabled() const noexcept { return consumer_.load(std::memory_order_acquire) == 3; }
void Adapter::gate_diagnostics() noexcept {
  try {
    std::unique_lock<std::mutex> lock(pending_mutex_, std::try_to_lock);
    if (lock.owns_lock() && !diagnostics_enabled() && producer_.observation_count) {
      add(producer_.continuity.lost_observations, producer_.observation_count);
      producer_.observations = {}; producer_.observation_count = 0;
    }
  } catch (...) { failure(); }
}
void Adapter::observe(ObservationKind kind, const char* group, const char* name, scs_u32_t index, const scs_value_t* value) {
  std::unique_lock<std::mutex> lock(pending_mutex_, std::try_to_lock);
  if (!lock.owns_lock() || !diagnostics_enabled() || producer_.observation_count == max_observations) { increment(producer_.continuity.lost_observations); return; }
  auto& output = producer_.observations[producer_.observation_count++];
  output = {}; output.kind = kind; output.group.assign(group); output.name.assign(name); output.index = index; output.callback_order = producer_.boundary_order; output.value = scalar(value);
  if (output.group.status != Availability::available || output.name.status != Availability::available) output.value.status = Availability::invalid;
}
void Adapter::copy_attributes(ObservationKind kind, const char* group, const scs_named_value_t* attributes) {
  // Empty event marker preserves the distinction between no event and an event with no attributes.
  observe(kind, group, "$event", SCS_U32_NIL, nullptr);
  if (!attributes) { failure(); return; }
  for (std::size_t i = 0; i < max_attributes; ++i) {
    if (!attributes[i].name) return;
    observe(kind, group, attributes[i].name, attributes[i].index, &attributes[i].value);
  }
  increment(producer_.continuity.lost_observations); // Unknown tail, a lower bound rather than an invented length.
}
void Adapter::configuration(const scs_telemetry_configuration_t& config) {
  if (!config.attributes) { failure(); return; }
  const bool truck = equal(config.id, SCS_TELEMETRY_CONFIG_truck), job = equal(config.id, SCS_TELEMETRY_CONFIG_job);
  if (truck || job) {
    if (producer_.state.configuration_revision == UINT64_MAX) { producer_.exhausted = true; producer_.active = false; source_live_.store(false, std::memory_order_release); return; }
    ++producer_.state.configuration_revision;
    if (truck) {
      producer_.state.truck_id = {}; producer_.state.fuel_capacity_l = {};
      // A model ID is not a truck instance ID. Always invalidate dynamic truck data on this boundary.
      for (std::size_t i = 0; i < producer_.state.channels.size(); ++i) if (i != static_cast<std::size_t>(Field::game_time) && registered_channels_[i]) producer_.state.channels[i] = {};
      producer_.state.world_placement = {};
      if (!registered_channels_[static_cast<std::size_t>(Field::world_placement)]) producer_.state.world_placement.status = Availability::not_supported;
    }
    if (job) { producer_.state.job = {}; if (config.attributes[0].name) producer_.state.job.status = Availability::available; }
    bool terminated = false;
    for (std::size_t i = 0; i < max_attributes; ++i) {
      const auto& attribute = config.attributes[i];
      if (!attribute.name) { terminated = true; break; }
      if (attribute.index != SCS_U32_NIL) continue;
      const auto& value = attribute.value;
      if (truck && equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_id)) identifier(producer_.state.truck_id, value);
      if (truck && equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity)) producer_.state.fuel_capacity_l = measurement(&value, SCS_VALUE_TYPE_float, 1, 0, 1000000);
      auto& current = producer_.state.job;
      if (job) {
        if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_id)) identifier(current.cargo_id, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city_id)) identifier(current.destination_city_id, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city_id)) identifier(current.source_city_id, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company_id)) identifier(current.destination_company_id, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company_id)) identifier(current.source_company_id, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_job_market)) identifier(current.market, value);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_planned_distance_km)) current.planned_distance_m = measurement(&value, SCS_VALUE_TYPE_u32, 1000, 0, 1e12);
        else if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income)) { current.expected_income.status = value.type == SCS_VALUE_TYPE_u64 ? Availability::available : Availability::invalid; if (current.expected_income.status == Availability::available) current.expected_income.value = value.value_u64.value; }
      }
    }
    if (!terminated) { failure(); if (job) { producer_.state.job = {}; producer_.state.job.status = Availability::invalid; } if (truck) { producer_.state.truck_id = {}; producer_.state.truck_id.status = Availability::invalid; producer_.state.fuel_capacity_l = {}; producer_.state.fuel_capacity_l.status = Availability::invalid; } }
  }
  if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
  copy_attributes(ObservationKind::configuration, config.id, config.attributes);
}
void Adapter::event(scs_event_t event_id, const void* info) {
  if (!initialized_ || producer_.exhausted || !next_order()) return;
  switch (event_id) {
    case SCS_TELEMETRY_EVENT_configuration:
      if (info) configuration(*static_cast<const scs_telemetry_configuration_t*>(info)); else failure(); break;
    case SCS_TELEMETRY_EVENT_gameplay:
      if (info) { const auto& event_info = *static_cast<const scs_telemetry_gameplay_event_t*>(info); copy_attributes(ObservationKind::gameplay, event_info.id, event_info.attributes); } else failure(); break;
    case SCS_TELEMETRY_EVENT_started: case SCS_TELEMETRY_EVENT_paused:
      producer_.state.simulation = event_id == SCS_TELEMETRY_EVENT_started ? Simulation::running : Simulation::paused;
      if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
      observe(ObservationKind::lifecycle, "simulation", event_id == SCS_TELEMETRY_EVENT_started ? "started" : "paused", SCS_U32_NIL, nullptr); break;
    case SCS_TELEMETRY_EVENT_frame_start:
      observed_in_frame_.fill(false); in_frame_ = false;
      if (info) {
        in_frame_ = true;
        const auto& frame = *static_cast<const scs_telemetry_frame_start_t*>(info);
        if ((frame.flags & SCS_TELEMETRY_FRAME_START_FLAG_timer_restart) || (producer_.state.frame_available && (frame.render_time < producer_.state.frame.render_time || frame.simulation_time < producer_.state.frame.simulation_time || frame.paused_simulation_time < producer_.state.frame.paused_simulation_time))) {
          clock_restart(); observe(ObservationKind::lifecycle, "timers", "restart", SCS_U32_NIL, nullptr);
          if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
        }
        producer_.state.frame = frame; producer_.state.frame_available = true;
      } else failure(); break;
    case SCS_TELEMETRY_EVENT_frame_end:
      publish(); observed_in_frame_.fill(false); in_frame_ = false; break;
    default: failure(); break;
  }
}
void Adapter::channel(Field field, const scs_value_t* value) {
  if (!initialized_ || producer_.exhausted || !next_order()) return;
  const auto i = static_cast<std::size_t>(field); const auto& spec = specs[i];
  if (field == Field::world_placement) {
    producer_.state.world_placement = {};
    const auto copied = scalar(value);
    producer_.state.world_placement.status = value && value->type != SCS_VALUE_TYPE_dplacement ? Availability::invalid : copied.status;
    if (producer_.state.world_placement.status == Availability::available) producer_.state.world_placement.value = copied.placement;
  } else producer_.state.channels[i] = measurement(value, spec.type, spec.multiplier, spec.minimum, spec.maximum);
  if (in_frame_) observed_in_frame_[i] = true;
  if (field == Field::game_time) {
    if (value && value->type == SCS_VALUE_TYPE_u32 && producer_.state.game_time_minutes.status == Availability::available && value->value_u32.value < producer_.state.game_time_minutes.value) {
      clock_restart(); observe(ObservationKind::lifecycle, "game.time", "regression", SCS_U32_NIL, nullptr);
      if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
      producer_.state.channels[i] = measurement(value, spec.type, spec.multiplier, spec.minimum, spec.maximum);
    }
    producer_.state.game_time_minutes = {};
    producer_.state.game_time_minutes.status = producer_.state.channels[i].status;
    if (value && producer_.state.game_time_minutes.status == Availability::available) producer_.state.game_time_minutes.value = value->value_u32.value;
  }
  observe(ObservationKind::channel, "channel", spec.name, SCS_U32_NIL, value);
}
SCSAPI_VOID Adapter::event_callback(scs_event_t event_id, const void* info, scs_context_t context) {
  auto* owner = static_cast<Adapter*>(context); if (!owner) return;
  try { owner->event(event_id, info); } catch (...) { owner->failure(); }
}
SCSAPI_VOID Adapter::channel_callback(scs_string_t, scs_u32_t, const scs_value_t* value, scs_context_t context) {
  auto* registered = static_cast<Context*>(context); if (!registered || !registered->owner) return;
  try { registered->owner->channel(registered->field, value); } catch (...) { registered->owner->failure(); }
}
void Adapter::publish() noexcept {
  try {
    gate_diagnostics();
    add(producer_.continuity.lost_observations, discarded_observations_.exchange(0, std::memory_order_relaxed));
    LARGE_INTEGER now{};
    if (QueryPerformanceCounter(&now) && monotonic_frequency_ > 0) {
      const long double elapsed = static_cast<long double>(now.QuadPart - monotonic_origin_) * 1e9L / static_cast<long double>(monotonic_frequency_);
      if (elapsed >= 0 && elapsed < static_cast<long double>(UINT64_MAX)) producer_.capture_monotonic_ns = static_cast<std::uint64_t>(elapsed);
      else { producer_.exhausted = true; producer_.active = false; source_live_.store(false, std::memory_order_release); }
    }
    // Disconnect may synchronously erase the pending batch. Neither lock blocks the SDK thread.
    std::unique_lock<std::mutex> pending_lock(pending_mutex_, std::try_to_lock);
    if (!pending_lock.owns_lock()) { increment(producer_.continuity.coalesced_snapshots); return; }
    std::unique_lock<std::mutex> lock(publication_mutex_, std::try_to_lock);
    if (!lock.owns_lock()) {
      increment(producer_.continuity.coalesced_snapshots);
      for (std::size_t i = 0; i < producer_.observation_count; ++i) increment(producer_.continuity.lost_observations);
    } else {
      if (unread_) { increment(producer_.continuity.coalesced_snapshots); for (std::size_t i = 0; i < published_.observation_count; ++i) increment(producer_.continuity.lost_observations); }
      published_ = producer_; unread_ = true;
    }
    // Payloads belong to this single publication boundary; never accumulate multiple frames.
    producer_.observations = {}; producer_.observation_count = 0;
  } catch (...) { failure(); }
}
void Adapter::set_consumer(bool connected, bool diagnostics) noexcept {
  consumer_.store(connected ? (diagnostics ? 3U : 1U) : 0U, std::memory_order_release);
  if (!connected || !diagnostics) {
    try {
      std::scoped_lock lock(publication_mutex_, pending_mutex_);
      // Producer incorporates this cross-thread discard at its next coherent boundary.
      add(discarded_observations_, published_.observation_count);
      published_.observations = {};
      published_.observation_count = 0;
      add(discarded_observations_, producer_.observation_count);
      producer_.observations = {}; producer_.observation_count = 0;
    } catch (...) { /* No exception crosses the transport boundary. Producer counters remain authoritative. */ }
  }
}
bool Adapter::read_latest(Snapshot& output) noexcept {
  try {
    std::lock_guard<std::mutex> lock(publication_mutex_);
    if (!unread_) return false;
    output = published_; output.source_retired = !source_live_.load(std::memory_order_acquire); unread_ = false;
    published_.observations = {}; published_.observation_count = 0;
    if (!diagnostics_enabled()) { add(discarded_observations_, output.observation_count); output.observations = {}; output.observation_count = 0; }
    return true;
  } catch (...) { return false; }
}
bool Adapter::read_current(Snapshot& output) noexcept {
  try {
    std::lock_guard<std::mutex> lock(publication_mutex_);
    if (published_.identity.plugin_session_id.status != Availability::available) return false;
    output = published_; output.source_retired = !source_live_.load(std::memory_order_acquire);
    output.observations = {}; output.observation_count = 0;
    return true;
  } catch (...) { return false; }
}
} // namespace ets2telemetry::sdk
