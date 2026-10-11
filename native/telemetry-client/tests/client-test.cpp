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
struct Child {
  Handle process, input, output; DWORD pid = 0;
  Child(const std::wstring& executable, const std::wstring& arguments) {
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE}; HANDLE inRead = nullptr, inWrite = nullptr, outRead = nullptr, outWrite = nullptr;
    require(CreatePipe(&inRead, &inWrite, &attributes, 0) != 0); Handle childInput(inRead); input.value = inWrite;
    require(CreatePipe(&outRead, &outWrite, &attributes, 0) != 0); Handle childOutput(outWrite); output.value = outRead;
    require(SetHandleInformation(input.value, HANDLE_FLAG_INHERIT, 0) && SetHandleInformation(output.value, HANDLE_FLAG_INHERIT, 0));
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = childInput.value; startup.hStdOutput = childOutput.value; startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION information{}; auto command = L"\"" + executable + L"\" " + arguments;
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &information) != 0);
    process.value = information.hProcess; pid = information.dwProcessId; CloseHandle(information.hThread);
  }
  void eof() {if (input.value != INVALID_HANDLE_VALUE) {CloseHandle(input.value); input.value = INVALID_HANDLE_VALUE;}}
  DWORD wait() {require(WaitForSingleObject(process.value, 6000) == WAIT_OBJECT_0); DWORD code = 0; require(GetExitCodeProcess(process.value, &code) != 0); return code;}
  ~Child() {
    eof();
    // Only this exact owned handle is terminated on a failed assertion; never enumerate host processes.
    if (WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {TerminateProcess(process.value, 90); WaitForSingleObject(process.value, 2000);}
  }
};
std::string read_frame(HANDLE pipe) {
  unsigned char prefix[4]; stdio_io(pipe, prefix, 4, false); const auto length = frame_length(prefix); require(length > 0 && length <= 65536);
  std::string bytes(length, '\0'); stdio_io(pipe, bytes.data(), length, false); return bytes;
}
void write_file(const fs::path& filename, const Json& value, const Identity& identity) {
  OwnerSecurity security(identity); Handle file(CreateFileW(filename.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  auto encoded = v0::detail::serialize(value); DWORD written = 0; require(WriteFile(file.value, encoded.data(), static_cast<DWORD>(encoded.size()), &written, nullptr) && written == encoded.size());
}
std::string file_bytes(const fs::path& filename) {std::ifstream input(filename, std::ios::binary); return std::string(std::istreambuf_iterator<char>(input), {});}
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
  const auto endpoint = "\\\\.\\pipe\\ETS2Telemetry-ets2-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + instance;
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
  if (WaitForMultipleObjects(2, waits, FALSE, 5000) != WAIT_OBJECT_0) {test_trace("host-no-client"); CancelIoEx(pipe.value, &operation); DWORD ignored = 0; GetOverlappedResult(pipe.value, &operation, &ignored, TRUE); return 0;}
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
    if (mode != "payload-break") WaitForSingleObject(client.value, 10000);
    return 0;
  }
  for (const auto* filename : {"welcome.json", "checkpoint.json"}) {
    auto message = parse(file_bytes(fixtures / filename)); auto& object = std::get<Json::Object>(message.value); object["source"] = source;
    if (std::string(filename) == "welcome.json") std::get<Json::Object>(object["data"].value)["diagnostics"] = Json{false};
    const auto frame = v0::encode_frame(v0::decode_payload(v0::detail::serialize(message)));
    pipe_io(pipe.value, client.value, const_cast<unsigned char*>(frame.data()), static_cast<DWORD>(frame.size()), true);
  }
  // Remain connected until the owned client exits or cancels while waiting for the next frame.
  WaitForSingleObject(client.value, mode == "quiet-exit" ? 5500 : 10000); return 0;
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 4 && std::wstring(argv[1]) == L"--discovery-case") {
      discoveryCase = utf8(argv[3]);
      wchar_t* arguments[] = {argv[0], const_cast<wchar_t*>(L"--game"), const_cast<wchar_t*>(L"ets2"), const_cast<wchar_t*>(L"--discovery-dir"), argv[2]};
      return broker_entrypoint(5, arguments);
    }
    if (argc == 5 && std::wstring(argv[1]) == L"--host") return host(argv[2], argv[3], utf8(argv[4]));
    require(argc == 3); const auto broker = std::wstring(argv[1]); const fs::path fixtures(argv[2]);
    descriptor_owner_test(Identity(GetCurrentProcess()));
    wchar_t temporary[MAX_PATH]; require(GetTempPathW(MAX_PATH, temporary) != 0); const auto base = fs::path(temporary) / (L"ets2telemetry-client-test-" + std::to_wstring(GetCurrentProcessId()));
    require(!fs::exists(base)); fs::create_directory(base); TestDirectoryCleanup cleanup{base}; Identity identity(GetCurrentProcess()); OwnerSecurity security(identity);
    controlled_token_owner_test(base, identity);
    wchar_t selfName[32768]; const auto selfLength = GetModuleFileNameW(nullptr, selfName, 32768); require(selfLength > 0); const std::wstring self(selfName, selfLength);
    wchar_t filterBuffer[128]{}; const auto filterSize = GetEnvironmentVariableW(L"ETS2TELEMETRY_CLIENT_TEST_CASE", filterBuffer, 128); require(filterSize < 128); const auto filter = filterSize ? utf8(filterBuffer) : std::string();
    for (const auto* mode : {"retired-record", "delete-pending-record", "denied-record", "zero-record", "short-record", "directory-record", "reparse-record"}) {
      if (!filter.empty() && filter != mode) continue;
      std::cerr << "case " << mode << "\n";
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      const std::string instance = "00112233-4455-6677-8899-aabbccddeeff";
      const auto record = directory / (instance + ".json"); const std::string scenario(mode); JunctionCleanup junction; std::optional<FixtureDaclRestore> permissionRestore;
      if (scenario == "directory-record") require(CreateDirectoryW(record.c_str(), &security.attributes));
      else if (scenario == "reparse-record") {const auto target = directory / "junction-target"; require(CreateDirectoryW(target.c_str(), &security.attributes)); junction.path = record; create_junction(record, target, identity);}
      else {
        const auto endpoint = "\\\\.\\pipe\\ETS2Telemetry-ets2-v0-" + identity.userTag + "-" + std::to_string(identity.session) + "-" + instance;
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
    for (const auto* mode : {"valid", "creation", "dead", "stale-live", "dead-live", "collision", "session", "malformed", "dacl", "payload-break", "bad-length", "invalid-credit", "quiet", "quiet-exit", "partial-prefix", "partial-payload"}) {
      if (!filter.empty() && filter != mode) continue;
      std::cerr << "case " << mode << "\n";
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      Child server(self, L"--host \"" + directory.wstring() + L"\" \"" + fixtures.wstring() + L"\" " + wide(mode));
      require(parse(read_frame(server.output.value)).at("type").string() == "ready");
      std::cerr << "host ready\n";
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"");
      const std::string scenario(mode);
      if (scenario == "creation" || scenario == "dead") {require(parse(read_frame(client.output.value)).at("type").string() == "waiting"); require(client.wait() == 2); server.eof(); require(server.wait() == 0); continue;}
      if (scenario == "collision" || scenario == "session" || scenario == "malformed" || scenario == "dacl") {client.eof(); require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;}
      const auto authority = parse(read_frame(client.output.value)); require(authority.at("type").string() == "authority"); require(integer(authority.at("source").at("processId")) == server.pid);
      std::cerr << "authority received\n";
      auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json"))); stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
      if (scenario == "invalid-credit") {unsigned char invalid = 2; stdio_io(client.input.value, &invalid, 1, true); require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;}
      unsigned char credit = 1; stdio_io(client.input.value, &credit, 1, true);
      if (scenario == "payload-break" || scenario == "partial-prefix" || scenario == "partial-payload" || scenario == "bad-length") {require(client.wait() == (scenario == "bad-length" ? 1u : 3u)); require(server.wait() == 0); continue;}
      auto welcome = v0::decode_payload(read_frame(client.output.value)); require(welcome.kind == "welcome");
      Sleep(100); DWORD available = 0; require(PeekNamedPipe(client.output.value, nullptr, 0, nullptr, &available, nullptr) && available == 0);
      stdio_io(client.input.value, &credit, 1, true); auto checkpoint = v0::decode_payload(read_frame(client.output.value)); v0::Consumer consumer(false); consumer.accept(welcome); require(consumer.accept(checkpoint)->hydration);
      if (scenario == "quiet" || scenario == "quiet-exit") {
        stdio_io(client.input.value, &credit, 1, true);
        if (scenario == "quiet") {require(WaitForSingleObject(client.process.value, 5500) == WAIT_TIMEOUT); const auto started = GetTickCount64(); client.eof(); require(client.wait() == 3 && GetTickCount64() - started < 2000);}
        else require(client.wait() == 3);
        require(server.wait() == 0); continue;
      }
      client.eof(); require(client.wait() == 3); require(server.wait() == 0);
    }
    for (const auto* mode : {"policy-prune", "policy-cap", "policy-duplicate", "policy-case-duplicate", "policy-junction"}) {
      if (!filter.empty() && filter != mode) continue;
      std::cerr << "case " << mode << "\n";
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
    fs::remove_all(base); std::cout << "native authority, stale lifetime filtering, hard security rejection, bounded partial frames, quiet-source and EOF cancellation passed\n"; return 0;
  } catch (const std::exception& error) {std::cerr << (argc == 5 ? "host: " : "controller: ") << error.what() << "\n"; return 1;}
}
