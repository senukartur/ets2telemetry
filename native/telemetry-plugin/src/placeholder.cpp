#include <cstdint>
// This is deliberately not an SCS entrypoint and must not be installed in a game.
extern "C" __declspec(dllexport) std::uint32_t ets2telemetry_scaffold_version() noexcept {
    return 1;
}
