#include "capture-server.hpp"
#include "capture-wire.hpp"
#include "pipe-discovery.hpp"
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
  // A separate namespace keyed to the verified process instance and this plugin initialization.
  return L"\\\\.\\pipe\\ETS2Telemetry-" + widen(s.identity.game.c_str()) + L"-cap0-" + widen(user.tag.c_str()) + L"-" + std::to_wstring(user.session) + L"-" +
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
std::uint64_t CaptureServer::now_ns() const noexcept { std::uint64_t value = 0; return adapter_.source_monotonic_ns(value) ? value : 0; }
bool CaptureServer::wait_io(HANDLE pipe, OVERLAPPED& operation, DWORD& transferred, ULONGLONG deadline, bool honor_stop) {
  for (;;) {
    if (GetOverlappedResult(pipe, &operation, &transferred, FALSE)) return true;
    if (GetLastError() != ERROR_IO_INCOMPLETE) return false;
    if ((honor_stop && WaitForSingleObject(stop_event_.get(), 0) == WAIT_OBJECT_0) || GetTickCount64() >= deadline) {
      CancelIoEx(pipe, &operation);
      // Completion is observed before the buffer or OVERLAPPED leaves scope, including CancelIoEx races.
      GetOverlappedResult(pipe, &operation, &transferred, TRUE); return false;
    }
    HANDLE handles[]{stop_event_.get(), operation.hEvent};
    WaitForMultipleObjects(honor_stop ? 2 : 1, honor_stop ? handles : handles + 1, FALSE, 10);
  }
}
bool CaptureServer::write(HANDLE pipe, const std::string& payload, ULONGLONG deadline, bool honor_stop) {
  const auto bytes = frame(payload); Operation op; DWORD written = 0;
  auto ok = WriteFile(pipe, bytes.data(), static_cast<DWORD>(bytes.size()), &written, &op.overlapped);
  if (!ok && GetLastError() != ERROR_IO_PENDING) return false;
  if (!ok && !wait_io(pipe, op.overlapped, written, deadline, honor_stop)) return false;
  return written == bytes.size();
}
void CaptureServer::serve(HANDLE pipe, const std::wstring& directory, const transport::OwnerSecurity& security, const transport::UserIdentity& user) {
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
    if (!ok && !wait_io(pipe, read.overlapped, bytes, handshake_deadline, true)) return;
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
  header.open_monotonic_ns = now_ns(); queue_.open(); status_.store(CaptureStatus::capturing); ++sessions_;
  std::uint64_t packet_seq = 0, published = 0, reported_drops = 0; ULONGLONG last_loss = 0, next_source_check = GetTickCount64() + 250;
  auto finish = [&](EndReason reason, bool drain) {
    queue_.close();
    // Shutdown drains already copied envelopes under a separate 250 ms bound, then reports the rest.
    const auto deadline = GetTickCount64() + 250; Envelope envelope;
    try {
      while (drain && GetTickCount64() < deadline && queue_.pop(envelope)) {
        for (const auto& payload : envelope_packets(session, envelope, packet_seq, now_ns())) if (!write(pipe, payload, deadline, false)) return;
        ++published;
      }
    } catch (...) { reason = EndReason::encoding_failed; }
    const auto counters = queue_.counters();
    if (counters.dropped != reported_drops && !write(pipe, loss_packet(session, counters, packet_seq++, now_ns()), deadline, false)) return;
    write(pipe, end_packet(session, {reason, counters, published, queue_.queued_envelopes()}, packet_seq++, now_ns()), deadline, false);
  };
  if (!write(pipe, header_packet(header, packet_seq++, now_ns()), GetTickCount64() + 1000, true)) return;
  Operation inbound; std::array<std::uint8_t, 64> input{}; DWORD bytes = 0;
  if (ReadFile(pipe, input.data(), static_cast<DWORD>(input.size()), &bytes, &inbound.overlapped) || GetLastError() != ERROR_IO_PENDING) return;
  // After an end marker the endpoint keeps serving, and DisconnectNamedPipe would discard unread
  // bytes. Give the client up to one second to read and close before the connection is retired.
  auto linger = [&] {
    HANDLE waits[]{stop_event_.get(), inbound.event.get()}; WaitForMultipleObjects(2, waits, FALSE, 1000);
    CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE);
  };
  try {
    for (;;) {
      if (WaitForSingleObject(stop_event_.get(), 10) != WAIT_TIMEOUT) { CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE); finish(EndReason::plugin_shutdown, true); return; }
      // Any post-hello client byte or EOF closes the capture; the client has no other messages.
      if (WaitForSingleObject(inbound.event.get(), 0) == WAIT_OBJECT_0) break;
      if (WaitForSingleObject(peer.process.get(), 0) != WAIT_TIMEOUT || transport::creation_time(peer.process.get()) != peer.creation) break;
      const auto now = GetTickCount64();
      if (now >= next_source_check) {
        next_source_check = now + 250;
        if (!adapter_.read_current(current) || current.source_retired || current.exhausted) {
          finish(EndReason::source_retired, true); linger(); return;
        }
      }
      Envelope envelope; bool failed = false;
      for (unsigned i = 0; i < 32; ++i) {
        std::vector<std::string> packets;
        try { if (!queue_.pop(envelope)) break; packets = envelope_packets(session, envelope, packet_seq, now_ns()); }
        catch (...) { failed = true; break; }
        for (const auto& payload : packets) if (!write(pipe, payload, GetTickCount64() + 1000, true)) { CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE); return; }
        ++published;
      }
      if (failed) { finish(EndReason::encoding_failed, false); linger(); return; }
      const auto counters = queue_.counters();
      if (counters.dropped != reported_drops && GetTickCount64() >= last_loss + 100) {
        if (!write(pipe, loss_packet(session, counters, packet_seq++, now_ns()), GetTickCount64() + 1000, true)) break;
        reported_drops = counters.dropped; last_loss = GetTickCount64();
      }
    }
  } catch (...) { CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE); throw; }
  CancelIoEx(pipe, &inbound.overlapped); GetOverlappedResult(pipe, &inbound.overlapped, &bytes, TRUE);
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
      if (!connected && error == ERROR_IO_PENDING) { connected = wait_io(pipe.get(), connect.overlapped, transferred, UINT64_MAX, true); error = connected ? ERROR_SUCCESS : GetLastError(); }
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
