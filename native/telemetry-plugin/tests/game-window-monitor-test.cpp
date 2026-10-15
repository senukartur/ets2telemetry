#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "game-window-monitor.hpp"
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

using namespace ets2telemetry::window;
namespace {
constexpr const char* session = "d2d8825a-8943-4e70-9aac-d06b52fdd480";
unsigned checks = 0, failures = 0;
void check(bool condition, const char* name) {
  ++checks; if (!condition) { ++failures; std::cerr << "FAIL: " << name << '\n'; }
}
void pump() {
  MSG message{}; while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
}
template<class Predicate> bool await(Monitor& monitor, Predicate predicate) {
  const auto until = GetTickCount64() + 1500;
  do { pump(); if (predicate(monitor.latest())) return true; Sleep(5); } while (GetTickCount64() < until);
  return false;
}
LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) { return DefWindowProcW(hwnd, message, wp, lp); }
HWND create(int x = -400, int y = -300, int width = 320, int height = 200) {
  HWND hwnd = CreateWindowExW(WS_EX_NOACTIVATE, L"ETS2TelemetryControlledWindow", L"Controlled ET-007 fixture", WS_POPUP,
    x, y, width, height, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (hwnd) ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return hwnd;
}
bool same_physical(HWND hwnd, Snapshot value) {
  RECT rect{}; POINT origin{};
  return GetClientRect(hwnd, &rect) && ClientToScreen(hwnd, &origin) &&
    value.client.x == origin.x && value.client.y == origin.y &&
    value.client.width == static_cast<unsigned>(rect.right) && value.client.height == static_cast<unsigned>(rect.bottom) &&
    value.dpi == GetDpiForWindow(hwnd) && value.foreground == (GetForegroundWindow() == hwnd);
}
// Child start-up time is OS scheduling, not a monitor property: an ASan peer on a
// loaded hosted runner exceeded the former fixed 1.5 s readiness wait. These bound
// only a hung or lost peer and stay below the 20 s CTest limit together.
constexpr DWORD peer_ready_guard_ms = 10000, peer_exit_guard_ms = 5000;
// The peer outlives any CTest-permitted run unless stopped or orphaned first.
constexpr ULONGLONG peer_backstop_ms = 30000;
// Peer exit codes: 0 stopped by the parent's event (the only normal result); 2 setup
// failed (events, parent handle or window); 3 the parent exited first; 4 the backstop
// expired; 5 the stop wait itself failed or returned an unexpected result.
enum PeerExit : int { peer_stopped = 0, peer_setup_failed = 2, peer_orphaned = 3, peer_backstop = 4, peer_wait_failed = 5 };
// Optional fault injection: the peer sleeps this long before any set-up, standing in for
// a slow process start. It reproduces the hosted failure against a fixed start-up
// deadline and stays well below the readiness hang guard.
constexpr const char* peer_delay_option = "--peer-startup-delay-ms";
constexpr unsigned long peer_delay_limit_ms = 5000;
bool parse_delay(const char* text, unsigned long& value) {
  char* end = nullptr; value = std::strtoul(text, &end, 10);
  return end != text && *end == '\0' && value <= peer_delay_limit_ms;
}
// Same top-level shape the monitor accepts for its own process: visible, root, unowned, not a tool window.
bool monitor_shaped(HWND hwnd, DWORD pid) {
  DWORD owner = 0;
  return IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, &owner) != 0 && owner == pid && IsWindowVisible(hwnd) &&
    GetAncestor(hwnd, GA_ROOT) == hwnd && !GetWindow(hwnd, GW_OWNER) && !(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW);
}
struct PeerWindows { DWORD pid; HWND found = nullptr; unsigned count = 0; };
BOOL CALLBACK peer_windows(HWND hwnd, LPARAM parameter) {
  auto& state = *reinterpret_cast<PeerWindows*>(parameter);
  if (monitor_shaped(hwnd, state.pid)) { state.found = hwnd; ++state.count; }
  return TRUE;
}
struct Displays { std::array<RECT, 16> bounds{}; unsigned count = 0; };
BOOL CALLBACK displays(HMONITOR, HDC, LPRECT rect, LPARAM parameter) {
  auto& list = *reinterpret_cast<Displays*>(parameter);
  if (list.count == list.bounds.size()) return FALSE;
  list.bounds[list.count++] = *rect; return TRUE;
}
}
int main(int argc, char** argv) {
  const auto previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!previous) return 1;
  WNDCLASSW wc{}; wc.lpfnWndProc = procedure; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"ETS2TelemetryControlledWindow";
  if (!RegisterClassW(&wc)) return 1;
  if (argc == 5 && std::string(argv[1]) == "--peer") {
    // The window stays until the parent stops it or exits, so it cannot vanish during
    // the parent's unrelated-window observation however slowly either process runs.
    unsigned long delay = 0;
    if (!parse_delay(argv[4], delay)) return peer_setup_failed;
    if (delay) Sleep(delay);
    const auto event = OpenEventA(SYNCHRONIZE, FALSE, argv[2]);
    const auto ready = OpenEventA(EVENT_MODIFY_STATE, FALSE, (std::string(argv[2]) + "-ready").c_str());
    const auto parent = OpenProcess(SYNCHRONIZE, FALSE, std::strtoul(argv[3], nullptr, 10));
    const auto hwnd = create(-800, -700);
    if (!event || !ready || !parent || !hwnd) return peer_setup_failed;
    SetEvent(ready); CloseHandle(ready);
    const HANDLE waits[] = {event, parent};
    const auto deadline = GetTickCount64() + peer_backstop_ms;
    int result = peer_backstop;
    for (auto now = GetTickCount64(); now < deadline; now = GetTickCount64()) {
      const auto wait = MsgWaitForMultipleObjects(2, waits, FALSE, static_cast<DWORD>(deadline - now), QS_ALLINPUT);
      if (wait == WAIT_OBJECT_0) { result = peer_stopped; break; }
      if (wait == WAIT_OBJECT_0 + 1) { result = peer_orphaned; break; }
      if (wait == WAIT_TIMEOUT) break;
      if (wait != WAIT_OBJECT_0 + 2) { result = peer_wait_failed; break; }
      pump();
    }
    DestroyWindow(hwnd); CloseHandle(parent); CloseHandle(event); return result;
  }
  unsigned long peer_delay_ms = 0;
  if (argc != 1 && !(argc == 3 && std::string(argv[1]) == peer_delay_option && parse_delay(argv[2], peer_delay_ms))) {
    std::cerr << "usage: game-window-monitor-test [" << peer_delay_option << " <0-" << peer_delay_limit_ms << ">]\n";
    return 64;
  }
  Monitor production;
  check(!production.start("eut2", session) && production.latest().status == Status::identity_rejected, "SDK claim does not authenticate foreign executable");
  check(!production.start("ats", session), "ATS executable mismatch");
  check(!production.start("unknown", session), "unsupported actual game identity");
  Monitor monitor;
  check(!monitor.start_test_host("invalid"), "bounded session identity rejects invalid size");
  check(monitor.start_test_host(session), "test host thread starts");
  check(!monitor.start_test_host(session), "double start rejected");
  check(await(monitor, [](Snapshot s) { return s.status == Status::unavailable && s.per_monitor_v2; }), "no own window is unavailable");
  // The PID keeps concurrent plain and ASan runs from sharing (and pre-signalling) events.
  const std::string event_name = "Local\\ET007-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64());
  const auto peer_stop = CreateEventA(nullptr, TRUE, FALSE, event_name.c_str());
  const bool fresh_stop = peer_stop && GetLastError() != ERROR_ALREADY_EXISTS;
  const auto peer_ready = CreateEventA(nullptr, TRUE, FALSE, (event_name + "-ready").c_str());
  const bool fresh_ready = peer_ready && GetLastError() != ERROR_ALREADY_EXISTS;
  wchar_t executable[32768]{}; GetModuleFileNameW(nullptr, executable, 32768);
  std::wstring command = L"\"" + std::wstring(executable) + L"\" --peer " + std::wstring(event_name.begin(), event_name.end()) +
    L" " + std::to_wstring(GetCurrentProcessId()) + L" " + std::to_wstring(peer_delay_ms);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION peer{};
  const bool launched = fresh_stop && fresh_ready && CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &peer);
  check(launched, "owned unrelated-process fixture starts");
  if (launched) {
    CloseHandle(peer.hThread);
    // Readiness or peer exit ends the wait, so a failed peer is reported as such and
    // never as a slow one; neither outcome depends on how long start-up takes.
    const auto ready_started = GetTickCount64();
    const HANDLE startup_waits[] = {peer_ready, peer.hProcess};
    const auto startup_result = WaitForMultipleObjects(2, startup_waits, FALSE, peer_ready_guard_ms);
    check(startup_result != WAIT_OBJECT_0 + 1, "owned peer alive until readiness");
    check(startup_result == WAIT_OBJECT_0, "unrelated actual window readiness");
    std::cout << "Peer readiness ms=" << GetTickCount64() - ready_started << " injected delay ms=" << peer_delay_ms << '\n';
    if (startup_result == WAIT_OBJECT_0 + 1) {
      DWORD early = STILL_ACTIVE; GetExitCodeProcess(peer.hProcess, &early);
      std::cerr << "Peer exited before readiness with code " << early << '\n';
    }
    // Ignoring a window proves nothing unless it exists: require exactly one window of
    // the peer that has the shape the monitor would select, before and after observing.
    PeerWindows peer_list{peer.dwProcessId};
    if (startup_result == WAIT_OBJECT_0) EnumWindows(peer_windows, reinterpret_cast<LPARAM>(&peer_list));
    check(peer_list.count == 1, "unrelated process shows one eligible-shape window");
    // The worker publishes once per scan. Revision R read here may be followed by R+1
    // from a scan that enumerated windows before the peer showed its window and was
    // then preempted. Revision R+2 comes from a scan that began after R+1 was
    // published, which is after this read and therefore after the window was shown.
    const auto revision = monitor.latest().revision;
    check(await(monitor, [&](Snapshot s) { return s.revision > revision + 1 && s.status == Status::unavailable; }), "unrelated process publication remains unavailable");
    check(monitor.latest().status == Status::unavailable, "unrelated process window ignored");
    check(peer_list.count == 1 && monitor_shaped(peer_list.found, peer.dwProcessId), "unrelated window still present after observation");
  }
  HWND hwnd = create(); check(hwnd != nullptr, "controlled visible no-activate window created");
  check(await(monitor, [&](Snapshot s) { return s.status == Status::available && s.handle == reinterpret_cast<std::uint64_t>(hwnd); }), "actual process window discovered");
  auto initial = monitor.latest();
  check(initial.client.x == -400 && initial.client.y == -300 && initial.client.width == 320 && initial.client.height == 200, "physical negative-origin client rectangle");
  check(same_physical(hwnd, initial) && initial.per_monitor_v2 && initial.monitor != 0, "physical rect DPI foreground monitor independent API comparison");
  check(initial.process_id == GetCurrentProcessId() && initial.process_creation_time != 0 && initial.window_generation > 0, "retained process/window identity");
  check(initial.display_mode == DisplayMode::unknown, "geometry does not prove display mode");
  HWND tool = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, wc.lpszClassName, L"Tool fixture", WS_POPUP,
    -900, -800, 100, 100, nullptr, nullptr, wc.hInstance, nullptr);
  HWND owned = CreateWindowExW(WS_EX_NOACTIVATE, wc.lpszClassName, L"Owned fixture", WS_POPUP,
    -900, -800, 100, 100, hwnd, nullptr, wc.hInstance, nullptr);
  ShowWindow(tool, SW_SHOWNOACTIVATE); ShowWindow(owned, SW_SHOWNOACTIVATE);
  const auto before_exclusions = monitor.latest().revision;
  check(tool && owned && await(monitor, [&](Snapshot s) { return s.revision > before_exclusions && s.status == Status::available && s.handle == initial.handle; }), "tool and owned top-level windows excluded");
  DestroyWindow(tool); DestroyWindow(owned);
  const auto caller_context = GetThreadDpiAwarenessContext();
  SetWindowPos(hwnd, nullptr, -250, -120, 450, 280, SWP_NOZORDER | SWP_NOACTIVATE);
  check(await(monitor, [&](Snapshot s) { return s.client.x == -250 && s.client.y == -120 && s.client.width == 450 && s.client.height == 280 && same_physical(hwnd, s); }), "move and resize update physical rectangle");
  check(AreDpiAwarenessContextsEqual(caller_context, GetThreadDpiAwarenessContext()) != FALSE, "worker does not mutate caller DPI context");
  Displays display_list; EnumDisplayMonitors(nullptr, nullptr, displays, reinterpret_cast<LPARAM>(&display_list));
  std::cout << "Available monitor count=" << display_list.count << '\n';
  for (unsigned index = 0; index < display_list.count; ++index) {
    const auto rect = display_list.bounds[index];
    SetWindowPos(hwnd, nullptr, rect.left + 40, rect.top + 40, 300, 180, SWP_NOZORDER | SWP_NOACTIVATE);
    check(await(monitor, [&](Snapshot s) { return s.status == Status::available && s.client.x == rect.left + 40 && s.client.y == rect.top + 40 && same_physical(hwnd, s); }), "actual monitor move physical bounds and DPI");
    const auto observation = monitor.latest();
    std::cout << "Monitor " << index << " physical=" << rect.left << ',' << rect.top << " DPI=" << observation.dpi << '\n';
  }
  HWND second = create(-600, -500);
  check(await(monitor, [](Snapshot s) { return s.status == Status::ambiguous && s.handle == 0; }), "two eligible own windows fail closed");
  DestroyWindow(second);
  check(await(monitor, [](Snapshot s) { return s.status == Status::available; }), "unique window recovers from ambiguity");
  ShowWindow(hwnd, SW_HIDE);
  check(await(monitor, [](Snapshot s) { return s.status == Status::available && !s.visible; }), "hidden tracked window retained with visibility false");
  second = create(-600, -500);
  const auto hidden_revision = monitor.latest().revision;
  check(await(monitor, [&](Snapshot s) { return s.revision > hidden_revision + 3 && s.status == Status::ambiguous && s.handle == 0; }), "hidden tracked identity and new window remain ambiguous");
  DestroyWindow(second);
  check(await(monitor, [](Snapshot s) { return s.status == Status::available && !s.visible; }), "ambiguity resolution recovers retained hidden identity");
  ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
  { RECT actual{}; GetClientRect(hwnd, &actual); std::cout << "Minimize observation: IsIconic=" << IsIconic(hwnd) << " client=" << actual.right << ',' << actual.bottom << '\n'; }
  check(await(monitor, [](Snapshot s) { return s.status == Status::available && s.minimized && !s.client_bounds_available; }), "actual minimized window retains identity without fabricated bounds");
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  check(await(monitor, [](Snapshot s) { return s.status == Status::available && !s.minimized; }), "actual restore recorded");
  const auto old = monitor.latest(); const auto old_handle = hwnd;
  DestroyWindow(hwnd); hwnd = nullptr;
  check(await(monitor, [](Snapshot s) { return s.status == Status::unavailable && s.handle == 0; }), "destroy clears stale handle");
  hwnd = create();
  check(await(monitor, [&](Snapshot s) { return s.status == Status::available && s.window_generation > old.window_generation; }), "window recreation rotates generation");
  const auto recreated = monitor.latest();
  std::cout << "Controlled observations: DPI=" << recreated.dpi << " foreground=" << recreated.foreground
    << " numeric HWND reused=" << (old_handle == hwnd) << " negative origin=" << recreated.client.x << ',' << recreated.client.y << '\n';
  std::atomic<bool> reading{true};
  std::thread reader([&] { while (reading.load()) { const auto s = monitor.latest(); if (s.status == Status::available && !s.process_creation_time) std::terminate(); } });
  const auto start = GetTickCount64(); monitor.stop();
  check(GetTickCount64() - start < 500, "owned worker cancellation and join under 500 ms");
  reading.store(false); reader.join();
  check(monitor.latest().status == Status::stopped && monitor.latest().handle == 0, "stop retires latest metadata");
  monitor.stop(); check(monitor.start_test_host(session), "restart after joined stop");
  check(await(monitor, [](Snapshot s) { return s.status == Status::available; }), "restart rediscovers own window");
  monitor.stop(); DestroyWindow(hwnd);
  if (launched) {
    SetEvent(peer_stop); DWORD peer_code = STILL_ACTIVE;
    const bool exited = WaitForSingleObject(peer.hProcess, peer_exit_guard_ms) == WAIT_OBJECT_0 && GetExitCodeProcess(peer.hProcess, &peer_code);
    check(exited && peer_code == peer_stopped, "owned peer exits normally");
    if (!exited) TerminateProcess(peer.hProcess, 1);
    CloseHandle(peer.hProcess);
  }
  if (peer_stop) CloseHandle(peer_stop);
  if (peer_ready) CloseHandle(peer_ready);
  UnregisterClassW(wc.lpszClassName, wc.hInstance); SetThreadDpiAwarenessContext(previous);
  std::cout << checks << " controlled Win32 checks, " << failures << " failures\n";
  return failures ? 1 : 0;
}
