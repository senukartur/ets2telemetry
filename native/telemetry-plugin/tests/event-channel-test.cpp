#include "event-channel.hpp"
#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

// ET-004b callback capture: the single-producer/single-consumer ring between the SDK callback thread and the v1
// transport worker, its gate, loss runs, frame flush and sequence exhaustion. Expected values are written by hand from
// docs/native-transport-v1.md; observation times are explicit arguments and random choices use fixed seeds.
namespace ets2telemetry::v1 {
struct EventChannelTestAccess {
  static void start_at(EventChannel& channel, std::uint64_t event_seq) { channel.assigned_next_.store(event_seq); }
  // The consumer-written head shares no cache line with the producer-written tail, eventSeq or the gate.
  static bool head_alone(const EventChannel& c) {
    const auto line = [](const void* p) { return reinterpret_cast<std::uintptr_t>(p) / cache_line; };
    return line(&c.head_) != line(&c.tail_) && line(&c.head_) != line(&c.assigned_next_) && line(&c.head_) != line(&c.gate_);
  }
};
}
using namespace ets2telemetry::v1;
namespace {
unsigned assertions = 0;
void check(bool ok, const std::string& name) { ++assertions; if (!ok) throw std::runtime_error(name); }
EventRecord observation(std::uint64_t ns) {
  EventRecord e; e.occurred.monotonic_ns = available_field(ns); e.occurred.boundary_order = ns; e.record = records::SimulationPaused{}; return e;
}
EventRecord unobserved_time() { EventRecord e; e.record = records::SimulationStarted{}; return e; }
std::uint64_t total(const LossCounts& c) { return c.offline + c.no_durable_consumer + c.queue_count + c.queue_bytes + c.retention_expired + c.encoding_failed; }
bool same(const LossCounts& a, const LossCounts& b) {
  return a.offline == b.offline && a.no_durable_consumer == b.no_durable_consumer && a.queue_count == b.queue_count && a.queue_bytes == b.queue_bytes &&
    a.retention_expired == b.retention_expired && a.encoding_failed == b.encoding_failed;
}
LossCounts causes(std::uint64_t offline, std::uint64_t no_durable, std::uint64_t queue_count) { LossCounts c; c.offline = offline; c.no_durable_consumer = no_durable; c.queue_count = queue_count; return c; }

// The worker's view: every slot in ring order. Coverage must be contiguous from eventSeq 1, a loss run must precede its
// record, the run's causes must add up to its length, and the channel's own causes are only the three capture causes.
struct Drain {
  std::uint64_t next = 1; LossCounts lost; std::vector<LossRun> runs; std::vector<EventRecord> records; std::size_t slots = 0;
  // The stress case keeps no copies; it checks that each record carries its own eventSeq as its observation time.
  bool keep = true; std::uint64_t copied = 0, foreign_content = 0;
  explicit Drain(std::uint64_t first = 1) : next(first) {}
  void slot(const ChannelSlot& s) {
    check(s.has_loss || s.has_record, "a slot is never empty");
    ++slots;
    if (s.has_loss) {
      const auto& r = s.loss_before;
      check(r.first_event_seq == next && r.last_event_seq >= r.first_event_seq && total(r.causes) == r.last_event_seq - r.first_event_seq + 1, "loss run contiguous with exact causes");
      check(r.causes.queue_bytes == 0 && r.causes.retention_expired == 0 && r.causes.encoding_failed == 0, "capture causes only");
      check(!r.times_available || r.first_lost_ns <= r.last_lost_ns, "lost times ordered");
      lost.offline += r.causes.offline; lost.no_durable_consumer += r.causes.no_durable_consumer; lost.queue_count += r.causes.queue_count;
      runs.push_back(r); next = r.last_event_seq + 1;
    }
    if (s.has_record) {
      check(s.record.event_seq == next, "record eventSeq follows coverage");
      if (keep) records.push_back(s.record);
      else if (s.record.occurred.monotonic_ns.value != s.record.event_seq || s.record.occurred.boundary_order != s.record.event_seq) ++foreign_content;
      ++copied; ++next;
    }
  }
  std::size_t all(EventChannel& channel, std::size_t limit = ~std::size_t{0}) {
    std::size_t n = 0;
    while (n < limit) { const auto* s = channel.front(); if (!s) break; slot(*s); channel.pop(); ++n; }
    return n;
  }
};

void ring_case() {
  EventChannel channel;
  check(EventChannelTestAccess::head_alone(channel), "head on its own cache line");
  check(!channel.prepared() && !channel.front() && channel.observe(observation(1)) == 0 && channel.next_event_seq() == 1, "nothing is assigned before prepare");
  check(channel.prepare() && channel.prepared() && channel.gate() == Gate::none && channel.next_event_seq() == 1, "prepared at eventSeq 1 with the gate closed");
  channel.set_gate(Gate::durable);
  auto job = observation(1005); auto& body = job.record.emplace<records::JobConfigured>(); body.cargo.assign("Synthetic Cargo"); body.planned_distance_km = available_field<std::uint32_t>(152);
  for (std::uint64_t i = 1; i <= channel_slots; ++i) {
    const auto seq = i == 5 ? channel.observe(job) : channel.observe(observation(1000 + i));
    check(seq == i, "eventSeq assigned in observation order");
  }
  // The caller's record is copied, not borrowed: changing it afterwards does not reach the ring.
  body.cargo.assign("Changed"); job.occurred.monotonic_ns = available_field<std::uint64_t>(1);
  check(channel.observe(observation(1129)) == 129 && channel.observe(observation(1130)) == 130, "a full ring still assigns eventSeq");
  const auto* first = channel.front();
  check(first && first->has_record && !first->has_loss && first->record.event_seq == 1 && first->record.occurred.monotonic_ns.value == 1001, "oldest slot first");
  const auto* first_slot = first; channel.pop();
  check(channel.observe(observation(1131)) == 131, "a freed slot takes the next record");
  Drain drain(2); drain.all(channel);
  check(drain.records.size() == channel_slots && drain.runs.size() == 1, "127 records, then the run with the next record");
  const auto& copied = drain.records[3];
  check(copied.event_seq == 5 && record_type(copied) == std::string("job.configured") && copied.occurred.monotonic_ns.value == 1005, "record identity copied");
  const auto& copied_job = std::get<records::JobConfigured>(copied.record);
  check(copied_job.cargo.view() == "Synthetic Cargo" && copied_job.planned_distance_km.value == 152, "record body copied at observation");
  const auto& run = drain.runs.at(0);
  check(run.first_event_seq == 129 && run.last_event_seq == 130 && same(run.causes, causes(0, 0, 2)), "ring overflow is queueCount");
  check(run.times_available && run.first_lost_ns == 1129 && run.last_lost_ns == 1130, "overflow lost times");
  check(drain.records.at(drain.records.size() - 1).event_seq == 131 && drain.next == 132, "the run precedes the record that closed it");
  // Index wrap-around keeps order and content through many cycles of fill and drain.
  for (unsigned cycle = 0; cycle < 5; ++cycle) {
    const auto base = channel.next_event_seq();
    for (std::uint64_t i = 0; i < channel_slots; ++i) check(channel.observe(observation(5000 + base + i)) == base + i, "wrapped eventSeq");
    check(!channel.front()->has_loss, "a full drain leaves no run");
    for (std::uint64_t i = 0; i < channel_slots; ++i) {
      const auto* s = channel.front(); check(s && s->has_record && s->record.event_seq == base + i && s->record.occurred.monotonic_ns.value == 5000 + base + i, "wrapped content");
      channel.pop();
    }
    check(!channel.front(), "drained");
  }
  channel.pop(); check(!channel.front() && channel.next_event_seq() == 132 + 5 * channel_slots, "pop on an empty ring has no effect");
  // A new plugin session restarts at eventSeq 1 without reallocating the ring.
  channel.observe(observation(1)); check(channel.prepare() && channel.next_event_seq() == 1 && channel.gate() == Gate::none && !channel.front(), "prepare resets the session");
  channel.set_gate(Gate::durable); check(channel.observe(observation(7)) == 1 && channel.front() == first_slot && !channel.front()->has_loss, "same ring storage, no carried run");
}

void gate_case() {
  EventChannel channel; check(channel.prepare(), "prepare");
  for (std::uint64_t i = 1; i <= 3; ++i) check(channel.observe(observation(100 + i)) == i, "gate none still assigns eventSeq");
  check(!channel.front(), "gate none copies no content");
  channel.flush_loss();
  Drain drain; drain.all(channel);
  check(drain.slots == 1 && drain.records.empty() && drain.runs.size() == 1 && same(drain.runs[0].causes, causes(3, 0, 0)), "gate none is offline loss");
  check(drain.runs[0].first_event_seq == 1 && drain.runs[0].last_event_seq == 3 && drain.runs[0].first_lost_ns == 101 && drain.runs[0].last_lost_ns == 103, "offline run range and times");
  channel.set_gate(Gate::live); check(channel.gate() == Gate::live, "gate stored");
  channel.observe(observation(201)); channel.observe(observation(202));
  check(!channel.front(), "a live-only client gets no content");
  channel.flush_loss(); drain.all(channel);
  check(drain.runs.size() == 2 && same(drain.runs[1].causes, causes(0, 2, 0)) && drain.runs[1].first_event_seq == 4 && drain.runs[1].last_event_seq == 5, "gate live is noDurableConsumer loss");
  channel.set_gate(Gate::durable); channel.observe(observation(301));
  const auto* copied = channel.front();
  check(copied && copied->has_record && !copied->has_loss && copied->record.event_seq == 6, "gate durable copies the record");
  drain.all(channel);
  // Gate transitions inside one run keep exact per-cause counts.
  channel.set_gate(Gate::none); channel.observe(observation(401));
  channel.set_gate(Gate::live); channel.observe(observation(402)); channel.observe(observation(403));
  channel.set_gate(Gate::durable); channel.observe(observation(404));
  drain.all(channel);
  const auto& mixed = drain.runs.at(drain.runs.size() - 1);
  check(mixed.first_event_seq == 7 && mixed.last_event_seq == 9 && same(mixed.causes, causes(1, 2, 0)) && drain.records.at(drain.records.size() - 1).event_seq == 10, "mixed-cause run before the copied record");
  // A record copied while durable stays in the ring after the gate closes (OD-5 S4: the store retains it).
  channel.observe(observation(501)); channel.set_gate(Gate::none);
  check(channel.front() && channel.front()->has_record && channel.front()->record.event_seq == 11, "copied record survives the gate closing");
  channel.observe(observation(502)); channel.flush_loss(); drain.all(channel);
  check(drain.records.at(drain.records.size() - 1).event_seq == 11 && same(drain.runs.at(drain.runs.size() - 1).causes, causes(1, 0, 0)) && drain.next == 13, "later loss after the gate closed");
  check(same(drain.lost, causes(5, 4, 0)) && drain.records.size() == 3, "cumulative causes exact");
}

void loss_runs_case() {
  EventChannel channel; check(channel.prepare(), "prepare");
  // Lost times are the earliest and latest available observation, not the first and last in order (OD-5 S1).
  channel.observe(observation(500)); channel.observe(observation(300)); channel.observe(unobserved_time()); channel.observe(observation(900)); channel.observe(observation(700));
  channel.flush_loss(); Drain drain; drain.all(channel);
  check(drain.runs.at(0).times_available && drain.runs.at(0).first_lost_ns == 300 && drain.runs.at(0).last_lost_ns == 900 && drain.runs.at(0).last_event_seq == 5, "lost times are min and max");
  channel.observe(unobserved_time()); channel.observe(unobserved_time()); channel.flush_loss(); drain.all(channel);
  check(!drain.runs.at(1).times_available && drain.runs.at(1).first_event_seq == 6 && drain.runs.at(1).last_event_seq == 7, "no available time, no lost times");
  // One run spans a full ring and two gate changes; the next copied record closes it.
  channel.set_gate(Gate::durable);
  for (std::size_t i = 0; i < channel_slots; ++i) channel.observe(observation(1000 + i));
  channel.observe(observation(2001)); channel.observe(observation(2002)); channel.observe(observation(2003));
  channel.set_gate(Gate::live); channel.observe(observation(2004));
  channel.set_gate(Gate::none); channel.observe(observation(2005));
  channel.flush_loss();
  drain.all(channel, 1); channel.set_gate(Gate::durable);
  check(channel.observe(observation(3000)) == 141, "the record after the run");
  drain.all(channel);
  const auto& run = drain.runs.at(drain.runs.size() - 1);
  check(drain.runs.size() == 3 && run.first_event_seq == 136 && run.last_event_seq == 140 && same(run.causes, causes(1, 1, 3)), "one run across a full ring and gate changes");
  check(run.first_lost_ns == 2001 && run.last_lost_ns == 2005 && drain.records.at(drain.records.size() - 1).event_seq == 141 && drain.next == 142, "run carried by the next copied record");
  // A copied record closes the run: the next loss opens a new one.
  channel.set_gate(Gate::live); channel.observe(observation(4000)); channel.flush_loss(); drain.all(channel);
  check(drain.runs.at(drain.runs.size() - 1).first_event_seq == 142 && drain.runs.at(drain.runs.size() - 1).last_event_seq == 142, "new run after a copy");
}

void flush_case() {
  EventChannel channel; check(channel.prepare(), "prepare");
  channel.flush_loss(); check(!channel.front(), "no run, no slot");
  channel.observe(observation(1)); channel.observe(observation(2)); channel.flush_loss();
  const auto* only = channel.front();
  check(only && only->has_loss && !only->has_record && only->loss_before.last_event_seq == 2, "the trailing run reaches the worker without a later record");
  Drain drain; drain.all(channel); channel.flush_loss(); check(!channel.front(), "a flushed run is closed");
  // With a full ring the run stays open and keeps extending until a slot frees.
  channel.set_gate(Gate::durable);
  for (std::size_t i = 0; i < channel_slots; ++i) channel.observe(observation(100 + i));
  channel.set_gate(Gate::none); channel.observe(observation(500)); channel.flush_loss(); channel.observe(observation(501));
  drain.all(channel, channel_slots);
  check(!channel.front(), "the full ring had no room for the run");
  channel.flush_loss();
  drain.all(channel);
  check(drain.runs.size() == 2 && drain.runs[1].first_event_seq == 131 && drain.runs[1].last_event_seq == 132 && same(drain.runs[1].causes, causes(2, 0, 0)), "run extended while the ring was full");
  check(drain.next == channel.next_event_seq(), "complete coverage after the flush");
}

void concurrency_case() {
  // A producer thread observes like SDK callbacks in frames of 64 observations, each ending with flush_loss() like
  // frame_end. The consumer releases one frame at a time and drains while the producer copies, so both threads touch the
  // ring concurrently. With a fixed seed it changes the gate between frames and sometimes stalls for three frames,
  // longer than the ring. Every eventSeq must arrive once, in order, with its own content.
  constexpr std::uint64_t frame = 64, frames = 6000, observations = frame * frames;
  EventChannel channel; check(channel.prepare(), "prepare");
  std::atomic<std::uint64_t> released{0}, produced{0}; std::atomic<bool> wrong_sequence{false};
  std::thread producer([&] {
    for (std::uint64_t f = 0; f < frames; ++f) {
      while (released.load() <= f) std::this_thread::yield();
      for (std::uint64_t i = f * frame + 1; i <= (f + 1) * frame; ++i) if (channel.observe(observation(i)) != i) wrong_sequence.store(true);
      channel.flush_loss(); produced.store(f + 1);
    }
  });
  std::mt19937 random(20261014); Drain drain; drain.keep = false; std::uint64_t stalled_frames = 0; unsigned stall = 0;
  try {
    for (std::uint64_t f = 0; f < frames; ++f) {
      const auto choice = random() % 100;
      if (choice < 10) channel.set_gate(Gate::none); else if (choice < 20) channel.set_gate(Gate::live); else if (choice < 60) channel.set_gate(Gate::durable);
      if (!stall && choice >= 92) stall = 3;
      released.store(f + 1);
      if (stall) { --stall; ++stalled_frames; while (produced.load() <= f) std::this_thread::yield(); }
      else { while (produced.load() <= f) drain.all(channel, 8); }
    }
  } catch (...) { released.store(frames); producer.join(); throw; }
  producer.join();
  // After the join this thread may take the producer role: a run left open by a full ring is flushed now.
  drain.all(channel); channel.flush_loss(); drain.all(channel);
  check(!wrong_sequence.load(), "eventSeq assigned in observation order");
  check(drain.foreign_content == 0, "every copied record carries its own content");
  check(drain.next == observations + 1 && drain.copied + total(drain.lost) == observations, "every eventSeq covered exactly once, in order");
  std::cout << "concurrency: copied=" << drain.copied << " offline=" << drain.lost.offline << " noDurableConsumer=" << drain.lost.no_durable_consumer
    << " queueCount=" << drain.lost.queue_count << " runs=" << drain.runs.size() << " slots=" << drain.slots << " stalledFrames=" << stalled_frames << "\n";
  check(drain.lost.offline > 0 && drain.lost.no_durable_consumer > 0 && drain.lost.queue_count > 0 && drain.copied > 0, "the seed exercises every capture cause and copies");
}

void exhaustion_case() {
  EventChannel channel; check(channel.prepare(), "prepare"); channel.set_gate(Gate::durable);
  EventChannelTestAccess::start_at(channel, max_event_seq - 2);
  check(channel.observe(observation(1)) == max_event_seq - 2 && channel.observe(observation(2)) == max_event_seq - 1 && !channel.exhausted(), "near the end");
  check(channel.observe(observation(3)) == max_event_seq && channel.exhausted() && channel.next_event_seq() == max_event_seq + 1, "the last assignable eventSeq");
  check(channel.observe(observation(4)) == 0 && channel.next_event_seq() == max_event_seq + 1, "nothing is assigned after exhaustion");
  Drain drain(max_event_seq - 2); drain.all(channel);
  check(drain.records.size() == 3 && drain.records.at(drain.records.size() - 1).event_seq == max_event_seq && drain.next == max_event_seq + 1, "exhausted coverage ends at max_event_seq");
  // A run that reaches max_event_seq still flushes after exhaustion.
  check(channel.prepare(), "prepare again"); EventChannelTestAccess::start_at(channel, max_event_seq - 1);
  channel.observe(observation(10)); channel.observe(observation(11));
  check(channel.observe(observation(12)) == 0 && channel.exhausted(), "exhausted while offline");
  channel.flush_loss(); Drain tail(max_event_seq - 1); tail.all(channel);
  check(tail.runs.size() == 1 && tail.runs[0].last_event_seq == max_event_seq && same(tail.runs[0].causes, causes(2, 0, 0)) && tail.runs[0].last_lost_ns == 11, "the final run ends at max_event_seq");
  check(channel.prepare() && !channel.exhausted() && channel.observe(observation(1)) == 1, "a new session starts again at 1");
}
}

int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("usage: event-channel-test <ring|gate|loss-runs|flush|concurrency|exhaustion>");
    const std::string name = argv[1];
    if (name == "ring") ring_case();
    else if (name == "gate") gate_case();
    else if (name == "loss-runs") loss_runs_case();
    else if (name == "flush") flush_case();
    else if (name == "concurrency") concurrency_case();
    else if (name == "exhaustion") exhaustion_case();
    else throw std::runtime_error("unknown case: " + name);
    std::cout << "event channel " << name << ": " << assertions << " checks passed; slot bytes=" << sizeof(ChannelSlot) << "\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << "event channel failure: " << error.what() << '\n'; return 1; }
}
