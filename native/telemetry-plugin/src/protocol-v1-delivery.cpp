#include "protocol-v1-delivery.hpp"
#include <algorithm>
#include <iterator>

namespace ets2telemetry::v1 {
namespace {
[[noreturn]] void fail(const char* reason = "Protocol v1 delivery violation") { throw ProtocolError(reason); }
bool uuid(const std::string& s) {
  if (s.size() != 36) return false;
  for (std::size_t i = 0; i < s.size(); ++i) {
    const bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? s[i] != '-' : !((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  } return true;
}
// An unsigned 65-bit value (carry, low) for exact sums of two uint64 values without __int128.
struct Wide { std::uint64_t high = 0, low = 0; };
Wide add(std::uint64_t a, std::uint64_t b) { const auto low = a + b; return {low < a ? 1U : 0U, low}; }
bool less(const Wide& a, const Wide& b) { return a.high != b.high ? a.high < b.high : a.low < b.low; }
// Requires a >= b, so the difference is non-negative and at most 2^65 - 2.
Wide subtract(const Wide& a, const Wide& b) { return {a.high - b.high - (a.low < b.low ? 1U : 0U), a.low - b.low}; }
// floor(d / 2) fits in uint64 because d <= 2^65 - 2.
std::uint64_t half(const Wide& d) { return (d.high << 63) | (d.low >> 1); }
}

Applied Consumer::accept(const Message& input) {
  try {
    if (phase_ == Phase::closed) fail("Consumer is closed");
    const auto m = validate(input.wire, Sender::server); const auto seq = m.seq, capture = m.capture.monotonic_ns; const auto& s = *m.source;
    // Identity comparison does not depend on JSON member order.
    const auto identity = s.game + '|' + s.plugin_session_id + '|' + s.process_instance_id + '|' + std::to_string(s.process_id) + '|' + std::to_string(s.windows_session_id) + '|' + s.origin;
    if (phase_ == Phase::welcome) {
      if (m.kind != "welcome" || (m.welcome->durable_events && !durable_requested_)) fail("Welcome expected");
      identity_ = identity; clock_ = m.capture.clock_id; durable_ = m.welcome->durable_events; plugin_session_id_ = s.plugin_session_id;
      event_types_ = std::set<std::string>(m.welcome->event_types.begin(), m.welcome->event_types.end());
      last_seq_ = seq; last_capture_ = capture; phase_ = Phase::checkpoint; return {};
    }
    if (identity != identity_ || m.capture.clock_id != clock_ || seq <= last_seq_ || capture < last_capture_) fail("Source identity, clock or order violation");
    if (m.kind == "welcome" || (phase_ == Phase::checkpoint ? m.kind != "checkpoint" && m.kind != "end" : m.kind == "checkpoint")) fail("Unexpected message for phase");
    Applied result{m.kind == "checkpoint", seq - last_seq_ - 1, std::nullopt};
    if (m.state) {
      const auto& status = m.state->status;
      if (status.delivery.durable != durable_ || m.state->boundary_order < state_boundary_) fail("State order violation");
      if (m.kind == "checkpoint") { next_event_ = status.delivery.acked_through_event_seq + 1; live_from_ = status.delivery.next_event_seq; }
      check_status(status, m.state->continuity); state_boundary_ = m.state->boundary_order;
    } else if (m.event || m.gap) {
      if (!durable_) fail("Durable stream not granted");
      const auto first = m.event ? m.event->event_seq : m.gap->first_event_seq, last = m.event ? first : m.gap->last_event_seq;
      const auto redelivered = m.event ? m.event->redelivered : m.gap->redelivered;
      // Coverage is contiguous: a duplicate or a skip within one connection is a violation, never a silent loss.
      if (first != next_event_ || (first >= live_from_ && redelivered)) fail("eventSeq coverage violation");
      if (m.event) {
        const auto boundary = m.event->occurred.boundary_order, revision = m.event->occurred.configuration_revision;
        if (!event_types_.count(m.event->record_type) || boundary < event_boundary_ || revision < event_revision_) fail("Event order violation");
        event_boundary_ = boundary; event_revision_ = revision;
      }
      next_event_ = last + 1; result.coverage = Coverage{first, last};
    } else if (m.clock_reply) {
      if (!probe_ || m.clock_reply->probe_id != *probe_) fail("Unsolicited clock reply");
      probe_.reset();
    } else if (m.end) {
      // Before the checkpoint the delivery cursor is unknown, so only the schema rules apply to an early end.
      const auto acked = m.end->acked_through_event_seq;
      if (status_ && (m.end->next_event_seq < next_event_ || acked > next_event_ - 1 || acked < status_->delivery.acked_through_event_seq)) fail("End marker inconsistent");
      last_seq_ = seq; last_capture_ = capture; phase_ = Phase::closed; return result;
    }
    last_seq_ = seq; last_capture_ = capture; phase_ = Phase::live; return result;
  } catch (...) { phase_ = Phase::closed; throw; }
}
void Consumer::check_status(const SourceStatus& s, const Continuity& continuity) {
  const auto acked = s.delivery.acked_through_event_seq;
  // The producer accepts an ACK only for eventSeqs already sent on this connection.
  if (acked > next_event_ - 1) fail("Acknowledged beyond delivered coverage");
  // Every eventSeq already covered on this connection was assigned, so nextEventSeq cannot be below it (as for `end`).
  if (s.delivery.next_event_seq < next_event_) fail("nextEventSeq below delivered coverage");
  if (status_) {
    const auto& p = status_->event_loss; const auto& n = s.event_loss;
    if (acked < status_->delivery.acked_through_event_seq || s.delivery.next_event_seq < status_->delivery.next_event_seq ||
      n.offline < p.offline || n.no_durable_consumer < p.no_durable_consumer || n.queue_count < p.queue_count || n.queue_bytes < p.queue_bytes ||
      n.retention_expired < p.retention_expired || n.encoding_failed < p.encoding_failed) fail("Status counters regressed");
  }
  if (continuity_ && (continuity.coalesced_snapshots < continuity_->coalesced_snapshots || continuity.offline_transitions < continuity_->offline_transitions)) fail("Continuity counters regressed");
  status_ = s; continuity_ = continuity;
}
void Consumer::expect_clock_reply(std::uint64_t probe_id) {
  try {
    if (probe_id < 1) fail("Invalid uint64 value");
    if (phase_ == Phase::closed || probe_ || probe_id <= last_probe_) fail("Clock probe not allowed");
    probe_ = probe_id; last_probe_ = probe_id;
  } catch (...) { phase_ = Phase::closed; throw; }
}

DurableAckCursor::DurableAckCursor(std::string plugin_session_id, std::uint64_t committed_through_event_seq)
  : plugin_session_id_(std::move(plugin_session_id)), through_(committed_through_event_seq), received_through_(committed_through_event_seq) {
  if (!uuid(plugin_session_id_)) fail("Invalid plugin session");
}
void DurableAckCursor::begin_connection(std::uint64_t acked) {
  if (acked > through_) fail("Producer acknowledged beyond local commits");
  connection_ = Connection{acked, acked};
}
void DurableAckCursor::received(std::uint64_t first, std::uint64_t last) {
  if (first < 1 || last < 1) fail("Invalid uint64 value");
  if (!connection_) fail("No connection started");
  if (last < first || first - 1 > connection_->received_through) fail("Received coverage is not contiguous");
  if (last > received_through_) received_through_ = last;
  if (last > connection_->received_through) connection_->received_through = last;
}
bool DurableAckCursor::is_committed(std::uint64_t event_seq) const {
  if (event_seq < 1) fail("Invalid uint64 value");
  return event_seq <= through_ || std::any_of(pending_.begin(), pending_.end(), [&](const auto& r) { return r.first <= event_seq && event_seq <= r.second; });
}
DurableAckCursor::CommitResult DurableAckCursor::commit(std::uint64_t a, std::uint64_t b) {
  if (a < 1 || b < 1) fail("Invalid uint64 value");
  if (b < a || b > received_through_) fail("Commit outside received coverage");
  if (b <= through_ || std::any_of(pending_.begin(), pending_.end(), [&](const auto& r) { return r.first <= a && b <= r.second; })) return CommitResult::duplicate;
  auto ranges = pending_; ranges.emplace_back(a > through_ ? a : through_ + 1, b); std::sort(ranges.begin(), ranges.end());
  std::vector<std::pair<std::uint64_t, std::uint64_t>> merged;
  // Every range starts at 1 or later, so `first - 1` never wraps.
  for (const auto& r : ranges) {
    if (!merged.empty() && r.first - 1 <= merged.back().second) { if (r.second > merged.back().second) merged.back().second = r.second; }
    else merged.push_back(r);
  }
  std::size_t used = 0;
  for (; used < merged.size() && merged[used].first - 1 <= through_; ++used) if (merged[used].second > through_) through_ = merged[used].second;
  pending_.assign(merged.begin() + static_cast<std::ptrdiff_t>(used), merged.end()); return CommitResult::committed;
}
std::optional<Message> DurableAckCursor::ack() {
  if (!connection_) return std::nullopt;
  const auto through = std::min(through_, connection_->received_through);
  if (through <= connection_->last_ack) return std::nullopt;
  connection_->last_ack = through;
  const Json wire{Json::Object{
    {"version", Json{Json::Object{{"major", Json{1.0}}, {"minor", Json{0.0}}}}}, {"kind", Json{std::string("ack")}},
    {"data", Json{Json::Object{{"pluginSessionId", Json{plugin_session_id_}}, {"throughEventSeq", Json{std::to_string(through)}}}}}}};
  return validate(wire, Sender::client);
}

AckValidator::AckValidator(std::string plugin_session_id, bool durable_events) : plugin_session_id_(std::move(plugin_session_id)), durable_events_(durable_events) {
  if (!uuid(plugin_session_id_)) fail("Invalid plugin session");
}
void AckValidator::checkpoint(std::uint64_t acked) {
  if (acked_) { closed_ = true; fail("Second checkpoint"); }
  acked_ = acked; sent_through_ = acked;
}
void AckValidator::sent(std::uint64_t last_event_seq) {
  if (last_event_seq < 1) fail("Invalid uint64 value");
  if (!acked_ || !durable_events_) { closed_ = true; fail("Event coverage without a durable checkpoint"); }
  if (last_event_seq > sent_through_) sent_through_ = last_event_seq;
}
std::optional<std::uint64_t> AckValidator::accept(const Message& input) {
  try {
    if (closed_) fail("ACK validator is closed");
    const auto m = validate(input.wire, Sender::client); if (m.kind != "ack") fail("ACK expected");
    const auto through = m.ack->through_event_seq;
    if (!durable_events_) fail("ACK from a live-only client");
    if (!acked_) fail("ACK before checkpoint");
    if (m.ack->plugin_session_id != plugin_session_id_) fail("ACK for a foreign plugin session");
    if (through > sent_through_) fail("ACK beyond the sent range");
    if (through < *acked_) fail("ACK regressed");
    if (through == *acked_) return std::nullopt;
    acked_ = through; return through;
  } catch (...) { closed_ = true; throw; }
}

std::optional<ClockMapping> compute_clock_mapping(const Message& input, std::uint64_t probe_id, const std::string& client_clock_id,
  std::uint64_t t0, std::uint64_t t3) {
  const auto reply = validate(input.wire, Sender::server);
  if (reply.kind != "clock.reply" || reply.clock_reply->probe_id != probe_id || !uuid(client_clock_id)) fail("Clock reply mismatch");
  const auto t1 = reply.clock_reply->received_monotonic_ns, t2 = reply.clock_reply->sent_monotonic_ns;
  if (t3 < t0) fail("Clock reply received before its probe was sent");
  // The schema guarantees t1 <= t2, so both intervals are exact. An impossible round trip is rejected before the
  // lateness check, so a late reply cannot hide it.
  const auto client_interval = t3 - t0, source_interval = t2 - t1;
  if (source_interval > client_interval) fail("Negative clock round trip");
  if (client_interval > clock_reply_deadline_ns) return std::nullopt;
  const auto rtt = client_interval - source_interval;
  // offset = floor(((t1 + t2) - (t0 + t3)) / 2); a negative difference -d rounds down to -ceil(d / 2).
  const auto source_sum = add(t1, t2), client_sum = add(t0, t3);
  std::string offset;
  if (!less(source_sum, client_sum)) offset = std::to_string(half(subtract(source_sum, client_sum)));
  else { const auto d = subtract(client_sum, source_sum); offset = "-" + std::to_string(half(d) + (d.low & 1)); }
  return ClockMapping{reply.capture.clock_id, client_clock_id, offset, rtt / 2 + rtt % 2, t3};
}
bool is_clock_mapping_current(const ClockMapping& mapping, const std::string& source_clock_id, const std::string& client_clock_id) {
  return mapping.source_clock_id == source_clock_id && mapping.client_clock_id == client_clock_id;
}
} // namespace ets2telemetry::v1
