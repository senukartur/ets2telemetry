#include "protocol-v1-store.hpp"
#include <algorithm>

namespace ets2telemetry::v1 {
namespace {
constexpr std::uint64_t u64_max = std::numeric_limits<std::uint64_t>::max();
constexpr std::uint64_t retention_ns = static_cast<std::uint64_t>(limits.disconnect_retention_ms) * 1'000'000;
std::uint64_t& counter(LossCounts& c, LossCause cause) noexcept {
  switch (cause) {
    case LossCause::offline: return c.offline;
    case LossCause::no_durable_consumer: return c.no_durable_consumer;
    case LossCause::queue_count: return c.queue_count;
    case LossCause::queue_bytes: return c.queue_bytes;
    case LossCause::retention_expired: return c.retention_expired;
    default: return c.encoding_failed;
  }
}
// Counts never exceed max_event_seq, so the per-field sums below cannot wrap.
LossCounts plus(const LossCounts& a, const LossCounts& b) noexcept {
  return {a.offline + b.offline, a.no_durable_consumer + b.no_durable_consumer, a.queue_count + b.queue_count, a.queue_bytes + b.queue_bytes,
    a.retention_expired + b.retention_expired, a.encoding_failed + b.encoding_failed};
}
LossCounts minus(const LossCounts& a, const LossCounts& b) noexcept {
  return {a.offline - b.offline, a.no_durable_consumer - b.no_durable_consumer, a.queue_count - b.queue_count, a.queue_bytes - b.queue_bytes,
    a.retention_expired - b.retention_expired, a.encoding_failed - b.encoding_failed};
}
// Merging lost times keeps the earliest first and the latest last observation (OD-5 S1).
void widen(std::optional<std::uint64_t>& first, std::optional<std::uint64_t>& last, std::optional<std::uint64_t> add_first, std::optional<std::uint64_t> add_last) noexcept {
  if (add_first) first = first ? std::min(*first, *add_first) : *add_first;
  if (add_last) last = last ? std::max(*last, *add_last) : *add_last;
}
}

EventStore::EventStore() : entries_(new Entry[limits.retained_entries]) {}
EventStore::Entry& EventStore::at(std::size_t index) noexcept { return entries_[(head_ + index) % limits.retained_entries]; }
const EventStore::Entry& EventStore::at(std::size_t index) const noexcept { return entries_[(head_ + index) % limits.retained_entries]; }
void EventStore::count_loss(LossCause cause, std::uint64_t count) noexcept { counter(loss_, cause) += count; }

bool EventStore::push_gap(std::uint64_t first, std::uint64_t last, const LossCounts& causes, std::optional<std::uint64_t> first_ns,
  std::optional<std::uint64_t> last_ns, std::uint64_t now_ns) noexcept {
  if (count_ && at(count_ - 1).gap) {
    // A lost range extends the trailing gap record in place; it keeps its entry, its 1,024 bytes and its retention time.
    auto& e = at(count_ - 1); e.last = last; e.causes = plus(e.causes, causes);
    widen(e.first_lost, e.last_lost, first_ns, last_ns); widen(e.tail_first_lost, e.tail_last_lost, first_ns, last_ns);
    return true;
  }
  // The admission rule keeps one entry and gap_record_bytes free whenever the trailing entry is an event.
  if (count_ >= limits.retained_entries || bytes_ + gap_record_bytes > limits.retained_bytes) return false;
  auto& e = at(count_); e = Entry{};
  e.gap = true; e.first = first; e.last = last; e.bytes = gap_record_bytes; e.since_ns = now_ns; e.causes = causes;
  widen(e.first_lost, e.last_lost, first_ns, last_ns);
  ++count_; bytes_ += gap_record_bytes; return true;
}

EventStore::Admission EventStore::admit(const EventRecord& record, std::size_t encoded_bytes, std::uint64_t now_ns) {
  if (exhausted() || record.event_seq != next_ || encoded_bytes == 0 || encoded_bytes > limits.event_bytes) return Admission::rejected;
  const auto observed = record.occurred.monotonic_ns.available() ? std::optional<std::uint64_t>(record.occurred.monotonic_ns.value) : std::nullopt;
  Admission result;
  // Without a durable consumer or an open retention window nothing is retained (OD-5 S4 covers only events copied while durable).
  if (!connected_ && !deadline_) result = Admission::lost_retention_expired;
  // Events never take the last entry or the last gap_record_bytes, so a later loss always fits as a gap record.
  // When both bounds apply, queueCount is counted.
  else if (count_ + 2 > limits.retained_entries) result = Admission::lost_queue_count;
  else if (bytes_ + encoded_bytes + gap_record_bytes > limits.retained_bytes) result = Admission::lost_queue_bytes;
  else {
    auto& e = at(count_); e = Entry{};
    e.first = e.last = record.event_seq; e.bytes = encoded_bytes; e.since_ns = now_ns; e.event = record;
    ++count_; bytes_ += encoded_bytes; next_ = record.event_seq + 1; return Admission::retained;
  }
  const auto cause = result == Admission::lost_retention_expired ? LossCause::retention_expired
    : result == Admission::lost_queue_bytes ? LossCause::queue_bytes : LossCause::queue_count;
  return lose(record.event_seq, record.event_seq, cause, observed, observed, now_ns) ? result : Admission::rejected;
}

bool EventStore::lose(std::uint64_t first, std::uint64_t last, LossCause cause, std::optional<std::uint64_t> first_ns,
  std::optional<std::uint64_t> last_ns, std::uint64_t now_ns) {
  if (exhausted() || first != next_ || last < first || last > max_event_seq || first_ns.has_value() != last_ns.has_value()) return false;
  if (first_ns && last_ns && *first_ns > *last_ns) return false;
  LossCounts causes; counter(causes, cause) = last - first + 1;
  if (!push_gap(first, last, causes, first_ns, last_ns, now_ns)) return false;
  count_loss(cause, last - first + 1); next_ = last + 1; return true;
}

void EventStore::connect() {
  connected_ = true; deadline_.reset();
  // A new connection starts at the release point, which is always the first eventSeq of an entry minus one.
  sent_through_ = acked_; written_before_ = written_;
}
void EventStore::disconnect(std::uint64_t now_ns) {
  if (!connected_) return;
  connected_ = false; deadline_ = now_ns > u64_max - retention_ns ? u64_max : now_ns + retention_ns;
}
void EventStore::expire(std::uint64_t now_ns) {
  if (connected_ || !deadline_ || now_ns < *deadline_) return;
  deadline_.reset();
  bool any_event = false;
  for (std::size_t i = 0; i < count_; ++i) any_event = any_event || !at(i).gap;
  if (!any_event) return;
  // Every retained event becomes retentionExpired coverage, and all coverage merges into one gap record over [A + 1, N).
  LossCounts causes; std::optional<std::uint64_t> first_ns, last_ns; std::uint64_t expired = 0;
  for (std::size_t i = 0; i < count_; ++i) {
    const auto& e = at(i);
    if (e.gap) { causes = plus(causes, e.causes); widen(first_ns, last_ns, e.first_lost, e.last_lost); continue; }
    ++expired;
    if (e.event.occurred.monotonic_ns.available()) widen(first_ns, last_ns, e.event.occurred.monotonic_ns.value, e.event.occurred.monotonic_ns.value);
  }
  causes.retention_expired += expired; count_loss(LossCause::retention_expired, expired);
  const auto first = acked_ + 1, last = next_ - 1;
  head_ = 0; count_ = 0; bytes_ = 0;
  push_gap(first, last, causes, first_ns, last_ns, now_ns);
}

std::optional<Outbound> EventStore::next_outbound() {
  if (!connected_ || sent_through_ + 1 >= next_) return std::nullopt;
  const auto seq = sent_through_ + 1;
  for (std::size_t i = 0; i < count_; ++i) {
    auto& e = at(i);
    if (e.last < seq) continue;
    Outbound out; out.redelivered = seq <= written_before_;
    if (!e.gap) out.event = e.event;
    else {
      out.gap = true; out.range.first_event_seq = seq; out.range.last_event_seq = e.last;
      // A record written whole before on this connection was extended since: write only the new tail as a delta.
      if (seq == e.first) { out.range.causes = e.causes; out.range.first_lost_ns = e.first_lost; out.range.last_lost_ns = e.last_lost; }
      else { out.range.causes = minus(e.causes, e.written_causes); out.range.first_lost_ns = e.tail_first_lost; out.range.last_lost_ns = e.tail_last_lost; }
      e.written_causes = e.causes; e.tail_first_lost.reset(); e.tail_last_lost.reset();
    }
    sent_through_ = e.last; written_ = std::max(written_, e.last);
    return out;
  }
  return std::nullopt;
}

std::optional<std::uint64_t> EventStore::release(std::uint64_t through) {
  if (!connected_ || through > sent_through_) return std::nullopt;
  if (through <= acked_) return acked_;
  while (count_ && at(0).last <= through) { bytes_ -= at(0).bytes; head_ = (head_ + 1) % limits.retained_entries; --count_; }
  // An ACK never splits a retained entry: inside a gap record the release point is that record's first eventSeq - 1.
  acked_ = count_ && at(0).first <= through ? at(0).first - 1 : through;
  if (!count_) head_ = 0;
  return acked_;
}

StoreStatus EventStore::status() const {
  StoreStatus s; s.acked_through_event_seq = acked_; s.next_event_seq = next_;
  s.retained_entries = static_cast<std::uint32_t>(count_); s.retained_bytes = static_cast<std::uint32_t>(bytes_); s.event_loss = loss_;
  for (std::size_t i = 0; i < count_; ++i) s.oldest_retained_ns = s.oldest_retained_ns ? std::min(*s.oldest_retained_ns, at(i).since_ns) : at(i).since_ns;
  return s;
}
EndCursor EventStore::end_cursor() const {
  EndCursor c; c.next_event_seq = next_; c.acked_through_event_seq = acked_;
  for (std::size_t i = 0; i < count_; ++i) if (!at(i).gap) ++c.retained_unacked;
  return c;
}
EventStore::EntryView EventStore::entry(std::size_t index) const noexcept {
  const auto& e = at(index); return {e.gap, e.first, e.last, e.bytes, e.since_ns, e.causes};
}
} // namespace ets2telemetry::v1
