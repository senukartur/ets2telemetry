#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include "protocol-json.hpp"
#include "protocol-v1.hpp"
#include "capture-hello.hpp"
#include "channel-identity.hpp"
#include <algorithm>
#include <filesystem>
#include <memory>
#include <optional>
#include <regex>
#include <thread>
#include <atomic>
#include <cstring>

namespace v0 = ets2telemetry::v0;
namespace v1 = ets2telemetry::v1;
namespace channel = ets2telemetry::channel;
using v0::Json;
namespace fs = std::filesystem;
#ifdef ETS2TELEMETRY_CLIENT_DISCOVERY_TEST
void discovery_before_open(const fs::path& filename);
#endif
void test_trace(const char* value) {
#ifdef ETS2TELEMETRY_CLIENT_ASAN_DIAGNOSTICS
  const auto text = std::string(value) + ":" + std::to_string(GetTickCount64()) + "\n"; DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
#else
  (void)value;
#endif
}
// Last Win32 error observed by the failing check; the exit diagnostic reports it only as a number.
DWORD failureError = ERROR_SUCCESS;
struct Disconnected : std::runtime_error {explicit Disconnected(DWORD error = GetLastError()) : std::runtime_error("Source disconnected") {failureError = error;}};
// Contention on a project-owned file before any authority receipt. It grants nothing; a retry re-verifies everything.
struct Busy : std::runtime_error {explicit Busy(DWORD error) : std::runtime_error("Owned local file busy") {failureError = error;}};
[[noreturn]] void fail() {failureError = GetLastError(); throw std::runtime_error("Verified pipe client rejected source or transport");}
[[noreturn]] void busy_or_fail(DWORD error, std::initializer_list<DWORD> retryable) {
  if (std::find(retryable.begin(), retryable.end(), error) != retryable.end()) throw Busy(error);
  SetLastError(error); fail();
}
[[noreturn]] void process_query_failed(HANDLE process) {
  // Access/security failures stay hard rejections, even if the process exits concurrently.
  const auto error = GetLastError();
  if ((error == ERROR_INVALID_PARAMETER || error == ERROR_PROCESS_ABORTED || error == ERROR_NO_TOKEN) && WaitForSingleObject(process, 0) == WAIT_OBJECT_0) throw Disconnected(error);
  SetLastError(error); fail();
}
[[noreturn]] void pipe_failed(DWORD error) {
  if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA) throw Disconnected(error);
  SetLastError(error); fail();
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {if (h == INVALID_HANDLE_VALUE || h == nullptr) fail();}
  Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete;
  Handle(Handle&& h) noexcept : value(h.value) {h.value = INVALID_HANDLE_VALUE;}
  ~Handle() {if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value);}
};
std::wstring wide(const std::string& text) {
  const auto n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!n) fail(); std::wstring result(static_cast<std::size_t>(n), L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n)) fail(); return result;
}
std::string utf8(const std::wstring& text) {
  const auto n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!n) fail(); std::string result(static_cast<std::size_t>(n), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n, nullptr, nullptr)) fail(); return result;
}
std::string sha256(const std::vector<unsigned char>& bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) fail();
  DWORD size = 0, written = 0; if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &written, 0) < 0) {BCryptCloseAlgorithmProvider(algorithm, 0); fail();}
  std::vector<unsigned char> object(size), digest(32);
  auto status = BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0);
  if (status >= 0) status = BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0);
  if (status >= 0) status = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
  if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); if (status < 0) fail();
  const char* digits = "0123456789abcdef"; std::string result;
  for (auto b : digest) {result += digits[b >> 4]; result += digits[b & 15];} return result;
}
struct Identity {
  std::vector<unsigned char> tokenUser; std::string sid, userTag; DWORD session = 0;
  explicit Identity(HANDLE process) {
    HANDLE raw = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) process_query_failed(process); Handle token(raw);
    DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); if (!size || size > 16384) fail();
    tokenUser.resize(size); if (!GetTokenInformation(token.value, TokenUser, tokenUser.data(), size, &size)) fail();
    auto user = reinterpret_cast<TOKEN_USER*>(tokenUser.data()); LPWSTR text = nullptr;
    if (!ConvertSidToStringSidW(user->User.Sid, &text)) fail(); sid = utf8(text); LocalFree(text);
    if (!GetTokenInformation(token.value, TokenSessionId, &session, sizeof(session), &size)) fail();
    userTag = sha256(std::vector<unsigned char>(sid.begin(), sid.end()));
  }
  PSID user() const {return reinterpret_cast<const TOKEN_USER*>(tokenUser.data())->User.Sid;}
};
std::uint64_t filetime_u64(const FILETIME& time) {
  return (static_cast<std::uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}
std::uint64_t creation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{}; if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) process_query_failed(process);
  return filetime_u64(created);
}
bool stale_process(HANDLE process, std::uint64_t expectedCreation) {
  const auto waited = WaitForSingleObject(process, 0);
  if (waited == WAIT_FAILED) fail();
  if (waited == WAIT_OBJECT_0) return true;
  if (waited != WAIT_TIMEOUT) fail();
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) fail();
  return filetime_u64(created) != expectedCreation;
}
std::wstring final_path(HANDLE file) {
  std::wstring result(32768, L'\0'); const auto n = GetFinalPathNameByHandleW(file, result.data(), static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!n || n >= result.size()) fail(); result.resize(n); return result;
}
void protected_owner(HANDLE file, const Identity& identity) {
  PSECURITY_DESCRIPTOR descriptor = nullptr; PSID owner = nullptr; PACL dacl = nullptr;
  if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) fail();
  bool valid = owner && EqualSid(owner, identity.user()) && dacl && dacl->AceCount == 1;
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  valid = valid && GetSecurityDescriptorControl(descriptor, &control, &revision) && (control & SE_DACL_PROTECTED);
  void* ace = nullptr;
  if (valid && GetAce(dacl, 0, &ace)) {
    auto allow = reinterpret_cast<ACCESS_ALLOWED_ACE*>(ace);
    valid = allow->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && !(allow->Header.AceFlags & INHERITED_ACE) && EqualSid(&allow->SidStart, identity.user()) && (allow->Mask == FILE_ALL_ACCESS || allow->Mask == GENERIC_ALL);
  } else valid = false;
  LocalFree(descriptor); if (!valid) fail();
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail();
}
struct OwnerSecurity {
  PSECURITY_DESCRIPTOR descriptor = nullptr; SECURITY_ATTRIBUTES attributes{};
  explicit OwnerSecurity(const Identity& identity) {
    const auto sddl = L"O:" + wide(identity.sid) + L"D:P(A;;GA;;;" + wide(identity.sid) + L")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) fail();
    attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  }
  ~OwnerSecurity() {LocalFree(descriptor);}
};
Handle secure_file(const fs::path& filename, const Identity& identity, bool directory = false, bool discovery = false) {
  Handle file(CreateFileW(filename.c_str(), GENERIC_READ | READ_CONTROL, discovery || directory ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE : FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
  protected_owner(file.value, identity); return file;
}
std::optional<Handle> enumerated_discovery_file(const fs::path& filename, const Identity& identity) {
  const auto raw = CreateFileW(filename.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (raw == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    // Only an enumerated record's confirmed retirement is skippable; security and lookup uncertainty stay hard.
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_DELETE_PENDING) return std::nullopt;
    fail();
  }
  Handle file(raw); protected_owner(file.value, identity); return std::optional<Handle>(std::move(file));
}
bool same_file(HANDLE first, HANDLE second) {
  BY_HANDLE_FILE_INFORMATION a{}, b{};
  if (!GetFileInformationByHandle(first, &a) || !GetFileInformationByHandle(second, &b)) return false;
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}
bool sweep_stale_record(const fs::path& path, std::optional<Handle>& verifiedFile, const Identity& self) {
  if (!verifiedFile) fail();
  const auto raw = CreateFileW(path.c_str(), DELETE | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (raw == INVALID_HANDLE_VALUE) {
    const auto error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_DELETE_PENDING) return true;
    if (error == ERROR_SHARING_VIOLATION) return false;
    SetLastError(error); fail();
  }
  Handle deleter(raw);
  protected_owner(deleter.value, self);
  if (!same_file(verifiedFile->value, deleter.value)) fail();
  verifiedFile.reset();
  FILE_DISPOSITION_INFO remove{TRUE};
  if (!SetFileInformationByHandle(deleter.value, FileDispositionInfo, &remove, sizeof(remove))) fail();
  return true;
}
bool is_reused_or_gone_on_access_denied(DWORD pid, std::uint64_t expectedCreation, const std::string& endpoint, const fs::path& path, std::optional<Handle>& file, const Identity& self) {
  const auto rawLimited = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (rawLimited) {
    Handle limited(rawLimited);
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(limited.value, &created, &exited, &kernel, &user)) fail();
    if (filetime_u64(created) == expectedCreation && filetime_u64(exited) == 0) return false;
  } else {
    const auto limitedError = GetLastError();
    if (limitedError == ERROR_INVALID_PARAMETER) {
      sweep_stale_record(path, file, self);
      return true;
    }
    if (limitedError != ERROR_ACCESS_DENIED) {
      SetLastError(limitedError);
      fail();
    }
  }
  if (WaitNamedPipeW(wide(endpoint).c_str(), 0) || GetLastError() != ERROR_FILE_NOT_FOUND) return false;
  return sweep_stale_record(path, file, self);
}
std::string read_bounded(HANDLE file, DWORD bound) {
  LARGE_INTEGER size{}; if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > bound) fail();
  std::string bytes(static_cast<std::size_t>(size.QuadPart), '\0'); DWORD read = 0;
  if (!ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size()) fail(); return bytes;
}
void exact(const Json& object, std::initializer_list<const char*> fields) {
  const auto* value = std::get_if<Json::Object>(&object.value); if (!value || value->size() != fields.size()) fail(); for (auto field : fields) object.at(field);
}
DWORD integer(const Json& value) {auto n = value.number(); if (n < 0 || n > MAXDWORD || std::floor(n) != n) fail(); return static_cast<DWORD>(n);}
bool uuid(const std::string& text) {return std::regex_match(text, std::regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));}
Json parse(const std::string& text) {return v0::detail::Parser(text).parse();}
Handle image(HANDLE process) {
  std::wstring name(32768, L'\0'); DWORD length = static_cast<DWORD>(name.size());
  if (!QueryFullProcessImageNameW(process, 0, name.data(), &length)) process_query_failed(process); name.resize(length);
  const auto raw = CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  // Another writer or deleter holding the image is contention, not authority; access and lookup failures stay hard.
  if (raw == INVALID_HANDLE_VALUE) busy_or_fail(GetLastError(), {ERROR_SHARING_VIOLATION});
  Handle file(raw);
  FILE_ATTRIBUTE_TAG_INFO attributes{}; if (!GetFileInformationByHandleEx(file.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail(); return file;
}
void reject_reparse_ancestors(fs::path directory) {
  while (!directory.empty()) {
    Handle held(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    FILE_ATTRIBUTE_TAG_INFO attributes{}; if (!GetFileInformationByHandleEx(held.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail();
    auto parent = directory.parent_path(); if (parent == directory) break; directory = parent;
  }
}
bool provably_missing_image(const std::string& path) {
  if (path.size() < 7 || path[5] != ':' || path[6] != '\\' || !((path[4] >= 'A' && path[4] <= 'Z') || (path[4] >= 'a' && path[4] <= 'z'))) return false;
  const fs::path filename(wide(path));
  HANDLE raw = CreateFileW(filename.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (raw != INVALID_HANDLE_VALUE) {Handle existing(raw); return false;}
  const auto error = GetLastError(); if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return false;
  // A missing leaf through a reparse or inaccessible ancestor is not proof of retirement.
  const auto volumeRoot = wide(path.substr(0, 7));
  auto ancestor = filename.parent_path(); bool rootVerified = false;
  while (!ancestor.empty()) {
    if (_wcsicmp(ancestor.c_str(), wide(path.substr(0, 6)).c_str()) == 0) ancestor = fs::path(volumeRoot);
    raw = CreateFileW(ancestor.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (raw != INVALID_HANDLE_VALUE) {
      Handle held(raw); FILE_ATTRIBUTE_TAG_INFO attributes{};
      if (!GetFileInformationByHandleEx(held.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return false;
      if (_wcsicmp(ancestor.c_str(), volumeRoot.c_str()) == 0) {rootVerified = true; break;}
    } else {const auto ancestorError = GetLastError(); if (ancestorError != ERROR_FILE_NOT_FOUND && ancestorError != ERROR_PATH_NOT_FOUND) return false;}
    const auto parent = ancestor.parent_path(); if (parent == ancestor) break; ancestor = parent;
  }
  return rootVerified;
}
// Fixed stage names and coarse millisecond timings are the only broker diagnostics: no paths, identities or peer bytes.
struct Stage {
  const char* name = "arguments"; const char* slowest = "arguments";
  ULONGLONG started = GetTickCount64(), entered = started, slowestMs = 0; bool timing = true;
  void account() {if (!timing) return; const auto spent = GetTickCount64() - entered; if (spent > slowestMs) {slowest = name; slowestMs = spent;}}
  Stage& operator=(const char* next) {
    account();
    // Relay waits follow the source's pacing; only startup and handshake stages are timed.
    if (std::strcmp(next, "relay") == 0) timing = false;
    name = next; entered = GetTickCount64(); return *this;
  }
  operator const char*() const {return name;}
};
int finish(int code, Stage& stage) {
  stage.account(); stage.timing = false;
  const auto text = "diag1 " + std::string(stage.name) + " " + std::to_string(failureError) + " " + std::to_string(GetTickCount64() - stage.started) + " " + stage.slowest + " " + std::to_string(stage.slowestMs) + "\n";
  DWORD written = 0; WriteFile(GetStdHandle(STD_ERROR_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr); return code;
}
void bootstrap_policy(const fs::path& directory, const Identity& identity, HANDLE ownImage, Stage& stage) {
  OwnerSecurity lockSecurity(identity);
  const auto rawLock = CreateFileW((directory / "service-policy.lock").c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, &lockSecurity.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
  // A live holder reports FILE_EXISTS; a released lock still open elsewhere is delete-pending and reports ACCESS_DENIED
  // in this already verified owner-only directory. Either way this attempt fails closed without publishing.
  if (rawLock == INVALID_HANDLE_VALUE) busy_or_fail(GetLastError(), {ERROR_FILE_EXISTS, ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION});
  Handle policyLock(rawLock);
  protected_owner(policyLock.value, identity);
  stage = "policy-image";
  test_trace(stage);
  const auto ownPath = utf8(final_path(ownImage)); LARGE_INTEGER zero{}; SetFilePointerEx(ownImage, zero, nullptr, FILE_BEGIN);
  const auto bytes = read_bounded(ownImage, 64 * 1024 * 1024); const auto hash = sha256(std::vector<unsigned char>(bytes.begin(), bytes.end()));
  stage = "policy-existing"; const auto policyPath = directory / "service-policy.json";
  test_trace(stage);
  Json::Array entries; std::string existing;
  if (fs::exists(policyPath)) {
    auto handle = secure_file(policyPath, identity); existing = read_bounded(handle.value, 16384); const auto policy = parse(existing);
    exact(policy, {"schemaVersion", "userTag", "windowsSessionId", "allowedExecutables"});
    if (integer(policy.at("schemaVersion")) != 1 || policy.at("userTag").string() != identity.userTag || integer(policy.at("windowsSessionId")) != identity.session) fail();
    const auto* list = std::get_if<Json::Array>(&policy.at("allowedExecutables").value); if (!list || list->empty() || list->size() > 4) fail();
    bool found = false; std::vector<std::string> paths;
    for (const auto& entry : *list) {
      exact(entry, {"path", "sha256"}); const auto& p = entry.at("path").string(); const auto& h = entry.at("sha256").string();
      if (p.size() > 32768 || p.rfind("\\\\?\\", 0) != 0 || !std::regex_match(h, std::regex("[0-9a-f]{64}")) || std::any_of(paths.begin(), paths.end(), [&](const auto& prior) {return _wcsicmp(wide(prior).c_str(), wide(p).c_str()) == 0;})) fail(); paths.push_back(p);
      if (_wcsicmp(wide(p).c_str(), wide(ownPath).c_str()) == 0) {entries.push_back(Json{Json::Object{{"path", Json{ownPath}}, {"sha256", Json{hash}}}}); found = true;}
      else if (!provably_missing_image(p)) entries.push_back(entry);
    }
    if (!found) {if (entries.size() == 4) fail(); entries.push_back(Json{Json::Object{{"path", Json{ownPath}}, {"sha256", Json{hash}}}});}
  } else entries.push_back(Json{Json::Object{{"path", Json{ownPath}}, {"sha256", Json{hash}}}});
  stage = "policy-json"; const auto policy = Json{Json::Object{{"schemaVersion", Json{1.0}}, {"userTag", Json{identity.userTag}}, {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"allowedExecutables", Json{entries}}}};
  test_trace(stage);
  const auto encoded = v0::detail::serialize(policy); if (encoded.size() > 16384) fail();
  // An identical policy is not replaced: each replacement races readers such as the plugin's per-connection check.
  if (encoded == existing) {stage = "policy-current"; test_trace(stage); return;}
  stage = "policy-write"; OwnerSecurity security(identity); const auto temporary = directory / ("policy-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(creation(GetCurrentProcess())) + ".tmp");
  {
    Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE | READ_CONTROL, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)); protected_owner(file.value, identity);
    DWORD written = 0; if (!WriteFile(file.value, encoded.data(), static_cast<DWORD>(encoded.size()), &written, nullptr) || written != encoded.size() || !FlushFileBuffers(file.value)) {DeleteFileW(temporary.c_str()); fail();}
  }
  stage = "policy-publish";
  if (!MoveFileExW(temporary.c_str(), policyPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    // Replacing the verified owner-only policy while any reader holds it open reports ACCESS_DENIED.
    const auto error = GetLastError(); DeleteFileW(temporary.c_str());
    // A read-only policy also reports ACCESS_DENIED but never clears by itself; keep it a visible hard failure.
    const auto attributes = GetFileAttributesW(policyPath.c_str());
    if (error == ERROR_ACCESS_DENIED && attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_READONLY)) {SetLastError(error); fail();}
    busy_or_fail(error, {ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION});
  }
  test_trace(stage);
}
// Anonymous stdio uses synchronous handles. Cancel the owned blocked thread, then join actual completion.
void stdio_io(HANDLE handle, void* buffer, DWORD size, bool write, DWORD timeoutMs = 5000) {
  Handle done(CreateEventW(nullptr, TRUE, FALSE, nullptr)); bool ok = false;
  DWORD error = ERROR_SUCCESS;
  std::thread worker([&] {DWORD transferred = 0; while (transferred < size) {DWORD count = 0; const bool success = write ? WriteFile(handle, static_cast<char*>(buffer) + transferred, size - transferred, &count, nullptr) : ReadFile(handle, static_cast<char*>(buffer) + transferred, size - transferred, &count, nullptr); if (!success || !count) {error = success ? ERROR_BROKEN_PIPE : GetLastError(); break;} transferred += count;} ok = transferred == size; SetEvent(done.value);});
  const auto waited = WaitForSingleObject(done.value, timeoutMs);
  if (waited != WAIT_OBJECT_0) {
    do {CancelSynchronousIo(worker.native_handle());} while (WaitForSingleObject(done.value, 25) == WAIT_TIMEOUT);
  }
  worker.join(); if (waited == WAIT_TIMEOUT) throw Disconnected(); if (waited != WAIT_OBJECT_0) fail(); if (!ok) pipe_failed(error);
}
// How a protocol v1 client frame ended the relay: rejected before it reached the pipe, or a write that disconnected or
// failed. v0 and CAP0 control streams never set it.
enum class ClientFailure {none, frame, disconnected, failed};
struct Credits {
  Handle ready{CreateSemaphoreW(nullptr, 0, 1, nullptr)}, cancelled{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  // Protocol v1 only: `helloSent` orders client frames after the hello on the pipe, and `stop` ends a pending client write.
  Handle helloSent{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::atomic<bool> stopping{false}, rejected{false}; std::atomic<ClientFailure> client{ClientFailure::none}; std::atomic<DWORD> clientError{ERROR_SUCCESS};
  // Protocol v1 only (ET-050b B1): the highest minor a client frame may carry, min(hello maxMinor, the contract's highest minor). The broker does not
  // parse the welcome, so it bounds client frames by the offer and requires one minor for every relayed frame; the
  // plugin then refuses any frame whose minor is not the connection's. Declared before the reader, which reads it.
  const unsigned maxMinor;
  std::thread reader;
  // Without a pipe the control stream is v0/CAP0 credit bytes; with one it is the protocol v1 tagged stream.
  explicit Credits(HANDLE pipe = nullptr, HANDLE process = nullptr, unsigned max_minor = 0) : maxMinor(max_minor), reader([this, pipe, process] {
    if (pipe) tagged(pipe, process); else credit_bytes();
    SetEvent(cancelled.value); SetEvent(done.value);
  }) {}
  void credit_bytes() {
    while (!stopping) {
      unsigned char credit = 0; DWORD read = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &credit, 1, &read, nullptr) || read != 1) break;
      if (credit != 1 || !ReleaseSemaphore(ready.value, 1, nullptr)) {rejected = true; break;}
    }
  }
  void tagged(HANDLE pipe, HANDLE process);
  // The reader, and with it any client write, is joined before the owner closes the pipe and process handles.
  ~Credits() {
    stopping = true; SetEvent(stop.value);
    while (WaitForSingleObject(done.value, 0) == WAIT_TIMEOUT) {CancelSynchronousIo(reader.native_handle()); WaitForSingleObject(done.value, 25);}
    reader.join();
  }
  void take(HANDLE process) {
    HANDLE waits[] = {ready.value, process, cancelled.value};
    const auto waited = WaitForMultipleObjects(3, waits, FALSE, 5000);
    if (rejected) fail();
    if (waited == WAIT_TIMEOUT || waited == WAIT_OBJECT_0 + 1 || waited == WAIT_OBJECT_0 + 2 || WaitForSingleObject(cancelled.value, 0) == WAIT_OBJECT_0) throw Disconnected();
    if (waited != WAIT_OBJECT_0) fail();
  }
};
void pipe_io(HANDLE pipe, HANDLE process, void* buffer, DWORD size, bool write, HANDLE cancelled = nullptr, bool awaitFrame = false) {
  auto deadline = GetTickCount64() + 5000; DWORD transferred = 0;
  while (transferred < size) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED operation{}; operation.hEvent = event.value;
    DWORD count = 0; bool ok = write ? WriteFile(pipe, static_cast<char*>(buffer) + transferred, size - transferred, &count, &operation) : ReadFile(pipe, static_cast<char*>(buffer) + transferred, size - transferred, &count, &operation);
    auto error = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && error == ERROR_IO_PENDING) {
      HANDLE waits[] = {event.value, process, cancelled}; const auto remaining = deadline > GetTickCount64() ? deadline - GetTickCount64() : 0;
      const auto waited = WaitForMultipleObjects(cancelled ? 3 : 2, waits, FALSE, awaitFrame && !transferred ? INFINITE : static_cast<DWORD>(remaining));
      if (waited != WAIT_OBJECT_0) {
        CancelIoEx(pipe, &operation); GetOverlappedResult(pipe, &operation, &count, TRUE);
        if (waited == WAIT_TIMEOUT || waited == WAIT_OBJECT_0 + 1 || (cancelled && waited == WAIT_OBJECT_0 + 2)) throw Disconnected();
        fail();
      }
      ok = GetOverlappedResult(pipe, &operation, &count, FALSE) != 0;
      error = ok ? ERROR_SUCCESS : GetLastError();
    }
    if (!ok) pipe_failed(error); if (!count) throw Disconnected();
    if (awaitFrame && !transferred) deadline = GetTickCount64() + 5000;
    transferred += count;
  }
}
DWORD frame_length(const unsigned char* prefix) {return static_cast<DWORD>(prefix[0]) | (static_cast<DWORD>(prefix[1]) << 8) | (static_cast<DWORD>(prefix[2]) << 16) | (static_cast<DWORD>(prefix[3]) << 24);}
// Reads exactly `size` control bytes; false on EOF, cancellation or a read error.
bool read_control(unsigned char* buffer, DWORD size) {
  DWORD transferred = 0;
  while (transferred < size) {DWORD count = 0; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer + transferred, size - transferred, &count, nullptr) || !count) return false; transferred += count;}
  return true;
}
// Writes one protocol v1 client frame on the reader thread with its own OVERLAPPED, beside the relay's pending read,
// under a 5 s deadline. A write that is not complete is cancelled and its completion observed before the frame buffer
// is released. Errors are returned, not thrown: the relay thread reports them.
ClientFailure client_write(HANDLE pipe, HANDLE process, HANDLE stop, const unsigned char* data, DWORD size, DWORD& error) {
  const auto deadline = GetTickCount64() + 5000; DWORD transferred = 0;
  while (transferred < size) {
    Handle event; event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); if (!event.value) {error = GetLastError(); return ClientFailure::failed;}
    OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
    bool ok = WriteFile(pipe, data + transferred, size - transferred, &count, &operation) != 0;
    error = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && error == ERROR_IO_PENDING) {
      HANDLE waits[] = {event.value, process, stop}; const auto now = GetTickCount64();
      const auto waited = WaitForMultipleObjects(3, waits, FALSE, deadline > now ? static_cast<DWORD>(deadline - now) : 0);
      if (waited != WAIT_OBJECT_0) {
        // A failed wait reports its own error, captured before the cancellation changes the last error.
        const auto waitError = waited == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
        CancelIoEx(pipe, &operation); GetOverlappedResult(pipe, &operation, &count, TRUE); error = waited == WAIT_FAILED ? waitError : GetLastError();
        return waited == WAIT_TIMEOUT || waited == WAIT_OBJECT_0 + 1 || waited == WAIT_OBJECT_0 + 2 ? ClientFailure::disconnected : ClientFailure::failed;
      }
      ok = GetOverlappedResult(pipe, &operation, &count, FALSE) != 0;
      error = ok ? ERROR_SUCCESS : GetLastError();
    }
    if (!ok) return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA ? ClientFailure::disconnected : ClientFailure::failed;
    if (!count) {error = GetLastError(); return ClientFailure::disconnected;}
    transferred += count;
  }
  return ClientFailure::none;
}
// Protocol v1 control stream: tagged records. 0x01 is one relay credit. 0x02, a u32 little-endian length of
// 1-4,096 and that many bytes are exactly one v1 client frame of kind ack or clock.probe; it is validated at most at
// the hello's offered minor, must carry the same minor as every earlier relayed frame, then is written to the pipe after
// the hello, in stdin order. Any other tag, length, minor or message ends the relay.
void Credits::tagged(HANDLE pipe, HANDLE process) {
  try {
    std::optional<unsigned> relayedMinor;
    while (!stopping) {
      unsigned char tag = 0; if (!read_control(&tag, 1)) return;
      if (tag == 1) {if (!ReleaseSemaphore(ready.value, 1, nullptr)) {rejected = true; return;} continue;}
      if (tag != 2) {rejected = true; return;}
      std::vector<unsigned char> frame(4); if (!read_control(frame.data(), 4)) return;
      const auto length = frame_length(frame.data());
      if (!length || length > v1::limits.client_frame_bytes) {client = ClientFailure::frame; return;}
      frame.resize(length + 4); if (!read_control(frame.data() + 4, length)) return;
      const auto message = v1::decode_payload(std::string(reinterpret_cast<const char*>(frame.data() + 4), length), v1::Sender::client, maxMinor);
      if ((message.kind != "ack" && message.kind != "clock.probe") || (relayedMinor && *relayedMinor != message.minor)) {client = ClientFailure::frame; return;}
      relayedMinor = message.minor;
      // Both events can be set at once, and the wait then reports helloSent: a stop is checked again before writing.
      HANDLE waits[] = {helloSent.value, stop.value}; if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0 || WaitForSingleObject(stop.value, 0) == WAIT_OBJECT_0) return;
      DWORD error = ERROR_SUCCESS; const auto result = client_write(pipe, process, stop.value, frame.data(), static_cast<DWORD>(frame.size()), error);
      if (result != ClientFailure::none) {clientError = error; client = result; return;}
    }
  } catch (...) {client = ClientFailure::frame;}
}
void receipt(const Json& value) {
  auto text = v0::detail::serialize(value); if (text.empty() || text.size() > 4096) fail(); const auto n = static_cast<DWORD>(text.size());
  unsigned char prefix[] = {static_cast<unsigned char>(n), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 24)};
  stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), prefix, 4, true); stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), n, true);
}
Json source_identity(const Json& record) {
  return Json{Json::Object{{"game", record.at("game")}, {"origin", Json{std::string("game")}}, {"processId", record.at("processId")},
    {"windowsSessionId", record.at("windowsSessionId")}, {"processInstanceId", record.at("processInstanceId")}, {"pluginSessionId", record.at("pluginSessionId")}}};
}
Json discovery_result(const std::optional<Json>& record, unsigned count) {
  Json::Object result{{"status", Json{std::string(count == 0 ? "absent" : count == 1 ? "unique" : "ambiguous")}}};
  if (count == 1) result["target"] = Json{Json::Object{{"source", source_identity(*record)}, {"processCreationTime", record->at("processCreationTime")}, {"userTag", record->at("userTag")}}};
  return Json{result};
}
int wmain(int argc, wchar_t** argv) {
  test_trace("entry");
  Stage stage;
  try {
    const bool discover = (argc == 4 || argc == 6) && std::wstring(argv[1]) == L"--discover" && std::wstring(argv[2]) == L"--discovery-dir";
    const bool discoverV1 = discover && argc == 6 && std::wstring(argv[4]) == L"--protocol" && std::wstring(argv[5]) == L"v1";
    if (discover && argc == 6 && !discoverV1) fail();
    // CAP0 evidence capture is a separate explicit mode: distinct endpoint, receipt marker and hello.
    const bool capture = argc == 7 && std::wstring(argv[5]) == L"--capture" && std::wstring(argv[6]) == L"cap0";
    // Protocol v1 is another explicit mode, never combined with capture: v1 discovery records and endpoint, a marked
    // receipt, a v1 hello and a tagged control stream that also carries client frames.
    const bool protocolV1 = discoverV1 || (argc == 7 && std::wstring(argv[5]) == L"--protocol" && std::wstring(argv[6]) == L"v1");
    if (!discover && ((argc != 5 && !capture && !protocolV1) || std::wstring(argv[1]) != L"--game" || std::wstring(argv[3]) != L"--discovery-dir")) fail();
    const DWORD protocolMajor = protocolV1 ? 1 : 0; const std::string segment = protocolV1 ? "-v1-" : "-v0-";
    const auto game = discover ? std::string() : utf8(argv[2]); if (!discover && game != "ets2" && game != "ats") fail();
    stage = "identity"; test_trace("current-identity-start"); Identity self(GetCurrentProcess()); test_trace("current-identity-done");
    stage = "directory"; const fs::path directory(argv[discover ? 3 : 4]); if (!directory.is_absolute()) fail();
    std::optional<Json> ets2Record, atsRecord; unsigned ets2Count = 0, atsCount = 0;
    auto discovered = [&] {receipt(Json{Json::Object{{"type", Json{std::string("discovery")}}, {"schemaVersion", Json{1.0}}, {"protocolMajor", Json{static_cast<double>(protocolMajor)}},
      {"games", Json{Json::Object{{"ets2", discovery_result(ets2Record, ets2Count)}, {"ats", discovery_result(atsRecord, atsCount)}}}}}});};
    if (!fs::exists(directory) && discover) {discovered(); return finish(0, stage);}
    if (!fs::exists(directory)) {receipt(Json{Json::Object{{"type", Json{std::string("waiting")}}, {"schemaVersion", Json{1.0}}}}); return finish(2, stage);}
    reject_reparse_ancestors(directory);
    // The two owned transport directories must both remain protected and free of reparses.
    auto parent = secure_file(directory.parent_path(), self, true); auto owned = secure_file(directory, self, true);
    stage = "own-image"; auto ownImage = image(GetCurrentProcess()); stage = "policy-lock"; bootstrap_policy(directory, self, ownImage.value, stage);
    stage = "discovery"; test_trace(stage); std::optional<Json> selected; std::optional<Handle> selectedProcess; unsigned records = 0, visited = 0;
    for (const auto& entry : fs::directory_iterator(directory)) {
      const auto stem = utf8(entry.path().stem().wstring());
      if (!uuid(stem) || entry.path().extension() != L".json") {if (++visited > 256) fail(); continue;}
#ifdef ETS2TELEMETRY_CLIENT_DISCOVERY_TEST
      discovery_before_open(entry.path());
#endif
      auto file = enumerated_discovery_file(entry.path(), self); if (!file) continue;
      auto record = parse(read_bounded(file->value, 16384));
      exact(record, {"schemaVersion", "protocolMajor", "game", "userTag", "windowsSessionId", "processId", "processCreationTime", "processInstanceId", "pluginSessionId", "pipeName"});
      if (integer(record.at("schemaVersion")) != 1 || integer(record.at("protocolMajor")) != protocolMajor || record.at("userTag").string() != self.userTag || integer(record.at("windowsSessionId")) != self.session || record.at("processInstanceId").string() != stem || !uuid(record.at("pluginSessionId").string())) fail();
      const auto& recordGame = record.at("game").string();
      if (recordGame != "ets2" && recordGame != "ats") fail();
      const auto pid = integer(record.at("processId")); if (!pid) fail();
      const auto expectedCreation = v0::parse_uint64(record.at("processCreationTime"));
      // Only names under this build channel's prefix (ET-055) are accepted: a record naming another prefix, such as the
      // other channel's, fails closed like any inconsistent derived name.
      const auto endpoint = channel::active.pipe_prefix + recordGame + segment + self.userTag + "-" + std::to_string(self.session) + "-" + stem;
      if (record.at("pipeName").string() != endpoint) fail();
      stage = "server-process";
      const auto raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (!raw) {
        const auto openError = GetLastError();
        if (openError == ERROR_INVALID_PARAMETER) {sweep_stale_record(entry.path(), file, self); stage = "discovery"; continue;}
        if (openError == ERROR_ACCESS_DENIED && is_reused_or_gone_on_access_denied(pid, expectedCreation, endpoint, entry.path(), file, self)) {stage = "discovery"; continue;}
        SetLastError(openError); fail();
      }
      std::optional<Handle> candidate(std::in_place, raw);
      if (stale_process(candidate->value, expectedCreation)) {candidate.reset(); sweep_stale_record(entry.path(), file, self); stage = "discovery"; continue;}
      file.reset();
      stage = "discovery";
      if (++visited > 256 || ++records > 128) fail();
      if (!discover && recordGame != game) continue;
      stage = "server-process";
      Identity server(candidate->value); if (server.sid != self.sid || server.session != self.session) fail();
      stage = "server-image"; auto serverImage = image(candidate->value); const auto expectedName = recordGame == "ets2" ? L"eurotrucks2.exe" : L"amtrucks.exe";
      if (_wcsicmp(fs::path(final_path(serverImage.value)).filename().c_str(), expectedName) != 0) fail();
      if (discover) {
        auto& count = recordGame == "ets2" ? ets2Count : atsCount;
        auto& first = recordGame == "ets2" ? ets2Record : atsRecord;
        if (++count == 1) first = record;
        stage = "discovery"; continue;
      }
      if (selected) fail(); selected = record; selectedProcess.emplace(std::move(*candidate)); stage = "discovery";
    }
    if (discover) {discovered(); return finish(0, stage);}
    if (!selected) {receipt(Json{Json::Object{{"type", Json{std::string("waiting")}}, {"schemaVersion", Json{1.0}}}}); return finish(2, stage);}
    const auto& record = *selected; const auto pid = integer(record.at("processId")); if (!pid) fail();
    const auto expectedCreation = v0::parse_uint64(record.at("processCreationTime"));
    const auto endpoint = channel::active.pipe_prefix + game + segment + self.userTag + "-" + std::to_string(self.session) + "-" + record.at("processInstanceId").string();
    if (record.at("pipeName").string() != endpoint) fail();
    // The capture endpoint is keyed to the same verified process instance and its plugin session.
    const auto connectTo = capture ? channel::active.pipe_prefix + game + "-cap0-" + self.userTag + "-" + std::to_string(self.session) + "-" + record.at("processInstanceId").string() + "-" + record.at("pluginSessionId").string() : endpoint;
    auto& process = *selectedProcess;
    stage = "connected-peer"; if (!WaitNamedPipeW(wide(connectTo).c_str(), 250)) {const auto error = GetLastError(); if (error == ERROR_FILE_NOT_FOUND || error == ERROR_SEM_TIMEOUT) throw Disconnected(); pipe_failed(error);}
    const auto rawPipe = CreateFileW(wide(connectTo).c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (rawPipe == INVALID_HANDLE_VALUE) {const auto error = GetLastError(); if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PIPE_BUSY) throw Disconnected(); pipe_failed(error);}
    Handle pipe(rawPipe);
    ULONG actualPid = 0; if (!GetNamedPipeServerProcessId(pipe.value, &actualPid)) pipe_failed(GetLastError()); if (actualPid != pid) fail();
    auto verify = [&] {const auto waited = WaitForSingleObject(process.value, 0); if (waited == WAIT_OBJECT_0) throw Disconnected(); if (waited != WAIT_TIMEOUT) fail(); Identity fresh(process.value); if (fresh.sid != self.sid || fresh.session != self.session || creation(process.value) != expectedCreation) fail(); ULONG current = 0; if (!GetNamedPipeServerProcessId(pipe.value, &current)) pipe_failed(GetLastError()); if (current != pid) fail();};
    verify();
    Json source{Json::Object{{"game", Json{game}}, {"processId", Json{static_cast<double>(pid)}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processInstanceId", record.at("processInstanceId")}, {"pluginSessionId", record.at("pluginSessionId")}, {"origin", Json{std::string("game")}}}};
    Json::Object authority{{"type", Json{std::string("authority")}}, {"schemaVersion", Json{1.0}}, {"source", source}, {"processCreationTime", record.at("processCreationTime")}, {"userTag", Json{self.userTag}}};
    if (capture) authority["evidence"] = Json{std::string("cap0")};
    if (protocolV1) authority["protocolMajor"] = Json{1.0};
    stage = "authority-receipt"; receipt(Json{authority});
    stage = "hello"; unsigned char prefix[4]; stdio_io(GetStdHandle(STD_INPUT_HANDLE), prefix, 4, false); const auto helloLength = frame_length(prefix); if (!helloLength || helloLength > 4096) fail();
    std::vector<unsigned char> hello(helloLength + 4); std::copy(prefix, prefix + 4, hello.begin()); stdio_io(GetStdHandle(STD_INPUT_HANDLE), hello.data() + 4, helloLength, false);
    const std::string helloPayload(reinterpret_cast<char*>(hello.data() + 4), helloLength);
    // ET-050b B1: the v1 hello is always version 1.0; min(its offer, the contract's highest minor) bounds the client
    // frames this broker relays (ET-052: the contract now implements minor 2, so an offer of 1 stays 1).
    unsigned clientMaxMinor = 0;
    if (capture) ets2telemetry::cap0::validate_hello(helloPayload);
    else if (protocolV1) clientMaxMinor = v1::negotiate(v1::decode_payload(helloPayload, v1::Sender::client), true, v1::highest_minor).minor;
    else v0::negotiate(v0::decode_payload(helloPayload));
    const std::size_t frameBound = protocolV1 ? v1::limits.server_frame_bytes : v0::max_frame_bytes;
    // Declared after the pipe and process handles, so its reader (and any v1 client write) is joined before they close.
    stage = "relay"; Credits credits(protocolV1 ? pipe.value : nullptr, protocolV1 ? process.value : nullptr, clientMaxMinor);
    try {
    pipe_io(pipe.value, process.value, hello.data(), static_cast<DWORD>(hello.size()), true, credits.cancelled.value);
    SetEvent(credits.helloSent.value);
    for (;;) {
      stage = "relay"; credits.take(process.value); stage = "retained-authority"; verify(); stage = "relay";
      pipe_io(pipe.value, process.value, prefix, 4, false, credits.cancelled.value, true); stage = "wire-frame"; const auto length = frame_length(prefix); if (!length || length > frameBound) fail(); stage = "relay";
      stage = "wire-payload"; std::vector<unsigned char> frame(length + 4); std::copy(prefix, prefix + 4, frame.begin()); pipe_io(pipe.value, process.value, frame.data() + 4, length, false, credits.cancelled.value); stage = "retained-authority"; verify(); stage = "relay";
      stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), frame.data(), static_cast<DWORD>(frame.size()), true);
    }
    } catch (const Disconnected&) {
      if (credits.rejected) fail();
      // A protocol v1 client frame ended the relay through the reader: a rejected frame is a hard failure with no Win32
      // error, and a failed write keeps the pipe's disconnect or failure classification.
      switch (credits.client.load()) {
        case ClientFailure::none: break;
        case ClientFailure::frame: stage = "client-frame"; SetLastError(ERROR_SUCCESS); fail();
        case ClientFailure::disconnected: stage = "client-write"; throw Disconnected(credits.clientError.load());
        case ClientFailure::failed: stage = "client-write"; SetLastError(credits.clientError.load()); fail();
      }
      throw;
    }
  } catch (const Disconnected&) {return finish(3, stage);}
  catch (const Busy&) {return finish(4, stage);}
  catch (...) {return finish(1, stage);}
}
