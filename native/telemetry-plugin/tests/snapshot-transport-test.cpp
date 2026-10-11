#include "pipe-server.hpp"
#include "snapshot-wire.hpp"
#include "protocol-json.hpp"
#include <map>
#include <memory>
#include <iostream>
#include <functional>
#include <chrono>
#include <sstream>
#include <objbase.h>
#include <sddl.h>
#include <winioctl.h>

using namespace ets2telemetry;
using namespace ets2telemetry::transport;
namespace {
unsigned assertions = 0;
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
bool until(const std::function<bool()>& predicate, DWORD ms = 2000) {
  const auto end = GetTickCount64()+ms; do { if (predicate()) return true; Sleep(5); } while (GetTickCount64()<end); return false;
}
struct Host {
  static Host* active;
  std::thread::id caller = std::this_thread::get_id(); unsigned wrong_thread = 0;
  std::vector<std::string> logs;
  std::map<scs_event_t,std::pair<scs_telemetry_event_callback_t,scs_context_t>> events;
  struct Channel { scs_telemetry_channel_callback_t cb; scs_context_t ctx; };
  std::map<std::string,Channel> channels; std::uint64_t frames = 0;
  Host() { active = this; }
  static void check() { if (active->caller != std::this_thread::get_id()) ++active->wrong_thread; }
  static SCSAPI_VOID log(scs_log_type_t type,scs_string_t message) { check(); require(type==SCS_LOG_TYPE_error,"startup error severity"); active->logs.emplace_back(message); }
  static SCSAPI_RESULT reg_event(scs_event_t id,scs_telemetry_event_callback_t cb,scs_context_t ctx) { check(); active->events[id] = {cb,ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_event(scs_event_t id) { check(); active->events.erase(id); return SCS_RESULT_ok; }
  static SCSAPI_RESULT reg_channel(scs_string_t name,scs_u32_t,scs_value_type_t,scs_u32_t,scs_telemetry_channel_callback_t cb,scs_context_t ctx) { check(); active->channels[name] = {cb,ctx}; return SCS_RESULT_ok; }
  static SCSAPI_RESULT unreg_channel(scs_string_t name,scs_u32_t,scs_value_type_t) { check(); active->channels.erase(name); return SCS_RESULT_ok; }
  scs_telemetry_init_params_v100_t params(const char* game="eut2") { scs_telemetry_init_params_v100_t p{}; p.common.game_id=game; p.common.game_version=SCS_MAKE_VERSION(1,20); p.common.log=log; p.register_for_event=reg_event; p.unregister_from_event=unreg_event; p.register_for_channel=reg_channel; p.unregister_from_channel=unreg_channel; return p; }
  void event(scs_event_t id,const void* value=nullptr) { auto entry=events.at(id); entry.first(id,value,entry.second); }
  void channel(const char* name, const scs_value_t& v) { const auto entry=channels.at(name); entry.cb(name,SCS_U32_NIL,&v,entry.ctx); }
  void frame(float speed) { scs_telemetry_frame_start_t f{}; f.render_time=f.simulation_time=f.paused_simulation_time=++frames*50000; event(SCS_TELEMETRY_EVENT_frame_start,&f);
    scs_value_t v{}; v.type=SCS_VALUE_TYPE_float; v.value_float.value=speed; channel("truck.speed",v); v.value_float.value=20; channel("truck.fuel.amount",v);
    v={}; v.type=SCS_VALUE_TYPE_dplacement; channel("truck.world.placement",v); event(SCS_TELEMETRY_EVENT_frame_end); }
};
Host* Host::active=nullptr;
std::string utf8(const std::wstring& w) { const auto n=WideCharToMultiByte(CP_UTF8,0,w.data(),static_cast<int>(w.size()),nullptr,0,nullptr,nullptr); std::string s(static_cast<std::size_t>(n),'\0'); WideCharToMultiByte(CP_UTF8,0,w.data(),static_cast<int>(w.size()),s.data(),n,nullptr,nullptr); return s; }
void write_policy(const std::wstring& directory,const OwnerSecurity& security,const UserIdentity& user,const PeerIdentity& peer,const std::string& digest="") {
  v0::Json j{v0::Json::Object{{"schemaVersion",v0::Json{1.0}},{"userTag",v0::Json{user.tag}},{"windowsSessionId",v0::Json{static_cast<double>(user.session)}},
    {"allowedExecutables",v0::Json{v0::Json::Array{v0::Json{v0::Json::Object{{"path",v0::Json{utf8(peer.image)}},{"sha256",v0::Json{digest.empty()?peer.sha256:digest}}}}}}}}};
  const auto bytes=v0::detail::serialize(j); Handle f(CreateFileW((directory+L"\\service-policy.json").c_str(),GENERIC_WRITE,0,security.attributes(),CREATE_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  require(static_cast<bool>(f),"policy create"); DWORD written=0; require(WriteFile(f.get(),bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)&&written==bytes.size(),"policy write");
}
struct Fixture {
  UserIdentity user=current_user(); OwnerSecurity security{user.sid}; PeerIdentity self=inspect_peer(GetCurrentProcessId());
  Host host; std::unique_ptr<sdk::Adapter> adapter=std::make_unique<sdk::Adapter>(); Server server{*adapter}; std::wstring directory;
  Fixture() { WCHAR temporary[MAX_PATH]{}; require(GetTempPathW(MAX_PATH,temporary)>0,"temp path"); GUID id{}; CoCreateGuid(&id); WCHAR label[40]{}; StringFromGUID2(id,label,40); directory=std::wstring(temporary)+L"ET004a-"+label; security.ensure_directory(directory);
    auto p=host.params(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01,&p)==SCS_RESULT_ok,"SDK initialize"); write_policy(directory,security,user,self); }
  ~Fixture() { server.stop(); adapter->shutdown(); DeleteFileW((directory+L"\\service-policy.json").c_str()); RemoveDirectoryW(directory.c_str()); }
  void start() { require(server.start(directory),"worker start"); require(until([&]{return server.status()==Status::listening;}),"listening"); }
  Handle connect() { Handle h; require(until([&]{ h.reset(CreateFileW(server.endpoint().c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr)); return static_cast<bool>(h); }),"client connect"); return h; }
};
bool io(HANDLE pipe,bool read,std::uint8_t* bytes,DWORD count,DWORD& transferred,DWORD deadline=2000) {
  Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr)); OVERLAPPED op{}; op.hEvent=event.get(); const auto ok=read?ReadFile(pipe,bytes,count,&transferred,&op):WriteFile(pipe,bytes,count,&transferred,&op);
  if (ok) return true; if (GetLastError()!=ERROR_IO_PENDING) return false;
  if (WaitForSingleObject(event.get(),deadline)!=WAIT_OBJECT_0) { CancelIoEx(pipe,&op); GetOverlappedResult(pipe,&op,&transferred,TRUE); return false; }
  return GetOverlappedResult(pipe,&op,&transferred,FALSE)!=FALSE;
}
std::vector<std::uint8_t> framed(const std::string& payload) { const auto n=static_cast<std::uint32_t>(payload.size()); std::vector<std::uint8_t> out{static_cast<std::uint8_t>(n),static_cast<std::uint8_t>(n>>8),static_cast<std::uint8_t>(n>>16),static_cast<std::uint8_t>(n>>24)}; out.insert(out.end(),payload.begin(),payload.end()); return out; }
const char* hello_payload="{\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"data\":{\"clientInstanceId\":\"00000000-0000-4000-8000-000000000001\",\"minMinor\":0,\"maxMinor\":0,\"diagnostics\":true}}";
void send(HANDLE h,std::vector<std::uint8_t> bytes,bool split=false) { DWORD written=0; if (!split) require(io(h,false,bytes.data(),static_cast<DWORD>(bytes.size()),written)&&written==bytes.size(),"client write");
  else for (auto& byte:bytes) require(io(h,false,&byte,1,written)&&written==1,"split client write"); }
struct Receiver {
  v0::FrameDecoder decoder; std::vector<v0::Message> messages;
  void read(HANDLE h,std::size_t minimum) { const auto deadline=GetTickCount64()+2500; while(messages.size()<minimum && GetTickCount64()<deadline) { std::array<std::uint8_t,65540> b{}; DWORD count=0; require(io(h,true,b.data(),static_cast<DWORD>(b.size()),count)&&count,"server frame read"); decoder.push(b.data(),count,[&](v0::Message m){messages.push_back(std::move(m));}); } require(messages.size()>=minimum,"message count"); }
};
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
struct HookState {
  enum class Mode { none, accept_close, accept_immediate, accept_completion, hash_block, hash_read, cancel_race } mode = Mode::none;
  Handle ready{CreateEventW(nullptr,TRUE,FALSE,nullptr)}, release{CreateEventW(nullptr,TRUE,FALSE,nullptr)}, first_cancel{CreateEventW(nullptr,TRUE,FALSE,nullptr)}, completed{CreateEventW(nullptr,TRUE,FALSE,nullptr)};
  Handle blocked_read, blocked_write;
  std::atomic<unsigned> accepts{0}, reads{0}, blocks{0};
  std::atomic<DWORD> observed_error{ERROR_SUCCESS}, late_read_error{ERROR_SUCCESS};
  std::atomic<bool> synchronized{true}; DWORD injected = ERROR_SUCCESS;
  static HookState* active;
  ~HookState() { set_transport_test_hook(nullptr); active=nullptr; }
  void enable() { active=this; set_transport_test_hook(hook); }
  static DWORD hook(const char* phase,HANDLE object,HANDLE stop,DWORD result) {
    auto& s=*active;
    if (!stop) return result;
    const std::string name(phase);
    if(name=="accept-before-connect") {
      const auto attempt=++s.accepts;
      if(attempt==1 && s.mode==Mode::accept_close) {
        SetEvent(s.ready.get()); if(WaitForSingleObject(s.release.get(),2000)!=WAIT_OBJECT_0)s.synchronized.store(false);
      }
      if(attempt==1 && s.mode==Mode::accept_immediate)return s.injected;
    }
    if(name=="accept-pending" && s.accepts.load()==1 && s.mode==Mode::accept_completion) {
      SetEvent(s.ready.get());
      if(s.injected==ERROR_OPERATION_ABORTED)CancelIoEx(object,nullptr);
    }
    if(name=="accept-result" && s.accepts.load()==1) {
      s.observed_error.store(result);
      // Deliberately clobber Win32 last-error after the worker has saved completion.
      SetLastError(ERROR_INVALID_HANDLE);
      if(s.mode==Mode::accept_completion && s.injected!=ERROR_OPERATION_ABORTED)return s.injected;
    }
    if(name=="hash-before-read")++s.reads;
    if(name=="hash-after-block")++s.blocks;
    const bool boundary=(s.mode==Mode::hash_block && name=="hash-after-block") || (s.mode==Mode::hash_read && name=="hash-after-read") || (s.mode==Mode::cancel_race && name=="hash-after-block");
    if(boundary && s.reads.load()==1) {
      SetEvent(s.ready.get());
      if(s.mode==Mode::cancel_race) {
        if(WaitForSingleObject(s.first_cancel.get(),2000)!=WAIT_OBJECT_0)s.synchronized.store(false);
        // The first cancellation already found no pending read. This real synchronous
        // read represents the check/read scheduling race on the owned worker.
        char byte=0; DWORD count=0;
        const auto ok=ReadFile(s.blocked_read.get(),&byte,1,&count,nullptr);
        s.late_read_error.store(ok?ERROR_SUCCESS:GetLastError()); SetEvent(s.completed.get());
      } else if(WaitForSingleObject(stop,2000)!=WAIT_OBJECT_0)s.synchronized.store(false);
    }
    if(name=="stop-after-cancel")SetEvent(s.first_cancel.get());
    return result;
  }
};
HookState* HookState::active=nullptr;
void accept_disconnect() {
  {
    HookState hooks; Fixture f; hooks.mode=HookState::Mode::accept_close; hooks.enable(); f.start();
    require(WaitForSingleObject(hooks.ready.get(),2000)==WAIT_OBJECT_0,"accept barrier reached");
    auto departed=f.connect(); departed.reset(); SetEvent(hooks.release.get());
    require(until([&]{return hooks.accepts.load()>=2;}),"immediate-close accept rearmed");
    require(hooks.observed_error.load()==ERROR_NO_DATA,"actual closed client produces ERROR_NO_DATA");
    std::cout<<"actualEarlyCloseError="<<hooks.observed_error.load()<<" acceptAttempts="<<hooks.accepts.load()<<'\n';
    auto replacement=f.connect(); send(replacement.get(),framed(hello_payload)); Receiver receiver; receiver.read(replacement.get(),2);
    require(receiver.messages[0].kind=="welcome"&&receiver.messages[1].kind=="checkpoint","authorized replacement hydrates after actual immediate close");
    require(hooks.synchronized.load(),"actual close barrier synchronized"); f.server.stop();
  }
  for(auto mode:{HookState::Mode::accept_immediate,HookState::Mode::accept_completion}) {
    HookState hooks; Fixture f; hooks.mode=mode; hooks.injected=mode==HookState::Mode::accept_immediate?ERROR_BROKEN_PIPE:ERROR_NO_DATA; hooks.enable();
    require(f.server.start(f.directory),"injected disconnect worker start"); require(f.server.await_startup()==StartupFailure::none,"injected disconnect startup");
    Handle departed; if(mode==HookState::Mode::accept_completion) {
      require(WaitForSingleObject(hooks.ready.get(),2000)==WAIT_OBJECT_0,"overlapped accept pending before connection"); departed=f.connect();
    }
    require(until([&]{return hooks.accepts.load()>=2;}),"known disconnected accept outcome rearmed"); departed.reset();
    auto replacement=f.connect(); send(replacement.get(),framed(hello_payload)); Receiver receiver; receiver.read(replacement.get(),2);
    require(receiver.messages[1].kind=="checkpoint","replacement hydrates after injected disconnected outcome"); f.server.stop();
  }
}
void accept_failure() {
  for(auto mode:{HookState::Mode::accept_immediate,HookState::Mode::accept_completion}) {
    HookState hooks; Fixture f; hooks.mode=mode; hooks.injected=mode==HookState::Mode::accept_completion?ERROR_OPERATION_ABORTED:ERROR_ACCESS_DENIED; hooks.enable();
    require(f.server.start(f.directory),"unknown accept worker starts"); require(f.server.await_startup()==StartupFailure::none,"unknown accept startup succeeds");
    if(mode==HookState::Mode::accept_completion)
      require(WaitForSingleObject(hooks.ready.get(),2000)==WAIT_OBJECT_0,"failed overlapped accept established");
    require(until([&]{return f.server.status()==Status::failed;}),"unexpected accept failure reported as failed");
    require(until([&]{return f.server.endpoint().empty();}),"failed accept retires endpoint");
    sdk::Snapshot current; require(f.adapter->read_current(current),"failed accept source retained");
    const auto record=f.directory+L"\\"+std::wstring(current.identity.process_instance_id.bytes.begin(),current.identity.process_instance_id.bytes.begin()+36)+L".json";
    require(GetFileAttributesW(record.c_str())==INVALID_FILE_ATTRIBUTES,"unexpected accept failure retires actual discovery");
    std::cout<<"unexpectedAcceptError="<<hooks.observed_error.load()<<" acceptAttempts="<<hooks.accepts.load()<<'\n';
    if(mode==HookState::Mode::accept_completion)
      require(hooks.observed_error.load()==ERROR_OPERATION_ABORTED,"actual overlapped completion failure saved before last-error clobber");
    require(hooks.accepts.load()==1,"unexpected accept error never broadly retried"); f.server.stop(); require(f.server.status()==Status::failed,"stop preserves accept failure");
  }
  HookState hooks; Fixture f; hooks.enable(); f.start(); require(until([&]{return hooks.accepts.load()==1;}),"pending accept established");
  f.server.stop(); require(f.server.status()==Status::stopped&&f.server.endpoint().empty(),"stop cancellation retires normally without accept failure");
}
void hash_cancel() {
  HookState hooks; Fixture f;
  const auto path=f.directory+L"\\hash-fixture.bin";
  struct OwnedFile { const std::wstring& path; ~OwnedFile() { DeleteFileW(path.c_str()); } } cleanup{path};
  std::vector<unsigned char> content(3*65536+17);
  for(std::size_t i=0;i<content.size();++i)content[i]=static_cast<unsigned char>(i%251);
  {Handle file(CreateFileW(path.c_str(),GENERIC_WRITE,0,f.security.attributes(),CREATE_NEW,0,nullptr)); DWORD written=0; require(file&&WriteFile(file.get(),content.data(),static_cast<DWORD>(content.size()),&written,nullptr)&&written==content.size(),"multi-block hash fixture write");}
  Handle stop(CreateEventW(nullptr,TRUE,FALSE,nullptr)); hooks.enable();
  {Handle file(CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr)); require(sha256_handle(file.get(),stop.get())=="4bb7439bc39bc2d0e3d6a915d7c81e38250a9c5bb320a94a19a95bba0d5fe40a"&&sha256_bytes(content.data(),content.size())=="4bb7439bc39bc2d0e3d6a915d7c81e38250a9c5bb320a94a19a95bba0d5fe40a","complete held-file hash matches independently pinned digest");}
  require(hooks.reads.load()==5&&hooks.blocks.load()==4,"positive full hash spans four blocks and EOF");
  for(auto mode:{HookState::Mode::hash_block,HookState::Mode::hash_read}) {
    ResetEvent(stop.get()); ResetEvent(hooks.ready.get()); hooks.mode=mode; hooks.reads.store(0); hooks.blocks.store(0);
    bool cancelled=false; std::thread hash_worker([&]{try{Handle file(CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr)); sha256_handle(file.get(),stop.get());}catch(const std::exception& e){cancelled=std::string(e.what())=="inspection-stopped";}});
    const auto reached=WaitForSingleObject(hooks.ready.get(),2000); SetEvent(stop.get()); hash_worker.join();
    require(reached==WAIT_OBJECT_0&&hooks.synchronized.load(),"hash cancellation boundary synchronized");
    std::cout<<"cancelledHash="<<cancelled<<" reads="<<hooks.reads.load()<<" blocks="<<hooks.blocks.load()<<'\n';
    require(cancelled,"stop rejects partial digest"); require(hooks.reads.load()==1,"stop between blocks prevents next file read");
    require(hooks.blocks.load()==(mode==HookState::Mode::hash_block?1u:0u),"stop after read prevents new hash work");
  }
  hooks.mode=HookState::Mode::none; ResetEvent(stop.get()); hooks.reads.store(0); hooks.blocks.store(0);
  auto peer=inspect_peer(GetCurrentProcessId(),stop.get()); require(peer.image==f.self.image&&peer.sha256==f.self.sha256&&peer.creation==f.self.creation&&peer.sid==f.user.sid&&peer.session==f.user.session,"complete peer inspection retains exact image process token session authority");
  const auto policy=read_service_policy(f.directory,f.security,f.user,stop.get());
  require(policy.size()==1&&policy[0].image==f.self.image&&policy[0].sha256==f.self.sha256,"complete protected policy preserves exact path and digest");
  SetEvent(stop.get()); bool policy_cancelled=false,peer_cancelled=false;
  try{read_service_policy(f.directory,f.security,f.user,stop.get());}catch(const std::exception& e){policy_cancelled=std::string(e.what())=="inspection-stopped";}
  try{inspect_peer(GetCurrentProcessId(),stop.get());}catch(const std::exception& e){peer_cancelled=std::string(e.what())=="inspection-stopped";}
  require(policy_cancelled&&peer_cancelled,"stopped peer and protected policy inspection reject before new authority I/O"); ResetEvent(stop.get());
  hooks.mode=HookState::Mode::hash_block; hooks.reads.store(0); hooks.blocks.store(0); ResetEvent(hooks.ready.get());
  f.start(); auto client=f.connect(); require(WaitForSingleObject(hooks.ready.get(),2000)==WAIT_OBJECT_0,"actual worker peer hash boundary reached");
  f.server.stop(); require(hooks.synchronized.load()&&hooks.reads.load()==1&&hooks.blocks.load()==1,"actual worker stop prevents further peer hash I/O");
  std::cout<<"actualHashWorkerShutdownMs="<<f.server.shutdown_ms()<<" reads="<<hooks.reads.load()<<" blocks="<<hooks.blocks.load()<<'\n';
  require(f.server.status()==Status::stopped&&f.server.endpoint().empty(),"actual hash worker completed joined and retired"); client.reset(); require(DeleteFileW(path.c_str())!=FALSE,"owned hash fixture removed");
}
void hash_cancel_race() {
  HookState hooks; Fixture f; hooks.mode=HookState::Mode::cancel_race;
  HANDLE read=nullptr,write=nullptr; require(CreatePipe(&read,&write,nullptr,0)!=FALSE,"owned synchronous read fixture"); hooks.blocked_read.reset(read); hooks.blocked_write.reset(write); hooks.enable(); f.start(); auto client=f.connect();
  require(WaitForSingleObject(hooks.ready.get(),2000)==WAIT_OBJECT_0,"late synchronous read boundary reached");
  std::atomic<bool> fallback{false};
  // A bounded fallback releases the original broken implementation for retained RED evidence.
  std::thread guard([&]{if(WaitForSingleObject(hooks.completed.get(),750)!=WAIT_OBJECT_0){fallback.store(true); char byte=1; DWORD written=0; WriteFile(hooks.blocked_write.get(),&byte,1,&written,nullptr);}});
  f.server.stop(); guard.join();
  std::cout<<"lateReadError="<<hooks.late_read_error.load()<<" fallback="<<fallback.load()<<" shutdownMs="<<f.server.shutdown_ms()<<'\n';
  require(hooks.synchronized.load()&&!fallback.load()&&hooks.late_read_error.load()==ERROR_OPERATION_ABORTED,"stop cancels real read scheduled after first cancellation");
  require(hooks.reads.load()==1&&hooks.blocks.load()==1&&f.server.status()==Status::stopped&&f.server.endpoint().empty(),"race worker completed joined without further image work");
}
#endif
void serialization() {
  OutboundSequence sequences(UINT64_MAX-1); require(sequences.reserve()==UINT64_MAX,"last sequence represented exactly"); bool exhausted=false; try{sequences.reserve();}catch(const SessionExhausted&){exhausted=true;} require(exhausted,"sequence exhaustion never wraps");
  require(sha256_bytes("abc",3)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","pinned SHA256 hash format");
  Fixture f; sdk::Snapshot s; require(f.adapter->read_current(s),"initial snapshot");
  auto welcome=current_message(s,"welcome",UINT64_MAX-2,{}); auto checkpoint=current_message(s,"checkpoint",UINT64_MAX-1,{});
  v0::Consumer consumer(false); consumer.accept(welcome); const auto applied=consumer.accept(checkpoint);
  require(applied&&applied->hydration,"coherent boundary exact uint64"); require(checkpoint.state->window.reason==v0::AvailabilityReason::not_supported,"window unavailable");
  window::Snapshot w{}; w.status=window::Status::available; w.process_id=s.identity.process_id; w.windows_session_id=s.identity.windows_session_id;
  w.process_creation_time=42; w.plugin_session_id=s.identity.plugin_session_id.bytes; w.per_monitor_v2=w.visible=w.client_bounds_available=true;
  w.handle=UINT64_MAX; w.client={-400,-300,640,480}; w.dpi=144; w.capture_monotonic_ms=1000;
  auto mapped=current_message(s,"snapshot",3,{},false,&w,42,1250);
  require(mapped.state->window.value&&mapped.state->window.value->handle==UINT64_MAX&&mapped.state->window.value->x==-400&&mapped.state->window.value->display_mode=="unknown","exact HWND signed physical geometry and unknown mode at age limit");
  require(!current_window(s,&w,42,1251).value&&!current_window(s,&w,42,999).value,"stale and future window captures unavailable");
  for(unsigned i=0;i<13;++i) {auto bad=w;
    switch(i){case 0:bad.process_id++;break;case 1:bad.windows_session_id++;break;case 2:bad.process_creation_time++;break;case 3:bad.plugin_session_id[0]='x';break;
      case 4:bad.handle=0;break;case 5:bad.dpi=0;break;case 6:bad.client.width=0;break;case 7:bad.client.height=0;break;case 8:bad.visible=false;break;
      case 9:bad.minimized=true;bad.client={};bad.client_bounds_available=false;break;case 10:bad.per_monitor_v2=false;break;case 11:bad.status=window::Status::ambiguous;break;case 12:bad.status=window::Status::stopped;break;}
    auto invalid=current_message(s,"snapshot",3,{},false,&bad,42,1000); require(!invalid.state->window.value,"identity/availability mismatch never retains old geometry");
  }
  s.state.job.status=sdk::Availability::available; s.state.job.cargo_id.status=sdk::Availability::invalid;
  auto invalid_job=current_message(s,"snapshot",3,{}); require(!invalid_job.state->configuration.job.value&&invalid_job.state->configuration.job.reason==v0::AvailabilityReason::invalid,"invalid required job identity remains invalid");
  s.observation_count=3; s.observations[0].kind=sdk::ObservationKind::channel; s.observations[0].name.assign("value"); s.observations[0].value.type=SCS_VALUE_TYPE_u64; s.observations[0].value.status=sdk::Availability::available; s.observations[0].value.unsigned_integer=UINT64_MAX;
  s.observations[1]=s.observations[0]; s.observations[1].name.assign("signed64"); s.observations[1].value.type=SCS_VALUE_TYPE_s64; s.observations[2]=s.observations[0]; s.observations[2].name.assign("placement"); s.observations[2].value.type=SCS_VALUE_TYPE_dplacement;
  v0::Continuity c{}; std::uint64_t omitted=0; auto d=diagnostic_message(s,UINT64_MAX,c,omitted);
  require(omitted==2&&d.observations.size()==1&&std::get<std::uint64_t>(*d.observations[0].reading.value)==UINT64_MAX&&c.lost_observations==2,"unsupported copied types are explicit loss, exact u64 retained");
  auto process=std::string(s.identity.process_instance_id.c_str()); auto plugin=std::string(s.identity.plugin_session_id.c_str()); f.adapter->shutdown(); auto p=f.host.params("ats"); require(f.adapter->initialize(SCS_TELEMETRY_VERSION_1_01,&p)==SCS_RESULT_ok,"ATS reinitialize"); f.adapter->read_current(s);
  require(process==s.identity.process_instance_id.c_str()&&plugin!=s.identity.plugin_session_id.c_str()&&std::string(s.identity.game.c_str())=="ats","process lifetime stable, plugin identity rotates, ATS distinct");
}
void live_reconnect_security() {
  Fixture f; f.host.event(SCS_TELEMETRY_EVENT_started); for(unsigned i=0;i<1000;++i) f.host.frame(10); sdk::Snapshot absent; f.adapter->read_current(absent); require(absent.observation_count==0&&absent.continuity.lost_observations>0,"absent consumer retains no observation payloads");
  f.start(); auto client=f.connect(); f.security.verify_handle(client.get()); send(client.get(),framed(hello_payload),true); Receiver receiver; receiver.read(client.get(),2);
  require(receiver.messages[0].kind=="welcome"&&receiver.messages[0].diagnostics&&receiver.messages[1].kind=="checkpoint","welcome diagnostic opt-in then checkpoint");
  Handle second(CreateFileW(f.server.endpoint().c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr)); require(!second&&GetLastError()==ERROR_PIPE_BUSY,"second client refused");
  auto wrong=f.user; wrong.session^=1; AllowedPeer allowed{f.self.pid,f.self.creation,f.self.image,f.self.sha256}; auto authoritative=authenticate_client(client.get(),f.user,allowed); require(authoritative.pid==f.self.pid&&authoritative.creation==f.self.creation,"actual peer authority positive control"); bool rejected=false; try{authenticate_client(client.get(),wrong,allowed);}catch(...){rejected=true;} require(rejected,"actual peer session mismatch rejected");
  wrong=f.user; wrong.sid=L"S-1-5-18"; rejected=false; try{authenticate_client(client.get(),wrong,allowed);}catch(...){rejected=true;} require(rejected,"actual peer token user mismatch rejected");
  allowed.creation++; rejected=false; try{authenticate_client(client.get(),f.user,allowed);}catch(...){rejected=true;} require(rejected,"retained creation mismatch rejected");
  f.host.frame(-7.5F); receiver.read(client.get(),4); v0::Consumer consumer(true); for(const auto& m:receiver.messages) consumer.accept(m);
  require(receiver.messages[2].state&&receiver.messages[2].state->speed.reading.value==std::optional<double>(-7.5),"actual pipe normalized reverse speed");
  require(receiver.messages[3].kind=="diagnostic"&&!receiver.messages[3].observations.empty(),"actual copied diagnostics transport");
  require(receiver.messages[3].continuity.lost_observations>receiver.messages[2].continuity.lost_observations,"actual unsupported placement counted as diagnostic loss");
  const auto previous=receiver.messages.back().seq; client.reset(); require(until([&]{return f.server.status()==Status::listening;}),"disconnect listening");
  f.host.frame(0); auto reconnect=f.connect(); send(reconnect.get(),framed(hello_payload)); Receiver again; again.read(reconnect.get(),2);
  require(again.messages[0].seq>previous&&again.messages[1].seq>again.messages[0].seq&&again.messages[1].state->speed.reading.value==std::optional<double>(0),"reconnect retains sequence/current zero hydration");
  f.server.stop(); require(f.server.shutdown_ms()<1000&&f.server.status()==Status::stopped,"active read cancellation observed and joined under deadline");
  require(f.host.wrong_thread==0,"worker never calls SDK API");
}
void rejection_and_timeout() {
  Fixture f; f.start();
  auto exact_payload=std::string(hello_payload); exact_payload.resize(4096,' ');
  auto exact=f.connect(); send(exact.get(),framed(exact_payload)); Receiver accepted; accepted.read(exact.get(),2);
  require(accepted.messages[0].kind=="welcome"&&accepted.messages[1].kind=="checkpoint","exact 4096-byte valid hello accepted"); exact.reset();
  require(until([&]{return f.server.status()==Status::listening;}),"exact-bound hello disconnect");
  auto oversized_payload=std::string(hello_payload); oversized_payload.resize(4097,' ');
  auto oversized=f.connect(); send(oversized.get(),framed(oversized_payload)); std::array<std::uint8_t,32> oversize_response{}; DWORD oversize_read=0;
  require(!io(oversized.get(),true,oversize_response.data(),32,oversize_read),"valid padded 4097-byte hello rejected before welcome"); oversized.reset();
  require(until([&]{return f.server.status()==Status::listening;}),"oversized hello disconnect");
  auto oversized_prefix=f.connect(); send(oversized_prefix.get(),{1,16,0,0}); const auto prefix_started=GetTickCount64();
  require(!io(oversized_prefix.get(),true,oversize_response.data(),32,oversize_read,1000)&&GetTickCount64()-prefix_started<1000,"oversized hello prefix rejected without waiting for payload"); oversized_prefix.reset();
  require(until([&]{return f.server.status()==Status::listening;}),"oversized prefix disconnect");
  std::vector<std::vector<std::uint8_t>> invalid;
  invalid.push_back({0,0,0,0}); invalid.push_back({1,0,1,0}); invalid.push_back(framed("{"));
  auto bad=std::string(hello_payload); bad.replace(bad.find("\"major\":0"),9,"\"major\":1"); invalid.push_back(framed(bad));
  auto duplicate=framed(hello_payload); const auto other=duplicate; duplicate.insert(duplicate.end(),other.begin(),other.end()); invalid.push_back(duplicate);
  auto trailing=framed(hello_payload); trailing.push_back(1); invalid.push_back(trailing);
  invalid.push_back(framed("{\"kind\":\"ack\"}")); invalid.push_back(framed("{\"version\":{\"major\":0,\"major\":0,\"minor\":0}}"));
  for(auto bytes:invalid) { auto h=f.connect(); send(h.get(),std::move(bytes)); std::array<std::uint8_t,32> response{}; DWORD read=0; require(!io(h.get(),true,response.data(),32,read,2000),"invalid inbound closes without welcome"); h.reset(); require(until([&]{return f.server.status()==Status::listening;}),"rejected reconnect listener"); }
  auto stalled=f.connect(); const auto started=GetTickCount64(); std::array<std::uint8_t,32> response{}; DWORD read=0;
  require(!io(stalled.get(),true,response.data(),32,read,6000),"no hello timed out"); const auto elapsed=GetTickCount64()-started; require(elapsed>=4900&&elapsed<5900,"real 5s handshake timeout"); stalled.reset();
  require(until([&]{return f.server.status()==Status::listening;}),"post-timeout listener");
  auto valid=f.connect(); send(valid.get(),framed(hello_payload)); Receiver receiver; receiver.read(valid.get(),2); send(valid.get(),framed(hello_payload)); require(!io(valid.get(),true,response.data(),32,read),"duplicate hello after checkpoint closes"); valid.reset();
  require(until([&]{return f.server.status()==Status::listening;}),"post-duplicate listener"); write_policy(f.directory,f.security,f.user,f.self,std::string(64,'0')); auto denied=f.connect(); send(denied.get(),framed(hello_payload)); require(!io(denied.get(),true,response.data(),32,read),"actual client image digest mismatch rejected"); denied.reset();
  f.server.stop(); require(f.server.shutdown_ms()<1000,"pending connect cancellation under deadline");
}
void collision_and_discovery() {
  Fixture f; sdk::Snapshot current; f.adapter->read_current(current); const auto name=endpoint_name(current,f.user);
  Handle foreign(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,f.security.attributes())); require(static_cast<bool>(foreign),"foreign collision fixture");
  require(f.server.start(f.directory),"collision worker starts"); require(until([&]{return f.server.status()==Status::failed;}),"foreign endpoint fails closed"); require(f.server.endpoint().empty(),"foreign endpoint not adopted"); f.server.stop(); foreign.reset();
  f.start(); const auto record=f.directory+L"\\"+std::wstring(current.identity.process_instance_id.bytes.begin(),current.identity.process_instance_id.bytes.begin()+36)+L".json";
  f.security.verify_owner_only(record); Handle retained(CreateFileW(record.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr)); require(static_cast<bool>(retained),"atomic discovery readable");
  std::array<char,4096> bytes{}; DWORD read=0; require(ReadFile(retained.get(),bytes.data(),4096,&read,nullptr)&&read>0,"discovery bytes"); auto j=v0::detail::Parser(std::string(bytes.data(),read)).parse();
  require(j.at("pipeName").string()==utf8(f.server.endpoint())&&j.at("processCreationTime").string()==std::to_string(f.self.creation)&&j.at("userTag").string()==f.user.tag,"exact untrusted discovery schema"); retained.reset();
  f.server.stop(); require(GetFileAttributesW(record.c_str())==INVALID_FILE_ATTRIBUTES,"owned discovery retired");
}
void coalescing_and_stalled_shutdown() {
  Fixture f; f.start(); auto h=f.connect(); send(h.get(),framed(hello_payload)); Receiver receiver; receiver.read(h.get(),2);
  f.host.event(SCS_TELEMETRY_EVENT_started); const auto started=GetTickCount64();
  for(unsigned i=0;i<2500;++i) { f.host.frame(static_cast<float>(i%100)); if(i%100==0) Sleep(1); }
  require(GetTickCount64()-started<2000,"callbacks do not wait on unread client");
  Sleep(100); receiver.read(h.get(),4); v0::Consumer consumer(true); for(const auto& message:receiver.messages) consumer.accept(message);
  require(receiver.messages.back().continuity.coalesced_snapshots>0,"coalescing explicitly counted");
  // Keep publishing without draining; bounded kernel buffer eventually makes a write pending.
  const auto deadline=GetTickCount64()+5000; unsigned i=0;
  while(!f.server.write_pending()&&GetTickCount64()<deadline) { f.host.frame(static_cast<float>((i++)%100)); Sleep(1); }
  require(f.server.write_pending(),"actual kernel backpressure write pending before stop");
  f.server.stop(); require(f.server.shutdown_ms()<1000&&f.server.status()==Status::stopped,"stalled write/read cancellation joined");
}
void policy_and_exhaustion() {
  Fixture f; auto policy=read_service_policy(f.directory,f.security,f.user); require(policy.size()==1&&policy[0].sha256==f.self.sha256,"valid bounded held policy");
  const auto path=f.directory+L"\\service-policy.json";
  auto bad=[&](const std::string& bytes){Handle out(CreateFileW(path.c_str(),GENERIC_WRITE,0,f.security.attributes(),CREATE_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,nullptr)); DWORD written=0; require(out&&WriteFile(out.get(),bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr),"invalid policy fixture"); out.reset(); bool rejected=false; try{read_service_policy(f.directory,f.security,f.user);}catch(...){rejected=true;} require(rejected,"invalid policy rejected");};
  bad("{}"); bad("{\"schemaVersion\":1,\"schemaVersion\":1}"); bad(std::string(16385,' '));
  write_policy(f.directory,f.security,f.user,f.self); PSECURITY_DESCRIPTOR insecure=nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)",SDDL_REVISION_1,&insecure,nullptr)!=FALSE,"untrusted ACL fixture");
  require(SetFileSecurityW(path.c_str(),DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,insecure)!=FALSE,"set broad ACL fixture"); LocalFree(insecure);
  bool rejected=false; try{read_service_policy(f.directory,f.security,f.user);}catch(...){rejected=true;} require(rejected,"broad ACL rejected");
  require(DeleteFileW(path.c_str())!=FALSE,"remove owned broad ACL fixture"); write_policy(f.directory,f.security,f.user,f.self);
  const auto link=f.directory+L"\\policy-link.json"; if(CreateSymbolicLinkW(link.c_str(),path.c_str(),SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) {
    rejected=false; try{f.security.verify_owner_only(link);}catch(...){rejected=true;} require(rejected,"reparse authority rejected"); DeleteFileW(link.c_str());
  }else std::cout<<"symbolic-link runtime fixture unavailable error="<<GetLastError()<<'\n';
  const auto junction=f.directory+L"\\junction"; f.security.ensure_directory(junction);
  Handle junction_handle(CreateFileW(junction.c_str(),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  struct Junction { ULONG tag; USHORT length,reserved,substitute_offset,substitute_length,print_offset,print_length; WCHAR path[1]; };
  const auto substitute=L"\\??\\"+f.directory; const auto substitute_bytes=substitute.size()*sizeof(wchar_t); const auto print_bytes=f.directory.size()*sizeof(wchar_t);
  std::vector<unsigned char> data(16+substitute_bytes+print_bytes+2*sizeof(wchar_t)); auto* mount=reinterpret_cast<Junction*>(data.data());
  mount->tag=IO_REPARSE_TAG_MOUNT_POINT; mount->length=static_cast<USHORT>(data.size()-8); mount->substitute_length=static_cast<USHORT>(substitute_bytes); mount->print_offset=static_cast<USHORT>(substitute_bytes+sizeof(wchar_t)); mount->print_length=static_cast<USHORT>(print_bytes);
  memcpy(mount->path,substitute.data(),substitute_bytes); memcpy(reinterpret_cast<unsigned char*>(mount->path)+mount->print_offset,f.directory.data(),print_bytes); DWORD returned=0;
  if(junction_handle&&DeviceIoControl(junction_handle.get(),FSCTL_SET_REPARSE_POINT,data.data(),static_cast<DWORD>(data.size()),nullptr,0,&returned,nullptr)) {
    junction_handle.reset(); rejected=false; try{f.security.verify_owner_only(junction);}catch(...){rejected=true;} require(rejected,"actual directory junction authority rejected");
  }else std::cout<<"junction runtime fixture unavailable error="<<GetLastError()<<'\n';
  junction_handle.reset(); require(RemoveDirectoryW(junction.c_str())!=FALSE,"remove only owned junction entry");
  Server exhausted(*f.adapter,UINT64_MAX-1); require(exhausted.start(f.directory),"exhaustion worker start"); require(until([&]{return exhausted.status()==Status::listening;}),"exhaustion listener");
  const auto exhausted_endpoint=exhausted.endpoint(); Handle client(CreateFileW(exhausted_endpoint.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr)); require(static_cast<bool>(client),"exhaustion client"); send(client.get(),framed(hello_payload));
  require(until([&]{return exhausted.status()==Status::failed&&exhausted.endpoint().empty();}),"exhaustion retires worker/discovery endpoint");
  sdk::Snapshot retired; f.adapter->read_current(retired); const auto record=f.directory+L"\\"+std::wstring(retired.identity.process_instance_id.bytes.begin(),retired.identity.process_instance_id.bytes.begin()+36)+L".json";
  require(GetFileAttributesW(record.c_str())==INVALID_FILE_ATTRIBUTES,"exhaustion discovery record absent");
  Handle next_client(CreateFileW(exhausted_endpoint.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr)); require(!next_client,"new client cannot reuse exhausted source endpoint");
  std::array<std::uint8_t,65540> bytes{}; DWORD count=0;
  if(io(client.get(),true,bytes.data(),static_cast<DWORD>(bytes.size()),count)) { v0::FrameDecoder decoder; unsigned states=0; decoder.push(bytes.data(),count,[&](v0::Message m){require(m.seq==UINT64_MAX&&m.kind=="welcome","only final sequence welcome can precede exhaustion"); if(m.state)++states;}); require(states==0,"no checkpoint/current state after sequence exhaustion"); }
  exhausted.stop(); require(exhausted.shutdown_ms()<1000,"exhausted worker joined");
}
void seeded_transport_fuzz() {
  Fixture f; f.start(); std::uint32_t random=0x45a10f93;
  auto next=[&]{random=random*1664525U+1013904223U;return random;};
  for(unsigned iteration=0;iteration<96;++iteration) {
    std::string invalid=hello_payload; const auto offset=static_cast<std::size_t>(next()%invalid.size());
    // Raw C0 bytes are independently invalid in every JSON grammar position, including strings.
    invalid.insert(offset,1,static_cast<char>(1+(next()%7))); auto h=f.connect(); send(h.get(),framed(invalid));
    std::array<std::uint8_t,32> response{}; DWORD received=0;
    require(!io(h.get(),true,response.data(),32,received),"seeded raw-control mutation closes without state"); h.reset();
  }
  auto h=f.connect(); send(h.get(),framed(hello_payload)); Receiver receiver; receiver.read(h.get(),2); f.host.event(SCS_TELEMETRY_EVENT_started);
  for(unsigned burst=0;burst<16;++burst) { for(unsigned i=0,n=1+next()%80;i<n;++i) f.host.frame(static_cast<float>(static_cast<int>(next()%101)-50)); Sleep(60); }
  receiver.read(h.get(),4); v0::Consumer consumer(true); for(const auto& message:receiver.messages) consumer.accept(message);
  require(receiver.messages.back().continuity.coalesced_snapshots>0,"seeded burst queue preserves ordered state and loss"); f.server.stop(); require(f.server.shutdown_ms()<1000,"seeded transport joined");
}
struct OwnedWindow {
  HWND handle=nullptr;
  OwnedWindow() { create(); }
  void create() {
    static const wchar_t* name=L"ETS2TelemetryBoundWindowFixture";
    WNDCLASSW wc{}; wc.lpfnWndProc=DefWindowProcW; wc.hInstance=GetModuleHandleW(nullptr); wc.lpszClassName=name;
    if(!RegisterClassW(&wc)) require(GetLastError()==ERROR_CLASS_ALREADY_EXISTS,"fixture class registration");
    handle=CreateWindowExW(WS_EX_NOACTIVATE,name,L"Owned telemetry window fixture",WS_OVERLAPPEDWINDOW,-400,-300,640,480,nullptr,nullptr,wc.hInstance,nullptr);
    require(handle!=nullptr,"owned fixture window"); ShowWindow(handle,SW_SHOWNOACTIVATE);
  }
  ~OwnedWindow() {if(handle)DestroyWindow(handle);}
  void recreate() {require(DestroyWindow(handle)!=FALSE,"destroy owned fixture");handle=nullptr; create();}
};
void window_binding() {
  // The provider also outlives the server during exception unwinding.
  window::Monitor monitor; Fixture f; OwnedWindow owned; sdk::Snapshot identity; f.adapter->read_current(identity);
  require(monitor.start("eut2",identity.identity.plugin_session_id.c_str()),"actual named host accepted by monitor");
  require(until([&]{return monitor.latest().status==window::Status::available;}),"real window geometry observed");
  f.host.event(SCS_TELEMETRY_EVENT_started); f.host.event(SCS_TELEMETRY_EVENT_paused); f.host.frame(10);
  require(f.server.start(f.directory,&monitor)&&f.server.await_startup()==StartupFailure::none,"provider-bound server startup");
  auto client=f.connect();send(client.get(),framed(hello_payload));Receiver receiver;receiver.read(client.get(),2);
  require(receiver.messages[1].state->window.value.has_value(),"checkpoint carries physical window");
  const auto capture=receiver.messages[1].capture.monotonic_ns; const auto generation=monitor.latest().window_generation;
  auto observe=[&](const std::function<bool(const v0::Message&)>& predicate){const auto end=GetTickCount64()+2000;do{receiver.read(client.get(),receiver.messages.size()+1); if(predicate(receiver.messages.back()))return true;}while(GetTickCount64()<end);return false;};
  require(SetWindowPos(owned.handle,nullptr,-200,-100,800,600,SWP_NOACTIVATE|SWP_NOZORDER)!=FALSE,"move owned fixture without activation");
  require(observe([](const v0::Message& m){return m.state&&m.state->window.value&&m.state->window.value->width>700;}),"paused no-frame geometry move reaches pipe");
  ShowWindow(owned.handle,SW_HIDE);require(observe([](const v0::Message& m){return m.state&&!m.state->window.value;}),"hidden metadata unavailable on pipe");
  ShowWindow(owned.handle,SW_SHOWNOACTIVATE);require(observe([](const v0::Message& m){return m.state&&m.state->window.value.has_value();}),"restore current geometry on pipe");
  ShowWindow(owned.handle,SW_SHOWMINNOACTIVE);require(observe([](const v0::Message& m){return m.state&&!m.state->window.value;}),"minimized zero geometry unavailable on pipe");
  ShowWindow(owned.handle,SW_SHOWNOACTIVATE);require(observe([](const v0::Message& m){return m.state&&m.state->window.value.has_value();}),"minimized restore current geometry on pipe");
  owned.recreate(); require(observe([&](const v0::Message& m){return monitor.latest().window_generation>generation&&m.state&&m.state->window.value.has_value();}),"recreated window reaches pipe with current identity");
  const auto first_quiet=receiver.messages.size(),quiet_start=GetTickCount64();
  do {receiver.read(client.get(),receiver.messages.size()+1);}while(GetTickCount64()-quiet_start<600);
  require(receiver.messages.size()-first_quiet<=14,"window-only publication remains bounded to 20 Hz cadence");
  v0::Consumer consumer(true); for(const auto& m:receiver.messages){consumer.accept(m);require(m.capture.monotonic_ns==capture,"window-only update preserves original SDK capture");}
  require(receiver.messages.back().continuity.lost_observations==receiver.messages[1].continuity.lost_observations,"window-only publications invent no lost SDK observations");
  require(receiver.messages.back().state->simulation=="paused"&&f.host.wrong_thread==0,"paused telemetry remains paused and monitor never calls SDK");
  const auto start=GetTickCount64();f.server.stop();monitor.stop();require(GetTickCount64()-start<1000,"transport joins before monitor retires");
}
void dll_lifecycle(const char* path) {
  Fixture f; OwnedWindow owned; f.adapter->shutdown();
  for(unsigned scenario=0;scenario<3;++scenario) {
    HMODULE module=LoadLibraryA(path); require(module!=nullptr,"isolated test DLL load");
    auto init=reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module,"scs_telemetry_init"));
    auto shutdown=reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module,"scs_telemetry_shutdown"));
    using SetDirectory=int(*)(const wchar_t*); using GetEndpoint=int(*)(wchar_t*,unsigned); using Pending=int(*)();
    auto directory=reinterpret_cast<SetDirectory>(GetProcAddress(module,"ets2telemetry_test_directory"));
    auto endpoint=reinterpret_cast<GetEndpoint>(GetProcAddress(module,"ets2telemetry_test_endpoint"));
    auto pending=reinterpret_cast<Pending>(GetProcAddress(module,"ets2telemetry_test_write_pending"));
    require(init&&shutdown&&directory&&endpoint&&pending,"test-only seam and official exports"); require(directory(f.directory.c_str())!=0,"isolated DLL directory");
    auto p=f.host.params(); require(init(SCS_TELEMETRY_VERSION_1_01,&p)==SCS_RESULT_ok,"official DLL initialization");
    std::array<wchar_t,512> name{}; require(until([&]{return endpoint(name.data(),static_cast<unsigned>(name.size()))!=0;}),"DLL endpoint ready");
    Handle client(CreateFileW(name.data(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr)); require(static_cast<bool>(client),"DLL controlled pipe client");
    if(scenario>0) {send(client.get(),framed(hello_payload)); Receiver receiver; receiver.read(client.get(),2);
      if(scenario==2) {f.host.event(SCS_TELEMETRY_EVENT_started); const auto end=GetTickCount64()+5000; unsigned i=0; while(!pending()&&GetTickCount64()<end){f.host.frame(static_cast<float>((i++)%100));Sleep(1);} require(pending()!=0,"DLL real pending write before shutdown");}
    }else Sleep(50); // The authorized client intentionally leaves its handshake read pending.
    const auto started=GetTickCount64(); shutdown(); require(GetTickCount64()-started<1000,"official DLL shutdown joins active IO under deadline");
    require(FreeLibrary(module)!=FALSE,"test DLL unload after joined worker"); require(f.host.wrong_thread==0,"DLL worker makes no SDK API calls");
  }
}
void dll_startup_reporting(const char* path) {
  OwnedWindow owned;
  bool reported=true;
  for(unsigned scenario=0;scenario<3;++scenario) {
    Fixture f; sdk::Snapshot source; f.adapter->read_current(source); f.adapter->shutdown();
    const auto name=endpoint_name(source,f.user); const auto record=f.directory+L"\\"+std::wstring(source.identity.process_instance_id.bytes.begin(),source.identity.process_instance_id.bytes.begin()+36)+L".json";
    Handle foreign_pipe,foreign_record;
    const char* expected=scenario==0?"ETS2Telemetry: transport startup failed: endpoint-creation":scenario==1?"ETS2Telemetry: transport startup failed: identity-security":"ETS2Telemetry: transport startup failed: discovery-publication";
    if(scenario==0) {foreign_pipe.reset(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,f.security.attributes()));require(static_cast<bool>(foreign_pipe),"actual foreign reporting endpoint");}
    if(scenario==1) {PSECURITY_DESCRIPTOR insecure=nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)",SDDL_REVISION_1,&insecure,nullptr)!=FALSE,"reporting broad ACL descriptor"); require(SetFileSecurityW(f.directory.c_str(),DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,insecure)!=FALSE,"reporting broad ACL directory"); LocalFree(insecure);}
    if(scenario==2) {foreign_record.reset(CreateFileW(record.c_str(),GENERIC_READ|GENERIC_WRITE|DELETE,FILE_SHARE_READ,f.security.attributes(),CREATE_NEW,0,nullptr)); require(static_cast<bool>(foreign_record),"actual foreign discovery record"); DWORD written=0; require(WriteFile(foreign_record.get(),"foreign",7,&written,nullptr)&&written==7,"foreign discovery sentinel");}
    HMODULE module=LoadLibraryA(path); require(module!=nullptr,"reporting DLL load");
    auto init=reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module,"scs_telemetry_init")); auto shutdown=reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module,"scs_telemetry_shutdown"));
    using SetDirectory=int(*)(const wchar_t*); auto directory=reinterpret_cast<SetDirectory>(GetProcAddress(module,"ets2telemetry_test_directory")); require(init&&shutdown&&directory&&directory(f.directory.c_str()),"reporting official SDK/test directory");
    auto params=f.host.params(); const auto started=GetTickCount64(); const auto result=init(SCS_TELEMETRY_VERSION_1_01,&params); const auto elapsed=GetTickCount64()-started;
    // Even the retained red implementation is safely joined before assertions and unloading.
    shutdown(); require(FreeLibrary(module)!=FALSE,"reporting DLL unload");
    bool preserved=true;
    if(scenario==0) {Handle replacement(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,f.security.attributes())); preserved=!replacement;}
    if(scenario==2) {std::array<char,7> sentinel{}; LARGE_INTEGER zero{}; DWORD read=0; preserved=SetFilePointerEx(foreign_record.get(),zero,nullptr,FILE_BEGIN)&&ReadFile(foreign_record.get(),sentinel.data(),7,&read,nullptr)&&read==7&&std::string(sentinel.data(),7)=="foreign"; FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(foreign_record.get(),FileDispositionInfo,&remove,sizeof(remove)); foreign_record.reset();}
    std::cout<<"startup scenario="<<scenario<<" result="<<result<<" logs="<<f.host.logs.size()<<" wrongThread="<<f.host.wrong_thread<<" elapsedMs="<<elapsed<<std::endl;
    reported=reported&&result==SCS_RESULT_generic_error&&f.host.logs.size()==1&&f.host.logs[0]==expected&&f.host.wrong_thread==0;
    require(elapsed<1000,"local startup failure promptly returned without client wait"); require(preserved,"foreign collision/publication object preserved");
  }
  require(reported,"all startup failures return generic error and log the fixed reason once on the direct SDK caller thread");
}
int controlled_host(const char* dll_path,const char* directory_utf8,bool windows=false) {
  const HANDLE input=GetStdHandle(STD_INPUT_HANDLE); require(GetFileType(input)==FILE_TYPE_PIPE,"controlled host requires piped stdin");
  const auto length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,directory_utf8,-1,nullptr,0); require(length>1&&length<4096,"controlled host directory encoding");
  std::wstring directory(static_cast<std::size_t>(length),L'\0'); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,directory_utf8,-1,directory.data(),length); directory.resize(static_cast<std::size_t>(length-1));
  auto user=current_user(); OwnerSecurity security(user.sid); security.ensure_directory(directory);
  Host host; std::unique_ptr<OwnedWindow> owned; if(windows)owned=std::make_unique<OwnedWindow>();
  HMODULE module=LoadLibraryA(dll_path); require(module!=nullptr,"controlled official SDK DLL load");
  auto init=reinterpret_cast<decltype(&scs_telemetry_init)>(GetProcAddress(module,"scs_telemetry_init"));
  auto shutdown=reinterpret_cast<decltype(&scs_telemetry_shutdown)>(GetProcAddress(module,"scs_telemetry_shutdown"));
  using SetDirectory=int(*)(const wchar_t*); using GetEndpoint=int(*)(wchar_t*,unsigned);
  auto set_directory=reinterpret_cast<SetDirectory>(GetProcAddress(module,"ets2telemetry_test_directory")); auto get_endpoint=reinterpret_cast<GetEndpoint>(GetProcAddress(module,"ets2telemetry_test_endpoint"));
  bool initialized=false;
  try {
    require(init&&shutdown&&set_directory&&get_endpoint,"controlled test-only official lifecycle exports"); require(set_directory(directory.c_str())!=0,"controlled isolated directory"); auto p=host.params(); require(init(SCS_TELEMETRY_VERSION_1_01,&p)==SCS_RESULT_ok,"controlled SDK init"); initialized=true;
    host.event(SCS_TELEMETRY_EVENT_started); if(windows)host.event(SCS_TELEMETRY_EVENT_paused); host.frame(10);
    std::array<wchar_t,512> endpoint{}; require(until([&]{return get_endpoint(endpoint.data(),static_cast<unsigned>(endpoint.size()))!=0;}),"controlled endpoint publication");
    v0::Json ready{v0::Json::Object{{"ready",v0::Json{true}},{"fixture",v0::Json{std::string("fake-sdk-host")}}, {"processId",v0::Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime",v0::Json{std::to_string(creation_time(GetCurrentProcess()))}}, {"pipeName",v0::Json{utf8(endpoint.data())}}}};
    std::cout<<v0::detail::serialize(ready)<<'\n'<<std::flush;
    const auto deadline=GetTickCount64()+30000; std::string commands;bool exit=false;
    while(!exit&&GetTickCount64()<deadline) {DWORD available=0; if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)) {require(GetLastError()==ERROR_BROKEN_PIPE,"controlled stdin EOF");break;}
      if(available){std::array<char,256> command{};DWORD read=0;if(!ReadFile(input,command.data(),static_cast<DWORD>(command.size()),&read,nullptr)||!read)break;commands.append(command.data(),read);require(commands.size()<=1024,"controlled command bound");
        for(auto newline=commands.find('\n');newline!=std::string::npos;newline=commands.find('\n')) {auto action=commands.substr(0,newline);commands.erase(0,newline+1);if(!action.empty()&&action.back()=='\r')action.pop_back();
          if(action=="exit"){exit=true;break;} if(windows){
            if(action=="move")require(SetWindowPos(owned->handle,nullptr,-200,-100,800,600,SWP_NOACTIVATE|SWP_NOZORDER)!=FALSE,"controlled move");
            else if(action=="hide")ShowWindow(owned->handle,SW_HIDE);else if(action=="minimize")ShowWindow(owned->handle,SW_SHOWMINNOACTIVE);
            else if(action=="restore")ShowWindow(owned->handle,SW_SHOWNOACTIVATE);else if(action=="recreate")owned->recreate();
            else require(false,"unknown controlled window command");
            std::cout<<"{\"phase\":\""<<action<<"\"}\n"<<std::flush;
          }
        }
      }
      MSG msg{};while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
      if(!windows)host.frame(10); Sleep(windows?10:50);
    }
    const auto start=GetTickCount64(); shutdown(); initialized=false; require(GetTickCount64()-start<1000&&host.wrong_thread==0,"controlled normal join"); require(FreeLibrary(module)!=FALSE,"controlled DLL unload"); return 0;
  }catch(...){if(initialized&&shutdown)shutdown();FreeLibrary(module);throw;}
}
}
int main(int argc,char** argv) {
  try { if(argc==4&&(std::string(argv[1])=="host"||std::string(argv[1])=="host-window"))return controlled_host(argv[2],argv[3],std::string(argv[1])=="host-window");
    const std::map<std::string,std::function<void()>> cases{{"serialization",serialization},{"live",live_reconnect_security},{"rejection",rejection_and_timeout},{"collision",collision_and_discovery},{"coalescing",coalescing_and_stalled_shutdown},{"policy",policy_and_exhaustion},{"fuzz",seeded_transport_fuzz},{"window",window_binding}
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    ,{"accept-disconnect",accept_disconnect},{"accept-failure",accept_failure},{"hash-cancel",hash_cancel},{"hash-cancel-race",hash_cancel_race}
#endif
    };
    auto timed=[](const std::string& name,const std::function<void()>& fn){const auto start=GetTickCount64(); std::cout<<name<<'\n'<<std::flush; fn(); std::cout<<name<<" elapsedMs="<<GetTickCount64()-start<<'\n'<<std::flush;};
    if(argc==3&&std::string(argv[1])=="dll") timed("dll",[&]{dll_lifecycle(argv[2]);}); else if(argc==3&&std::string(argv[1])=="dll-report") timed("dll-report",[&]{dll_startup_reporting(argv[2]);}); else if(argc==2) timed(argv[1],cases.at(argv[1])); else for(const auto& entry:cases) timed(entry.first,entry.second);
    std::cout<<"Actual Windows snapshot transport: "<<assertions<<" assertions passed; second-user/remote/game checks pending\n"; return 0;
  }catch(const std::exception& e){std::cerr<<"Transport failure after "<<assertions<<" assertions: "<<e.what()<<'\n'; return 1;}
}
