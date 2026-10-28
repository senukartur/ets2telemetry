#pragma once
// Build-channel identities of the native artifacts (ET-055 UP12). A production and a staging installation can run side by
// side, with both plugins loaded in one game, only because every name they would otherwise share differs: the pipe
// prefix of the v0, v1 and CAP0 endpoints, the folder under %LOCALAPPDATA% that holds the protected transport discovery
// and policy directories, and the plugin DLL file name. Production values are the names every release before ET-055
// used and must never change; channel-identity-test pins them. The prefix of the plugin's lines in the SCS game log differs
// too (ET-055 coordinator decision), so that the lines of two plugins in one game log are told apart.
//
// The plugin and the native broker (native/telemetry-client) compile this header. CMake selects the active channel at
// build time with exactly one of ETS2TELEMETRY_CHANNEL_PRODUCTION or ETS2TELEMETRY_CHANNEL_STAGING (the
// ETS2TELEMETRY_CHANNEL cache variable); nothing switches it at run time. A translation unit compiled without either
// definition still sees both tables, but `active` does not exist, so product code that needs it fails to compile.

namespace ets2telemetry::channel {
struct Identity {
  // "production" or "staging", the value of the ETS2TELEMETRY_CHANNEL cache variable.
  const char* name;
  // Every v0, v1 and CAP0 endpoint name starts with this prefix; the rest of the name is the same in both channels.
  const char* pipe_prefix;
  const wchar_t* pipe_prefix_wide;
  // Folder directly under %LOCALAPPDATA%: the plugin's default transport directories are <root>\transport\v0 and \v1.
  const wchar_t* data_root;
  // File name of the game plugin DLL; CMake sets the DLL's OUTPUT_NAME and VERSIONINFO OriginalFilename to it.
  const char* plugin_file;
  // First word of every message the plugin writes to the SCS game log, ETS2TELEMETRY_GAME_LOG_PREFIX for the active channel.
  const char* game_log_prefix;
};

// The game-log prefixes as string-literal macros, so a fixed message is one literal: ETS2TELEMETRY_GAME_LOG_PREFIX " text".
#define ETS2TELEMETRY_GAME_LOG_PREFIX_PRODUCTION "ETS2Telemetry:"
#define ETS2TELEMETRY_GAME_LOG_PREFIX_STAGING "ETS2TelemetryStaging:"

inline constexpr Identity production{"production", "\\\\.\\pipe\\ETS2Telemetry-", L"\\\\.\\pipe\\ETS2Telemetry-", L"ETS2Telemetry",
  "ets2telemetry-plugin.dll", ETS2TELEMETRY_GAME_LOG_PREFIX_PRODUCTION};
inline constexpr Identity staging{"staging", "\\\\.\\pipe\\ETS2TelemetryStaging-", L"\\\\.\\pipe\\ETS2TelemetryStaging-",
  L"ETS2TelemetryStaging", "ets2telemetry-plugin-staging.dll", ETS2TELEMETRY_GAME_LOG_PREFIX_STAGING};

#if defined(ETS2TELEMETRY_CHANNEL_PRODUCTION) && defined(ETS2TELEMETRY_CHANNEL_STAGING)
#error "Define exactly one build channel: ETS2TELEMETRY_CHANNEL_PRODUCTION or ETS2TELEMETRY_CHANNEL_STAGING"
#elif defined(ETS2TELEMETRY_CHANNEL_PRODUCTION)
inline constexpr const Identity& active = production;
#define ETS2TELEMETRY_GAME_LOG_PREFIX ETS2TELEMETRY_GAME_LOG_PREFIX_PRODUCTION
#elif defined(ETS2TELEMETRY_CHANNEL_STAGING)
inline constexpr const Identity& active = staging;
#define ETS2TELEMETRY_GAME_LOG_PREFIX ETS2TELEMETRY_GAME_LOG_PREFIX_STAGING
#endif
} // namespace ets2telemetry::channel
