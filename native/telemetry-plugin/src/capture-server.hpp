#pragma once
#include "pipe-security.hpp"
#include "sdk-adapter.hpp"
#include "evidence-queue.hpp"
#include <atomic>
#include <mutex>
#include <stdexcept>
#include <thread>

// Opt-in CAP0 evidence endpoint. It is a separate pipe, worker, queue and wire contract from
// the v0 live server: its I/O can stall or fail without delaying SDK callbacks or v0 frames.
namespace ets2telemetry::cap0 {
enum class CaptureStatus { stopped, starting, listening, capturing, failed };
std::wstring capture_endpoint_name(const sdk::Snapshot&, const transport::UserIdentity&);
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Console-test seam: simulates an unreadable source monotonic clock.
void set_capture_clock_failure_for_test(bool) noexcept;
#endif
class CaptureServer final {
 public:
  CaptureServer(sdk::Adapter& adapter, const char* origin) : adapter_(adapter), origin_(origin) {}
  ~CaptureServer();
  CaptureServer(const CaptureServer&) = delete;
  // SDK initialization context only: attaches the queue to the adapter and starts the worker.
  // The capture gate stays closed until an authorized client sends a valid CAP0 hello.
  bool start(std::wstring directory = {}) noexcept;
  // SDK shutdown context only. Joins the worker, then detaches the queue.
  void stop() noexcept;
  CaptureStatus status() const noexcept { return status_.load(); }
  std::wstring endpoint() const;
  std::uint64_t shutdown_ms() const noexcept { return shutdown_ms_.load(); }
  std::uint64_t sessions() const noexcept { return sessions_.load(); }
  const EvidenceQueue& queue() const noexcept { return queue_; }
 private:
  void run(std::wstring directory) noexcept;
  void serve(HANDLE pipe, const std::wstring& directory, const transport::OwnerSecurity&, const transport::UserIdentity&);
  // cancel: stop cancels pending I/O. grace: stop allows an in-flight frame 250 ms to finish so a
  // frame is not truncated by choice. ignore: only the deadline applies (bounded shutdown drain).
  enum class StopMode { cancel, grace, ignore };
  struct ClockUnavailable : std::runtime_error { ClockUnavailable() : std::runtime_error("capture-clock-unavailable") {} };
  bool wait_io(HANDLE pipe, OVERLAPPED&, DWORD& transferred, ULONGLONG deadline, StopMode);
  // `not_issued` (optional) is true only when nothing was handed to the pipe: the deadline had passed or
  // WriteFile failed immediately. A pending write that was cancelled is never treated as clean.
  bool write(HANDLE pipe, const std::string& payload, ULONGLONG deadline, StopMode, bool* not_issued = nullptr);
  std::uint64_t stamp() const;
  // One shutdown budget per stop, measured from when the worker first observes it: writes in flight
  // and the drain share the window up to (total - marker); loss and end markers must finish by total.
  static constexpr ULONGLONG stop_total_ms = 550, stop_marker_ms = 100;
  ULONGLONG stop_deadline_ = 0;
  ULONGLONG stop_budget() noexcept { if (!stop_deadline_) stop_deadline_ = GetTickCount64() + stop_total_ms; return stop_deadline_; }
  sdk::Adapter& adapter_; const char* origin_;
  EvidenceQueue queue_;
  std::thread worker_; transport::Handle stop_event_;
  std::atomic<CaptureStatus> status_{CaptureStatus::stopped};
  std::atomic<std::uint64_t> shutdown_ms_{0}, sessions_{0};
  mutable std::mutex endpoint_mutex_; std::wstring endpoint_;
  bool image_known_ = false; std::string image_path_, image_sha256_;
};
}
