// Build-channel identities (ET-055 UP12). Pins every production name to the literal that releases before ET-055 used,
// checks the staging names, proves that no name is shared between the channels, and checks that this build's plugin code
// and product DLLs use the configured channel. Pure name checks and version-resource reads only: nothing is loaded,
// created or written, and %LOCALAPPDATA% is never used.
// Protects REG-015 and REG-017 in part: the project manages only its own channel's plugin, and production assets keep
// their names.
#include "channel-identity.hpp"
#include "capture-server.hpp"
#include "pipe-discovery.hpp"
#include <winver.h>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ets2telemetry;
namespace {
unsigned assertions = 0;
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
bool same(const char* a, const char* b) { return std::strcmp(a, b) == 0; }
bool same(const wchar_t* a, const wchar_t* b) { return std::wcscmp(a, b) == 0; }
bool starts_with(const std::wstring& value, const wchar_t* prefix) { return value.rfind(prefix, 0) == 0; }
std::wstring widen(const char* ascii) { std::wstring out; for (const char* c = ascii; *c; ++c) out.push_back(static_cast<wchar_t>(static_cast<unsigned char>(*c))); return out; }

// Production must stay byte-for-byte what earlier releases shipped: the application, the uninstall cleanup and plugins
// already loaded in a running game depend on these names.
void production_golden() {
  require(same(channel::production.name, "production"), "production channel name");
  require(same(channel::production.pipe_prefix, "\\\\.\\pipe\\ETS2Telemetry-"), "production pipe prefix unchanged");
  require(same(channel::production.pipe_prefix_wide, L"\\\\.\\pipe\\ETS2Telemetry-"), "production wide pipe prefix unchanged");
  require(same(channel::production.data_root, L"ETS2Telemetry"), "production data root unchanged");
  require(same(channel::production.plugin_file, "ets2telemetry-plugin.dll"), "production plugin DLL name unchanged");
  require(same(channel::production.game_log_prefix, "ETS2Telemetry:"), "production game-log prefix unchanged");
}
void staging_values() {
  require(same(channel::staging.name, "staging"), "staging channel name");
  require(same(channel::staging.pipe_prefix, "\\\\.\\pipe\\ETS2TelemetryStaging-"), "staging pipe prefix");
  require(same(channel::staging.pipe_prefix_wide, L"\\\\.\\pipe\\ETS2TelemetryStaging-"), "staging wide pipe prefix");
  require(same(channel::staging.data_root, L"ETS2TelemetryStaging"), "staging data root");
  require(same(channel::staging.plugin_file, "ets2telemetry-plugin-staging.dll"), "staging plugin DLL name");
  require(same(channel::staging.game_log_prefix, "ETS2TelemetryStaging:"), "staging game-log prefix");
}
// No identity is shared. Windows compares file and pipe names case-insensitively, so the checks do too, and neither pipe
// prefix may start the other: a prefix match must never select the other channel's endpoint.
void nothing_shared() {
  for (const auto* identity : {&channel::production, &channel::staging})
    require(widen(identity->pipe_prefix) == identity->pipe_prefix_wide, "narrow and wide pipe prefixes agree");
  require(_stricmp(channel::production.name, channel::staging.name) != 0, "channel names differ");
  require(_wcsicmp(channel::production.pipe_prefix_wide, channel::staging.pipe_prefix_wide) != 0, "pipe prefixes differ");
  const auto p = std::wstring(channel::production.pipe_prefix_wide), s = std::wstring(channel::staging.pipe_prefix_wide);
  require(_wcsnicmp(p.c_str(), s.c_str(), p.size()) != 0 && _wcsnicmp(s.c_str(), p.c_str(), s.size()) != 0, "neither pipe prefix starts the other");
  require(_wcsicmp(channel::production.data_root, channel::staging.data_root) != 0, "data roots differ");
  require(_stricmp(channel::production.plugin_file, channel::staging.plugin_file) != 0, "plugin DLL names differ");
  require(_stricmp(channel::production.game_log_prefix, channel::staging.game_log_prefix) != 0, "game-log prefixes differ");
}
// The compiled plugin code uses the active channel for every endpoint and for its default transport directory.
void active_channel(const std::string& configured) {
  require(configured == channel::active.name, "the compiled channel is the configured ETS2TELEMETRY_CHANNEL");
  // The fixed game-log messages are built from the macro; it must be the active channel's prefix.
  require(same(ETS2TELEMETRY_GAME_LOG_PREFIX, channel::active.game_log_prefix), "game-log macro is the active channel's prefix");
  auto source = std::make_unique<sdk::Snapshot>();
  require(source->identity.game.assign("ets2") && source->identity.process_instance_id.assign("00000000-0000-4000-8000-0000000000a1") &&
    source->identity.plugin_session_id.assign("00000000-0000-4000-8000-0000000000b2"), "synthetic source identity");
  transport::UserIdentity user; user.tag = std::string(64, 'a'); user.session = 7;
  const auto tail = std::wstring(L"-") + std::wstring(64, L'a') + L"-7-00000000-0000-4000-8000-0000000000a1";
  require(transport::endpoint_name(*source, user) == std::wstring(channel::active.pipe_prefix_wide) + L"ets2-v0" + tail, "v0 endpoint under the channel prefix");
  require(transport::endpoint_name(*source, user, 1) == std::wstring(channel::active.pipe_prefix_wide) + L"ets2-v1" + tail, "v1 endpoint under the channel prefix");
  require(cap0::capture_endpoint_name(*source, user) == std::wstring(channel::active.pipe_prefix_wide) + L"ets2-cap0" + tail + L"-00000000-0000-4000-8000-0000000000b2",
    "CAP0 endpoint under the channel prefix");
  require(transport::application_directory(L"C:\\Users\\fixture\\AppData\\Local") == std::wstring(L"C:\\Users\\fixture\\AppData\\Local\\") + channel::active.data_root,
    "transport directories under the channel's data root");
  const auto& other = &channel::active == &channel::production ? channel::staging : channel::production;
  require(!starts_with(transport::endpoint_name(*source, user), other.pipe_prefix_wide), "no endpoint under the other channel's prefix");
}
// OriginalFilename from the DLL's version resource. Reading the resource maps the file as data; nothing is executed.
std::wstring original_filename(const std::wstring& file) {
  DWORD ignored = 0; const auto size = GetFileVersionInfoSizeW(file.c_str(), &ignored); require(size > 0, "plugin DLL has a version resource");
  std::vector<unsigned char> data(size); require(GetFileVersionInfoW(file.c_str(), 0, size, data.data()) != FALSE, "version resource readable");
  struct Translation { WORD language, codepage; }* translation = nullptr; UINT length = 0;
  require(VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translation), &length) != FALSE && length >= sizeof(Translation), "version translation");
  wchar_t key[64]{}; swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\OriginalFilename", translation->language, translation->codepage);
  wchar_t* value = nullptr; require(VerQueryValueW(data.data(), key, reinterpret_cast<void**>(&value), &length) != FALSE && length > 0, "OriginalFilename present");
  return value;
}
// The configured product DLL and the other channel's product DLL, both built from this tree, carry their channel's name.
void product_dlls(const std::wstring& configured_dll, const std::wstring& other_dll) {
  const auto& other = &channel::active == &channel::production ? channel::staging : channel::production;
  for (const auto& [file, identity] : {std::pair<std::wstring, const channel::Identity*>{configured_dll, &channel::active}, {other_dll, &other}}) {
    require(std::filesystem::path(file).filename().wstring() == widen(identity->plugin_file), "product DLL file name is the channel's plugin_file");
    require(original_filename(file) == widen(identity->plugin_file), "VERSIONINFO OriginalFilename is the channel's plugin_file");
  }
}
}
int main(int argc, char** argv) {
  try {
    if (argc != 4) throw std::runtime_error("usage: channel-identity-test <configured channel> <product DLL> <other-channel product DLL>");
    // Command-line paths arrive in the ANSI code page; std::filesystem::path converts them as Windows does.
    const auto path = [](const char* a) { return std::filesystem::path(a).wstring(); };
    production_golden(); staging_values(); nothing_shared(); active_channel(argv[1]); product_dlls(path(argv[2]), path(argv[3]));
    std::cout << "Native channel identities: " << assertions << " assertions passed (channel " << channel::active.name << ")\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << "Channel identity failure after " << assertions << " assertions: " << e.what() << '\n'; return 1; }
}
