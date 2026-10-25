#pragma once
#include "protocol-v0.hpp"
#include <cstdint>
#include <functional>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

// Durable telemetry protocol 1.0 and 1.1 (ET-002b; minor 1, the gearbox state, is ET-050b): the C++17 counterpart of
// packages/contracts/src/protocol-v1.ts. It is a separate major from the frozen v0 live protocol and from CAP0, and
// reuses only the bounded strict JSON layer (v0::Json, the parser and the serializer). The wire format is specified in
// docs/protocol/v1.md.
namespace ets2telemetry::v1 {
using Json = v0::Json;
// Version 1.0: every hello, and every message of a connection that selected minor 0.
constexpr unsigned protocol_major = 1, protocol_minor = 0;
// The highest minor this contract implements. Minor 1 adds `state.gearbox` to checkpoints and snapshots (§7). Every
// stateless entry point below takes a `max_minor` that defaults to 0, so a caller accepts or writes a minor-1 message
// only when it opts in; a maximum other than 0 or 1 is a caller error and throws ProtocolError.
constexpr unsigned highest_minor = 1;
// Gearbox bounds of minor 1 (ET-050b B2). A producer marks a reading outside them `invalid`, never truncated.
struct GearboxLimits { unsigned max_gears, max_selector_count, max_slots, max_handle_position; };
constexpr GearboxLimits gearbox_limits{100, 6, 64, 255};
struct Limits {
  std::size_t server_frame_bytes, client_frame_bytes, event_bytes, retained_entries, retained_bytes;
  std::uint32_t disconnect_retention_ms, hello_timeout_ms, write_deadline_ms, snapshot_interval_ms, trailer_slots;
};
// Fixed producer and transport bounds. Every welcome repeats them exactly; a mismatch is rejected.
constexpr Limits limits{65536, 4096, 16384, 256, 1048576, 300000, 5000, 1000, 50, 10};
// UTF-8 byte limits of SDK identifiers and localized display text. Longer values become `invalid`, never truncated.
constexpr std::size_t id_bytes = 128, name_bytes = 256;
// Retained-byte accounting of one gap record, whatever its encoded size (docs/protocol/v1.md §9).
constexpr std::size_t gap_record_bytes = 1024;
// The last assignable eventSeq, so that `nextEventSeq` stays representable as a uint64 after it.
constexpr std::uint64_t max_event_seq = std::numeric_limits<std::uint64_t>::max() - 1;
constexpr std::uint64_t clock_reply_deadline_ns = 1'000'000'000;
inline constexpr const char* event_types[] = {
  "job.configured", "job.cleared", "truck.configured", "truck.cleared", "trailer.configured", "trailer.cleared",
  "simulation.paused", "simulation.started", "timers.restart", "gameTime.regression", "job.delivered", "job.cancelled",
  "player.fined", "player.tollgate.paid", "player.use.ferry", "player.use.train", "source.gameMode"};
// Record types that come from SDK gameplay-event callbacks, absent when that registration is unsupported.
inline constexpr const char* gameplay_event_types[] = {"job.delivered", "job.cancelled", "player.fined", "player.tollgate.paid", "player.use.ferry", "player.use.train"};

// Every public entry point throws only this type for protocol failures; no v0 error escapes the v1 API.
struct ProtocolError : std::runtime_error { using std::runtime_error::runtime_error; };
enum class Sender { server, client };
enum class Reason { not_supported, not_observed, invalid };
template<class T> struct Available { std::optional<T> value; Reason reason = Reason::not_observed; };
struct Measure { Available<double> reading; std::string unit; };
enum class TextKind { id, name, nonempty_id };
enum class SdkType { s64, u64 };
struct Currency { enum class Status { unknown, sdk_documented } status = Status::unknown; std::string code, source; };
// Raw SDK money: `raw` is the exact decimal string from the wire, `exact` its value. Never converted or rounded.
struct Money { std::string raw; SdkType sdk_type = SdkType::u64; Currency currency; std::variant<std::int64_t, std::uint64_t> exact; };
struct GameMode { std::string mode, method, confidence; Available<std::string> module; };
struct SourceIdentity {
  std::string game, plugin_session_id, process_instance_id, origin;
  std::uint32_t process_id = 0, windows_session_id = 0;
};
struct CaptureTime { std::string clock_id; std::uint64_t monotonic_ns = 0; };
// Cumulative counts of lost eventSeqs by cause; gap messages use the same fields for one range.
struct LossCounts { std::uint64_t offline = 0, no_durable_consumer = 0, queue_count = 0, queue_bytes = 0, retention_expired = 0, encoding_failed = 0; };
struct DeliveryStatus {
  bool durable = false; std::uint64_t acked_through_event_seq = 0, next_event_seq = 0;
  std::uint32_t retained_events = 0, retained_bytes = 0; Available<std::uint64_t> oldest_retained_monotonic_ns;
};
struct SourceStatus { GameMode game_mode; DeliveryStatus delivery; LossCounts event_loss; };
struct Continuity { std::uint64_t coalesced_snapshots = 0, offline_transitions = 0; };
struct GameTimeStamp { Available<std::uint64_t> minutes; std::string clock_id; };
// One H-shifter slot with a nonzero gear: reverse negative. `selectors` is a bit set below 2^selector_count.
struct HShifterSlot { int gear = 0; unsigned handle_position = 0, selectors = 0; };
// The latest SDK `hshifter` configuration: every slot whose gear is not neutral, in SDK slot order.
struct HShifterLayout { unsigned selector_count = 0; std::vector<HShifterSlot> slots; };
// Minor 1 only (ET-050b B1, B2): the truck's gear counts and the H-shifter layout.
struct Gearbox { Available<unsigned> forward_gears, reverse_gears; Available<HShifterLayout> hshifter; };
// Read views per kind. State, configuration and record bodies stay in `wire` and are read through read_* below.
// `minor` is the selected minor the welcome announces; it equals the welcome's envelope minor.
struct WelcomeView { unsigned minor = 0; bool durable_events = false, gameplay_events_registered = false; std::vector<std::string> event_types; GameMode game_mode; };
// `gearbox` is set exactly for a minor-1 state.
struct StateView { std::optional<std::uint64_t> boundary_seq; std::uint64_t boundary_order = 0; SourceStatus status; Continuity continuity; std::optional<Gearbox> gearbox; };
struct Occurrence {
  Available<std::uint64_t> monotonic_ns; GameTimeStamp game_time; Available<std::uint64_t> utc_unix_ms;
  std::string simulation; std::uint64_t configuration_revision = 0, boundary_order = 0;
};
struct EventView { std::uint64_t event_seq = 0; bool redelivered = false; Occurrence occurred; std::string record_type; };
struct GapView {
  std::uint64_t first_event_seq = 0, last_event_seq = 0; LossCounts causes;
  Available<std::uint64_t> first_lost_monotonic_ns, last_lost_monotonic_ns; bool redelivered = false;
};
struct ClockReplyView { std::uint64_t probe_id = 0, received_monotonic_ns = 0, sent_monotonic_ns = 0; };
struct EndView { std::string reason; std::uint64_t next_event_seq = 0, acked_through_event_seq = 0, retained_unacked = 0; };
struct HelloView { std::string client_instance_id; std::uint16_t max_minor = 0; bool durable_events = false; };
struct AckView { std::string plugin_session_id; std::uint64_t through_event_seq = 0; };
struct ClockProbeView { std::uint64_t probe_id = 0; };
struct Message {
  // `minor` is the envelope minor, which selects the state schema.
  Sender sender = Sender::server; std::string kind; unsigned minor = 0;
  // Server envelopes only.
  std::optional<SourceIdentity> source; std::uint64_t seq = 0; CaptureTime capture;
  // Exactly the view of `kind` is set.
  std::optional<WelcomeView> welcome; std::optional<StateView> state; std::optional<EventView> event; std::optional<GapView> gap;
  std::optional<ClockReplyView> clock_reply; std::optional<EndView> end;
  std::optional<HelloView> hello; std::optional<AckView> ack; std::optional<ClockProbeView> clock_probe;
  // Wire is the authoritative representation for encoding and validation; the views are read-only copies.
  // Change wire, then decode the encoded frame again to obtain updated views.
  Json wire;
};

// Strict validation of one message from `sender`: exact keys, bounds, units and exact integer strings, in the order of
// validateServerMessage/validateClientMessage. The envelope minor selects the state schema; minors above `max_minor`
// (default 0) are rejected, and a hello is always version 1.0.
Message validate(const Json&, Sender, unsigned max_minor = 0);
// Size, UTF-8, strict JSON, schema, then the event size bound.
Message decode_payload(const std::string& bytes, Sender, unsigned max_minor = 0);
// Validates first (the sender follows from `wire.kind`), serializes, re-decodes and adds the length prefix. Minors
// above `max_minor` (default 0) are refused.
std::vector<std::uint8_t> encode_frame(const Message&, unsigned max_minor = 0);
struct Negotiated { unsigned major = protocol_major, minor = protocol_minor; bool durable_events = false; };
// Server-side hello negotiation. The server selects min(hello `maxMinor`, its own `max_minor`), which defaults to 0;
// the welcome and every later message in both directions then carry that minor. Durable delivery never exceeds the
// client's request.
Negotiated negotiate(const Message& hello, bool allow_durable = true, unsigned max_minor = 0);

// Readers for validated wire nodes inside state, configuration and records.
Available<std::uint64_t> read_uint64(const Json&);
Measure read_measure(const Json&, const char* unit);
Available<std::string> read_text(const Json&, TextKind);
Available<Money> read_money(const Json&, SdkType);
GameMode read_game_mode(const Json&);
// A validated minor-1 `state.gearbox` node.
Gearbox read_gearbox(const Json&);

// Length-prefixed v1 framing for one direction. Fails closed; never rescans for a later prefix after an error.
class FrameDecoder {
 public:
  // `peer` is the sender whose frames this decoder reads: server on the client, client on the server. Frames above
  // `max_minor` (default 0) are rejected.
  explicit FrameDecoder(Sender peer, unsigned max_minor = 0);
  void push(const std::uint8_t* data, std::size_t size, const std::function<void(Message)>& emit);
  void end();
 private:
  Sender peer_; unsigned max_minor_; std::uint8_t header_[4]{}; std::size_t header_used_ = 0, expected_ = 0;
  std::string payload_; bool failed_ = false, pushing_ = false;
};

// SDK-independent normalization helpers. The SDK adapter (ET-004b) decides availability before calling them.
// Exact metres from a u32 kilometre count, such as job `planned_distance.km`.
Measure km_to_meters_u32(const Available<double>& km);
// Metres from an SDK float kilometre value, such as `distance.km`; non-finite or out-of-range input is invalid.
Measure km_to_meters_float(const Available<double>& km);
// An SDK fraction, such as cargo damage; values outside the defensive 0-1,000 range are invalid.
Measure fraction(const Available<double>& input);
// Exact raw money from an SDK integer or decimal string. Out-of-range or non-canonical input is invalid, never rounded.
Available<Money> sdk_money(const std::string& raw, SdkType, const Currency&);
Available<Money> sdk_money(std::int64_t raw, SdkType, const Currency&);
Available<Money> sdk_money(std::uint64_t raw, SdkType, const Currency&);
// SDK text: not sent is not-observed, a provided empty string stays available, and a rule violation is invalid.
Available<std::string> sdk_text(const std::optional<std::string>& value, TextKind);
} // namespace ets2telemetry::v1
