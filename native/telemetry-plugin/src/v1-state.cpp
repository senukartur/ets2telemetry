#include "v1-state.hpp"
#include <cstring>
#include <string>

namespace ets2telemetry::v1 {
namespace {
Uuid uuid_of(const sdk::Uuid& text) noexcept { Uuid output; std::memcpy(output.text, text.bytes.data(), sizeof output.text); return output; }
// SCS versions are SCS_MAKE_VERSION(major, minor): the major in the high and the minor in the low 16 bits.
VersionPair version_of(std::uint32_t version) noexcept { return {static_cast<std::uint16_t>(version >> 16), static_cast<std::uint16_t>(version & 0xffff)}; }
std::uint64_t saturating_add(std::uint64_t a, std::uint64_t b) noexcept { return a > UINT64_MAX - b ? UINT64_MAX : a + b; }
}

SessionIdentity session_identity(const sdk::Identity& id, Origin origin) {
  SessionIdentity output;
  output.source.game = std::string(id.game.c_str()) == "ats" ? GameId::ats : GameId::ets2;
  output.source.plugin_session_id = uuid_of(id.plugin_session_id); output.source.process_instance_id = uuid_of(id.process_instance_id);
  output.source.process_id = id.process_id; output.source.windows_session_id = id.windows_session_id; output.source.origin = origin;
  output.capture_clock_id = uuid_of(id.capture_clock_id);
  // D11: the currency the pinned SDK headers document for this game, with the header reference as its source.
  if (id.currency.status == sdk::Availability::available && id.currency_source.status == sdk::Availability::available)
    output.currency = Currency{Currency::Status::sdk_documented, id.currency.c_str(), id.currency_source.c_str()};
  return output;
}

WelcomeInfo welcome_info(const sdk::V1Current& current, bool durable_events) {
  WelcomeInfo output; output.durable_events = durable_events;
  output.gameplay_events_registered = current.gameplay_result == SCS_RESULT_ok;
  // OD-3: no game-mode detection yet, so no source.gameMode events and the default unknown/none/none evidence.
  output.game_mode_events = false; output.game_mode = GameModePod{};
  output.telemetry_api = version_of(current.identity.api_version); output.game_telemetry = version_of(current.identity.game_telemetry_version);
  return output;
}

Field<WindowPod> window_field(const sdk::V1Current& c, const window::Snapshot* w, std::uint64_t creation, std::uint64_t now) noexcept {
  if (!w) return {WindowPod{}, FieldState::not_supported};
  // The same fail-closed identity and age rules as v0 (snapshot-wire.cpp, transport::current_window); the console test
  // compares both over one mutation table.
  if (!c.active || c.source_retired || c.exhausted || w->status != window::Status::available || !w->per_monitor_v2 ||
      !w->visible || w->minimized || !w->client_bounds_available || !w->handle || !w->dpi || !w->client.width || !w->client.height ||
      !creation || w->process_creation_time != creation || w->process_id != c.identity.process_id ||
      w->windows_session_id != c.identity.windows_session_id ||
      w->plugin_session_id != c.identity.plugin_session_id.bytes || now < w->capture_monotonic_ms || now - w->capture_monotonic_ms > 250)
    return {WindowPod{}, FieldState::not_observed};
  WindowPod pod; pod.handle = w->handle; pod.x = w->client.x; pod.y = w->client.y; pod.width = w->client.width; pod.height = w->client.height;
  pod.dpi = w->dpi; pod.foreground = w->foreground; pod.minimized = w->minimized; pod.display_mode = DisplayMode::unknown;
  return {pod, FieldState::available};
}

Continuity continuity(const sdk::V1Current& current, std::uint64_t endpoint_coalesced) noexcept {
  return {saturating_add(current.continuity.coalesced_snapshots, endpoint_coalesced), current.continuity.offline_transitions};
}

std::uint64_t carried_ns(const Outbound& item) noexcept {
  if (item.gap) return item.range.last_lost_ns.value_or(0);
  return item.event.occurred.monotonic_ns.available() ? item.event.occurred.monotonic_ns.value : 0;
}

std::uint64_t CaptureStamp::stamp(std::uint64_t now_ns, std::uint64_t carried) noexcept {
  if (now_ns > last_) last_ = now_ns;
  if (carried > last_) last_ = carried;
  return last_;
}
} // namespace ets2telemetry::v1
