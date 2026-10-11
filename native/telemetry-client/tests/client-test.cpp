// This is an isolated console fixture named eurotrucks2.exe; it never launches or touches a game.
#define wmain broker_entrypoint
#include "../src/client.cpp"
#undef wmain
#include <fstream>
#include <iostream>
void require(bool value) {if (!value) throw std::runtime_error("Native client test assertion failed");}
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
int host(const fs::path& directory, const fs::path& fixtures, const std::string& mode) {
  Identity self(GetCurrentProcess()); OwnerSecurity security(self);
  const std::string instance = "00112233-4455-6677-8899-aabbccddeeff", plugin = "11112233-4455-6677-8899-aabbccddeeff";
  const auto endpoint = "\\\\.\\pipe\\ETS2Telemetry-ets2-v0-" + self.userTag + "-" + std::to_string(self.session) + "-" + instance;
  Handle pipe(CreateNamedPipeW(wide(endpoint).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65540, 65540, 0, &security.attributes));
  Json source{Json::Object{{"game", Json{std::string("ets2")}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"origin", Json{std::string("game")}}}};
  auto record = Json{Json::Object{{"schemaVersion", Json{1.0}}, {"protocolMajor", Json{0.0}}, {"game", Json{std::string("ets2")}}, {"userTag", Json{self.userTag}}, {"windowsSessionId", Json{static_cast<double>(self.session)}}, {"processId", Json{static_cast<double>(GetCurrentProcessId())}}, {"processCreationTime", Json{std::to_string(creation(GetCurrentProcess()) + (mode == "creation" ? 1 : 0))}}, {"processInstanceId", Json{instance}}, {"pluginSessionId", Json{plugin}}, {"pipeName", Json{endpoint}}}};
  if (mode == "session") std::get<Json::Object>(record.value)["windowsSessionId"] = Json{static_cast<double>(self.session + 1)};
  if (mode == "malformed") std::get<Json::Object>(record.value)["unexpected"] = Json{false};
  const auto recordPath = directory / (instance + ".json"); write_file(recordPath, record, self);
  if (mode == "dacl") {
    PSECURITY_DESCRIPTOR descriptor = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)", SDDL_REVISION_1, &descriptor, nullptr));
    PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE; require(GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted));
    require(SetNamedSecurityInfoW(const_cast<wchar_t*>(recordPath.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS); LocalFree(descriptor);
  }
  if (mode == "collision") {std::get<Json::Object>(record.value)["processInstanceId"] = Json{std::string("22112233-4455-6677-8899-aabbccddeeff")}; write_file(directory / "22112233-4455-6677-8899-aabbccddeeff.json", record, self);}
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
  for (const auto* filename : {"welcome.json", "checkpoint.json"}) {
    auto message = parse(file_bytes(fixtures / filename)); auto& object = std::get<Json::Object>(message.value); object["source"] = source;
    if (std::string(filename) == "welcome.json") std::get<Json::Object>(object["data"].value)["diagnostics"] = Json{false};
    const auto frame = v0::encode_frame(v0::decode_payload(v0::detail::serialize(message)));
    pipe_io(pipe.value, client.value, const_cast<unsigned char*>(frame.data()), static_cast<DWORD>(frame.size()), true);
  }
  // Remain connected until the owned client exits or cancels while waiting for the next frame.
  WaitForSingleObject(client.value, 5000); return 0;
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 5 && std::wstring(argv[1]) == L"--host") return host(argv[2], argv[3], utf8(argv[4]));
    require(argc == 3); const auto broker = std::wstring(argv[1]); const fs::path fixtures(argv[2]);
    wchar_t temporary[MAX_PATH]; require(GetTempPathW(MAX_PATH, temporary) != 0); const auto base = fs::path(temporary) / (L"ets2telemetry-client-test-" + std::to_wstring(GetCurrentProcessId()));
    require(!fs::exists(base)); fs::create_directory(base); Identity identity(GetCurrentProcess()); OwnerSecurity security(identity);
    wchar_t selfName[32768]; const auto selfLength = GetModuleFileNameW(nullptr, selfName, 32768); require(selfLength > 0); const std::wstring self(selfName, selfLength);
    for (const auto* mode : {"valid", "creation", "collision", "session", "malformed", "dacl"}) {
      std::cerr << "case " << mode << "\n";
      const auto directory = base / wide(mode) / "transport" / "v0"; fs::create_directory(directory.parent_path().parent_path());
      require(CreateDirectoryW(directory.parent_path().c_str(), &security.attributes)); require(CreateDirectoryW(directory.c_str(), &security.attributes));
      Child server(self, L"--host \"" + directory.wstring() + L"\" \"" + fixtures.wstring() + L"\" " + wide(mode));
      require(parse(read_frame(server.output.value)).at("type").string() == "ready");
      std::cerr << "host ready\n";
      Child client(broker, L"--game ets2 --discovery-dir \"" + directory.wstring() + L"\"");
      if (std::string(mode) != "valid") {client.eof(); require(client.wait() == 1); server.eof(); require(server.wait() == 0); continue;}
      const auto authority = parse(read_frame(client.output.value)); require(authority.at("type").string() == "authority"); require(integer(authority.at("source").at("processId")) == server.pid);
      std::cerr << "authority received\n";
      auto hello = v0::encode_frame(v0::decode_payload(file_bytes(fixtures / "hello.json"))); stdio_io(client.input.value, hello.data(), static_cast<DWORD>(hello.size()), true);
      unsigned char credit = 1; stdio_io(client.input.value, &credit, 1, true); auto welcome = v0::decode_payload(read_frame(client.output.value)); require(welcome.kind == "welcome");
      Sleep(100); DWORD available = 0; require(PeekNamedPipe(client.output.value, nullptr, 0, nullptr, &available, nullptr) && available == 0);
      stdio_io(client.input.value, &credit, 1, true); auto checkpoint = v0::decode_payload(read_frame(client.output.value)); v0::Consumer consumer(false); consumer.accept(welcome); require(consumer.accept(checkpoint)->hydration);
      client.eof(); require(client.wait() == 3); require(server.wait() == 0);
    }
    fs::remove_all(base); std::cout << "native authority, collision, creation mismatch, frame credits and EOF cancellation passed\n"; return 0;
  } catch (const std::exception& error) {std::cerr << (argc == 5 ? "host: " : "controller: ") << error.what() << "\n"; return 1;}
}
