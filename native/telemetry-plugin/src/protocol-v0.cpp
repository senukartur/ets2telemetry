#include "protocol-v0.hpp"
#include "protocol-json.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <regex>
#include <set>

namespace ets2telemetry::v0 {
using detail::fail;
const Json& Json::at(const std::string& key) const {
  const auto o = std::get_if<Object>(&value); if (!o) fail(); const auto it = o->find(key); if (it == o->end()) fail(); return it->second;
}
const std::string& Json::string() const { const auto s = std::get_if<std::string>(&value); if (!s) fail(); return *s; }
double Json::number() const { const auto n = std::get_if<double>(&value); if (!n) fail(); return *n; }
bool Json::boolean() const { const auto b = std::get_if<bool>(&value); if (!b) fail(); return *b; }
namespace {
void object(const Json& j, std::initializer_list<const char*> keys) {
  const auto o = std::get_if<Json::Object>(&j.value); if (!o || o->size() != keys.size()) fail(); for (auto key : keys) j.at(key);
}
std::string text(const Json& j, std::size_t max = 128, bool allow_empty = false) {
  const auto& s = j.string(); if ((!allow_empty && s.empty()) || s.size() > max) fail(); detail::utf8(s);
  for (auto c : s) if (static_cast<unsigned char>(c) < 32 || c == 127) fail(); return s;
}
std::string uuid(const Json& j) {
  const auto& s = j.string(); if (s.size() != 36) fail(); static const std::regex pattern("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
  if (!std::regex_match(s, pattern)) fail(); return s;
}
double number(const Json& j, double min, double max, bool integer = false) {
  auto n = j.number(); if (!std::isfinite(n) || n < min || n > max || (integer && std::trunc(n) != n)) fail(); return n;
}
std::string choice(const Json& j, std::initializer_list<const char*> options) {
  const auto& s = j.string(); if (s.size() > 128 || std::find(options.begin(), options.end(), s) == options.end()) fail(); return s;
}
AvailabilityReason reason(const Json& j) {
  const auto s = choice(j, {"not-supported", "not-observed", "invalid"});
  return s == "invalid" ? AvailabilityReason::invalid : s == "not-supported" ? AvailabilityReason::not_supported : AvailabilityReason::not_observed;
}
template<class T, class F> Available<T> available(const Json& j, F read, std::initializer_list<const char*> extra = {}) {
  const auto flag = j.at("available").boolean(); const auto o = std::get_if<Json::Object>(&j.value);
  if (!o || o->size() != 2 + extra.size()) fail(); for (auto key : extra) j.at(key);
  Available<T> a; if (flag) a.value = read(j.at("value")); else a.reason = reason(j.at("reason")); return a;
}
Measure measure(const Json& j, const char* unit, double min, double max, bool integer = false) {
  auto a = available<double>(j, [=](const Json& v) { return number(v, min, max, integer); }, {"unit"});
  if (j.at("unit").string() != unit) fail(); return {a, unit};
}
Continuity continuity(const Json& j) {
  object(j, {"coalescedSnapshots", "lostObservations", "offlineTransitions"});
  return {parse_uint64(j.at("coalescedSnapshots")), parse_uint64(j.at("lostObservations")), parse_uint64(j.at("offlineTransitions"))};
}
CurrentState state(const Json& j) {
  object(j, {"simulation", "speed", "fuel", "fuelCapacity", "engineRpm", "gear", "odometer", "averageConsumption", "estimatedRange", "gameTime", "captureUtcUnixMs", "configuration", "window"});
  CurrentState s; s.simulation = choice(j.at("simulation"), {"running", "paused", "unavailable"});
  s.speed = measure(j.at("speed"), "m/s", -1000, 1000); s.fuel = measure(j.at("fuel"), "L", 0, 1e6);
  s.fuel_capacity = measure(j.at("fuelCapacity"), "L", 0, 1e6); s.engine_rpm = measure(j.at("engineRpm"), "rpm", 0, 100000);
  s.gear = measure(j.at("gear"), "index", -100, 100, true); s.odometer = measure(j.at("odometer"), "m", 0, 1e12);
  s.average_consumption = measure(j.at("averageConsumption"), "L/100km", 0, 1e6); s.estimated_range = measure(j.at("estimatedRange"), "m", 0, 1e12);
  const auto& gt = j.at("gameTime"); s.game_time_minutes = available<std::uint64_t>(gt, parse_uint64, {"unit", "clockId"});
  if (gt.at("unit").string() != "min") fail(); s.game_clock_id = uuid(gt.at("clockId"));
  s.capture_utc_unix_ms = available<std::uint64_t>(j.at("captureUtcUnixMs"), parse_uint64);
  const auto& config = j.at("configuration"); object(config, {"revision", "truckId", "job"});
  s.configuration.revision = parse_uint64(config.at("revision"));
  s.configuration.truck_id = available<std::string>(config.at("truckId"), [](const Json& v) { return text(v); });
  s.configuration.job = available<Job>(config.at("job"), [](const Json& v) {
    object(v, {"cargoId", "destinationCityId", "plannedDistance", "expectedIncome"}); Job job;
    job.cargo_id = text(v.at("cargoId")); job.destination_city_id = text(v.at("destinationCityId"));
    job.planned_distance = measure(v.at("plannedDistance"), "m", 0, 1e12);
    const auto& money = v.at("expectedIncome"); object(money, {"rawValue", "currency"}); job.expected_income.raw_value = text(money.at("rawValue"), 28);
    static const std::regex raw("-?(0|[1-9][0-9]{0,19})(\\.[0-9]{1,6})?"); if (!std::regex_match(job.expected_income.raw_value, raw)) fail();
    const auto& currency = money.at("currency"); const auto status = choice(currency.at("status"), {"unknown", "verified"});
    if (status == "unknown") object(currency, {"status"});
    else {
      object(currency, {"status", "code", "source"}); if (status != "verified") fail(); const auto& code = currency.at("code").string();
      if (code.size() != 3 || !std::all_of(code.begin(), code.end(), [](char c) { return c >= 'A' && c <= 'Z'; })) fail();
      job.expected_income.currency_code = code; job.expected_income.verified_source = text(currency.at("source"));
    } return job;
  });
  s.window = available<GameWindow>(j.at("window"), [](const Json& v) {
    object(v, {"handle", "x", "y", "width", "height", "dpi", "foreground", "minimized", "displayMode"}); GameWindow w;
    w.handle = parse_uint64(v.at("handle")); if (!w.handle) fail();
    w.x = static_cast<std::int32_t>(number(v.at("x"), -1e6, 1e6, true)); w.y = static_cast<std::int32_t>(number(v.at("y"), -1e6, 1e6, true));
    w.width = static_cast<std::uint32_t>(number(v.at("width"), 0, 100000, true)); w.height = static_cast<std::uint32_t>(number(v.at("height"), 0, 100000, true));
    w.dpi = static_cast<std::uint32_t>(number(v.at("dpi"), 1, 1000, true)); w.foreground = v.at("foreground").boolean(); w.minimized = v.at("minimized").boolean();
    w.display_mode = choice(v.at("displayMode"), {"windowed", "borderless", "exclusive", "unknown"}); return w;
  }); return s;
}
Message validate(const Json& j) {
  Message m; m.kind = choice(j.at("kind"), {"hello", "welcome", "checkpoint", "snapshot", "diagnostic"});
  if (m.kind == "hello") object(j, {"version", "kind", "data"}); else object(j, {"version", "kind", "source", "seq", "capture", "data"});
  const auto& version = j.at("version"); object(version, {"major", "minor"});
  if (version.at("major").number() != 0 || version.at("minor").number() != 0) throw ProtocolError("Unsupported protocol version");
  const auto& d = j.at("data");
  if (m.kind == "hello") {
    object(d, {"clientInstanceId", "minMinor", "maxMinor", "diagnostics"}); m.client_instance_id = uuid(d.at("clientInstanceId"));
    if (d.at("minMinor").number() != 0) fail(); m.max_minor = static_cast<std::uint16_t>(number(d.at("maxMinor"), 0, 65535, true));
    m.diagnostics = d.at("diagnostics").boolean();
  } else {
    const auto& s = j.at("source"); object(s, {"game", "pluginSessionId", "processInstanceId", "processId", "windowsSessionId", "origin"});
    m.source = SourceIdentity{choice(s.at("game"), {"ets2", "ats"}), uuid(s.at("pluginSessionId")), uuid(s.at("processInstanceId")), choice(s.at("origin"), {"game", "synthetic", "replay"}),
      static_cast<std::uint32_t>(number(s.at("processId"), 1, 4294967295., true)), static_cast<std::uint32_t>(number(s.at("windowsSessionId"), 0, 4294967295., true))};
    m.seq = parse_uint64(j.at("seq")); const auto& capture = j.at("capture"); object(capture, {"clockId", "monotonicNs"});
    m.capture = {uuid(capture.at("clockId")), parse_uint64(capture.at("monotonicNs"))};
    if (m.kind == "welcome") {
      object(d, {"diagnostics", "durableRecording"}); m.diagnostics = d.at("diagnostics").boolean(); if (d.at("durableRecording").boolean()) fail();
    } else if (m.kind == "snapshot" || m.kind == "checkpoint") {
      if (m.kind == "checkpoint") { object(d, {"boundarySeq", "state", "continuity"}); if (parse_uint64(d.at("boundarySeq")) != m.seq) fail(); }
      else object(d, {"state", "continuity"}); m.state = state(d.at("state")); m.continuity = continuity(d.at("continuity"));
    } else if (m.kind == "diagnostic") {
      object(d, {"copied", "observations", "continuity"}); if (!d.at("copied").boolean()) fail(); m.continuity = continuity(d.at("continuity"));
      const auto a = std::get_if<Json::Array>(&d.at("observations").value); if (!a || a->size() > max_observations) fail(); std::set<std::string> channels;
      for (const auto& obs : *a) {
        object(obs, {"channel", "sdkType", "value", "unit"}); Observation o;
        o.channel = text(obs.at("channel")); o.unit = text(obs.at("unit"), 32); if (!channels.insert(o.channel).second) fail();
        o.sdk_type = choice(obs.at("sdkType"), {"bool", "s32", "u32", "u64", "float", "double", "string"});
        o.reading = available<DiagnosticValue>(obs.at("value"), [&](const Json& raw) -> DiagnosticValue {
          if (o.sdk_type == "bool") return raw.boolean();
          if (o.sdk_type == "u64") return parse_uint64(raw);
          if (o.sdk_type == "string") return text(raw, 1024, true);
          if (o.sdk_type == "s32") return number(raw, -2147483648., 2147483647., true);
          if (o.sdk_type == "u32") return number(raw, 0, 4294967295., true);
          if (o.sdk_type == "float") return number(raw, -3.4028234663852886e38, 3.4028234663852886e38);
          return number(raw, -std::numeric_limits<double>::max(), std::numeric_limits<double>::max());
        }); m.observations.push_back(std::move(o));
      }
    } else fail();
  } m.wire = j; return m;
}
std::string identity(const SourceIdentity& s) {
  return s.game + '|' + s.plugin_session_id + '|' + s.process_instance_id + '|' + std::to_string(s.process_id) + '|' + std::to_string(s.windows_session_id) + '|' + s.origin;
}
}
std::uint64_t parse_uint64(const Json& j) {
  const auto& s = j.string(); if (s.empty() || s.size() > 20 || (s.size() > 1 && s[0] == '0') || !std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; })) fail();
  if (s.size() == 20 && s > "18446744073709551615") fail(); std::uint64_t n = 0;
  for (char c : s) n = n * 10 + static_cast<unsigned>(c - '0'); return n;
}
Message decode_payload(const std::string& bytes) {
  if (bytes.empty() || bytes.size() > max_frame_bytes) fail(); return validate(detail::Parser(bytes).parse());
}
std::vector<std::uint8_t> encode_frame(const Message& m) {
  validate(m.wire); const auto bytes = detail::serialize(m.wire); decode_payload(bytes);
  const auto length = static_cast<std::uint32_t>(bytes.size()); std::vector<std::uint8_t> result(4 + bytes.size());
  for (unsigned i = 0; i < 4; ++i) result[i] = static_cast<std::uint8_t>((length >> (8 * i)) & 255);
  std::copy(bytes.begin(), bytes.end(), result.begin() + 4); return result;
}
Negotiated negotiate(const Message& input) {
  auto hello = validate(input.wire); if (hello.kind != "hello") fail(); return {0, 0, hello.diagnostics, false};
}
Measure normalize_sdk_measurement(SdkField field, Available<double> input) {
  std::string unit; double multiplier = 1, min = 0, max = 0;
  switch (field) {
    case SdkField::speed: unit = "m/s"; min = -1000; max = 1000; break;
    case SdkField::fuel: case SdkField::fuel_capacity: unit = "L"; max = 1e6; break;
    case SdkField::engine_rpm: unit = "rpm"; max = 100000; break;
    case SdkField::gear: unit = "index"; min = -100; max = 100; break;
    case SdkField::odometer: case SdkField::estimated_range: unit = "m"; multiplier = 1000; max = 1e12; break;
    case SdkField::average_consumption: unit = "L/100km"; multiplier = 100; max = 1e6; break;
    default: fail();
  }
  if (!input.value) return {input, unit}; const auto value = *input.value * multiplier;
  if (!std::isfinite(value) || value < min || value > max || (field == SdkField::gear && std::trunc(value) != value)) return {{std::nullopt, AvailabilityReason::invalid}, unit};
  return {{value, AvailabilityReason::not_observed}, unit};
}
void FrameDecoder::push(const std::uint8_t* data, std::size_t size, const std::function<void(Message)>& emit) {
  if (failed_) throw ProtocolError("Decoder is closed");
  if (pushing_) { failed_ = true; payload_.clear(); throw ProtocolError("Recursive decoding is unsupported"); }
  pushing_ = true;
  try {
    std::size_t offset = 0;
    while (offset < size) {
      if (!expected_) {
        const auto n = std::min(4 - header_used_, size - offset); std::copy_n(data + offset, n, header_ + header_used_); header_used_ += n; offset += n;
        if (header_used_ != 4) continue; std::uint32_t length = 0;
        for (unsigned i = 0; i < 4; ++i) length |= static_cast<std::uint32_t>(header_[i]) << (8 * i);
        if (!length || length > max_frame_bytes) fail(); expected_ = length; payload_.reserve(expected_);
      }
      const auto n = std::min(expected_ - payload_.size(), size - offset); payload_.append(reinterpret_cast<const char*>(data + offset), n); offset += n;
      if (payload_.size() == expected_) {
        auto m = decode_payload(payload_); payload_.clear(); expected_ = 0; header_used_ = 0; emit(std::move(m));
        if (failed_) break;
      }
    }
    pushing_ = false;
  } catch (...) { pushing_ = false; failed_ = true; payload_.clear(); throw; }
}
void FrameDecoder::end() {
  const auto truncated = failed_ || header_used_ != 0 || expected_ != 0; failed_ = true; payload_.clear();
  if (truncated) throw ProtocolError("Truncated or failed stream");
}
std::optional<AppliedState> Consumer::accept(const Message& input) {
  try {
    // Never trust a manually assembled native Message: wire is authoritative and revalidated.
    const auto m = validate(input.wire); if (!m.source || phase_ == Phase::closed) fail();
    auto id = identity(*m.source);
    if (phase_ == Phase::welcome) {
      if (m.kind != "welcome" || (m.diagnostics && !diagnostics_requested_)) fail();
      identity_ = id; clock_ = m.capture.clock_id; last_seq_ = m.seq; last_capture_ = m.capture.monotonic_ns;
      diagnostics_enabled_ = m.diagnostics; phase_ = Phase::checkpoint; return {};
    }
    if (id != identity_ || m.capture.clock_id != clock_ || m.seq <= last_seq_ || m.capture.monotonic_ns < last_capture_) fail();
    if (phase_ == Phase::checkpoint && m.kind != "checkpoint") fail();
    if (phase_ == Phase::live && (m.kind == "welcome" || m.kind == "checkpoint")) fail();
    if (m.kind == "welcome" || (m.kind == "diagnostic" && !diagnostics_enabled_)) fail();
    if (counters_ && (m.continuity.coalesced_snapshots < counters_->coalesced_snapshots || m.continuity.lost_observations < counters_->lost_observations || m.continuity.offline_transitions < counters_->offline_transitions)) fail();
    AppliedState a{m.kind == "checkpoint", m.seq - last_seq_ - 1, m.continuity};
    last_seq_ = m.seq; last_capture_ = m.capture.monotonic_ns; counters_ = m.continuity; phase_ = Phase::live; return a;
  } catch (...) { phase_ = Phase::closed; throw; }
}
} // namespace ets2telemetry::v0
