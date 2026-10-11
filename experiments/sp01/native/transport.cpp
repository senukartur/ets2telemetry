#include "transport.hpp"
#include <sddl.h>
#include <objbase.h>
#include <cmath>
#include <iomanip>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace sp01 {
std::wstring user_sid() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw std::runtime_error("token");
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  std::vector<unsigned char> buffer(bytes);
  const bool ok = GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes) != FALSE;
  CloseHandle(token);
  if (!ok) throw std::runtime_error("token user");
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid))
    throw std::runtime_error("SID");
  std::wstring result(sid); LocalFree(sid); return result;
}
std::wstring pipe_name(const std::string& game) {
  if (game != "eut2" && game != "ats") throw std::invalid_argument("game");
  return L"\\\\.\\pipe\\ETS2Telemetry.SP01." + user_sid() + L"." + std::wstring(game.begin(), game.end());
}
HANDLE create_pipe(const std::wstring& name) {
  // Grant this user read/write and instance creation; no Everyone/anonymous/admin defaults.
  const auto sddl = L"D:P(A;;GA;;;" + user_sid() + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
    return INVALID_HANDLE_VALUE;
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  const auto handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
    FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1, 4096, 4096, 0, &security);
  LocalFree(descriptor); return handle;
}
Window foreground_window(DWORD pid) noexcept {
  Window result;
  const auto hwnd = GetForegroundWindow(); DWORD owner = 0;
  GetWindowThreadProcessId(hwnd, &owner);
  if (!hwnd || owner != pid || IsIconic(hwnd) || !IsWindowVisible(hwnd)) return result;
  RECT rect{}; POINT origin{};
  if (!GetClientRect(hwnd, &rect) || !ClientToScreen(hwnd, &origin)) return result;
  result.width = rect.right; result.height = rect.bottom;
  result.x = origin.x; result.y = origin.y;
  result.visible = result.width > 0 && result.height > 0;
  return result;
}
std::string serialize(const Snapshot& s, const Window& w, const std::string& session,
                      const std::string& game, uint64_t seq, uint64_t dropped) {
  std::ostringstream out; out.imbue(std::locale::classic()); out << std::setprecision(9);
  out << "{\"v\":\"sp01-1\",\"session\":\"" << session << "\",\"game\":\"" << game
      << "\",\"seq\":\"" << seq << "\",\"frame\":\"" << s.frame
      << "\",\"renderUs\":\"" << s.render_us << "\",\"simulationUs\":\"" << s.simulation_us
      << "\",\"dropped\":\"" << dropped << "\",\"speedMps\":";
  if (s.speed_available && std::isfinite(s.speed)) out << s.speed; else out << "null";
  out << ",\"fuelLitres\":";
  if (s.fuel_available && std::isfinite(s.fuel) && s.fuel >= 0) out << s.fuel; else out << "null";
  out << ",\"paused\":" << (s.paused ? "true" : "false")
      << ",\"timerRestart\":" << (s.timer_restart ? "true" : "false")
      << ",\"window\":{\"visible\":" << (w.visible ? "true" : "false") << ",\"x\":" << w.x
      << ",\"y\":" << w.y << ",\"width\":" << w.width << ",\"height\":" << w.height << "}}\n";
  return out.str();
}
Transport::Transport(const std::wstring& name, const std::string& game): name_(name), game_(game) {
  GUID guid{}; if (FAILED(CoCreateGuid(&guid))) throw std::runtime_error("session GUID");
  std::ostringstream hex; hex << std::hex << std::setfill('0');
  const auto* bytes = reinterpret_cast<const unsigned char*>(&guid);
  for (size_t i = 0; i < sizeof guid; ++i) hex << std::setw(2) << static_cast<unsigned>(bytes[i]);
  session_ = hex.str(); stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_event_) throw std::runtime_error("stop event");
  try { thread_ = std::thread(&Transport::run, this); }
  catch (...) { CloseHandle(stop_event_); throw; }
}
Transport::~Transport() { stop(); CloseHandle(stop_event_); }
void Transport::stop() noexcept {
  stop_.store(true, std::memory_order_release); SetEvent(stop_event_);
  if (thread_.joinable()) thread_.join();
}
void Transport::run() noexcept {
  // All pipe I/O and serialization are confined here. No SCS API calls occur here.
  HANDLE pipe = INVALID_HANDLE_VALUE, event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!event) return;
  const auto wait_io = [&](OVERLAPPED& op, DWORD milliseconds) {
    HANDLE waits[]{stop_event_, event};
    const auto wait = WaitForMultipleObjects(2, waits, FALSE, milliseconds);
    DWORD bytes = 0;
    if (wait == WAIT_OBJECT_0 + 1 && GetOverlappedResult(pipe, &op, &bytes, FALSE)) return true;
    CancelIoEx(pipe, &op);
    // Complete cancellation before destroying OVERLAPPED or its buffer.
    GetOverlappedResult(pipe, &op, &bytes, TRUE); return false;
  };
  try {
    Snapshot latest{}; uint64_t sequence = 0;
    while (!stop_.load(std::memory_order_acquire)) {
      pipe = create_pipe(name_);
      if (pipe == INVALID_HANDLE_VALUE) { WaitForSingleObject(stop_event_, 100); continue; }
      OVERLAPPED connect{}; connect.hEvent = event; ResetEvent(event);
      bool connected = ConnectNamedPipe(pipe, &connect) != FALSE;
      if (!connected) {
        const auto error = GetLastError();
        connected = error == ERROR_PIPE_CONNECTED || (error == ERROR_IO_PENDING && wait_io(connect, 100));
      }
      while (connected && !stop_.load(std::memory_order_acquire)) {
        Snapshot next{};
        while (queue_.pop(next)) { latest = next; }
        // Heartbeats refresh foreground visibility even when the simulation is paused.
        const auto line = serialize(latest, foreground_window(GetCurrentProcessId()), session_, game_, ++sequence,
                                    dropped_.load(std::memory_order_relaxed));
        if (line.size() > 2048) break;
        OVERLAPPED write{}; write.hEvent = event; ResetEvent(event); DWORD bytes = 0;
        connected = WriteFile(pipe, line.data(), static_cast<DWORD>(line.size()), &bytes, &write) != FALSE;
        if (!connected && GetLastError() == ERROR_IO_PENDING) connected = wait_io(write, 100);
        WaitForSingleObject(stop_event_, 50);
      }
      DisconnectNamedPipe(pipe); CloseHandle(pipe); pipe = INVALID_HANDLE_VALUE;
      // No offline spool: drain old snapshots while waiting for the next client.
      Snapshot discarded{}; while (queue_.pop(discarded)) latest = discarded;
    }
  } catch (...) { /* Fail closed; game callbacks continue without waiting for this worker. */ }
  if (pipe != INVALID_HANDLE_VALUE) { CancelIoEx(pipe, nullptr); CloseHandle(pipe); }
  CloseHandle(event);
}
}
