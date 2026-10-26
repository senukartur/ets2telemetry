#include "protocol-v1.hpp"
#include "protocol-json.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <initializer_list>
#include <iterator>
#include <set>
#include <utility>

namespace ets2telemetry::v1 {
namespace {
constexpr std::uint64_t u64_max = std::numeric_limits<std::uint64_t>::max(), u32_max = 4294967295ULL;
constexpr double max_double = std::numeric_limits<double>::max();
[[noreturn]] void fail(const char* reason = "Invalid protocol v1 message") { throw ProtocolError(reason); }
const Json::Object& object(const Json& j) { const auto o = std::get_if<Json::Object>(&j.value); if (!o) fail(); return *o; }
// Exact key set, as `record` in protocol-v1.ts.
template<class Keys> const Json::Object& exact(const Json& j, const Keys& keys, std::initializer_list<const char*> extra) {
  const auto& o = object(j); if (o.size() != std::size(keys) + extra.size()) fail();
  for (auto key : keys) if (!o.count(key)) fail();
  for (auto key : extra) if (!o.count(key)) fail(); return o;
}
const Json::Object& record(const Json& j, std::initializer_list<const char*> keys) { return exact(j, keys, {}); }
const Json& at(const Json& j, const char* key) { const auto& o = object(j); const auto it = o.find(key); if (it == o.end()) fail(); return it->second; }
const std::string& str(const Json& j) { const auto s = std::get_if<std::string>(&j.value); if (!s) fail(); return *s; }
bool boolean(const Json& j) { const auto b = std::get_if<bool>(&j.value); if (!b) fail(); return *b; }
double num(const Json& j, double min, double max, bool integer = false) {
  const auto n = std::get_if<double>(&j.value); if (!n || !std::isfinite(*n) || *n < min || *n > max || (integer && std::trunc(*n) != *n)) fail(); return *n;
}
template<class Options> const std::string& choice(const Json& j, const Options& options) {
  const auto& s = str(j); if (std::none_of(std::begin(options), std::end(options), [&](const char* option) { return s == option; })) fail(); return s;
}
const std::string& choice(const Json& j, std::initializer_list<const char*> options) { return choice<std::initializer_list<const char*>>(j, options); }
bool valid_utf8(const std::string& s) { try { v0::detail::utf8(s); return true; } catch (const v0::ProtocolError&) { return false; } }
bool valid_text(const std::string& s, std::size_t max_bytes, bool allow_empty) {
  if ((!allow_empty && s.empty()) || s.size() > max_bytes || !valid_utf8(s)) return false;
  return std::none_of(s.begin(), s.end(), [](char c) { return static_cast<unsigned char>(c) < 0x20 || c == 0x7f; });
}
std::size_t text_limit(TextKind kind) { return kind == TextKind::name ? name_bytes : id_bytes; }
const std::string& text(const Json& j, std::size_t max_bytes, bool allow_empty = true) { const auto& s = str(j); if (!valid_text(s, max_bytes, allow_empty)) fail(); return s; }
const std::string& id(const Json& j) { return text(j, id_bytes); }
const std::string& name(const Json& j) { return text(j, name_bytes); }
bool valid_uuid(const std::string& s) {
  if (s.size() != 36) return false;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? s[i] != '-' : !((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  } return true;
}
const std::string& uuid(const Json& j) { const auto& s = str(j); if (!valid_uuid(s)) fail(); return s; }
std::uint64_t u64(const Json& j, std::uint64_t max = u64_max) {
  std::uint64_t n = 0; try { n = v0::parse_uint64(j); } catch (const v0::ProtocolError&) { fail(); }
  if (n > max) fail(); return n;
}
std::uint64_t event_seq(const Json& j) { const auto n = u64(j, max_event_seq); if (n == 0) fail(); return n; }
std::int64_t s64(const Json& j) {
  const auto& s = str(j); const std::size_t digits = s.size() - (!s.empty() && s[0] == '-' ? 1 : 0), start = s.size() - digits;
  // Canonical -?(0|[1-9][0-9]{0,18}) without -0, then an exact range check.
  if (digits == 0 || digits > 19 || (digits > 1 && s[start] == '0') || s == "-0" ||
    !std::all_of(s.begin() + static_cast<std::ptrdiff_t>(start), s.end(), [](char c) { return c >= '0' && c <= '9'; })) fail();
  std::int64_t n = 0; const auto parsed = std::from_chars(s.data(), s.data() + s.size(), n);
  if (parsed.ec != std::errc{} || parsed.ptr != s.data() + s.size()) fail(); return n;
}
Reason reason(const Json& j) {
  const auto& s = choice(j, {"not-supported", "not-observed", "invalid"});
  return s == "invalid" ? Reason::invalid : s == "not-supported" ? Reason::not_supported : Reason::not_observed;
}
// `{available:true,value}` or `{available:false,reason}`, each with the exact extra keys.
template<class T, class F> Available<T> available(const Json& j, F read, std::initializer_list<const char*> extra = {}) {
  const auto& o = object(j); const auto flag = o.find("available");
  const auto b = flag == o.end() ? nullptr : std::get_if<bool>(&flag->second.value); if (!b) fail();
  Available<T> a;
  if (*b) { exact(j, std::initializer_list<const char*>{"available", "value"}, extra); a.value = read(at(j, "value")); }
  else { exact(j, std::initializer_list<const char*>{"available", "reason"}, extra); a.reason = reason(at(j, "reason")); }
  return a;
}
Measure measure(const Json& j, const char* unit, double min, double max, bool integer = false, bool (*check)(double) = nullptr) {
  auto a = available<double>(j, [&](const Json& v) { const auto n = num(v, min, max, integer); if (check && !check(n)) fail(); return n; }, {"unit"});
  if (str(at(j, "unit")) != unit) fail(); return {a, unit};
}
Available<std::uint64_t> game_minutes(const Json& j) {
  auto a = available<std::uint64_t>(j, [](const Json& v) { return u64(v, u32_max); }, {"unit"}); if (str(at(j, "unit")) != "min") fail(); return a;
}
bool same_available(const Available<std::uint64_t>& a, const Available<std::uint64_t>& b) {
  return a.value ? b.value && *a.value == *b.value : !b.value && a.reason == b.reason;
}
GameTimeStamp game_time_stamp(const Json& j) {
  record(j, {"minutes", "clockId"});
  return {available<std::uint64_t>(at(j, "minutes"), [](const Json& v) { return u64(v, u32_max); }), uuid(at(j, "clockId"))};
}
bool valid_currency(const Currency& c) {
  if (c.status == Currency::Status::unknown) return c.code.empty() && c.source.empty();
  return c.code.size() == 3 && std::all_of(c.code.begin(), c.code.end(), [](char ch) { return ch >= 'A' && ch <= 'Z'; }) && valid_text(c.source, id_bytes, false);
}
Currency currency(const Json& j) {
  const auto o = std::get_if<Json::Object>(&j.value); const auto status = o ? o->find("status") : Json::Object::const_iterator{};
  if (o && status != o->end() && std::get_if<std::string>(&status->second.value) && str(status->second) == "unknown") { record(j, {"status"}); return {}; }
  record(j, {"status", "code", "source"});
  if (str(at(j, "status")) != "sdk-documented") fail();
  Currency c{Currency::Status::sdk_documented, str(at(j, "code")), text(at(j, "source"), id_bytes, false)};
  if (!valid_currency(c)) fail(); return c;
}
Available<Money> money(const Json& j, SdkType type) {
  return available<Money>(j, [type](const Json& v) {
    record(v, {"raw", "sdkType", "currency"}); Money m;
    if (str(at(v, "sdkType")) != (type == SdkType::s64 ? "s64" : "u64")) fail();
    m.sdk_type = type; m.raw = str(at(v, "raw"));
    if (type == SdkType::s64) m.exact = s64(at(v, "raw")); else m.exact = u64(at(v, "raw"));
    m.currency = currency(at(v, "currency")); return m;
  });
}
void ids(const Json& j, std::initializer_list<const char*> keys) { for (auto key : keys) available<std::string>(at(j, key), id); }
void names(const Json& j, std::initializer_list<const char*> keys) { for (auto key : keys) available<std::string>(at(j, key), name); }
constexpr const char* job_keys[] = {"sourceCityId", "sourceCity", "sourceCompanyId", "sourceCompany", "destinationCityId", "destinationCity", "destinationCompanyId", "destinationCompany",
  "cargoId", "cargo", "cargoMass", "cargoUnitMass", "cargoUnitCount", "market", "isSpecialJob", "cargoLoaded", "plannedDistance", "expectedIncome", "deliveryDeadline"};
constexpr const char* truck_keys[] = {"brandId", "brand", "id", "name", "fuelCapacity", "licensePlate", "plateCountryId", "plateCountry"};
constexpr const char* trailer_keys[] = {"index", "id", "bodyType", "chainType", "cargoAccessoryId", "brandId", "brand", "name", "licensePlate", "plateCountryId", "plateCountry"};
constexpr const char* transfer_keys[] = {"amount", "sourceId", "sourceName", "targetId", "targetName"};
constexpr const char* game_mode_keys[] = {"mode", "method", "confidence", "module"};
constexpr const char* loss_keys[] = {"offline", "noDurableConsumer", "queueCount", "queueBytes", "retentionExpired", "encodingFailed"};
void job(const Json& o) {
  ids(o, {"sourceCityId", "sourceCompanyId", "destinationCityId", "destinationCompanyId", "cargoId", "market"});
  names(o, {"sourceCity", "sourceCompany", "destinationCity", "destinationCompany", "cargo"});
  measure(at(o, "cargoMass"), "kg", 0, 1e9); measure(at(o, "cargoUnitMass"), "kg", 0, 1e9);
  available<double>(at(o, "cargoUnitCount"), [](const Json& v) { return num(v, 0, u32_max, true); });
  available<bool>(at(o, "isSpecialJob"), boolean); available<bool>(at(o, "cargoLoaded"), boolean);
  // SDK planned_distance.km is a u32 of whole kilometres, so its exact metre value is a multiple of 1,000.
  measure(at(o, "plannedDistance"), "m", 0, u32_max * 1000.0, true, [](double value) { return std::fmod(value, 1000) == 0; });
  money(at(o, "expectedIncome"), SdkType::u64); game_minutes(at(o, "deliveryDeadline"));
}
void truck(const Json& o) {
  ids(o, {"brandId", "id", "plateCountryId"}); names(o, {"brand", "name", "licensePlate", "plateCountry"}); measure(at(o, "fuelCapacity"), "L", 0, 1e6);
}
double trailer(const Json& o) {
  ids(o, {"id", "bodyType", "chainType", "cargoAccessoryId", "brandId", "plateCountryId"}); names(o, {"brand", "name", "licensePlate", "plateCountry"});
  return num(at(o, "index"), 0, limits.trailer_slots - 1, true);
}
GameMode game_mode(const Json& o) {
  GameMode g; g.mode = choice(at(o, "mode"), {"single-player", "truckersmp", "unknown"}); g.method = choice(at(o, "method"), {"module-scan", "process-scan", "none"});
  g.confidence = choice(at(o, "confidence"), {"strong", "weak", "none"});
  g.module = available<std::string>(at(o, "module"), [](const Json& v) { return text(v, id_bytes, false); });
  // Unknown pairs only with none; a missing module is weak evidence, so single-player is never strong.
  if ((g.mode == "unknown") != (g.method == "none") || (g.mode == "unknown") != (g.confidence == "none")) fail();
  if (g.mode == "single-player" && g.confidence == "strong") fail();
  if (g.mode == "truckersmp" && g.method == "module-scan" && !g.module.value) fail();
  // Only a module scan can name a module.
  if (g.method != "module-scan" && g.module.value) fail();
  return g;
}
// The counts and their checked sum; nullopt means the sum exceeds uint64, which never equals a gap length.
std::pair<LossCounts, std::optional<std::uint64_t>> loss_counts(const Json& j) {
  exact(j, loss_keys, {});
  LossCounts c{u64(at(j, "offline")), u64(at(j, "noDurableConsumer")), u64(at(j, "queueCount")), u64(at(j, "queueBytes")), u64(at(j, "retentionExpired")), u64(at(j, "encodingFailed"))};
  std::optional<std::uint64_t> sum = 0;
  for (auto n : {c.offline, c.no_durable_consumer, c.queue_count, c.queue_bytes, c.retention_expired, c.encoding_failed}) {
    if (sum && n > u64_max - *sum) sum.reset(); else if (sum) *sum += n;
  }
  return {c, sum};
}
bool window_state(const Json& w) {
  record(w, {"handle", "x", "y", "width", "height", "dpi", "foreground", "minimized", "displayMode"});
  if (u64(at(w, "handle")) == 0) fail(); num(at(w, "x"), -1e6, 1e6, true); num(at(w, "y"), -1e6, 1e6, true);
  num(at(w, "width"), 0, 100000, true); num(at(w, "height"), 0, 100000, true); num(at(w, "dpi"), 1, 1000, true);
  boolean(at(w, "foreground")); boolean(at(w, "minimized")); choice(at(w, "displayMode"), {"windowed", "borderless", "exclusive", "unknown"}); return true;
}
unsigned gear_count(const Json& v) { return static_cast<unsigned>(num(v, 0, gearbox_limits.max_gears, true)); }
Gearbox gearbox(const Json& g) {
  record(g, {"forwardGears", "reverseGears", "hshifter"}); Gearbox r;
  r.forward_gears = available<unsigned>(at(g, "forwardGears"), gear_count); r.reverse_gears = available<unsigned>(at(g, "reverseGears"), gear_count);
  r.hshifter = available<HShifterLayout>(at(g, "hshifter"), [](const Json& value) {
    record(value, {"selectorCount", "slots"}); HShifterLayout h;
    h.selector_count = static_cast<unsigned>(num(at(value, "selectorCount"), 0, gearbox_limits.max_selector_count, true));
    const auto slots = std::get_if<Json::Array>(&at(value, "slots").value); if (!slots || slots->size() > gearbox_limits.max_slots) fail();
    const double max_gear = gearbox_limits.max_gears; std::set<unsigned> pairs;
    for (const auto& slot : *slots) {
      record(slot, {"gear", "handlePosition", "selectors"}); HShifterSlot s;
      // Neutral slots are omitted, so a slot gear is never 0.
      const auto gear = num(at(slot, "gear"), -max_gear, max_gear, true); if (gear == 0) fail(); s.gear = static_cast<int>(gear);
      s.handle_position = static_cast<unsigned>(num(at(slot, "handlePosition"), 0, gearbox_limits.max_handle_position, true));
      s.selectors = static_cast<unsigned>(num(at(slot, "selectors"), 0, (1U << h.selector_count) - 1, true));
      // Each (handlePosition, selectors) pair selects exactly one slot.
      if (!pairs.insert((s.handle_position << gearbox_limits.max_selector_count) | s.selectors).second) fail();
      h.slots.push_back(s);
    }
    return h;
  });
  return r;
}
constexpr const char* state_keys[] = {"simulation", "speed", "fuel", "fuelCapacity", "engineRpm", "gear", "odometer", "averageConsumption", "estimatedRange",
  "navigationDistance", "gameTime", "captureUtcUnixMs", "boundaryOrder", "worldPlacement", "configuration", "window"};
// The minor-0 state, plus `gearbox` from minor 1 and `nextMandatoryBreak` from minor 2, exactly as the envelope minor says;
// returns the boundary order.
std::uint64_t state(const Json& o, unsigned minor, std::optional<Gearbox>& box, std::optional<Measure>& next_break) {
  if (minor >= 2) exact(o, state_keys, {"gearbox", "nextMandatoryBreak"}); else if (minor == 1) exact(o, state_keys, {"gearbox"}); else exact(o, state_keys, {});
  choice(at(o, "simulation"), {"running", "paused", "unavailable"});
  measure(at(o, "speed"), "m/s", -1000, 1000); measure(at(o, "fuel"), "L", 0, 1e6); measure(at(o, "fuelCapacity"), "L", 0, 1e6);
  measure(at(o, "engineRpm"), "rpm", 0, 100000); measure(at(o, "gear"), "index", -100, 100, true); measure(at(o, "odometer"), "m", 0, 1e12);
  measure(at(o, "averageConsumption"), "L/100km", 0, 1e6); measure(at(o, "estimatedRange"), "m", 0, 1e12); measure(at(o, "navigationDistance"), "m", 0, 1e12);
  const auto& gt = at(o, "gameTime"); available<std::uint64_t>(gt, [](const Json& v) { return u64(v, u32_max); }, {"unit", "clockId"});
  if (str(at(gt, "unit")) != "min") fail(); uuid(at(gt, "clockId"));
  available<std::uint64_t>(at(o, "captureUtcUnixMs"), [](const Json& v) { return u64(v); }); const auto boundary_order = u64(at(o, "boundaryOrder"));
  available<bool>(at(o, "worldPlacement"), [](const Json& value) {
    record(value, {"position", "orientation"}); const auto& position = at(value, "position"), &orientation = at(value, "orientation");
    record(position, {"x", "y", "z"}); record(orientation, {"heading", "pitch", "roll"});
    for (auto axis : {"x", "y", "z"}) num(at(position, axis), -1e9, 1e9);
    for (auto angle : {"heading", "pitch", "roll"}) num(at(orientation, angle), -1, 1);
    return true;
  });
  const auto& c = at(o, "configuration"); record(c, {"revision", "job", "truck", "trailers"}); u64(at(c, "revision"));
  available<bool>(at(c, "job"), [](const Json& v) { exact(v, job_keys, {}); job(v); return true; });
  available<bool>(at(c, "truck"), [](const Json& v) { exact(v, truck_keys, {}); truck(v); return true; });
  const auto trailers = std::get_if<Json::Array>(&at(c, "trailers").value); if (!trailers || trailers->size() > limits.trailer_slots) fail();
  for (std::size_t index = 0; index < trailers->size(); ++index)
    available<bool>((*trailers)[index], [index](const Json& v) { exact(v, trailer_keys, {}); if (trailer(v) != static_cast<double>(index)) fail(); return true; });
  available<bool>(at(o, "window"), window_state);
  if (minor >= 1) box = gearbox(at(o, "gearbox"));
  // A plain signed JSON integer of the s32 range, not a canonical u64 string: negative means overdue and zero is a value (MB1).
  if (minor >= 2) next_break = measure(at(o, "nextMandatoryBreak"), "min", -2147483648.0, 2147483647.0, true);
  return boundary_order;
}
SourceStatus status(const Json& o, std::uint64_t capture_ns) {
  record(o, {"gameMode", "delivery", "eventLoss"}); SourceStatus s;
  exact(at(o, "gameMode"), game_mode_keys, {}); s.game_mode = game_mode(at(o, "gameMode")); s.event_loss = loss_counts(at(o, "eventLoss")).first;
  const auto& d = at(o, "delivery"); record(d, {"durable", "ackedThroughEventSeq", "nextEventSeq", "retainedEvents", "retainedBytes", "oldestRetainedMonotonicNs"});
  auto& delivery = s.delivery; delivery.durable = boolean(at(d, "durable"));
  const auto acked = u64(at(d, "ackedThroughEventSeq")), next = u64(at(d, "nextEventSeq"));
  const auto entries = static_cast<std::uint32_t>(num(at(d, "retainedEvents"), 0, static_cast<double>(limits.retained_entries), true));
  const auto bytes = static_cast<std::uint32_t>(num(at(d, "retainedBytes"), 0, static_cast<double>(limits.retained_bytes), true));
  // Each retained entry (event or gap record) covers at least one unacknowledged eventSeq.
  if (next == 0 || acked >= next || entries > next - 1 - acked || (entries == 0) != (bytes == 0)) fail();
  // Events never take the reserved last entry, so a full store holds at least one gap record.
  if (entries == limits.retained_entries && bytes < gap_record_bytes) fail();
  delivery.oldest_retained_monotonic_ns = available<std::uint64_t>(at(d, "oldestRetainedMonotonicNs"), [capture_ns](const Json& v) { return u64(v, capture_ns); });
  if (delivery.oldest_retained_monotonic_ns.value.has_value() != (entries > 0)) fail();
  delivery.acked_through_event_seq = acked; delivery.next_event_seq = next; delivery.retained_events = entries; delivery.retained_bytes = bytes;
  return s;
}
Occurrence occurrence(const Json& o, std::uint64_t capture_ns) {
  record(o, {"monotonicNs", "gameTime", "utcUnixMs", "simulation", "configurationRevision", "boundaryOrder"}); Occurrence r;
  r.monotonic_ns = available<std::uint64_t>(at(o, "monotonicNs"), [capture_ns](const Json& v) { return u64(v, capture_ns); });
  r.game_time = game_time_stamp(at(o, "gameTime")); r.utc_unix_ms = available<std::uint64_t>(at(o, "utcUnixMs"), [](const Json& v) { return u64(v); });
  r.simulation = choice(at(o, "simulation"), {"running", "paused", "unavailable"});
  r.configuration_revision = u64(at(o, "configurationRevision")); r.boundary_order = u64(at(o, "boundaryOrder"));
  return r;
}
std::vector<const char*> record_keys(const std::string& type) {
  if (type == "job.configured") return {std::begin(job_keys), std::end(job_keys)};
  if (type == "truck.configured") return {std::begin(truck_keys), std::end(truck_keys)};
  if (type == "trailer.configured") return {std::begin(trailer_keys), std::end(trailer_keys)};
  if (type == "trailer.cleared") return {"index"};
  if (type == "gameTime.regression") return {"from", "to"};
  if (type == "job.delivered") return {"revenue", "earnedXp", "cargoDamage", "distance", "deliveryDuration", "autoParkUsed", "autoLoadUsed"};
  if (type == "job.cancelled") return {"penalty"};
  if (type == "player.fined") return {"offence", "amount"};
  if (type == "player.tollgate.paid") return {"amount"};
  if (type == "player.use.ferry" || type == "player.use.train") return {std::begin(transfer_keys), std::end(transfer_keys)};
  if (type == "source.gameMode") return {std::begin(game_mode_keys), std::end(game_mode_keys)};
  return {};
}
std::string event_record(const Json& o, const Occurrence& occurred) {
  object(o);
  // Unknown types, including the deferred bus and car jobs (TD-002), are rejected rather than ignored.
  const auto& type = choice(at(o, "type"), event_types); exact(o, record_keys(type), {"type"});
  if (type == "job.configured") job(o);
  else if (type == "truck.configured") truck(o);
  else if (type == "trailer.configured") trailer(o);
  else if (type == "trailer.cleared") num(at(o, "index"), 0, limits.trailer_slots - 1, true);
  else if (type == "gameTime.regression") {
    const auto from = game_time_stamp(at(o, "from")), to = game_time_stamp(at(o, "to"));
    // Only the regression event carries the new game time and clock, so it occurs at `to`.
    if (from.clock_id == to.clock_id || occurred.game_time.clock_id != to.clock_id || !same_available(occurred.game_time.minutes, to.minutes)) fail();
    if (from.minutes.value && to.minutes.value && *to.minutes.value >= *from.minutes.value) fail();
  } else if (type == "job.delivered") {
    money(at(o, "revenue"), SdkType::s64); available<double>(at(o, "earnedXp"), [](const Json& v) { return num(v, -2147483648., 2147483647., true); });
    measure(at(o, "cargoDamage"), "fraction", 0, 1000); measure(at(o, "distance"), "m", 0, 1e12); game_minutes(at(o, "deliveryDuration"));
    available<bool>(at(o, "autoParkUsed"), boolean); available<bool>(at(o, "autoLoadUsed"), boolean);
  } else if (type == "job.cancelled") money(at(o, "penalty"), SdkType::s64);
  else if (type == "player.fined") { available<std::string>(at(o, "offence"), id); money(at(o, "amount"), SdkType::s64); }
  else if (type == "player.tollgate.paid") money(at(o, "amount"), SdkType::s64);
  else if (type == "player.use.ferry" || type == "player.use.train") {
    money(at(o, "amount"), SdkType::s64); ids(o, {"sourceId", "targetId"}); names(o, {"sourceName", "targetName"});
  } else if (type == "source.gameMode") game_mode(o);
  return type;
}
WelcomeView welcome(const Json& d, unsigned envelope_minor) {
  record(d, {"minor", "durableEvents", "limits", "capabilities", "versions", "gameMode"}); WelcomeView w;
  // The welcome is the first message at the selected minor, so its envelope minor equals the minor it announces.
  const auto minor = std::get_if<double>(&at(d, "minor").value); if (!minor || *minor != envelope_minor) fail(); w.minor = envelope_minor;
  w.durable_events = boolean(at(d, "durableEvents"));
  const std::pair<const char*, double> expected[] = {{"serverFrameBytes", static_cast<double>(limits.server_frame_bytes)}, {"clientFrameBytes", static_cast<double>(limits.client_frame_bytes)},
    {"eventBytes", static_cast<double>(limits.event_bytes)}, {"retainedEntries", static_cast<double>(limits.retained_entries)}, {"retainedBytes", static_cast<double>(limits.retained_bytes)},
    {"disconnectRetentionMs", limits.disconnect_retention_ms}, {"helloTimeoutMs", limits.hello_timeout_ms}, {"writeDeadlineMs", limits.write_deadline_ms},
    {"snapshotIntervalMs", limits.snapshot_interval_ms}, {"trailerSlots", limits.trailer_slots}};
  const auto& l = at(d, "limits"); const auto& lo = object(l); if (lo.size() != std::size(expected)) fail();
  for (const auto& entry : expected) if (!lo.count(entry.first)) fail();
  for (const auto& entry : expected) { const auto n = std::get_if<double>(&lo.at(entry.first).value); if (!n || *n != entry.second) fail("Unsupported protocol v1 limits"); }
  const auto& c = at(d, "capabilities"); record(c, {"gameplayEvents", "eventTypes"});
  w.gameplay_events_registered = choice(at(c, "gameplayEvents"), {"registered", "not-supported"}) == "registered";
  const auto types = std::get_if<Json::Array>(&at(c, "eventTypes").value); if (!types || types->size() > std::size(event_types)) fail();
  std::set<std::string> seen;
  for (const auto& type : *types) {
    const auto& t = choice(type, event_types);
    const bool gameplay = std::any_of(std::begin(gameplay_event_types), std::end(gameplay_event_types), [&](const char* g) { return t == g; });
    if (!seen.insert(t).second || (!w.gameplay_events_registered && gameplay)) fail(); w.event_types.push_back(t);
  }
  const auto& versions = at(d, "versions"); record(versions, {"telemetryApi", "gameTelemetry", "sdkArchive"});
  for (auto key : {"telemetryApi", "gameTelemetry"}) { const auto& v = at(versions, key); record(v, {"major", "minor"}); num(at(v, "major"), 0, 65535, true); num(at(v, "minor"), 0, 65535, true); }
  text(at(versions, "sdkArchive"), id_bytes, false); exact(at(d, "gameMode"), game_mode_keys, {}); w.game_mode = game_mode(at(d, "gameMode"));
  return w;
}
SourceIdentity source(const Json& s) {
  record(s, {"game", "pluginSessionId", "processInstanceId", "processId", "windowsSessionId", "origin"}); SourceIdentity r;
  r.game = choice(at(s, "game"), {"ets2", "ats"}); r.plugin_session_id = uuid(at(s, "pluginSessionId")); r.process_instance_id = uuid(at(s, "processInstanceId"));
  r.process_id = static_cast<std::uint32_t>(num(at(s, "processId"), 1, u32_max, true)); r.windows_session_id = static_cast<std::uint32_t>(num(at(s, "windowsSessionId"), 0, u32_max, true));
  r.origin = choice(at(s, "origin"), {"game", "synthetic", "replay"}); return r;
}
// The caller's highest accepted minor; a value this contract does not implement is a caller error.
unsigned max_minor_of(unsigned max) { if (max > highest_minor) fail("Unsupported maximum protocol v1 minor"); return max; }
unsigned version(const Json& v, unsigned max) {
  record(v, {"major", "minor"}); const auto major = std::get_if<double>(&at(v, "major").value), minor = std::get_if<double>(&at(v, "minor").value);
  // Minors 0 to 2 are implemented; a minor above the caller's maximum is refused as an unsupported version.
  if (!major || !minor || *major != protocol_major || !(*minor == 0 || *minor == 1 || *minor == 2) || *minor > max) fail("Unsupported protocol version");
  return static_cast<unsigned>(*minor);
}
constexpr const char* client_kinds[] = {"hello", "ack", "clock.probe"};
Message server_message(const Json& o, unsigned max) {
  record(o, {"version", "kind", "source", "seq", "capture", "data"}); Message m; m.minor = version(at(o, "version"), max); m.sender = Sender::server;
  m.source = source(at(o, "source")); m.seq = u64(at(o, "seq")); const auto& cap = at(o, "capture"); record(cap, {"clockId", "monotonicNs"});
  m.capture.clock_id = uuid(at(cap, "clockId")); m.capture.monotonic_ns = u64(at(cap, "monotonicNs")); const auto capture_ns = m.capture.monotonic_ns;
  m.kind = choice(at(o, "kind"), {"welcome", "checkpoint", "snapshot", "event", "gap", "clock.reply", "end"}); const auto& d = at(o, "data");
  if (m.kind == "welcome") m.welcome = welcome(d, m.minor);
  else if (m.kind == "checkpoint" || m.kind == "snapshot") {
    StateView v;
    if (m.kind == "checkpoint") {
      record(d, {"boundarySeq", "state", "status", "continuity"});
      const auto boundary = std::get_if<std::string>(&at(d, "boundarySeq").value); if (!boundary || *boundary != str(at(o, "seq"))) fail(); v.boundary_seq = m.seq;
    } else record(d, {"state", "status", "continuity"});
    v.boundary_order = state(at(d, "state"), m.minor, v.gearbox, v.next_mandatory_break); v.status = status(at(d, "status"), capture_ns);
    const auto& c = at(d, "continuity"); record(c, {"coalescedSnapshots", "offlineTransitions"});
    v.continuity = {u64(at(c, "coalescedSnapshots")), u64(at(c, "offlineTransitions"))}; m.state = std::move(v);
  } else if (m.kind == "event") {
    record(d, {"eventSeq", "redelivered", "occurred", "record"}); EventView e; e.event_seq = event_seq(at(d, "eventSeq")); e.redelivered = boolean(at(d, "redelivered"));
    e.occurred = occurrence(at(d, "occurred"), capture_ns); e.record_type = event_record(at(d, "record"), e.occurred); m.event = std::move(e);
  } else if (m.kind == "gap") {
    record(d, {"firstEventSeq", "lastEventSeq", "causes", "firstLostMonotonicNs", "lastLostMonotonicNs", "redelivered"}); GapView g;
    g.first_event_seq = event_seq(at(d, "firstEventSeq")); g.last_event_seq = event_seq(at(d, "lastEventSeq"));
    if (g.last_event_seq < g.first_event_seq) fail();
    const auto causes = loss_counts(at(d, "causes")); if (!causes.second || *causes.second != g.last_event_seq - g.first_event_seq + 1) fail(); g.causes = causes.first;
    g.first_lost_monotonic_ns = available<std::uint64_t>(at(d, "firstLostMonotonicNs"), [capture_ns](const Json& v) { return u64(v, capture_ns); });
    const auto first_lost = g.first_lost_monotonic_ns.value;
    g.last_lost_monotonic_ns = available<std::uint64_t>(at(d, "lastLostMonotonicNs"), [capture_ns, first_lost](const Json& v) {
      const auto last_lost = u64(v, capture_ns); if (first_lost && last_lost < *first_lost) fail(); return last_lost;
    });
    g.redelivered = boolean(at(d, "redelivered")); m.gap = std::move(g);
  } else if (m.kind == "clock.reply") {
    record(d, {"probeId", "receivedMonotonicNs", "sentMonotonicNs"}); ClockReplyView r;
    r.probe_id = u64(at(d, "probeId")); if (r.probe_id == 0) fail(); r.received_monotonic_ns = u64(at(d, "receivedMonotonicNs")); r.sent_monotonic_ns = u64(at(d, "sentMonotonicNs"));
    if (r.received_monotonic_ns > r.sent_monotonic_ns || r.sent_monotonic_ns > capture_ns) fail(); m.clock_reply = r;
  } else {
    record(d, {"reason", "nextEventSeq", "ackedThroughEventSeq", "retainedUnacked"}); EndView e;
    e.reason = choice(at(d, "reason"), {"plugin-shutdown", "sequence-exhausted", "source-retired"});
    e.next_event_seq = u64(at(d, "nextEventSeq")); e.acked_through_event_seq = u64(at(d, "ackedThroughEventSeq"));
    if (e.next_event_seq == 0 || e.acked_through_event_seq >= e.next_event_seq) fail();
    e.retained_unacked = u64(at(d, "retainedUnacked")); if (e.retained_unacked > e.next_event_seq - 1 - e.acked_through_event_seq) fail(); m.end = std::move(e);
  }
  return m;
}
Message client_message(const Json& o, unsigned max) {
  record(o, {"version", "kind", "data"}); Message m; m.minor = version(at(o, "version"), max); m.sender = Sender::client;
  m.kind = choice(at(o, "kind"), client_kinds); const auto& d = at(o, "data");
  if (m.kind == "hello") {
    // A hello is always version 1.0; `ack` and `clock.probe` carry the connection's selected minor.
    if (m.minor != 0) fail("Unsupported protocol version");
    record(d, {"clientInstanceId", "minMinor", "maxMinor", "durableEvents"}); HelloView h; h.client_instance_id = uuid(at(d, "clientInstanceId"));
    const auto min_minor = std::get_if<double>(&at(d, "minMinor").value); if (!min_minor || *min_minor != 0) fail();
    h.max_minor = static_cast<std::uint16_t>(num(at(d, "maxMinor"), 0, 65535, true)); h.durable_events = boolean(at(d, "durableEvents")); m.hello = std::move(h);
  } else if (m.kind == "ack") {
    record(d, {"pluginSessionId", "throughEventSeq"}); m.ack = AckView{uuid(at(d, "pluginSessionId")), u64(at(d, "throughEventSeq"))};
  } else { record(d, {"probeId"}); m.clock_probe = ClockProbeView{u64(at(d, "probeId"))}; if (m.clock_probe->probe_id == 0) fail(); }
  return m;
}
std::size_t max_payload(Sender sender) { return sender == Sender::server ? limits.server_frame_bytes : limits.client_frame_bytes; }
// Converts any v0 JSON-layer error inside a public entry point into a v1 error.
template<class F> auto guarded(F f) -> decltype(f()) { try { return f(); } catch (const v0::ProtocolError&) { fail(); } }
// The views of a valid message, without `wire`.
Message views(const Json& j, Sender sender, unsigned max) {
  max_minor_of(max); return guarded([&] { return sender == Sender::server ? server_message(j, max) : client_message(j, max); });
}
}

Message validate(const Json& j, Sender sender, unsigned max_minor) { auto m = views(j, sender, max_minor); m.wire = j; return m; }
Message decode_payload(const std::string& bytes, Sender sender, unsigned max_minor) {
  max_minor_of(max_minor);
  if (bytes.empty() || bytes.size() > max_payload(sender)) fail("Protocol v1 payload size rejected");
  // The strict parser rejects invalid UTF-8, a BOM, duplicate keys, malformed numbers, lone surrogates, trailing data and depth above 16.
  Json parsed; try { parsed = v0::detail::Parser(bytes).parse(); } catch (const v0::ProtocolError&) { fail("Malformed protocol v1 JSON"); }
  auto m = views(parsed, sender, max_minor);
  if (m.kind == "event" && bytes.size() > limits.event_bytes) fail("Protocol v1 event size rejected");
  m.wire = std::move(parsed); return m;
}
std::vector<std::uint8_t> encode_frame(const Message& m, unsigned max_minor) {
  auto sender = Sender::server;
  if (const auto o = std::get_if<Json::Object>(&m.wire.value)) {
    const auto kind = o->find("kind"); const auto s = kind == o->end() ? nullptr : std::get_if<std::string>(&kind->second.value);
    if (s && std::any_of(std::begin(client_kinds), std::end(client_kinds), [&](const char* k) { return *s == k; })) sender = Sender::client;
  }
  // Validate first so an invalid caller-owned tree is never copied or serialized; then validate the serialized bytes.
  views(m.wire, sender, max_minor); std::string bytes;
  try { bytes = v0::detail::serialize(m.wire); } catch (const v0::ProtocolError&) { fail("Protocol v1 payload size rejected"); }
  decode_payload(bytes, sender, max_minor);
  const auto length = static_cast<std::uint32_t>(bytes.size()); std::vector<std::uint8_t> result(4 + bytes.size());
  for (unsigned i = 0; i < 4; ++i) result[i] = static_cast<std::uint8_t>((length >> (8 * i)) & 255);
  std::copy(bytes.begin(), bytes.end(), result.begin() + 4); return result;
}
Negotiated negotiate(const Message& input, bool allow_durable, unsigned max_minor) {
  const auto own = max_minor_of(max_minor); const auto hello = validate(input.wire, Sender::client); if (hello.kind != "hello") fail();
  // min(offer, own): a client that offers less than the server's maximum gets exactly its offer, never minor 0 by default.
  return {protocol_major, std::min<unsigned>(hello.hello->max_minor, own), hello.hello->durable_events && allow_durable};
}
Available<std::uint64_t> read_uint64(const Json& j) { return guarded([&] { return available<std::uint64_t>(j, [](const Json& v) { return u64(v); }); }); }
Measure read_measure(const Json& j, const char* unit) { return guarded([&] { return measure(j, unit, -max_double, max_double); }); }
Available<std::string> read_text(const Json& j, TextKind kind) {
  return guarded([&] { return available<std::string>(j, [kind](const Json& v) { return text(v, text_limit(kind), kind != TextKind::nonempty_id); }); });
}
Available<Money> read_money(const Json& j, SdkType type) { return guarded([&] { return money(j, type); }); }
GameMode read_game_mode(const Json& j) { return guarded([&] { exact(j, game_mode_keys, {}); return game_mode(j); }); }
Gearbox read_gearbox(const Json& j) { return guarded([&] { return gearbox(j); }); }

FrameDecoder::FrameDecoder(Sender peer, unsigned max_minor) : peer_(peer), max_minor_(max_minor_of(max_minor)) {}

void FrameDecoder::push(const std::uint8_t* data, std::size_t size, const std::function<void(Message)>& emit) {
  if (failed_) fail("Decoder is closed");
  if (pushing_) { failed_ = true; payload_.clear(); fail("Recursive decoding is unsupported"); }
  pushing_ = true;
  try {
    std::size_t offset = 0;
    while (offset < size) {
      if (!expected_) {
        const auto n = std::min(4 - header_used_, size - offset); std::copy_n(data + offset, n, header_ + header_used_); header_used_ += n; offset += n;
        if (header_used_ != 4) continue; std::uint32_t length = 0;
        for (unsigned i = 0; i < 4; ++i) length |= static_cast<std::uint32_t>(header_[i]) << (8 * i);
        // The direction limit applies to the prefix before any allocation.
        if (!length || length > max_payload(peer_)) fail("Protocol v1 payload size rejected"); expected_ = length; payload_.reserve(expected_);
      }
      const auto n = std::min(expected_ - payload_.size(), size - offset); payload_.append(reinterpret_cast<const char*>(data + offset), n); offset += n;
      if (payload_.size() == expected_) {
        auto m = decode_payload(payload_, peer_, max_minor_); payload_.clear(); expected_ = 0; header_used_ = 0; emit(std::move(m));
        if (failed_) break;
      }
    }
    pushing_ = false;
  } catch (...) { pushing_ = false; failed_ = true; payload_.clear(); throw; }
}
void FrameDecoder::end() {
  const auto truncated = failed_ || header_used_ != 0 || expected_ != 0; failed_ = true; payload_.clear();
  if (truncated) fail("Truncated or failed stream");
}

Measure km_to_meters_u32(const Available<double>& km) {
  if (!km.value) return {{std::nullopt, km.reason}, "m"};
  const auto v = *km.value; if (!std::isfinite(v) || std::trunc(v) != v || v < 0 || v > u32_max) return {{std::nullopt, Reason::invalid}, "m"};
  return {{v * 1000, Reason::not_observed}, "m"};
}
Measure km_to_meters_float(const Available<double>& km) {
  if (!km.value) return {{std::nullopt, km.reason}, "m"};
  const auto value = *km.value * 1000; if (!std::isfinite(value) || value < 0 || value > 1e12) return {{std::nullopt, Reason::invalid}, "m"};
  return {{value, Reason::not_observed}, "m"};
}
Measure fraction(const Available<double>& input) {
  if (!input.value) return {{std::nullopt, input.reason}, "fraction"};
  const auto v = *input.value; if (!std::isfinite(v) || v < 0 || v > 1000) return {{std::nullopt, Reason::invalid}, "fraction"};
  return {{v, Reason::not_observed}, "fraction"};
}
Available<Money> sdk_money(const std::string& raw, SdkType type, const Currency& c) {
  Money m; m.raw = raw; m.sdk_type = type; m.currency = c;
  try { const Json value{raw}; if (type == SdkType::s64) m.exact = s64(value); else m.exact = u64(value); } catch (const ProtocolError&) { return {std::nullopt, Reason::invalid}; }
  if (!valid_currency(c)) return {std::nullopt, Reason::invalid};
  return {m, Reason::not_observed};
}
Available<Money> sdk_money(std::int64_t raw, SdkType type, const Currency& c) { return sdk_money(std::to_string(raw), type, c); }
Available<Money> sdk_money(std::uint64_t raw, SdkType type, const Currency& c) { return sdk_money(std::to_string(raw), type, c); }
Available<std::string> sdk_text(const std::optional<std::string>& value, TextKind kind) {
  if (!value) return {std::nullopt, Reason::not_observed};
  if (!valid_text(*value, text_limit(kind), kind != TextKind::nonempty_id)) return {std::nullopt, Reason::invalid};
  return {*value, Reason::not_observed};
}
} // namespace ets2telemetry::v1
