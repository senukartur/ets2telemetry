#pragma once
#include "protocol-v1-records.hpp"

namespace ets2telemetry::game_mode {
enum class LookupResult { present, missing, failed };
using Lookup = LookupResult (*)(const wchar_t*) noexcept;
// One in-process lookup; the returned module handle is never used or released.
LookupResult loaded_module(const wchar_t* basename) noexcept;
v1::GameModePod detect(v1::GameId game, Lookup lookup = loaded_module) noexcept;
} // namespace ets2telemetry::game_mode
