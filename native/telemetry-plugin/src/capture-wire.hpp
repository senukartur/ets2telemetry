#pragma once
#include "evidence-queue.hpp"
#include "capture-hello.hpp"
#include <string>
#include <vector>

// CAP0 evidence wire encoding. Only the capture worker calls these functions; SDK callbacks
// copy fixed binary envelopes into EvidenceQueue and never construct JSON.
namespace ets2telemetry::cap0 {
struct HeaderInfo {
  std::string capture_session_id, origin, game, sdk_game_id, process_instance_id, plugin_session_id, source_clock_id, game_clock_id;
  std::uint32_t process_id = 0, windows_session_id = 0, api_version = 0, game_telemetry_version = 0;
  bool currency_available = false; std::string currency_code, currency_source;
  bool image_available = false; std::string image_path, image_sha256;
  std::uint64_t open_monotonic_ns = 0, boundary_at_open = 0;
};
enum class EndReason { plugin_shutdown, source_retired, encoding_failed };
struct EndInfo { EndReason reason = EndReason::plugin_shutdown; Counters counters; std::uint64_t published = 0, unsent = 0; };

std::string header_packet(const HeaderInfo&, std::uint64_t packet_seq, std::uint64_t publish_ns);
std::string loss_packet(const std::string& capture_session_id, const Counters&, std::uint64_t packet_seq, std::uint64_t publish_ns);
std::string end_packet(const std::string& capture_session_id, const EndInfo&, std::uint64_t packet_seq, std::uint64_t publish_ns);
// Splits one copied envelope into ordered packets of at most `limit` payload bytes. Every copied
// attribute appears exactly once; packet boundaries are explicit attribute ranges.
std::vector<std::string> envelope_packets(const std::string& capture_session_id, const Envelope&, std::uint64_t& packet_seq, std::uint64_t publish_ns, std::size_t limit = max_packet_bytes);
std::vector<std::uint8_t> frame(const std::string& payload);
}
