#pragma once
#include <windows.h>
#include <winrt/base.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace media {
using namespace winrt::Windows::Data::Json;
inline bool exact(JsonObject const& object, std::initializer_list<wchar_t const*> keys) {
  if (object.Size() != keys.size()) return false;
  for (auto key : keys) if (!object.HasKey(key)) return false;
  return true;
}
inline bool valid_id(std::wstring const& id) {
  if (id.size() < 2 || id.size() > 44 || id[0] != L's') return false;
  auto dash = id.find(L'-');
  if (dash == std::wstring::npos) return id.size() <= 11 && id[1] >= L'1' && id[1] <= L'9' && std::all_of(id.begin() + 1, id.end(), [](wchar_t c) {return c >= L'0' && c <= L'9';});
  return dash == 33 && id.size() > 34 && id[34] >= L'1' && id[34] <= L'9' &&
    std::all_of(id.begin() + 1, id.begin() + 33, [](wchar_t c) {return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F');}) &&
    std::all_of(id.begin() + 34, id.end(), [](wchar_t c) {return c >= L'0' && c <= L'9';});
}
struct Command {double request{}; std::wstring selected;};
inline Command command(std::string const& bytes) {
  if (bytes.size() > 1024) throw std::runtime_error("command bound");
  auto object = JsonObject::Parse(winrt::to_hstring(bytes));
  if (!exact(object, {L"version", L"type", L"requestId", L"selectedId"}) || object.GetNamedNumber(L"version") != 1 || object.GetNamedString(L"type") != L"snapshot") throw std::runtime_error("command shape");
  auto id = object.GetNamedNumber(L"requestId");
  if (id < 1 || id > 9007199254740991.0 || std::floor(id) != id) throw std::runtime_error("request id");
  std::wstring selected;
  if (object.GetNamedValue(L"selectedId").ValueType() != JsonValueType::Null) {
    selected = object.GetNamedString(L"selectedId");
    if (!valid_id(selected)) throw std::runtime_error("session id");
  }
  return {id, selected};
}
inline winrt::hstring clean(winrt::hstring const& text, size_t bound) {
  std::wstring result;
  for (wchar_t c : text) {if (c >= 32 && !(c >= 127 && c <= 159)) result += c; if (result.size() == bound) break;}
  if (!result.empty() && result.back() >= 0xd800 && result.back() <= 0xdbff) result.pop_back();
  return winrt::hstring(result);
}
inline void text(JsonObject const& object, wchar_t const* key, winrt::hstring const& value, size_t bound = 1024) {
  auto sanitized = clean(value, bound);
  object.SetNamedValue(key, sanitized.empty() ? JsonValue::CreateNullValue() : JsonValue::CreateStringValue(sanitized));
}
inline void number(JsonObject const& object, wchar_t const* key, double value) {object.SetNamedValue(key, JsonValue::CreateNumberValue(value));}
inline bool read_exact(HANDLE input, void* target, DWORD size) {
  DWORD offset = 0;
  while (offset < size) {DWORD read{}; if (!ReadFile(input, static_cast<char*>(target) + offset, size - offset, &read, nullptr) || !read) return false; offset += read;}
  return true;
}
inline bool write_exact(HANDLE output, void const* bytes, DWORD size) {
  DWORD offset = 0;
  while (offset < size) {DWORD written{}; if (!WriteFile(output, static_cast<char const*>(bytes) + offset, size - offset, &written, nullptr) || !written) return false; offset += written;}
  return true;
}
inline JsonObject response(double request) {
  JsonObject result; number(result, L"version", 1); number(result, L"requestId", request);
  result.SetNamedValue(L"type", JsonValue::CreateStringValue(L"snapshot")); result.SetNamedValue(L"sessions", JsonArray());
  result.SetNamedValue(L"selected", JsonValue::CreateNullValue()); result.SetNamedValue(L"error", JsonValue::CreateNullValue()); return result;
}
}
