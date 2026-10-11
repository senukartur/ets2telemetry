#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace ets2telemetry::window {
enum class Status { stopped, identity_rejected, unavailable, ambiguous, available };
enum class DisplayMode { unknown };
struct Bounds {
  std::int32_t x = 0, y = 0;
  std::uint32_t width = 0, height = 0;
};
struct Snapshot {
  Status status = Status::stopped;
  std::uint64_t revision = 0, window_generation = 0, capture_monotonic_ms = 0;
  std::uint32_t process_id = 0, windows_session_id = 0, dpi = 0;
  std::uint64_t process_creation_time = 0, handle = 0, monitor = 0;
  std::array<char, 37> plugin_session_id{};
  Bounds client, monitor_bounds;
  bool visible = false, minimized = false, foreground = false, per_monitor_v2 = false, client_bounds_available = false;
  DisplayMode display_mode = DisplayMode::unknown;
};
// Lifecycle methods are owned by the SDK init/shutdown thread. Readers copy one
// bounded latest value; no SDK-owned data or HWND authority crosses this API.
class Monitor {
public:
  Monitor() = default;
  ~Monitor();
  Monitor(const Monitor&) = delete;
  Monitor& operator=(const Monitor&) = delete;
  bool start(const char* sdk_game_id, const char* plugin_session_id) noexcept;
  void stop() noexcept;
  Snapshot latest() const noexcept;
#ifdef ETS2TELEMETRY_WINDOW_TEST_HOST
  bool start_test_host(const char* plugin_session_id) noexcept;
#endif
private:
  bool start_impl(const char* game, const char* session, bool test_host) noexcept;
  void run() noexcept;
  void publish(Snapshot value) noexcept;
  static void CALLBACK destroyed(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) noexcept;
  mutable std::mutex mutex_;
  Snapshot latest_{};
  Snapshot identity_{};
  std::thread worker_;
  std::atomic<bool> stopping_{false};
  void* stop_event_ = nullptr;
  void* process_ = nullptr;
  void* tracked_ = nullptr;
  std::uint64_t generation_ = 0, revision_ = 0;
  bool invalidated_ = false;
};
} // namespace ets2telemetry::window
