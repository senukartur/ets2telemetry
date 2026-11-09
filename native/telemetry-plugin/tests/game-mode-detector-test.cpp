#include "game-mode-detector.hpp"
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using namespace ets2telemetry;

namespace {
std::vector<std::wstring> queried_modules;
game_mode::LookupResult haulmp_result = game_mode::LookupResult::missing;
game_mode::LookupResult tmp_result = game_mode::LookupResult::missing;

game_mode::LookupResult mock_lookup(const wchar_t* name) noexcept {
  queried_modules.push_back(name);
  if (std::wcscmp(name, L"haulmp_stub.dll") == 0) return haulmp_result;
  if (std::wcscmp(name, L"core_ets2mp.dll") == 0 || std::wcscmp(name, L"core_atsmp.dll") == 0) return tmp_result;
  return game_mode::LookupResult::missing;
}

void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
}

int main() {
  try {
    // 1. ETS2 HaulMP detection
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::present;
    tmp_result = game_mode::LookupResult::missing;
    auto mode = game_mode::detect(v1::GameId::ets2, mock_lookup);
    require(mode.mode == v1::GameModeKind::haulmp && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::strong, "ETS2 HaulMP positive evidence");
    require(mode.module.view() == "haulmp_stub.dll", "ETS2 HaulMP module name");

    // 2. ETS2 TruckersMP detection
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::present;
    mode = game_mode::detect(v1::GameId::ets2, mock_lookup);
    require(mode.mode == v1::GameModeKind::truckersmp && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::strong, "ETS2 TruckersMP positive evidence");
    require(mode.module.view() == "core_ets2mp.dll", "ETS2 TruckersMP module name");

    // 3. ETS2 Single player (neither module present)
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::missing;
    mode = game_mode::detect(v1::GameId::ets2, mock_lookup);
    require(mode.mode == v1::GameModeKind::single_player && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::weak, "ETS2 single player absence is weak");
    require(mode.module.state != v1::FieldState::available, "ETS2 single player has no module");

    // 4. ETS2 Lookup failure on first module
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::failed;
    tmp_result = game_mode::LookupResult::missing;
    mode = game_mode::detect(v1::GameId::ets2, mock_lookup);
    require(mode.mode == v1::GameModeKind::unknown && mode.method == v1::DetectionMethod::none && mode.confidence == v1::Confidence::none, "ETS2 lookup failure resets evidence");

    // 5. ETS2 Lookup failure on second module
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::failed;
    mode = game_mode::detect(v1::GameId::ets2, mock_lookup);
    require(mode.mode == v1::GameModeKind::unknown && mode.method == v1::DetectionMethod::none && mode.confidence == v1::Confidence::none, "ETS2 second lookup failure resets evidence");

    // 6. ATS TruckersMP detection
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::present;
    mode = game_mode::detect(v1::GameId::ats, mock_lookup);
    require(mode.mode == v1::GameModeKind::truckersmp && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::strong, "ATS TruckersMP positive evidence");
    require(mode.module.view() == "core_atsmp.dll", "ATS TruckersMP module name");
    require(queried_modules.size() == 1 && queried_modules[0] == L"core_atsmp.dll", "ATS queries only core_atsmp.dll (no HaulMP check)");

    // 7. ATS Single player
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::missing;
    mode = game_mode::detect(v1::GameId::ats, mock_lookup);
    require(mode.mode == v1::GameModeKind::single_player && mode.method == v1::DetectionMethod::module_scan && mode.confidence == v1::Confidence::weak, "ATS single player absence");

    // 8. ATS Lookup failure
    queried_modules.clear();
    haulmp_result = game_mode::LookupResult::missing;
    tmp_result = game_mode::LookupResult::failed;
    mode = game_mode::detect(v1::GameId::ats, mock_lookup);
    require(mode.mode == v1::GameModeKind::unknown && mode.method == v1::DetectionMethod::none && mode.confidence == v1::Confidence::none, "ATS failure resets");

    // 9. Invalid GameId
    queried_modules.clear();
    mode = game_mode::detect(static_cast<v1::GameId>(255), mock_lookup);
    require(mode.mode == v1::GameModeKind::unknown && queried_modules.empty(), "missing signature makes no lookup");

    // 10. Real loaded_module lookup checks
    require(game_mode::loaded_module(L"KERNEL32.DLL") == game_mode::LookupResult::present && game_mode::loaded_module(L"kernel32.dll") == game_mode::LookupResult::present, "Windows lookup is case insensitive");
    require(game_mode::loaded_module(L"et059-synthetic-unrelated-module.dll") == game_mode::LookupResult::missing, "unrelated synthetic name absent");

    std::cout << "game mode detector contract passed\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
