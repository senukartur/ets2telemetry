// Fixed read-only inspection of an authenticated target. The parent owns the two-second child deadline.
struct ProfileCom {
  ProfileCom() {if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) fail();}
  ~ProfileCom() {CoUninitialize();}
};
struct ProfileBstr {
  BSTR value;
  explicit ProfileBstr(const wchar_t* text) : value(SysAllocString(text)) {if (!value) fail();}
  ~ProfileBstr() {SysFreeString(value);}
};
std::wstring profile_command_line(DWORD pid) {
#ifdef ETS2TELEMETRY_PROFILE_PROCESS_TEST
  if (auto injected = profile_test_command_line(pid)) return *injected;
#endif
  ProfileCom apartment;
  const auto security = CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE, nullptr);
  if (FAILED(security)) fail();
  Microsoft::WRL::ComPtr<IWbemLocator> locator;
  if (FAILED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(locator.GetAddressOf())))) fail();
  Microsoft::WRL::ComPtr<IWbemServices> services;
  ProfileBstr root(L"ROOT\\CIMV2");
  if (FAILED(locator->ConnectServer(root.value, nullptr, nullptr, nullptr, 0, nullptr, nullptr, services.GetAddressOf()))) fail();
  if (FAILED(CoSetProxyBlanket(services.Get(), RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE))) fail();
  const auto query = L"SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + std::to_wstring(pid);
  ProfileBstr language(L"WQL"), statement(query.c_str());
  Microsoft::WRL::ComPtr<IEnumWbemClassObject> results;
  // Exactly one query per attempt. Forward-only semisynchronous enumeration has a finite wait.
  if (FAILED(services->ExecQuery(language.value, statement.value, WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr, results.GetAddressOf()))) fail();
  Microsoft::WRL::ComPtr<IWbemClassObject> row; ULONG count = 0;
  const auto status = results->Next(1000, 1, row.GetAddressOf(), &count);
  if (status != WBEM_S_NO_ERROR || count != 1 || !row) fail();
  VARIANT value; VariantInit(&value);
  const auto fetched = row->Get(L"CommandLine", 0, &value, nullptr, nullptr);
  if (FAILED(fetched) || value.vt != VT_BSTR || !value.bstrVal || !SysStringLen(value.bstrVal) || SysStringLen(value.bstrVal) > 32768) {VariantClear(&value); fail();}
  const std::wstring command(value.bstrVal, SysStringLen(value.bstrVal)); VariantClear(&value);
  if (command.find(L'\0') != std::wstring::npos) fail();
  return command;
}
Json profile_home_directory(const std::wstring& command) {
  if (command.empty()) fail();
  int count = 0; auto raw = CommandLineToArgvW(command.c_str(), &count); if (!raw) fail();
  const std::unique_ptr<wchar_t*, decltype(&LocalFree)> arguments(raw, LocalFree);
  Json result{nullptr}; bool found = false;
  for (int index = 1; index < count; ++index) {
    if (_wcsicmp(raw[index], L"-homedir") != 0) continue;
    if (found || ++index >= count) fail(); found = true;
    const std::wstring directory(raw[index]);
    if (directory.empty() || directory.size() > 4096 || !fs::path(directory).is_absolute()) fail();
    result = Json{utf8(directory)};
  }
  return result;
}
void inspect_profile_process() {
  unsigned char prefix[4]; if (!read_control(prefix, 4)) fail();
  const auto length = frame_length(prefix); if (!length || length > 16384) fail();
  std::string bytes(length, '\0'); if (!read_control(reinterpret_cast<unsigned char*>(bytes.data()), length)) fail();
  unsigned char trailing = 0; if (read_control(&trailing, 1)) fail();
  const auto target = parse(bytes); exact(target, {"source", "processCreationTime", "userTag"});
  const auto& source = target.at("source"); exact(source, {"game", "origin", "processId", "windowsSessionId", "processInstanceId", "pluginSessionId"});
  const auto game = source.at("game").string();
  if ((game != "ets2" && game != "ats") || source.at("origin").string() != "game" || !uuid(source.at("processInstanceId").string()) || !uuid(source.at("pluginSessionId").string())) fail();
  const auto pid = integer(source.at("processId")), expectedSession = integer(source.at("windowsSessionId")); if (!pid) fail();
  const auto expectedCreation = v0::parse_uint64(target.at("processCreationTime"));
  Identity self(GetCurrentProcess());
  if (target.at("userTag").string() != self.userTag || expectedSession != self.session) fail();
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  auto validate = [&] {
    if (stale_process(process.value, expectedCreation)) fail();
    Identity peer(process.value); if (peer.sid != self.sid || peer.session != expectedSession) fail();
    auto executable = image(process.value);
    if (_wcsicmp(fs::path(final_path(executable.value)).filename().c_str(), game == "ets2" ? L"eurotrucks2.exe" : L"amtrucks.exe") != 0) fail();
    return executable;
  };
  auto executable = validate();
  const auto home = profile_home_directory(profile_command_line(pid));
  auto checked = validate(); if (!same_file(executable.value, checked.value)) fail();
  receipt(Json{Json::Object{{"type", Json{std::string("profile-process")}}, {"schemaVersion", Json{1.0}}, {"target", target},
    {"executable", Json{utf8(fs::path(final_path(executable.value)).wstring())}}, {"homeDirectory", home}}}, 16384);
}
