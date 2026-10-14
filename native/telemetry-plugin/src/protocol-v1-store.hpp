#pragma once
#include "protocol-v1-records.hpp"
#include <cstdint>
#include <memory>
#include <optional>

// Protocol v1 producer event store (ET-004b): the retained, unacknowledged entries of one plugin session and its
// delivery cursor, following docs/protocol/v1.md §9-§10 and docs/native-transport-v1.md. Single-threaded and owned by
// the transport worker; it never blocks, performs no I/O and takes every time as an explicit source-clock argument.
namespace ets2telemetry::v1 {
enum class LossCause : std::uint8_t { offline, no_durable_consumer, queue_count, queue_bytes, retention_expired, encoding_failed };
// One contiguous eventSeq range that the producer no longer holds. Lost times are the first and last lost observation
// in the source clock (OD-5 S1); both are present or both absent.
struct GapRange {
  std::uint64_t first_event_seq = 0, last_event_seq = 0; LossCounts causes;
  std::optional<std::uint64_t> first_lost_ns, last_lost_ns;
};
// The delivery block of status (§7) and the loss counters, as the store holds them at this moment.
struct StoreStatus {
  std::uint64_t acked_through_event_seq = 0, next_event_seq = 1;
  std::uint32_t retained_entries = 0, retained_bytes = 0; std::optional<std::uint64_t> oldest_retained_ns;
  LossCounts event_loss;
};
// The cursor fields of `end` (§9); `retained_unacked` counts retained events, not gap records (OD-5 S5).
struct EndCursor { std::uint64_t next_event_seq = 1, acked_through_event_seq = 0, retained_unacked = 0; };
// The next coverage item to write on the current durable connection.
struct Outbound {
  bool gap = false; EventRecord event; GapRange range;
  // True when any eventSeq of the item was written to an earlier connection of this plugin session.
  bool redelivered = false;
  std::uint64_t first_event_seq() const noexcept { return gap ? range.first_event_seq : event.event_seq; }
  std::uint64_t last_event_seq() const noexcept { return gap ? range.last_event_seq : event.event_seq; }
};

// Invariants after every call (docs/native-transport-v1.md, I1-I8):
// I1 the entries cover exactly [A + 1, N) in order, where A is the release point and N the next eventSeq;
// I2 at most 256 entries and 1 MiB, events at most 255 entries, always room for one trailing gap record;
// I3 a lost range extends a trailing gap record in place; I4 an ACK releases only whole entries (decision (c));
// I5 disconnect retention converts every retained event into retentionExpired coverage without adding entries;
// I6 each eventSeq is written at most once per connection, in order, with its redelivered flag;
// I7 A, N and the loss counters never decrease; I8 N stops at max_event_seq + 1 (sequence exhausted).
class EventStore {
 public:
  enum class Admission { retained, lost_queue_count, lost_queue_bytes, lost_retention_expired, rejected };
  // Allocates every entry once; nothing allocates afterwards.
  EventStore();
  EventStore(const EventStore&) = delete;
  EventStore& operator=(const EventStore&) = delete;

  // Retains one event measured at admission with the worst-case envelope (OD-5 S3), or records it as lost with
  // queueCount (no entry), queueBytes (no bytes; queueCount wins when both apply) or retentionExpired (no durable
  // consumer and no open retention window). `rejected` means misuse with no effect: an eventSeq other than N, an
  // exhausted sequence or a size outside 1..16,384 bytes.
  Admission admit(const EventRecord&, std::size_t encoded_bytes, std::uint64_t now_ns);
  // Records the lost range [first, last] with one cause. `first` must equal N, and the lost times are both present
  // (first <= last) or both absent. Extends a trailing gap record in place, otherwise adds one in the reserved entry.
  // Returns false on misuse, with no effect.
  bool lose(std::uint64_t first, std::uint64_t last, LossCause, std::optional<std::uint64_t> first_lost_ns,
    std::optional<std::uint64_t> last_lost_ns, std::uint64_t now_ns);

  // A durable consumer connected (its welcome granted durableEvents). Cancels any retention window and starts the
  // outbound cursor at A. Call it before the event gate opens, so that events copied for this consumer are retained.
  void connect();
  // The durable consumer is gone: the retention window of 300,000 ms starts now.
  void disconnect(std::uint64_t now_ns);
  // When the window has ended, converts every retained event into retentionExpired coverage, merged in place into one
  // gap record whose retention time is `now_ns` (OD-5 S2). Gap records are never aged. Call it on every iteration.
  void expire(std::uint64_t now_ns);
  // The next item after the last one written on this connection, or nullopt when the connection has written all
  // coverage or no durable consumer is connected. Returning the item marks it written (OD-5 S9). A gap record that
  // was extended after it was written yields a delta gap for the new tail only.
  std::optional<Outbound> next_outbound();
  // Applies a cumulative ACK that AckValidator accepted on this connection. Releases exactly the entries whose last
  // eventSeq is <= T; a gap record with first <= T < last stays whole and the release point becomes first - 1.
  // Returns the release point, or nullopt on misuse (not connected, T beyond the written coverage), with no effect.
  std::optional<std::uint64_t> release(std::uint64_t through_event_seq);

  StoreStatus status() const;
  EndCursor end_cursor() const;
  // True once every assignable eventSeq is covered; the producer then ends the session with sequence-exhausted.
  bool exhausted() const noexcept { return next_ > max_event_seq; }
  bool connected() const noexcept { return connected_; }
  std::optional<std::uint64_t> retention_deadline_ns() const noexcept { return deadline_; }
  std::uint64_t next_event_seq() const noexcept { return next_; }
  std::uint64_t release_point() const noexcept { return acked_; }
  // Read-only view of entry `index` from the oldest, for tests and diagnostics.
  struct EntryView { bool gap; std::uint64_t first_event_seq, last_event_seq; std::size_t bytes; std::uint64_t retained_since_ns; LossCounts causes; };
  std::size_t entries() const noexcept { return count_; }
  EntryView entry(std::size_t index) const noexcept;

 private:
  struct Entry {
    bool gap = false; std::uint64_t first = 0, last = 0; std::size_t bytes = 0; std::uint64_t since_ns = 0;
    EventRecord event;
    LossCounts causes; std::optional<std::uint64_t> first_lost, last_lost;
    // Gap records only: the causes already written on this connection and the lost times of the unwritten tail.
    LossCounts written_causes; std::optional<std::uint64_t> tail_first_lost, tail_last_lost;
  };
  Entry& at(std::size_t index) noexcept;
  const Entry& at(std::size_t index) const noexcept;
  void count_loss(LossCause, std::uint64_t count) noexcept;
  bool push_gap(std::uint64_t first, std::uint64_t last, const LossCounts&, std::optional<std::uint64_t> first_ns,
    std::optional<std::uint64_t> last_ns, std::uint64_t now_ns) noexcept;
  std::unique_ptr<Entry[]> entries_;
  std::size_t head_ = 0, count_ = 0, bytes_ = 0;
  std::uint64_t acked_ = 0, next_ = 1;
  LossCounts loss_;
  bool connected_ = false; std::optional<std::uint64_t> deadline_;
  // Highest eventSeq written on the current connection, and on any connection before it.
  std::uint64_t sent_through_ = 0, written_ = 0, written_before_ = 0;
};
} // namespace ets2telemetry::v1
