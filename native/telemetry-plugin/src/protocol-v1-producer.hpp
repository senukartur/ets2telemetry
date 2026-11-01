#pragma once
#include "protocol-v1-records.hpp"
#include "protocol-v1-store.hpp"
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// Protocol v1 producer encoder (ET-004b): builds every server message from the copied records and the store's cursor,
// then validates and frames it with the ET-002b contract (v1::encode_frame). SDK-free and I/O-free; the transport
// worker owns it. See docs/protocol/v1.md §4-§11 and docs/native-transport-v1.md.
namespace ets2telemetry::v1 {
// The identity every server envelope of one plugin session repeats, and the currency of its money fields (D11).
struct SessionIdentity { SourcePod source; Uuid capture_clock_id; Currency currency; };
struct VersionPair { std::uint16_t major = 0, minor = 0; };
struct WelcomeInfo {
  bool durable_events = false;
  // Whether the SDK gameplay-event callback was registered; without it the six gameplay types are not listed.
  bool gameplay_events_registered = false;
  // Whether this source supports source.gameMode observations; set by the endpoint.
  bool game_mode_events = false;
  VersionPair telemetry_api, game_telemetry; std::string sdk_archive = "scs-sdk-1.15"; GameModePod game_mode;
};
// The status and continuity blocks of a checkpoint or snapshot. `durable` equals the connection's welcome grant.
struct StatusInfo { GameModePod game_mode; bool durable = false; StoreStatus delivery; Continuity continuity; };
enum class EndReason { plugin_shutdown, sequence_exhausted, source_retired };

// The welcome's capabilities.eventTypes in v1::event_types order.
std::vector<std::string> welcome_event_types(bool gameplay_events_registered, bool game_mode_events);

// Every builder returns the wire tree of one server message. `capture_ns` must not precede any source-clock time the
// message carries (occurred, lost or retention times); encode() rejects such a message.
// `minor` is the minor the connection selected (ET-050b B1, ET-052, default 0). Every message of a connection carries it in
// its envelope and the welcome announces it; only checkpoints and snapshots differ in content: `state.gearbox` from minor
// 1 and `state.nextMandatoryBreak` from minor 2. A minor-0 message is byte-identical to the original minor-0 encoding, and
// a minor-1 message to the original minor-1 encoding: neither carries the break.
class Encoder {
 public:
  explicit Encoder(SessionIdentity identity) : identity_(std::move(identity)) {}
  const SessionIdentity& identity() const noexcept { return identity_; }
  Json welcome(std::uint64_t seq, std::uint64_t capture_ns, const WelcomeInfo&, unsigned minor = 0) const;
  Json checkpoint(std::uint64_t seq, std::uint64_t capture_ns, const StatePod&, const StatusInfo&, unsigned minor = 0) const;
  Json snapshot(std::uint64_t seq, std::uint64_t capture_ns, const StatePod&, const StatusInfo&, unsigned minor = 0) const;
  Json event(std::uint64_t seq, std::uint64_t capture_ns, const EventRecord&, bool redelivered, unsigned minor = 0) const;
  Json gap(std::uint64_t seq, std::uint64_t capture_ns, const GapRange&, bool redelivered, unsigned minor = 0) const;
  // An event or gap returned by EventStore::next_outbound().
  Json outbound(std::uint64_t seq, std::uint64_t capture_ns, const Outbound&, unsigned minor = 0) const;
  Json clock_reply(std::uint64_t seq, std::uint64_t capture_ns, std::uint64_t probe_id, std::uint64_t received_ns, std::uint64_t sent_ns, unsigned minor = 0) const;
  Json end(std::uint64_t seq, std::uint64_t capture_ns, EndReason, const EndCursor&, unsigned minor = 0) const;
  // Encoded payload bytes of this event with the worst-case envelope: maximum seq and capture time and
  // `redelivered: false`, the longer literal (OD-5 S3). Every later encoding of the record fits within it, at any
  // minor: an event's body does not depend on the minor, and every minor is one digit long. Nullopt
  // means the record cannot be sent: the contract rejects it, it exceeds the 16,384-byte event bound, or encoding
  // failed for any other reason, such as allocation. It never throws, so every drained eventSeq gets coverage.
  std::optional<std::size_t> measure_event(const EventRecord&) const noexcept;
 private:
  Json envelope(const char* kind, std::uint64_t seq, std::uint64_t capture_ns, Json data, unsigned minor) const;
  Json state_data(const StatePod&, const StatusInfo&, unsigned minor) const;
  SessionIdentity identity_;
};

// Validates and frames one server message through v1::encode_frame, accepting envelope minors up to `minor` (default
// 0). Throws v1::ProtocolError.
std::vector<std::uint8_t> encode(Json wire, unsigned minor = 0);

// Measures one drained event and retains it, or records it as lost: encodingFailed when it cannot be sent, otherwise
// the store's admission causes. The lost time of an event is its occurred.monotonicNs (OD-5 S1). It never throws: the
// store does not allocate, and measurement maps every failure to encodingFailed. `rejected` means misuse with no effect.
enum class Ingest { retained, lost_queue_count, lost_queue_bytes, lost_retention_expired, lost_encoding_failed, rejected };
Ingest ingest_event(EventStore&, const Encoder&, const EventRecord&, std::uint64_t now_ns) noexcept;
} // namespace ets2telemetry::v1
