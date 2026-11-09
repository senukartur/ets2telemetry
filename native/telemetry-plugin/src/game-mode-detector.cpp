#include "game-mode-detector.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace ets2telemetry::game_mode {
LookupResult loaded_module(const wchar_t* basename) noexcept {
  HMODULE module = nullptr;
  SetLastError(ERROR_SUCCESS);
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, basename, &module)) return LookupResult::present;
  return GetLastError() == ERROR_MOD_NOT_FOUND ? LookupResult::missing : LookupResult::failed;
}
v1::GameModePod detect(v1::GameId game, Lookup lookup) noexcept {
  v1::GameModePod output;
  if (!lookup) return output;

  if (game == v1::GameId::ets2) {
    const auto tmp_result = lookup(L"core_ets2mp.dll");
    if (tmp_result == LookupResult::failed) return output;
    if (tmp_result == LookupResult::present) {
      output.method = v1::DetectionMethod::module_scan;
      output.mode = v1::GameModeKind::truckersmp;
      output.confidence = v1::Confidence::strong;
      output.module.assign("core_ets2mp.dll");
      return output;
    }

    const auto haulmp_result = lookup(L"haulmp_stub.dll");
    if (haulmp_result == LookupResult::failed) return output;
    if (haulmp_result == LookupResult::present) {
      output.method = v1::DetectionMethod::module_scan;
      output.mode = v1::GameModeKind::haulmp;
      output.confidence = v1::Confidence::strong;
      output.module.assign("haulmp_stub.dll");
      return output;
    }

    output.method = v1::DetectionMethod::module_scan;
    output.mode = v1::GameModeKind::single_player;
    output.confidence = v1::Confidence::weak;
    return output;
  }

  if (game == v1::GameId::ats) {
    const auto result = lookup(L"core_atsmp.dll");
    if (result == LookupResult::failed) return output;
    output.method = v1::DetectionMethod::module_scan;
    output.mode = result == LookupResult::present ? v1::GameModeKind::truckersmp : v1::GameModeKind::single_player;
    output.confidence = result == LookupResult::present ? v1::Confidence::strong : v1::Confidence::weak;
    if (result == LookupResult::present) output.module.assign("core_atsmp.dll");
    return output;
  }

  return output;
}
} // namespace ets2telemetry::game_mode
