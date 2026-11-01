#include "game-mode-detector.hpp"
#include <cwchar>
#include <iostream>
#include <stdexcept>
using namespace ets2telemetry;
// Injected outcomes are synthetic; no real-game signature or initialization timing is validated here.
namespace {
unsigned calls = 0;
const wchar_t* expected = L"core_ets2mp.dll";
game_mode::LookupResult result = game_mode::LookupResult::present;
bool matched = false;
game_mode::LookupResult lookup(const wchar_t* name) noexcept { ++calls; matched = std::wcscmp(name, expected) == 0; return result; }
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
}
int main() {
  try {
    for (const auto game : {v1::GameId::ets2, v1::GameId::ats}) {
      expected = game == v1::GameId::ets2 ? L"core_ets2mp.dll" : L"core_atsmp.dll";
      for (const auto state : {game_mode::LookupResult::present, game_mode::LookupResult::missing, game_mode::LookupResult::failed}) {
        calls = 0; matched = false; result = state;
        const auto mode = game_mode::detect(game, lookup);
        require(calls == 1 && matched, "exact game-specific name and one lookup");
        if (state == game_mode::LookupResult::present) {
          require(mode.mode == v1::GameModeKind::truckersmp && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::strong, "positive evidence");
          require(mode.module.view() == (game == v1::GameId::ets2 ? "core_ets2mp.dll" : "core_atsmp.dll"), "module retained");
        } else if (state == game_mode::LookupResult::missing) require(mode.mode == v1::GameModeKind::single_player && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::weak && mode.module.state != v1::FieldState::available, "absence is weak evidence");
        else require(mode.mode == v1::GameModeKind::unknown && mode.method == v1::DetectionMethod::none && mode.confidence == v1::Confidence::none && mode.module.state != v1::FieldState::available, "failure resets evidence");
      }
    }
    calls = 0; require(game_mode::detect(static_cast<v1::GameId>(255), lookup).mode == v1::GameModeKind::unknown && calls == 0, "missing signature makes no lookup");
    require(game_mode::loaded_module(L"KERNEL32.DLL") == game_mode::LookupResult::present && game_mode::loaded_module(L"kernel32.dll") == game_mode::LookupResult::present, "Windows lookup is case insensitive");
    require(game_mode::loaded_module(L"et059-synthetic-unrelated-module.dll") == game_mode::LookupResult::missing, "unrelated synthetic name absent");
    std::cout << "game mode detector contract passed\n"; return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
