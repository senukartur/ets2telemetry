#pragma once
#include "pipe-discovery.hpp"
#include "protocol-v0.hpp"
#include "game-window-monitor.hpp"
#include <atomic>
#include <thread>
#include <mutex>
#include <optional>

namespace ets2telemetry::transport {
struct SessionExhausted : std::runtime_error { SessionExhausted() : std::runtime_error("sequence-exhausted") {} };
class OutboundSequence final {
 public:
  explicit OutboundSequence(std::uint64_t initial = 0) : value_(initial) {}
  std::uint64_t reserve() { if (value_ == UINT64_MAX) throw SessionExhausted(); return ++value_; }
 private: std::uint64_t value_;
};
enum class Status { stopped, starting, listening, connected, failed, shutdown_deadline_exceeded };
enum class StartupFailure { none, worker_creation, identity_security, source_identity, endpoint_creation, discovery_publication, timeout };
const char* startup_failure_message(StartupFailure) noexcept;
const char* startup_pending_message() noexcept;
class Server final {
 public:
  explicit Server(sdk::Adapter& adapter, std::uint64_t initial_sequence = 0) : adapter_(adapter), initial_sequence_(initial_sequence) {}
  ~Server();
  bool start(std::wstring directory = {}, const window::Monitor* monitor = nullptr) noexcept;
  // Waits at most the fixed 1 s SDK-initialization budget. A result within it is the caller's to report.
  // On timeout the worker keeps starting and its eventual result is handed to the adapter's deferred
  // game log instead, so exactly one side reports each startup.
  StartupFailure await_startup() noexcept;
  void stop() noexcept;
  Status status() const noexcept { return status_.load(); }
  std::wstring endpoint() const;
  std::uint64_t shutdown_ms() const noexcept { return shutdown_ms_.load(); }
  bool write_pending() const noexcept { return write_pending_.load(); }
 private:
  enum class StartupReport { pending, completed, detached };
  void run(std::wstring directory) noexcept;
  void complete_startup(StartupFailure) noexcept;
  void capture();
  std::uint64_t next_sequence();
  v0::Continuity continuity(const sdk::Snapshot&) const;
  bool wait_io(HANDLE pipe, OVERLAPPED&, DWORD& transferred, ULONGLONG deadline, bool capture_updates);
  bool write_frame(HANDLE pipe, const std::vector<std::uint8_t>&, bool capture_updates);
  void serve(HANDLE pipe, const std::wstring& directory, const OwnerSecurity&, const UserIdentity&);
  sdk::Adapter& adapter_; std::thread worker_; Handle stop_event_, startup_event_;
  std::atomic<StartupFailure> startup_failure_{StartupFailure::worker_creation};
  std::atomic<StartupReport> startup_report_{StartupReport::pending};
  std::atomic<Status> status_{Status::stopped}; std::atomic<std::uint64_t> shutdown_ms_{0};
  std::atomic<bool> write_pending_{false};
  mutable std::mutex endpoint_mutex_; std::wstring endpoint_;
  sdk::Snapshot current_{}; struct Pending { sdk::Snapshot snapshot; std::uint64_t seq, diagnostic_seq; };
  // Borrowed provider stays alive until stop() has observed transport completion.
  const window::Monitor* monitor_ = nullptr;
  window::Snapshot window_{};
  std::uint64_t process_creation_ = 0, next_window_poll_ = 0;
  bool window_available_ = false;
  std::optional<Pending> pending_; OutboundSequence sequence_; std::uint64_t coalesced_ = 0, lost_ = 0;
  bool diagnostics_ = false;
  const std::uint64_t initial_sequence_;
};
Server& server() noexcept;
}
