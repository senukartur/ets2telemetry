#pragma once
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cstdint>
#include <vector>

namespace ets2telemetry::transport {
class Handle final {
 public:
  Handle() = default; explicit Handle(HANDLE h) : h_(h) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : h_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { reset(other.release()); return *this; }
  HANDLE get() const noexcept { return h_; }
  explicit operator bool() const noexcept { return h_ && h_ != INVALID_HANDLE_VALUE; }
  HANDLE release() noexcept { auto h = h_; h_ = nullptr; return h; }
  void reset(HANDLE h = nullptr) noexcept { if (*this) CloseHandle(h_); h_ = h; }
 private: HANDLE h_ = nullptr;
};
struct UserIdentity { std::wstring sid; std::string tag; DWORD session = 0; };
struct PeerIdentity { Handle process, image_file; DWORD pid = 0, session = 0; std::uint64_t creation = 0; std::wstring sid, image; std::string sha256; };
struct AllowedPeer { DWORD pid = 0; std::uint64_t creation = 0; std::wstring image; std::string sha256; };
UserIdentity current_user();
std::string sha256_bytes(const void*, std::size_t);
std::string sha256_file(const std::wstring&);
std::string sha256_handle(HANDLE);
std::uint64_t creation_time(HANDLE);
PeerIdentity inspect_peer(DWORD pid);
PeerIdentity authenticate_client(HANDLE pipe, const UserIdentity&, const AllowedPeer&);
class OwnerSecurity final {
 public:
  explicit OwnerSecurity(const std::wstring& sid);
  ~OwnerSecurity();
  OwnerSecurity(const OwnerSecurity&) = delete;
  SECURITY_ATTRIBUTES* attributes() const noexcept { return const_cast<SECURITY_ATTRIBUTES*>(&attributes_); }
  void ensure_directory(const std::wstring&) const;
  void verify_owner_only(const std::wstring&) const;
  void verify_handle(HANDLE) const;
 private:
  std::wstring sid_; PSECURITY_DESCRIPTOR descriptor_ = nullptr; SECURITY_ATTRIBUTES attributes_{};
};
std::wstring final_path(HANDLE);
std::wstring local_transport_directory(const OwnerSecurity&);
}
