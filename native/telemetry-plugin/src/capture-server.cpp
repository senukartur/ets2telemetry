#include "capture-server.hpp"
#include "capture-wire.hpp"
#include "channel-identity.hpp"
#include "pipe-discovery.hpp"
#include <algorithm>
#include <array>
#include <stdexcept>

namespace ets2telemetry::cap0 {
namespace {
using transport::Handle;
struct Operation {
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)}; OVERLAPPED overlapped{};
  Operation() { if (!event) throw std::runtime_error("capture-io-event"); overlapped.hEvent = event.get(); }
};
std::wstring widen(const char* text) {
  const auto n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, nullptr, 0); if (n <= 1) throw std::runtime_error("capture-name");
  std::wstring output(static_cast<std::size_t>(n), L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, output.data(), n); output.resize(static_cast<std::size_t>(n - 1)); return output;
}
std::string narrow(const std::wstring& text) {
  const auto n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr); if (n <= 0) throw std::runtime_error("capture-path");
  std::string output(static_cast<std::size_t>(n), '\0'); WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), output.data(), n, nullptr, nullptr); return output;
}
// Identifies the module containing this code: the plugin DLL in a game, the console in tests.
void module_identity(HANDLE stop_event, std::string& path, std::string& digest) {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(&module_identity), &module)) throw std::runtime_error("capture-module");
  std::wstring name(32768, L'\0'); const auto length = GetModuleFileNameW(module, name.data(), static_cast<DWORD>(name.size()));
  if (!length || length >= name.size()) throw std::runtime_error("capture-module"); name.resize(length);
  Handle file(CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file) throw std::runtime_error("capture-module-open");
  path = narrow(transport::final_path(file.get(), stop_event)); digest = transport::sha256_handle(file.get(), stop_event);
}
}
std::wstring capture_endpoint_name(const sdk::Snapshot& s, const transport::UserIdentity& user) {
  // A separate namespace keyed to the verified process instance and this plugin initialization, under the build
  // channel's prefix (ET-055).
  return channel::active.pipe_prefix_wide + widen(s.identity.game.c_str()) + L"-cap0-" + widen(user.tag.c_str()) + L"-" + std::to_wstring(user.session) + L"-" +
    widen(s.identity.process_instance_id.c_str()) + L"-" + widen(s.identity.plugin_session_id.c_str());
}
CaptureServer::~CaptureServer() { stop(); }
bool CaptureServer::start(std::wstring directory) noexcept {
  try {
    if (worker_.joinable()) return false;
    stop_event_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!stop_event_) throw std::runtime_error("capture-stop-event");
    shutdown_ms_.store(0); status_.store(CaptureStatus::starting);
    adapter_.attach_evidence(&queue_);
    worker_ = std::thread([this, directory = std::move(directory)] { run(directory); }); return true;
  } catch (...) { adapter_.attach_evidence(nullptr); status_.store(CaptureStatus::failed); stop_event_.reset(); return false; }
}
void CaptureServer::stop() noexcept {
  try {
    if (!worker_.joinable()) return;
    const auto started = GetTickCount64(); SetEvent(stop_event_.get());
    // Policy/image inspection may perform synchronous reads on this owned worker only.
    CancelSynchronousIo(worker_.native_handle());
    while (WaitForSingleObject(worker_.native_handle(), 10) == WAIT_TIMEOUT) CancelSynchronousIo(worker_.native_handle());
    worker_.join(); queue_.close(); adapter_.attach_evidence(nullptr);
    shutdown_ms_.store(GetTickCount64() - started); stop_event_.reset();
    if (status_.load() != CaptureStatus::failed) status_.store(CaptureStatus::stopped);
  } catch (...) { status_.store(CaptureStatus::failed); }
}
std::wstring CaptureServer::endpoint() const { std::lock_guard<std::mutex> lock(endpoint_mutex_); return endpoint_; }
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
namespace { std::atomic<bool> clock_failure_for_test{false}; }
void set_capture_clock_failure_for_test(bool failed) noexcept { clock_failure_for_test.store(failed); }
#endif
std::uint64_t CaptureServer::stamp() const {
  // Packets are never stamped with a fabricated time: without the source clock the capture ends.
  std::uint64_t value = 0;
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
  if (clock_failure_for_test.load()) throw ClockUnavailable();
#endif
  if (!adapter_.source_monotonic_ns(value)) throw ClockUnavailable();
  return value;
}
bool CaptureServer::wait_io(HANDLE pipe, OVERLAPPED& operation, DWORD& transferred, ULONGLONG deadline, StopMode mode) {
  for (;;) {
    if (GetOverlappedResult(pipe, &operation, &transferred, FALSE)) return true;
    if (GetLastError() != ERROR_IO_INCOMPLETE) return false;
    const auto now = GetTickCount64();
    const bool stopping = mode != StopMode::ignore && WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0;
    // grace: in-flight and remaining split-envelope writes may continue until the drain window of the
    // single stop budget closes. The bound is per stop, not per write, so later writes never extend it.
    if (stopping && mode == StopMode::grace) deadline = (std::min)(deadline, stop_budget() - stop_marker_ms);
    if ((stopping && mode == StopMode::cancel) || now >= deadline) {
      CancelIoEx(pipe, &operation);
      // Completion is observed before the buffer or OVERLAPPED leaves scope, including CancelIoEx races.
      GetOverlappedResult(pipe, &operation, &transferred, TRUE); return false;
    }
    // No polling: wait for completion, stop or the deadline (INFINITE while idle and listening).
    const DWORD timeout = deadline == UINT64_MAX ? INFINITE : static_cast<DWORD>((std::min)(deadline - now, static_cast<ULONGLONG>(INFINITE - 1)));
    HANDLE handles[]{operation.hEvent, stop_event_.get()};
    WaitForMultipleObjects(stopping || mode == StopMode::ignore ? 1 : 2, handles, FALSE, timeout);
  }
}
bool CaptureServer::write(HANDLE pipe, const std::string& payload, ULONGLONG deadline, StopMode mode, bool* not_issued) {
  // A write counts as never issued only if its deadline had already passed or WriteFile failed
  // immediately. Byte counts after cancelling a pending write are not trusted: such a cut is dirty.
  if (not_issued) *not_issued = false;
  if (GetTickCount64() >= deadline) { if (not_issued) *not_issued = true; return false; }
  const auto bytes = frame(payload); Operation op; DWORD written = 0;
  auto ok = WriteFile(pipe, bytes.data(), static_cast<DWORD>(bytes.size()), &written, &op.overlapped);
  if (!ok && GetLastError() != ERROR_IO_PENDING) { if (not_issued) *not_issued = true; return false; }
  if (!ok && !wait_io(pipe, op.overlapped, written, deadline, mode)) return false;
  return written == bytes.size();
}
void CaptureServer::serve(HANDLE pipe, const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user) {
  stop_deadline_ = 0;
  const auto handshake_deadline = GetTickCount64() + 5000;
  ULONG pid = 0; if (!GetNamedPipeClientProcessId(pipe, &pid)) return;
  // Same connected-peer authority as v0: token user, session and the protected broker policy.
  auto peer = transport::inspect_peer(pid, stop_event_.get()); if (peer.sid != user.sid || peer.session != user.session) return;
  auto policy = transport::read_service_policy(directory, security, user, stop_event_.get()); bool allowed = false;
  for (const auto& candidate : policy) if (!_wcsicmp(candidate.image.c_str(), peer.image.c_str()) && candidate.sha256 == peer.sha256) allowed = true;
  if (!allowed || GetTickCount64() >= handshake_deadline) return;
  std::array<char, max_hello_bytes + 4> hello{}; std::size_t received = 0; std::uint32_t length = 0;
  while (!length || received < length + 4) {
    Operation read; DWORD bytes = 0;
    auto ok = ReadFile(pipe, hello.data() + received, static_cast<DWORD>(hello.size() - received), &bytes, &read.overlapped);
    if (!ok && GetLastError() != ERROR_IO_PENDING) return;
    if (!ok && !wait_io(pipe, read.overlapped, bytes, handshake_deadline, StopMode::cancel)) return;
    if (!bytes) return;
    received += bytes;
    if (received >= 4) {
      length = static_cast<std::uint32_t>(static_cast<unsigned char>(hello[0])) | (static_cast<std::uint32_t>(static_cast<unsigned char>(hello[1])) << 8) |
        (static_cast<std::uint32_t>(static_cast<unsigned char>(hello[2])) << 16) | (static_cast<std::uint32_t>(static_cast<unsigned char>(hello[3])) << 24);
      // The bound is enforced from the prefix; a client byte beyond the hello is a protocol violation.
      if (!length || length > max_hello_bytes || received > static_cast<std::size_t>(length) + 4) return;
    }
  }
  const auto session = validate_hello(std::string(hello.data() + 4, length));
  if (!image_known_) { try { module_identity(stop_event_.get(), image_path_, image_sha256_); image_known_ = true; } catch (...) { transport::inspection_running(stop_event_.get()); } }
  sdk::Snapshot current;
  if (!adapter_.read_current(current) || current.source_retired || current.exhausted || !queue_.prepare()) return;
  HeaderInfo header;
  header.capture_session_id = session; header.origin = origin_; header.game = current.identity.game.c_str(); header.sdk_game_id = current.identity.game_id.c_str();
  header.process_instance_id = current.identity.process_instance_id.c_str(); header.plugin_session_id = current.identity.plugin_session_id.c_str();
  header.source_clock_id = current.identity.capture_clock_id.c_str(); header.game_clock_id = current.state.game_clock_id.c_str();
  header.process_id = current.identity.process_id; header.windows_session_id = current.identity.windows_session_id;
  header.api_version = current.identity.api_version; header.game_telemetry_version = current.identity.game_telemetry_version;
  header.currency_available = current.identity.currency.status == sdk::Availability::available && current.identity.currency_source.status == sdk::Availability::available;
  header.currency_code = current.identity.currency.c_str(); header.currency_source = current.identity.currency_source.c_str();
  header.image_available = image_known_; header.image_path = image_path_; header.image_sha256 = image_sha256_;
  header.boundary_at_open = current.boundary_order;
  // Only now, after authority and explicit opt-in, may callbacks copy evidence.
  // Both header stamps are taken before the gate opens, so a missing clock never opens it.
  header.open_monotonic_ns = stamp(); const auto header_payload = header_packet(header, 0, stamp());
  queue_.open(); status_.store(CaptureStatus::capturing); ++sessions_;
  // abandoned: popped envelopes whose first packet was never handed to the pipe; reported as unsent.
  std::uint64_t packet_seq = 0, published = 0, reported_drops = 0, abandoned = 0; ULONGLONG last_loss = 0, next_source_check = GetTickCount64() + 250;
  auto finish = [&](EndReason reason, bool drain) {
    queue_.close();
    // On shutdown both deadlines come from the single stop budget (see stop_budget()); envelopes still
    // queued are counted as unsent.
    const auto started = GetTickCount64();
    const auto deadline = reason == EndReason::plugin_shutdown ? stop_budget() : started + 300, drain_deadline = deadline - stop_marker_ms; Envelope envelope;
    // Drain writes stop at drain_deadline so the last stop_marker_ms stay reserved for the markers. Only an
    // envelope whose first packet was never issued (deadline passed or WriteFile failed immediately)
    // keeps the stream valid for markers; any cancelled pending write ends the stream without them.
    try {
      // An envelope is started only if the previous one's serialization and write time still fits in the
      // drain window, so cutting a split envelope (which forbids markers) stays rare.
      ULONGLONG last_cost = 0;
      while (drain && GetTickCount64() + last_cost < drain_deadline && queue_.pop(envelope)) {
        const auto envelope_started = GetTickCount64();
        const auto first_seq = packet_seq; const auto packets = envelope_packets(session, envelope, packet_seq, stamp());
        bool cut = false;
        for (std::size_t i = 0; i < packets.size(); ++i) {
          bool not_issued = false;
          if (write(pipe, packets[i], drain_deadline, StopMode::ignore, &not_issued)) continue;
          if (i != 0 || !not_issued) return;
          packet_seq = first_seq; ++abandoned; cut = true; break;
        }
        if (cut) break;
        ++published; last_cost = GetTickCount64() - envelope_started;
      }
    } catch (const ClockUnavailable&) { throw; }
    catch (...) { reason = EndReason::encoding_failed; }
    const auto counters = queue_.counters();
    if (counters.dropped != reported_drops && !write(pipe, loss_packet(session, counters, packet_seq++, stamp()), deadline, StopMode::ignore)) return;
    write(pipe, end_packet(session, {reason, counters, published, queue_.queued_envelopes() + abandoned}, packet_seq++, stamp()), deadline, StopMode::ignore);
  };
  ++packet_seq;
  if (!write(pipe, header_payload, GetTickCount64() + 1000, StopMode::cancel)) return;
  Operation inbound; std::array<std::uint8_t, 64> input{}; DWORD bytes = 0;
  if (ReadFile(pipe, input.data(), static_cast<DWORD>(input.size()), &bytes, &inbound.overlapped) || GetLastError() != ERROR_IO_PENDING) return;
  // After an end marker the endpoint keeps serving, and DisconnectNamedPipe would discard unread
  // bytes. Give the client up to one second to read and close before the connection is retired.
  auto linger = [&] {
    HANDLE waits[]{stop_event_.get(), inbound.event.get()}; WaitForMultipleObjects(2, waits, FALSE, 1000);
    CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE);
  };
  auto retire_inbound = [&] { CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE); };
  // A write that a stop interrupted mid-grace may have left a partial frame; nothing more is sent.
  auto stopped = [&] { return WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0; };
  try {
    for (;;) {
      if (stopped() || WaitForSingleObject(stop_event_.get(), 10) != WAIT_TIMEOUT) { retire_inbound(); finish(EndReason::plugin_shutdown, true); return; }
      // Any post-hello client byte or EOF closes the capture; the client has no other messages.
      if (WaitForSingleObject(inbound.event.get(), 0) == WAIT_OBJECT_0) break;
      if (WaitForSingleObject(peer.process.get(), 0) != WAIT_TIMEOUT || transport::creation_time(peer.process.get()) != peer.creation) break;
      const auto now = GetTickCount64();
      if (now >= next_source_check) {
        next_source_check = now + 250;
        // Lock-free liveness only: the full current snapshot was read once for the header, so the
        // worker never contends with the SDK thread's publication lock while capturing.
        if (!adapter_.source_live()) { finish(EndReason::source_retired, true); linger(); return; }
      }
      Envelope envelope; bool failed = false, write_failed = false;
      for (unsigned i = 0; i < 32 && !write_failed && !stopped(); ++i) {
        std::vector<std::string> packets;
        try { if (!queue_.pop(envelope)) break; packets = envelope_packets(session, envelope, packet_seq, stamp()); }
        catch (const ClockUnavailable&) { throw; }
        catch (...) { failed = true; break; }
        const auto first_seq = packet_seq - packets.size(); bool cut_cleanly = false;
        for (std::size_t p = 0; p < packets.size(); ++p) {
          // After a stop, nothing new is issued past the drain window of the stop budget.
          const auto limit = stopped() ? (std::min)(GetTickCount64() + 1000, stop_budget() - stop_marker_ms) : GetTickCount64() + 1000;
          bool not_issued = false;
          if (write(pipe, packets[p], limit, StopMode::grace, &not_issued)) continue;
          write_failed = true;
          // Only an envelope whose first packet was never handed to the pipe keeps the stream valid for markers.
          if (stopped() && p == 0 && not_issued) { packet_seq = first_seq; ++abandoned; cut_cleanly = true; }
          break;
        }
        if (cut_cleanly) { retire_inbound(); finish(EndReason::plugin_shutdown, true); return; }
        if (!write_failed) ++published;
      }
      if (write_failed) { retire_inbound(); return; }
      if (failed) { finish(EndReason::encoding_failed, false); linger(); return; }
      // After a stop, finish() writes loss and end markers within the stop budget instead.
      if (stopped()) { retire_inbound(); finish(EndReason::plugin_shutdown, true); return; }
      const auto counters = queue_.counters();
      if (counters.dropped != reported_drops && GetTickCount64() >= last_loss + 100) {
        if (!write(pipe, loss_packet(session, counters, packet_seq++, stamp()), GetTickCount64() + 1000, StopMode::grace)) break;
        reported_drops = counters.dropped; last_loss = GetTickCount64();
      }
    }
  } catch (...) { retire_inbound(); throw; }
  retire_inbound();
}
void CaptureServer::run(std::wstring directory) noexcept {
  try {
    auto user = transport::current_user(); transport::OwnerSecurity security(user.sid);
    if (directory.empty()) directory = transport::local_transport_directory(security); else security.ensure_directory(directory);
    sdk::Snapshot current;
    if (!adapter_.read_current(current) || current.source_retired || current.identity.windows_session_id != user.session) throw std::runtime_error("capture-source");
    const auto name = capture_endpoint_name(current, user);
    Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, 65540, 0, security.attributes()));
    // A pre-existing endpoint is never adopted.
    if (!pipe) throw std::runtime_error("capture-endpoint-collision");
    { std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_ = name; }
    while (WaitForSingleObject(stop_event_.get(), 0) == WAIT_TIMEOUT) {
      status_.store(CaptureStatus::listening); Operation connect; DWORD transferred = 0;
      auto connected = ConnectNamedPipe(pipe.get(), &connect.overlapped);
      auto error = connected ? ERROR_SUCCESS : GetLastError();
      if (!connected && error == ERROR_IO_PENDING) { connected = wait_io(pipe.get(), connect.overlapped, transferred, UINT64_MAX, StopMode::cancel); error = connected ? ERROR_SUCCESS : GetLastError(); }
      else if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
      if (!connected) {
        if (WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0) break;
        if (error != ERROR_NO_DATA && error != ERROR_BROKEN_PIPE) throw std::runtime_error("capture-accept");
        if (!DisconnectNamedPipe(pipe.get()) && GetLastError() != ERROR_PIPE_NOT_CONNECTED) throw std::runtime_error("capture-reset");
        continue;
      }
      if (WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0) break;
      try { serve(pipe.get(), directory, security, user); } catch (...) { /* A rejected or failed capture client retires only its connection. */ }
      queue_.close();
      // DisconnectNamedPipe discards unread bytes. On shutdown the handle is closed instead, so the
      // client can still read the drained envelopes and end marker already written.
      if (WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0) break;
      CancelIoEx(pipe.get(), nullptr); DisconnectNamedPipe(pipe.get());
    }
  } catch (...) { status_.store(CaptureStatus::failed); }
  queue_.close();
  std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_.clear();
}
}
