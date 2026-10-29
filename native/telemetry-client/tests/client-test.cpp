// This is an isolated console fixture named eurotrucks2.exe; it never launches or touches a game.
#define wmain broker_entrypoint
#define ETS2TELEMETRY_CLIENT_DISCOVERY_TEST
#include "../src/client.cpp"
#undef ETS2TELEMETRY_CLIENT_DISCOVERY_TEST
#undef wmain
#include <fstream>
#include <iostream>
#include <winioctl.h>
void require(bool value) {if (!value) throw std::runtime_error("Native client test assertion failed");}
struct TestDirectoryCleanup {
  fs::path path;
  ~TestDirectoryCleanup() {std::error_code ignored; fs::remove_all(path, ignored);}
};
struct JunctionCleanup {
  fs::path path;
  ~JunctionCleanup() {if (!path.empty()) RemoveDirectoryW(path.c_str());}
};
struct FixtureDaclRestore {
  Handle file; OwnerSecurity security; PACL dacl = nullptr;
  FixtureDaclRestore(const fs::path& filename, const Identity& identity) : file(CreateFileW(filename.c_str(), READ_CONTROL | WRITE_DAC | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)), security(identity) {
    BOOL present = FALSE, defaulted = FALSE; require(GetSecurityDescriptorDacl(security.descriptor, &present, &dacl, &defaulted) && present && dacl);
  }
  bool restore() {if (!dacl) return true; const auto result = SetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr); if (result == ERROR_SUCCESS) dacl = nullptr; else std::cerr << "fixture DACL restoration error " << result << "\n"; return result == ERROR_SUCCESS;}
  ~FixtureDaclRestore() {restore();}
};
void create_junction(const fs::path& link, const fs::path& target, const Identity& identity) {
  OwnerSecurity security(identity); require(CreateDirectoryW(link.c_str(), &security.attributes) != 0);
  Handle directory(CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  struct MountPoint {
    DWORD tag; WORD dataLength, reserved, substituteOffset, substituteLength, printOffset, printLength; wchar_t names[1024];
  } data{};
  static_assert(offsetof(MountPoint, names) == 16);
  const auto substitute = L"\\??\\" + target.wstring(), printable = target.wstring();
  require(substitute.size() + printable.size() + 2 < 1024);
  data.tag = IO_REPARSE_TAG_MOUNT_POINT;
  data.substituteLength = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  data.printOffset = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
  data.printLength = static_cast<WORD>(printable.size() * sizeof(wchar_t));
  data.dataLength = static_cast<WORD>(8 + data.printOffset + data.printLength + sizeof(wchar_t));
  std::copy(substitute.begin(), substitute.end(), data.names);
  std::copy(printable.begin(), printable.end(), data.names + substitute.size() + 1);
  DWORD returned = 0;
  require(DeviceIoControl(directory.value, FSCTL_SET_REPARSE_POINT, &data, static_cast<DWORD>(8 + data.dataLength), nullptr, 0, &returned, nullptr) != 0);
  FILE_ATTRIBUTE_TAG_INFO attributes{}; require(GetFileInformationByHandleEx(directory.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) && attributes.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT);
}
void descriptor_owner_test(const Identity& identity) {
  OwnerSecurity security(identity); PSID owner = nullptr; BOOL defaulted = FALSE;
  require(GetSecurityDescriptorOwner(security.descriptor, &owner, &defaulted) != 0);
  require(owner && EqualSid(owner, identity.user()) && !defaulted);
  std::cout << "explicit descriptor owner equals TokenUser passed\n";
}
std::vector<unsigned char> token_information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size); require(size > 0 && size <= 65536);
  std::vector<unsigned char> result(size); require(GetTokenInformation(token, kind, result.data(), size, &size) != 0); return result;
}
bool file_owner_is(HANDLE file, PSID expected) {
  PSECURITY_DESCRIPTOR descriptor = nullptr; PSID owner = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &descriptor) == ERROR_SUCCESS);
  const bool matches = owner && EqualSid(owner, expected); LocalFree(descriptor); return matches;
}
void controlled_token_owner_test(const fs::path& base, const Identity& identity) {
  HANDLE raw = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw) != 0); Handle token(raw);
  auto ownerBytes = token_information(token.value, TokenOwner), groupBytes = token_information(token.value, TokenGroups), privilegeBytes = token_information(token.value, TokenPrivileges);
  const auto defaultOwner = reinterpret_cast<TOKEN_OWNER*>(ownerBytes.data())->Owner;
  const auto groups = reinterpret_cast<TOKEN_GROUPS*>(groupBytes.data()); PSID alternateOwner = nullptr;
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    const auto& group = groups->Groups[index];
    if ((group.Attributes & SE_GROUP_OWNER) && !(group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) && !EqualSid(group.Sid, identity.user())) {alternateOwner = group.Sid; break;}
  }
  TOKEN_ELEVATION elevation{}; DWORD written = 0; require(GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &written) != 0);
  std::cout << "token roles: elevated=" << (elevation.TokenIsElevated != 0) << " defaultOwnerEqualsUser=" << (EqualSid(defaultOwner, identity.user()) != 0) << " alternateOwnerAvailable=" << (alternateOwner != nullptr) << "\n";
  const auto privileges = reinterpret_cast<TOKEN_PRIVILEGES*>(privilegeBytes.data());
  for (const auto* name : {L"SeRestorePrivilege", L"SeTakeOwnershipPrivilege", L"SeImpersonatePrivilege"}) {
    LUID identifier{}; require(LookupPrivilegeValueW(nullptr, name, &identifier) != 0); bool present = false, enabled = false;
    for (DWORD index = 0; index < privileges->PrivilegeCount; ++index) {
      const auto& privilege = privileges->Privileges[index];
      if (privilege.Luid.HighPart == identifier.HighPart && privilege.Luid.LowPart == identifier.LowPart) {present = true; enabled = (privilege.Attributes & SE_PRIVILEGE_ENABLED) != 0;}
    }
    std::cout << utf8(name) << ": present=" << present << " enabled=" << enabled << "\n";
  }
  if (!alternateOwner) {std::cout << "controlled TokenOwner mismatch unavailable: no eligible alternate owner group; descriptor-owner regression passed, elevation not established\n"; return;}
  HANDLE duplicated = nullptr;
  require(DuplicateTokenEx(token.value, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_IMPERSONATE, nullptr, SecurityImpersonation, TokenImpersonation, &duplicated) != 0); Handle testToken(duplicated);
  TOKEN_OWNER changed{alternateOwner}; require(SetTokenInformation(testToken.value, TokenOwner, &changed, sizeof(changed)) != 0);
  auto changedBytes = token_information(testToken.value, TokenOwner); require(EqualSid(reinterpret_cast<TOKEN_OWNER*>(changedBytes.data())->Owner, alternateOwner) != 0);
  // Only this duplicate token's default owner changes; the process token and account remain untouched.
  require(ImpersonateLoggedOnUser(testToken.value) != 0);
  try {
    OwnerSecurity explicitSecurity(identity);
    PSECURITY_DESCRIPTOR implicitDescriptor = nullptr;
    const auto implicitSddl = L"D:P(A;;GA;;;" + wide(identity.sid) + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(implicitSddl.c_str(), SDDL_REVISION_1, &implicitDescriptor, nullptr) != 0);
    struct Descriptor {PSECURITY_DESCRIPTOR value; ~Descriptor() {LocalFree(value);}} implicit{implicitDescriptor};
    SECURITY_ATTRIBUTES implicitSecurity{sizeof(SECURITY_ATTRIBUTES), implicit.value, FALSE};
    Handle implicitFile(CreateFileW((base / L"implicit-owner.tmp").c_str(), GENERIC_WRITE | READ_CONTROL | DELETE, 0, &implicitSecurity, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
    require(file_owner_is(implicitFile.value, alternateOwner) && !file_owner_is(implicitFile.value, identity.user()));
    Handle explicitFile(CreateFileW((base / L"explicit-owner.tmp").c_str(), GENERIC_WRITE | READ_CONTROL | DELETE, 0, &explicitSecurity.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
    protected_owner(explicitFile.value, identity);
  } catch (...) {require(RevertToSelf() != 0); throw;}
  require(RevertToSelf() != 0); std::cout << "controlled duplicate TokenOwner mismatch: implicit owner rejected, explicit TokenUser owner and strict DACL passed\n";
}
// Hang detection for the fixture's own waits (child exit, frame reads, host connect). Several cases
// wait out the broker's fixed 5 s frame deadline or the host's 5.5 s quiet window, so these bounds need
// real slack above those product timings on a loaded host. The former 5-6 s bounds left 0-1 s and
// failed under CPU contention although the broker exited correctly. Product timing is asserted
// separately where it matters (quiet: alive after 5.5 s, prompt EOF exit; partial frames: exit after
// the 5 s deadline, measured).
constexpr DWORD fixtureWaitMs = 15000;
// The broker also exits (code 3) when the host process exits. In cases that prove a broker deadline or
// prompt EOF cancellation, the host therefore outlives every fixture bound by a wide margin, so a
// regression that removes the deadline or the cancellation cannot pass by riding on host exit. The host
// still returns as soon as the broker exits, so passing runs are not slower.
constexpr DWORD hostHoldMs = 3 * fixtureWaitMs;
struct Child {
  Handle process, input, output, error; DWORD pid = 0;
  Child(const std::wstring& executable, const std::wstring& arguments, bool captureError = false) {
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE}; HANDLE inRead = nullptr, inWrite = nullptr, outRead = nullptr, outWrite = nullptr;
    require(CreatePipe(&inRead, &inWrite, &attributes, 0) != 0); Handle childInput(inRead); input.value = inWrite;
    require(CreatePipe(&outRead, &outWrite, &attributes, 0) != 0); Handle childOutput(outWrite); output.value = outRead;
    require(SetHandleInformation(input.value, HANDLE_FLAG_INHERIT, 0) && SetHandleInformation(output.value, HANDLE_FLAG_INHERIT, 0));
    std::optional<Handle> childError;
    if (captureError) {HANDLE errRead = nullptr, errWrite = nullptr; require(CreatePipe(&errRead, &errWrite, &attributes, 65536) != 0); childError.emplace(errWrite); error.value = errRead; require(SetHandleInformation(error.value, HANDLE_FLAG_INHERIT, 0) != 0);}
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = childInput.value; startup.hStdOutput = childOutput.value; startup.hStdError = childError ? childError->value : GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION information{}; auto command = L"\"" + executable + L"\" " + arguments;
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &information) != 0);
    process.value = information.hProcess; pid = information.dwProcessId; CloseHandle(information.hThread);
  }
  void eof() {if (input.value != INVALID_HANDLE_VALUE) {CloseHandle(input.value); input.value = INVALID_HANDLE_VALUE;}}
  DWORD wait() {require(WaitForSingleObject(process.value, fixtureWaitMs) == WAIT_OBJECT_0); DWORD code = 0; require(GetExitCodeProcess(process.value, &code) != 0); return code;}
  // Reads the captured stderr after exit; the bound matches the service's diagnostic tail.
  std::string diagnostic() {
    std::string text; char buffer[512]; DWORD read = 0;
    while (ReadFile(error.value, buffer, sizeof(buffer), &read, nullptr) && read) {text.append(buffer, read); require(text.size() <= 4096);}
    return text;
  }
  ~Child() {
    eof();
    // Only this exact owned handle is terminated on a failed assertion; never enumerate host processes.
    if (WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {TerminateProcess(process.value, 90); WaitForSingleObject(process.value, 2000);}
  }
};
std::string read_frame(HANDLE pipe) {
  unsigned char prefix[4]; stdio_io(pipe, prefix, 4, false, fixtureWaitMs); const auto length = frame_length(prefix); require(length > 0 && length <= 65536);
  std::string bytes(length, '\0'); stdio_io(pipe, bytes.data(), length, false, fixtureWaitMs); return bytes;
}
void write_file(const fs::path& filename, const Json& value, const Identity& identity) {
  OwnerSecurity security(identity); Handle file(CreateFileW(filename.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  auto encoded = v0::detail::serialize(value); DWORD written = 0; require(WriteFile(file.value, encoded.data(), static_cast<DWORD>(encoded.size()), &written, nullptr) && written == encoded.size());
}
std::string file_bytes(const fs::path& filename) {std::ifstream input(filename, std::ios::binary); return std::string(std::istreambuf_iterator<char>(input), {});}
// Every case in run order. CMakeLists.txt registers one CTest entry per name, selected through
// ETS2TELEMETRY_CLIENT_TEST_CASE; its --verify-cases entry fails when the two lists diverge.
const char* const discoveryCases[] = {"retired-record", "delete-pending-record", "denied-record", "zero-record", "short-record", "directory-record", "reparse-record"};
const char* const oneShotCases[] = {"discover-none", "discover-ets2", "discover-ats", "discover-both", "discover-ambiguous", "discover-v1", "discover-stale", "discover-dead", "discover-malformed", "discover-channel", "discover-dacl", "discover-reparse", "discover-retired", "discover-delete-pending"};
const char* const hostCases[] = {"valid", "creation", "dead", "stale-live", "dead-live", "collision", "session", "malformed", "dacl", "payload-break", "bad-length", "invalid-credit", "quiet", "quiet-exit", "partial-prefix", "partial-payload"};
const char* const captureCases[] = {"capture", "capture-v0-hello", "capture-bad-arguments"};
const char* const v1Cases[] = {"v1-valid", "v1-policy", "v1-major-mismatch", "v1-name-mismatch", "v1-collision", "v1-v0-hello", "v1-cap0-hello",
  "v1-client-kind", "v1-client-oversize", "v1-bad-tag", "v1-partial-length", "v1-partial-payload", "v1-zero-length", "v1-ack-while-quiet", "v1-write-deadline", "v1-capture-conflict",
  "v1-minor1-valid", "v1-minor-above-offer", "v1-minor-changed", "v1-minor2-valid", "v1-minor2-above-offer"};
const char* const policyCases[] = {"policy-prune", "policy-cap", "policy-duplicate", "policy-case-duplicate", "policy-junction"};
const char* const contentionCases[] = {"policy-lock-busy", "policy-lock-pending", "policy-publish-busy", "image-busy"};
std::string case_list() {
  std::string joined;
  auto add = [&](const auto& names) {for (const auto* name : names) joined += (joined.empty() ? "" : ",") + std::string(name);};
  add(discoveryCases); add(oneShotCases); add(hostCases); add(captureCases); add(v1Cases); add(policyCases); add(contentionCases);
  return joined + ",policy-readonly";
}
unsigned casesRun = 0;
// Reports each case's wall time on stderr (unbuffered), so a slow case is visible even when CTest
// kills the process at its timeout.
struct CaseTimer {
  std::string name; ULONGLONG started = GetTickCount64();
  explicit CaseTimer(std::string value) : name(std::move(value)) {++casesRun; std::cerr << "case " << name << "\n";}
  ~CaseTimer() {std::cerr << "case " << name << " ms=" << GetTickCount64() - started << "\n";}
};
std::string discoveryCase;
std::optional<Handle> pendingRecord;
void discovery_before_open(const fs::path& filename) {
  if (discoveryCase == "retired-record") require(DeleteFileW(filename.c_str()) != 0);
  if (discoveryCase == "delete-pending-record") {
    pendingRecord.emplace(CreateFileW(filename.c_str(), GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(DeleteFileW(filename.c_str()) != 0);
    FILE_STANDARD_INFO info{}; require(GetFileInformationByHandleEx(pendingRecord->value, FileStandardInfo, &info, sizeof(info)) && info.DeletePending);
    const auto raw = CreateFileW(filename.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    const auto error = GetLastError(); if (raw != INVALID_HANDLE_VALUE) CloseHandle(raw); require(raw == INVALID_HANDLE_VALUE);
    std::cerr << "actual delete-pending discovery open error " << error << "\n";
    receipt(Json{Json::Object{{"type", Json{std::string("pending-observation")}}, {"error", Json{static_cast<double>(error)}}}});
  }
}
int host(const fs::path& directory, const fs::path& fixtures, const std::string& mode) {
  Identity self(GetCurrentProcess()); OwnerSecurity security(self);
  const std::string instance = "00112233-4455-6677-8899-aabbccddeeff", plugin = "11112233-4455-6677-8899-aabbccddeeff";
  const auto endpoint = std::string(channel::active.pipe_prefix) + "ets2-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + instance;
  Handle pipe(CreateNamedPipeW(wide(endpoint).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, 65540, 0, &security.attributes));
  Json source{Json::Object{{"game", Json{std::string("ets2")}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"origin", Json{std::string("game")}}}};
  auto record = Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{0.0}}, {"game", Json{std::string("ets2")}}, {"userTag", Json{self.userTag}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime", Json{std::to_string(creation(GetCurrentProcess()) + (mode == "creation" ? 1 : 0))}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"pipeName", Json{endpoint}}}};
  if (mode == "session") std::get<Json::Object>(record.value)["windowsSessionId"] = Json{static_cast<double>(self.session + 1)};
  if (mode == "malformed") std::get<Json::Object>(record.value)["unexpected"] = Json{false};
  if (mode == "dead") std::get<Json::Object>(record.value)["processId"] = Json{static_cast<double>(MAXDWORD)};
  const auto recordPath = directory / (instance + ".json"); write_file(recordPath, record, self);
  if (mode == "dacl") {
    PSECURITY_DESCRIPTOR descriptor = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
    PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE; require(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted));
    require(SetNamedSecurityInfoW(const_cast<wchar_t*>(recordPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS); LocalFree(descriptor);
  }
  if (mode == "collision" || mode == "stale-live" || mode == "dead-live") {
    const std::string second = "22112233-4455-6677-8899-aabbccddeeff";
    auto duplicate = record; auto& fields = std::get<Json::Object>(duplicate.value);
    fields["processInstanceId"] = Json{second}; fields["pipeName"] = Json{endpoint.substr(0, endpoint.size() - instance.size()) + second};
    if (mode == "stale-live") fields["processCreationTime"] = Json{std::to_string(creation(GetCurrentProcess()) + 1)};
    if (mode == "dead-live") fields["processId"] = Json{static_cast<double>(MAXDWORD)};
    write_file(directory / (second + ".json"), duplicate, self);
  }
  receipt(Json{Json::Object{{"type", Json{std::string("ready")}}}});
  test_trace("host-listen");
  Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED operation{}; operation.hEvent = connected.value;
  const auto success = ConnectNamedPipe(pipe.value, &operation); const auto error = success ? ERROR_SUCCESS : GetLastError();
  test_trace("host-connect-issued");
  if (error == ERROR_PIPE_CONNECTED) SetEvent(connected.value); else if (error != ERROR_IO_PENDING && error != ERROR_SUCCESS) fail();
  Credits cancellation;
  test_trace("host-monitor");
  HANDLE waits[] = {connected.value, cancellation.cancelled.value};
  if (WaitForMultipleObjects(2, waits, FALSE, fixtureWaitMs) != WAIT_OBJECT_0) {test_trace("host-no-client"); CancelIoEx(pipe.value, &operation); DWORD ignored = 0; GetOverlappedResult(pipe.value, &operation, &ignored, TRUE); return 0;}
  test_trace("host-connected");
  ULONG clientPid = 0; require(GetNamedPipeClientProcessId(pipe.value, &clientPid) && clientPid != 0); Handle client(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, clientPid)); Identity peer(client.value); require(peer.sid == self.sid && peer.session == self.session);
  auto policy = secure_file(directory / "service-policy.json", self); const auto policyJson = parse(read_bounded(policy.value, 16384)); auto peerImage = image(client.value); const auto peerPath = utf8(final_path(peerImage.value));
  bool allowed = false; for (const auto& entry : std::get<Json::Array>(policyJson.at("allowedExecutables").value)) if (entry.at("path").string() == peerPath) {const auto bytes = read_bounded(peerImage.value, 64 * 1024 * 1024); allowed = entry.at("sha256").string() == sha256(std::vector<unsigned char>(bytes.begin(), bytes.end()));}
  test_trace("host-policy-checked"); require(allowed);
  unsigned char header[4]; pipe_io(pipe.value, client.value, header, 4, false); const auto length = frame_length(header); require(length > 0 && length <= 4096); std::string hello(length, '\0'); pipe_io(pipe.value, client.value, hello.data(), length, false); require(v0::decode_payload(hello).kind == "hello");
  if (mode == "invalid-credit") {WaitForSingleObject(client.value, 10000); return 0;}
  if (mode == "payload-break" || mode == "partial-payload" || mode == "partial-prefix" || mode == "bad-length") {
    unsigned char incomplete[] = {8, 0, 0, 0, '{'};
    if (mode == "bad-length") std::fill(incomplete, incomplete + 4, static_cast<unsigned char>(0));
    const DWORD count = mode == "partial-prefix" ? 1 : mode == "bad-length" ? 4 : 5;
    pipe_io(pipe.value, client.value, incomplete, count, true);
    if (mode != "payload-break") WaitForSingleObject(client.value, mode == "bad-length" ? 10000 : hostHoldMs);
    return 0;
  }
  for (const auto* filename : {"welcome.json", "checkpoint.json"}) {
    auto message = parse(file_bytes(fixtures / filename)); auto& object = std::get<Json::Object>(message.value); object["source"] = source;
    if (std::string(filename) == "welcome.json") std::get<Json::Object>(object["data"].value)["diagnostics"] = Json{false};
    const auto frame = v0::encode_frame(v0::decode_payload(v0::detail::serialize(message)));
    pipe_io(pipe.value, client.value, const_cast<unsigned char*>(frame.data()), static_cast<DWORD>(frame.size()), true);
  }
  // Remain connected until the owned client exits or cancels while waiting for the next frame.
  WaitForSingleObject(client.value, mode == "quiet-exit" ? 5500 : mode == "quiet" ? hostHoldMs : 10000); return 0;
}
// CAP0 capture host: publishes the same v0 discovery record but serves only the separate capture endpoint.
int capture_host(const fs::path& directory, const std::string& mode) {
  Identity self(GetCurrentProcess()); OwnerSecurity security(self);
  const std::string instance = "00112233-4455-6677-8899-aabbccddeeff", plugin = "11112233-4455-6677-8899-aabbccddeeff";
  const auto endpoint = std::string(channel::active.pipe_prefix) + "ets2-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + instance;
  const auto capture = std::string(channel::active.pipe_prefix) + "ets2-cap0-" + self.userTag + "-" + std::to_string(self.session) + "-" + instance + "-" + plugin;
  Handle pipe(CreateNamedPipeW(wide(capture).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, 65540, 0, &security.attributes));
  write_file(directory / (instance + ".json"), Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{0.0}}, {"game", Json{std::string("ets2")}}, {"userTag", Json{self.userTag}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime", Json{std::to_string(creation(GetCurrentProcess()))}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"pipeName", Json{endpoint}}}}, self);
  receipt(Json{Json::Object{{"type", Json{std::string("ready")}}}});
  Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED operation{}; operation.hEvent = connected.value;
  const auto success = ConnectNamedPipe(pipe.value, &operation); const auto error = success ? ERROR_SUCCESS : GetLastError();
  if (error == ERROR_PIPE_CONNECTED) SetEvent(connected.value); else if (error != ERROR_IO_PENDING && error != ERROR_SUCCESS) fail();
  if (WaitForSingleObject(connected.value, fixtureWaitMs) != WAIT_OBJECT_0) {CancelIoEx(pipe.value, &operation); DWORD ignored = 0; GetOverlappedResult(pipe.value, &operation, &ignored, TRUE); return mode == "capture-v0-hello" ? 0 : 1;}
  ULONG clientPid = 0; require(GetNamedPipeClientProcessId(pipe.value, &clientPid) && clientPid != 0); Handle client(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, clientPid));
  // The broker must reject a v0 hello locally; nothing reaches the capture endpoint.
  if (mode == "capture-v0-hello") {WaitForSingleObject(client.value, 10000); return 0;}
  unsigned char header[4]; pipe_io(pipe.value, client.value, header, 4, false); const auto length = frame_length(header); require(length > 0 && length <= 4096);
  std::string hello(length, '\0'); pipe_io(pipe.value, client.value, hello.data(), length, false); require(ets2telemetry::cap0::validate_hello(hello) == "0cab0000-0000-4000-8000-0000000000a1");
  const auto packet = std::string("{\"format\":\"ets2telemetry-cap0\",\"kind\":\"header\",\"fixture\":true}"); const auto n = static_cast<DWORD>(packet.size());
  unsigned char prefix[] = {static_cast<unsigned char>(n), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 24)};
  pipe_io(pipe.value, client.value, prefix, 4, true); pipe_io(pipe.value, client.value, const_cast<char*>(packet.data()), n, true);
  WaitForSingleObject(client.value, 10000); return 0;
}
// A four-byte little-endian length prefix followed by the payload.
std::string framed(const std::string& payload) {
  const auto n = static_cast<DWORD>(payload.size());
  return std::string{static_cast<char>(n & 255), static_cast<char>((n >> 8) & 255), static_cast<char>((n >> 16) & 255), static_cast<char>((n >> 24) & 255)} + payload;
}
// One length-prefixed frame from the host's pipe, waiting for its first byte until the client exits.
std::string pipe_frame(HANDLE pipe, HANDLE client) {
  unsigned char header[4]; pipe_io(pipe, client, header, 4, false, nullptr, true); const auto length = frame_length(header); require(length > 0 && length <= 4096);
  std::string payload(length, '\0'); pipe_io(pipe, client, payload.data(), length, false); return framed(payload);
}
// After the broker has exited, nothing more may be readable: a forwarded byte would complete this read instead of EOF.
bool silent(HANDLE pipe, HANDLE client) {
  unsigned char byte = 0;
  try {pipe_io(pipe, client, &byte, 1, false);} catch (const Disconnected&) {return true;}
  return false;
}
// Protocol v1 host: publishes a v1 discovery record and serves the v1 endpoint with v1 fixture frames. Like the plugin it
// authorizes the broker against the policy in the v1 directory, and it requires that exactly the v1 hello and the client
// frames the controller sent reach the pipe, byte for byte and in order.
int v1_host(const fs::path& directory, const fs::path& fixtures, const std::string& mode) {
  Identity self(GetCurrentProcess()); OwnerSecurity security(self);
  const std::string instance = "00112233-4455-6677-8899-aabbccddeeff", plugin = "11112233-4455-6677-8899-aabbccddeeff";
  const auto name = [&](const char* segment, const std::string& id) {return std::string(channel::active.pipe_prefix) + "ets2-" + std::string(segment) + "-" + self.userTag + "-" + std::to_string(self.session) + "-" + id;};
  const auto endpoint = name("v1", instance);
  // Without inbound quota a client write stays pending until the host reads it, which the deadline case never does.
  const DWORD inbound = mode == "v1-write-deadline" ? 0 : 65540;
  Handle pipe(CreateNamedPipeW(wide(endpoint).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, inbound, 0, &security.attributes));
  auto record = Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{mode == "v1-major-mismatch" ? 0.0 : 1.0}}, {"game", Json{std::string("ets2")}}, {"userTag", Json{self.userTag}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime", Json{std::to_string(creation(GetCurrentProcess()))}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"pipeName", Json{mode == "v1-name-mismatch" ? name("v0", instance) : endpoint}}}};
  write_file(directory / (instance + ".json"), record, self);
  if (mode == "v1-collision") {
    const std::string second = "22112233-4455-6677-8899-aabbccddeeff";
    auto duplicate = record; auto& fields = std::get<Json::Object>(duplicate.value);
    fields["processInstanceId"] = Json{second}; fields["pipeName"] = Json{name("v1", second)};
    write_file(directory / (second + ".json"), duplicate, self);
  }
  receipt(Json{Json::Object{{"type", Json{std::string("ready")}}}});
  Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED operation{}; operation.hEvent = connected.value;
  const auto success = ConnectNamedPipe(pipe.value, &operation); const auto error = success ? ERROR_SUCCESS : GetLastError();
  if (error == ERROR_PIPE_CONNECTED) SetEvent(connected.value); else if (error != ERROR_IO_PENDING && error != ERROR_SUCCESS) fail();
  Credits cancellation;
  HANDLE waits[] = {connected.value, cancellation.cancelled.value};
  if (WaitForMultipleObjects(2, waits, FALSE, fixtureWaitMs) != WAIT_OBJECT_0) {CancelIoEx(pipe.value, &operation); DWORD ignored = 0; GetOverlappedResult(pipe.value, &operation, &ignored, TRUE); return 0;}
  ULONG clientPid = 0; require(GetNamedPipeClientProcessId(pipe.value, &clientPid) && clientPid != 0); Handle client(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, clientPid)); Identity peer(client.value); require(peer.sid == self.sid && peer.session == self.session);
  auto policy = secure_file(directory / "service-policy.json", self); const auto policyJson = parse(read_bounded(policy.value, 16384)); auto peerImage = image(client.value); const auto peerPath = utf8(final_path(peerImage.value));
  bool allowed = false; for (const auto& entry : std::get<Json::Array>(policyJson.at("allowedExecutables").value)) if (entry.at("path").string() == peerPath) {const auto bytes = read_bounded(peerImage.value, 64 * 1024 * 1024); allowed = entry.at("sha256").string() == sha256(std::vector<unsigned char>(bytes.begin(), bytes.end()));}
  require(allowed);
  // A rejected hello never reaches the endpoint.
  if (mode == "v1-v0-hello" || mode == "v1-cap0-hello") {WaitForSingleObject(client.value, 10000); return silent(pipe.value, client.value) ? 0 : 1;}
  // ET-050b B1: the minor-1 cases offer minor 1 and are served the minor-1 fixtures, whose frames all carry {1,1}. ET-052:
  // v1-minor2-valid offers minor 2 and is served the minor-2 fixtures ({1,2}); v1-minor2-above-offer offers minor 1 (then
  // sends a {1,2} ACK) and is served the minor-1 fixtures.
  const bool minor1 = mode == "v1-minor1-valid" || mode == "v1-minor-changed" || mode == "v1-minor2-above-offer";
  const auto served = mode == "v1-minor2-valid" ? fixtures / "minor2" : minor1 ? fixtures / "minor1" : fixtures;
  const auto hello = pipe_frame(pipe.value, client.value); require(hello == framed(file_bytes(served / "hello.json")));
  for (const auto* filename : {"welcome.json", "checkpoint.json"}) {auto frame = framed(file_bytes(served / filename)); pipe_io(pipe.value, client.value, frame.data(), static_cast<DWORD>(frame.size()), true);}
  if (mode == "v1-write-deadline") {WaitForSingleObject(client.value, hostHoldMs); return silent(pipe.value, client.value) ? 0 : 1;}
  if (mode == "v1-valid" || mode == "v1-ack-while-quiet" || mode == "v1-minor1-valid" || mode == "v1-minor2-valid") {
    // The host stays quiet until the ACK arrives; the reply proves that the relay still runs after the client frames.
    require(pipe_frame(pipe.value, client.value) == framed(file_bytes(served / "ack-1.json")));
    if (mode != "v1-ack-while-quiet") require(pipe_frame(pipe.value, client.value) == framed(file_bytes(served / "clock-probe.json")));
    auto reply = framed(file_bytes(served / "clock-reply.json")); pipe_io(pipe.value, client.value, reply.data(), static_cast<DWORD>(reply.size()), true);
  }
  // The first {1,1} frame is relayed; the {1,0} probe after it is refused by the broker and never reaches the pipe.
  if (mode == "v1-minor-changed") require(pipe_frame(pipe.value, client.value) == framed(file_bytes(served / "ack-1.json")));
  WaitForSingleObject(client.value, 10000); return silent(pipe.value, client.value) ? 0 : 1;
}
std::string indexed_uuid(unsigned prefix, unsigned index) {
  char buffer[64]{};
  std::snprintf(buffer, sizeof(buffer), "%08x-0000-4000-8000-%012x", prefix, index);
  return std::string(buffer);
}
void write_discovery_record(const fs::path& directory, const Identity& identity, const std::string& recordGame, const std::string& instanceId, DWORD pid, std::uint64_t created) {
  const auto endpoint = channel::active.pipe_prefix + recordGame + "-v0-" + identity.userTag + "-" + std::to_string(identity.session) + "-" + instanceId;
  const auto record = Json{Json::Object{
    {"schemaVersion", Json{1.0}},
    {"protocolMajor", Json{0.0}},
    {"game", Json{recordGame}},
    {"userTag", Json{identity.userTag}},
    {"windowsSessionId", Json{static_cast<double>(identity.session)}},
    {"processId", Json{static_cast<double>(pid)}},
    {"processCreationTime", Json{std::to_string(created)}},
    {"processInstanceId", Json{instanceId}},
    {"pluginSessionId", Json{std::string("11112233-4455-6677-8899-aabbccddeeff")}},
    {"pipeName", Json{endpoint}}
  }};
  write_file(directory / (instanceId + ".json"), record, identity);
}
bool disable_privilege(const wchar_t* name) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &raw)) return false;
  Handle token(raw);
  LUID luid{};
  if (!LookupPrivilegeValueW(nullptr, name, &luid)) return false;
  TOKEN_PRIVILEGES state{};
  state.PrivilegeCount = 1;
  state.Privileges[0].Luid = luid;
  state.Privileges[0].Attributes = 0;
  return AdjustTokenPrivileges(token.value, FALSE, &state, 0, nullptr, nullptr) != 0 && GetLastError() == ERROR_SUCCESS;
}
void set_process_dacl(HANDLE process, const wchar_t* sddl) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, nullptr) != 0);
  PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
  require(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) != 0 && present);
  const auto result = SetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
  LocalFree(descriptor);
  require(result == ERROR_SUCCESS);
}
void run_stale_record_sweep_cases(const fs::path& base, const std::wstring& self, const std::wstring& broker, const fs::path& fixtures, const Identity& identity, OwnerSecurity& security) {
  const auto diagnosed = [](Child& child, const std::string& stage, const std::string& error) {
    const auto diagnostic = child.diagnostic(); std::cerr << "broker diagnostic " << diagnostic;
    return std::regex_search(diagnostic, std::regex("(^|\n)diag1 " + stage + " " + error + " [0-9]{1,10} [a-z-]{1,24} [0-9]{1,10}\n$"));
  };
  const auto noOutput = [](Child& child) {DWORD available = 0; const auto peeked = PeekNamedPipe(child.output.value, nullptr, 0, nullptr, &available, nullptr); return (peeked || GetLastError() == ERROR_BROKEN_PIPE) && available == 0;};
  const auto makeTransportDir = [&](const wchar_t* name) {
    const auto directory = base / name / "transport" / "v0";
    fs::create_directory(directory.parent_path().parent_path());
    require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes) != 0);
    require(CreateDirectoryW(directory.c_str(), &security.attributes) != 0);
    return directory;
  };
  // 1) >256 stale discovery records (260 across ets2 and ats: non-existent PID, reused accessible PID, and exited process handle) plus 1 live Server record.
  {
    const auto directory = makeTransportDir(L"sweep-260");
    Child exitedChild(self, L"--verify-cases \"" + wide(case_list()) + L"\"");
    require(exitedChild.wait() == 0);
    const auto exitedCreation = creation(exitedChild.process.value);
    const auto selfCreation = creation(GetCurrentProcess());
    Child server(self, L"--host \"" + directory.wstring() + L"\" \"" + fixtures.wstring() + L"\" valid");
    require(parse(read_frame(server.output.value)).at("type").string() == "ready");
    for (unsigned index = 0; index < 260; ++index) {
      const auto id = indexed_uuid(0xdead0001u, index);
      const std::string recGame = (index % 2 == 0) ? "ets2" : "ats";
      if (index % 3 == 0) write_discovery_record(directory, identity, recGame, id, MAXDWORD, selfCreation);
      else if (index % 3 == 1) write_discovery_record(directory, identity, recGame, id, GetCurrentProcessId(), selfCreation - 1);
      else write_discovery_record(directory, identity, recGame, id, exitedChild.pid, exitedCreation);
    }
    Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"");
    const auto authority = parse(read_frame(client.output.value));
    require(authority.at("type").string() == "authority" && integer(authority.at("source").at("processId")) == server.pid);
    auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json")));
    stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
    unsigned char credit = 1;
    stdio_io(client.input.value, &credit, 1, true);
    auto welcome = v0::decode_payload(read_frame(client.output.value));
    require(welcome.kind == "welcome");
    stdio_io(client.input.value, &credit, 1, true);
    auto checkpoint = v0::decode_payload(read_frame(client.output.value));
    v0::Consumer consumer(false); consumer.accept(welcome); require(consumer.accept(checkpoint)->hydration);
    client.eof(); require(client.wait() == 3); require(server.wait() == 0);
    for (unsigned index = 0; index < 260; ++index) {
      require(!fs::exists(directory / (indexed_uuid(0xdead0001u, index) + ".json")));
    }
    require(fs::exists(directory / "00112233-4455-6677-8899-aabbccddeeff.json"));
  }
  // 2) Reused inaccessible PID (ERROR_ACCESS_DENIED) via a controlled child process with a restricted SE_KERNEL_OBJECT DACL:
  //    unowned stale record is swept; locked record (no FILE_SHARE_DELETE) or matching live creation time fails closed at stage=server-process.
  {
    // If running under an elevated token (e.g. administrator on CI or local dev), disable SeDebugPrivilege
    // so OpenProcess respects the kernel object's DACL instead of bypassing access checks.
    disable_privilege(L"SeDebugPrivilege");

    Child deniedHolder(self, L"--hold");
    require(parse(read_frame(deniedHolder.output.value)).at("type").string() == "ready");
    const DWORD deniedPid = deniedHolder.pid;
    const auto actualCreation = creation(deniedHolder.process.value);
    const auto staleCreation = actualCreation - 1;

    set_process_dacl(deniedHolder.process.value, L"D:P(D;;0x101000;;;WD)");
    const auto checkBoth = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, deniedPid);
    const auto checkBothErr = GetLastError();
    if (checkBoth) CloseHandle(checkBoth);
    require(!checkBoth && checkBothErr == ERROR_ACCESS_DENIED);
    const auto checkLimited = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, deniedPid);
    const auto checkLimitedErr = GetLastError();
    if (checkLimited) CloseHandle(checkLimited);
    require(!checkLimited && checkLimitedErr == ERROR_ACCESS_DENIED);

    const auto sweepDir = makeTransportDir(L"sweep-access-denied");
    Child server(self, L"--host \"" + sweepDir.wstring() + L"\" \"" + fixtures.wstring() + L"\" valid");
    require(parse(read_frame(server.output.value)).at("type").string() == "ready");
    const std::string staleDeniedId = "33112233-4455-6677-8899-aabbccddeeff";
    write_discovery_record(sweepDir, identity, "ets2", staleDeniedId, deniedPid, staleCreation);
    Child client(broker, L"--game ets2 --discovery-dir \"" + sweepDir.wstring() + L"\"");
    const auto authority = parse(read_frame(client.output.value));
    require(authority.at("type").string() == "authority" && integer(authority.at("source").at("processId")) == server.pid);
    auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json")));
    stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
    unsigned char credit = 1;
    stdio_io(client.input.value, &credit, 1, true);
    auto welcome = v0::decode_payload(read_frame(client.output.value));
    require(welcome.kind == "welcome");
    stdio_io(client.input.value, &credit, 1, true);
    auto checkpoint = v0::decode_payload(read_frame(client.output.value));
    v0::Consumer consumer(false); consumer.accept(welcome); require(consumer.accept(checkpoint)->hydration);
    client.eof(); require(client.wait() == 3); require(server.wait() == 0);
    require(!fs::exists(sweepDir / (staleDeniedId + ".json")));
    require(fs::exists(sweepDir / "00112233-4455-6677-8899-aabbccddeeff.json"));

    const auto lockedDir = makeTransportDir(L"locked-access-denied");
    const std::string lockedDeniedId = "44112233-4455-6677-8899-aabbccddeeff";
    write_discovery_record(lockedDir, identity, "ets2", lockedDeniedId, deniedPid, staleCreation);
    const auto lockedPath = lockedDir / (lockedDeniedId + ".json");
    Handle heldWithoutShareDelete(CreateFileW(lockedPath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Child lockedClient(broker, L"--game ets2 --discovery-dir \"" + lockedDir.wstring() + L"\"", true);
    lockedClient.eof();
    require(lockedClient.wait() == 1 && diagnosed(lockedClient, "server-process", "5") && noOutput(lockedClient) && fs::exists(lockedPath));

    set_process_dacl(deniedHolder.process.value, L"D:P(D;;0x100000;;;WD)(A;;0x1000;;;WD)");
    const auto checkSync = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, deniedPid);
    const auto checkSyncErr = GetLastError();
    if (checkSync) CloseHandle(checkSync);
    require(!checkSync && checkSyncErr == ERROR_ACCESS_DENIED);
    const auto checkQuery = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, deniedPid);
    require(checkQuery != nullptr);
    CloseHandle(checkQuery);

    const auto liveDeniedDir = makeTransportDir(L"live-access-denied");
    const std::string liveDeniedId = "55112233-4455-6677-8899-aabbccddeeff";
    write_discovery_record(liveDeniedDir, identity, "ets2", liveDeniedId, deniedPid, actualCreation);
    const auto liveDeniedPath = liveDeniedDir / (liveDeniedId + ".json");
    Child liveDeniedClient(broker, L"--game ets2 --discovery-dir \"" + liveDeniedDir.wstring() + L"\"", true);
    liveDeniedClient.eof();
    require(liveDeniedClient.wait() == 1 && diagnosed(liveDeniedClient, "server-process", "5") && noOutput(liveDeniedClient) && fs::exists(liveDeniedPath));

    deniedHolder.eof();
    require(deniedHolder.wait() == 0);
  }
  // 3) >256 non-record entries and >128 live records still fail closed at stage=discovery.
  {
    const auto nonRecordDir = makeTransportDir(L"limit-non-records");
    for (unsigned index = 0; index < 257; ++index) {
      write_file(nonRecordDir / ("non-record-" + std::to_string(index) + ".txt"), Json{Json::Object{{"index", Json{static_cast<double>(index)}}}}, identity);
    }
    Child nonRecordClient(broker, L"--game ets2 --discovery-dir \"" + nonRecordDir.wstring() + L"\"", true);
    nonRecordClient.eof();
    require(nonRecordClient.wait() == 1 && diagnosed(nonRecordClient, "discovery", "[0-9]{1,10}") && noOutput(nonRecordClient));

    const auto liveRecordDir = makeTransportDir(L"limit-live-records");
    const auto selfCreation = creation(GetCurrentProcess());
    for (unsigned index = 0; index < 129; ++index) {
      write_discovery_record(liveRecordDir, identity, "ats", indexed_uuid(0xbeef0001u, index), GetCurrentProcessId(), selfCreation);
    }
    Child liveRecordClient(broker, L"--game ets2 --discovery-dir \"" + liveRecordDir.wstring() + L"\"", true);
    liveRecordClient.eof();
    require(liveRecordClient.wait() == 1 && diagnosed(liveRecordClient, "discovery", "[0-9]{1,10}") && noOutput(liveRecordClient));
  }
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--hold") {
      receipt(Json{Json::Object{{"type", Json{std::string("ready")}}}});
      Credits cancellation;
      WaitForSingleObject(cancellation.cancelled.value, fixtureWaitMs);
      return 0;
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--discover-race") {
      discoveryCase = std::wstring(argv[3]) == L"discover-retired" ? "retired-record" : "delete-pending-record";
      wchar_t* arguments[] = {argv[0], const_cast<wchar_t*>(L"--discover"), const_cast<wchar_t*>(L"--discovery-dir"), argv[2]};
      return broker_entrypoint(4, arguments);
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--discovery-case") {
      discoveryCase = utf8(argv[3]);
      wchar_t* arguments[] = {argv[0], const_cast<wchar_t*>(L"--game"), const_cast<wchar_t*>(L"ets2"), const_cast<wchar_t*>(L"--discovery-dir"), argv[2]};
      return broker_entrypoint(5, arguments);
    }
    if (argc == 5 && std::wstring(argv[1]) == L"--host") return host(argv[2], argv[3], utf8(argv[4]));
    if (argc == 4 && std::wstring(argv[1]) == L"--capture-host") return capture_host(argv[2], utf8(argv[3]));
    if (argc == 5 && std::wstring(argv[1]) == L"--v1-host") return v1_host(argv[2], argv[3], utf8(argv[4]));
    if (argc == 3 && std::wstring(argv[1]) == L"--verify-cases") {
      const auto registered = utf8(argv[2]), actual = case_list();
      if (registered != actual) {std::cerr << "registered CTest cases differ from the fixture\nregistered " << registered << "\nfixture    " << actual << "\n"; return 1;}
      std::cout << "all " << std::count(actual.begin(), actual.end(), ',') + 1 << " fixture cases are registered\n"; return 0;
    }
    require(argc == 3); const auto broker = std::wstring(argv[1]); const fs::path fixtures(argv[2]);
    descriptor_owner_test(Identity(GetCurrentProcess()));
    wchar_t temporary[MAX_PATH]; require(GetTempPathW(MAX_PATH, temporary) != 0); // PID plus creation time: a PID alone is reused, and a directory left by a killed run (for example at a
    // CTest timeout) would then fail the exists check of an unrelated later run.
    const auto base = fs::path(temporary) / (L"ets2telemetry-client-test-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(creation(GetCurrentProcess())));
    require(!fs::exists(base)); fs::create_directory(base); TestDirectoryCleanup cleanup{base}; Identity identity(GetCurrentProcess()); OwnerSecurity security(identity);
    controlled_token_owner_test(base, identity);
    wchar_t selfName[32768]; const auto selfLength = GetModuleFileNameW(nullptr, selfName, 32768); require(selfLength > 0); const std::wstring self(selfName, selfLength);
    wchar_t filterBuffer[128]{}; const auto filterSize = GetEnvironmentVariableW(L"ETS2TELEMETRY_CLIENT_TEST_CASE", filterBuffer, 128); require(filterSize < 128); const auto filter = filterSize ? utf8(filterBuffer) : std::string();
    for (const auto* mode : discoveryCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      const std::string instance = "00112233-4455-6677-8899-aabbccddeeff";
      const auto record = directory / (instance + ".json"); const std::string scenario(mode); JunctionCleanup junction; std::optional<FixtureDaclRestore> permissionRestore;
      if (scenario == "directory-record") require(CreateDirectoryW(record.c_str(), &security.attributes));
      else if (scenario == "reparse-record") {const auto target = directory / "junction-target"; require(CreateDirectoryW(target.c_str(), &security.attributes)); junction.path = record; create_junction(record, target, identity);}
      else {
        const auto endpoint = std::string(channel::active.pipe_prefix) + "ets2-v0-" + identity.userTag + "-" + std::to_string(identity.session) + "-" + instance;
        write_file(record, Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{0.0}}, {"game", Json{std::string("ets2")}}, {"userTag", Json{identity.userTag}}, {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime", Json{std::to_string(creation(GetCurrentProcess()))}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{std::string("11112233-4455-6677-8899-aabbccddeeff")}}, {"pipeName", Json{endpoint}}}}, identity);
        if (scenario == "zero-record" || scenario == "short-record") {Handle file(CreateFileW(record.c_str(), GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)); if (scenario == "short-record") {DWORD written = 0; require(WriteFile(file.value, "{", 1, &written, nullptr) && written == 1);}}
        if (scenario == "denied-record") {
          permissionRestore.emplace(record, identity);
          PSECURITY_DESCRIPTOR descriptor = nullptr; const auto sddl = L"D:P(D;;GR;;;" + wide(identity.sid) + L")(A;;GA;;;" + wide(identity.sid) + L")";
          require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
          require(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted)); const auto result = SetNamedSecurityInfoW(const_cast<wchar_t*>(record.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr); LocalFree(descriptor); require(result == ERROR_SUCCESS);
          const auto raw = CreateFileW(record.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr); const auto error = GetLastError(); if (raw != INVALID_HANDLE_VALUE) CloseHandle(raw); require(raw == INVALID_HANDLE_VALUE && error == ERROR_ACCESS_DENIED);
          std::cerr << "actual discovery access denied observed\n";
        }
      }
      Child client(self, L"--discovery-case \"" + directory.wstring() + L"\" " + wide(mode)); DWORD expected = scenario == "retired-record" ? 2u : 1u;
      if (scenario == "delete-pending-record") {const auto observed = parse(read_frame(client.output.value)); require(observed.at("type").string() == "pending-observation"); const auto error = integer(observed.at("error")); expected = error == ERROR_FILE_NOT_FOUND || error == ERROR_DELETE_PENDING ? 2u : 1u;}
      const auto actual = client.wait(); std::cerr << "broker entrypoint exit " << actual << " expected " << expected << "\n"; require(actual == expected);
      if (expected == 2) {const auto result = parse(read_frame(client.output.value)); exact(result, {"type", "schemaVersion"}); require(result.at("type").string() == "waiting" && integer(result.at("schemaVersion")) == 1);}
      DWORD available = 0; const auto peeked = PeekNamedPipe(client.output.value, nullptr, 0, nullptr, &available, nullptr); require((peeked || GetLastError() == ERROR_BROKEN_PIPE) && available == 0);
      if (permissionRestore) require(permissionRestore->restore());
    }
    for (const auto* mode : oneShotCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode); const std::string scenario(mode);
      const bool protocolV1 = scenario == "discover-v1";
      const auto directory = base / wide(mode) / "transport" / (protocolV1 ? "v1" : "v0"); fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      std::optional<Child> ats;
      if (scenario == "discover-ats" || scenario == "discover-both") {
        const auto atsImage = fs::path(self).parent_path() / "amtrucks.exe";
        ats.emplace(atsImage.wstring(), L"--hold"); require(parse(read_frame(ats->output.value)).at("type").string() == "ready");
      }
      auto recordFor = [&](const std::string& game, DWORD pid, HANDLE process, const std::string& instance) {
        const auto endpoint = channel::active.pipe_prefix + game + (protocolV1 ? "-v1-" : "-v0-") + identity.userTag + "-" + std::to_string(identity.session) + "-" + instance;
        return Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{protocolV1 ? 1.0 : 0.0}}, {"game", Json{game}}, {"userTag", Json{identity.userTag}},
          {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"processId", Json{static_cast<double>(pid)}}, {"processCreationTime", Json{std::to_string(creation(process))}},
          {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{std::string("11112233-4455-6677-8899-aabbccddeeff")}}, {"pipeName", Json{endpoint}}}};
      };
      const std::string instance = "00112233-4455-6677-8899-aabbccddeeff", second = "22112233-4455-6677-8899-aabbccddeeff";
      const auto recordPath = directory / (instance + ".json"); JunctionCleanup junction; std::optional<FixtureDaclRestore> restore;
      if (scenario != "discover-none" && scenario != "discover-ats") {
        auto record = recordFor("ets2", GetCurrentProcessId(), GetCurrentProcess(), instance); auto& fields = std::get<Json::Object>(record.value);
        if (scenario == "discover-stale") fields["processCreationTime"] = Json{std::to_string(creation(GetCurrentProcess()) + 1)};
        if (scenario == "discover-dead") fields["processId"] = Json{static_cast<double>(MAXDWORD)};
        if (scenario == "discover-malformed") fields["extra"] = Json{true};
        if (scenario == "discover-channel") fields["pipeName"] = Json{std::string("\\\\.\\pipe\\foreign-channel")};
        write_file(recordPath, record, identity);
        if (scenario == "discover-ambiguous") write_file(directory / (second + ".json"), recordFor("ets2", GetCurrentProcessId(), GetCurrentProcess(), second), identity);
        if (scenario == "discover-reparse") {require(DeleteFileW(recordPath.c_str())); const auto target = directory / "linked"; require(CreateDirectoryW(target.c_str(), &security.attributes)); junction.path = recordPath; create_junction(recordPath, target, identity);}
        if (scenario == "discover-dacl") {
          restore.emplace(recordPath, identity); PSECURITY_DESCRIPTOR descriptor = nullptr;
          require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
          PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE; require(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted));
          const auto changed = SetNamedSecurityInfoW(const_cast<wchar_t*>(recordPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr); LocalFree(descriptor); require(changed == ERROR_SUCCESS);
        }
      }
      if (ats) write_file(directory / (second + ".json"), recordFor("ats", ats->pid, ats->process.value, second), identity);
      // No telemetry endpoint exists in any of these cases: discovery must not open or occupy it.
      const bool race = scenario == "discover-retired" || scenario == "discover-delete-pending";
      Child client(race ? self : broker, race ? L"--discover-race \"" + directory.wstring() + L"\" " + wide(mode) : L"--discover --discovery-dir \"" + directory.wstring() + L"\"" + (protocolV1 ? L" --protocol v1" : L""));
      bool rejected = scenario == "discover-malformed" || scenario == "discover-channel" || scenario == "discover-dacl" || scenario == "discover-reparse";
      if (scenario == "discover-delete-pending") {
        const auto observed = parse(read_frame(client.output.value)); require(observed.at("type").string() == "pending-observation");
        const auto error = integer(observed.at("error")); rejected = error != ERROR_FILE_NOT_FOUND && error != ERROR_DELETE_PENDING;
      }
      require(client.wait() == (rejected ? 1u : 0u));
      if (!rejected) {
        const auto result = parse(read_frame(client.output.value)); exact(result, {"type", "schemaVersion", "protocolMajor", "games"});
        require(result.at("type").string() == "discovery" && integer(result.at("schemaVersion")) == 1 && integer(result.at("protocolMajor")) == (protocolV1 ? 1u : 0u));
        const auto& games = result.at("games"); exact(games, {"ets2", "ats"});
        const bool absent = race || scenario == "discover-none" || scenario == "discover-ats" || scenario == "discover-stale" || scenario == "discover-dead";
        require(games.at("ets2").at("status").string() == (absent ? "absent" : scenario == "discover-ambiguous" ? "ambiguous" : "unique"));
        require(games.at("ats").at("status").string() == (ats ? "unique" : "absent"));
        if (!absent && scenario != "discover-ambiguous") {
          const auto& target = games.at("ets2").at("target"); exact(target, {"source", "processCreationTime", "userTag"});
          require(integer(target.at("source").at("processId")) == GetCurrentProcessId() && target.at("processCreationTime").string() == std::to_string(creation(GetCurrentProcess())) && target.at("userTag").string() == identity.userTag);
        }
        if (scenario == "discover-stale" || scenario == "discover-dead") require(!fs::exists(recordPath));
      }
      if (restore) require(restore->restore());
      if (ats) {ats->eof(); require(ats->wait() == 0);}
    }
    for (const auto* mode : hostCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      Child server(self, L"--host \"" + directory.wstring() + L"\" \"" + fixtures.wstring() + L"\" " + wide(mode));
      require(parse(read_frame(server.output.value)).at("type").string() == "ready");
      std::cerr << "host ready\n";
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"");
      const std::string scenario(mode);
      if (scenario == "creation" || scenario == "dead") {require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2); require(!fs::exists(directory / "00112233-4455-6677-8899-aabbccddeeff.json")); server.eof(); require(server.wait() == 0); continue;}
      if (scenario == "collision" || scenario == "session" || scenario == "malformed" || scenario == "dacl") {client.eof(); require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;}
      const auto authority = parse(read_frame(client.output.value)); require(authority.at("type").string() == "authority"); require(integer(authority.at("source").at("processId")) == server.pid);
      std::cerr << "authority received\n";
      auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json"))); stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
      if (scenario == "invalid-credit") {unsigned char invalid = 2; stdio_io(client.input.value, &invalid, 1, true); require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;}
      // Taken before the credit write: the broker's partial-frame deadline starts only after it receives
      // this credit, so a correct broker measures at least 5 s here however this thread is scheduled.
      const auto creditSent = GetTickCount64();
      unsigned char credit = 1; stdio_io(client.input.value, &credit, 1, true);
      if (scenario == "partial-prefix" || scenario == "partial-payload") {
        // The broker's own 5 s partial-frame deadline must end the relay: not early, and long before the
        // held host would exit.
        require(client.wait() == 3); const auto elapsed = GetTickCount64() - creditSent;
        std::cerr << "partial-frame exit after " << elapsed << " ms\n"; require(elapsed >= 4500 && elapsed < 12000);
        require(server.wait() == 0); continue;
      }
      if (scenario == "payload-break" || scenario == "bad-length") {require(client.wait() == (scenario == "bad-length" ? 1u : 3u)); require(server.wait() == 0); continue;}
      auto welcome = v0::decode_payload(read_frame(client.output.value)); require(welcome.kind == "welcome");
      Sleep(100); DWORD available = 0; require(PeekNamedPipe(client.output.value, nullptr, 0, nullptr, &available, nullptr) && available == 0);
      stdio_io(client.input.value, &credit, 1, true); auto checkpoint = v0::decode_payload(read_frame(client.output.value)); v0::Consumer consumer(false); consumer.accept(welcome); require(consumer.accept(checkpoint)->hydration);
      if (scenario == "quiet" || scenario == "quiet-exit") {
        stdio_io(client.input.value, &credit, 1, true);
        if (scenario == "quiet") {require(WaitForSingleObject(client.process.value, 5500) == WAIT_TIMEOUT); const auto started = GetTickCount64(); client.eof(); require(client.wait() == 3 && GetTickCount64() - started < 4000);} // EOF cancels promptly: well below every 5 s broker deadline.
        else require(client.wait() == 3);
        require(server.wait() == 0); continue;
      }
      client.eof(); require(client.wait() == 3); require(server.wait() == 0);
      if (scenario == "dead-live") run_stale_record_sweep_cases(base, self, broker, fixtures, identity, security);
      if (scenario == "stale-live" || scenario == "dead-live") {
        require(!fs::exists(directory / "22112233-4455-6677-8899-aabbccddeeff.json"));
        require(fs::exists(directory / "00112233-4455-6677-8899-aabbccddeeff.json"));
      }
    }
    // CAP0 broker mode: same authority checks, separate keyed endpoint, marked receipt and CAP0-only hello.
    for (const auto* mode : captureCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      const std::string scenario(mode);
      if (scenario == "capture-bad-arguments") {
        Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\" --capture cap1"); client.eof(); require(client.wait() == 1); continue;
      }
      Child server(self, L"--capture-host \"" + directory.wstring() + L"\" " + wide(mode));
      require(parse(read_frame(server.output.value)).at("type").string() == "ready");
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\" --capture cap0");
      const auto authority = parse(read_frame(client.output.value));
      exact(authority, {"type", "schemaVersion", "source", "processCreationTime", "userTag", "evidence"});
      require(authority.at("type").string() == "authority" && authority.at("evidence").string() == "cap0" && integer(authority.at("source").at("processId")) == server.pid);
      if (scenario == "capture-v0-hello") {
        auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json"))); stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
        require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;
      }
      const auto payload = ets2telemetry::cap0::hello_payload("0cab0000-0000-4000-8000-0000000000a1"); const auto n = static_cast<DWORD>(payload.size());
      unsigned char prefix[] = {static_cast<unsigned char>(n), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 24)};
      stdio_io(client.input.value, prefix, 4, true); stdio_io(client.input.value, const_cast<char*>(payload.data()), n, true);
      unsigned char credit = 1; stdio_io(client.input.value, &credit, 1, true);
      const auto relayed = parse(read_frame(client.output.value)); require(relayed.at("kind").string() == "header" && relayed.at("fixture").boolean());
      // The v0 endpoint named by the record is never opened in capture mode.
      client.eof(); require(client.wait() == 3); require(server.wait() == 0);
      std::cerr << "capture relay passed\n";
    }
    // Protocol v1 broker mode: v1 records and endpoint, a six-key receipt, a v1-only hello and the tagged control stream
    // whose client frames reach the pipe beside the relay. Fixtures are the shared protocol v1 payloads.
    const auto v1Fixtures = fixtures.parent_path() / "protocol-v1"; require(fs::exists(v1Fixtures / "hello.json"));
    const auto diagnosed = [](Child& child, const std::string& stage, const std::string& error) {
      const auto diagnostic = child.diagnostic(); std::cerr << "broker diagnostic " << diagnostic;
      return std::regex_search(diagnostic, std::regex("(^|\n)diag1 " + stage + " " + error + " [0-9]{1,10} [a-z-]{1,24} [0-9]{1,10}\n$"));
    };
    const auto noOutput = [](Child& child) {DWORD available = 0; const auto peeked = PeekNamedPipe(child.output.value, nullptr, 0, nullptr, &available, nullptr); return (peeked || GetLastError() == ERROR_BROKEN_PIPE) && available == 0;};
    for (const auto* mode : v1Cases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const auto transport = base / wide(mode) / "transport", directory = transport / "v1"; fs::create_directory(transport.parent_path());
      require(CreateDirectoryW(transport.c_str(), &security.attributes));
      const std::string scenario(mode);
      const auto v1Arguments = L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\" --protocol v1";
      if (scenario == "v1-capture-conflict") {
        // v1 is never combined with capture, and only the exact value v1 selects it.
        for (const auto* extra : {L" --protocol v1 --capture cap0", L" --capture cap0 --protocol v1", L" --protocol v2", L" --protocol"}) {
          Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"" + extra, true); client.eof();
          require(client.wait() == 1 && diagnosed(client, "arguments", "[0-9]{1,10}") && noOutput(client));
        }
        continue;
      }
      if (scenario == "v1-policy") {
        const auto v0Directory = transport / "v0"; require(CreateDirectoryW(v0Directory.c_str(), &security.attributes));
        // The plugin creates transport\v1. Until it exists the broker only reports waiting and creates nothing.
        {Child client(broker, v1Arguments); require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2);}
        require(!fs::exists(directory));
        require(CreateDirectoryW(directory.c_str(), &security.attributes));
        {Child client(broker, v1Arguments); require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2);}
        const auto policyPath = directory / "service-policy.json"; const auto written = file_bytes(policyPath); const auto policy = parse(written);
        exact(policy, {"schemaVersion", "userTag", "windowsSessionId", "allowedExecutables"});
        require(integer(policy.at("schemaVersion")) == 1 && policy.at("userTag").string() == identity.userTag && integer(policy.at("windowsSessionId")) == identity.session);
        const auto& entries = std::get<Json::Array>(policy.at("allowedExecutables").value); require(entries.size() == 1); exact(entries[0], {"path", "sha256"});
        {
          Handle brokerImage(CreateFileW(broker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr)); const auto bytes = read_bounded(brokerImage.value, 64 * 1024 * 1024);
          require(entries[0].at("path").string() == utf8(final_path(brokerImage.value)) && entries[0].at("sha256").string() == sha256(std::vector<unsigned char>(bytes.begin(), bytes.end())));
        }
        // The v0 directory is a separate policy scope; the v1 mode never writes it.
        require(fs::is_empty(v0Directory));
        for (const auto& entry : fs::directory_iterator(directory)) require(entry.path().extension() != L".tmp");
        // An identical policy is not replaced: the same file and bytes after another run.
        const auto fileIndex = [&] {
          Handle file(CreateFileW(policyPath.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
          BY_HANDLE_FILE_INFORMATION information{}; require(GetFileInformationByHandle(file.value, &information) != 0);
          return (static_cast<std::uint64_t>(information.nFileIndexHigh) << 32) | information.nFileIndexLow;
        };
        const auto before = fileIndex();
        {Child client(broker, v1Arguments); require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2);}
        require(fileIndex() == before && file_bytes(policyPath) == written);
        continue;
      }
      require(CreateDirectoryW(directory.c_str(), &security.attributes));
      Child server(self, L"--v1-host \"" + directory.wstring() + L"\" \"" + v1Fixtures.wstring() + L"\" " + wide(mode));
      require(parse(read_frame(server.output.value)).at("type").string() == "ready");
      Child client(broker, v1Arguments, true);
      if (scenario == "v1-major-mismatch" || scenario == "v1-name-mismatch" || scenario == "v1-collision") {
        // Each rejection must come from its own discovery check: a wrong major or pipe name fails while the record is
        // validated, and a second live record fails only after both passed the image check.
        client.eof(); require(client.wait() == 1 && noOutput(client) && diagnosed(client, scenario == "v1-collision" ? "server-image" : "discovery", "[0-9]{1,10}"));
        server.eof(); require(server.wait() == 0); continue;
      }
      const auto authority = parse(read_frame(client.output.value));
      exact(authority, {"type", "schemaVersion", "source", "processCreationTime", "userTag", "protocolMajor"});
      require(authority.at("type").string() == "authority" && integer(authority.at("protocolMajor")) == 1 && integer(authority.at("schemaVersion")) == 1);
      require(integer(authority.at("source").at("processId")) == server.pid && authority.at("source").at("origin").string() == "game" && authority.at("source").at("pluginSessionId").string() == "11112233-4455-6677-8899-aabbccddeeff");
      const auto send = [&](const std::string& bytes) {stdio_io(client.input.value, const_cast<char*>(bytes.data()), static_cast<DWORD>(bytes.size()), true);};
      const auto clientFrame = [](const std::string& payload) {return std::string(1, '\x02') + framed(payload);};
      const std::string credit(1, '\x01');
      if (scenario == "v1-v0-hello" || scenario == "v1-cap0-hello") {
        send(framed(scenario == "v1-v0-hello" ? file_bytes(fixtures / "hello.json") : ets2telemetry::cap0::hello_payload("0cab0000-0000-4000-8000-0000000000a1")));
        require(client.wait() == 1 && diagnosed(client, "hello", "[0-9]{1,10}")); server.eof(); require(server.wait() == 0); continue;
      }
      // ET-050b B1: the minor-1 cases offer minor 1 and use the minor-1 fixtures; the broker relays server frames opaquely.
      // ET-052: v1-minor2-valid offers minor 2 and uses the minor-2 fixtures; v1-minor2-above-offer offers minor 1.
      const bool minor1 = scenario == "v1-minor1-valid" || scenario == "v1-minor-changed" || scenario == "v1-minor2-above-offer";
      const auto served = scenario == "v1-minor2-valid" ? v1Fixtures / "minor2" : minor1 ? v1Fixtures / "minor1" : v1Fixtures;
      send(framed(file_bytes(served / "hello.json")));
      send(credit); require(v1::decode_payload(read_frame(client.output.value), v1::Sender::server, v1::highest_minor).kind == "welcome");
      Sleep(100); require(noOutput(client));
      send(credit); require(v1::decode_payload(read_frame(client.output.value), v1::Sender::server, v1::highest_minor).kind == "checkpoint");
      if (scenario == "v1-valid" || scenario == "v1-ack-while-quiet" || scenario == "v1-minor1-valid" || scenario == "v1-minor2-valid") {
        if (scenario != "v1-ack-while-quiet") send(clientFrame(file_bytes(served / "ack-1.json")) + clientFrame(file_bytes(served / "clock-probe.json")) + credit);
        // The credit first: the broker is then waiting on its pending pipe read when the ACK must still reach the quiet host.
        else {send(credit); Sleep(300); send(clientFrame(file_bytes(served / "ack-1.json")));}
        require(read_frame(client.output.value) == file_bytes(served / "clock-reply.json"));
        client.eof(); require(client.wait() == 3); require(server.wait() == 0); continue;
      }
      if (scenario == "v1-write-deadline") {
        // The host never reads the ACK: the broker's own 5 s client-write deadline must end the relay. The credit comes
        // first, so the relay waits on its pending pipe read, which has no idle deadline, instead of the 5 s credit wait.
        const auto sent = GetTickCount64(); send(credit + clientFrame(file_bytes(v1Fixtures / "ack-1.json")));
        require(client.wait() == 3); const auto elapsed = GetTickCount64() - sent;
        std::cerr << "client-write exit after " << elapsed << " ms\n"; require(elapsed >= 4500 && elapsed < 12000 && diagnosed(client, "client-write", "[0-9]{1,10}"));
        require(server.wait() == 0); continue;
      }
      if (scenario == "v1-partial-length" || scenario == "v1-partial-payload") {
        // EOF inside a record is cancellation: exit 3 at the relay stage, never client-frame, and nothing reaches the host.
        const auto payload = file_bytes(v1Fixtures / "ack-1.json"); require(payload.size() < 256);
        send(scenario == "v1-partial-length" ? std::string{'\x02', static_cast<char>(payload.size()), '\x00'} : clientFrame(payload).substr(0, 5 + payload.size() / 2));
        client.eof(); require(client.wait() == 3 && diagnosed(client, "relay", "[0-9]{1,10}")); require(server.wait() == 0); continue;
      }
      // Rejected control records: a client message of another kind, an oversize or zero length and an unknown tag.
      // ET-050b B1: a {1,1} ACK after a hello that offered only minor 0, and a {1,0} probe after a relayed {1,1} ACK.
      if (scenario == "v1-client-kind") send(clientFrame(file_bytes(v1Fixtures / "hello.json")));
      else if (scenario == "v1-minor-above-offer") send(clientFrame(file_bytes(v1Fixtures / "minor1" / "ack-1.json")));
      // ET-052: a {1,2} ACK after a hello that offered only minor 1 is refused even though the contract implements minor 2.
      else if (scenario == "v1-minor2-above-offer") send(clientFrame(file_bytes(v1Fixtures / "minor2" / "ack-1.json")));
      else if (scenario == "v1-minor-changed") send(clientFrame(file_bytes(served / "ack-1.json")) + clientFrame(file_bytes(served / "clock-probe-minor-0.json")));
      else if (scenario == "v1-client-oversize") send(std::string{'\x02', '\x01', '\x10', '\x00', '\x00'});
      else if (scenario == "v1-zero-length") send(std::string{'\x02', '\x00', '\x00', '\x00', '\x00'});
      else send(std::string(1, '\x03'));
      require(client.wait() == 1 && diagnosed(client, scenario == "v1-bad-tag" ? "relay" : "client-frame", scenario == "v1-bad-tag" ? "[0-9]{1,10}" : "0"));
      require(server.wait() == 0);
    }
    for (const auto* mode : policyCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      Json::Array entries;
      for (unsigned index = 0; index < 4; ++index) {
        const auto filename = directory / ("retired-" + std::to_string(index)) / "broker.exe";
        if (std::string(mode) != "policy-prune") {fs::create_directory(filename.parent_path()); std::ofstream output(filename, std::ios::binary); output << "fixture";}
        entries.push_back(Json{Json::Object{{"path", Json{std::string("\\\\?\\") + utf8(filename.wstring())}}, {"sha256", Json{std::string(64, '0')}}}});
      }
      if (std::string(mode) == "policy-duplicate") entries[1] = entries[0];
      if (std::string(mode) == "policy-case-duplicate") {
        entries[1] = entries[0]; auto& path = std::get<Json::Object>(entries[1].value)["path"];
        auto variant = path.string(); const auto offset = variant.find("retired-0"); require(offset != std::string::npos); variant.replace(offset, 9, "RETIRED-0"); path = Json{variant};
      }
      JunctionCleanup junction;
      if (std::string(mode) == "policy-junction") {
        const auto target = directory / "junction-target"; require(CreateDirectoryW(target.c_str(), &security.attributes) != 0);
        junction.path = directory / "junction-link"; create_junction(junction.path, target, identity);
        const auto missing = std::string("\\\\?\\") + utf8((junction.path / "missing-broker.exe").wstring());
        auto raw = CreateFileW(wide(missing).c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        const auto error = GetLastError(); require(raw == INVALID_HANDLE_VALUE && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND));
        require(!provably_missing_image(missing)); std::get<Json::Object>(entries[0].value)["path"] = Json{missing};
      }
      auto policy = Json{Json::Object{{"schemaVersion", Json{1.0}}, {"userTag", Json{identity.userTag}}, {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"allowedExecutables", Json{entries}}}};
      write_file(directory / "service-policy.json", policy, identity);
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"");
      if (std::string(mode) == "policy-prune") {
        require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2);
        const auto updated = parse(file_bytes(directory / "service-policy.json")); const auto& kept = std::get<Json::Array>(updated.at("allowedExecutables").value); require(kept.size() == 1);
        auto own = image(GetCurrentProcess());
        require(!provably_missing_image(utf8(final_path(own.value))) && !provably_missing_image("\\\\?\\UNC\\unverified-server\\share\\broker.exe"));
      } else {client.eof(); require(client.wait() == 1); require(file_bytes(directory / "service-policy.json") == v0::detail::serialize(policy));}
    }
    for (const auto* mode : contentionCases) {
      if (!filter.empty() && filter != mode) continue;
      CaseTimer timer(mode);
      const std::string scenario(mode);
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      const auto lock = directory / "service-policy.lock", policyPath = directory / "service-policy.json";
      const auto lockAccess = GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL;
      std::optional<Handle> holder; std::string before;
      if (scenario == "policy-lock-busy") holder.emplace(CreateFileW(lock.c_str(), lockAccess, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
      else if (scenario == "policy-lock-pending") {
        // The released lock stays delete-pending while another (scanner-like) handle remains open.
        Handle creator(CreateFileW(lock.c_str(), lockAccess, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
        holder.emplace(CreateFileW(lock.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
      } else if (scenario == "image-busy") {
        // Another holder with DELETE access (an updater or scanner) blocks the broker's deny-write image open, not its launch.
        holder.emplace(CreateFileW(broker.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
      } else {
        // An existing approved entry forces a replacement; the reader uses the plugin's policy share mode.
        auto own = image(GetCurrentProcess()); const auto ownPath = utf8(final_path(own.value));
        write_file(policyPath, Json{Json::Object{{"schemaVersion", Json{1.0}}, {"userTag", Json{identity.userTag}}, {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"allowedExecutables", Json{Json::Array{Json{Json::Object{{"path", Json{ownPath}}, {"sha256", Json{std::string(64, '0')}}}}}}}}}, identity);
        before = file_bytes(policyPath);
        holder.emplace(CreateFileW(policyPath.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      }
      const DWORD expectedError = scenario == "policy-lock-busy" ? ERROR_FILE_EXISTS : scenario == "image-busy" ? ERROR_SHARING_VIOLATION : ERROR_ACCESS_DENIED;
      {
        Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"", true); client.eof();
        const auto code = client.wait(); std::cerr << "contention exit " << code << "\n"; require(code == 4);
        const auto diagnostic = client.diagnostic(); std::cerr << "contention diagnostic " << diagnostic;
        const auto expectedStage = scenario == "policy-publish-busy" ? std::string("policy-publish") : scenario == "image-busy" ? std::string("own-image") : std::string("policy-lock");
        // The fixed diagnostic is the final stderr line; separate ASan fixtures emit stage traces before it.
        require(std::regex_search(diagnostic, std::regex("(^|\n)diag1 " + expectedStage + " " + std::to_string(expectedError) + " [0-9]{1,10} [a-z-]{1,24} [0-9]{1,10}\n$")));
        DWORD available = 0; const auto peeked = PeekNamedPipe(client.output.value, nullptr, 0, nullptr, &available, nullptr); require((peeked || GetLastError() == ERROR_BROKEN_PIPE) && available == 0);
        if (scenario == "policy-publish-busy") require(file_bytes(policyPath) == before); else require(!fs::exists(policyPath));
        for (const auto& entry : fs::directory_iterator(directory)) require(entry.path().extension() != L".tmp");
      }
      if (scenario != "policy-publish-busy") holder.reset();
      else {
        // Release the reader for the real update, then prove an unchanged policy is not replaced under that reader.
        holder.reset();
        Child updated(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"", true); require(parse(read_frame(updated.output.value)).at("type").string() == "waiting"); require(updated.wait() == 2);
        require(std::regex_search(updated.diagnostic(), std::regex("(^|\n)diag1 discovery 0 [0-9]{1,10} [a-z-]{1,24} [0-9]{1,10}\n$")));
        const auto current = file_bytes(policyPath); require(current != before && std::get<Json::Array>(parse(current).at("allowedExecutables").value).size() == 2);
        BY_HANDLE_FILE_INFORMATION first{}, second{};
        holder.emplace(CreateFileW(policyPath.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(GetFileInformationByHandle(holder->value, &first) != 0);
        Child unchanged(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"", true); require(parse(read_frame(unchanged.output.value)).at("type").string() == "waiting"); require(unchanged.wait() == 2);
        unchanged.diagnostic(); holder.reset();
        Handle reopened(CreateFileW(policyPath.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(GetFileInformationByHandle(reopened.value, &second) != 0);
        require(first.nFileIndexHigh == second.nFileIndexHigh && first.nFileIndexLow == second.nFileIndexLow && file_bytes(policyPath) == current);
        continue;
      }
      Child released(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\""); require(parse(read_frame(released.output.value)).at("type").string() == "waiting"); require(released.wait() == 2);
      require(fs::exists(policyPath));
    }
    if (filter.empty() || filter == "policy-readonly") {
      // A read-only policy also blocks replacement with ACCESS_DENIED, but never clears: it stays a hard rejection.
      CaseTimer timer("policy-readonly");
      const auto directory = base / L"policy-readonly" / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      const auto policyPath = directory / "service-policy.json"; auto own = image(GetCurrentProcess());
      write_file(policyPath, Json{Json::Object{{"schemaVersion", Json{1.0}}, {"userTag", Json{identity.userTag}}, {"windowsSessionId", Json{static_cast<double>(identity.session)}}, {"allowedExecutables", Json{Json::Array{Json{Json::Object{{"path", Json{utf8(final_path(own.value))}}, {"sha256", Json{std::string(64, '0')}}}}}}}}}, identity);
      const auto before = file_bytes(policyPath); require(SetFileAttributesW(policyPath.c_str(), FILE_ATTRIBUTE_READONLY) != 0);
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"", true); client.eof(); const auto code = client.wait();
      const auto diagnostic = client.diagnostic(); std::cerr << "read-only exit " << code << " diagnostic " << diagnostic;
      require(SetFileAttributesW(policyPath.c_str(), FILE_ATTRIBUTE_NORMAL) != 0);
      require(code == 1 && std::regex_search(diagnostic, std::regex("(^|\n)diag1 policy-publish 5 [0-9]{1,10} [a-z-]{1,24} [0-9]{1,10}\n$")) && file_bytes(policyPath) == before);
      for (const auto& entry : fs::directory_iterator(directory)) require(entry.path().extension() != L".tmp");
    }
    // A filter naming no case would otherwise pass without testing anything.
    if (!filter.empty() && casesRun != 1) {std::cerr << "case filter " << filter << " matched " << casesRun << " cases\n"; return 1;}
    fs::remove_all(base); std::cout << "native authority, stale lifetime filtering, hard security rejection, retryable owned-file contention, bounded partial frames, quiet-source and EOF cancellation passed\n"; return 0;
  } catch (const std::exception& error) {std::cerr << (argc == 5 ? "host: " : "controller: ") << error.what() << "\n"; return 1;}
}
