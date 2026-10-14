#include "event-channel.hpp"
#include <new>

namespace ets2telemetry::v1 {
namespace {
// Counts never exceed max_event_seq, so a per-cause count cannot wrap.
void count(LossCounts& c, LossCause cause) noexcept {
  switch (cause) {
    case LossCause::offline: ++c.offline; break;
    case LossCause::no_durable_consumer: ++c.no_durable_consumer; break;
    default: ++c.queue_count; break;
  }
}
}

bool EventChannel::prepare() noexcept {
  if (!slots_) slots_.reset(new (std::nothrow) ChannelSlot[channel_slots]);
  if (!slots_) return false;
  head_.store(0, std::memory_order_relaxed); tail_.store(0, std::memory_order_relaxed);
  assigned_next_.store(1, std::memory_order_relaxed); gate_.store(Gate::none, std::memory_order_relaxed);
  open_ = {}; has_open_ = false;
  std::atomic_thread_fence(std::memory_order_release);
  return true;
}

std::uint64_t EventChannel::observe(const EventRecord& record) noexcept {
  const auto event_seq = assigned_next_.load(std::memory_order_relaxed);
  // eventSeq never wraps (§9): after max_event_seq the session ends with sequence-exhausted, assigning nothing more.
  if (!slots_ || event_seq > max_event_seq) return 0;
  assigned_next_.store(event_seq + 1, std::memory_order_release);
  const auto gate = gate_.load(std::memory_order_acquire);
  if (gate == Gate::durable) {
    if (push(&record, event_seq)) return event_seq;
    lose(event_seq, LossCause::queue_count, record.occurred.monotonic_ns);
  } else lose(event_seq, gate == Gate::live ? LossCause::no_durable_consumer : LossCause::offline, record.occurred.monotonic_ns);
  return event_seq;
}

void EventChannel::flush_loss() noexcept { if (has_open_) push(nullptr, 0); }

bool EventChannel::push(const EventRecord* record, std::uint64_t event_seq) noexcept {
  if (!slots_) return false;
  // The acquire load pairs with pop(): the worker has finished reading a slot before the producer reuses it.
  const auto tail = tail_.load(std::memory_order_relaxed);
  if (tail - head_.load(std::memory_order_acquire) >= channel_slots) return false;
  auto& slot = slots_[tail % channel_slots];
  slot.has_loss = has_open_;
  if (has_open_) slot.loss_before = open_;
  slot.has_record = record != nullptr;
  if (record) {
    // EventRecord is trivially copyable: this is a plain fixed-size copy without allocation.
    slot.record = *record; slot.record.event_seq = event_seq;
  }
  tail_.store(tail + 1, std::memory_order_release);
  open_ = {}; has_open_ = false;
  return true;
}

void EventChannel::lose(std::uint64_t event_seq, LossCause cause, const Field<std::uint64_t>& observed_ns) noexcept {
  // Every assigned eventSeq is either copied, which closes the run, or lost here, so an open run is contiguous.
  if (!has_open_) { open_ = {}; open_.first_event_seq = event_seq; has_open_ = true; }
  open_.last_event_seq = event_seq; count(open_.causes, cause);
  if (!observed_ns.available()) return;
  if (!open_.times_available) { open_.times_available = true; open_.first_lost_ns = open_.last_lost_ns = observed_ns.value; return; }
  if (observed_ns.value < open_.first_lost_ns) open_.first_lost_ns = observed_ns.value;
  if (observed_ns.value > open_.last_lost_ns) open_.last_lost_ns = observed_ns.value;
}

const ChannelSlot* EventChannel::front() const noexcept {
  if (!slots_) return nullptr;
  const auto head = head_.load(std::memory_order_relaxed);
  if (head == tail_.load(std::memory_order_acquire)) return nullptr;
  return &slots_[head % channel_slots];
}

void EventChannel::pop() noexcept {
  const auto head = head_.load(std::memory_order_relaxed);
  if (head != tail_.load(std::memory_order_acquire)) head_.store(head + 1, std::memory_order_release);
}
} // namespace ets2telemetry::v1
