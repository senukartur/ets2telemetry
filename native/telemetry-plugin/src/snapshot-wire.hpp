#pragma once
#include "sdk-adapter.hpp"
#include "protocol-v0.hpp"

namespace ets2telemetry::transport {
// Only the transport thread constructs JSON; SDK callback storage stays fixed-size.
v0::Message current_message(const sdk::Snapshot&, const char* kind, std::uint64_t seq,
                            v0::Continuity, bool diagnostics = false);
v0::Message diagnostic_message(const sdk::Snapshot&, std::uint64_t seq,
                               v0::Continuity&, std::uint64_t& omitted);
}
