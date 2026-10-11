#include "pipe-server.hpp"
#include "snapshot-wire.hpp"
#include <array>
#include <stdexcept>

namespace ets2telemetry::transport {
namespace {
constexpr std::uint32_t max_hello_bytes = 4096;
struct Operation { Handle event{CreateEventW(nullptr,TRUE,FALSE,nullptr)}; OVERLAPPED overlapped{};
  Operation() { if (!event) throw std::runtime_error("io-event"); overlapped.hEvent = event.get(); }
};
}
Server& server() noexcept { static Server value(sdk::adapter()); return value; }
const char* startup_failure_message(StartupFailure failure) noexcept {
  switch (failure) {
    case StartupFailure::identity_security: return "ETS2Telemetry: transport startup failed: identity-security";
    case StartupFailure::source_identity: return "ETS2Telemetry: transport startup failed: source-identity";
    case StartupFailure::endpoint_creation: return "ETS2Telemetry: transport startup failed: endpoint-creation";
    case StartupFailure::discovery_publication: return "ETS2Telemetry: transport startup failed: discovery-publication";
    case StartupFailure::timeout: return "ETS2Telemetry: transport startup failed: timeout";
    default: return "ETS2Telemetry: transport startup failed: worker-creation";
  }
}
Server::~Server() { stop(); }
bool Server::start(std::wstring directory) noexcept {
  try {
    if (worker_.joinable()) return false;
    startup_failure_.store(StartupFailure::worker_creation);
    stop_event_.reset(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    startup_event_.reset(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    if (!stop_event_ || !startup_event_) throw std::runtime_error("startup-event");
    sequence_ = OutboundSequence(initial_sequence_); coalesced_ = lost_ = 0; diagnostics_ = false; pending_.reset(); current_ = {}; shutdown_ms_.store(0); status_.store(Status::starting);
    worker_ = std::thread([this, directory = std::move(directory)] { run(directory); }); return true;
  } catch (...) { status_.store(Status::failed); stop_event_.reset(); startup_event_.reset(); return false; }
}
StartupFailure Server::await_startup() noexcept {
  // Only explicit SDK initialization waits here; no callback or client handshake does.
  if (!startup_event_) return StartupFailure::worker_creation;
  if (WaitForSingleObject(startup_event_.get(),1000) == WAIT_OBJECT_0) return startup_failure_.load();
  return StartupFailure::timeout;
}
void Server::stop() noexcept {
  try {
    if (!worker_.joinable()) return; auto started = GetTickCount64(); SetEvent(stop_event_.get());
    // File policy/image inspection may have synchronous reads. Only this owned worker is cancelled.
    CancelSynchronousIo(worker_.native_handle()); worker_.join();
    shutdown_ms_.store(GetTickCount64() - started); stop_event_.reset(); startup_event_.reset();
    if (shutdown_ms_.load() > 1000) status_.store(Status::shutdown_deadline_exceeded);
    else if (status_.load() != Status::failed) status_.store(Status::stopped);
  } catch (...) { status_.store(Status::failed); }
}
std::wstring Server::endpoint() const { std::lock_guard<std::mutex> lock(endpoint_mutex_); return endpoint_; }
std::uint64_t Server::next_sequence() { return sequence_.reserve(); }
v0::Continuity Server::continuity(const sdk::Snapshot& s) const {
  return {s.continuity.coalesced_snapshots > UINT64_MAX - coalesced_ ? UINT64_MAX : s.continuity.coalesced_snapshots + coalesced_,s.continuity.lost_observations > UINT64_MAX - lost_ ? UINT64_MAX : s.continuity.lost_observations + lost_,s.continuity.offline_transitions};
}
void Server::capture() {
  sdk::Snapshot next;
  if (!adapter_.read_latest(next)) return;
  if (next.source_retired || next.exhausted || !next.active) throw std::runtime_error("source-retired");
  // Eligibility receives an exact sequence before replacing the unsent slot.
  auto seq = next_sequence(); const auto diagnostic_seq = diagnostics_ && next.observation_count ? next_sequence() : 0;
  if (pending_) { if (coalesced_ != UINT64_MAX) ++coalesced_; lost_ = lost_ > UINT64_MAX - pending_->snapshot.observation_count ? UINT64_MAX : lost_ + pending_->snapshot.observation_count; }
  current_ = next; current_.observations = {}; current_.observation_count = 0;
  pending_ = Pending{std::move(next),seq,diagnostic_seq};
}
bool Server::wait_io(HANDLE pipe, OVERLAPPED& operation, DWORD& transferred, ULONGLONG deadline, bool capture_updates) {
  for (;;) {
    if (GetOverlappedResult(pipe,&operation,&transferred,FALSE)) return true;
    if (GetLastError() != ERROR_IO_INCOMPLETE) return false;
    if (WaitForSingleObject(stop_event_.get(),0) == WAIT_OBJECT_0 || GetTickCount64() >= deadline) {
      CancelIoEx(pipe,&operation);
      // ERROR_NOT_FOUND can race completion. Always observe completion before freeing buffers/events.
      GetOverlappedResult(pipe,&operation,&transferred,TRUE); return false;
    }
    if (capture_updates) {
      try { capture(); } catch (...) { CancelIoEx(pipe,&operation); GetOverlappedResult(pipe,&operation,&transferred,TRUE); throw; }
    }
    HANDLE handles[]{stop_event_.get(),operation.hEvent}; WaitForMultipleObjects(2,handles,FALSE,10);
  }
}
bool Server::write_frame(HANDLE pipe, const std::vector<std::uint8_t>& frame, bool capture_updates) {
  Operation op; DWORD bytes = 0; auto ok = WriteFile(pipe,frame.data(),static_cast<DWORD>(frame.size()),&bytes,&op.overlapped);
  if (!ok && GetLastError() != ERROR_IO_PENDING) return false;
  if (!ok) {
    write_pending_.store(true);
    try { const auto completed = wait_io(pipe,op.overlapped,bytes,GetTickCount64()+1000,capture_updates); write_pending_.store(false); if (!completed) return false; }
    catch (...) { write_pending_.store(false); throw; }
  }
  return bytes == frame.size();
}
void Server::serve(HANDLE pipe, const std::wstring& directory, const OwnerSecurity& security, const UserIdentity& user) {
  const auto handshake_deadline = GetTickCount64()+5000;
  ULONG pid = 0; if (!GetNamedPipeClientProcessId(pipe,&pid)) return;
  auto peer = inspect_peer(pid); if (peer.sid != user.sid || peer.session != user.session) return;
  auto policy = read_service_policy(directory,security,user); bool allowed = false;
  for (const auto& candidate : policy) if (!_wcsicmp(candidate.image.c_str(),peer.image.c_str()) && candidate.sha256 == peer.sha256) allowed = true;
  if (!allowed || GetTickCount64() >= handshake_deadline) return;
  v0::FrameDecoder decoder; bool hello_received = false; v0::Message hello;
  std::array<std::uint8_t,4> prefix{}; std::size_t received = 0; std::uint32_t hello_length = 0;
  while (!hello_received) {
    Operation read; std::array<std::uint8_t,4096> buffer{}; DWORD bytes = 0;
    auto ok = ReadFile(pipe,buffer.data(),static_cast<DWORD>(buffer.size()),&bytes,&read.overlapped);
    if (!ok && GetLastError() != ERROR_IO_PENDING) return;
    if (!ok && !wait_io(pipe,read.overlapped,bytes,handshake_deadline,false)) return;
    if (!bytes) return;
    for (DWORD i = 0; i < bytes && received + i < 4; ++i) prefix[received+i] = buffer[i];
    received += bytes;
    if (received >= 4) {
      hello_length = static_cast<std::uint32_t>(prefix[0]) | (static_cast<std::uint32_t>(prefix[1]) << 8) | (static_cast<std::uint32_t>(prefix[2]) << 16) | (static_cast<std::uint32_t>(prefix[3]) << 24);
      // Hello has a tighter transport budget than general server frames. Reject at
      // prefix receipt before the decoder can retain an oversized hello payload.
      if (!hello_length || hello_length > max_hello_bytes || received > static_cast<std::size_t>(hello_length)+4) return;
    }
    decoder.push(buffer.data(),bytes,[&](v0::Message m) { if (hello_received || m.kind != "hello") throw v0::ProtocolError("client-direction"); hello = std::move(m); hello_received = true; });
  }
  v0::negotiate(hello);
  diagnostics_ = hello.diagnostics;
  adapter_.set_consumer(true,diagnostics_);
  if (!adapter_.read_current(current_) || current_.source_retired || current_.exhausted) return;
  pending_.reset();
  if (!write_frame(pipe,v0::encode_frame(current_message(current_,"welcome",next_sequence(),continuity(current_),diagnostics_)),false)) return;
  if (!adapter_.read_current(current_) || current_.source_retired || current_.exhausted) return;
  if (!write_frame(pipe,v0::encode_frame(current_message(current_,"checkpoint",next_sequence(),continuity(current_))),false)) return;
  // Discard any adapter publication covered by hydration before live eligibility is established.
  sdk::Snapshot hydrated;
  if (adapter_.read_latest(hydrated) && hydrated.boundary_order > current_.boundary_order) {
    if (hydrated.source_retired || hydrated.exhausted) return;
    const auto seq = next_sequence(); const auto diagnostic_seq = diagnostics_ && hydrated.observation_count ? next_sequence() : 0;
    pending_ = Pending{hydrated,seq,diagnostic_seq}; current_ = hydrated; current_.observations = {}; current_.observation_count = 0;
  } else if (hydrated.observation_count) {
    lost_ = lost_ > UINT64_MAX - hydrated.observation_count ? UINT64_MAX : lost_ + hydrated.observation_count;
  }
  status_.store(Status::connected);
  Operation inbound; std::array<std::uint8_t,4096> input{}; DWORD bytes = 0;
  bool reading = !ReadFile(pipe,input.data(),static_cast<DWORD>(input.size()),&bytes,&inbound.overlapped);
  if (!reading || GetLastError() != ERROR_IO_PENDING) return; // Any post-hello client byte is forbidden.
  ULONGLONG next_display = 0;
  try {
    while (WaitForSingleObject(stop_event_.get(),10) == WAIT_TIMEOUT) {
      if (WaitForSingleObject(peer.process.get(),0) != WAIT_TIMEOUT || creation_time(peer.process.get()) != peer.creation) break;
      if (WaitForSingleObject(inbound.event.get(),0) == WAIT_OBJECT_0) break;
      capture();
      if (pending_ && GetTickCount64() >= next_display) {
        auto next = std::move(*pending_); pending_.reset();
        if (!write_frame(pipe,v0::encode_frame(current_message(next.snapshot,"snapshot",next.seq,continuity(next.snapshot))),true)) { lost_ = lost_ > UINT64_MAX - next.snapshot.observation_count ? UINT64_MAX : lost_ + next.snapshot.observation_count; break; }
        if (next.diagnostic_seq) {
          auto c = continuity(next.snapshot); std::uint64_t omitted = 0;
          auto message = diagnostic_message(next.snapshot,next.diagnostic_seq,c,omitted);
          lost_ = lost_ > UINT64_MAX - omitted ? UINT64_MAX : lost_ + omitted;
          if (!write_frame(pipe,v0::encode_frame(message),true)) { const auto remaining = next.snapshot.observation_count - omitted; lost_ = lost_ > UINT64_MAX - remaining ? UINT64_MAX : lost_ + remaining; break; }
        }
        next_display = GetTickCount64()+50;
      }
    }
  } catch (...) { CancelIoEx(pipe,&inbound.overlapped); GetOverlappedResult(pipe,&inbound.overlapped,&bytes,TRUE); throw; }
  CancelIoEx(pipe,&inbound.overlapped); GetOverlappedResult(pipe,&inbound.overlapped,&bytes,TRUE);
}
void Server::run(std::wstring directory) noexcept {
  auto startup_stage = StartupFailure::identity_security;
  bool startup_complete = false;
  try {
    auto user = current_user(); OwnerSecurity security(user.sid);
    if (directory.empty()) directory = local_transport_directory(security); else security.ensure_directory(directory);
    startup_stage = StartupFailure::source_identity;
    if (!adapter_.read_current(current_) || current_.source_retired || current_.identity.windows_session_id != user.session) throw std::runtime_error("source-identity");
    const auto name = endpoint_name(current_,user);
    startup_stage = StartupFailure::endpoint_creation;
    Handle pipe(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,1,65540,65540,0,security.attributes()));
    if (!pipe) throw std::runtime_error("endpoint-collision");
    startup_stage = StartupFailure::discovery_publication;
    Discovery discovery(directory,security,user,current_,name);
    { std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_ = name; }
    startup_failure_.store(StartupFailure::none); startup_complete = true; SetEvent(startup_event_.get());
    while (WaitForSingleObject(stop_event_.get(),0) == WAIT_TIMEOUT) {
      status_.store(Status::listening); Operation connect; DWORD transferred = 0;
      auto connected = ConnectNamedPipe(pipe.get(),&connect.overlapped); auto error = connected ? ERROR_SUCCESS : GetLastError();
      if (!connected && error == ERROR_IO_PENDING) connected = wait_io(pipe.get(),connect.overlapped,transferred,UINT64_MAX,false);
      else if (error == ERROR_PIPE_CONNECTED) connected = TRUE;
      if (!connected) break;
      try { serve(pipe.get(),directory,security,user); }
      catch (const SessionExhausted&) { throw; } // Retire discovery/session; never reset an exhausted counter in place.
      catch (...) { /* Malformed/rejected clients retire only their connection. */ }
      adapter_.set_consumer(false,false);
      if (pending_) lost_ = lost_ > UINT64_MAX - pending_->snapshot.observation_count ? UINT64_MAX : lost_ + pending_->snapshot.observation_count;
      pending_.reset(); current_.observations = {}; current_.observation_count = 0; diagnostics_ = false; CancelIoEx(pipe.get(),nullptr); DisconnectNamedPipe(pipe.get());
    }
    adapter_.set_consumer(false,false);
  } catch (...) {
    adapter_.set_consumer(false,false); status_.store(Status::failed);
    if (!startup_complete) { startup_failure_.store(startup_stage); SetEvent(startup_event_.get()); }
  }
  { std::lock_guard<std::mutex> lock(endpoint_mutex_); endpoint_.clear(); }
}
}
