#include "transport.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <chrono>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--synthetic-fixture") {
      sp01::Transport transport(sp01::pipe_name("eut2") + L".synthetic." + std::to_wstring(GetCurrentProcessId()), "eut2");
      sp01::Snapshot synthetic; synthetic.paused = false;
      synthetic.speed_available = true; synthetic.speed = 25;
      synthetic.fuel_available = true; synthetic.fuel = 800;
      for (int i = 0; i < 160; ++i) { ++synthetic.frame; transport.publish(synthetic); Sleep(50); }
      return 0;
    }
    sp01::Queue<4> queue; sp01::Snapshot value;
    for (uint64_t i = 1; i <= 3; ++i) { value.frame = i; require(queue.push(value), "queue accepts capacity"); }
    require(!queue.push(value), "queue bounded");
    for (uint64_t i = 1; i <= 3; ++i) { require(queue.pop(value) && value.frame == i, "ordered queue"); }
    require(!queue.pop(value), "empty queue");
    value.speed_available = true; value.speed = std::numeric_limits<float>::quiet_NaN();
    value.fuel_available = true; value.fuel = 0;
    const auto line = sp01::serialize(value, {}, std::string(32, 'a'), "eut2", 1, 2);
    require(line.size() < 2048 && line.back() == '\n', "bounded frame");
    require(line.find("\"speedMps\":null") != std::string::npos, "NaN unavailable");
    require(line.find("\"fuelLitres\":0") != std::string::npos, "zero preserved");
    require(!sp01::foreground_window(0).visible, "unrelated foreground hidden");
    const auto name = L"\\\\.\\pipe\\ETS2Telemetry.SP01.test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
    HANDLE secured = sp01::create_pipe(name);
    require(secured != INVALID_HANDLE_VALUE, "secure server");
    HANDLE collision = sp01::create_pipe(name);
    require(collision == INVALID_HANDLE_VALUE, "first instance rejects collision");
    PSECURITY_DESCRIPTOR descriptor = nullptr; PACL acl = nullptr;
    require(GetSecurityInfo(secured, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS, "inspect DACL");
    require(acl && acl->AceCount == 1, "one user ACE");
    void* ace = nullptr; require(GetAce(acl, 0, &ace) != FALSE, "read ACE");
    auto* allowed = static_cast<ACCESS_ALLOWED_ACE*>(ace); LPWSTR sid = nullptr;
    require(ConvertSidToStringSidW(&allowed->SidStart, &sid) != FALSE, "ACE SID");
    require(std::wstring(sid) == sp01::user_sid(), "only current user");
    LocalFree(sid); LocalFree(descriptor); CloseHandle(secured);
    const auto start = std::chrono::steady_clock::now();
    {
      sp01::Transport transport(name, "eut2");
      HANDLE client = INVALID_HANDLE_VALUE;
      for (int attempt = 0; attempt < 50 && client == INVALID_HANDLE_VALUE; ++attempt) {
        client = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (client == INVALID_HANDLE_VALUE) Sleep(10);
      }
      require(client != INVALID_HANDLE_VALUE, "actual pipe connects");
      transport.publish(value);
      char buffer[2048]{}; DWORD bytes = 0;
      require(ReadFile(client, buffer, sizeof buffer, &bytes, nullptr) && bytes > 0, "actual pipe delivers");
      require(std::string(buffer, bytes).find("sp01-1") != std::string::npos, "wire version");
      CloseHandle(client); Sleep(150);
      client = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
      require(client != INVALID_HANDLE_VALUE, "reconnect");
      // Deliberately do not read. Publish heavily; callback work remains bounded.
      for (int i = 0; i < 100000; ++i) transport.publish(value);
      Sleep(300); transport.stop(); CloseHandle(client);
    }
    require(std::chrono::steady_clock::now() - start < std::chrono::seconds(3), "disconnect/slow-reader/shutdown bounded");
    { sp01::Transport absent(name, "ats"); absent.publish(value); absent.stop(); }
    std::cout << "SP-01 queue, unavailable/zero, DACL, collision, actual pipe, reconnect, slow reader and shutdown passed\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
