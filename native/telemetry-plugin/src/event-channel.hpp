#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
// pipe-security.hpp includes <windows.h> without NOMINMAX before sdk-adapter.hpp in several transport sources. The
// frozen protocol v1 headers call std::numeric_limits<...>::max(), so the min/max macros are hidden while they load.
#pragma push_macro("min")
#pragma push_macro("max")
#undef min
#undef max
#include "protocol-v1-records.hpp"
#include "protocol-v1-store.hpp"
#pragma pop_macro("max")
#pragma pop_macro("min")

// Protocol v1 callback capture (ET-004b): the bounded handoff of event records from the SDK callback thread to the v1
// transport worker. The SDK thread assigns every observed event its eventSeq here (D5) and copies the record only while a
// durable consumer is connected; every other eventSeq joins a counted loss run. See docs/native-transport-v1.md.
namespace ets2telemetry::v1 {
constexpr std::size_t channel_slots = 128;
// What the transport worker currently serves: no v1 client, a live-only client, or a durable consumer whose store
// connection is open. Only `durable` copies record contents (OD-4).
enum class Gate : std::uint8_t { none = 0, live = 1, durable = 2 };
// Consecutive eventSeqs that the SDK thread assigned but did not copy, with exact per-cause counts. Lost times are the
// earliest and latest available occurred.monotonicNs of the lost observations (OD-5 S1), both present or both absent.
struct LossRun {
  std::uint64_t first_event_seq = 0, last_event_seq = 0; LossCounts causes;
  bool times_available = false; std::uint64_t first_lost_ns = 0, last_lost_ns = 0;
};
// One ring slot: an optional closed loss run that precedes an optional copied record. A loss-only slot comes from
// flush_loss(); a slot never holds neither.
struct ChannelSlot { bool has_loss = false, has_record = false; LossRun loss_before; EventRecord record; };

constexpr std::size_t cache_line = 64;
// alignas below pads the class on purpose; MSVC reports that padding as warning C4324.
#pragma warning(push)
#pragma warning(disable : 4324)
// Single SDK-thread producer, single transport-worker consumer. The ring is allocated once by prepare() and never
// reallocated while the adapter holds the channel. The producer never blocks, allocates, calls the SDK or signals an
// event: the worker polls front() at least every 10 ms.
class EventChannel final {
 public:
  EventChannel() = default;
  EventChannel(const EventChannel&) = delete;
  EventChannel& operator=(const EventChannel&) = delete;
  // SDK initialization context, while no adapter holds the channel: allocates the ring once and starts a plugin session
  // at eventSeq 1 with the gate closed. False when the allocation fails.
  bool prepare() noexcept;
  bool prepared() const noexcept { return slots_ != nullptr; }

  // Transport worker. Open `durable` only after EventStore::connect(), so that every record copied for the consumer is
  // retained; close it before EventStore::disconnect(). Records already copied stay in the ring and are retained (OD-5 S4).
  void set_gate(Gate gate) noexcept { gate_.store(gate, std::memory_order_release); }
  Gate gate() const noexcept { return gate_.load(std::memory_order_acquire); }

  // SDK callback thread only. Assigns the next eventSeq and copies the record into a free slot while the gate is
  // durable; otherwise the eventSeq extends the open loss run with cause offline (gate none), noDurableConsumer (gate
  // live) or queueCount (ring full). The copied record carries the closed run as `loss_before`. Returns the assigned
  // eventSeq, or 0 when the sequence is exhausted or the channel is not prepared; then nothing is assigned.
  std::uint64_t observe(const EventRecord& record) noexcept;
  // SDK callback thread only, at every frame_end: moves an open loss run into a free slot of its own, so that a
  // trailing run reaches the worker without waiting for the next copied record. A full ring keeps the run open.
  void flush_loss() noexcept;

  // Transport worker only: the oldest unconsumed slot, or nullptr. The slot stays valid until pop().
  const ChannelSlot* front() const noexcept;
  void pop() noexcept;

  // Any thread: the next eventSeq the SDK thread would assign. A store's next eventSeq never exceeds it.
  std::uint64_t next_event_seq() const noexcept { return assigned_next_.load(std::memory_order_acquire); }
  // Any thread: true once max_event_seq has been assigned; observe() then assigns nothing more.
  bool exhausted() const noexcept { return next_event_seq() > max_event_seq; }

 private:
  friend struct EventChannelTestAccess;
  void lose(std::uint64_t event_seq, LossCause cause, const Field<std::uint64_t>& observed_ns) noexcept;
  bool push(const EventRecord* record, std::uint64_t event_seq) noexcept;
  std::unique_ptr<ChannelSlot[]> slots_;
  // The consumer-written head has a cache line of its own, apart from the producer-written tail and eventSeq. The
  // gate is written by the worker only on connection changes.
  alignas(cache_line) std::atomic<std::uint64_t> head_{0};
  alignas(cache_line) std::atomic<std::uint64_t> tail_{0};
  std::atomic<std::uint64_t> assigned_next_{1};
  std::atomic<Gate> gate_{Gate::none};
  // SDK thread only: the loss run not yet handed to the worker.
  LossRun open_; bool has_open_ = false;
};
#pragma warning(pop)
static_assert(alignof(EventChannel) == cache_line && sizeof(EventChannel) <= 4 * cache_line, "cache-line separated, four lines at most");
} // namespace ets2telemetry::v1
