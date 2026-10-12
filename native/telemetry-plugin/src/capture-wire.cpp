#include "capture-wire.hpp"
#include <stdexcept>

namespace ets2telemetry::cap0 {
namespace {
using v0::Json;
Json str(const std::string& value) { return Json{value}; }
Json u64(std::uint64_t value) { return Json{std::to_string(value)}; }
Json number(double value) { return Json{value}; }
Json integer(std::uint32_t value) { return Json{static_cast<double>(value)}; }
const char* reason(Status status) {
  switch (status) { case Status::not_observed: return "not-observed"; case Status::not_supported: return "not-supported"; default: return "invalid"; }
}
const char* detail(Detail value) {
  switch (value) {
    case Detail::null_value: return "null-value"; case Detail::too_long: return "too-long"; case Detail::invalid_utf8: return "invalid-utf8";
    case Detail::non_finite: return "non-finite"; case Detail::unsupported_type: return "unsupported-type"; case Detail::null_name: return "null-name";
    case Detail::null_attributes: return "null-attributes"; default: return "none";
  }
}
Json unavailable(Status status, const char* why) { return Json{Json::Object{{"available", Json{false}}, {"reason", str(reason(status))}, {"detail", str(why)}}}; }
Json available(Json value) { return Json{Json::Object{{"available", Json{true}}, {"value", std::move(value)}}}; }
Json text(const Text& t) { return t.status == Status::available ? available(str(t.value)) : unavailable(t.status, detail(t.detail)); }
const char* type_name(std::uint32_t type) {
  switch (type) {
    case SCS_VALUE_TYPE_bool: return "bool"; case SCS_VALUE_TYPE_s32: return "s32"; case SCS_VALUE_TYPE_u32: return "u32";
    case SCS_VALUE_TYPE_u64: return "u64"; case SCS_VALUE_TYPE_s64: return "s64"; case SCS_VALUE_TYPE_float: return "float";
    case SCS_VALUE_TYPE_double: return "double"; case SCS_VALUE_TYPE_fvector: return "fvector"; case SCS_VALUE_TYPE_dvector: return "dvector";
    case SCS_VALUE_TYPE_euler: return "euler"; case SCS_VALUE_TYPE_fplacement: return "fplacement"; case SCS_VALUE_TYPE_dplacement: return "dplacement";
    case SCS_VALUE_TYPE_string: return "string"; default: return "unknown";
  }
}
Json vector3(const std::array<double, 6>& n, std::size_t offset, bool euler) {
  return euler ? Json{Json::Object{{"heading", number(n[offset])}, {"pitch", number(n[offset + 1])}, {"roll", number(n[offset + 2])}}}
               : Json{Json::Object{{"x", number(n[offset])}, {"y", number(n[offset + 1])}, {"z", number(n[offset + 2])}}};
}
Json value(const Value& v) {
  if (v.status != Status::available) return unavailable(v.status, detail(v.detail));
  switch (v.type) {
    case SCS_VALUE_TYPE_bool: return available(Json{v.boolean});
    case SCS_VALUE_TYPE_s32: return available(number(static_cast<double>(v.signed_integer)));
    case SCS_VALUE_TYPE_u32: return available(number(static_cast<double>(v.unsigned_integer)));
    // 64-bit integers stay decimal strings: JSON numbers cannot carry them exactly in JavaScript.
    case SCS_VALUE_TYPE_s64: return available(str(std::to_string(v.signed_integer)));
    case SCS_VALUE_TYPE_u64: return available(u64(v.unsigned_integer));
    case SCS_VALUE_TYPE_float: case SCS_VALUE_TYPE_double: return available(number(v.numbers[0]));
    case SCS_VALUE_TYPE_fvector: case SCS_VALUE_TYPE_dvector: return available(vector3(v.numbers, 0, false));
    case SCS_VALUE_TYPE_euler: return available(vector3(v.numbers, 0, true));
    case SCS_VALUE_TYPE_fplacement: case SCS_VALUE_TYPE_dplacement:
      return available(Json{Json::Object{{"position", vector3(v.numbers, 0, false)}, {"orientation", vector3(v.numbers, 3, true)}}});
    case SCS_VALUE_TYPE_string: return available(str(v.text));
    default: return unavailable(Status::not_supported, "unsupported-type");
  }
}
Json observation(const Attribute& a, std::size_t position) {
  return Json{Json::Object{
    {"position", integer(static_cast<std::uint32_t>(position))}, {"name", text(a.name)},
    {"arrayIndex", a.index == SCS_U32_NIL ? unavailable(Status::not_supported, "none") : available(integer(a.index))},
    {"sdkType", str(type_name(a.value.type))}, {"sdkTypeId", integer(a.value.type)}, {"value", value(a.value)}}};
}
Json packet(const std::string& session, const char* kind, std::uint64_t seq, std::uint64_t publish_ns, Json data) {
  return Json{Json::Object{{"format", str(format)}, {"version", Json{Json::Object{{"major", number(0)}, {"minor", number(0)}}}}, {"kind", str(kind)},
    {"captureSessionId", str(session)}, {"packetSeq", u64(seq)}, {"publishMonotonicNs", u64(publish_ns)}, {"data", std::move(data)}}};
}
Json version(std::uint32_t packed) { return Json{Json::Object{{"major", integer(packed >> 16)}, {"minor", integer(packed & 0xffff)}}}; }
const char* group(Kind kind) { return kind == Kind::configuration ? "configuration" : kind == Kind::gameplay ? "gameplay" : "lifecycle"; }
const char* simulation(Simulation s) { return s == Simulation::running ? "running" : s == Simulation::paused ? "paused" : "unavailable"; }
}

std::string header_packet(const HeaderInfo& h, std::uint64_t packet_seq, std::uint64_t publish_ns) {
  Json image = h.image_available && h.image_path.size() <= 4096
    ? available(Json{Json::Object{{"path", str(h.image_path)}, {"sha256", str(h.image_sha256)}}})
    : unavailable(h.image_available ? Status::invalid : Status::not_observed, h.image_available ? "too-long" : "none");
  Json currency = h.currency_available ? available(Json{Json::Object{{"code", str(h.currency_code)}, {"source", str(h.currency_source)}}}) : unavailable(Status::not_supported, "none");
  Json data{Json::Object{
    {"origin", str(h.origin)},
    {"source", Json{Json::Object{{"game", str(h.game)}, {"sdkGameId", str(h.sdk_game_id)}, {"processId", integer(h.process_id)}, {"windowsSessionId", integer(h.windows_session_id)},
      {"processInstanceId", str(h.process_instance_id)}, {"pluginSessionId", str(h.plugin_session_id)}}}},
    {"versions", Json{Json::Object{{"telemetryApi", version(h.api_version)}, {"gameTelemetry", version(h.game_telemetry_version)}, {"sdkArchive", str("scs-sdk-1.15")}, {"pluginImage", image}}}},
    {"clocks", Json{Json::Object{{"sourceMonotonicClockId", str(h.source_clock_id)}, {"gameClockIdAtOpen", str(h.game_clock_id)}, {"openMonotonicNs", u64(h.open_monotonic_ns)}}}},
    {"currency", currency},
    {"publishedBoundaryOrderAtOpen", u64(h.boundary_at_open)},
    {"bounds", Json{Json::Object{{"queueEnvelopes", integer(queue_envelopes)}, {"queueBytes", integer(queue_bytes)}, {"packetBytes", integer(max_packet_bytes)},
      {"attributeScan", integer(attribute_scan)}, {"identifierBytes", integer(identifier_bytes)}, {"stringBytes", integer(string_bytes)}}}}}};
  return v0::detail::serialize(packet(h.capture_session_id, "header", packet_seq, publish_ns, std::move(data)));
}
std::string loss_packet(const std::string& session, const Counters& c, std::uint64_t packet_seq, std::uint64_t publish_ns) {
  Json data{Json::Object{{"attemptedEnvelopes", u64(c.attempted)}, {"droppedEnvelopes", u64(c.dropped)}, {"droppedBytes", u64(c.dropped_bytes)},
    {"droppedQueueFull", u64(c.dropped_full_slots)}, {"droppedBytesFull", u64(c.dropped_full_bytes)},
    {"lastDroppedEnvelopeSeq", c.dropped ? available(u64(c.last_dropped_seq)) : unavailable(Status::not_observed, "none")},
    {"lastDropMonotonicNs", c.last_drop_available ? available(u64(c.last_drop_monotonic_ns)) : unavailable(Status::not_observed, "none")}}};
  return v0::detail::serialize(packet(session, "loss", packet_seq, publish_ns, std::move(data)));
}
std::string end_packet(const std::string& session, const EndInfo& e, std::uint64_t packet_seq, std::uint64_t publish_ns) {
  const char* why = e.reason == EndReason::source_retired ? "source-retired" : e.reason == EndReason::encoding_failed ? "encoding-failed" : "plugin-shutdown";
  Json data{Json::Object{{"reason", str(why)}, {"attemptedEnvelopes", u64(e.counters.attempted)}, {"enqueuedEnvelopes", u64(e.counters.enqueued)},
    {"publishedEnvelopes", u64(e.published)}, {"droppedEnvelopes", u64(e.counters.dropped)}, {"droppedBytes", u64(e.counters.dropped_bytes)}, {"unsentEnvelopes", u64(e.unsent)}}};
  return v0::detail::serialize(packet(session, "end", packet_seq, publish_ns, std::move(data)));
}
std::vector<std::string> envelope_packets(const std::string& session, const Envelope& e, std::uint64_t& packet_seq, std::uint64_t publish_ns, std::size_t limit) {
  if (limit > max_packet_bytes) throw std::runtime_error("cap0-packet-limit");
  std::vector<std::string> observations; observations.reserve(e.attributes.size());
  for (std::size_t i = 0; i < e.attributes.size(); ++i) observations.push_back(v0::detail::serialize(observation(e.attributes[i], i)));
  const auto total = static_cast<std::uint32_t>(e.attributes.size());
  auto build = [&](std::size_t first, std::size_t count, bool final, std::uint64_t seq, bool with_observations) {
    Json::Array items;
    if (with_observations) for (std::size_t i = first; i < first + count; ++i) items.push_back(observation(e.attributes[i], i));
    Json frame_times = e.frame_available
      ? available(Json{Json::Object{{"renderTimeUs", u64(e.render_us)}, {"simulationTimeUs", u64(e.simulation_us)}, {"pausedSimulationTimeUs", u64(e.paused_simulation_us)}}})
      : unavailable(Status::not_observed, "none");
    Json data{Json::Object{
      {"envelopeSeq", u64(e.seq)}, {"droppedBefore", u64(e.dropped_before)},
      {"callback", Json{Json::Object{{"group", str(group(e.kind))}, {"id", text(e.id)}}}},
      {"sharedBoundaryOrder", u64(e.boundary_order)}, {"configurationRevision", u64(e.configuration_revision)},
      {"callbackMonotonicNs", e.monotonic_available ? available(u64(e.monotonic_ns)) : unavailable(Status::invalid, "none")},
      {"sdkFrame", frame_times},
      {"gameTime", Json{Json::Object{{"minutes", e.game_time_status == Status::available ? available(u64(e.game_time_minutes)) : unavailable(e.game_time_status, "none")}, {"clockId", str(e.game_clock_id)}}}},
      {"simulation", str(simulation(e.simulation))},
      {"attributes", Json{Json::Object{{"expected", Json{e.attributes_expected}}, {"present", Json{e.attributes_expected && !e.attributes_null}}, {"terminated", Json{e.terminated}},
        {"total", integer(total)}, {"first", integer(static_cast<std::uint32_t>(first))}, {"count", integer(static_cast<std::uint32_t>(count))}, {"final", Json{final}},
        // An unterminated scan proves at least one more attribute existed beyond the cap.
        {"omittedLowerBound", integer(e.terminated ? 0U : 1U)}}}},
      {"observations", Json{std::move(items)}}}};
    return packet(session, "envelope", seq, publish_ns, std::move(data));
  };
  std::vector<std::string> output; std::size_t first = 0;
  do {
    // Overhead with the widest counters this packet can carry; then add serialized observations.
    const auto overhead = v0::detail::serialize(build(first, total, false, packet_seq, false)).size() + 16;
    std::size_t count = 0, size = overhead;
    while (first + count < total) {
      const auto next = observations[first + count].size() + (count ? 1 : 0);
      if (size + next > limit) break;
      size += next; ++count;
    }
    if (first < total && count == 0) throw std::runtime_error("cap0-packet-limit");
    const bool final = first + count == total;
    auto bytes = v0::detail::serialize(build(first, count, final, packet_seq, true));
    if (bytes.size() > limit) throw std::runtime_error("cap0-packet-limit");
    output.push_back(std::move(bytes)); first += count;
    if (packet_seq == UINT64_MAX) throw std::runtime_error("cap0-packet-sequence");
    ++packet_seq;
  } while (first < total);
  return output;
}
std::vector<std::uint8_t> frame(const std::string& payload) {
  if (payload.empty() || payload.size() > max_packet_bytes) throw std::runtime_error("cap0-packet-limit");
  const auto n = static_cast<std::uint32_t>(payload.size());
  std::vector<std::uint8_t> output{static_cast<std::uint8_t>(n), static_cast<std::uint8_t>(n >> 8), static_cast<std::uint8_t>(n >> 16), static_cast<std::uint8_t>(n >> 24)};
  output.insert(output.end(), payload.begin(), payload.end()); return output;
}
}
