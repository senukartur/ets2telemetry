#pragma once
#include "pipe-security.hpp"
#include "sdk-adapter.hpp"

namespace ets2telemetry::transport {
std::wstring endpoint_name(const sdk::Snapshot&, const UserIdentity&);
std::vector<AllowedPeer> read_service_policy(const std::wstring& directory, const OwnerSecurity&, const UserIdentity&);
class Discovery final {
 public:
  Discovery(const std::wstring& directory, const OwnerSecurity&, const UserIdentity&, const sdk::Snapshot&, const std::wstring& pipe);
  ~Discovery();
  Discovery(const Discovery&) = delete;
 private: Handle owned_; std::wstring path_;
};
}
