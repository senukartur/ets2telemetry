#include "evidence-queue.hpp"
#include <cmath>
#include <cstring>
#include <new>
#include <stdexcept>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace ets2telemetry::cap0 {
namespace {
void saturating_add(std::atomic<std::uint64_t>& value, std::uint64_t count) noexcept {
  auto previous = value.load(std::memory_order_relaxed);
  while (!value.compare_exchange_weak(previous, count > UINT64_MAX - previous ? UINT64_MAX : previous + count, std::memory_order_relaxed)) {}
}
// Valid UTF-8 scalar sequence. Unlike v0 identifiers, evidence keeps C0 controls: JSON escapes them.
bool valid_utf8(const char* data, std::size_t size) noexcept {
  std::size_t i = 0;
  while (i < size) {
    auto byte = static_cast<unsigned char>(data[i++]);
    if (byte < 128) continue;
    unsigned count = 0; std::uint32_t code = 0, minimum = 0;
    if (byte >= 0xc2 && byte <= 0xdf) { count = 1; code = byte & 31; minimum = 0x80; }
    else if (byte >= 0xe0 && byte <= 0xef) { count = 2; code = byte & 15; minimum = 0x800; }
    else if (byte >= 0xf0 && byte <= 0xf4) { count = 3; code = byte & 7; minimum = 0x10000; }
    else return false;
    if (i + count > size) return false;
    for (unsigned j = 0; j < count; ++j) { byte = static_cast<unsigned char>(data[i++]); if ((byte & 0xc0) != 0x80) return false; code = (code << 6) | (byte & 63); }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
struct Bounded { Status status = Status::available; Detail detail = Detail::none; std::size_t length = 0; };
// Reads at most limit+1 bytes from a borrowed SDK string: no unbounded scan of foreign memory.
Bounded inspect(const char* text, std::size_t limit, Detail null_detail) noexcept {
  Bounded result;
  if (!text) { result.status = Status::invalid; result.detail = null_detail; return result; }
  while (result.length <= limit && text[result.length]) ++result.length;
  if (result.length > limit) { result.status = Status::invalid; result.detail = Detail::too_long; result.length = 0; return result; }
  if (!valid_utf8(text, result.length)) { result.status = Status::invalid; result.detail = Detail::invalid_utf8; result.length = 0; }
  return result;
}
std::size_t payload_size(const scs_value_t& value, Status& status, Detail& detail) noexcept {
  status = Status::available; detail = Detail::none;
  auto finite = [&](std::initializer_list<double> numbers) { for (auto n : numbers) if (!std::isfinite(n)) { status = Status::invalid; detail = Detail::non_finite; return; } };
  switch (value.type) {
    case SCS_VALUE_TYPE_bool: return 1;
    case SCS_VALUE_TYPE_s32: case SCS_VALUE_TYPE_u32: return 4;
    case SCS_VALUE_TYPE_s64: case SCS_VALUE_TYPE_u64: return 8;
    case SCS_VALUE_TYPE_float: finite({value.value_float.value}); return status == Status::available ? 8 : 0;
    case SCS_VALUE_TYPE_double: finite({value.value_double.value}); return status == Status::available ? 8 : 0;
    case SCS_VALUE_TYPE_fvector: finite({value.value_fvector.x, value.value_fvector.y, value.value_fvector.z}); return status == Status::available ? 24 : 0;
    case SCS_VALUE_TYPE_dvector: finite({value.value_dvector.x, value.value_dvector.y, value.value_dvector.z}); return status == Status::available ? 24 : 0;
    case SCS_VALUE_TYPE_euler: finite({value.value_euler.heading, value.value_euler.pitch, value.value_euler.roll}); return status == Status::available ? 24 : 0;
    case SCS_VALUE_TYPE_fplacement: {
      const auto& p = value.value_fplacement; finite({p.position.x, p.position.y, p.position.z, p.orientation.heading, p.orientation.pitch, p.orientation.roll});
      return status == Status::available ? 48 : 0;
    }
    case SCS_VALUE_TYPE_dplacement: {
      const auto& p = value.value_dplacement; finite({p.position.x, p.position.y, p.position.z, p.orientation.heading, p.orientation.pitch, p.orientation.roll});
      return status == Status::available ? 48 : 0;
    }
    case SCS_VALUE_TYPE_string: {
      const auto text = inspect(value.value_string.value, string_bytes, Detail::null_value);
      status = text.status; detail = text.detail; return 2 + text.length;
    }
    default: status = Status::not_supported; detail = Detail::unsupported_type; return 0;
  }
}
// One encoder walks the same bounded input twice: once to size, once to copy.
template<bool Write> class Packer {
 public:
  explicit Packer(unsigned char* output = nullptr) noexcept : output_(output) {}
  template<class T> void put(const T& value) noexcept { bytes(&value, sizeof(T)); }
  void bytes(const void* data, std::size_t size) noexcept { if constexpr (Write) std::memcpy(output_ + size_, data, size); size_ += size; }
  void text(const char* value, std::size_t limit, Detail null_detail) noexcept {
    const auto bounded = inspect(value, limit, null_detail);
    put(static_cast<std::uint8_t>(bounded.status)); put(static_cast<std::uint8_t>(bounded.detail)); put(static_cast<std::uint16_t>(bounded.length));
    if (bounded.length) bytes(value, bounded.length);
  }
  void value(const scs_value_t& value) noexcept {
    Status status{}; Detail detail{};
    payload_size(value, status, detail);
    put(static_cast<std::uint32_t>(value.type));
    if (value.type == SCS_VALUE_TYPE_string) { text(value.value_string.value, string_bytes, Detail::null_value); return; }
    put(static_cast<std::uint8_t>(status)); put(static_cast<std::uint8_t>(detail));
    if (status != Status::available) return;
    switch (value.type) {
      case SCS_VALUE_TYPE_bool: put(static_cast<std::uint8_t>(value.value_bool.value ? 1 : 0)); break;
      case SCS_VALUE_TYPE_s32: put(value.value_s32.value); break;
      case SCS_VALUE_TYPE_u32: put(value.value_u32.value); break;
      case SCS_VALUE_TYPE_s64: put(value.value_s64.value); break;
      case SCS_VALUE_TYPE_u64: put(value.value_u64.value); break;
      case SCS_VALUE_TYPE_float: put(static_cast<double>(value.value_float.value)); break;
      case SCS_VALUE_TYPE_double: put(value.value_double.value); break;
      case SCS_VALUE_TYPE_fvector: for (double n : {static_cast<double>(value.value_fvector.x), static_cast<double>(value.value_fvector.y), static_cast<double>(value.value_fvector.z)}) put(n); break;
      case SCS_VALUE_TYPE_dvector: for (double n : {value.value_dvector.x, value.value_dvector.y, value.value_dvector.z}) put(n); break;
      case SCS_VALUE_TYPE_euler: for (double n : {static_cast<double>(value.value_euler.heading), static_cast<double>(value.value_euler.pitch), static_cast<double>(value.value_euler.roll)}) put(n); break;
      case SCS_VALUE_TYPE_fplacement: { const auto& p = value.value_fplacement;
        for (double n : {static_cast<double>(p.position.x), static_cast<double>(p.position.y), static_cast<double>(p.position.z), static_cast<double>(p.orientation.heading), static_cast<double>(p.orientation.pitch), static_cast<double>(p.orientation.roll)}) put(n); break; }
      case SCS_VALUE_TYPE_dplacement: { const auto& p = value.value_dplacement;
        for (double n : {p.position.x, p.position.y, p.position.z, static_cast<double>(p.orientation.heading), static_cast<double>(p.orientation.pitch), static_cast<double>(p.orientation.roll)}) put(n); break; }
      default: break;
    }
  }
  void envelope(const Context& c, std::uint64_t seq, std::uint64_t dropped_before) noexcept {
    put(std::uint32_t{0}); // Patched size placeholder.
    put(static_cast<std::uint8_t>(c.kind)); put(seq); put(dropped_before); put(c.boundary_order); put(c.configuration_revision);
    put(static_cast<std::uint8_t>(c.monotonic_available)); put(c.monotonic_ns);
    put(static_cast<std::uint8_t>(c.frame_available)); put(c.render_us); put(c.simulation_us); put(c.paused_simulation_us);
    put(static_cast<std::uint8_t>(c.game_time_status)); put(c.game_time_minutes);
    std::array<char, 36> clock{};
    if (c.game_clock_id) for (std::size_t i = 0; i < clock.size() && c.game_clock_id[i]; ++i) clock[i] = c.game_clock_id[i];
    bytes(clock.data(), clock.size());
    put(static_cast<std::uint8_t>(c.simulation));
    text(c.id, identifier_bytes, Detail::null_name);
    const bool null_attributes = c.attributes_expected && !c.attributes;
    put(static_cast<std::uint8_t>(c.attributes_expected)); put(static_cast<std::uint8_t>(null_attributes));
    std::uint16_t count = 0; bool terminated = !c.attributes_expected || null_attributes;
    if (c.attributes) for (std::size_t i = 0; i < attribute_scan; ++i) { if (!c.attributes[i].name) { terminated = true; break; } ++count; }
    put(static_cast<std::uint8_t>(terminated)); put(count);
    for (std::uint16_t i = 0; i < count; ++i) {
      const auto& attribute = c.attributes[i];
      text(attribute.name, identifier_bytes, Detail::null_name); put(attribute.index); value(attribute.value);
    }
  }
  std::size_t size() const noexcept { return size_; }
 private:
  unsigned char* output_; std::size_t size_ = 0;
};
class Reader {
 public:
  Reader(const unsigned char* data, std::size_t size) : data_(data), size_(size) {}
  template<class T> T get() { T value{}; take(&value, sizeof(T)); return value; }
  void take(void* output, std::size_t size) { if (size > size_ - offset_) throw std::runtime_error("evidence-record"); std::memcpy(output, data_ + offset_, size); offset_ += size; }
  Text text() {
    Text result; result.status = static_cast<Status>(get<std::uint8_t>()); result.detail = static_cast<Detail>(get<std::uint8_t>());
    const auto length = get<std::uint16_t>(); result.value.resize(length); if (length) take(result.value.data(), length); return result;
  }
  bool done() const noexcept { return offset_ == size_; }
 private:
  const unsigned char* data_; std::size_t size_, offset_ = 0;
};
}

std::size_t EvidenceQueue::encoded_size(const Context& context) noexcept {
  Packer<false> sizing; sizing.envelope(context, 0, 0); return sizing.size();
}
bool EvidenceQueue::prepare() noexcept {
  if (open_.load(std::memory_order_acquire)) return false;
  try { if (!arena_) arena_.reset(new unsigned char[queue_bytes]); } catch (...) { return false; }
  head_.store(0, std::memory_order_relaxed); tail_.store(0, std::memory_order_relaxed); used_.store(0, std::memory_order_relaxed);
  write_ = 0; pending_drops_ = 0;
  for (auto* counter : {&attempted_, &enqueued_, &dequeued_, &dropped_, &dropped_bytes_, &dropped_slots_, &dropped_capacity_, &last_dropped_seq_, &last_drop_ns_}) counter->store(0, std::memory_order_relaxed);
  last_drop_available_.store(false, std::memory_order_relaxed);
  return true;
}
void EvidenceQueue::open() noexcept { if (arena_) open_.store(true, std::memory_order_seq_cst); }
void EvidenceQueue::close() noexcept {
  open_.store(false, std::memory_order_seq_cst);
  // Dekker-style handshake with capture(): a producer that observed the open gate is still
  // copying. The section is bounded by the attribute/string caps and never waits.
  while (in_capture_.load(std::memory_order_seq_cst)) YieldProcessor();
}
void EvidenceQueue::drop(std::uint64_t seq, std::uint64_t bytes, bool slots, std::uint64_t monotonic_ns, bool monotonic_available) noexcept {
  saturating_add(dropped_, 1); saturating_add(dropped_bytes_, bytes); saturating_add(slots ? dropped_slots_ : dropped_capacity_, 1);
  last_dropped_seq_.store(seq, std::memory_order_relaxed);
  if (monotonic_available) { last_drop_ns_.store(monotonic_ns, std::memory_order_relaxed); last_drop_available_.store(true, std::memory_order_relaxed); }
  if (pending_drops_ != UINT64_MAX) ++pending_drops_;
}
void EvidenceQueue::capture(const Context& context) noexcept {
  in_capture_.fetch_add(1, std::memory_order_seq_cst);
  if (!open_.load(std::memory_order_seq_cst)) { in_capture_.fetch_sub(1, std::memory_order_release); return; }
  const auto seq = attempted_.load(std::memory_order_relaxed) == UINT64_MAX ? UINT64_MAX : attempted_.load(std::memory_order_relaxed) + 1;
  attempted_.store(seq, std::memory_order_relaxed);
  const auto size = encoded_size(context);
  const auto tail = tail_.load(std::memory_order_relaxed), head = head_.load(std::memory_order_acquire);
  auto used = used_.load(std::memory_order_acquire);
  // An empty ring can restart at offset zero; the consumer owns no record.
  if (tail == head && used == 0) write_ = 0;
  if (tail - head >= queue_envelopes) drop(seq, size, true, context.monotonic_ns, context.monotonic_available);
  else {
    std::size_t offset = write_, charge = size;
    if (size > queue_bytes - write_) { offset = 0; charge = (queue_bytes - write_) + size; }
    if (size > queue_bytes || charge > queue_bytes - used) drop(seq, size, false, context.monotonic_ns, context.monotonic_available);
    else {
      Packer<true> writer(arena_.get() + offset); writer.envelope(context, seq, pending_drops_);
      const auto written = static_cast<std::uint32_t>(writer.size()); std::memcpy(arena_.get() + offset, &written, sizeof(written));
      slots_[tail % queue_envelopes] = {static_cast<std::uint32_t>(offset), written, static_cast<std::uint32_t>(charge)};
      write_ = offset + size == queue_bytes ? 0 : offset + size;
      used_.fetch_add(charge, std::memory_order_acq_rel);
      pending_drops_ = 0; saturating_add(enqueued_, 1);
      tail_.store(tail + 1, std::memory_order_release);
    }
  }
  in_capture_.fetch_sub(1, std::memory_order_release);
}
bool EvidenceQueue::pop(Envelope& output) {
  const auto head = head_.load(std::memory_order_relaxed);
  if (head == tail_.load(std::memory_order_acquire)) return false;
  const auto slot = slots_[head % queue_envelopes];
  Reader reader(arena_.get() + slot.offset, slot.size);
  Envelope e;
  reader.get<std::uint32_t>(); e.kind = static_cast<Kind>(reader.get<std::uint8_t>());
  e.seq = reader.get<std::uint64_t>(); e.dropped_before = reader.get<std::uint64_t>(); e.boundary_order = reader.get<std::uint64_t>(); e.configuration_revision = reader.get<std::uint64_t>();
  e.monotonic_available = reader.get<std::uint8_t>() != 0; e.monotonic_ns = reader.get<std::uint64_t>();
  e.frame_available = reader.get<std::uint8_t>() != 0; e.render_us = reader.get<std::uint64_t>(); e.simulation_us = reader.get<std::uint64_t>(); e.paused_simulation_us = reader.get<std::uint64_t>();
  e.game_time_status = static_cast<Status>(reader.get<std::uint8_t>()); e.game_time_minutes = reader.get<std::uint32_t>();
  std::array<char, 36> clock{}; reader.take(clock.data(), clock.size()); e.game_clock_id.assign(clock.data(), clock[35] ? 36 : std::strlen(clock.data()));
  e.simulation = static_cast<Simulation>(reader.get<std::uint8_t>());
  e.id = reader.text();
  e.attributes_expected = reader.get<std::uint8_t>() != 0; e.attributes_null = reader.get<std::uint8_t>() != 0; e.terminated = reader.get<std::uint8_t>() != 0;
  const auto count = reader.get<std::uint16_t>(); e.attributes.resize(count);
  for (auto& attribute : e.attributes) {
    attribute.name = reader.text(); attribute.index = reader.get<std::uint32_t>();
    auto& v = attribute.value; v.type = reader.get<std::uint32_t>();
    if (v.type == SCS_VALUE_TYPE_string) { auto t = reader.text(); v.status = t.status; v.detail = t.detail; v.text = std::move(t.value); continue; }
    v.status = static_cast<Status>(reader.get<std::uint8_t>()); v.detail = static_cast<Detail>(reader.get<std::uint8_t>());
    if (v.status != Status::available) continue;
    switch (v.type) {
      case SCS_VALUE_TYPE_bool: v.boolean = reader.get<std::uint8_t>() != 0; break;
      case SCS_VALUE_TYPE_s32: v.signed_integer = reader.get<std::int32_t>(); break;
      case SCS_VALUE_TYPE_u32: v.unsigned_integer = reader.get<std::uint32_t>(); break;
      case SCS_VALUE_TYPE_s64: v.signed_integer = reader.get<std::int64_t>(); break;
      case SCS_VALUE_TYPE_u64: v.unsigned_integer = reader.get<std::uint64_t>(); break;
      case SCS_VALUE_TYPE_float: case SCS_VALUE_TYPE_double: v.numbers[0] = reader.get<double>(); break;
      case SCS_VALUE_TYPE_fvector: case SCS_VALUE_TYPE_dvector: case SCS_VALUE_TYPE_euler: for (std::size_t i = 0; i < 3; ++i) v.numbers[i] = reader.get<double>(); break;
      case SCS_VALUE_TYPE_fplacement: case SCS_VALUE_TYPE_dplacement: for (auto& n : v.numbers) n = reader.get<double>(); break;
      default: break;
    }
  }
  if (!reader.done()) throw std::runtime_error("evidence-record");
  used_.fetch_sub(slot.charge, std::memory_order_acq_rel);
  head_.store(head + 1, std::memory_order_release);
  saturating_add(dequeued_, 1);
  output = std::move(e); return true;
}
Counters EvidenceQueue::counters() const noexcept {
  Counters c;
  c.attempted = attempted_.load(std::memory_order_relaxed); c.enqueued = enqueued_.load(std::memory_order_relaxed); c.dequeued = dequeued_.load(std::memory_order_relaxed);
  c.dropped = dropped_.load(std::memory_order_relaxed); c.dropped_bytes = dropped_bytes_.load(std::memory_order_relaxed);
  c.dropped_full_slots = dropped_slots_.load(std::memory_order_relaxed); c.dropped_full_bytes = dropped_capacity_.load(std::memory_order_relaxed);
  c.last_drop_available = last_drop_available_.load(std::memory_order_relaxed); c.last_dropped_seq = last_dropped_seq_.load(std::memory_order_relaxed); c.last_drop_monotonic_ns = last_drop_ns_.load(std::memory_order_relaxed);
  return c;
}
std::size_t EvidenceQueue::queued_envelopes() const noexcept {
  return static_cast<std::size_t>(tail_.load(std::memory_order_acquire) - head_.load(std::memory_order_acquire));
}
}
