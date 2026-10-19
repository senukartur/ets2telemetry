#pragma once
// ET-019 extended campaigns: ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER multiplies the iteration counts of the seeded native
// fuzz cases (snapshot-transport `fuzz`, v1-producer `fuzz`, v1-transport `fuzz`). Unset or empty means 1, the PR run;
// the extended Windows job sets 50 (docs/ci.md#et-019-extended-campaigns). Any other value than a decimal integer from 1
// to 1000 throws, so a typo can never silently run the default campaign. The seeds are unchanged, so each multiplier
// gives a fixed, reproducible input sequence, and the first loop of each case begins with the inputs of the PR run.
#include <cstdlib>
#include <stdexcept>
#include <string>

namespace ets2telemetry::test {
inline unsigned native_fuzz_multiplier() {
  constexpr unsigned maximum = 1000;
  char* raw = nullptr; std::size_t length = 0;
  if (_dupenv_s(&raw, &length, "ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER") != 0) throw std::runtime_error("ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER could not be read");
  const std::string text = raw ? raw : ""; std::free(raw);
  if (text.empty()) return 1;
  bool digits = text.size() <= 4;
  for (const char c : text) digits = digits && c >= '0' && c <= '9';
  const unsigned value = digits ? static_cast<unsigned>(std::stoul(text)) : 0;
  if (!digits || value < 1 || value > maximum) throw std::runtime_error("ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER must be an integer from 1 to 1000, got \"" + text + "\"");
  return value;
}
} // namespace ets2telemetry::test
