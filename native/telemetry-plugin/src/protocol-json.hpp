#pragma once
#include "protocol-v0.hpp"
#include <charconv>
#include <cmath>
#include <iomanip>
#include <locale>
#include <sstream>
#include <string_view>

namespace ets2telemetry::v0::detail {
[[noreturn]] inline void fail() { throw ProtocolError("Invalid protocol v0 message"); }
inline void utf8(const std::string& s) {
  for (std::size_t i = 0; i < s.size();) {
    auto lead = static_cast<unsigned char>(s[i++]);
    if (lead < 0x80) continue;
    unsigned remaining = 0, scalar = 0, minimum = 0;
    if (lead >= 0xc2 && lead <= 0xdf) { remaining = 1; scalar = lead & 0x1f; minimum = 0x80; }
    else if (lead >= 0xe0 && lead <= 0xef) { remaining = 2; scalar = lead & 0xf; minimum = 0x800; }
    else if (lead >= 0xf0 && lead <= 0xf4) { remaining = 3; scalar = lead & 7; minimum = 0x10000; }
    else fail();
    if (s.size() - i < remaining) fail();
    while (remaining--) { auto c = static_cast<unsigned char>(s[i++]); if ((c & 0xc0) != 0x80) fail(); scalar = (scalar << 6) | (c & 0x3f); }
    if (scalar < minimum || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) fail();
  }
}
inline void append_scalar(std::string& s, unsigned c) {
  if (c < 0x80) s += static_cast<char>(c);
  else if (c < 0x800) { s += static_cast<char>(0xc0 | (c >> 6)); s += static_cast<char>(0x80 | (c & 63)); }
  else if (c < 0x10000) { s += static_cast<char>(0xe0 | (c >> 12)); s += static_cast<char>(0x80 | ((c >> 6) & 63)); s += static_cast<char>(0x80 | (c & 63)); }
  else { s += static_cast<char>(0xf0 | (c >> 18)); s += static_cast<char>(0x80 | ((c >> 12) & 63)); s += static_cast<char>(0x80 | ((c >> 6) & 63)); s += static_cast<char>(0x80 | (c & 63)); }
}
class Parser {
 public:
  explicit Parser(const std::string& s) : s_(s) { utf8(s); }
  Json parse() { auto result = value(0); ws(); if (p_ != s_.size()) fail(); return result; }
 private:
  const std::string& s_; std::size_t p_ = 0;
  char peek() const { return p_ < s_.size() ? s_[p_] : '\0'; }
  char take() { if (p_ >= s_.size()) fail(); return s_[p_++]; }
  void ws() { while (peek() == ' ' || peek() == '\r' || peek() == '\n' || peek() == '\t') ++p_; }
  unsigned hex4() {
    unsigned v = 0;
    for (unsigned i = 0; i < 4; ++i) { char c = take(); unsigned digit;
      if (c >= '0' && c <= '9') digit = static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') digit = static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') digit = static_cast<unsigned>(c - 'A' + 10); else { fail(); }
      v = v * 16 + digit;
    } return v;
  }
  std::string string() {
    if (take() != '"') fail(); std::string result;
    for (;;) {
      char c = take(); if (c == '"') return result;
      if (static_cast<unsigned char>(c) < 32) fail();
      if (c != '\\') { result += c; continue; }
      switch (take()) {
        case '"': result += '"'; break; case '\\': result += '\\'; break; case '/': result += '/'; break;
        case 'b': result += '\b'; break; case 'f': result += '\f'; break; case 'n': result += '\n'; break;
        case 'r': result += '\r'; break; case 't': result += '\t'; break;
        case 'u': {
          unsigned code = hex4();
          if (code >= 0xd800 && code <= 0xdbff) {
            if (take() != '\\' || take() != 'u') fail(); unsigned low = hex4();
            if (low < 0xdc00 || low > 0xdfff) fail(); code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
          } else if (code >= 0xdc00 && code <= 0xdfff) fail();
          append_scalar(result, code); break;
        }
        default: fail();
      }
    }
  }
  Json value(unsigned depth) {
    if (depth > max_json_depth) fail(); ws(); char c = peek();
    if (c == '"') return Json{string()};
    if (c == '{') {
      take(); ws(); Json::Object o; if (peek() == '}') { take(); return Json{o}; }
      for (;;) { ws(); auto k = string(); ws(); if (take() != ':') fail(); auto v = value(depth + 1);
        if (!o.emplace(k, std::move(v)).second) fail(); ws(); c = take(); if (c == '}') return Json{o}; if (c != ',') fail(); }
    }
    if (c == '[') {
      take(); ws(); Json::Array a; if (peek() == ']') { take(); return Json{a}; }
      for (;;) { a.push_back(value(depth + 1)); ws(); c = take(); if (c == ']') return Json{a}; if (c != ',') fail(); }
    }
    for (auto literal : {std::string_view("true"), std::string_view("false"), std::string_view("null")}) {
      if (s_.compare(p_, literal.size(), literal) == 0) {
        p_ += literal.size(); if (literal == "null") return Json{nullptr}; return Json{literal == "true"};
      }
    }
    const auto begin = p_;
    if (peek() == '-') take();
    if (peek() == '0') take();
    else { if (peek() < '1' || peek() > '9') fail(); do { take(); } while (peek() >= '0' && peek() <= '9'); }
    if (peek() == '.') { take(); if (peek() < '0' || peek() > '9') fail(); do { take(); } while (peek() >= '0' && peek() <= '9'); }
    if (peek() == 'e' || peek() == 'E') { take(); if (peek() == '+' || peek() == '-') take();
      if (peek() < '0' || peek() > '9') fail(); do { take(); } while (peek() >= '0' && peek() <= '9'); }
    auto token = s_.substr(begin, p_ - begin); double n = 0;
    const auto parsed = std::from_chars(token.data(), token.data() + token.size(), n);
    // JavaScript rounds tiny finite values to zero; MSVC from_chars reports underflow instead.
    if (parsed.ec == std::errc::result_out_of_range) {
      std::istringstream stream(token); stream.imbue(std::locale::classic()); stream >> n;
      if (stream.fail() && n != 0) fail();
    } else if (parsed.ec != std::errc{} || parsed.ptr != token.data() + token.size()) fail();
    if (!std::isfinite(n)) fail(); return Json{n};
  }
};
inline void append_bounded(std::string& output, const std::string& value) {
  if (value.size() > max_frame_bytes - output.size()) fail(); output += value;
}
inline void append_bounded(std::string& output, char value) {
  if (output.size() >= max_frame_bytes) fail(); output += value;
}
inline void serialize_into(const Json& j, std::string& output, unsigned depth) {
  if (depth > max_json_depth) fail();
  if (std::holds_alternative<std::nullptr_t>(j.value)) { append_bounded(output, "null"); return; }
  if (auto b = std::get_if<bool>(&j.value)) { append_bounded(output, *b ? "true" : "false"); return; }
  if (auto n = std::get_if<double>(&j.value)) { if (!std::isfinite(*n)) fail(); std::ostringstream s;
    s.imbue(std::locale::classic()); s << std::setprecision(17) << *n; append_bounded(output, s.str()); return; }
  if (auto s = std::get_if<std::string>(&j.value)) {
    if (s->size() > max_frame_bytes - output.size()) fail(); utf8(*s); append_bounded(output, '"'); constexpr char hex[] = "0123456789abcdef";
    for (auto ch : *s) { auto c = static_cast<unsigned char>(ch);
      if (c == '"' || c == '\\') { append_bounded(output, '\\'); append_bounded(output, ch); }
      else if (c < 32) { append_bounded(output, "\\u00"); append_bounded(output, hex[c >> 4]); append_bounded(output, hex[c & 15]); } else append_bounded(output, ch);
    } append_bounded(output, '"'); return;
  }
  if (auto o = std::get_if<Json::Object>(&j.value)) {
    append_bounded(output, '{'); bool first = true;
    for (const auto& pair : *o) { if (!first) append_bounded(output, ','); first = false;
      if (pair.first.size() > max_frame_bytes - output.size()) fail();
      serialize_into(Json{pair.first}, output, depth + 1); append_bounded(output, ':'); serialize_into(pair.second, output, depth + 1); }
    append_bounded(output, '}'); return;
  }
  auto a = std::get_if<Json::Array>(&j.value); append_bounded(output, '['); bool first = true;
  for (const auto& v : *a) { if (!first) append_bounded(output, ','); first = false; serialize_into(v, output, depth + 1); } append_bounded(output, ']');
}
inline std::string serialize(const Json& j) {
  std::string output; serialize_into(j, output, 0); return output;
}
} // namespace ets2telemetry::v0::detail
