#pragma once
#include "sdk-adapter.hpp"
#include "game-window-monitor.hpp"
#include <cstdint>
// pipe-security.hpp includes <windows.h> without NOMINMAX before this header in the transport sources, so the min/max
// macros are hidden while the frozen protocol v1 headers load (as in event-channel.hpp).
#pragma push_macro("min")
#pragma push_macro("max")
#undef min
#undef max
#include "protocol-v1-producer.hpp"
#include "protocol-v1-delivery.hpp"
#pragma pop_macro("max")
#pragma pop_macro("min")

// Protocol v1 endpoint state (ET-004b): pure mappings from the adapter's v1 slot and the game-window monitor to the
// encoder's inputs. No I/O and no SDK calls; the v1 transport worker uses them, and the console test checks them
// directly. See docs/native-transport-v1.md.
namespace ets2telemetry::v1 {
// The identity every envelope of the plugin session repeats, and the currency of its money fields (D11). `origin` is fixed
// per artifact: `game` in the production DLL, `synthetic` in test DLLs and console fixtures.
SessionIdentity session_identity(const sdk::Identity&, Origin origin);
// Welcome capabilities for one connection: the API and game telemetry versions from the SDK identity, the gameplay-event
// registration result and the session game-mode evidence, with source.gameMode support.
WelcomeInfo welcome_info(const sdk::V1Current&, bool durable_events);
// The current game window, under the identity and freshness rules of the v0 transport::current_window: unavailable
// (not-supported) without a monitor, not-observed for a stale, foreign, hidden or minimized window.
Field<WindowPod> window_field(const sdk::V1Current&, const window::Snapshot*, std::uint64_t process_creation, std::uint64_t now_ms) noexcept;
// Saturating sum of the adapter's slot contention and the endpoint's replaced unsent snapshots, with the adapter's
// offline transitions (OD-5 S10). Both parts never decrease, so the sum never decreases within a connection.
Continuity continuity(const sdk::V1Current&, std::uint64_t endpoint_coalesced) noexcept;
// The latest source-clock time an outbound item carries: an event's occurred.monotonicNs or a gap's last lost time.
std::uint64_t carried_ns(const Outbound&) noexcept;

// The capture time of one connection (docs/native-transport-v1.md, Caller sequence step 5, OD-5 S7):
// capture = max(now, last capture on the connection, the latest source-clock time the message carries).
// A retained event's occurrence comes from the SDK thread and can be later than the worker's clock reading; encode()
// rejects a capture before a carried time, so an unclamped capture would stall delivery of a retained entry.
class CaptureStamp {
 public:
  std::uint64_t stamp(std::uint64_t now_ns, std::uint64_t carried_ns = 0) noexcept;
  std::uint64_t last() const noexcept { return last_; }
 private:
  std::uint64_t last_ = 0;
};
} // namespace ets2telemetry::v1
