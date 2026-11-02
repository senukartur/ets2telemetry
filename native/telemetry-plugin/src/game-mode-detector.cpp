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
  const wchar_t* wide = nullptr; const char* name = nullptr;
  if (game == v1::GameId::ets2) { wide = L"core_ets2mp.dll"; name = "core_ets2mp.dll"; }
  else if (game == v1::GameId::ats) { wide = L"core_atsmp.dll"; name = "core_atsmp.dll"; }
  v1::GameModePod output;
  if (!wide || !lookup) return output;
  const auto result = lookup(wide);
  if (result == LookupResult::failed) return output;
  output.method = v1::DetectionMethod::module_scan;
  output.mode = result == LookupResult::present ? v1::GameModeKind::truckersmp : v1::GameModeKind::single_player;
  output.confidence = result == LookupResult::present ? v1::Confidence::strong : v1::Confidence::weak;
  if (result == LookupResult::present) output.module.assign(name);
  return output;
}
} // namespace ets2telemetry::game_mode
