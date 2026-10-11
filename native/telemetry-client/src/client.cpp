#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include "protocol-json.hpp"
#include <algorithm>
#include <filesystem>
#include <memory>
#include <regex>
#include <thread>
#include <atomic>

namespace v0 = ets2telemetry::v0;
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
struct Disconnected : std::runtime_error {Disconnected() : std::runtime_error("Source disconnected") {}};
[[noreturn]] void fail() {throw std::runtime_error("Verified pipe client rejected source or transport");}
[[noreturn]] void process_query_failed(HANDLE process) {
  // Access/security failures stay hard rejections, even if the process exits concurrently.
  const auto error = GetLastError();
  if ((error == ERROR_INVALID_PARAMETER || error == ERROR_PROCESS_ABORTED || error == ERROR_NO_TOKEN) && WaitForSingleObject(process, 0) == WAIT_OBJECT_0) throw Disconnected();
  fail();
}
[[noreturn]] void pipe_failed(DWORD error) {
  if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA) throw Disconnected();
  fail();
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
std::uint64_t creation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{}; if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) process_query_failed(process);
  return (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
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
  Handle file(CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
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
void bootstrap_policy(const fs::path& directory, const Identity& identity, HANDLE ownImage, const char*& stage) {
  OwnerSecurity lockSecurity(identity);
  Handle policyLock(CreateFileW((directory / "service-policy.lock").c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, &lockSecurity.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
  protected_owner(policyLock.value, identity);
  stage = "policy-image";
  test_trace(stage);
  const auto ownPath = utf8(final_path(ownImage)); LARGE_INTEGER zero{}; SetFilePointerEx(ownImage, zero, nullptr, FILE_BEGIN);
  const auto bytes = read_bounded(ownImage, 64 * 1024 * 1024); const auto hash = sha256(std::vector<unsigned char>(bytes.begin(), bytes.end()));
  stage = "policy-existing"; const auto policyPath = directory / "service-policy.json";
  test_trace(stage);
  Json::Array entries;
  if (fs::exists(policyPath)) {
    auto handle = secure_file(policyPath, identity); const auto policy = parse(read_bounded(handle.value, 16384));
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
  stage = "policy-write"; OwnerSecurity security(identity); const auto temporary = directory / ("policy-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(creation(GetCurrentProcess())) + ".tmp");
  {
    Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE | READ_CONTROL, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)); protected_owner(file.value, identity);
    DWORD written = 0; if (!WriteFile(file.value, encoded.data(), static_cast<DWORD>(encoded.size()), &written, nullptr) || written != encoded.size() || !FlushFileBuffers(file.value)) {DeleteFileW(temporary.c_str()); fail();}
  }
  stage = "policy-publish"; if (!MoveFileExW(temporary.c_str(), policyPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {DeleteFileW(temporary.c_str()); fail();}
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
struct Credits {
  Handle ready{CreateSemaphoreW(nullptr, 0, 1, nullptr)}, cancelled{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::atomic<bool> stopping{false}, rejected{false}; std::thread reader;
  Credits() : reader([this] {
    while (!stopping) {
      unsigned char credit = 0; DWORD read = 0;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &credit, 1, &read, nullptr) || read != 1) break;
      if (credit != 1 || !ReleaseSemaphore(ready.value, 1, nullptr)) {rejected = true; break;}
    }
    SetEvent(cancelled.value); SetEvent(done.value);
  }) {}
  ~Credits() {
    stopping = true;
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
void receipt(const Json& value) {
  auto text = v0::detail::serialize(value); if (text.empty() || text.size() > 4096) fail(); const auto n = static_cast<DWORD>(text.size());
  unsigned char prefix[] = {static_cast<unsigned char>(n), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 24)};
  stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), prefix, 4, true); stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), n, true);
}
int wmain(int argc, wchar_t** argv) {
  test_trace("entry");
  const char* stage = "arguments";
  try {
    if (argc != 5 || std::wstring(argv[1]) != L"--game" || std::wstring(argv[3]) != L"--discovery-dir") fail();
    const auto game = utf8(argv[2]); if (game != "ets2" && game != "ats") fail();
    test_trace("current-identity-start"); Identity self(GetCurrentProcess()); test_trace("current-identity-done"); const fs::path directory(argv[4]); if (!directory.is_absolute()) fail();
    if (!fs::exists(directory)) {receipt(Json{Json::Object{{"type", Json{std::string("waiting")}}, {"schemaVersion", Json{1.0}}}}); return 2;}
    reject_reparse_ancestors(directory);
    // The two owned transport directories must both remain protected and free of reparses.
    auto parent = secure_file(directory.parent_path(), self, true); auto owned = secure_file(directory, self, true);
    stage = "policy"; auto ownImage = image(GetCurrentProcess()); bootstrap_policy(directory, self, ownImage.value, stage);
    stage = "discovery"; test_trace(stage); std::optional<Json> selected; std::optional<Handle> selectedProcess; unsigned records = 0, visited = 0;
    for (const auto& entry : fs::directory_iterator(directory)) {
      if (++visited > 256) fail();
      const auto stem = utf8(entry.path().stem().wstring()); if (!uuid(stem) || entry.path().extension() != L".json") continue;
      if (++records > 128) fail();
#ifdef ETS2TELEMETRY_CLIENT_DISCOVERY_TEST
      discovery_before_open(entry.path());
#endif
      auto file = enumerated_discovery_file(entry.path(), self); if (!file) continue;
      auto record = parse(read_bounded(file->value, 16384));
      exact(record, {"schemaVersion", "protocolMajor", "game", "userTag", "windowsSessionId", "processId", "processCreationTime", "processInstanceId", "pluginSessionId", "pipeName"});
      if (integer(record.at("schemaVersion")) != 1 || integer(record.at("protocolMajor")) != 0 || record.at("userTag").string() != self.userTag || integer(record.at("windowsSessionId")) != self.session || record.at("processInstanceId").string() != stem || !uuid(record.at("pluginSessionId").string())) fail();
      if (record.at("game").string() != "ets2" && record.at("game").string() != "ats") fail();
      if (record.at("game").string() != game) continue;
      const auto pid = integer(record.at("processId")); if (!pid) fail();
      const auto expectedCreation = v0::parse_uint64(record.at("processCreationTime"));
      const auto endpoint = "\\\\.\\pipe\\ETS2Telemetry-" + game + "-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + stem;
      if (record.at("pipeName").string() != endpoint) fail();
      stage = "server-process";
      const auto raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (!raw) {if (GetLastError() == ERROR_INVALID_PARAMETER) {stage = "discovery"; continue;} fail();}
      Handle candidate(raw);
      if (WaitForSingleObject(candidate.value, 0) == WAIT_OBJECT_0 || creation(candidate.value) != expectedCreation) {stage = "discovery"; continue;}
      Identity server(candidate.value); if (server.sid != self.sid || server.session != self.session) fail();
      stage = "server-image"; auto serverImage = image(candidate.value); const auto expectedName = game == "ets2" ? L"eurotrucks2.exe" : L"amtrucks.exe";
      if (_wcsicmp(fs::path(final_path(serverImage.value)).filename().c_str(), expectedName) != 0) fail();
      if (selected) fail(); selected = record; selectedProcess.emplace(std::move(candidate)); stage = "discovery";
    }
    if (!selected) {receipt(Json{Json::Object{{"type", Json{std::string("waiting")}}, {"schemaVersion", Json{1.0}}}}); return 2;}
    const auto& record = *selected; const auto pid = integer(record.at("processId")); if (!pid) fail();
    const auto expectedCreation = v0::parse_uint64(record.at("processCreationTime"));
    const auto endpoint = "\\\\.\\pipe\\ETS2Telemetry-" + game + "-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + record.at("processInstanceId").string();
    if (record.at("pipeName").string() != endpoint) fail();
    auto& process = *selectedProcess;
    stage = "connected-peer"; if (!WaitNamedPipeW(wide(endpoint).c_str(), 250)) {const auto error = GetLastError(); if (error == ERROR_FILE_NOT_FOUND || error == ERROR_SEM_TIMEOUT) throw Disconnected(); pipe_failed(error);}
    const auto rawPipe = CreateFileW(wide(endpoint).c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (rawPipe == INVALID_HANDLE_VALUE) {const auto error = GetLastError(); if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PIPE_BUSY) throw Disconnected(); pipe_failed(error);}
    Handle pipe(rawPipe);
    ULONG actualPid = 0; if (!GetNamedPipeServerProcessId(pipe.value, &actualPid)) pipe_failed(GetLastError()); if (actualPid != pid) fail();
    auto verify = [&] {const auto waited = WaitForSingleObject(process.value, 0); if (waited == WAIT_OBJECT_0) throw Disconnected(); if (waited != WAIT_TIMEOUT) fail(); Identity fresh(process.value); if (fresh.sid != self.sid || fresh.session != self.session || creation(process.value) != expectedCreation) fail(); ULONG current = 0; if (!GetNamedPipeServerProcessId(pipe.value, &current)) pipe_failed(GetLastError()); if (current != pid) fail();};
    verify();
    Json source{Json::Object{{"game", Json{game}}, {"processId", Json{static_cast<double>(pid)}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processInstanceId", record.at("processInstanceId")}, {"pluginSessionId", record.at("pluginSessionId")}, {"origin", Json{std::string("game")}}}};
    stage = "authority-receipt"; receipt(Json{Json::Object{{"type", Json{std::string("authority")}}, {"schemaVersion", Json{1.0}}, {"source", source}, {"processCreationTime", record.at("processCreationTime")}, {"userTag", Json{self.userTag}}}});
    stage = "hello"; unsigned char prefix[4]; stdio_io(GetStdHandle(STD_INPUT_HANDLE), prefix, 4, false); const auto helloLength = frame_length(prefix); if (!helloLength || helloLength > 4096) fail();
    std::vector<unsigned char> hello(helloLength + 4); std::copy(prefix, prefix + 4, hello.begin()); stdio_io(GetStdHandle(STD_INPUT_HANDLE), hello.data() + 4, helloLength, false);
    const auto helloMessage = v0::decode_payload(std::string(reinterpret_cast<char*>(hello.data() + 4), helloLength)); v0::negotiate(helloMessage);
    stage = "relay"; Credits credits;
    try {
    pipe_io(pipe.value, process.value, hello.data(), static_cast<DWORD>(hello.size()), true, credits.cancelled.value);
    for (;;) {
      stage = "relay"; credits.take(process.value); stage = "retained-authority"; verify(); stage = "relay";
      pipe_io(pipe.value, process.value, prefix, 4, false, credits.cancelled.value, true); stage = "wire-frame"; const auto length = frame_length(prefix); if (!length || length > v0::max_frame_bytes) fail(); stage = "relay";
      stage = "wire-payload"; std::vector<unsigned char> frame(length + 4); std::copy(prefix, prefix + 4, frame.begin()); pipe_io(pipe.value, process.value, frame.data() + 4, length, false, credits.cancelled.value); stage = "retained-authority"; verify(); stage = "relay";
      stdio_io(GetStdHandle(STD_OUTPUT_HANDLE), frame.data(), static_cast<DWORD>(frame.size()), true);
    }
    } catch (const Disconnected&) {if (credits.rejected) fail(); throw;}
  } catch (const Disconnected&) {return 3;}
  catch (...) {const auto diagnostic = std::string(stage) + ":" + std::to_string(GetLastError()); DWORD written = 0; WriteFile(GetStdHandle(STD_ERROR_HANDLE), diagnostic.data(), static_cast<DWORD>(diagnostic.size()), &written, nullptr); return 1;}
}
