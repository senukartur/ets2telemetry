#include "pipe-discovery.hpp"
#include "protocol-json.hpp"
#include <set>
#include <stdexcept>

namespace ets2telemetry::transport {
namespace {
using J = v0::Json;
[[noreturn]] void fail() { throw std::runtime_error("discovery-policy"); }
std::wstring widen(const std::string& s) {
  const auto n = MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),nullptr,0); if (n <= 0) fail();
  std::wstring w(static_cast<std::size_t>(n),L'\0'); if (!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),w.data(),n)) fail(); return w;
}
std::string narrow(const std::wstring& s) {
  const auto n = WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),nullptr,0,nullptr,nullptr); if (n <= 0) fail();
  std::string a(static_cast<std::size_t>(n),'\0'); if (!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),a.data(),n,nullptr,nullptr)) fail(); return a;
}
void keys(const J& j, std::initializer_list<const char*> expected) {
  const auto* o = std::get_if<J::Object>(&j.value); if (!o || o->size() != expected.size()) fail(); for (auto key : expected) if (!o->count(key)) fail();
}
std::string bounded_file(HANDLE f, std::size_t limit) {
  FILE_ATTRIBUTE_TAG_INFO info{}; LARGE_INTEGER size{};
  if (!GetFileInformationByHandleEx(f,FileAttributeTagInfo,&info,sizeof(info)) || info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) || !GetFileSizeEx(f,&size) || size.QuadPart < 1 || static_cast<std::uint64_t>(size.QuadPart) > limit) fail();
  std::string result(static_cast<std::size_t>(size.QuadPart),'\0'); DWORD read = 0;
  if (!ReadFile(f,result.data(),static_cast<DWORD>(result.size()),&read,nullptr) || read != result.size()) fail(); return result;
}
}
std::wstring endpoint_name(const sdk::Snapshot& s, const UserIdentity& user) {
  return L"\\\\.\\pipe\\ETS2Telemetry-" + widen(s.identity.game.c_str()) + L"-v0-" + widen(user.tag) + L"-" + std::to_wstring(user.session) + L"-" + widen(s.identity.process_instance_id.c_str());
}
std::vector<AllowedPeer> read_service_policy(const std::wstring& directory, const OwnerSecurity& security, const UserIdentity& user) {
  security.verify_owner_only(directory);
  Handle file(CreateFileW((directory + L"\\service-policy.json").c_str(),GENERIC_READ | READ_CONTROL,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if (!file) fail(); security.verify_handle(file.get()); const auto bytes = bounded_file(file.get(),16384); const auto j = v0::detail::Parser(bytes).parse();
  keys(j,{"schemaVersion","userTag","windowsSessionId","allowedExecutables"});
  if (j.at("schemaVersion").number() != 1 || j.at("userTag").string() != user.tag || j.at("windowsSessionId").number() != user.session) fail();
  const auto* array = std::get_if<J::Array>(&j.at("allowedExecutables").value); if (!array || array->empty() || array->size() > 4) fail();
  std::vector<AllowedPeer> result; std::set<std::wstring> paths;
  for (const auto& e : *array) {
    keys(e,{"path","sha256"}); const auto& path = e.at("path").string(); const auto& digest = e.at("sha256").string();
    if (path.size() < 7 || path.size() > 4096 || path.substr(0,4) != "\\\\?\\" || path[5] != ':' || path[6] != '\\' || digest.size() != 64) fail();
    for (auto c : path) if (static_cast<unsigned char>(c) < 32 || c == 127) fail();
    for (auto c : digest) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) fail();
    AllowedPeer allowed; allowed.image = widen(path); allowed.sha256 = digest; if (!paths.emplace(allowed.image).second) fail(); result.push_back(std::move(allowed));
  }
  return result;
}
Discovery::Discovery(const std::wstring& directory, const OwnerSecurity& security, const UserIdentity& user, const sdk::Snapshot& s, const std::wstring& pipe) {
  security.verify_owner_only(directory); path_ = directory + L"\\" + widen(s.identity.process_instance_id.c_str()) + L".json";
  const auto temporary = path_ + L"." + widen(s.identity.plugin_session_id.c_str()) + L".tmp";
  J record{J::Object{{"schemaVersion",J{1.0}}, {"protocolMajor",J{0.0}}, {"game",J{std::string(s.identity.game.c_str())}}, {"userTag",J{user.tag}},
    {"windowsSessionId",J{static_cast<double>(user.session)}}, {"processId",J{static_cast<double>(s.identity.process_id)}},
    {"processCreationTime",J{std::to_string(creation_time(GetCurrentProcess()))}}, {"processInstanceId",J{std::string(s.identity.process_instance_id.c_str())}},
    {"pluginSessionId",J{std::string(s.identity.plugin_session_id.c_str())}}, {"pipeName",J{narrow(pipe)}}}};
  const auto bytes = v0::detail::serialize(record); if (bytes.size() > 4096) fail();
  Handle file(CreateFileW(temporary.c_str(),GENERIC_WRITE | DELETE,FILE_SHARE_READ,security.attributes(),CREATE_NEW,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if (!file) fail();
  try {
    DWORD written = 0; if (!WriteFile(file.get(),bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr) || written != bytes.size() || !FlushFileBuffers(file.get())) fail();
    const auto length = path_.size() * sizeof(wchar_t); std::vector<unsigned char> rename(sizeof(FILE_RENAME_INFO) + length);
    auto* info = reinterpret_cast<FILE_RENAME_INFO*>(rename.data()); info->ReplaceIfExists = FALSE; info->RootDirectory = nullptr; info->FileNameLength = static_cast<DWORD>(length); memcpy(info->FileName,path_.data(),length);
    if (!SetFileInformationByHandle(file.get(),FileRenameInfo,info,static_cast<DWORD>(rename.size()))) fail();
    owned_ = std::move(file);
  } catch (...) { FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(file.get(),FileDispositionInfo,&remove,sizeof(remove)); throw; }
}
Discovery::~Discovery() {
  // Held DELETE authority identifies exactly our file even if a name is later reused.
  if (owned_) { FILE_DISPOSITION_INFO remove{TRUE}; SetFileInformationByHandle(owned_.get(),FileDispositionInfo,&remove,sizeof(remove)); }
}
}
