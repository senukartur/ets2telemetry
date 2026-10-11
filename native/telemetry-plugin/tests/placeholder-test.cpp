#include <cstdint>
#include <iostream>
extern "C" __declspec(dllimport) std::uint32_t ets2telemetry_scaffold_version() noexcept;
int main() {
    if (sizeof(void*) != 8 || ets2telemetry_scaffold_version() != 1) {
        std::cerr << "Unexpected architecture or exported scaffold contract\n";
        return 1;
    }
    return 0;
}
