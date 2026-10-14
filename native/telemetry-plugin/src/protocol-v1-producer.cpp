#include "protocol-v1-producer.hpp"
#include <algorithm>
#include <cmath>
#include <iterator>
#include <limits>
#include <utility>

namespace ets2telemetry::v1 {
namespace {
using Object = Json::Object;
constexpr std::uint64_t u64_max = std::numeric_limits<std::uint64_t>::max();
Json text_value(std::string s) { return Json{std::move(s)}; }
Json decimal(std::uint64_t v) { return Json{std::to_string(v)}; }
Json number(double v) { return Json{v}; }
Json uuid(const Uuid& u) { return Json{std::string(u.text, sizeof u.text)}; }
Reason reason_of(FieldState s) { return s == FieldState::not_supported ? Reason::not_supported : s == FieldState::invalid ? Reason::invalid : Reason::not_observed; }
const char* reason_text(Reason r) { return r == Reason::not_supported ? "not-supported" : r == Reason::invalid ? "invalid" : "not-observed"; }
Json available(Json value) { return Json{Object{{"available", Json{true}}, {"value", std::move(value)}}}; }
Json unavailable(Reason r) { return Json{Object{{"available", Json{false}}, {"reason", text_value(reason_text(r))}}}; }
Json with(Json j, const char* key, Json value) { std::get<Object>(j.value).emplace(key, std::move(value)); return j; }
Json with_unit(Json j, const char* unit) { return with(std::move(j), "unit", text_value(unit)); }
template<class T, class F> Json field(const Field<T>& f, F to_json) { return f.available() ? available(to_json(f.value)) : unavailable(reason_of(f.state)); }
Json optional_time(const std::optional<std::uint64_t>& t) { return t ? available(decimal(*t)) : unavailable(Reason::not_observed); }
template<class T> Available<double> as_double(const Field<T>& f) {
  return f.available() ? Available<double>{static_cast<double>(f.value), Reason::not_observed} : Available<double>{std::nullopt, reason_of(f.state)};
}
Json measure(const Measure& m) { return with_unit(m.reading.value ? available(number(*m.reading.value)) : unavailable(m.reading.reason), m.unit.c_str()); }
// §6 mapping of an SDK float reading: scale, then mark non-finite or out-of-range results invalid.
Measure scaled(const Field<double>& f, double scale, double min, double max, const char* unit) {
  if (!f.available()) return {{std::nullopt, reason_of(f.state)}, unit};
  const auto v = f.value * scale; if (!std::isfinite(v) || v < min || v > max) return {{std::nullopt, Reason::invalid}, unit};
  return {{v, Reason::not_observed}, unit};
}
Json minutes(const Field<std::uint32_t>& f) { return with_unit(field(f, [](std::uint32_t v) { return decimal(v); }), "min"); }
template<std::size_t N> Json text(const FixedText<N>& t, TextKind kind) {
  if (t.state != FieldState::available) return unavailable(reason_of(t.state));
  const auto checked = sdk_text(std::string(t.view()), kind);
  return checked.value ? available(text_value(*checked.value)) : unavailable(checked.reason);
}
Json currency(const Currency& c) {
  if (c.status == Currency::Status::unknown) return Json{Object{{"status", text_value("unknown")}}};
  return Json{Object{{"status", text_value("sdk-documented")}, {"code", text_value(c.code)}, {"source", text_value(c.source)}}};
}
template<class T> Json money(const Field<T>& f, SdkType type, const Currency& c) {
  if (!f.available()) return unavailable(reason_of(f.state));
  const auto m = sdk_money(f.value, type, c); if (!m.value) return unavailable(m.reason);
  return available(Json{Object{{"raw", text_value(m.value->raw)}, {"sdkType", text_value(type == SdkType::s64 ? "s64" : "u64")}, {"currency", currency(m.value->currency)}}});
}
Json flag(const Field<bool>& f) { return field(f, [](bool v) { return Json{v}; }); }
Json game_time(const GameTimePod& g) { return Json{Object{{"minutes", field(g.minutes, [](std::uint32_t v) { return decimal(v); })}, {"clockId", uuid(g.clock_id)}}}; }
const char* simulation(SimulationState s) { return s == SimulationState::running ? "running" : s == SimulationState::paused ? "paused" : "unavailable"; }
Object game_mode(const GameModePod& g) {
  const char* mode = g.mode == GameModeKind::single_player ? "single-player" : g.mode == GameModeKind::truckersmp ? "truckersmp" : "unknown";
  const char* method = g.method == DetectionMethod::module_scan ? "module-scan" : g.method == DetectionMethod::process_scan ? "process-scan" : "none";
  const char* confidence = g.confidence == Confidence::strong ? "strong" : g.confidence == Confidence::weak ? "weak" : "none";
  return {{"mode", text_value(mode)}, {"method", text_value(method)}, {"confidence", text_value(confidence)}, {"module", text(g.module, TextKind::nonempty_id)}};
}
Object loss(const LossCounts& c) {
  return {{"offline", decimal(c.offline)}, {"noDurableConsumer", decimal(c.no_durable_consumer)}, {"queueCount", decimal(c.queue_count)},
    {"queueBytes", decimal(c.queue_bytes)}, {"retentionExpired", decimal(c.retention_expired)}, {"encodingFailed", decimal(c.encoding_failed)}};
}
// Record bodies: the `*.configured` shapes double as configuration entries (§7), without `type`.
Object body(const records::JobConfigured& r, const Currency& c) {
  return {{"sourceCityId", text(r.source_city_id, TextKind::id)}, {"sourceCity", text(r.source_city, TextKind::name)},
    {"sourceCompanyId", text(r.source_company_id, TextKind::id)}, {"sourceCompany", text(r.source_company, TextKind::name)},
    {"destinationCityId", text(r.destination_city_id, TextKind::id)}, {"destinationCity", text(r.destination_city, TextKind::name)},
    {"destinationCompanyId", text(r.destination_company_id, TextKind::id)}, {"destinationCompany", text(r.destination_company, TextKind::name)},
    {"cargoId", text(r.cargo_id, TextKind::id)}, {"cargo", text(r.cargo, TextKind::name)},
    {"cargoMass", measure(scaled(r.cargo_mass_kg, 1, 0, 1e9, "kg"))}, {"cargoUnitMass", measure(scaled(r.cargo_unit_mass_kg, 1, 0, 1e9, "kg"))},
    {"cargoUnitCount", field(r.cargo_unit_count, [](std::uint32_t v) { return number(v); })}, {"market", text(r.market, TextKind::id)},
    {"isSpecialJob", flag(r.is_special_job)}, {"cargoLoaded", flag(r.cargo_loaded)},
    {"plannedDistance", measure(km_to_meters_u32(as_double(r.planned_distance_km)))}, {"expectedIncome", money(r.expected_income, SdkType::u64, c)},
    {"deliveryDeadline", minutes(r.delivery_deadline_min)}};
}
Object body(const records::TruckConfigured& r, const Currency&) {
  return {{"brandId", text(r.brand_id, TextKind::id)}, {"brand", text(r.brand, TextKind::name)}, {"id", text(r.id, TextKind::id)}, {"name", text(r.name, TextKind::name)},
    {"fuelCapacity", measure(scaled(r.fuel_capacity_l, 1, 0, 1e6, "L"))}, {"licensePlate", text(r.license_plate, TextKind::name)},
    {"plateCountryId", text(r.plate_country_id, TextKind::id)}, {"plateCountry", text(r.plate_country, TextKind::name)}};
}
Object trailer(const records::TrailerConfigured& r, unsigned index) {
  return {{"index", number(index)}, {"id", text(r.id, TextKind::id)}, {"bodyType", text(r.body_type, TextKind::id)}, {"chainType", text(r.chain_type, TextKind::id)},
    {"cargoAccessoryId", text(r.cargo_accessory_id, TextKind::id)}, {"brandId", text(r.brand_id, TextKind::id)}, {"brand", text(r.brand, TextKind::name)},
    {"name", text(r.name, TextKind::name)}, {"licensePlate", text(r.license_plate, TextKind::name)}, {"plateCountryId", text(r.plate_country_id, TextKind::id)},
    {"plateCountry", text(r.plate_country, TextKind::name)}};
}
// An out-of-range index stays as copied, so the contract rejects the record and it becomes an encodingFailed gap.
Object body(const records::TrailerConfigured& r, const Currency&) { return trailer(r, r.index); }
Object body(const records::TrailerCleared& r, const Currency&) { return {{"index", number(r.index)}}; }
Object body(const records::GameTimeRegression& r, const Currency&) { return {{"from", game_time(r.from)}, {"to", game_time(r.to)}}; }
Object body(const records::JobDelivered& r, const Currency& c) {
  return {{"revenue", money(r.revenue, SdkType::s64, c)}, {"earnedXp", field(r.earned_xp, [](std::int32_t v) { return number(v); })},
    {"cargoDamage", measure(fraction(as_double(r.cargo_damage)))}, {"distance", measure(km_to_meters_float(as_double(r.distance_km)))},
    {"deliveryDuration", minutes(r.delivery_duration_min)}, {"autoParkUsed", flag(r.auto_park_used)}, {"autoLoadUsed", flag(r.auto_load_used)}};
}
Object body(const records::JobCancelled& r, const Currency& c) { return {{"penalty", money(r.penalty, SdkType::s64, c)}}; }
Object body(const records::PlayerFined& r, const Currency& c) { return {{"offence", text(r.offence, TextKind::id)}, {"amount", money(r.amount, SdkType::s64, c)}}; }
Object body(const records::PlayerTollgatePaid& r, const Currency& c) { return {{"amount", money(r.amount, SdkType::s64, c)}}; }
Object body(const records::Transfer& r, const Currency& c) {
  return {{"amount", money(r.amount, SdkType::s64, c)}, {"sourceId", text(r.source_id, TextKind::id)}, {"sourceName", text(r.source_name, TextKind::name)},
    {"targetId", text(r.target_id, TextKind::id)}, {"targetName", text(r.target_name, TextKind::name)}};
}
Object body(const records::PlayerUseFerry& r, const Currency& c) { return body(static_cast<const records::Transfer&>(r), c); }
Object body(const records::PlayerUseTrain& r, const Currency& c) { return body(static_cast<const records::Transfer&>(r), c); }
Object body(const records::SourceGameMode& r, const Currency&) { return game_mode(r.mode); }
// Records without fields. Every body type has its own overload, so a new record type cannot fall through silently.
Object body(const records::JobCleared&, const Currency&) { return {}; }
Object body(const records::TruckCleared&, const Currency&) { return {}; }
Object body(const records::SimulationPaused&, const Currency&) { return {}; }
Object body(const records::SimulationStarted&, const Currency&) { return {}; }
Object body(const records::TimersRestart&, const Currency&) { return {}; }
Json occurrence(const OccurrencePod& o) {
  return Json{Object{{"monotonicNs", field(o.monotonic_ns, decimal)}, {"gameTime", game_time(o.game_time)}, {"utcUnixMs", field(o.utc_unix_ms, decimal)},
    {"simulation", text_value(simulation(o.simulation))}, {"configurationRevision", decimal(o.configuration_revision)}, {"boundaryOrder", decimal(o.boundary_order)}}};
}
Json placement(const Field<PlacementPod>& f) {
  if (!f.available()) return unavailable(reason_of(f.state));
  const auto& p = f.value; bool valid = true;
  for (const auto axis : {p.x, p.y, p.z}) valid = valid && std::isfinite(axis) && axis >= -1e9 && axis <= 1e9;
  for (const auto angle : {p.heading, p.pitch, p.roll}) valid = valid && std::isfinite(angle) && angle >= -1 && angle <= 1;
  if (!valid) return unavailable(Reason::invalid);
  return available(Json{Object{{"position", Json{Object{{"x", number(p.x)}, {"y", number(p.y)}, {"z", number(p.z)}}}},
    {"orientation", Json{Object{{"heading", number(p.heading)}, {"pitch", number(p.pitch)}, {"roll", number(p.roll)}}}}}});
}
Json window(const Field<WindowPod>& f) {
  if (!f.available()) return unavailable(reason_of(f.state));
  const auto& w = f.value;
  if (!w.handle || w.x < -1000000 || w.x > 1000000 || w.y < -1000000 || w.y > 1000000 || w.width > 100000 || w.height > 100000 || w.dpi < 1 || w.dpi > 1000)
    return unavailable(Reason::invalid);
  const char* mode = w.display_mode == DisplayMode::windowed ? "windowed" : w.display_mode == DisplayMode::borderless ? "borderless"
    : w.display_mode == DisplayMode::exclusive ? "exclusive" : "unknown";
  return available(Json{Object{{"handle", decimal(w.handle)}, {"x", number(w.x)}, {"y", number(w.y)}, {"width", number(w.width)}, {"height", number(w.height)},
    {"dpi", number(w.dpi)}, {"foreground", Json{w.foreground}}, {"minimized", Json{w.minimized}}, {"displayMode", text_value(mode)}}});
}
Json configuration(const ConfigurationPod& c, const Currency& currency) {
  Json::Array trailers;
  // OD-6: every slot is present; slot i of an available trailer carries index i.
  for (unsigned i = 0; i < c.trailers.size(); ++i) {
    const auto& slot = c.trailers[i];
    trailers.push_back(slot.available() ? available(Json{trailer(slot.value, i)}) : unavailable(reason_of(slot.state)));
  }
  return Json{Object{{"revision", decimal(c.revision)}, {"job", c.job.available() ? available(Json{body(c.job.value, currency)}) : unavailable(reason_of(c.job.state))},
    {"truck", c.truck.available() ? available(Json{body(c.truck.value, currency)}) : unavailable(reason_of(c.truck.state))}, {"trailers", Json{std::move(trailers)}}}};
}
Json state(const StatePod& s, const Currency& currency) {
  return Json{Object{{"simulation", text_value(simulation(s.simulation))},
    {"speed", measure(scaled(s.speed_mps, 1, -1000, 1000, "m/s"))}, {"fuel", measure(scaled(s.fuel_l, 1, 0, 1e6, "L"))},
    {"fuelCapacity", measure(scaled(s.fuel_capacity_l, 1, 0, 1e6, "L"))}, {"engineRpm", measure(scaled(s.engine_rpm, 1, 0, 100000, "rpm"))},
    {"gear", s.gear.available() && s.gear.value >= -100 && s.gear.value <= 100 ? with_unit(available(number(s.gear.value)), "index")
      : with_unit(unavailable(s.gear.available() ? Reason::invalid : reason_of(s.gear.state)), "index")},
    {"odometer", measure(scaled(s.odometer_km, 1000, 0, 1e12, "m"))}, {"averageConsumption", measure(scaled(s.average_consumption_l_per_km, 100, 0, 1e6, "L/100km"))},
    {"estimatedRange", measure(scaled(s.estimated_range_km, 1000, 0, 1e12, "m"))}, {"navigationDistance", measure(scaled(s.navigation_distance_m, 1, 0, 1e12, "m"))},
    {"gameTime", with(minutes(s.game_time.minutes), "clockId", uuid(s.game_time.clock_id))}, {"captureUtcUnixMs", field(s.capture_utc_unix_ms, decimal)},
    {"boundaryOrder", decimal(s.boundary_order)}, {"worldPlacement", placement(s.world_placement)}, {"configuration", configuration(s.configuration, currency)},
    {"window", window(s.window)}}};
}
}

std::vector<std::string> welcome_event_types(bool gameplay_events_registered, bool game_mode_events) {
  std::vector<std::string> types;
  for (const auto* type : event_types) {
    const bool gameplay = std::any_of(std::begin(gameplay_event_types), std::end(gameplay_event_types), [&](const char* g) { return std::string(type) == g; });
    if ((gameplay && !gameplay_events_registered) || (!game_mode_events && std::string(type) == "source.gameMode")) continue;
    types.emplace_back(type);
  }
  return types;
}

Json Encoder::envelope(const char* kind, std::uint64_t seq, std::uint64_t capture_ns, Json data) const {
  const auto& s = identity_.source;
  const char* origin = s.origin == Origin::synthetic ? "synthetic" : s.origin == Origin::replay ? "replay" : "game";
  return Json{Object{{"version", Json{Object{{"major", number(protocol_major)}, {"minor", number(protocol_minor)}}}}, {"kind", text_value(kind)},
    {"source", Json{Object{{"game", text_value(s.game == GameId::ats ? "ats" : "ets2")}, {"pluginSessionId", uuid(s.plugin_session_id)},
      {"processInstanceId", uuid(s.process_instance_id)}, {"processId", number(s.process_id)}, {"windowsSessionId", number(s.windows_session_id)}, {"origin", text_value(origin)}}}},
    {"seq", decimal(seq)}, {"capture", Json{Object{{"clockId", uuid(identity_.capture_clock_id)}, {"monotonicNs", decimal(capture_ns)}}}}, {"data", std::move(data)}}};
}
Json Encoder::welcome(std::uint64_t seq, std::uint64_t capture_ns, const WelcomeInfo& w) const {
  Json::Array types; for (auto& type : welcome_event_types(w.gameplay_events_registered, w.game_mode_events)) types.push_back(text_value(std::move(type)));
  const auto version = [](const VersionPair& v) { return Json{Object{{"major", number(v.major)}, {"minor", number(v.minor)}}}; };
  return envelope("welcome", seq, capture_ns, Json{Object{{"minor", number(protocol_minor)}, {"durableEvents", Json{w.durable_events}},
    {"limits", Json{Object{{"serverFrameBytes", number(static_cast<double>(limits.server_frame_bytes))}, {"clientFrameBytes", number(static_cast<double>(limits.client_frame_bytes))},
      {"eventBytes", number(static_cast<double>(limits.event_bytes))}, {"retainedEntries", number(static_cast<double>(limits.retained_entries))},
      {"retainedBytes", number(static_cast<double>(limits.retained_bytes))}, {"disconnectRetentionMs", number(limits.disconnect_retention_ms)},
      {"helloTimeoutMs", number(limits.hello_timeout_ms)}, {"writeDeadlineMs", number(limits.write_deadline_ms)},
      {"snapshotIntervalMs", number(limits.snapshot_interval_ms)}, {"trailerSlots", number(limits.trailer_slots)}}}},
    {"capabilities", Json{Object{{"gameplayEvents", text_value(w.gameplay_events_registered ? "registered" : "not-supported")}, {"eventTypes", Json{std::move(types)}}}}},
    {"versions", Json{Object{{"telemetryApi", version(w.telemetry_api)}, {"gameTelemetry", version(w.game_telemetry)}, {"sdkArchive", text_value(w.sdk_archive)}}}},
    {"gameMode", Json{game_mode(w.game_mode)}}}});
}
Json Encoder::state_data(const StatePod& s, const StatusInfo& status) const {
  const auto& d = status.delivery;
  return Json{Object{{"state", state(s, identity_.currency)},
    {"status", Json{Object{{"gameMode", Json{game_mode(status.game_mode)}}, {"eventLoss", Json{loss(d.event_loss)}},
      {"delivery", Json{Object{{"durable", Json{status.durable}}, {"ackedThroughEventSeq", decimal(d.acked_through_event_seq)}, {"nextEventSeq", decimal(d.next_event_seq)},
        {"retainedEvents", number(d.retained_entries)}, {"retainedBytes", number(d.retained_bytes)}, {"oldestRetainedMonotonicNs", optional_time(d.oldest_retained_ns)}}}}}}},
    {"continuity", Json{Object{{"coalescedSnapshots", decimal(status.continuity.coalesced_snapshots)}, {"offlineTransitions", decimal(status.continuity.offline_transitions)}}}}}};
}
Json Encoder::checkpoint(std::uint64_t seq, std::uint64_t capture_ns, const StatePod& s, const StatusInfo& status) const {
  return envelope("checkpoint", seq, capture_ns, with(state_data(s, status), "boundarySeq", decimal(seq)));
}
Json Encoder::snapshot(std::uint64_t seq, std::uint64_t capture_ns, const StatePod& s, const StatusInfo& status) const {
  return envelope("snapshot", seq, capture_ns, state_data(s, status));
}
Json Encoder::event(std::uint64_t seq, std::uint64_t capture_ns, const EventRecord& e, bool redelivered) const {
  auto record = std::visit([&](const auto& r) { return body(r, identity_.currency); }, e.record);
  record.emplace("type", text_value(record_type(e)));
  return envelope("event", seq, capture_ns, Json{Object{{"eventSeq", decimal(e.event_seq)}, {"redelivered", Json{redelivered}},
    {"occurred", occurrence(e.occurred)}, {"record", Json{std::move(record)}}}});
}
Json Encoder::gap(std::uint64_t seq, std::uint64_t capture_ns, const GapRange& g, bool redelivered) const {
  return envelope("gap", seq, capture_ns, Json{Object{{"firstEventSeq", decimal(g.first_event_seq)}, {"lastEventSeq", decimal(g.last_event_seq)},
    {"causes", Json{loss(g.causes)}}, {"firstLostMonotonicNs", optional_time(g.first_lost_ns)}, {"lastLostMonotonicNs", optional_time(g.last_lost_ns)},
    {"redelivered", Json{redelivered}}}});
}
Json Encoder::outbound(std::uint64_t seq, std::uint64_t capture_ns, const Outbound& o) const {
  return o.gap ? gap(seq, capture_ns, o.range, o.redelivered) : event(seq, capture_ns, o.event, o.redelivered);
}
Json Encoder::clock_reply(std::uint64_t seq, std::uint64_t capture_ns, std::uint64_t probe_id, std::uint64_t received_ns, std::uint64_t sent_ns) const {
  return envelope("clock.reply", seq, capture_ns, Json{Object{{"probeId", decimal(probe_id)}, {"receivedMonotonicNs", decimal(received_ns)}, {"sentMonotonicNs", decimal(sent_ns)}}});
}
Json Encoder::end(std::uint64_t seq, std::uint64_t capture_ns, EndReason reason, const EndCursor& c) const {
  const char* text = reason == EndReason::sequence_exhausted ? "sequence-exhausted" : reason == EndReason::source_retired ? "source-retired" : "plugin-shutdown";
  return envelope("end", seq, capture_ns, Json{Object{{"reason", text_value(text)}, {"nextEventSeq", decimal(c.next_event_seq)},
    {"ackedThroughEventSeq", decimal(c.acked_through_event_seq)}, {"retainedUnacked", decimal(c.retained_unacked)}}});
}
std::optional<std::size_t> Encoder::measure_event(const EventRecord& e) const noexcept {
  try {
    // The eventSeq is fixed per record; the envelope fields that change between writes take their longest values.
    const auto frame = encode(event(u64_max, u64_max, e, false));
    return frame.size() - 4;
  } catch (...) {
    // A contract rejection or any other failure, such as std::bad_alloc, makes the record unsendable. Nothing escapes,
    // so the transport worker never terminates and the eventSeq still gets encodingFailed coverage.
    return std::nullopt;
  }
}

std::vector<std::uint8_t> encode(Json wire) { Message m; m.wire = std::move(wire); return encode_frame(m); }

Ingest ingest_event(EventStore& store, const Encoder& encoder, const EventRecord& record, std::uint64_t now_ns) noexcept {
  if (store.exhausted() || record.event_seq != store.next_event_seq()) return Ingest::rejected;
  if (const auto bytes = encoder.measure_event(record)) {
    switch (store.admit(record, *bytes, now_ns)) {
      case EventStore::Admission::retained: return Ingest::retained;
      case EventStore::Admission::lost_queue_count: return Ingest::lost_queue_count;
      case EventStore::Admission::lost_queue_bytes: return Ingest::lost_queue_bytes;
      case EventStore::Admission::lost_retention_expired: return Ingest::lost_retention_expired;
      default: return Ingest::rejected;
    }
  }
  const auto observed = record.occurred.monotonic_ns.available() ? std::optional<std::uint64_t>(record.occurred.monotonic_ns.value) : std::nullopt;
  return store.lose(record.event_seq, record.event_seq, LossCause::encoding_failed, observed, observed, now_ns) ? Ingest::lost_encoding_failed : Ingest::rejected;
}
} // namespace ets2telemetry::v1
