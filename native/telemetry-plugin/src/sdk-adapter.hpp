#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include "scssdk_telemetry.h"
#include "evidence-queue.hpp"

namespace ets2telemetry::sdk {
// Includes truck wheel/config arrays; scan cap includes the required null terminator.
constexpr std::size_t max_attributes = 256;
constexpr std::size_t max_observations = 32;
enum class Availability : std::uint8_t { available, not_observed, not_supported, invalid };
template<std::size_t N> struct Text {
  std::array<char, N + 1> bytes{};
  Availability status = Availability::not_observed;
  bool assign(const char* value) noexcept;
  const char* c_str() const noexcept { return bytes.data(); }
};
using Identifier = Text<128>;
using String = Text<1024>;
using Uuid = Text<36>;
template<class T> struct Reading { T value{}; Availability status = Availability::not_observed; };
enum class Field : std::uint8_t { speed, fuel, rpm, gear, odometer, consumption, range, game_time, navigation_distance, world_placement, count };
struct ChannelSpec { const char* name; scs_value_type_t type; const char* unit; double multiplier; double minimum; double maximum; };
const std::array<ChannelSpec, static_cast<std::size_t>(Field::count)>& channel_specs() noexcept;
struct Job {
  Availability status = Availability::not_observed;
  Identifier cargo_id, destination_city_id, source_city_id, destination_company_id, source_company_id, market;
  Reading<double> planned_distance_m;
  Reading<std::uint64_t> expected_income;
};
enum class Simulation : std::uint8_t { unavailable, paused, running };
struct State {
  // World placement has its own typed reading; it never masquerades as scalar zero.
  std::array<Reading<double>, static_cast<std::size_t>(Field::world_placement)> channels{};
  Reading<std::uint32_t> game_time_minutes;
  Reading<scs_value_dplacement_t> world_placement;
  Reading<double> fuel_capacity_l;
  Identifier truck_id;
  Job job;
  std::uint64_t configuration_revision = 0;
  Simulation simulation = Simulation::unavailable;
  Uuid game_clock_id;
  scs_telemetry_frame_start_t frame{};
  bool frame_available = false;
};
struct Identity {
  Identifier game_id, game;
  Uuid plugin_session_id, process_instance_id, capture_clock_id;
  std::uint32_t process_id = 0, windows_session_id = 0, api_version = 0, game_telemetry_version = 0;
  // Source-backed currency applies to config income and common gameplay monetary fields.
  Text<3> currency;
  Identifier currency_source;
};
struct Scalar {
  scs_value_type_t type = SCS_VALUE_TYPE_INVALID;
  Availability status = Availability::not_observed;
  bool boolean = false;
  std::int64_t signed_integer = 0;
  std::uint64_t unsigned_integer = 0;
  double number = 0;
  scs_value_dplacement_t placement{};
  String string;
};
enum class ObservationKind : std::uint8_t { channel, configuration, gameplay, lifecycle };
struct Observation {
  ObservationKind kind{};
  Identifier group, name;
  std::uint32_t index = SCS_U32_NIL;
  std::uint64_t callback_order = 0;
  Scalar value;
};
struct Continuity { std::uint64_t coalesced_snapshots = 0, lost_observations = 0, offline_transitions = 0, callback_failures = 0; };
struct Snapshot {
  Identity identity;
  State state;
  Continuity continuity;
  std::uint64_t boundary_order = 0, capture_monotonic_ns = 0;
  std::array<Observation, max_observations> observations{};
  std::size_t observation_count = 0;
  bool active = false, exhausted = false;
  // Read-side lifetime fence: cached boundary may precede SDK shutdown if publication was contended.
  bool source_retired = false;
  std::array<scs_result_t, static_cast<std::size_t>(Field::count)> channel_results{};
  scs_result_t gameplay_result = SCS_RESULT_unsupported;
};

// SDK calls and mutable producer state belong exclusively to the SDK calling thread.
// read_latest / read_current / set_consumer / defer_log are the only methods for a transport thread.
// No SDK-owned pointers or C++ allocations cross the DLL boundary.
// A fixed game-log entry with static storage duration; only the SDK thread passes it to the logger.
struct DeferredLog { scs_log_type_t type; const char* message; };
class Adapter final {
 public:
  scs_result_t initialize(scs_u32_t version, const scs_telemetry_init_params_t* params) noexcept;
  void shutdown() noexcept;
  void set_consumer(bool connected, bool diagnostics) noexcept;
  bool read_latest(Snapshot& output) noexcept;
  bool read_current(Snapshot& output) noexcept;
  // SDK initialization/shutdown context only. The queue's own gate decides whether a
  // callback copies a CAP0 envelope; v0 publication and diagnostics are unaffected.
  void attach_evidence(cap0::EvidenceQueue* queue) noexcept { evidence_.store(queue, std::memory_order_release); }
  // Current time in the source monotonic clock domain (Identity::capture_clock_id). The origin is
  // fixed by initialize(); only workers started after initialization may call this.
  bool source_monotonic_ns(std::uint64_t& output) const noexcept;
  // Lock-free source liveness (false after shutdown or counter exhaustion) for worker polling.
  bool source_live() const noexcept { return source_live_.load(std::memory_order_acquire); }
  // Any thread: hands one static entry to the SDK thread, replacing an entry not yet logged. A worker
  // never calls the game logger; the next frame_end callback or explicit shutdown logs it once.
  void defer_log(const DeferredLog* entry) noexcept { deferred_log_.store(entry, std::memory_order_release); }
 private:
  friend struct AdapterTestAccess;
  static SCSAPI_VOID event_callback(scs_event_t, const void*, scs_context_t);
  static SCSAPI_VOID channel_callback(scs_string_t, scs_u32_t, const scs_value_t*, scs_context_t);
  struct Context { Adapter* owner = nullptr; Field field{}; };
  void event(scs_event_t, const void*);
  void channel(Field, const scs_value_t*);
  void configuration(const scs_telemetry_configuration_t&);
  void copy_attributes(ObservationKind, const char*, const scs_named_value_t*);
  void observe(ObservationKind, const char*, const char*, scs_u32_t, const scs_value_t*);
  void publish() noexcept;
  void cleanup() noexcept;
  void failure() noexcept;
  bool next_order() noexcept;
  void clock_restart() noexcept;
  void gate_diagnostics() noexcept;
  bool diagnostics_enabled() const noexcept;
  void evidence(cap0::Kind, const char* id, const scs_named_value_t* attributes, bool attributes_expected) noexcept;
  void flush_deferred_log() noexcept;
  Snapshot producer_{}, published_{};
  std::mutex publication_mutex_;
  std::mutex pending_mutex_;
  std::atomic<unsigned> consumer_{0};
  std::atomic<std::uint64_t> discarded_observations_{0};
  std::atomic<bool> source_live_{false};
  std::atomic<cap0::EvidenceQueue*> evidence_{nullptr};
  std::atomic<const DeferredLog*> deferred_log_{nullptr};
  bool unread_ = false, initialized_ = false;
  scs_telemetry_init_params_v100_t api_{};
  std::array<bool, 7> registered_events_{};
  std::array<bool, static_cast<std::size_t>(Field::count)> registered_channels_{};
  std::array<Context, static_cast<std::size_t>(Field::count)> contexts_{};
  // Only explicit SDK frame boundaries establish that a reading belongs to the current frame.
  std::array<bool, static_cast<std::size_t>(Field::count)> observed_in_frame_{};
  bool in_frame_ = false;
  std::uint64_t clock_epoch_ = 0;
  std::int64_t monotonic_origin_ = 0, monotonic_frequency_ = 0;
};
Adapter& adapter() noexcept;
} // namespace ets2telemetry::sdk
