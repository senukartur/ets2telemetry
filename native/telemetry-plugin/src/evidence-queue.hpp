#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "scssdk_telemetry.h"

// CAP0 evidence capture queue. Separate from the frozen v0 live transport: it never
// feeds v0 snapshots/diagnostics and v0 never reads it. See docs/protocol/cap0.md.
namespace ets2telemetry::cap0 {
constexpr std::size_t queue_envelopes = 128;
constexpr std::size_t queue_bytes = 2 * 1024 * 1024;
constexpr std::size_t identifier_bytes = 128;
constexpr std::size_t string_bytes = 1024;
// Matches the adapter's configuration/gameplay scan bound, including the terminator.
constexpr std::size_t attribute_scan = 256;

enum class Kind : std::uint8_t { configuration = 1, gameplay = 2, lifecycle = 3 };
enum class Status : std::uint8_t { available = 0, not_observed = 1, not_supported = 2, invalid = 3 };
// Why a copied element is unavailable. Detail never replaces the status; it qualifies it.
enum class Detail : std::uint8_t { none = 0, null_value = 1, too_long = 2, invalid_utf8 = 3, non_finite = 4, unsupported_type = 5, null_name = 6, null_attributes = 7 };
enum class Simulation : std::uint8_t { unavailable = 0, paused = 1, running = 2 };

// Values copied by the SDK callback. Borrowed pointers are only read during capture().
struct Context {
  Kind kind = Kind::lifecycle;
  const char* id = nullptr;
  const scs_named_value_t* attributes = nullptr;
  bool attributes_expected = false;
  std::uint64_t boundary_order = 0, configuration_revision = 0;
  bool monotonic_available = false; std::uint64_t monotonic_ns = 0;
  bool frame_available = false; std::uint64_t render_us = 0, simulation_us = 0, paused_simulation_us = 0;
  Status game_time_status = Status::not_observed; std::uint32_t game_time_minutes = 0;
  const char* game_clock_id = nullptr;
  Simulation simulation = Simulation::unavailable;
};

struct Text { Status status = Status::not_observed; Detail detail = Detail::none; std::string value; };
struct Value {
  std::uint32_t type = 0; Status status = Status::not_observed; Detail detail = Detail::none;
  bool boolean = false; std::int64_t signed_integer = 0; std::uint64_t unsigned_integer = 0;
  // Float-family values are widened exactly to double; the SDK type is retained separately.
  std::array<double, 6> numbers{}; std::string text;
};
struct Attribute { Text name; std::uint32_t index = SCS_U32_NIL; Value value; };
// Decoded copy owned by the capture worker.
struct Envelope {
  Kind kind = Kind::lifecycle; Text id;
  std::uint64_t seq = 0, dropped_before = 0, boundary_order = 0, configuration_revision = 0;
  bool monotonic_available = false; std::uint64_t monotonic_ns = 0;
  bool frame_available = false; std::uint64_t render_us = 0, simulation_us = 0, paused_simulation_us = 0;
  Status game_time_status = Status::not_observed; std::uint32_t game_time_minutes = 0;
  std::string game_clock_id; Simulation simulation = Simulation::unavailable;
  bool attributes_expected = false, attributes_null = false, terminated = false;
  std::vector<Attribute> attributes;
};
struct Counters {
  std::uint64_t attempted = 0, enqueued = 0, dequeued = 0, dropped = 0, dropped_bytes = 0, dropped_full_slots = 0, dropped_full_bytes = 0;
  bool last_drop_available = false; std::uint64_t last_dropped_seq = 0, last_drop_monotonic_ns = 0;
};

// Single SDK producer, single capture-worker consumer. Preallocated, lock-free and newest-drop:
// a full queue rejects the arriving envelope and records it in loss counters.
class EvidenceQueue final {
 public:
  EvidenceQueue() = default;
  EvidenceQueue(const EvidenceQueue&) = delete;
  EvidenceQueue& operator=(const EvidenceQueue&) = delete;
  // Worker only, while closed: allocate storage outside callbacks and reset per-capture state.
  bool prepare() noexcept;
  void open() noexcept;
  // Worker only. Waits only for an in-progress callback copy to leave the producer section.
  void close() noexcept;
  bool is_open() const noexcept { return open_.load(std::memory_order_acquire); }
  // SDK callback thread only. Never blocks, allocates, or calls the SDK.
  void capture(const Context&) noexcept;
  // Worker only.
  bool pop(Envelope&);
  Counters counters() const noexcept;
  std::size_t queued_envelopes() const noexcept;
  std::size_t queued_bytes() const noexcept { return used_.load(std::memory_order_acquire); }
  // Encoded size bound used by tests; the producer computes it exactly before reserving.
  static std::size_t encoded_size(const Context&) noexcept;
 private:
  struct Slot { std::uint32_t offset = 0, size = 0, charge = 0; };
  void drop(std::uint64_t seq, std::uint64_t bytes, bool slots, std::uint64_t monotonic_ns, bool monotonic_available) noexcept;
  std::unique_ptr<unsigned char[]> arena_;
  std::array<Slot, queue_envelopes> slots_{};
  std::atomic<bool> open_{false};
  std::atomic<unsigned> in_capture_{0};
  std::atomic<std::uint64_t> head_{0}, tail_{0};
  std::atomic<std::size_t> used_{0};
  std::size_t write_ = 0;
  std::uint64_t pending_drops_ = 0;
  std::atomic<std::uint64_t> attempted_{0}, enqueued_{0}, dequeued_{0}, dropped_{0}, dropped_bytes_{0}, dropped_slots_{0}, dropped_capacity_{0};
  std::atomic<std::uint64_t> last_dropped_seq_{0}, last_drop_ns_{0};
  std::atomic<bool> last_drop_available_{false};
};
}
