#pragma once
#include "protocol-v1.hpp"
#include <array>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <string_view>
#include <type_traits>
#include <variant>

// Protocol v1 producer records (ET-004b): fixed-size, trivially copyable copies of SDK observations. The SDK callback
// copies them with memcpy into a preallocated slot; the transport worker turns them into wire messages
// (protocol-v1-producer.hpp) and retains events (protocol-v1-store.hpp). Values stay in SDK units here; the encoder
// applies the docs/protocol/v1.md §6 mapping and marks non-finite or out-of-range readings `invalid`.
namespace ets2telemetry::v1 {
// Availability of one copied value. Zero-initialized storage reads as not-observed, never as an available zero.
enum class FieldState : std::uint8_t { not_observed = 0, available = 1, not_supported = 2, invalid = 3 };
template<class T> struct Field {
  T value{}; FieldState state = FieldState::not_observed;
  bool available() const noexcept { return state == FieldState::available; }
};
// Returns a prvalue on purpose. With a named local (NRVO), MSVC 19.51 AddressSanitizer reports a false
// stack-use-after-scope on the tail padding of Field<std::uint32_t>; docs/validation/et-004b.md records the reduction.
template<class T> Field<T> available_field(T value) noexcept { return Field<T>{value, FieldState::available}; }

// Text copied from a borrowed SDK string. It is never truncated: a value longer than N bytes becomes invalid. UTF-8,
// C0 and DEL rules (D12) are checked by the encoder, which marks a violating value invalid.
template<std::size_t N> struct FixedText {
  static_assert(N > 0 && N <= 65535, "text capacity");
  FieldState state = FieldState::not_observed; std::uint16_t length = 0; char bytes[N]{};
  // Reads at most N + 1 bytes of a NUL-terminated string, so a missing terminator never causes an unbounded scan.
  // A null pointer means the game did not send the value; a provided empty string stays available.
  void assign(const char* value) noexcept {
    length = 0;
    if (!value) { state = FieldState::not_observed; return; }
    std::size_t size = 0;
    while (size <= N && value[size]) ++size;
    if (size > N) { state = FieldState::invalid; return; }
    std::memcpy(bytes, value, size); length = static_cast<std::uint16_t>(size); state = FieldState::available;
  }
  void assign(std::string_view value) noexcept {
    length = 0;
    if (value.size() > N) { state = FieldState::invalid; return; }
    if (!value.empty()) std::memcpy(bytes, value.data(), value.size());
    length = static_cast<std::uint16_t>(value.size()); state = FieldState::available;
  }
  std::string_view view() const noexcept { return {bytes, length <= N ? length : N}; }
};
using IdText = FixedText<id_bytes>;
using NameText = FixedText<name_bytes>;
// A UUID in its 36-character text form. The encoder rejects anything but lowercase canonical text.
struct Uuid { char text[36]{}; };
inline Uuid make_uuid(std::string_view text) noexcept { Uuid u; std::memcpy(u.text, text.data(), text.size() < 36 ? text.size() : 36); return u; }

enum class SimulationState : std::uint8_t { unavailable = 0, paused = 1, running = 2 };
// Game time in SDK u32 minutes with the adapter's game clock identity, which rotates on a recognized discontinuity.
struct GameTimePod { Field<std::uint32_t> minutes; Uuid clock_id; };
// The callback moment of an event (§8): source monotonic time, game time, UTC label and adapter order.
struct OccurrencePod {
  Field<std::uint64_t> monotonic_ns; GameTimePod game_time; Field<std::uint64_t> utc_unix_ms;
  SimulationState simulation = SimulationState::unavailable; std::uint64_t configuration_revision = 0, boundary_order = 0;
};

enum class GameModeKind : std::uint8_t { unknown = 0, single_player = 1, truckersmp = 2 };
enum class DetectionMethod : std::uint8_t { none = 0, module_scan = 1, process_scan = 2 };
enum class Confidence : std::uint8_t { none = 0, weak = 1, strong = 2 };
// Game-mode evidence (D9). The default is the OD-3 value: unknown, method none, confidence none, no module.
struct GameModePod { GameModeKind mode = GameModeKind::unknown; DetectionMethod method = DetectionMethod::none; Confidence confidence = Confidence::none; IdText module; };

namespace records {
// Record bodies in the order of v1::event_types; EventRecord::record.index() selects the wire `type`.
struct JobConfigured {
  IdText source_city_id, source_company_id, destination_city_id, destination_company_id, cargo_id, market;
  NameText source_city, source_company, destination_city, destination_company, cargo;
  Field<double> cargo_mass_kg, cargo_unit_mass_kg; Field<std::uint32_t> cargo_unit_count;
  Field<bool> is_special_job, cargo_loaded;
  // SDK planned_distance.km (u32), income (u64) and delivery.time (u32 absolute minutes).
  Field<std::uint32_t> planned_distance_km; Field<std::uint64_t> expected_income; Field<std::uint32_t> delivery_deadline_min;
};
struct JobCleared {};
struct TruckConfigured {
  IdText brand_id, id, plate_country_id; NameText brand, name, license_plate, plate_country; Field<double> fuel_capacity_l;
};
struct TruckCleared {};
struct TrailerConfigured {
  std::uint8_t index = 0;
  IdText id, body_type, chain_type, cargo_accessory_id, brand_id, plate_country_id; NameText brand, name, license_plate, plate_country;
};
struct TrailerCleared { std::uint8_t index = 0; };
struct SimulationPaused {};
struct SimulationStarted {};
struct TimersRestart {};
struct GameTimeRegression { GameTimePod from, to; };
struct JobDelivered {
  Field<std::int64_t> revenue; Field<std::int32_t> earned_xp; Field<double> cargo_damage; Field<float> distance_km;
  Field<std::uint32_t> delivery_duration_min; Field<bool> auto_park_used, auto_load_used;
};
struct JobCancelled { Field<std::int64_t> penalty; };
struct PlayerFined { IdText offence; Field<std::int64_t> amount; };
struct PlayerTollgatePaid { Field<std::int64_t> amount; };
struct Transfer { Field<std::int64_t> amount; IdText source_id, target_id; NameText source_name, target_name; };
struct PlayerUseFerry : Transfer {};
struct PlayerUseTrain : Transfer {};
struct SourceGameMode { GameModePod mode; };
} // namespace records
using RecordBody = std::variant<records::JobConfigured, records::JobCleared, records::TruckConfigured, records::TruckCleared,
  records::TrailerConfigured, records::TrailerCleared, records::SimulationPaused, records::SimulationStarted, records::TimersRestart,
  records::GameTimeRegression, records::JobDelivered, records::JobCancelled, records::PlayerFined, records::PlayerTollgatePaid,
  records::PlayerUseFerry, records::PlayerUseTrain, records::SourceGameMode>;
static_assert(std::variant_size_v<RecordBody> == std::size(event_types), "one record body per v1 event type");
// One observed gameplay event with the eventSeq assigned at observation (D5).
struct EventRecord { std::uint64_t event_seq = 0; OccurrencePod occurred; RecordBody record; };
inline const char* record_type(const EventRecord& e) noexcept { return event_types[e.record.index()]; }

// Current configuration (D17). OD-6: the wire always carries trailers.size() entries; an empty slot is unavailable.
struct ConfigurationPod {
  std::uint64_t revision = 0; Field<records::JobConfigured> job; Field<records::TruckConfigured> truck;
  std::array<Field<records::TrailerConfigured>, limits.trailer_slots> trailers{};
};
struct PlacementPod { double x = 0, y = 0, z = 0, heading = 0, pitch = 0, roll = 0; };
enum class DisplayMode : std::uint8_t { unknown = 0, windowed = 1, borderless = 2, exclusive = 3 };
// The v0 window structure: physical client-area origin and size of the current game window.
struct WindowPod {
  std::uint64_t handle = 0; std::int32_t x = 0, y = 0; std::uint32_t width = 0, height = 0, dpi = 0;
  bool foreground = false, minimized = false; DisplayMode display_mode = DisplayMode::unknown;
};
// Minor-1 gearbox (ET-050b B2): raw copies of one SDK `hshifter` configuration callback, indexed by SDK slot. `seen`
// holds one bit per slot attribute copied (slot_gear_seen, slot_handle_seen, slot_selectors_seen). The SDK callback only
// copies; the encoder omits neutral (gear 0) slots and marks an incomplete slot, an out-of-range value or a duplicate
// (handle position, selectors) pair `invalid`, so a layout is never truncated.
constexpr std::uint8_t slot_gear_seen = 1, slot_handle_seen = 2, slot_selectors_seen = 4;
struct HShifterSlotRaw { std::int32_t gear = 0; std::uint32_t handle_position = 0, selectors = 0; std::uint8_t seen = 0; };
struct HShifterPod { std::uint32_t selector_count = 0; std::array<HShifterSlotRaw, gearbox_limits.max_slots> slots{}; };
// Gear counts in SDK u32 from the latest truck callback (`gears.forward`, `gears.reverse`) and the latest h-shifter
// layout. It is outside ConfigurationPod: the hshifter callback changes no revision and emits no event (B2).
struct GearboxPod { Field<std::uint32_t> forward_gears, reverse_gears; Field<HShifterPod> hshifter; };
// Current state in SDK units: speed m/s, fuel L, odometer and range km, consumption L/km, navigation distance m.
// `gearbox` is encoded on a minor-1 or minor-2 connection and `next_mandatory_break_min` (SDK s32 game minutes, negative is
// overdue and zero is a value) only on a minor-2 connection; a lower minor ignores them.
struct StatePod {
  SimulationState simulation = SimulationState::unavailable;
  Field<double> speed_mps, fuel_l, fuel_capacity_l, engine_rpm; Field<std::int32_t> gear;
  Field<double> odometer_km, average_consumption_l_per_km, estimated_range_km, navigation_distance_m;
  GameTimePod game_time; Field<std::uint64_t> capture_utc_unix_ms; std::uint64_t boundary_order = 0;
  Field<PlacementPod> world_placement; ConfigurationPod configuration; Field<WindowPod> window; GearboxPod gearbox; Field<std::int32_t> next_mandatory_break_min;
};
enum class GameId : std::uint8_t { ets2 = 0, ats = 1 };
enum class Origin : std::uint8_t { game = 0, synthetic = 1, replay = 2 };
// The v0 source identity of one plugin session.
struct SourcePod { GameId game = GameId::ets2; Uuid plugin_session_id, process_instance_id; std::uint32_t process_id = 0, windows_session_id = 0; Origin origin = Origin::game; };

static_assert(std::is_trivially_copyable_v<EventRecord> && std::is_trivially_copyable_v<StatePod> && std::is_trivially_copyable_v<SourcePod> &&
  std::is_trivially_copyable_v<GameModePod> && std::is_trivially_copyable_v<ConfigurationPod> && std::is_trivially_copyable_v<GearboxPod>, "SDK-thread copies are plain memcpy");
} // namespace ets2telemetry::v1
