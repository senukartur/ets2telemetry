#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "game-window-monitor.hpp"
#include <cwchar>
#include <cstring>
#include <limits>

namespace ets2telemetry::window {
namespace {
thread_local Monitor* callback_monitor = nullptr;
constexpr unsigned max_windows = 4096;
std::uint64_t token(FILETIME value) noexcept {
  return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
bool creation(HANDLE process, std::uint64_t& value) noexcept {
  FILETIME created{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exit, &kernel, &user)) return false;
  value = token(created); return value != 0;
}
bool rectangle(const RECT& rect, Bounds& result) noexcept {
  const auto width = static_cast<std::int64_t>(rect.right) - rect.left;
  const auto height = static_cast<std::int64_t>(rect.bottom) - rect.top;
  if (width <= 0 || height <= 0 || width > UINT32_MAX || height > UINT32_MAX) return false;
  result = {rect.left, rect.top, static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height)};
  return true;
}
bool eligible(HWND hwnd, DWORD pid) noexcept {
  DWORD owner = 0;
  return GetWindowThreadProcessId(hwnd, &owner) != 0 && owner == pid &&
    GetAncestor(hwnd, GA_ROOT) == hwnd && !GetWindow(hwnd, GW_OWNER) &&
    !(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW);
}
struct Enumeration {
  DWORD pid;
  const std::atomic<bool>* stopping;
  HWND candidate = nullptr;
  unsigned count = 0, visited = 0;
  bool capped = false;
};
BOOL CALLBACK enumerate(HWND hwnd, LPARAM parameter) noexcept {
  auto& state = *reinterpret_cast<Enumeration*>(parameter);
  if (state.stopping->load(std::memory_order_acquire)) return FALSE;
  if (++state.visited > max_windows) { state.capped = true; return FALSE; }
  if (eligible(hwnd, state.pid) && IsWindowVisible(hwnd)) {
    state.candidate = hwnd;
    if (++state.count > 1) return FALSE;
  }
  return TRUE;
}
}
Monitor::~Monitor() { stop(); }
Snapshot Monitor::latest() const noexcept {
  try { std::lock_guard<std::mutex> lock(mutex_); return latest_; }
  catch (...) { return {}; }
}
void Monitor::publish(Snapshot value) noexcept {
  value.revision = ++revision_;
  value.window_generation = generation_;
  value.capture_monotonic_ms = GetTickCount64();
  try { std::lock_guard<std::mutex> lock(mutex_); latest_ = value; } catch (...) {}
}
bool Monitor::start(const char* game, const char* session) noexcept { return start_impl(game, session, false); }
#ifdef ETS2TELEMETRY_WINDOW_TEST_HOST
bool Monitor::start_test_host(const char* session) noexcept { return start_impl(nullptr, session, true); }
#endif
bool Monitor::start_impl(const char* game, const char* session, bool test_host) noexcept {
  if (worker_.joinable()) return false;
  identity_ = {}; identity_.status = Status::identity_rejected;
  tracked_ = nullptr; invalidated_ = false;
  if (!session || std::strlen(session) != 36) { publish(identity_); return false; }
  std::memcpy(identity_.plugin_session_id.data(), session, 36);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, GetCurrentProcessId());
  wchar_t image[32768]{}; DWORD length = static_cast<DWORD>(std::size(image));
  DWORD session_id = 0;
  bool verified = process && QueryFullProcessImageNameW(process, 0, image, &length) &&
    creation(process, identity_.process_creation_time) && ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
  const wchar_t* filename = std::wcsrchr(image, L'\\'); filename = filename ? filename + 1 : image;
  if (!test_host) {
    verified = verified && game &&
      ((std::strcmp(game, "eut2") == 0 && _wcsicmp(filename, L"eurotrucks2.exe") == 0) ||
       (std::strcmp(game, "ats") == 0 && _wcsicmp(filename, L"amtrucks.exe") == 0));
  }
  if (!verified) { if (process) CloseHandle(process); publish(identity_); return false; }
  identity_.process_id = GetCurrentProcessId(); identity_.windows_session_id = session_id;
  identity_.status = Status::unavailable;
  process_ = process;
  stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_event_) { CloseHandle(process); process_ = nullptr; publish(identity_); return false; }
  stopping_.store(false, std::memory_order_release);
  publish(identity_);
  try { worker_ = std::thread(&Monitor::run, this); return true; }
  catch (...) { CloseHandle(stop_event_); CloseHandle(process_); stop_event_ = process_ = nullptr; return false; }
}
void Monitor::stop() noexcept {
  stopping_.store(true, std::memory_order_release);
  if (stop_event_) SetEvent(stop_event_);
  if (worker_.joinable()) worker_.join();
  if (stop_event_) CloseHandle(stop_event_);
  if (process_) CloseHandle(process_);
  stop_event_ = process_ = tracked_ = nullptr;
  Snapshot stopped = identity_; stopped.status = Status::stopped; publish(stopped);
}
void CALLBACK Monitor::destroyed(HWINEVENTHOOK, DWORD, HWND hwnd, LONG object, LONG child, DWORD, DWORD) noexcept {
  if (callback_monitor && object == OBJID_WINDOW && child == CHILDID_SELF && hwnd == callback_monitor->tracked_)
    callback_monitor->invalidated_ = true;
}
void Monitor::run() noexcept {
  const auto previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!previous || !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    if (previous) SetThreadDpiAwarenessContext(previous);
    publish(identity_); return;
  }
  callback_monitor = this;
  const auto hook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, nullptr,
    &Monitor::destroyed, identity_.process_id, 0, WINEVENT_OUTOFCONTEXT);
  // Missing destruction observations would allow a reused HWND to retain identity.
  if (!hook) { callback_monitor = nullptr; SetThreadDpiAwarenessContext(previous); publish(identity_); return; }
  MSG message{};
  while (!stopping_.load(std::memory_order_acquire)) {
    // Drain a bounded batch. If still queued, publish unavailable until caught up.
    unsigned messages = 0;
    while (messages < 256 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message); DispatchMessageW(&message); ++messages;
    }
    Snapshot value = identity_; value.per_monitor_v2 = true;
    std::uint64_t current_creation = 0; DWORD current_session = 0;
    const bool identity_valid = GetProcessId(process_) == identity_.process_id &&
      WaitForSingleObject(process_, 0) == WAIT_TIMEOUT && creation(process_, current_creation) &&
      current_creation == identity_.process_creation_time &&
      ProcessIdToSessionId(identity_.process_id, &current_session) && current_session == identity_.windows_session_id;
    if (invalidated_ || !identity_valid || (tracked_ && !eligible(static_cast<HWND>(tracked_), identity_.process_id))) {
      tracked_ = nullptr; invalidated_ = false;
    }
    Enumeration state{identity_.process_id, &stopping_};
    if (identity_valid && messages < 256) {
      SetLastError(ERROR_SUCCESS);
      const BOOL enumerated = EnumWindows(enumerate, reinterpret_cast<LPARAM>(&state));
      const bool enum_ok = enumerated || state.count > 1;
      if (state.count > 1 || (state.count == 1 && tracked_ && state.candidate != tracked_)) {
        // Retain the identity internally: a hidden old window plus a new visible
        // candidate must remain ambiguous on subsequent polls, not self-resolve.
        value.status = Status::ambiguous;
      }
      else if (enum_ok && !state.capped && !stopping_.load(std::memory_order_acquire)) {
        HWND selected = state.count == 1 ? state.candidate : static_cast<HWND>(tracked_);
        if (selected && selected != tracked_) { tracked_ = selected; ++generation_; }
        if (selected && eligible(selected, identity_.process_id)) {
          RECT client{}; POINT origin{}; MONITORINFO info{}; info.cbSize = sizeof(info);
          const auto monitor = MonitorFromWindow(selected, MONITOR_DEFAULTTONEAREST);
          const auto dpi = GetDpiForWindow(selected);
          value.minimized = IsIconic(selected) != FALSE;
          value.client_bounds_available = GetClientRect(selected, &client) && ClientToScreen(selected, &origin) && rectangle(client, value.client);
          if ((value.client_bounds_available || value.minimized) && monitor && GetMonitorInfoW(monitor, &info) &&
              rectangle(info.rcMonitor, value.monitor_bounds) && dpi && eligible(selected, identity_.process_id)) {
            if (value.client_bounds_available) { value.client.x = origin.x; value.client.y = origin.y; }
            value.status = Status::available; value.handle = reinterpret_cast<std::uint64_t>(selected);
            value.monitor = reinterpret_cast<std::uint64_t>(monitor); value.dpi = dpi;
            value.visible = IsWindowVisible(selected) != FALSE;
            value.foreground = GetForegroundWindow() == selected;
          }
        }
      }
    }
    if (!identity_valid) value.status = Status::identity_rejected;
    publish(value);
    const auto wait = MsgWaitForMultipleObjectsEx(1, &stop_event_, 50, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_FAILED) break;
  }
  UnhookWinEvent(hook); callback_monitor = nullptr;
  SetThreadDpiAwarenessContext(previous);
}
} // namespace ets2telemetry::window
