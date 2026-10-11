#pragma once
#include <windows.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <string>
#include <thread>

namespace sp01 {
struct Snapshot {
  uint64_t frame = 0, render_us = 0, simulation_us = 0;
  float speed = 0, fuel = 0;
  bool speed_available = false, fuel_available = false, paused = true, timer_restart = false;
};
// One SDK callback thread produces; one transport thread consumes. Full queues drop new frames.
template<size_t N> class Queue {
  static_assert(N > 1);
  std::array<Snapshot, N> values_{};
  std::atomic<size_t> read_{0}, write_{0};
public:
  bool push(const Snapshot& value) noexcept {
    const auto pos = write_.load(std::memory_order_relaxed);
    const auto next = (pos + 1) % N;
    if (next == read_.load(std::memory_order_acquire)) return false;
    values_[pos] = value;
    write_.store(next, std::memory_order_release);
    return true;
  }
  bool pop(Snapshot& value) noexcept {
    const auto pos = read_.load(std::memory_order_relaxed);
    if (pos == write_.load(std::memory_order_acquire)) return false;
    value = values_[pos];
    read_.store((pos + 1) % N, std::memory_order_release);
    return true;
  }
};
struct Window { bool visible = false; LONG x = 0, y = 0, width = 0, height = 0; };
Window foreground_window(DWORD pid) noexcept;
std::string serialize(const Snapshot&, const Window&, const std::string& session,
                      const std::string& game, uint64_t sequence, uint64_t dropped);
std::wstring user_sid();
std::wstring pipe_name(const std::string& game);
HANDLE create_pipe(const std::wstring& name);
class Transport {
  Queue<64> queue_;
  std::atomic<uint64_t> dropped_{0};
  std::atomic<bool> stop_{false};
  HANDLE stop_event_ = nullptr;
  std::thread thread_;
  std::wstring name_;
  std::string game_, session_;
  void run() noexcept;
public:
  Transport(const std::wstring& name, const std::string& game);
  ~Transport();
  Transport(const Transport&) = delete;
  Transport& operator=(const Transport&) = delete;
  void publish(const Snapshot& value) noexcept {
    if (!queue_.push(value)) dropped_.fetch_add(1, std::memory_order_relaxed);
  }
  void stop() noexcept;
};
}
