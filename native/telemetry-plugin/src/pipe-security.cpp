#include "pipe-security.hpp"
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <array>
#include <stdexcept>
#include <algorithm>
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
#include <atomic>
#endif

namespace ets2telemetry::transport {
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
namespace { std::atomic<TransportTestHook> inspection_hook{nullptr}; }
void set_transport_test_hook(TransportTestHook hook) noexcept { inspection_hook.store(hook); }
DWORD transport_test_hook(const char* phase, HANDLE object, HANDLE stop, DWORD result) {
  auto hook = inspection_hook.load(); return hook ? hook(phase,object,stop,result) : result;
}
#endif
namespace {
[[noreturn]] void fail(const char* code) { throw std::runtime_error(code); }
std::wstring token_sid(HANDLE process, HANDLE stop_event = nullptr) {
  inspection_running(stop_event);
  HANDLE raw = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) fail("token-open"); Handle token(raw); inspection_running(stop_event);
  DWORD bytes = 0; inspection_running(stop_event); GetTokenInformation(token.get(), TokenUser, nullptr, 0, &bytes);
  inspection_running(stop_event);
  if (!bytes || bytes > 16384) fail("token-size"); std::vector<unsigned char> buffer(bytes);
  if (!GetTokenInformation(token.get(), TokenUser, buffer.data(), bytes, &bytes)) fail("token-user");
  inspection_running(stop_event);
  LPWSTR sid = nullptr; if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &sid)) fail("token-sid");
  std::wstring result(sid); LocalFree(sid); return result;
}
class Hash {
 public:
  Hash() {
    if (BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) fail("hash-provider");
    if (BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0) < 0) { BCryptCloseAlgorithmProvider(algorithm_, 0); algorithm_ = nullptr; fail("hash-create"); }
  }
  ~Hash() { if (hash_) BCryptDestroyHash(hash_); if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0); }
  void add(const void* p, std::size_t bytes) { if (bytes > UINT32_MAX || BCryptHashData(hash_, reinterpret_cast<PUCHAR>(const_cast<void*>(p)), static_cast<ULONG>(bytes), 0) < 0) fail("hash-input"); }
  std::string finish() { std::array<unsigned char, 32> bytes{}; if (BCryptFinishHash(hash_, bytes.data(), 32, 0) < 0) fail("hash-finish");
    std::string result; constexpr char hex[] = "0123456789abcdef"; for (auto b : bytes) { result += hex[b >> 4]; result += hex[b & 15]; } return result; }
 private: BCRYPT_ALG_HANDLE algorithm_ = nullptr; BCRYPT_HASH_HANDLE hash_ = nullptr;
};
}
void inspection_running(HANDLE stop_event) {
  if (!stop_event) return;
  const auto result = WaitForSingleObject(stop_event,0);
  if (result == WAIT_OBJECT_0) fail("inspection-stopped");
  if (result != WAIT_TIMEOUT) fail("inspection-stop-event");
}
std::string sha256_bytes(const void* p, std::size_t n) { Hash h; h.add(p,n); return h.finish(); }
std::wstring final_path(HANDLE h, HANDLE stop_event) {
  inspection_running(stop_event);
  std::wstring result(32768, L'\0'); auto length = GetFinalPathNameByHandleW(h, result.data(), static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  inspection_running(stop_event);
  if (!length || length >= result.size()) fail("final-path"); result.resize(length); return result;
}
std::string sha256_handle(HANDLE file, HANDLE stop_event) {
  inspection_running(stop_event);
  FILE_ATTRIBUTE_TAG_INFO attributes{}; LARGE_INTEGER size{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) || (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || !GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 512LL * 1024 * 1024) fail("image-file");
  inspection_running(stop_event);
  Hash hash; std::array<unsigned char, 65536> bytes{}; DWORD read = 0;
  do {
    inspection_running(stop_event);
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    transport_test_hook("hash-before-read",file,stop_event);
#endif
    inspection_running(stop_event);
    if (!ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) fail("image-read");
    inspection_running(stop_event);
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    transport_test_hook("hash-after-read",file,stop_event);
#endif
    inspection_running(stop_event);
    if (read) hash.add(bytes.data(),read);
#ifdef ETS2TELEMETRY_TRANSPORT_TEST_HOOKS
    if (read) transport_test_hook("hash-after-block",file,stop_event);
#endif
    inspection_running(stop_event);
  } while (read);
  inspection_running(stop_event);
  return hash.finish();
}
std::string sha256_file(const std::wstring& path, HANDLE stop_event) {
  inspection_running(stop_event);
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!file) fail("image-open"); inspection_running(stop_event); return sha256_handle(file.get(),stop_event);
}
std::uint64_t creation_time(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{}; if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) fail("process-time");
  return (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
PeerIdentity inspect_peer(DWORD pid, HANDLE stop_event) {
  inspection_running(stop_event);
  PeerIdentity peer; peer.pid = pid; peer.process.reset(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!peer.process || WaitForSingleObject(peer.process.get(),0) != WAIT_TIMEOUT) fail("process-open");
  inspection_running(stop_event); peer.creation = creation_time(peer.process.get());
  peer.sid = token_sid(peer.process.get(),stop_event); inspection_running(stop_event);
  if (!ProcessIdToSessionId(pid, &peer.session)) fail("process-session");
  inspection_running(stop_event);
  std::wstring path(32768,L'\0'); DWORD count = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(peer.process.get(),0,path.data(),&count)) fail("process-image"); path.resize(count);
  inspection_running(stop_event);
  peer.image_file.reset(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!peer.image_file) fail("process-image-open"); inspection_running(stop_event); peer.image = final_path(peer.image_file.get(),stop_event); peer.sha256 = sha256_handle(peer.image_file.get(),stop_event);
  inspection_running(stop_event);
  if (WaitForSingleObject(peer.process.get(),0) != WAIT_TIMEOUT || creation_time(peer.process.get()) != peer.creation) fail("process-retired"); return peer;
}
UserIdentity current_user() {
  UserIdentity result; result.sid = token_sid(GetCurrentProcess());
  std::string canonical; for (auto c : result.sid) { if (c > 127) fail("sid-ascii"); canonical += static_cast<char>(c); }
  result.tag = sha256_bytes(canonical.data(),canonical.size());
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &result.session)) fail("current-session"); return result;
}
PeerIdentity authenticate_client(HANDLE pipe, const UserIdentity& user, const AllowedPeer& allowed) {
  ULONG pid = 0; if (!GetNamedPipeClientProcessId(pipe,&pid) || !pid || (allowed.pid && pid != allowed.pid) || allowed.sha256.size() != 64 || allowed.image.empty()) fail("client-registration");
  auto peer = inspect_peer(pid);
  if ((allowed.creation && peer.creation != allowed.creation) || peer.sid != user.sid || peer.session != user.session || _wcsicmp(peer.image.c_str(),allowed.image.c_str()) || peer.sha256 != allowed.sha256) fail("client-provenance");
  return peer;
}
OwnerSecurity::OwnerSecurity(const std::wstring& sid) : sid_(sid) {
  const auto sddl = L"O:" + sid + L"D:P(A;;GA;;;" + sid + L")";
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor_, nullptr)) fail("owner-security");
  attributes_ = {sizeof(SECURITY_ATTRIBUTES), descriptor_, FALSE};
}
OwnerSecurity::~OwnerSecurity() { if (descriptor_) LocalFree(descriptor_); }
void OwnerSecurity::verify_owner_only(const std::wstring& path, HANDLE stop_event) const {
  inspection_running(stop_event);
  Handle file(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (!file) fail("owner-open"); inspection_running(stop_event); FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(file.get(),FileAttributeTagInfo,&attributes,sizeof(attributes)) || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail("owner-reparse");
  inspection_running(stop_event); verify_handle(file.get(),stop_event);
}
void OwnerSecurity::verify_handle(HANDLE file, HANDLE stop_event) const {
  inspection_running(stop_event);
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  if (GetSecurityInfo(file,SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&raw) != ERROR_SUCCESS) fail("owner-descriptor");
  bool valid = false; PSID expected = nullptr;
  if (ConvertStringSidToSidW(sid_.c_str(),&expected)) {
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    valid = owner && EqualSid(owner,expected) && acl && GetSecurityDescriptorControl(raw,&control,&revision) && (control & SE_DACL_PROTECTED) && acl->AceCount == 1;
    void* ace = nullptr;
    valid = valid && GetAce(acl,0,&ace) && reinterpret_cast<ACE_HEADER*>(ace)->AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(&reinterpret_cast<ACCESS_ALLOWED_ACE*>(ace)->SidStart,expected);
    LocalFree(expected);
  }
  LocalFree(raw); inspection_running(stop_event); if (!valid) fail("owner-dacl");
}
void OwnerSecurity::ensure_directory(const std::wstring& path) const {
  if (!CreateDirectoryW(path.c_str(),const_cast<SECURITY_ATTRIBUTES*>(&attributes_)) && GetLastError() != ERROR_ALREADY_EXISTS) fail("owner-directory"); verify_owner_only(path);
}
std::wstring local_transport_directory(const OwnerSecurity& security) {
  PWSTR raw = nullptr; if (SHGetKnownFolderPath(FOLDERID_LocalAppData,KF_FLAG_DEFAULT,nullptr,&raw) != S_OK) fail("local-appdata");
  std::wstring path(raw); CoTaskMemFree(raw);
  // Existing application root has historical default ACLs; only the dedicated transport subtree is authority.
  path += L"\\ETS2Telemetry"; if (!CreateDirectoryW(path.c_str(),nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) fail("application-directory");
  if (GetFileAttributesW(path.c_str()) & FILE_ATTRIBUTE_REPARSE_POINT) fail("application-reparse");
  path += L"\\transport"; security.ensure_directory(path); path += L"\\v0"; security.ensure_directory(path); return path;
}
}
