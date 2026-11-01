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
#include "common/scssdk_telemetry_common_gameplay_events.h"
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
  // ET-052: signed in-game minutes until the next mandatory break; negative is overdue and zero is a value. The bounds are
  // the s32 range, which a double holds exactly.
  {SCS_TELEMETRY_CHANNEL_next_mandatory_break, SCS_VALUE_TYPE_s32, "min", 1, -2147483648.0, 2147483647.0},
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

// Protocol v1 copies (ET-004b). Values stay in SDK units; the v1 encoder applies the §6 mapping, the defensive ranges
// and the D12 text rules. Field<T> is always returned as a prvalue (see available_field in protocol-v1-records.hpp).
v1::FieldState v1_state(Availability status) noexcept {
  switch (status) {
    case Availability::available: return v1::FieldState::available;
    case Availability::not_supported: return v1::FieldState::not_supported;
    case Availability::invalid: return v1::FieldState::invalid;
    default: return v1::FieldState::not_observed;
  }
}
v1::SimulationState v1_simulation(Simulation simulation) noexcept {
  return simulation == Simulation::running ? v1::SimulationState::running : simulation == Simulation::paused ? v1::SimulationState::paused : v1::SimulationState::unavailable;
}
// v0 readings hold an SDK float or integer scaled by 1, 100 or 1,000. A float times such a factor is exact in double,
// so the division restores the SDK value exactly; the v1 encoder applies the same factor again.
v1::Field<double> v1_reading(const Reading<double>& reading, double multiplier) noexcept {
  return reading.status == Availability::available ? v1::Field<double>{reading.value / multiplier, v1::FieldState::available} : v1::Field<double>{0, v1_state(reading.status)};
}
// ET-052 minor 2: the break channel is an s32 held exactly in the double reading (multiplier 1, range checked against the
// s32 bounds), so the v1 copy converts it back to the integer without the multiplier path.
v1::Field<std::int32_t> v1_reading_s32(const Reading<double>& reading) noexcept {
  return reading.status == Availability::available ? v1::Field<std::int32_t>{static_cast<std::int32_t>(reading.value), v1::FieldState::available} : v1::Field<std::int32_t>{0, v1_state(reading.status)};
}
// UTC label (OD-5 S8): unsigned Unix milliseconds from the system clock, which may jump.
v1::Field<std::uint64_t> utc_unix_ms() noexcept {
  FILETIME now{}; GetSystemTimePreciseAsFileTime(&now);
  const std::uint64_t ticks = (static_cast<std::uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
  constexpr std::uint64_t unix_epoch_ticks = 116444736000000000ULL;
  return ticks >= unix_epoch_ticks ? v1::Field<std::uint64_t>{(ticks - unix_epoch_ticks) / 10000, v1::FieldState::available} : v1::Field<std::uint64_t>{};
}
// A sent attribute with an unusable type or value is invalid; only an attribute the game did not send stays
// not-observed. A provided empty string stays available (D12), unlike the v0 identifier rule.
template<std::size_t N> void v1_value(v1::FixedText<N>& output, const scs_value_t& input) noexcept {
  if (input.type == SCS_VALUE_TYPE_string && input.value_string.value) output.assign(input.value_string.value);
  else { output = {}; output.state = v1::FieldState::invalid; }
}
// The union member is read only when the SDK type matches the documented attribute type.
template<class T> v1::Field<T> v1_invalid() noexcept { return v1::Field<T>{T{}, v1::FieldState::invalid}; }
template<class T> v1::Field<T> v1_available(T value) noexcept { return v1::Field<T>{value, v1::FieldState::available}; }
void v1_value(v1::Field<double>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_float ? v1_available<double>(input.value_float.value) : v1_invalid<double>(); }
void v1_value(v1::Field<float>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_float ? v1_available<float>(input.value_float.value) : v1_invalid<float>(); }
void v1_value(v1::Field<bool>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_bool ? v1_available<bool>(input.value_bool.value != 0) : v1_invalid<bool>(); }
void v1_value(v1::Field<std::int32_t>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_s32 ? v1_available<std::int32_t>(input.value_s32.value) : v1_invalid<std::int32_t>(); }
void v1_value(v1::Field<std::uint32_t>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_u32 ? v1_available<std::uint32_t>(input.value_u32.value) : v1_invalid<std::uint32_t>(); }
void v1_value(v1::Field<std::int64_t>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_s64 ? v1_available<std::int64_t>(input.value_s64.value) : v1_invalid<std::int64_t>(); }
void v1_value(v1::Field<std::uint64_t>& output, const scs_value_t& input) noexcept { output = input.type == SCS_VALUE_TYPE_u64 ? v1_available<std::uint64_t>(input.value_u64.value) : v1_invalid<std::uint64_t>(); }
// After a null or unterminated attribute list, a field that was not seen may still have been sent: it is invalid.
template<class T> void v1_unseen(T& field) noexcept { if (field.state == v1::FieldState::not_observed) field.state = v1::FieldState::invalid; }
template<class... F> void v1_unseen_all(F&... fields) noexcept { (v1_unseen(fields), ...); }
// The v0 scan bound: at most max_attributes entries including the terminator. Indexed attributes (wheel arrays) carry
// no v1 field. Returns false for a null or unterminated list.
template<class Apply> bool v1_scan(const scs_named_value_t* attributes, Apply apply) noexcept {
  if (!attributes) return false;
  for (std::size_t i = 0; i < max_attributes; ++i) {
    const auto& attribute = attributes[i];
    if (!attribute.name) return true;
    if (attribute.index == SCS_U32_NIL) apply(attribute.name, attribute.value);
  }
  return false;
}
void v1_job(v1::records::JobConfigured& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city_id)) v1_value(r.source_city_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_city)) v1_value(r.source_city, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company_id)) v1_value(r.source_company_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_source_company)) v1_value(r.source_company, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city_id)) v1_value(r.destination_city_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_city)) v1_value(r.destination_city, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company_id)) v1_value(r.destination_company_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_destination_company)) v1_value(r.destination_company, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_id)) v1_value(r.cargo_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo)) v1_value(r.cargo, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_mass)) v1_value(r.cargo_mass_kg, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_unit_mass)) v1_value(r.cargo_unit_mass_kg, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_unit_count)) v1_value(r.cargo_unit_count, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_job_market)) v1_value(r.market, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_special_job)) v1_value(r.is_special_job, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_is_cargo_loaded)) v1_value(r.cargo_loaded, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_planned_distance_km)) v1_value(r.planned_distance_km, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_income)) v1_value(r.expected_income, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_delivery_time)) v1_value(r.delivery_deadline_min, value);
  });
  if (!terminated) v1_unseen_all(r.source_city_id, r.source_city, r.source_company_id, r.source_company, r.destination_city_id, r.destination_city,
    r.destination_company_id, r.destination_company, r.cargo_id, r.cargo, r.cargo_mass_kg, r.cargo_unit_mass_kg, r.cargo_unit_count, r.market,
    r.is_special_job, r.cargo_loaded, r.planned_distance_km, r.expected_income, r.delivery_deadline_min);
}
void v1_truck(v1::records::TruckConfigured& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand_id)) v1_value(r.brand_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand)) v1_value(r.brand, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_id)) v1_value(r.id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name)) v1_value(r.name, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_fuel_capacity)) v1_value(r.fuel_capacity_l, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate)) v1_value(r.license_plate, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate_country_id)) v1_value(r.plate_country_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate_country)) v1_value(r.plate_country, value);
  });
  if (!terminated) v1_unseen_all(r.brand_id, r.brand, r.id, r.name, r.fuel_capacity_l, r.license_plate, r.plate_country_id, r.plate_country);
}
// Minor-1 gear counts (ET-050b B2): the truck configuration's u32 `gears.forward` and `gears.reverse`, for the undamaged
// truck. They stay outside the truck record, so truck.configured events and minor-0 bytes are unchanged.
void v1_gear_counts(v1::GearboxPod& g, const scs_named_value_t* attributes) noexcept {
  g.forward_gears = {}; g.reverse_gears = {};
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_forward_gear_count)) v1_value(g.forward_gears, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_reverse_gear_count)) v1_value(g.reverse_gears, value);
  });
  if (!terminated) v1_unseen_all(g.forward_gears, g.reverse_gears);
}
// One bounded pass over an `hshifter` configuration (ET-050b B2): `selector.count` (the CAP-01 captures send it twice,
// without and with index 0, and every copy must agree) and the indexed slot.gear (s32), slot.handle.position and
// slot.selectors (u32), copied by SDK slot index. Returns the layout's availability: an empty list is not-observed; a
// null or unterminated list, a type mismatch, a slot attribute without an index or at index 64 or more, a repeated slot
// attribute, disagreeing selector counts or a missing selector count are invalid. Range, completeness and duplicate
// pairs are checked by the encoder; nothing is ever truncated. Other attributes, such as shifter.type, are not copied.
v1::FieldState v1_hshifter(v1::HShifterPod& h, const scs_named_value_t* attributes) noexcept {
  h = {};
  if (!attributes) return v1::FieldState::invalid;
  bool counted = false;
  for (std::size_t i = 0; i < max_attributes; ++i) {
    const auto& attribute = attributes[i];
    if (!attribute.name) return i == 0 ? v1::FieldState::not_observed : counted ? v1::FieldState::available : v1::FieldState::invalid;
    const auto& value = attribute.value;
    if (equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_selector_count)) {
      if (value.type != SCS_VALUE_TYPE_u32 || (counted && value.value_u32.value != h.selector_count)) return v1::FieldState::invalid;
      h.selector_count = value.value_u32.value; counted = true; continue;
    }
    const std::uint8_t bit = equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_slot_gear) ? v1::slot_gear_seen
      : equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_slot_handle_position) ? v1::slot_handle_seen
      : equal(attribute.name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_slot_selectors) ? v1::slot_selectors_seen : 0;
    if (!bit) continue;
    if (attribute.index == SCS_U32_NIL || attribute.index >= h.slots.size()) return v1::FieldState::invalid;
    auto& slot = h.slots[attribute.index];
    if (slot.seen & bit) return v1::FieldState::invalid;
    slot.seen = static_cast<std::uint8_t>(slot.seen | bit);
    if (bit == v1::slot_gear_seen) {
      if (value.type != SCS_VALUE_TYPE_s32) return v1::FieldState::invalid;
      slot.gear = value.value_s32.value;
    } else {
      if (value.type != SCS_VALUE_TYPE_u32) return v1::FieldState::invalid;
      (bit == v1::slot_handle_seen ? slot.handle_position : slot.selectors) = value.value_u32.value;
    }
  }
  return v1::FieldState::invalid;
}
void v1_trailer(v1::records::TrailerConfigured& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_id)) v1_value(r.id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_body_type)) v1_value(r.body_type, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_chain_type)) v1_value(r.chain_type, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_cargo_accessory_id)) v1_value(r.cargo_accessory_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand_id)) v1_value(r.brand_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_brand)) v1_value(r.brand, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_name)) v1_value(r.name, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate)) v1_value(r.license_plate, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate_country_id)) v1_value(r.plate_country_id, value);
    else if (equal(name, SCS_TELEMETRY_CONFIG_ATTRIBUTE_license_plate_country)) v1_value(r.plate_country, value);
  });
  if (!terminated) v1_unseen_all(r.id, r.body_type, r.chain_type, r.cargo_accessory_id, r.brand_id, r.brand, r.name, r.license_plate, r.plate_country_id, r.plate_country);
}
void v1_delivered(v1::records::JobDelivered& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_revenue)) v1_value(r.revenue, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_earned_xp)) v1_value(r.earned_xp, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cargo_damage)) v1_value(r.cargo_damage, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_distance_km)) v1_value(r.distance_km, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_delivery_time)) v1_value(r.delivery_duration_min, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_auto_park_used)) v1_value(r.auto_park_used, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_auto_load_used)) v1_value(r.auto_load_used, value);
  });
  if (!terminated) v1_unseen_all(r.revenue, r.earned_xp, r.cargo_damage, r.distance_km, r.delivery_duration_min, r.auto_park_used, r.auto_load_used);
}
void v1_cancelled(v1::records::JobCancelled& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_cancel_penalty)) v1_value(r.penalty, value);
  });
  if (!terminated) v1_unseen_all(r.penalty);
}
void v1_fined(v1::records::PlayerFined& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_offence)) v1_value(r.offence, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_fine_amount)) v1_value(r.amount, value);
  });
  if (!terminated) v1_unseen_all(r.offence, r.amount);
}
void v1_tollgate(v1::records::PlayerTollgatePaid& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount)) v1_value(r.amount, value);
  });
  if (!terminated) v1_unseen_all(r.amount);
}
void v1_transfer(v1::records::Transfer& r, const scs_named_value_t* attributes) noexcept {
  const bool terminated = v1_scan(attributes, [&](const char* name, const scs_value_t& value) {
    if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_pay_amount)) v1_value(r.amount, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_source_id)) v1_value(r.source_id, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_source_name)) v1_value(r.source_name, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_target_id)) v1_value(r.target_id, value);
    else if (equal(name, SCS_TELEMETRY_GAMEPLAY_EVENT_ATTRIBUTE_target_name)) v1_value(r.target_name, value);
  });
  if (!terminated) v1_unseen_all(r.amount, r.source_id, r.source_name, r.target_id, r.target_name);
}
// Slot of a `trailer.N` configuration, N = 0-9, or -1. The legacy `trailer` id repeats trailer.0 and has no v1 slot.
int trailer_slot(const char* id) noexcept {
  static_assert(v1::limits.trailer_slots == 10, "single-digit trailer configuration ids");
  constexpr char prefix[] = "trailer.";
  // Compares one byte at a time and stops at the first difference, so a short id is never read past its terminator.
  for (std::size_t i = 0; i + 1 < sizeof prefix; ++i) if (id[i] != prefix[i]) return -1;
  return id[8] >= '0' && id[8] <= '9' && !id[9] ? id[8] - '0' : -1;
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
      // All three locks are held before any reset, so `not_now` leaves every slot and the producer state unchanged.
      std::unique_lock<std::mutex> v1_lock(v1_mutex_, std::try_to_lock);
      if (!v1_lock.owns_lock()) return SCS_RESULT_not_now;
      published_ = {}; unread_ = false;
      producer_ = {}; consumer_.store(0, std::memory_order_release); discarded_observations_.store(0, std::memory_order_relaxed);
      // The v1 slot of an earlier plugin session must not outlive it. A channel still attached belongs to that session
      // too: a new session must start at eventSeq 1 (§9), so it is detached and v1 stays inert until the caller prepares
      // a channel and attaches it again.
      v1_published_ = {}; events_.store(nullptr, std::memory_order_release);
    }
    v1_configuration_ = {}; v1_continuity_ = {}; v1_configuration_dirty_ = true; v1_gearbox_ = {}; v1_gearbox_dirty_ = true;
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
    api_ = input; initialized_ = true; for (auto& slot : deferred_logs_) slot.store(nullptr, std::memory_order_relaxed);
    connection_logs_.reset(); connection_log_drop_reported_ = false;
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
      // ET-052: the optional break channel never fails initialization. Any result other than ok means the game does not
      // provide it (an older game, a refused flag or an unknown code), which is not-supported; core channels stay strict.
      const bool optional = static_cast<Field>(i) == Field::mandatory_break;
      if (result == SCS_RESULT_not_found || result == SCS_RESULT_unsupported_type || result == SCS_RESULT_unsupported || (optional && result != SCS_RESULT_ok)) {
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
void Adapter::shutdown() noexcept { try { if (initialized_) { flush_deferred_log(true); cleanup(); } } catch (...) { failure(); } }
void Adapter::flush_deferred_log(bool all) noexcept {
  // SDK calling thread only, during a direct game invocation (frame_end callback or shutdown).
  // Slots are logged in their fixed order; each holds at most one static entry, so nothing allocates here.
  for (auto& slot : deferred_logs_) {
    if (!slot.load(std::memory_order_relaxed)) continue;
    const auto* entry = slot.exchange(nullptr, std::memory_order_acquire);
    // A logger exception loses no telemetry observation, so it is not counted as lost data.
    try { if (entry && api_.common.log) api_.common.log(entry->type, entry->message); } catch (...) { increment(producer_.continuity.callback_failures); }
  }
  ConnectionLogLine line;
  const auto limit = all ? ConnectionLogQueue::capacity : 4;
  for (std::size_t i = 0; i < limit && connection_logs_.pop(line); ++i) {
    try { if (api_.common.log) api_.common.log(SCS_LOG_TYPE_message, line.text.data()); } catch (...) { increment(producer_.continuity.callback_failures); }
  }
  const auto* overflow = connection_logs_.dropped();
  if (!connection_log_drop_reported_ && overflow) {
    connection_log_drop_reported_ = true;
    try { if (api_.common.log) api_.common.log(overflow->type, overflow->message); } catch (...) { increment(producer_.continuity.callback_failures); }
  }
}
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
bool Adapter::source_monotonic_ns(std::uint64_t& output) const noexcept {
  LARGE_INTEGER now{};
  if (!QueryPerformanceCounter(&now) || monotonic_frequency_ <= 0 || now.QuadPart < monotonic_origin_) return false;
  const long double elapsed = static_cast<long double>(now.QuadPart - monotonic_origin_) * 1e9L / static_cast<long double>(monotonic_frequency_);
  if (elapsed >= static_cast<long double>(UINT64_MAX)) return false;
  output = static_cast<std::uint64_t>(elapsed); return true;
}
void Adapter::evidence(cap0::Kind kind, const char* id, const scs_named_value_t* attributes, bool attributes_expected) noexcept {
  // CAP0 copies the same borrowed callback input already inspected above; it makes no SDK call.
  auto* queue = evidence_.load(std::memory_order_acquire);
  if (!queue || !queue->is_open()) return;
  cap0::Context c;
  c.kind = kind; c.id = id; c.attributes = attributes; c.attributes_expected = attributes_expected;
  c.boundary_order = producer_.boundary_order; c.configuration_revision = producer_.state.configuration_revision;
  c.monotonic_available = source_monotonic_ns(c.monotonic_ns);
  c.frame_available = producer_.state.frame_available;
  if (c.frame_available) { c.render_us = producer_.state.frame.render_time; c.simulation_us = producer_.state.frame.simulation_time; c.paused_simulation_us = producer_.state.frame.paused_simulation_time; }
  const auto& game_time = producer_.state.game_time_minutes;
  c.game_time_status = static_cast<cap0::Status>(game_time.status); c.game_time_minutes = game_time.value;
  c.game_clock_id = producer_.state.game_clock_id.c_str();
  c.simulation = producer_.state.simulation == Simulation::running ? cap0::Simulation::running : producer_.state.simulation == Simulation::paused ? cap0::Simulation::paused : cap0::Simulation::unavailable;
  queue->capture(c);
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
      if (info) {
        const auto& config = *static_cast<const scs_telemetry_configuration_t*>(info);
        configuration(config);
        if (!producer_.exhausted) evidence(cap0::Kind::configuration, config.id, config.attributes, true);
        if (!producer_.exhausted) v1_configuration(config);
      } else { failure(); evidence(cap0::Kind::configuration, nullptr, nullptr, true); } break;
    case SCS_TELEMETRY_EVENT_gameplay:
      if (info) { const auto& event_info = *static_cast<const scs_telemetry_gameplay_event_t*>(info); copy_attributes(ObservationKind::gameplay, event_info.id, event_info.attributes); evidence(cap0::Kind::gameplay, event_info.id, event_info.attributes, true); v1_gameplay(event_info); }
      else { failure(); evidence(cap0::Kind::gameplay, nullptr, nullptr, true); } break;
    case SCS_TELEMETRY_EVENT_started: case SCS_TELEMETRY_EVENT_paused:
      producer_.state.simulation = event_id == SCS_TELEMETRY_EVENT_started ? Simulation::running : Simulation::paused;
      if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
      observe(ObservationKind::lifecycle, "simulation", event_id == SCS_TELEMETRY_EVENT_started ? "started" : "paused", SCS_U32_NIL, nullptr);
      evidence(cap0::Kind::lifecycle, event_id == SCS_TELEMETRY_EVENT_started ? "simulation.started" : "simulation.paused", nullptr, false);
      if (events_.load(std::memory_order_acquire)) {
        if (event_id == SCS_TELEMETRY_EVENT_started) v1_record_.record.emplace<v1::records::SimulationStarted>(); else v1_record_.record.emplace<v1::records::SimulationPaused>();
        v1_emit(true);
      } break;
    case SCS_TELEMETRY_EVENT_frame_start:
      observed_in_frame_.fill(false); in_frame_ = false;
      if (info) {
        in_frame_ = true;
        const auto& frame = *static_cast<const scs_telemetry_frame_start_t*>(info);
        if ((frame.flags & SCS_TELEMETRY_FRAME_START_FLAG_timer_restart) || (producer_.state.frame_available && (frame.render_time < producer_.state.frame.render_time || frame.simulation_time < producer_.state.frame.simulation_time || frame.paused_simulation_time < producer_.state.frame.paused_simulation_time))) {
          clock_restart(); observe(ObservationKind::lifecycle, "timers", "restart", SCS_U32_NIL, nullptr);
          if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
          // Record the new frame times with the restart marker; prior values remain in earlier envelopes.
          producer_.state.frame = frame; producer_.state.frame_available = true;
          evidence(cap0::Kind::lifecycle, "timers.restart", nullptr, false);
          if (!producer_.exhausted && events_.load(std::memory_order_acquire)) { v1_record_.record.emplace<v1::records::TimersRestart>(); v1_emit(true); }
        }
        producer_.state.frame = frame; producer_.state.frame_available = true;
      } else failure(); break;
    case SCS_TELEMETRY_EVENT_frame_end:
      // A trailing v1 loss run reaches the worker at least once per frame, even without a later copied record.
      if (auto* channel = events_.load(std::memory_order_acquire)) channel->flush_loss();
      publish(); observed_in_frame_.fill(false); in_frame_ = false; flush_deferred_log(); break;
    default: failure(); break;
  }
}
void Adapter::channel(Field field, const scs_value_t* value) {
  // The break channel (ET-052) is a v1-only extension: it advances no boundary order, so the v0 snapshot, the v0 ordering
  // and the CAP0 envelopes of a game that provides it are identical to those of a game that does not.
  if (!initialized_ || producer_.exhausted || (field != Field::mandatory_break && !next_order())) return;
  const auto i = static_cast<std::size_t>(field); const auto& spec = specs[i];
  if (field == Field::world_placement) {
    producer_.state.world_placement = {};
    const auto copied = scalar(value);
    producer_.state.world_placement.status = value && value->type != SCS_VALUE_TYPE_dplacement ? Availability::invalid : copied.status;
    if (producer_.state.world_placement.status == Availability::available) producer_.state.world_placement.value = copied.placement;
  } else producer_.state.channels[i] = measurement(value, spec.type, spec.multiplier, spec.minimum, spec.maximum);
  if (in_frame_) observed_in_frame_[i] = true;
  // No v0 diagnostic observation either: v0 diagnostic batches and loss counts stay as they were (CAP0 never records channels).
  if (field == Field::mandatory_break) return;
  if (field == Field::game_time) {
    if (value && value->type == SCS_VALUE_TYPE_u32 && producer_.state.game_time_minutes.status == Availability::available && value->value_u32.value < producer_.state.game_time_minutes.value) {
      // v1 gameTime.regression: `from` is the reading and clock before the rotation, `to` the regressed reading after it.
      v1::GameTimePod from; if (events_.load(std::memory_order_acquire)) v1_game_time(from);
      clock_restart(); observe(ObservationKind::lifecycle, "game.time", "regression", SCS_U32_NIL, nullptr);
      if (!(consumer_.load(std::memory_order_acquire) & 1)) increment(producer_.continuity.offline_transitions);
      producer_.state.channels[i] = measurement(value, spec.type, spec.multiplier, spec.minimum, spec.maximum);
      producer_.state.game_time_minutes = {};
      producer_.state.game_time_minutes.status = producer_.state.channels[i].status;
      if (producer_.state.game_time_minutes.status == Availability::available) producer_.state.game_time_minutes.value = value->value_u32.value;
      // The envelope carries the regressed reading under the rotated game clock.
      evidence(cap0::Kind::lifecycle, "game.time.regression", nullptr, false);
      if (!producer_.exhausted && events_.load(std::memory_order_acquire)) {
        auto& regression = v1_record_.record.emplace<v1::records::GameTimeRegression>();
        regression.from = from; v1_game_time(regression.to); v1_emit(true);
      }
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
void Adapter::publish() noexcept { publish_v0(); publish_v1(); }
void Adapter::publish_v0() noexcept {
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
void Adapter::attach_events(v1::EventChannel* channel) noexcept {
  events_.store(channel, std::memory_order_release);
  // The first v1 slot of the session, so that a worker started after attachment can build its checkpoint at once.
  if (channel && initialized_) { v1_configuration_dirty_ = true; v1_gearbox_dirty_ = true; publish_v1(); }
}
bool Adapter::read_v1_current(V1Current& output) noexcept {
  try {
    std::lock_guard<std::mutex> lock(v1_mutex_);
    if (v1_published_.identity.plugin_session_id.status != Availability::available) return false;
    output = v1_published_; output.source_retired = !source_live_.load(std::memory_order_acquire);
    return true;
  } catch (...) { return false; }
}
void Adapter::v1_game_time(v1::GameTimePod& output) const noexcept {
  const auto& minutes = producer_.state.game_time_minutes;
  output.minutes = v1::Field<std::uint32_t>{minutes.status == Availability::available ? minutes.value : 0, v1_state(minutes.status)};
  std::memcpy(output.clock_id.text, producer_.state.game_clock_id.bytes.data(), sizeof output.clock_id.text);
}
void Adapter::v1_emit(bool boundary) noexcept {
  auto* channel = events_.load(std::memory_order_acquire);
  if (!channel) return;
  // The callback moment (§8), after this callback updated the adapter state: the source clock, the game clock, a UTC
  // label, the simulation state, the v1 configuration revision and the shared callback order.
  auto& occurred = v1_record_.occurred;
  std::uint64_t now = 0;
  occurred.monotonic_ns = source_monotonic_ns(now) ? v1::Field<std::uint64_t>{now, v1::FieldState::available} : v1::Field<std::uint64_t>{};
  v1_game_time(occurred.game_time);
  occurred.utc_unix_ms = utc_unix_ms();
  occurred.simulation = v1_simulation(producer_.state.simulation);
  occurred.configuration_revision = v1_configuration_.revision; occurred.boundary_order = producer_.boundary_order;
  // OD-5 S10: a lifecycle or configuration boundary while no v1 client is connected. Gameplay events are counted as loss.
  if (boundary && channel->gate() == v1::Gate::none) increment(v1_continuity_.offline_transitions);
  channel->observe(v1_record_);
}
void Adapter::v1_configuration(const scs_telemetry_configuration_t& config) noexcept {
  if (!events_.load(std::memory_order_acquire) || !config.id) return;
  if (equal(config.id, SCS_TELEMETRY_CONFIG_hshifter)) {
    // B2: the layout sits outside `configuration`. It changes no revision, assigns no eventSeq and emits no event; the
    // copy is bounded and allocation-free, and only the next publication carries it.
    auto& layout = v1_gearbox_.hshifter;
    layout.state = v1_hshifter(layout.value, config.attributes);
    v1_gearbox_dirty_ = true; return;
  }
  const bool job = equal(config.id, SCS_TELEMETRY_CONFIG_job), truck = equal(config.id, SCS_TELEMETRY_CONFIG_truck);
  const int trailer = trailer_slot(config.id);
  // bus_job and car_job have no v1 type (TD-002) and the legacy `trailer` id repeats trailer.0: no record, no eventSeq.
  if (!job && !truck && trailer < 0) return;
  // An empty attribute list clears the configuration. A null list is a present configuration whose fields are unseen.
  const bool cleared = config.attributes && !config.attributes[0].name;
  auto& current = v1_configuration_;
  // D13: a trailer slot emits only when it is non-empty or when a clear follows a non-empty slot.
  if (trailer >= 0 && cleared && !current.trailers[static_cast<std::size_t>(trailer)].available()) return;
  // Separate from the v0 revision. Saturation is unreachable in practice and keeps the revision non-decreasing.
  if (current.revision != UINT64_MAX) ++current.revision;
  auto& body = v1_record_.record;
  if (job && cleared) { body.emplace<v1::records::JobCleared>(); current.job = {}; }
  else if (job) { auto& r = body.emplace<v1::records::JobConfigured>(); v1_job(r, config.attributes); current.job.value = r; current.job.state = v1::FieldState::available; }
  // A truck clear makes the gear counts not-observed and a truck configuration copies them (B2); the layout is unchanged.
  else if (truck && cleared) {
    body.emplace<v1::records::TruckCleared>(); current.truck = {};
    v1_gearbox_.forward_gears = {}; v1_gearbox_.reverse_gears = {}; v1_gearbox_dirty_ = true;
  }
  else if (truck) {
    auto& r = body.emplace<v1::records::TruckConfigured>(); v1_truck(r, config.attributes); current.truck.value = r; current.truck.state = v1::FieldState::available;
    v1_gear_counts(v1_gearbox_, config.attributes); v1_gearbox_dirty_ = true;
  }
  else {
    auto& slot = current.trailers[static_cast<std::size_t>(trailer)];
    if (cleared) { body.emplace<v1::records::TrailerCleared>().index = static_cast<std::uint8_t>(trailer); slot = {}; }
    else {
      auto& r = body.emplace<v1::records::TrailerConfigured>(); r.index = static_cast<std::uint8_t>(trailer);
      v1_trailer(r, config.attributes); slot.value = r; slot.state = v1::FieldState::available;
    }
  }
  v1_configuration_dirty_ = true;
  v1_emit(true);
}
void Adapter::v1_gameplay(const scs_telemetry_gameplay_event_t& event_info) noexcept {
  if (!events_.load(std::memory_order_acquire) || !event_info.id) return;
  auto& body = v1_record_.record; const char* id = event_info.id; const auto* attributes = event_info.attributes;
  if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_job_delivered)) v1_delivered(body.emplace<v1::records::JobDelivered>(), attributes);
  else if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled)) v1_cancelled(body.emplace<v1::records::JobCancelled>(), attributes);
  else if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_fined)) v1_fined(body.emplace<v1::records::PlayerFined>(), attributes);
  else if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_tollgate_paid)) v1_tollgate(body.emplace<v1::records::PlayerTollgatePaid>(), attributes);
  else if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_use_ferry)) v1_transfer(body.emplace<v1::records::PlayerUseFerry>(), attributes);
  else if (equal(id, SCS_TELEMETRY_GAMEPLAY_EVENT_player_use_train)) v1_transfer(body.emplace<v1::records::PlayerUseTrain>(), attributes);
  // car_job.* and unknown gameplay types have no v1 type (TD-002): no record and no eventSeq.
  else return;
  v1_emit(false);
}
void Adapter::publish_v1() noexcept {
  if (!events_.load(std::memory_order_acquire)) return;
  try {
    // A worker copying the slot never stalls the SDK thread: the older slot stays intact and the contention is counted.
    std::unique_lock<std::mutex> lock(v1_mutex_, std::try_to_lock);
    if (!lock.owns_lock()) { increment(v1_continuity_.coalesced_snapshots); return; }
    auto& output = v1_published_; const auto& state = producer_.state;
    output.identity = producer_.identity; output.gameplay_result = producer_.gameplay_result;
    output.active = producer_.active; output.exhausted = producer_.exhausted; output.continuity = v1_continuity_;
    auto& s = output.state;
    const auto sdk_value = [&](Field field) { const auto i = static_cast<std::size_t>(field); return v1_reading(state.channels[i], specs[i].multiplier); };
    s.simulation = v1_simulation(state.simulation);
    s.speed_mps = sdk_value(Field::speed); s.fuel_l = sdk_value(Field::fuel); s.engine_rpm = sdk_value(Field::rpm);
    s.odometer_km = sdk_value(Field::odometer); s.average_consumption_l_per_km = sdk_value(Field::consumption);
    s.estimated_range_km = sdk_value(Field::range); s.navigation_distance_m = sdk_value(Field::navigation_distance);
    s.fuel_capacity_l = v1_reading(state.fuel_capacity_l, 1);
    s.next_mandatory_break_min = v1_reading_s32(state.channels[static_cast<std::size_t>(Field::mandatory_break)]);
    const auto& gear = state.channels[static_cast<std::size_t>(Field::gear)];
    s.gear = gear.status == Availability::available ? v1::Field<std::int32_t>{static_cast<std::int32_t>(gear.value), v1::FieldState::available} : v1::Field<std::int32_t>{0, v1_state(gear.status)};
    v1_game_time(s.game_time); s.capture_utc_unix_ms = utc_unix_ms(); s.boundary_order = producer_.boundary_order;
    const auto& placement = state.world_placement;
    if (placement.status == Availability::available) {
      const auto& p = placement.value;
      s.world_placement = v1::Field<v1::PlacementPod>{v1::PlacementPod{p.position.x, p.position.y, p.position.z, p.orientation.heading, p.orientation.pitch, p.orientation.roll}, v1::FieldState::available};
    } else s.world_placement = v1::Field<v1::PlacementPod>{v1::PlacementPod{}, v1_state(placement.status)};
    // The configuration is copied only after a configuration boundary, not on every frame.
    if (v1_configuration_dirty_) { s.configuration = v1_configuration_; v1_configuration_dirty_ = false; }
    if (v1_gearbox_dirty_) { s.gearbox = v1_gearbox_; v1_gearbox_dirty_ = false; }
  } catch (...) { increment(v1_continuity_.coalesced_snapshots); }
}
} // namespace ets2telemetry::sdk
