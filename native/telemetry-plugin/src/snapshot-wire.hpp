#pragma once
#include "sdk-adapter.hpp"
#include "protocol-v0.hpp"
#include "game-window-monitor.hpp"

namespace ets2telemetry::transport {
// Only the transport thread constructs JSON; SDK callback storage stays fixed-size.
v0::Message current_message(const sdk::Snapshot&, const char* kind, std::uint64_t seq,
                            v0::Continuity, bool diagnostics = false,
                            const window::Snapshot* window = nullptr,
                            std::uint64_t process_creation = 0, std::uint64_t now_ms = 0);
// Pure fail-closed identity/age mapping; no HWND operations occur in serialization.
v0::Available<v0::GameWindow> current_window(const sdk::Snapshot&, const window::Snapshot*,
                                          std::uint64_t process_creation, std::uint64_t now_ms);
v0::Message diagnostic_message(const sdk::Snapshot&, std::uint64_t seq,
                               v0::Continuity&, std::uint64_t& omitted);
}
