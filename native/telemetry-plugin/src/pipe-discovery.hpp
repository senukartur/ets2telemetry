#pragma once
#include "pipe-security.hpp"
#include "sdk-adapter.hpp"

namespace ets2telemetry::transport {
// `protocol_major` selects the endpoint namespace: 0 for the v0 live endpoint, 1 for the protocol v1 endpoint.
std::wstring endpoint_name(const sdk::Snapshot&, const UserIdentity&, unsigned protocol_major = 0);
std::vector<AllowedPeer> read_service_policy(const std::wstring& directory, const OwnerSecurity&, const UserIdentity&, HANDLE stop_event = nullptr);
class Discovery final {
 public:
  // Records carry `protocolMajor`; the protocol v1 endpoint publishes 1 in its own directory.
  Discovery(const std::wstring& directory, const OwnerSecurity&, const UserIdentity&, const sdk::Snapshot&, const std::wstring& pipe, unsigned protocol_major = 0);
  ~Discovery();
  Discovery(const Discovery&) = delete;
 private: Handle owned_; std::wstring path_;
};
}
