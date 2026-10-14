#pragma once
#include "protocol-v1.hpp"
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

// Protocol v1 delivery rules, mirroring packages/contracts/src/protocol-v1-delivery.ts: stream ordering and event
// coverage on the client, the storage-commit ACK cursor, the producer-side ACK validator and clock mapping.
// No I/O, storage or SDK calls; see docs/protocol/v1.md §7-§11.
namespace ets2telemetry::v1 {
struct Coverage { std::uint64_t first_event_seq = 0, last_event_seq = 0; };
struct Applied {
  // True only for the coherent checkpoint. Hydration replaces current state and never applies job, delivery or cancellation effects.
  bool hydration = false;
  // Exact message `seq` difference minus one. Coalescing makes skips legal; a skip alone is not lost gameplay data.
  std::uint64_t skipped_sequences = 0;
  // eventSeq range of an event (one value) or a gap, in stream order. Feed it to the ACK cursor only after storage commits it.
  std::optional<Coverage> coverage;
};

// Client-side ordering for one connection: welcome, exactly one checkpoint, then live messages until `end`. It enforces
// source identity, clock and sequence order, contiguous eventSeq coverage, durable opt-in and a terminal `end`. Any
// violation closes the consumer; a reconnection needs a new consumer.
class Consumer {
 public:
  explicit Consumer(bool durable_requested) : durable_requested_(durable_requested) {}
  // Revalidates `wire` as a server message first; a manually assembled Message is never trusted.
  Applied accept(const Message&);
  // Registers the one outstanding clock probe before it is sent. Probe IDs are at least 1 and increase within a
  // connection. A probe stays outstanding until its reply arrives, even after the 1 s measurement deadline.
  void expect_clock_reply(std::uint64_t probe_id);
  // The connection's plugin session, known after welcome.
  const std::optional<std::string>& plugin_session_id() const { return plugin_session_id_; }
  bool durable_events() const { return durable_; }
  // The next eventSeq this connection must cover.
  std::uint64_t next_event_seq() const { return next_event_; }
  bool clock_probe_outstanding() const { return probe_.has_value(); }
 private:
  enum class Phase { welcome, checkpoint, live, closed };
  void check_status(const SourceStatus&, const Continuity&);
  Phase phase_ = Phase::welcome; bool durable_requested_, durable_ = false;
  std::string identity_, clock_; std::optional<std::string> plugin_session_id_; std::set<std::string> event_types_;
  std::uint64_t last_seq_ = 0, last_capture_ = 0, next_event_ = 1, live_from_ = 1, event_boundary_ = 0, event_revision_ = 0, state_boundary_ = 0, last_probe_ = 0;
  std::optional<SourceStatus> status_; std::optional<Continuity> continuity_; std::optional<std::uint64_t> probe_;
};

// Client-side cumulative ACK cursor for one plugin session, kept across its connections. `through_event_seq` is the
// highest eventSeq T such that storage committed every event and gap marker in [1, T]. Receipt alone never advances it.
// An ACK never exceeds the coverage received on the current connection, which the producer's ACK rule requires.
class DurableAckCursor {
 public:
  enum class CommitResult { committed, duplicate };
  // `committed_through_event_seq` is the contiguous commit point already in storage for this plugin session.
  explicit DurableAckCursor(std::string plugin_session_id, std::uint64_t committed_through_event_seq = 0);
  const std::string& plugin_session_id() const { return plugin_session_id_; }
  std::uint64_t through_event_seq() const { return through_; }
  // Starts a connection from its checkpoint's `ackedThroughEventSeq` A. Both per-connection marks restart at A.
  void begin_connection(std::uint64_t acked_through_event_seq);
  // Records coverage delivered on the current connection; commits are allowed only inside received coverage.
  void received(std::uint64_t first, std::uint64_t last);
  bool is_committed(std::uint64_t event_seq) const;
  // Call only after the storage transaction that inserted UNIQUE(plugin_session_id, event_seq) rows for [first, last]
  // committed. A redelivered range already committed is a duplicate.
  CommitResult commit(std::uint64_t first, std::uint64_t last);
  CommitResult commit(std::uint64_t event_seq) { return commit(event_seq, event_seq); }
  // The next cumulative ACK on the current connection, validated as a client message: min(contiguous committed
  // eventSeq, highest eventSeq received on this connection), only when it exceeds the last ACK sent on this connection.
  std::optional<Message> ack();
 private:
  struct Connection { std::uint64_t received_through = 0, last_ack = 0; };
  std::string plugin_session_id_; std::uint64_t through_ = 0, received_through_ = 0;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> pending_; std::optional<Connection> connection_;
};

// Producer-side ACK validation for one connection, created when the welcome is written. It rejects every ACK from a
// live-only client, any ACK before the checkpoint, a foreign plugin session, an ACK beyond the highest eventSeq sent on
// this connection and a regressing ACK, and closes on the first violation. An equal ACK is a no-op.
// An ACK never splits a retained entry: the producer releases exactly the entries whose last eventSeq is <= T, and its
// `ackedThroughEventSeq` is T, or the first eventSeq - 1 of a retained gap record with first <= T < last (ET-004b enforces it).
class AckValidator {
 public:
  // `durable_events` is the grant written in this connection's welcome.
  AckValidator(std::string plugin_session_id, bool durable_events);
  std::optional<std::uint64_t> acked_through_event_seq() const { return acked_; }
  // Records the checkpoint written on this connection, with its `ackedThroughEventSeq`.
  void checkpoint(std::uint64_t acked_through_event_seq);
  // Records an event or gap written on this connection, covering eventSeqs through `last_event_seq`.
  void sent(std::uint64_t last_event_seq);
  // Returns the new acknowledged eventSeq after an advance, or nullopt for an equal ACK.
  std::optional<std::uint64_t> accept(const Message&);
 private:
  std::string plugin_session_id_; bool durable_events_; std::optional<std::uint64_t> acked_; std::uint64_t sent_through_ = 0; bool closed_ = false;
};

// Local-only mapping from the source monotonic clock to a client monotonic clock. Never a wire field.
// `offset_ns` is a signed decimal string: source ~= client + offset_ns, within +/- uncertainty_ns.
struct ClockMapping { std::string source_clock_id, client_clock_id, offset_ns; std::uint64_t uncertainty_ns = 0, measured_at_client_ns = 0; };
// Computes the mapping from one probe round trip with exact 65-bit arithmetic. t0/t3 are the client's probe send and
// reply receipt; t1/t2 the source's receipt and reply send. The offset is rounded down and the uncertainty up. A
// negative round trip is rejected before the lateness check; a reply more than 1 s after its probe returns nullopt.
std::optional<ClockMapping> compute_clock_mapping(const Message& reply, std::uint64_t probe_id, const std::string& client_clock_id,
  std::uint64_t probe_sent_ns, std::uint64_t reply_received_ns);
// A mapping is valid only while both clock identities are unchanged.
bool is_clock_mapping_current(const ClockMapping&, const std::string& source_clock_id, const std::string& client_clock_id);
} // namespace ets2telemetry::v1
