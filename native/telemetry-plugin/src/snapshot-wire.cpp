#include "snapshot-wire.hpp"
#include "protocol-json.hpp"
#include <set>
#include <cstring>

namespace ets2telemetry::transport {
namespace {
using J = v0::Json;
J object(std::initializer_list<std::pair<const std::string, J>> fields) { return J{J::Object(fields)}; }
J text(const char* s) { return J{std::string(s)}; }
J integer(std::uint64_t v) { return J{std::to_string(v)}; }
const char* reason(sdk::Availability a) {
  switch (a) { case sdk::Availability::not_supported: return "not-supported";
    case sdk::Availability::invalid: return "invalid"; default: return "not-observed"; }
}
J available(sdk::Availability a, J value) {
  if (a == sdk::Availability::available) return object({{"available", J{true}}, {"value", std::move(value)}});
  return object({{"available", J{false}}, {"reason", text(reason(a))}});
}
J measure(const sdk::Reading<double>& r, const char* unit) {
  auto j = available(r.status, J{r.value}); std::get<J::Object>(j.value).emplace("unit", text(unit)); return j;
}
J continuity(v0::Continuity c) {
  return object({{"coalescedSnapshots", integer(c.coalesced_snapshots)}, {"lostObservations", integer(c.lost_observations)}, {"offlineTransitions", integer(c.offline_transitions)}});
}
J state(const sdk::Snapshot& s, const window::Snapshot* w, std::uint64_t creation, std::uint64_t now) {
  const auto& st = s.state;
  auto channel = [&](sdk::Field f, const char* unit) { return measure(st.channels[static_cast<std::size_t>(f)], unit); };
  auto gt = available(st.game_time_minutes.status, integer(st.game_time_minutes.value));
  auto& gto = std::get<J::Object>(gt.value); gto.emplace("unit", text("min")); gto.emplace("clockId", text(st.game_clock_id.c_str()));
  const auto& job = st.job;
  J currency = object({{"status", text("unknown")}});
  if (s.identity.currency.status == sdk::Availability::available && s.identity.currency_source.status == sdk::Availability::available)
    currency = object({{"status", text("verified")}, {"code", text(s.identity.currency.c_str())}, {"source", text(s.identity.currency_source.c_str())}});
  auto job_status = job.status;
  // V0 Job requires all four values; a partial configuration cannot be invented.
  if (job_status == sdk::Availability::available && (job.cargo_id.status != sdk::Availability::available || job.destination_city_id.status != sdk::Availability::available || job.expected_income.status != sdk::Availability::available)) job_status = sdk::Availability::not_observed;
  if (job.status == sdk::Availability::available && (job.cargo_id.status == sdk::Availability::invalid || job.destination_city_id.status == sdk::Availability::invalid || job.expected_income.status == sdk::Availability::invalid)) job_status = sdk::Availability::invalid;
  J job_value = object({{"cargoId", text(job.cargo_id.c_str())}, {"destinationCityId", text(job.destination_city_id.c_str())},
    {"plannedDistance", measure(job.planned_distance_m, "m")}, {"expectedIncome", object({{"rawValue", integer(job.expected_income.value)}, {"currency", currency}})}});
  const auto mapped = current_window(s, w, creation, now);
  J window_value{nullptr};
  if (mapped.value) {
    const auto& v = *mapped.value;
    window_value = object({{"handle", integer(v.handle)}, {"x", J{static_cast<double>(v.x)}}, {"y", J{static_cast<double>(v.y)}},
      {"width", J{static_cast<double>(v.width)}}, {"height", J{static_cast<double>(v.height)}}, {"dpi", J{static_cast<double>(v.dpi)}},
      {"foreground", J{v.foreground}}, {"minimized", J{v.minimized}}, {"displayMode", text("unknown")}});
  }
  return object({{"simulation", text(st.simulation == sdk::Simulation::running ? "running" : st.simulation == sdk::Simulation::paused ? "paused" : "unavailable")},
    {"speed", channel(sdk::Field::speed, "m/s")}, {"fuel", channel(sdk::Field::fuel, "L")}, {"fuelCapacity", measure(st.fuel_capacity_l, "L")},
    {"engineRpm", channel(sdk::Field::rpm, "rpm")}, {"gear", channel(sdk::Field::gear, "index")}, {"odometer", channel(sdk::Field::odometer, "m")},
    {"averageConsumption", channel(sdk::Field::consumption, "L/100km")}, {"estimatedRange", channel(sdk::Field::range, "m")}, {"gameTime", gt},
    {"captureUtcUnixMs", available(sdk::Availability::not_supported, integer(0))},
    {"configuration", object({{"revision", integer(st.configuration_revision)}, {"truckId", available(st.truck_id.status, text(st.truck_id.c_str()))}, {"job", available(job_status, job_value)}})},
    {"window", available(mapped.value ? sdk::Availability::available : !w ? sdk::Availability::not_supported : sdk::Availability::not_observed, window_value)}});
}
J envelope(const sdk::Snapshot& s, const char* kind, std::uint64_t seq, J data) {
  return object({{"version", object({{"major", J{0.0}}, {"minor", J{0.0}}})}, {"kind", text(kind)},
    {"source", object({{"game", text(s.identity.game.c_str())}, {"pluginSessionId", text(s.identity.plugin_session_id.c_str())}, {"processInstanceId", text(s.identity.process_instance_id.c_str())},
      {"processId", J{static_cast<double>(s.identity.process_id)}}, {"windowsSessionId", J{static_cast<double>(s.identity.windows_session_id)}}, {"origin", text("game")}})},
    {"seq", integer(seq)}, {"capture", object({{"clockId", text(s.identity.capture_clock_id.c_str())}, {"monotonicNs", integer(s.capture_monotonic_ns)}})}, {"data", std::move(data)}});
}
v0::Message checked(J wire) { return v0::decode_payload(v0::detail::serialize(wire)); }
}
v0::Available<v0::GameWindow> current_window(const sdk::Snapshot& s, const window::Snapshot* w, std::uint64_t creation, std::uint64_t now) {
  if (!w) return {{}, v0::AvailabilityReason::not_supported};
  if (!s.active || s.source_retired || s.exhausted || w->status != window::Status::available || !w->per_monitor_v2 ||
      !w->visible || w->minimized || !w->client_bounds_available || !w->handle || !w->dpi || !w->client.width || !w->client.height ||
      !creation || w->process_creation_time != creation || w->process_id != s.identity.process_id ||
      w->windows_session_id != s.identity.windows_session_id ||
      w->plugin_session_id != s.identity.plugin_session_id.bytes || now < w->capture_monotonic_ms || now - w->capture_monotonic_ms > 250)
    return {{}, v0::AvailabilityReason::not_observed};
  return {v0::GameWindow{w->handle,w->client.x,w->client.y,w->client.width,w->client.height,w->dpi,w->foreground,w->minimized,"unknown"}, v0::AvailabilityReason::not_observed};
}
v0::Message current_message(const sdk::Snapshot& s, const char* kind, std::uint64_t seq, v0::Continuity c, bool diagnostics,
                            const window::Snapshot* w, std::uint64_t creation, std::uint64_t now) {
  J data;
  if (std::string(kind) == "welcome") data = object({{"diagnostics", J{diagnostics}}, {"durableRecording", J{false}}});
  else { data = object({{"state", state(s,w,creation,now)}, {"continuity", continuity(c)}}); if (std::string(kind) == "checkpoint") std::get<J::Object>(data.value).emplace("boundarySeq", integer(seq)); }
  return checked(envelope(s, kind, seq, std::move(data)));
}
v0::Message diagnostic_message(const sdk::Snapshot& s, std::uint64_t seq, v0::Continuity& c, std::uint64_t& omitted) {
  J::Array observations; std::set<std::string> names;
  for (std::size_t i = 0; i < s.observation_count; ++i) {
    const auto& o = s.observations[i]; const auto& v = o.value; const char* type = nullptr; J value{nullptr};
    switch (v.type) {
      case SCS_VALUE_TYPE_bool: type = "bool"; value = J{v.boolean}; break;
      case SCS_VALUE_TYPE_s32: type = "s32"; value = J{static_cast<double>(v.signed_integer)}; break;
      case SCS_VALUE_TYPE_u32: type = "u32"; value = J{static_cast<double>(v.unsigned_integer)}; break;
      case SCS_VALUE_TYPE_u64: type = "u64"; value = integer(v.unsigned_integer); break;
      case SCS_VALUE_TYPE_float: type = "float"; value = J{v.number}; break;
      case SCS_VALUE_TYPE_double: type = "double"; value = J{v.number}; break;
      case SCS_VALUE_TYPE_string: type = "string"; value = text(v.string.c_str()); break;
      default: break;
    }
    // CAP-01 owns richer configuration/gameplay evidence. Never label placement/s64 as scalars.
    std::string name = o.name.c_str();
    if (!type || o.kind != sdk::ObservationKind::channel || o.name.status != sdk::Availability::available || name.empty() || !names.emplace(name).second) { if (omitted != UINT64_MAX) ++omitted; continue; }
    observations.push_back(object({{"channel", J{name}}, {"sdkType", text(type)}, {"value", available(v.status, value)}, {"unit", text("raw")}}));
  }
  c.lost_observations = c.lost_observations > UINT64_MAX - omitted ? UINT64_MAX : c.lost_observations + omitted;
  return checked(envelope(s, "diagnostic", seq, object({{"copied", J{true}}, {"observations", J{observations}}, {"continuity", continuity(c)}})));
}
}
