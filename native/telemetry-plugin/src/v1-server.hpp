#pragma once
#include "cancel-window.hpp"
#include "pipe-discovery.hpp"
#include "v1-state.hpp"
#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

// Protocol v1 endpoint (ET-004b): the plugin's second named pipe, beside the v0 live endpoint and the CAP0 evidence
// endpoint, with its own worker, discovery directory and service policy. The worker owns the event store and the
// encoder: it drains the SDK-thread event channel into the store at least every 10 ms, serves one authorized client at a
// time and writes `end` at shutdown. It never calls an SCS API. See docs/native-transport-v1.md and docs/protocol/v1.md.
namespace ets2telemetry::v1 {
enum class ServerStatus { stopped, starting, listening, connected, failed, retired };
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
// Console tests only: a signed offset added to every worker reading of the source clock. A positive offset moves the
// retention clock forward; a negative one makes the worker read earlier than SDK-thread occurrence times.
void set_clock_offset_for_test(std::int64_t offset_ns) noexcept;
#endif
class Server final {
 public:
  Server(sdk::Adapter& adapter, Origin origin) noexcept : adapter_(adapter), origin_(origin) {}
  ~Server();
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;
  // SDK initialization context, after Adapter::initialize() and before attach_events(), while no adapter holds the channel
  // and no worker runs. Prepares the event channel and a fresh event store for the new plugin session, so eventSeq starts
  // at 1. Returns the channel to attach, or nullptr when the worker is still running or an allocation failed. It is called
  // once per plugin session: a second initialization of the same session fails in the adapter before it.
  EventChannel* prepare() noexcept;
  // SDK initialization context, after prepare(): starts the worker. Startup is asynchronous and never reported to the
  // game. A local failure (identity, directory, foreign pipe, foreign discovery record) leaves the status `failed` and the
  // endpoint closed; v0 and CAP0 are unaffected. `directory` is the protected discovery and policy directory; empty
  // selects %LOCALAPPDATA%\ETS2Telemetry\transport\v1 (the build channel's data root, channel-identity.hpp, ET-055). The
  // monitor stays alive until stop() returns.
  bool start(std::wstring directory = {}, const window::Monitor* monitor = nullptr) noexcept;
  // SDK shutdown context: asks the worker to end its connection, so `end` is written while the CAP0 endpoint stops.
  void signal_stop() noexcept;
  // SDK shutdown context: cancels synchronous I/O only inside the worker's peer-inspection window until the worker
  // exits, so exit-path file operations are never cancelled, then joins it. The measured
  // shutdown time and the deadline flag are recorded after the mandatory join.
  void stop() noexcept;
  ServerStatus status() const noexcept { return status_.load(); }
  std::wstring endpoint() const;
  std::uint64_t shutdown_ms() const noexcept { return shutdown_ms_.load(); }
  bool shutdown_deadline_exceeded() const noexcept { return deadline_exceeded_.load(); }
  // True while a write has stayed pending in the kernel (the client does not read).
  bool write_pending() const noexcept { return write_pending_.load(); }
  // Connections that received a checkpoint, and connections that ended with `end`.
  std::uint64_t hydrations() const noexcept { return hydrations_.load(); }
  std::uint64_t ends() const noexcept { return ends_.load(); }
  // Diagnostic counter, compiled into every build: `end` writes issued, whether or not they completed.
  std::uint64_t end_attempts() const noexcept { return end_attempts_.load(); }
  // The prepared channel; tests use it to inspect the SDK-thread side.
  EventChannel* channel() noexcept { return channel_.get(); }
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
  // Console tests only, after prepare() and before start(): records [1, next) as offline coverage in the store without
  // the channel. Moving the channel to the same eventSeq reaches the end of the range; moving only the store provokes
  // the invariant violation that retires the endpoint.
  bool skip_store_for_test(std::uint64_t next) noexcept;
#endif

 private:
  struct Connection;
  enum class Outcome { reset, ended };
  void run(std::wstring directory) noexcept;
  Outcome serve(HANDLE pipe, const std::wstring& directory, const transport::OwnerSecurity&, const transport::UserIdentity&);
  bool wait_io(HANDLE pipe, OVERLAPPED&, DWORD& transferred, ULONGLONG deadline);
  // Drains the channel into the store in the documented caller sequence and expires retention. Throws Retire on an
  // invariant violation (`rejected`) or at sequence exhaustion.
  void tick();
  // Drains at most one ring's worth, and at least one slot. After that it stops at `until` or, with `yield_to_stop`, as soon
  // as a stop is requested, so a full ring of large records never delays the shutdown budget.
  void drain(std::uint64_t now_ns, ULONGLONG until, bool yield_to_stop);
  std::uint64_t now_ns() const;
  std::uint64_t next_seq();
  bool stopped() const noexcept;
  // stop() cancels the worker's synchronous I/O only inside an inspection window (peer image and policy reads, which can
  // be long). Elsewhere, above all in the exit path that deletes the discovery record, a cancelled synchronous call
  // would fail silently, so it is never cancelled. The mutex orders each cancellation with the window's open and close.
  transport::CancelWindow cancel_window_;

  sdk::Adapter& adapter_; const Origin origin_;
  std::unique_ptr<EventChannel> channel_; std::unique_ptr<EventStore> store_; std::optional<Encoder> encoder_;
  WelcomeInfo welcome_{};
  std::string plugin_session_id_;
  std::thread worker_; transport::Handle stop_event_;
  std::atomic<ServerStatus> status_{ServerStatus::stopped};
  std::atomic<std::uint64_t> shutdown_ms_{0}, stop_requested_{0}, hydrations_{0}, ends_{0}, end_attempts_{0};
  std::atomic<bool> deadline_exceeded_{false}, write_pending_{false};
  mutable std::mutex endpoint_mutex_; std::wstring endpoint_;
  // Borrowed provider; it stays alive until stop() has joined the worker.
  const window::Monitor* monitor_ = nullptr; std::uint64_t process_creation_ = 0;
  // Worker-owned: the outbound message seq of the plugin session, the endpoint's replaced unsent snapshots, and the time
  // the channel was first seen exhausted.
  std::uint64_t seq_ = 0, coalesced_ = 0; ULONGLONG exhausted_since_ = 0;
};
} // namespace ets2telemetry::v1
