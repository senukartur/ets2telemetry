#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace ets2telemetry::v0 {
constexpr std::size_t max_frame_bytes = 65536;
constexpr unsigned max_json_depth = 16;
constexpr std::size_t max_observations = 32;
struct ProtocolError : std::runtime_error { using std::runtime_error::runtime_error; };
// A validated JSON tree preserves all copied diagnostic fields; protocol fields are materialized below.
struct Json {
  using Object = std::map<std::string, Json>;
  using Array = std::vector<Json>;
  std::variant<std::nullptr_t, bool, double, std::string, Object, Array> value;
  const Json& at(const std::string& key) const;
  const std::string& string() const;
  double number() const;
  bool boolean() const;
};
enum class AvailabilityReason { not_supported, not_observed, invalid };
template<class T> struct Available { std::optional<T> value; AvailabilityReason reason = AvailabilityReason::not_observed; };
struct Measure { Available<double> reading; std::string unit; };
struct SourceIdentity {
  std::string game, plugin_session_id, process_instance_id, origin;
  std::uint32_t process_id = 0, windows_session_id = 0;
};
struct CaptureTime { std::string clock_id; std::uint64_t monotonic_ns = 0; };
struct LocalReceiveTime { std::string clock_id; std::uint64_t monotonic_ns = 0; Available<std::uint64_t> utc_unix_ms; };
struct Continuity { std::uint64_t coalesced_snapshots = 0, lost_observations = 0, offline_transitions = 0; };
struct Money { std::string raw_value; std::optional<std::string> currency_code; std::string verified_source; };
struct Job { std::string cargo_id, destination_city_id; Measure planned_distance; Money expected_income; };
struct Configuration { std::uint64_t revision = 0; Available<std::string> truck_id; Available<Job> job; };
struct GameWindow {
  std::uint64_t handle = 0; std::int32_t x = 0, y = 0; std::uint32_t width = 0, height = 0, dpi = 0;
  bool foreground = false, minimized = false; std::string display_mode;
};
struct CurrentState {
  std::string simulation;
  Measure speed, fuel, fuel_capacity, engine_rpm, gear, odometer, average_consumption, estimated_range;
  Available<std::uint64_t> game_time_minutes, capture_utc_unix_ms; std::string game_clock_id;
  Configuration configuration; Available<GameWindow> window;
};
using DiagnosticValue = std::variant<bool, double, std::uint64_t, std::string>;
struct Observation { std::string channel, sdk_type, unit; Available<DiagnosticValue> reading; };
struct Message {
  std::string kind;
  std::optional<SourceIdentity> source;
  std::uint64_t seq = 0; CaptureTime capture;
  bool diagnostics = false; std::string client_instance_id; std::uint16_t max_minor = 0;
  std::optional<CurrentState> state; Continuity continuity;
  std::vector<Observation> observations;
  // Wire is the authoritative representation for encoding/validation. Typed fields are read views.
  // Change wire, then decode the encoded frame again to obtain updated typed views.
  Json wire;
};
std::uint64_t parse_uint64(const Json&);
Message decode_payload(const std::string& bytes);
std::vector<std::uint8_t> encode_frame(const Message&);
struct Negotiated { unsigned major = 0, minor = 0; bool diagnostics = false, durable_recording = false; };
Negotiated negotiate(const Message& hello);
enum class SdkField { speed, fuel, fuel_capacity, engine_rpm, gear, odometer, average_consumption, estimated_range };
Measure normalize_sdk_measurement(SdkField, Available<double>);
class FrameDecoder {
 public:
  void push(const std::uint8_t* data, std::size_t size, const std::function<void(Message)>& emit);
  void end();
 private:
  std::uint8_t header_[4]{}; std::size_t header_used_ = 0, expected_ = 0;
  std::string payload_; bool failed_ = false, pushing_ = false;
};
struct AppliedState { bool hydration = false; std::uint64_t skipped_sequences = 0; Continuity continuity; };
class Consumer {
 public:
  explicit Consumer(bool diagnostics_requested) : diagnostics_requested_(diagnostics_requested) {}
  std::optional<AppliedState> accept(const Message&);
 private:
  enum class Phase { welcome, checkpoint, live, closed };
  Phase phase_ = Phase::welcome; bool diagnostics_requested_, diagnostics_enabled_ = false;
  std::string identity_, clock_; std::uint64_t last_seq_ = 0, last_capture_ = 0;
  std::optional<Continuity> counters_;
};
} // namespace ets2telemetry::v0
