#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include "scssdk_telemetry.h"
#include "evidence-queue.hpp"
#include "event-channel.hpp"

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
// The scalar channels come first, in State::channels order; world_placement has its own typed reading and ends the scalar
// range. `mandatory_break` (ET-052) is the optional protocol v1 minor-2 channel `next_mandatory_break` (s32 game minutes):
// its registration never fails initialization, and it takes no part in the v0 snapshot wire or the v0 diagnostics.
enum class Field : std::uint8_t { speed, fuel, rpm, gear, odometer, consumption, range, game_time, navigation_distance, mandatory_break, world_placement, count };
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
// Protocol v1 current state (ET-004b), published beside the v0 slot while an event channel is attached. Values keep
// SDK units (protocol-v1-records.hpp). `state.window` stays unavailable: the v1 endpoint adds the window monitor's
// state. `continuity` counts v1 slot contention and boundaries while no v1 client is connected (OD-5 S10).
struct V1Current {
  Identity identity;
  v1::StatePod state;
  v1::GameModePod game_mode;
  v1::Continuity continuity;
  scs_result_t gameplay_result = SCS_RESULT_unsupported;
  bool active = false, exhausted = false, source_retired = false;
};

// SDK calls and mutable producer state belong exclusively to the SDK calling thread.
// read_latest / read_current / set_consumer / defer_log / read_v1_current are the only methods for a transport thread.
// No SDK-owned pointers or C++ allocations cross the DLL boundary.
// A fixed game-log entry with static storage duration; only the SDK thread passes it to the logger.
struct DeferredLog { scs_log_type_t type; const char* message; };
// One fixed slot per producer of deferred entries: the v0 transport's late startup result and the protocol v1 endpoint.
enum class DeferredLogSlot : std::uint8_t { transport_v0 = 0, transport_v1 = 1, count = 2 };
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
  // SDK initialization/shutdown context only, after initialize() and with a prepared channel. Callbacks then hand
  // protocol v1 event records to the channel, whose gate decides whether a record is copied, and publish the v1 state
  // slot. Without a channel every v1 path is inert; v0 and CAP0 behavior is identical either way. initialize() detaches
  // a channel left attached from an earlier plugin session, whose eventSeq must not continue under a new session.
  void attach_events(v1::EventChannel* channel) noexcept;
  // SDK initialization only, before attaching the prepared event channel.
  void set_game_mode(const v1::GameModePod& mode) noexcept { game_mode_ = mode; }
  // Transport worker: an owned copy of the current v1 state slot. It consumes nothing, so the v0 read_latest slot keeps
  // its single consumer. False before the first v1 publication of this plugin session.
  bool read_v1_current(V1Current& output) noexcept;
  // Current time in the source monotonic clock domain (Identity::capture_clock_id). The origin is
  // fixed by initialize(); only workers started after initialization may call this.
  bool source_monotonic_ns(std::uint64_t& output) const noexcept;
  // Lock-free source liveness (false after shutdown or counter exhaustion) for worker polling.
  bool source_live() const noexcept { return source_live_.load(std::memory_order_acquire); }
  // Any thread: hands one static entry to the SDK thread, replacing an entry not yet logged in the same slot. A worker
  // never calls the game logger; the next frame_end callback or explicit shutdown logs it once. Each producer has its
  // own slot, so entries of different producers never replace each other; the SDK thread logs the slots in order.
  void defer_log(const DeferredLog* entry, DeferredLogSlot slot = DeferredLogSlot::transport_v0) noexcept {
    deferred_logs_[static_cast<std::size_t>(slot)].store(entry, std::memory_order_release);
  }
  // Any thread: whether a protocol v1 event channel is attached, for diagnostics and tests only.
  bool events_attached() const noexcept { return events_.load(std::memory_order_acquire) != nullptr; }
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
  void publish_v0() noexcept;
  // Protocol v1 capture (ET-004b): SDK thread only, inert without an attached channel, and never touches v0 state.
  void publish_v1() noexcept;
  void v1_configuration(const scs_telemetry_configuration_t&) noexcept;
  void v1_gameplay(const scs_telemetry_gameplay_event_t&) noexcept;
  void v1_game_time(v1::GameTimePod& output) const noexcept;
  // Assigned eventSeq, including ordinary loss; zero means no sequence was assigned.
  std::uint64_t v1_emit(bool boundary) noexcept;
  Snapshot producer_{}, published_{};
  std::mutex publication_mutex_;
  std::mutex pending_mutex_;
  std::atomic<unsigned> consumer_{0};
  std::atomic<std::uint64_t> discarded_observations_{0};
  std::atomic<bool> source_live_{false};
  std::atomic<cap0::EvidenceQueue*> evidence_{nullptr};
  std::array<std::atomic<const DeferredLog*>, static_cast<std::size_t>(DeferredLogSlot::count)> deferred_logs_{};
  std::atomic<v1::EventChannel*> events_{nullptr};
  // v1 producer state: the record being built, the current configuration with its own revision, and v1 continuity.
  v1::EventRecord v1_record_{};
  v1::GameModePod game_mode_{};
  bool game_mode_emitted_ = false;
  v1::ConfigurationPod v1_configuration_{};
  v1::Continuity v1_continuity_{};
  bool v1_configuration_dirty_ = true;
  // Minor-1 gearbox (ET-050b B2): truck gear counts and the latest hshifter layout. A callback that changes it sets only
  // this dirty flag; the next publication copies it into the slot, like the configuration.
  v1::GearboxPod v1_gearbox_{};
  bool v1_gearbox_dirty_ = true;
  // The v1 slot. The SDK thread only try-locks it and copies the configuration only after a configuration boundary.
  V1Current v1_published_{};
  std::mutex v1_mutex_;
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
