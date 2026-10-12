#pragma once
#include "protocol-json.hpp"
#include <regex>
#include <string>

// CAP0 opt-in hello shared by the plugin capture endpoint and the native broker. It depends on
// the bounded strict JSON parser only, never on the frozen v0 message schema.
namespace ets2telemetry::cap0 {
constexpr std::size_t max_packet_bytes = 65536;
constexpr std::size_t max_hello_bytes = 4096;
constexpr const char* format = "ets2telemetry-cap0";

inline bool canonical_uuid(const std::string& text) {
  return std::regex_match(text, std::regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
}
// Returns the capture session UUID or throws v0::ProtocolError. Unknown/duplicate keys are rejected.
inline std::string validate_hello(const std::string& payload) {
  using v0::Json; using v0::ProtocolError;
  if (payload.empty() || payload.size() > max_hello_bytes) throw ProtocolError("cap0-hello-size");
  const auto root = v0::detail::Parser(payload).parse();
  auto exact = [](const Json& value, std::initializer_list<const char*> keys) -> const Json::Object& {
    const auto* object = std::get_if<Json::Object>(&value.value);
    if (!object || object->size() != keys.size()) throw ProtocolError("cap0-hello-shape");
    for (auto key : keys) if (!object->count(key)) throw ProtocolError("cap0-hello-shape");
    return *object;
  };
  exact(root, {"format", "version", "kind", "captureSessionId", "data"});
  if (root.at("format").string() != format || root.at("kind").string() != "hello") throw ProtocolError("cap0-hello-kind");
  exact(root.at("version"), {"major", "minor"});
  if (root.at("version").at("major").number() != 0 || root.at("version").at("minor").number() != 0) throw ProtocolError("cap0-hello-version");
  exact(root.at("data"), {"evidenceOnly"});
  if (!root.at("data").at("evidenceOnly").boolean()) throw ProtocolError("cap0-hello-opt-in");
  const auto& session = root.at("captureSessionId").string();
  if (!canonical_uuid(session)) throw ProtocolError("cap0-hello-session");
  return session;
}
inline std::string hello_payload(const std::string& capture_session_id) {
  return std::string("{\"format\":\"") + format + "\",\"version\":{\"major\":0,\"minor\":0},\"kind\":\"hello\",\"captureSessionId\":\"" + capture_session_id + "\",\"data\":{\"evidenceOnly\":true}}";
}
}
