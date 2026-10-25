#include "protocol-v1-producer.hpp"
#include "protocol-v1-delivery.hpp"
#include "protocol-json.hpp"
#include "native-fuzz-multiplier.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <new>
#include <random>
#include <sstream>
#include <string>
#include <vector>

// ET-004b producer core: the event store and encoder driven through the ET-002b contract classes as an oracle. Every
// message is encoded, decoded and accepted by the client-side Consumer; the DurableAckCursor stands in for storage
// commits and the AckValidator applies the producer's ACK rule before the store releases anything. Expected values are
// written by hand from docs/protocol/v1.md and docs/native-transport-v1.md, or are the hand-written shared fixtures.
// Test-only allocation failure: when armed with a countdown, the global operator new throws std::bad_alloc once.
namespace { long allocation_countdown = -1; bool allocation_failed = false; }
void* operator new(std::size_t size) {
  if (allocation_countdown == 0) { allocation_countdown = -1; allocation_failed = true; throw std::bad_alloc(); }
  if (allocation_countdown > 0) --allocation_countdown;
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

using namespace ets2telemetry::v1;
namespace v0 = ets2telemetry::v0;
namespace {
constexpr std::uint64_t u64_max = std::numeric_limits<std::uint64_t>::max();
constexpr std::uint64_t retention_ns = 300'000'000'000ULL;
const std::string SESSION = "10000000-0000-4000-8000-000000000001", SESSION_2 = "10000000-0000-4000-8000-000000000002";
const std::string INSTANCE = "20000000-0000-4000-8000-000000000001", SOURCE_CLOCK = "30000000-0000-4000-8000-000000000001";
const std::string GAME_CLOCK = "40000000-0000-4000-8000-000000000001", GAME_CLOCK_2 = "40000000-0000-4000-8000-000000000002";
const std::string EUR_SOURCE = "scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units";
void check(bool ok, const std::string& name) { if (!ok) throw std::runtime_error(name); }
template<class F> void rejects(F f, const std::string& name) {
  try { f(); } catch (const ProtocolError&) { return; }
  throw std::runtime_error(name + ": not rejected");
}
std::string read(const std::filesystem::path& p) {
  std::ifstream s(p, std::ios::binary); if (!s) throw std::runtime_error("Missing fixture: " + p.string());
  return {std::istreambuf_iterator<char>(s), std::istreambuf_iterator<char>()};
}
std::vector<std::vector<std::string>> rows(const std::string& text) {
  std::vector<std::vector<std::string>> result; std::istringstream lines(text); std::string line;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::istringstream tokens(line); std::vector<std::string> row; std::string token;
    while (tokens >> token) row.push_back(token);
    if (!row.empty()) result.push_back(std::move(row));
  }
  return result;
}
std::string canonical(const Json& j) { return v0::detail::serialize(j); }
Json& field(Json& j, const std::string& key) { return std::get<Json::Object>(j.value).at(key); }
const Json& field(const Json& j, const std::string& key) { return std::get<Json::Object>(j.value).at(key); }
Message decode(const std::vector<std::uint8_t>& frame) {
  check(frame.size() > 4, "frame prefix"); return decode_payload(std::string(frame.begin() + 4, frame.end()), Sender::server);
}
struct Fixtures {
  std::filesystem::path dir;
  Message server(const std::string& name) const { return decode_payload(read(dir / (name + ".json")), Sender::server); }
};

SessionIdentity identity(const std::string& session = SESSION, Currency currency = {}) {
  SessionIdentity id; id.source.game = GameId::ets2; id.source.plugin_session_id = make_uuid(session); id.source.process_instance_id = make_uuid(INSTANCE);
  id.source.process_id = 12345; id.source.windows_session_id = 1; id.source.origin = Origin::synthetic; id.capture_clock_id = make_uuid(SOURCE_CLOCK);
  id.currency = std::move(currency); return id;
}
Currency eur() { return Currency{Currency::Status::sdk_documented, "EUR", EUR_SOURCE}; }
GameModePod single_player_weak() { GameModePod g; g.mode = GameModeKind::single_player; g.method = DetectionMethod::module_scan; g.confidence = Confidence::weak; return g; }
OccurrencePod occurred_at(std::uint64_t ns, std::uint64_t boundary = 101) {
  OccurrencePod o; o.monotonic_ns = available_field(ns); o.game_time.minutes = available_field<std::uint32_t>(12345); o.game_time.clock_id = make_uuid(GAME_CLOCK);
  o.utc_unix_ms = available_field<std::uint64_t>(1791676800000ULL); o.simulation = SimulationState::running; o.configuration_revision = 8; o.boundary_order = boundary;
  return o;
}
EventRecord make_event(std::uint64_t seq, RecordBody body, std::uint64_t ns, std::uint64_t boundary = 101) {
  EventRecord e; e.event_seq = seq; e.occurred = occurred_at(ns, boundary); e.record = body; return e;
}
StatePod minimal_state() { StatePod s; s.game_time.clock_id = make_uuid(GAME_CLOCK); return s; }
records::JobConfigured synthetic_job() {
  records::JobConfigured j;
  j.source_city_id.assign("synthetic_city_a"); j.source_city.assign("Synthetic City A"); j.source_company_id.assign("synthetic_company_a"); j.source_company.assign("Synthetic Company A");
  j.destination_city_id.assign("synthetic_city_b"); j.destination_city.assign("Synthetic City B"); j.destination_company_id.assign("synthetic_company_b");
  j.destination_company.assign("Synthetic Company B"); j.cargo_id.assign("synthetic_cargo"); j.cargo.assign("Synthetic Cargo");
  j.cargo_mass_kg = available_field(18000.0); j.cargo_unit_mass_kg = available_field(1000.0); j.cargo_unit_count = available_field<std::uint32_t>(18);
  j.market.assign("freight_market"); j.is_special_job = available_field(false); j.cargo_loaded = available_field(true);
  j.planned_distance_km = available_field<std::uint32_t>(152); j.expected_income = available_field<std::uint64_t>(12345); j.delivery_deadline_min = available_field<std::uint32_t>(13000);
  return j;
}
records::TruckConfigured synthetic_truck() {
  records::TruckConfigured t; t.brand_id.assign("synthetic_brand"); t.brand.assign("Synthetic Brand"); t.id.assign("vehicle.synthetic_truck"); t.name.assign("Synthetic Truck");
  t.fuel_capacity_l = available_field(1000.0); t.license_plate.assign("SYN 0001"); t.plate_country_id.assign("synthetica"); t.plate_country.assign("Synthetica"); return t;
}
records::TrailerConfigured synthetic_trailer() {
  records::TrailerConfigured t; t.index = 0; t.id.assign("trailer.synthetic_box"); t.body_type.assign("dryvan"); t.chain_type.assign("single");
  t.cargo_accessory_id.assign(""); t.license_plate.assign("SYN 0002"); t.plate_country_id.assign("synthetica"); t.plate_country.assign("Synthetica"); return t;
}
records::Transfer transfer(const char* source_id, const char* source_name, const char* target_id, const char* target_name) {
  records::Transfer t; t.amount = available_field<std::int64_t>(-450); t.source_id.assign(source_id); t.source_name.assign(source_name);
  t.target_id.assign(target_id); t.target_name.assign(target_name); return t;
}
std::string content(const Json& event) { const auto& d = field(event, "data"); return canonical(field(d, "occurred")) + canonical(field(d, "record")); }

// Union of eventSeq ranges, kept merged so that very long gap ranges cost nothing.
class Ranges {
 public:
  void add(std::uint64_t first, std::uint64_t last) {
    auto it = ranges_.upper_bound(first);
    if (it != ranges_.begin() && std::prev(it)->second + 1 >= first) { --it; first = it->first; last = std::max(last, it->second); it = ranges_.erase(it); }
    while (it != ranges_.end() && it->first <= last + 1) { last = std::max(last, it->second); it = ranges_.erase(it); }
    ranges_.emplace(first, last);
  }
  bool contains(std::uint64_t seq) const { auto it = ranges_.upper_bound(seq); return it != ranges_.begin() && std::prev(it)->second >= seq; }
  std::uint64_t size() const { std::uint64_t n = 0; for (const auto& r : ranges_) n += r.second - r.first + 1; return n; }
 private:
  std::map<std::uint64_t, std::uint64_t> ranges_;
};

// Structural invariants I1-I3 and I7 of docs/native-transport-v1.md, checked through the public view.
struct Monotone { std::uint64_t acked = 0, next = 1; LossCounts loss; };
void check_store(const EventStore& store, Monotone* previous = nullptr) {
  const auto s = store.status(); std::uint64_t expected = s.acked_through_event_seq + 1, bytes = 0, events = 0; bool previous_gap = false;
  check(s.acked_through_event_seq < s.next_event_seq && s.retained_entries == store.entries(), "I1 cursor");
  for (std::size_t i = 0; i < store.entries(); ++i) {
    const auto e = store.entry(i);
    check(e.first_event_seq == expected && e.last_event_seq >= e.first_event_seq, "I1 contiguous coverage");
    if (e.gap) {
      const auto& c = e.causes; const auto sum = c.offline + c.no_durable_consumer + c.queue_count + c.queue_bytes + c.retention_expired + c.encoding_failed;
      check(e.bytes == gap_record_bytes && sum == e.last_event_seq - e.first_event_seq + 1 && !previous_gap, "I3 one gap record per lost run");
    } else { check(e.first_event_seq == e.last_event_seq && e.bytes >= 1 && e.bytes <= limits.event_bytes, "event entry"); ++events; }
    previous_gap = e.gap; bytes += e.bytes; expected = e.last_event_seq + 1;
  }
  check(expected == s.next_event_seq && bytes == s.retained_bytes, "I1 coverage ends at N");
  check(store.entries() <= limits.retained_entries && bytes <= limits.retained_bytes && events < limits.retained_entries, "I2 bounds");
  check(store.entries() < limits.retained_entries || bytes >= gap_record_bytes, "I2 a full store holds a gap record");
  check(s.oldest_retained_ns.has_value() == (store.entries() > 0), "oldest retained exactly when entries are retained");
  if (previous) {
    const auto& p = previous->loss; const auto& n = s.event_loss;
    check(s.acked_through_event_seq >= previous->acked && s.next_event_seq >= previous->next && n.offline >= p.offline && n.no_durable_consumer >= p.no_durable_consumer &&
      n.queue_count >= p.queue_count && n.queue_bytes >= p.queue_bytes && n.retention_expired >= p.retention_expired && n.encoding_failed >= p.encoding_failed, "I7 monotone status");
    *previous = {s.acked_through_event_seq, s.next_event_seq, s.event_loss};
  }
}

// One plugin session driven through the store and encoder, observed by the contract oracle. `committed` is the storage
// stand-in: the content committed per eventSeq, which redelivery must never contradict.
struct Harness {
  struct Link { bool durable; Consumer consumer; AckValidator validator; std::vector<std::pair<std::uint64_t, std::uint64_t>> pending; std::vector<Message> messages; };
  Encoder encoder; EventStore store; std::optional<DurableAckCursor> cursor; std::optional<Link> link; std::string session;
  std::uint64_t seq = 0, now = 1'000'400'000'000ULL, boundary = 100, written = 0, written_before = 0, connections = 0, redelivered_items = 0;
  std::map<std::uint64_t, std::string> admitted, committed; Ranges gaps_received, gaps_committed; Monotone monotone;
  explicit Harness(const std::string& session_id = SESSION, Currency currency = {}) : encoder(identity(session_id, std::move(currency))), session(session_id) {}
  std::uint64_t tick(std::uint64_t ns = 1'000'000) { now += ns; return now; }
  Message send(Json wire, Applied* applied = nullptr) {
    const auto m = decode(encode(std::move(wire))); const auto a = link->consumer.accept(m); link->messages.push_back(m);
    if (applied) *applied = a; return m;
  }
  StoreStatus open(bool durable) {
    check(!link, "one connection at a time");
    if (durable) { store.connect(); written_before = written; ++connections; }
    link.emplace(Link{durable, Consumer(durable), AckValidator(session, durable), {}, {}});
    WelcomeInfo w; w.durable_events = durable; w.gameplay_events_registered = true; w.telemetry_api = {1, 1}; w.game_telemetry = {1, 19}; w.game_mode = single_player_weak();
    send(encoder.welcome(++seq, tick(), w));
    const auto status = store.status();
    Applied applied; send(encoder.checkpoint(++seq, tick(), minimal_state(), StatusInfo{single_player_weak(), durable, status, {}}), &applied);
    check(applied.hydration && !applied.coverage, "checkpoint hydrates only");
    link->validator.checkpoint(status.acked_through_event_seq);
    if (durable) { if (!cursor) cursor.emplace(session); cursor->begin_connection(status.acked_through_event_seq); }
    return status;
  }
  // Writes up to `limit` outbound items and checks identity, order and the redelivered rule against the model.
  std::size_t pump(std::size_t limit = std::numeric_limits<std::size_t>::max()) {
    std::size_t n = 0;
    while (n < limit) {
      const auto o = store.next_outbound(); if (!o) break;
      const auto first = o->first_event_seq(), last = o->last_event_seq();
      check(o->redelivered == (first <= written_before), "redelivered exactly when written to an earlier connection"); if (o->redelivered) ++redelivered_items;
      Applied applied; const auto m = send(encoder.outbound(++seq, tick(), *o), &applied);
      check(applied.coverage && applied.coverage->first_event_seq == first && applied.coverage->last_event_seq == last, "coverage of the written item");
      if (!o->gap) check(admitted.count(first) && admitted.at(first) == content(m.wire), "event identity preserved");
      else gaps_received.add(first, last);
      written = std::max(written, last); link->validator.sent(last); cursor->received(first, last); link->pending.emplace_back(first, last); ++n;
    }
    check_store(store, &monotone); return n;
  }
  // Commits the oldest `limit` received items, as a storage transaction would.
  void commit(std::size_t limit = std::numeric_limits<std::size_t>::max()) {
    auto& pending = link->pending; const auto n = std::min(limit, pending.size());
    for (std::size_t i = 0; i < n; ++i) {
      const auto [first, last] = pending[i]; const auto& m = *std::find_if(link->messages.rbegin(), link->messages.rend(), [&](const Message& x) {
        return (x.event && x.event->event_seq == first) || (x.gap && x.gap->first_event_seq == first); });
      if (m.event) {
        check(!gaps_committed.contains(first), "a committed gap never becomes an event");
        const auto c = content(m.wire); const auto it = committed.find(first); check(it == committed.end() || it->second == c, "redelivered duplicate is identical");
        committed[first] = c;
      } else gaps_committed.add(first, last);
      cursor->commit(first, last);
    }
    pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(n));
  }
  // Sends the cursor's ACK through the producer-side validator and releases the store. Returns the accepted ACK.
  std::optional<std::uint64_t> ack() {
    const auto a = cursor->ack(); if (!a) return std::nullopt;
    const auto through = link->validator.accept(*a); if (!through) return std::nullopt;
    const auto released = store.release(*through); check(released && *released <= *through, "release accepted ACK");
    check_store(store, &monotone); return through;
  }
  Message snapshot() { return send(encoder.snapshot(++seq, tick(), minimal_state(), StatusInfo{single_player_weak(), link->durable, store.status(), {}})); }
  Message end(EndReason reason) { return send(encoder.end(++seq, tick(), reason, store.end_cursor())); }
  void close() { if (link && link->durable) store.disconnect(now); link.reset(); }
  EventRecord next_event(RecordBody body = records::SimulationPaused{}) { tick(); return make_event(store.next_event_seq(), body, now, ++boundary); }
  Ingest ingest(const EventRecord& e) {
    const auto result = ingest_event(store, encoder, e, now);
    if (result == Ingest::retained) admitted[e.event_seq] = content(encoder.event(1, u64_max, e, false));
    check_store(store, &monotone); return result;
  }
  EventStore::Admission admit_sized(const EventRecord& e, std::size_t bytes) {
    const auto result = store.admit(e, bytes, now);
    if (result == EventStore::Admission::retained) admitted[e.event_seq] = content(encoder.event(1, u64_max, e, false));
    check_store(store, &monotone); return result;
  }
  void lose(std::uint64_t count, LossCause cause) {
    const auto first = store.next_event_seq(); check(store.lose(first, first + count - 1, cause, now, now, now), "loss recorded"); check_store(store, &monotone);
  }
};
LossCounts counts(std::uint64_t offline, std::uint64_t no_durable, std::uint64_t queue_count, std::uint64_t queue_bytes, std::uint64_t expired, std::uint64_t encoding) {
  return {offline, no_durable, queue_count, queue_bytes, expired, encoding};
}
bool same(const LossCounts& a, const LossCounts& b) {
  return a.offline == b.offline && a.no_durable_consumer == b.no_durable_consumer && a.queue_count == b.queue_count && a.queue_bytes == b.queue_bytes &&
    a.retention_expired == b.retention_expired && a.encoding_failed == b.encoding_failed;
}
const Message& last_message(const Harness& h) { return h.link->messages.back(); }

void store_case() {
  check(limits.retained_entries == 256 && limits.retained_bytes == 1048576 && gap_record_bytes == 1024 && limits.disconnect_retention_ms == 300000 && limits.event_bytes == 16384, "approved bounds");
  EventStore fresh; const auto empty = fresh.status();
  check(empty.acked_through_event_seq == 0 && empty.next_event_seq == 1 && empty.retained_entries == 0 && empty.retained_bytes == 0 && !empty.oldest_retained_ns &&
    same(empty.event_loss, {}) && !fresh.exhausted() && !fresh.connected(), "fresh store");
  // Before any durable connection events arrive only as offline or noDurableConsumer runs (OD-4): admission is misuse.
  const Encoder fresh_encoder(identity());
  check(fresh.admit(make_event(1, records::JobCleared{}, 5), 100, 6) == EventStore::Admission::rejected && !fresh.ever_connected(), "no admission before a durable connection");
  check(ingest_event(fresh, fresh_encoder, make_event(1, records::JobCleared{}, 5), 6) == Ingest::rejected &&
    ingest_event(fresh, fresh_encoder, make_event(1, records::TrailerCleared{10}, 5), 6) == Ingest::rejected, "no ingestion before a durable connection");
  check(fresh.entries() == 0 && fresh.next_event_seq() == 1 && same(fresh.status().event_loss, {}), "rejection has no effect");
  check(fresh.lose(1, 2, LossCause::offline, 5, 6, 7) && fresh.entries() == 1 && fresh.status().event_loss.offline == 2, "offline run before the first connection");
  check_store(fresh);

  EventStore store; store.connect(); Monotone m;
  for (std::uint64_t seq = 1; seq <= 3; ++seq) check(store.admit(make_event(seq, records::SimulationPaused{}, seq * 10), seq * 100, seq * 10 + 1) == EventStore::Admission::retained, "retained");
  auto s = store.status(); check_store(store, &m);
  check(s.next_event_seq == 4 && s.retained_entries == 3 && s.retained_bytes == 600 && s.oldest_retained_ns == 11u && s.acked_through_event_seq == 0, "three events");
  // Misuse never changes the store.
  check(store.admit(make_event(5, records::SimulationPaused{}, 40), 100, 41) == EventStore::Admission::rejected, "eventSeq other than N");
  check(store.admit(make_event(4, records::SimulationPaused{}, 40), 0, 41) == EventStore::Admission::rejected, "zero bytes");
  check(store.admit(make_event(4, records::SimulationPaused{}, 40), 16385, 41) == EventStore::Admission::rejected, "over the event bound");
  check(!store.lose(5, 5, LossCause::offline, 1, 1, 41) && !store.lose(4, 3, LossCause::offline, 1, 1, 41), "loss not at N");
  check(!store.lose(4, 4, LossCause::offline, 1, std::nullopt, 41) && !store.lose(4, 4, LossCause::offline, 2, 1, 41), "lost times both present and ordered");
  check(store.status().next_event_seq == 4 && store.entries() == 3, "misuse has no effect");
  check(store.lose(4, 6, LossCause::offline, 40, 60, 61), "offline run");
  check(store.lose(7, 7, LossCause::no_durable_consumer, 70, 70, 71), "extension");
  check(store.entries() == 4 && store.status().retained_bytes == 1624, "extension keeps one entry and 1,024 bytes");
  const auto gap = store.entry(3);
  check(gap.gap && gap.first_event_seq == 4 && gap.last_event_seq == 7 && same(gap.causes, counts(3, 1, 0, 0, 0, 0)) && gap.retained_since_ns == 61, "gap record");
  check(store.admit(make_event(8, records::SimulationPaused{}, 80), 50, 81) == EventStore::Admission::retained && store.entries() == 5, "event after gap");
  check(store.lose(9, 9, LossCause::queue_count, std::nullopt, std::nullopt, 90) && store.entries() == 6, "a lost run without observation times");
  check_store(store, &m);
  // The worker reads a coherent status for every snapshot; the contract accepts it.
  Encoder encoder(identity());
  const auto snap = decode(encode(encoder.snapshot(1, 100, minimal_state(), StatusInfo{{}, true, store.status(), {}})));
  check(snap.state->status.delivery.next_event_seq == 10 && snap.state->status.delivery.retained_events == 6 && snap.state->status.event_loss.offline == 3 &&
    snap.state->status.event_loss.no_durable_consumer == 1 && snap.state->status.event_loss.queue_count == 1, "status on the wire");
  // I8: the last assignable eventSeq ends the sequence.
  check(store.lose(10, max_event_seq, LossCause::offline, 100, 100, 100) && store.exhausted() && store.next_event_seq() == u64_max, "sequence exhausted");
  check(store.admit(make_event(u64_max, records::SimulationPaused{}, 1), 10, 101) == EventStore::Admission::rejected && !store.lose(u64_max, u64_max, LossCause::offline, 1, 1, 101), "nothing after exhaustion");
  const auto end = store.end_cursor(); check(end.next_event_seq == u64_max && end.acked_through_event_seq == 0 && end.retained_unacked == 4, "end cursor counts retained events");
  check_store(store, &m);
  const auto ended = decode(encode(encoder.end(2, 200, EndReason::sequence_exhausted, end)));
  check(ended.end->reason == "sequence-exhausted" && ended.end->next_event_seq == u64_max && ended.end->retained_unacked == 4, "sequence-exhausted end");
}

void release_case() {
  // ack-inside-gap-record: event 1, queueCount [2, 3], then encodingFailed 4 extends the written record; an ACK of 3 is accepted but releases nothing past 1.
  Harness h; h.open(true);
  check(h.ingest(h.next_event(records::JobCleared{})) == Ingest::retained, "event 1");
  h.tick(); h.store.lose(2, 3, LossCause::queue_count, 1000330000000ULL, 1000340000000ULL, h.now);
  check(h.pump() == 2, "event and gap written");
  const auto& first_gap = *last_message(h).gap;
  check(first_gap.first_event_seq == 2 && first_gap.last_event_seq == 3 && first_gap.causes.queue_count == 2 && first_gap.first_lost_monotonic_ns.value == 1000330000000ULL &&
    first_gap.last_lost_monotonic_ns.value == 1000340000000ULL && !first_gap.redelivered, "gap [2, 3]");
  auto bad = h.next_event(records::TrailerCleared{10});
  check(h.ingest(bad) == Ingest::lost_encoding_failed && h.store.entries() == 2 && h.store.entry(1).last_event_seq == 4, "encodingFailed extends the trailing record");
  check(h.pump() == 1, "delta gap written");
  const auto& delta = *last_message(h).gap;
  check(delta.first_event_seq == 4 && delta.last_event_seq == 4 && same(delta.causes, counts(0, 0, 0, 0, 0, 1)) && delta.first_lost_monotonic_ns.value == bad.occurred.monotonic_ns.value &&
    delta.last_lost_monotonic_ns.value == bad.occurred.monotonic_ns.value && !delta.redelivered, "delta gap for the extension only");
  h.commit(); check(h.ack() == 4u && h.store.entries() == 0 && h.store.release_point() == 4, "commit through 4 releases everything");

  // The same stream with the consumer's ACK of 3 inside the record [2, 4].
  Harness g; g.open(true); g.ingest(g.next_event(records::JobCleared{}));
  g.tick(); g.store.lose(2, 3, LossCause::queue_count, 1000330000000ULL, 1000340000000ULL, g.now); const auto record_since = g.now;
  g.pump(); const auto g_bad = g.next_event(records::TrailerCleared{10}); g.ingest(g_bad); g.pump(1);
  g.commit(2); // event 1 and gap [2, 3] committed; the delta [4] is not yet committed
  check(g.ack() == 3u, "ACK 3 accepted by the producer rule");
  auto s = g.store.status();
  check(s.acked_through_event_seq == 1 && s.next_event_seq == 5 && s.retained_entries == 1 && s.retained_bytes == 1024 && s.oldest_retained_ns == record_since, "release point is first - 1");
  const auto whole = g.store.entry(0);
  check(whole.gap && whole.first_event_seq == 2 && whole.last_event_seq == 4 && same(whole.causes, counts(0, 0, 2, 0, 0, 1)) && whole.bytes == 1024, "the record stays whole");
  const auto status_message = g.snapshot(); check(status_message.state->status.delivery.acked_through_event_seq == 1, "status reports the release point");
  g.close();
  // Reconnection: the checkpoint carries A = 1 and the record is redelivered whole.
  const auto again = g.open(true);
  check(again.acked_through_event_seq == 1 && again.next_event_seq == 5 && again.retained_entries == 1 && again.retained_bytes == 1024, "checkpoint-ack-inside-gap");
  check(!g.cursor->ack(), "no ACK before redelivery");
  check(g.pump() == 1, "one redelivered item");
  const auto& merged = *last_message(g).gap;
  check(merged.first_event_seq == 2 && merged.last_event_seq == 4 && same(merged.causes, counts(0, 0, 2, 0, 0, 1)) && merged.first_lost_monotonic_ns.value == 1000330000000ULL &&
    merged.last_lost_monotonic_ns.value == g_bad.occurred.monotonic_ns.value && merged.redelivered, "gap-merged-redelivered");
  g.commit(); check(g.cursor->through_event_seq() == 4 && g.ack() == 4u && g.store.entries() == 0 && g.store.release_point() == 4, "cursor 4; record released");

  // An ACK at a record's last eventSeq releases it; ACKs inside it never trim it.
  Harness r; r.open(true); r.lose(5, LossCause::queue_count); r.ingest(r.next_event()); r.pump(); r.commit();
  check(r.store.release(2) == 0u && r.store.entry(0).last_event_seq == 5 && r.store.entry(0).bytes == 1024, "inside: release point 0");
  check(r.store.release(4) == 0u && same(r.store.entry(0).causes, counts(0, 0, 5, 0, 0, 0)), "still inside");
  check(r.store.release(5) == 5u && r.store.entries() == 1 && !r.store.entry(0).gap, "last eventSeq releases the record");
  check(r.store.release(3) == 5u, "a lower ACK never lowers the release point");
  check(!r.store.release(7), "beyond the written coverage is misuse");
  check(r.store.release(6) == 6u && r.store.entries() == 0, "event released");
  r.close(); check(!r.store.release(6), "release requires a connection");
  check_store(r.store);
}

void retention_case() {
  // Reconnection inside the window redelivers retained events with redelivered = true.
  Harness h; h.open(true);
  h.ingest(h.next_event(synthetic_truck())); h.ingest(h.next_event(records::JobCleared{})); h.pump(); h.commit(1);
  check(h.ack() == 1u, "first event acknowledged");
  h.close(); const auto disconnected = h.now;
  check(h.store.retention_deadline_ns() == disconnected + retention_ns, "300,000 ms window");
  // Events copied while durable and drained after the disconnect are retained (S4).
  check(h.ingest(h.next_event()) == Ingest::retained, "drained after disconnect");
  h.store.expire(disconnected + retention_ns - 1); check(h.store.entries() == 2 && h.store.status().event_loss.retention_expired == 0, "inside the window");
  const auto reconnect = h.open(true);
  check(reconnect.acked_through_event_seq == 1 && reconnect.next_event_seq == 4 && !h.store.retention_deadline_ns(), "reconnection cancels the window");
  check(h.pump() == 2 && last_message(h).event->event_seq == 3 && !last_message(h).event->redelivered, "live event not redelivered");
  check(h.link->messages[h.link->messages.size() - 2].event->redelivered, "written event redelivered");
  h.commit(); check(h.ack() == 3u, "redelivered duplicates and new event acknowledged");

  // Expiry: every retained event becomes retentionExpired coverage in one gap record with the expiry time (S2).
  Harness e; e.open(true);
  const auto first = e.next_event(); e.ingest(first); const auto second = e.next_event(records::JobCleared{}); e.ingest(second); e.pump();
  e.close(); e.tick(retention_ns); const auto deadline = e.now;
  e.store.expire(deadline);
  auto s = e.store.status();
  check(e.store.entries() == 1 && s.retained_bytes == 1024 && s.oldest_retained_ns == deadline && s.event_loss.retention_expired == 2 && !e.store.retention_deadline_ns(), "expired at the deadline");
  const auto expired = e.store.entry(0); check(expired.first_event_seq == 1 && expired.last_event_seq == 2 && same(expired.causes, counts(0, 0, 0, 0, 2, 0)), "one expiry record");
  // With the window closed an event drained later is not retained either.
  const auto third = e.next_event();
  check(e.ingest(third) == Ingest::lost_retention_expired && e.store.entries() == 1 && e.store.entry(0).last_event_seq == 3, "closed window extends the record");
  const auto cp = e.open(true); check(cp.acked_through_event_seq == 0 && cp.next_event_seq == 4 && cp.retained_entries == 1 && cp.retained_bytes == 1024, "checkpoint-expired");
  e.pump(); const auto& gap = *last_message(e).gap;
  check(gap.first_event_seq == 1 && gap.last_event_seq == 3 && gap.causes.retention_expired == 3 && gap.redelivered && gap.first_lost_monotonic_ns.value == first.occurred.monotonic_ns.value &&
    gap.last_lost_monotonic_ns.value == third.occurred.monotonic_ns.value, "gap-expired redelivered");
  check(*gap.first_lost_monotonic_ns.value <= *gap.last_lost_monotonic_ns.value, "lost times ordered");
  e.commit(); check(e.ack() == 3u && e.cursor->through_event_seq() == 3, "retention-expired-ack");

  // Expiry merges mixed coverage and never adds entries, even from a full store.
  Harness f; f.open(true);
  for (unsigned i = 0; i < 255; ++i) check(f.admit_sized(f.next_event(), 100) == EventStore::Admission::retained, "fill");
  check(f.admit_sized(f.next_event(), 100) == EventStore::Admission::lost_queue_count && f.store.entries() == 256, "full");
  f.close(); f.store.expire(f.now + retention_ns);
  check(f.store.entries() == 1 && same(f.store.entry(0).causes, counts(0, 0, 1, 0, 255, 0)) && f.store.status().retained_bytes == 1024, "full store expires into one record");
  Harness mixed; mixed.store.lose(1, 1, LossCause::offline, 5, 5, 5); mixed.open(true);
  mixed.ingest(mixed.next_event()); mixed.ingest(mixed.next_event()); mixed.lose(2, LossCause::queue_count); mixed.ingest(mixed.next_event());
  check(mixed.store.entries() == 5, "gap, two events, gap, event");
  mixed.close(); mixed.store.expire(mixed.now + retention_ns);
  check(mixed.store.entries() == 1 && same(mixed.store.entry(0).causes, counts(1, 0, 2, 0, 3, 0)) && mixed.store.entry(0).first_event_seq == 1 && mixed.store.entry(0).last_event_seq == 6, "mixed coverage merged");
  // Gap records are never aged.
  EventStore gaps; gaps.lose(1, 4, LossCause::offline, 10, 20, 30); gaps.connect(); gaps.disconnect(40); gaps.expire(40 + 10 * retention_ns);
  check(gaps.entries() == 1 && gaps.entry(0).retained_since_ns == 30 && gaps.status().event_loss.retention_expired == 0 && !gaps.retention_deadline_ns(), "gap records never expire");
  // Expiry does nothing while connected or before the deadline, and the deadline saturates.
  EventStore late; late.connect(); late.admit(make_event(1, records::JobCleared{}, 1), 10, 2); late.expire(u64_max); check(late.entries() == 1 && !late.entry(0).gap, "connected store never expires");
  late.disconnect(u64_max - 5); check(late.retention_deadline_ns() == u64_max, "deadline saturates");
  late.expire(u64_max - 1); check(!late.entry(0).gap, "before the saturated deadline");
  late.expire(u64_max); check(late.entry(0).gap && late.entry(0).retained_since_ns == u64_max, "at the saturated deadline");
}

void overflow_case() {
  // Entry bound: 255 events, then the reserved entry holds the trailing gap record (queueCount).
  Harness h; h.open(true);
  for (unsigned i = 0; i < 255; ++i) check(h.admit_sized(h.next_event(), 100) == EventStore::Admission::retained, "event fits");
  check(h.store.entries() == 255 && h.store.status().retained_bytes == 25500, "255 events");
  check(h.admit_sized(h.next_event(), 100) == EventStore::Admission::lost_queue_count, "256th event lost");
  check(h.store.entries() == 256 && h.store.entry(255).gap && h.store.status().retained_bytes == 25500 + 1024, "reserved entry holds the gap record");
  for (unsigned i = 0; i < 4; ++i) check(h.admit_sized(h.next_event(), 100) == EventStore::Admission::lost_queue_count, "newest-drop");
  h.lose(2, LossCause::offline);
  auto s = h.store.status();
  check(h.store.entries() == 256 && s.retained_bytes == 26524 && s.event_loss.queue_count == 5 && s.event_loss.offline == 2 && s.next_event_seq == 263, "extended in place with mixed causes");
  check(same(h.store.entry(255).causes, counts(2, 0, 5, 0, 0, 0)) && h.store.entry(255).first_event_seq == 256 && h.store.entry(255).last_event_seq == 262, "trailing record");
  // A full store is a valid status: 256 entries with at least 1,024 bytes.
  const auto full = h.snapshot(); check(full.state->status.delivery.retained_events == 256 && full.state->status.delivery.retained_bytes == 26524, "full status accepted");
  check(h.pump() == 256, "255 events and one gap written");
  const auto& gap = *last_message(h).gap; check(gap.first_event_seq == 256 && gap.last_event_seq == 262 && gap.causes.queue_count == 5 && gap.causes.offline == 2, "overflow is observable");
  h.commit(10); check(h.ack() == 10u && h.store.entries() == 246, "release frees entries");
  check(h.admit_sized(h.next_event(), 100) == EventStore::Admission::retained && h.store.entries() == 247, "admission resumes after the trailing gap");
  h.pump(); h.commit(); check(h.ack() == 263u && h.store.entries() == 0, "everything acknowledged");

  // Byte bound: events of 16,384 bytes until the reserved 1,024 bytes would be needed.
  Harness b; b.open(true); unsigned fitted = 0;
  while (b.admit_sized(b.next_event(), 16384) == EventStore::Admission::retained) ++fitted;
  check(fitted == 63 && b.store.status().retained_bytes == 63 * 16384 + 1024 && b.store.status().event_loss.queue_bytes == 1, "63 large events, then queueBytes");
  check(b.admit_sized(b.next_event(), 100) == EventStore::Admission::retained, "a small event still fits");
  check(b.store.status().retained_bytes == 63 * 16384 + 1024 + 100, "byte accounting");
  // 1,048,576 - 1,033,316 - 1,024 leaves room for exactly 14,236 bytes.
  check(b.admit_sized(b.next_event(), 14237) == EventStore::Admission::lost_queue_bytes && b.store.entries() == 66, "one byte too many: new gap record");
  check(b.admit_sized(b.next_event(), 14236) == EventStore::Admission::lost_queue_bytes && b.store.entries() == 66, "the new gap record took its reserved 1,024 bytes");
  check(b.admit_sized(b.next_event(), 13212) == EventStore::Admission::retained && b.store.status().retained_bytes == limits.retained_bytes - gap_record_bytes, "exact fit keeps the reservation");
  b.pump(); b.commit(); check(b.ack() == b.store.next_event_seq() - 1 && b.store.entries() == 0, "byte overflow delivered and acknowledged");

  // Both bounds exceeded: queueCount is counted.
  Harness both; both.open(true);
  for (unsigned i = 0; i < 255; ++i) check(both.admit_sized(both.next_event(), 4100) == EventStore::Admission::retained, "fill both");
  check(both.admit_sized(both.next_event(), 4100) == EventStore::Admission::lost_queue_count, "queueCount wins");
  check(both.store.status().event_loss.queue_count == 1 && both.store.status().event_loss.queue_bytes == 0, "only queueCount counted");
  check_store(both.store);
}

void encoding_case() {
  Encoder encoder(identity());
  // measure_event bounds every later encoding of the record.
  const auto job = make_event(7, synthetic_job(), 1000149000000ULL); const auto measured = encoder.measure_event(job);
  check(measured.has_value(), "job measured");
  for (const auto redelivered : {false, true})
    for (const auto seq : {std::uint64_t{1}, u64_max})
      for (const auto capture : {std::uint64_t{1000149000000ULL}, u64_max}) {
        const auto frame = encode(encoder.event(seq, capture, job, redelivered)); check(frame.size() - 4 <= *measured, "measured size bounds the encoding");
      }
  check(encode(encoder.event(u64_max, u64_max, job, false)).size() - 4 == *measured, "measurement is the worst-case envelope");
  check(encode(encoder.event(u64_max, u64_max, job, true)).size() - 4 == *measured - 1, "true is one byte shorter");

  // Text (D12): never truncated; invalid values become `invalid`, a provided empty string stays available.
  const auto record_field = [&](const records::TruckConfigured& t, const char* key) {
    const auto m = decode(encode(encoder.event(1, 2000000000000ULL, make_event(1, t, 1000149000000ULL), false)));
    return field(field(m.wire, "data"), "record").at(key);
  };
  auto truck = synthetic_truck();
  truck.id.assign(std::string(128, 'x').c_str()); check(read_text(record_field(truck, "id"), TextKind::id).value == std::string(128, 'x'), "id at 128 bytes");
  truck.id.assign(std::string(129, 'x').c_str()); check(truck.id.state == FieldState::invalid && read_text(record_field(truck, "id"), TextKind::id).reason == Reason::invalid, "id over 128 bytes");
  truck.id.assign(""); check(read_text(record_field(truck, "id"), TextKind::id).value == std::string(), "provided empty");
  truck.id.assign(static_cast<const char*>(nullptr)); check(read_text(record_field(truck, "id"), TextKind::id).reason == Reason::not_observed, "not sent");
  truck.id.assign("bad\xc3\x28utf8"); check(read_text(record_field(truck, "id"), TextKind::id).reason == Reason::invalid, "invalid UTF-8");
  truck.id.assign("tab\there"); check(read_text(record_field(truck, "id"), TextKind::id).reason == Reason::invalid, "C0 control");
  truck.id.assign("del\x7f"); check(read_text(record_field(truck, "id"), TextKind::id).reason == Reason::invalid, "DEL");
  std::string accented; for (unsigned i = 0; i < 128; ++i) accented += "\xc3\xa9";
  truck.name.assign(accented.c_str()); check(read_text(record_field(truck, "name"), TextKind::name).value == accented, "name at 256 bytes");
  truck.name.assign((accented + "x").c_str()); check(read_text(record_field(truck, "name"), TextKind::name).reason == Reason::invalid, "name over 256 bytes");
  // A borrowed string without a terminator in its first N + 1 bytes is read no further (ASan checks the bound).
  std::vector<char> unterminated(id_bytes + 1, 'y'); IdText bounded; bounded.assign(unterminated.data()); check(bounded.state == FieldState::invalid && bounded.length == 0, "bounded scan");
  truck.fuel_capacity_l = available_field(std::numeric_limits<double>::quiet_NaN()); check(read_measure(record_field(truck, "fuelCapacity"), "L").reading.reason == Reason::invalid, "NaN invalid");
  truck.fuel_capacity_l = available_field(1e6 + 1); check(read_measure(record_field(truck, "fuelCapacity"), "L").reading.reason == Reason::invalid, "out of range invalid");
  truck.fuel_capacity_l = available_field(0.0); check(read_measure(record_field(truck, "fuelCapacity"), "L").reading.value == 0.0, "zero stays available");
  truck.fuel_capacity_l.state = FieldState::not_supported; check(read_measure(record_field(truck, "fuelCapacity"), "L").reading.reason == Reason::not_supported, "unsupported stays");

  // Exact money, kilometre and duration mappings (§6).
  records::JobDelivered delivered; delivered.revenue = available_field(std::numeric_limits<std::int64_t>::min()); delivered.earned_xp = available_field(std::numeric_limits<std::int32_t>::min());
  delivered.cargo_damage = available_field(0.0125); delivered.distance_km = available_field(151.25f); delivered.delivery_duration_min = available_field(std::numeric_limits<std::uint32_t>::max());
  delivered.auto_park_used = available_field(false);
  const auto dm = decode(encode(encoder.event(1, 2000000000000ULL, make_event(1, delivered, 1000149000000ULL), false))); const auto& dr = field(field(dm.wire, "data"), "record");
  const auto revenue = read_money(dr.at("revenue"), SdkType::s64);
  check(revenue.value && revenue.value->raw == "-9223372036854775808" && revenue.value->currency.status == Currency::Status::unknown, "INT64_MIN revenue");
  check(field(dr, "earnedXp").at("value").number() == -2147483648.0 && read_measure(dr.at("distance"), "m").reading.value == 151250.0, "xp and distance");
  check(field(dr, "deliveryDuration").at("value").string() == "4294967295" && field(dr, "deliveryDuration").at("unit").string() == "min", "duration minutes");
  check(read_measure(dr.at("cargoDamage"), "fraction").reading.value == 0.0125 && !field(dr, "autoLoadUsed").at("available").boolean(), "fraction and unobserved flag");
  auto planned = synthetic_job(); planned.planned_distance_km = available_field(std::numeric_limits<std::uint32_t>::max()); planned.expected_income = available_field(u64_max);
  const auto pm = decode(encode(Encoder(identity(SESSION, eur())).event(1, 2000000000000ULL, make_event(1, planned, 1000149000000ULL), false)));
  const auto& pr = field(field(pm.wire, "data"), "record");
  check(read_measure(pr.at("plannedDistance"), "m").reading.value == 4294967295000.0, "u32 km exact");
  const auto income = read_money(pr.at("expectedIncome"), SdkType::u64);
  check(income.value && income.value->raw == "18446744073709551615" && income.value->currency.code == "EUR" && income.value->currency.source == EUR_SOURCE, "u64 income with documented currency");
  const auto broken = decode(encode(Encoder(identity(SESSION, Currency{Currency::Status::sdk_documented, "eur", "x"})).event(1, 2000000000000ULL, make_event(1, planned, 1000149000000ULL), false)));
  check(read_money(field(field(broken.wire, "data"), "record").at("expectedIncome"), SdkType::u64).reason == Reason::invalid, "an invalid currency makes money invalid");

  // Records the contract rejects cannot be sent: measure_event fails and ingestion records encodingFailed.
  const auto unsendable = [&](RecordBody body, const std::function<void(EventRecord&)>& change, const std::string& name) {
    auto e = make_event(1, body, 1000149000000ULL); change(e); check(!encoder.measure_event(e), name);
  };
  records::GameTimeRegression regression; regression.from = {available_field<std::uint32_t>(12345), make_uuid(GAME_CLOCK)}; regression.to = {available_field<std::uint32_t>(11000), make_uuid(GAME_CLOCK_2)};
  auto good_regression = make_event(1, regression, 1000149000000ULL); good_regression.occurred.game_time = regression.to; check(encoder.measure_event(good_regression).has_value(), "valid regression");
  unsendable(regression, [](EventRecord&) {}, "regression without occurred = to");
  unsendable(regression, [&](EventRecord& e) { std::get<records::GameTimeRegression>(e.record).to.clock_id = make_uuid(GAME_CLOCK); e.occurred.game_time = std::get<records::GameTimeRegression>(e.record).to; }, "regression on the same clock");
  unsendable(records::TrailerCleared{10}, [](EventRecord&) {}, "trailer index 10");
  unsendable(records::JobCleared{}, [](EventRecord& e) { e.occurred.game_time.clock_id = make_uuid("40000000-0000-4000-8000-00000000000A"); }, "uppercase game clock");
  unsendable(records::JobCleared{}, [](EventRecord& e) { e.occurred.game_time.clock_id = Uuid{}; }, "empty game clock");
  unsendable(records::JobCleared{}, [](EventRecord& e) { e.event_seq = 0; }, "eventSeq 0");
  unsendable(records::JobCleared{}, [](EventRecord& e) { e.event_seq = u64_max; }, "eventSeq beyond the last assignable value");
  records::SourceGameMode mode; mode.mode.mode = GameModeKind::truckersmp; mode.mode.method = DetectionMethod::module_scan; mode.mode.confidence = Confidence::strong;
  unsendable(mode, [](EventRecord&) {}, "truckersmp module scan without a module");
  mode.mode.module.assign("synthetic-multiplayer-module.dll"); check(encoder.measure_event(make_event(1, mode, 1)).has_value(), "detected module");
  EventStore store; store.connect();
  check(ingest_event(store, encoder, make_event(1, records::TrailerCleared{10}, 1000149000000ULL), 1000150000000ULL) == Ingest::lost_encoding_failed, "encodingFailed");
  check(store.status().event_loss.encoding_failed == 1 && store.entry(0).gap, "encodingFailed coverage");
  check(ingest_event(store, encoder, make_event(5, records::JobCleared{}, 1), 2) == Ingest::rejected && store.next_event_seq() == 2, "ingestion keeps eventSeq order");
  check(ingest_event(store, encoder, make_event(2, records::JobCleared{}, 1000149000000ULL), 1000150000000ULL) == Ingest::retained && store.entry(1).bytes == *encoder.measure_event(make_event(2, records::JobCleared{}, 1000149000000ULL)), "admitted with its measured size");
  // A message whose capture precedes a time it carries is rejected, never silently clamped.
  rejects([&] { encode(encoder.event(1, 1000148999999ULL, job, false)); }, "capture before occurred");
  rejects([&] { encode(encoder.gap(1, 9, GapRange{1, 1, counts(1, 0, 0, 0, 0, 0), 10, 10}, false)); }, "capture before lost time");
  // A failure other than a contract rejection, here std::bad_alloc at every allocation point in turn, never escapes
  // ingestion: the eventSeq becomes encodingFailed coverage, and the store itself allocates nothing.
  EventStore oom; oom.connect(); unsigned failed_allocations = 0;
  for (long countdown = 0;; ++countdown) {
    const auto record = make_event(oom.next_event_seq(), synthetic_job(), 1000149000000ULL);
    allocation_failed = false; allocation_countdown = countdown;
    const auto result = ingest_event(oom, encoder, record, 1000150000000ULL);
    const bool failed = allocation_failed; allocation_countdown = -1;
    check_store(oom);
    if (!failed) { check(result == Ingest::retained && oom.next_event_seq() == record.event_seq + 1, "retained once nothing fails"); break; }
    check(result == Ingest::lost_encoding_failed && oom.next_event_seq() == record.event_seq + 1, "allocation failure becomes encodingFailed"); ++failed_allocations;
  }
  check(failed_allocations > 10 && oom.status().event_loss.encoding_failed == failed_allocations, "every allocation point covered");
  const auto plain = make_event(oom.next_event_seq() + 1, records::JobCleared{}, 1);
  allocation_failed = false; allocation_countdown = 0;
  const bool no_allocation = oom.lose(oom.next_event_seq(), oom.next_event_seq(), LossCause::offline, 1, 1, 2) && oom.admit(plain, 100, 3) == EventStore::Admission::retained;
  const bool armed = !allocation_failed; allocation_countdown = -1;
  check(no_allocation && armed, "loss and admission allocate nothing");
  std::cout << failed_allocations << " forced allocation failures became encodingFailed; ";
}

// Builds the fixture checkpoint state from SDK-unit values.
StatePod fixture_state(std::uint64_t boundary, std::uint64_t revision, bool speed_available) {
  StatePod s; s.simulation = SimulationState::running;
  if (speed_available) s.speed_mps = available_field(0.0);
  s.fuel_l = available_field(410.5); s.fuel_capacity_l = available_field(1000.0); s.engine_rpm = available_field(600.0); s.gear = available_field<std::int32_t>(3);
  s.odometer_km = available_field(1234.5675); s.average_consumption_l_per_km = available_field(0.325); s.estimated_range_km = available_field(1263.0); s.navigation_distance_m = available_field(151000.0);
  s.game_time = {available_field<std::uint32_t>(12345), make_uuid(GAME_CLOCK)}; s.capture_utc_unix_ms = available_field<std::uint64_t>(1791676800000ULL); s.boundary_order = boundary;
  s.world_placement = available_field(PlacementPod{-31234.5, 42.25, 18800.75, 0.25, 0, -0.01});
  s.configuration.revision = revision; s.configuration.job = available_field(synthetic_job()); s.configuration.truck = available_field(synthetic_truck());
  s.configuration.trailers[0] = available_field(synthetic_trailer());
  WindowPod w; w.handle = 65538; w.width = 1920; w.height = 1080; w.dpi = 96; w.foreground = true; w.display_mode = DisplayMode::borderless; s.window = available_field(w);
  return s;
}
// OD-6: the producer always writes ten trailer slots; the fixtures list only the occupied first slot.
Json with_ten_trailers(Json wire) {
  auto& trailers = std::get<Json::Array>(field(field(field(field(wire, "data"), "state"), "configuration"), "trailers").value);
  while (trailers.size() < limits.trailer_slots) trailers.push_back(Json{Json::Object{{"available", Json{false}}, {"reason", Json{std::string("not-observed")}}}});
  return wire;
}
void same_message(const Json& built, const Json& expected, const std::string& name) {
  check(canonical(built) == canonical(expected), name + " matches the hand-written fixture");
  check(canonical(decode(encode(built)).wire) == canonical(expected), name + " encodes");
}

GearboxPod worst_gearbox();
void messages_case(const Fixtures& f) {
  const Encoder encoder(identity());
  WelcomeInfo w; w.durable_events = true; w.gameplay_events_registered = true; w.game_mode_events = true; w.telemetry_api = {1, 1}; w.game_telemetry = {1, 19}; w.game_mode = single_player_weak();
  same_message(encoder.welcome(1, 1000050000000ULL, w), f.server("welcome").wire, "welcome");
  w.durable_events = false; same_message(encoder.welcome(1, 1000050000000ULL, w), f.server("welcome-live").wire, "welcome-live");
  w.durable_events = true; w.gameplay_events_registered = false; same_message(encoder.welcome(1, 1000050000000ULL, w), f.server("welcome-gameplay-unsupported").wire, "welcome-gameplay-unsupported");
  // OD-3: without game-mode detection the session lists no source.gameMode type and reports unknown/none/none.
  WelcomeInfo od3; od3.durable_events = true; od3.gameplay_events_registered = true;
  const auto unknown = decode(encode(encoder.welcome(1, 1, od3)));
  check(unknown.welcome->event_types.size() == 16 && std::find(unknown.welcome->event_types.begin(), unknown.welcome->event_types.end(), "source.gameMode") == unknown.welcome->event_types.end() &&
    unknown.welcome->game_mode.mode == "unknown" && unknown.welcome->game_mode.method == "none" && unknown.welcome->game_mode.confidence == "none" && !unknown.welcome->game_mode.module.value, "OD-3 welcome");
  check(welcome_event_types(false, false).size() == 10, "neither gameplay nor game-mode types");

  StoreStatus delivery; StatusInfo status{single_player_weak(), true, delivery, {}};
  same_message(encoder.checkpoint(2, 1000100000000ULL, fixture_state(100, 7, true), status), with_ten_trailers(f.server("checkpoint").wire), "checkpoint");
  delivery.next_event_seq = 2; delivery.retained_entries = 1; delivery.retained_bytes = 1500; delivery.oldest_retained_ns = 1000149000000ULL;
  same_message(encoder.snapshot(5, 1000250000000ULL, fixture_state(102, 8, false), StatusInfo{single_player_weak(), true, delivery, {1, 0}}),
    with_ten_trailers(f.server("snapshot").wire), "snapshot");
  StoreStatus live; live.next_event_seq = 3; live.retained_entries = 1; live.retained_bytes = 1024; live.oldest_retained_ns = 1000200000000ULL; live.event_loss.no_durable_consumer = 2;
  auto live_state = minimal_state(); auto live_expected = f.server("snapshot-live").wire;
  field(field(live_expected, "data"), "state") = field(field(decode(encode(encoder.snapshot(5, 1000250000000ULL, live_state, StatusInfo{single_player_weak(), false, live, {1, 0}}))).wire, "data"), "state");
  same_message(encoder.snapshot(5, 1000250000000ULL, live_state, StatusInfo{single_player_weak(), false, live, {1, 0}}), live_expected, "snapshot-live status");

  // Every record type from its SDK-unit POD.
  const auto event = [&](const Encoder& e, RecordBody body, const std::string& name, const std::function<void(EventRecord&)>& change = {}) {
    auto record = make_event(1, body, 1000149000000ULL); if (change) change(record);
    auto expected = f.server(name).wire; same_message(e.event(3, 1000150000000ULL, record, false), expected, name);
  };
  event(encoder, synthetic_job(), "event-job-configured"); event(encoder, records::JobCleared{}, "event-job-cleared");
  event(encoder, synthetic_truck(), "event-truck-configured"); event(encoder, records::TruckCleared{}, "event-truck-cleared");
  event(encoder, synthetic_trailer(), "event-trailer-configured"); event(encoder, records::TrailerCleared{0}, "event-trailer-cleared");
  event(encoder, records::SimulationPaused{}, "event-simulation-paused"); event(encoder, records::SimulationStarted{}, "event-simulation-started");
  event(encoder, records::TimersRestart{}, "event-timers-restart");
  records::GameTimeRegression regression; regression.from = {available_field<std::uint32_t>(12345), make_uuid(GAME_CLOCK)}; regression.to = {available_field<std::uint32_t>(11000), make_uuid(GAME_CLOCK_2)};
  event(encoder, regression, "event-game-time-regression", [&](EventRecord& r) { r.occurred.game_time = regression.to; });
  records::JobDelivered delivered; delivered.revenue = available_field<std::int64_t>(15000); delivered.earned_xp = available_field(250); delivered.cargo_damage = available_field(0.0125);
  delivered.distance_km = available_field(151.2505f); delivered.delivery_duration_min = available_field<std::uint32_t>(471); delivered.auto_park_used = available_field(false); delivered.auto_load_used = available_field(true);
  {
    // SDK distance.km is a float: 151.2505f is 151.25050354003906 km, so the exact metre value differs from the fixture's 151250.5.
    auto built = encoder.event(3, 1000150000000ULL, make_event(1, delivered, 1000149000000ULL), false);
    auto& distance = field(field(field(field(built, "data"), "record"), "distance"), "value");
    check(distance.number() == static_cast<double>(151.2505f) * 1000 && std::fabs(distance.number() - 151250.5) < 0.01, "float kilometres times 1,000");
    distance = Json{151250.5}; same_message(built, f.server("event-job-delivered").wire, "event-job-delivered");
  }
  event(encoder, records::JobCancelled{available_field<std::int64_t>(-1200)}, "event-job-cancelled");
  records::PlayerFined fined; fined.offence.assign("speeding_camera"); fined.amount = available_field<std::int64_t>(-300);
  event(Encoder(identity(SESSION, eur())), fined, "event-player-fined");
  event(encoder, records::PlayerTollgatePaid{available_field<std::int64_t>(-25)}, "event-player-tollgate-paid");
  records::PlayerUseFerry ferry; static_cast<records::Transfer&>(ferry) = transfer("synthetic_port_a", "Synthetic Port A", "synthetic_port_b", "Synthetic Port B");
  event(encoder, ferry, "event-player-use-ferry");
  records::PlayerUseTrain train; static_cast<records::Transfer&>(train) = transfer("synthetic_station_a", "Synthetic Station A", "synthetic_station_b", "Synthetic Station B");
  event(encoder, train, "event-player-use-train");
  records::SourceGameMode mode; mode.mode.mode = GameModeKind::truckersmp; mode.mode.method = DetectionMethod::module_scan; mode.mode.confidence = Confidence::strong;
  mode.mode.module.assign("synthetic-multiplayer-module.dll"); event(encoder, mode, "event-source-game-mode");
  event(encoder, records::SimulationStarted{}, "event-unavailable-occurrence", [](EventRecord& r) {
    r.occurred.monotonic_ns = {}; r.occurred.game_time.minutes = {}; r.occurred.utc_unix_ms.state = FieldState::not_supported; r.occurred.simulation = SimulationState::unavailable; });

  same_message(encoder.gap(7, 1000350000000ULL, GapRange{3, 4, counts(0, 0, 1, 1, 0, 0), 1000330000000ULL, 1000340000000ULL}, false), f.server("gap").wire, "gap");
  same_message(encoder.clock_reply(9, 1000450000000ULL, 1, 1000449700000ULL, 1000449900000ULL), f.server("clock-reply").wire, "clock-reply");
  same_message(encoder.end(10, 1000500000000ULL, EndReason::plugin_shutdown, EndCursor{6, 5, 0}), f.server("end").wire, "end");
  same_message(encoder.end(10, 1000500000000ULL, EndReason::sequence_exhausted, EndCursor{u64_max, u64_max - 2, 1}), f.server("end-sequence-exhausted").wire, "end-sequence-exhausted");

  // The worst-case event: every text at its byte limit, quotes and backslashes that double under escaping.
  const auto worst = f.server("event-worst"); const auto& wr = field(field(worst.wire, "data"), "record");
  SessionIdentity worst_id = identity(); worst_id.source.process_id = 4294967295U; worst_id.source.windows_session_id = 4294967295U;
  worst_id.currency = read_money(wr.at("expectedIncome"), SdkType::u64).value->currency; const Encoder worst_encoder(worst_id);
  records::JobConfigured big;
  const auto id = [&](IdText& t, const char* key) { t.assign(read_text(wr.at(key), TextKind::id).value->c_str()); };
  const auto name = [&](NameText& t, const char* key) { t.assign(read_text(wr.at(key), TextKind::name).value->c_str()); };
  id(big.source_city_id, "sourceCityId"); id(big.source_company_id, "sourceCompanyId"); id(big.destination_city_id, "destinationCityId");
  id(big.destination_company_id, "destinationCompanyId"); id(big.cargo_id, "cargoId"); id(big.market, "market");
  name(big.source_city, "sourceCity"); name(big.source_company, "sourceCompany"); name(big.destination_city, "destinationCity"); name(big.destination_company, "destinationCompany"); name(big.cargo, "cargo");
  big.cargo_mass_kg = available_field(1.2345678901234568e-300); big.cargo_unit_mass_kg = big.cargo_mass_kg; big.cargo_unit_count = available_field(std::numeric_limits<std::uint32_t>::max());
  big.is_special_job = available_field(false); big.cargo_loaded = available_field(false); big.planned_distance_km = available_field(std::numeric_limits<std::uint32_t>::max());
  big.expected_income = available_field(u64_max); big.delivery_deadline_min = available_field(std::numeric_limits<std::uint32_t>::max());
  EventRecord worst_record; worst_record.event_seq = max_event_seq; worst_record.record = big;
  worst_record.occurred.monotonic_ns = available_field(u64_max); worst_record.occurred.game_time = {available_field(std::numeric_limits<std::uint32_t>::max()), make_uuid(GAME_CLOCK)};
  worst_record.occurred.utc_unix_ms = available_field(u64_max); worst_record.occurred.configuration_revision = u64_max; worst_record.occurred.boundary_order = u64_max;
  const auto worst_built = worst_encoder.event(u64_max, u64_max, worst_record, true);
  same_message(worst_built, worst.wire, "event-worst");
  const auto worst_size = worst_encoder.measure_event(worst_record);
  check(worst_size == 6306u && encode(worst_built).size() - 4 == 6305, "worst event: 6,305 bytes, measured 6,306 with redelivered false");
  // The worst-case state (ten trailers, every text at its limit) fits the server frame.
  StatePod heavy = fixture_state(u64_max, u64_max, true); records::TrailerConfigured heavy_trailer; const auto fill = std::string(name_bytes / 2, '"') + std::string(name_bytes / 2, '\\');
  for (auto* t : {&heavy_trailer.id, &heavy_trailer.body_type, &heavy_trailer.chain_type, &heavy_trailer.cargo_accessory_id, &heavy_trailer.brand_id, &heavy_trailer.plate_country_id}) t->assign(fill.substr(0, id_bytes));
  for (auto* t : {&heavy_trailer.brand, &heavy_trailer.name, &heavy_trailer.license_plate, &heavy_trailer.plate_country}) t->assign(fill);
  for (auto& slot : heavy.configuration.trailers) slot = available_field(heavy_trailer);
  auto heavy_job = big; heavy.configuration.job = available_field(heavy_job);
  records::TruckConfigured heavy_truck; for (auto* t : {&heavy_truck.brand_id, &heavy_truck.id, &heavy_truck.plate_country_id}) t->assign(fill.substr(0, id_bytes));
  for (auto* t : {&heavy_truck.brand, &heavy_truck.name, &heavy_truck.license_plate, &heavy_truck.plate_country}) t->assign(fill);
  heavy_truck.fuel_capacity_l = available_field(1e6); heavy.configuration.truck = available_field(heavy_truck);
  StoreStatus worst_delivery; worst_delivery.acked_through_event_seq = u64_max - 1; worst_delivery.next_event_seq = u64_max;
  const auto heavy_frame = encode(worst_encoder.checkpoint(u64_max, u64_max, heavy, StatusInfo{single_player_weak(), true, worst_delivery, {u64_max, u64_max}}));
  check(heavy_frame.size() - 4 <= limits.server_frame_bytes, "worst state fits 64 KiB");
  std::cout << "worst checkpoint built " << heavy_frame.size() - 4 << " bytes; ";
  // ET-050b: with the worst-case gearbox the minor-1 checkpoint still fits (D17), and the minor-0 bytes do not change.
  heavy.gearbox = worst_gearbox();
  const auto heavy_status = StatusInfo{single_player_weak(), true, worst_delivery, {u64_max, u64_max}};
  check(encode(worst_encoder.checkpoint(u64_max, u64_max, heavy, heavy_status)) == heavy_frame, "a gearbox never reaches the minor-0 worst checkpoint");
  const auto heavy_minor1 = encode(worst_encoder.checkpoint(u64_max, u64_max, heavy, heavy_status, 1), 1);
  check(heavy_minor1.size() - 4 <= limits.server_frame_bytes, "worst minor-1 state fits 64 KiB");
  std::cout << "worst minor-1 checkpoint built " << heavy_minor1.size() - 4 << " bytes; ";
}

// ET-050b PR-4: the minor-1 gearbox from the raw adapter copies. The slot tables are the hand-written CAP-01 tables of the
// accepted plan; the SDK sends 32 slots, handle positions 0-7 times selector states 0-3, and an unmatched slot is gear 0.
struct LayoutRow { std::int32_t gear; std::uint32_t handle, selectors; };
constexpr std::uint8_t slot_complete = slot_gear_seen | slot_handle_seen | slot_selectors_seen;
Field<HShifterPod> sdk_layout(std::initializer_list<LayoutRow> gears) {
  HShifterPod h; h.selector_count = 2;
  for (std::uint32_t i = 0; i < 32; ++i) { auto& s = h.slots[i]; s.handle_position = i / 4; s.selectors = i % 4; s.seen = slot_complete; }
  for (const auto& row : gears) h.slots[row.handle * 4 + row.selectors].gear = row.gear;
  return available_field(h);
}
Field<HShifterPod> daf_12() {
  return sdk_layout({{-1, 1, 0}, {-3, 1, 1}, {-2, 1, 2}, {-4, 1, 3}, {1, 2, 0}, {7, 2, 1}, {2, 2, 2}, {8, 2, 3}, {3, 3, 0}, {9, 3, 1}, {4, 3, 2}, {10, 3, 3},
    {5, 4, 0}, {11, 4, 1}, {6, 4, 2}, {12, 4, 3}});
}
Field<HShifterPod> mack_18() {
  return sdk_layout({{-1, 2, 0}, {-3, 2, 1}, {-2, 2, 2}, {-4, 2, 3}, {1, 3, 0}, {2, 3, 2}, {3, 4, 0}, {11, 4, 1}, {4, 4, 2}, {12, 4, 3}, {5, 5, 0}, {13, 5, 1},
    {6, 5, 2}, {14, 5, 3}, {7, 6, 0}, {15, 6, 1}, {8, 6, 2}, {16, 6, 3}, {9, 7, 0}, {17, 7, 1}, {10, 7, 2}, {18, 7, 3}});
}
GearboxPod gearbox_of(std::uint32_t forward, std::uint32_t reverse, Field<HShifterPod> layout) {
  GearboxPod g; g.forward_gears = available_field(forward); g.reverse_gears = available_field(reverse); g.hshifter = layout; return g;
}
// The worst-case gearbox of minor1/checkpoint-worst.json: not-supported counts and 64 slots of maximal width.
GearboxPod worst_gearbox() {
  GearboxPod g; g.forward_gears.state = g.reverse_gears.state = FieldState::not_supported;
  HShifterPod h; h.selector_count = 6; std::size_t i = 0;
  for (std::uint32_t s = 10; s <= 63; ++s) h.slots[i++] = HShifterSlotRaw{-100, 255, s, slot_complete};
  for (std::uint32_t s = 10; s <= 19; ++s) h.slots[i++] = HShifterSlotRaw{-100, 254, s, slot_complete};
  g.hshifter = available_field(h); return g;
}
Message minor1(const Fixtures& f, const std::string& name) { return decode_payload(read(f.dir / "minor1" / (name + ".json")), Sender::server, 1); }
const Json& gearbox_node(const Json& message) { return field(field(field(message, "data"), "state"), "gearbox"); }
// Encodes and decodes one server message at minor 1.
Message roundtrip1(const Json& wire) { const auto frame = encode(wire, 1); return decode_payload(std::string(frame.begin() + 4, frame.end()), Sender::server, 1); }
Json encoded_gearbox(const GearboxPod& g) {
  auto s = minimal_state(); s.gearbox = g;
  return gearbox_node(roundtrip1(Encoder(identity()).snapshot(1, 1, s, {}, 1)).wire);
}
bool gearbox_reason(const GearboxPod& g, const char* part, const char* reason) {
  const auto node = encoded_gearbox(g); const auto& p = field(node, part);
  return !field(p, "available").boolean() && field(p, "reason").string() == reason;
}
void gearbox_case(const Fixtures& f) {
  const Encoder encoder(identity());
  StoreStatus delivery; StatusInfo status{single_player_weak(), true, delivery, {}};
  // The CAP-01 ETS2 DAF 12-speed and ATS Mack 18-speed layouts equal the hand-written minor-1 checkpoints.
  auto daf = fixture_state(100, 7, true); daf.gearbox = gearbox_of(12, 4, daf_12());
  const auto daf_built = encoder.checkpoint(2, 1000100000000ULL, daf, status, 1);
  check(canonical(daf_built) == canonical(with_ten_trailers(minor1(f, "checkpoint").wire)), "DAF 12-speed checkpoint matches minor1/checkpoint");
  check(canonical(roundtrip1(daf_built).wire) == canonical(with_ten_trailers(minor1(f, "checkpoint").wire)), "DAF checkpoint encodes at minor 1");
  auto ats = identity(); ats.source.game = GameId::ats; const Encoder ats_encoder(ats);
  auto mack = fixture_state(100, 7, true); mack.gearbox = gearbox_of(18, 4, mack_18());
  check(canonical(ats_encoder.checkpoint(2, 1000100000000ULL, mack, status, 1)) == canonical(with_ten_trailers(minor1(f, "checkpoint-ats-mack").wire)),
    "Mack 18-speed checkpoint matches minor1/checkpoint-ats-mack");
  // Minor 0 never carries the gearbox: the bytes equal the frozen fixture and the state without a gearbox.
  const auto frozen = canonical(with_ten_trailers(f.server("checkpoint").wire));
  check(canonical(encoder.checkpoint(2, 1000100000000ULL, daf, status)) == frozen && canonical(encoder.checkpoint(2, 1000100000000ULL, daf, status, 0)) == frozen,
    "minor-0 checkpoint unchanged by a populated gearbox");
  check(encode(encoder.checkpoint(2, 1000100000000ULL, daf, status)) == encode(encoder.checkpoint(2, 1000100000000ULL, fixture_state(100, 7, true), status)),
    "minor-0 checkpoint bytes identical with and without a gearbox");
  StoreStatus snap; snap.next_event_seq = 2; snap.retained_entries = 1; snap.retained_bytes = 1500; snap.oldest_retained_ns = 1000149000000ULL;
  const StatusInfo snap_status{single_player_weak(), true, snap, {1, 0}};
  auto snapshot_state = fixture_state(102, 8, false); snapshot_state.gearbox.forward_gears = available_field<std::uint32_t>(12); snapshot_state.gearbox.reverse_gears = available_field<std::uint32_t>(4);
  check(canonical(encoder.snapshot(5, 1000250000000ULL, snapshot_state, snap_status, 1)) == canonical(with_ten_trailers(minor1(f, "snapshot").wire)), "snapshot with counts and no layout");
  check(encode(encoder.snapshot(5, 1000250000000ULL, snapshot_state, snap_status)) == encode(encoder.snapshot(5, 1000250000000ULL, fixture_state(102, 8, false), snap_status)) &&
    canonical(encoder.snapshot(5, 1000250000000ULL, snapshot_state, snap_status)) == canonical(with_ten_trailers(f.server("snapshot").wire)), "minor-0 snapshot bytes unchanged");
  rejects([&] { encode(daf_built); }, "the default encoder refuses a minor-1 checkpoint");
  // Every other message of a minor-1 connection differs only by its minor.
  WelcomeInfo w; w.durable_events = true; w.gameplay_events_registered = true; w.game_mode_events = true; w.telemetry_api = {1, 1}; w.game_telemetry = {1, 19}; w.game_mode = single_player_weak();
  check(canonical(encoder.welcome(1, 1000050000000ULL, w, 1)) == canonical(minor1(f, "welcome").wire), "minor-1 welcome");
  check(canonical(roundtrip1(encoder.welcome(1, 1000050000000ULL, w, 1)).wire) == canonical(minor1(f, "welcome").wire), "minor-1 welcome encodes");
  check(canonical(encoder.event(3, 1000150000000ULL, make_event(1, synthetic_job(), 1000149000000ULL), false, 1)) == canonical(minor1(f, "event-job-configured").wire), "minor-1 event");
  check(canonical(encoder.gap(7, 1000350000000ULL, GapRange{3, 4, counts(0, 0, 1, 1, 0, 0), 1000330000000ULL, 1000340000000ULL}, false, 1)) == canonical(minor1(f, "gap").wire), "minor-1 gap");
  check(canonical(encoder.clock_reply(9, 1000450000000ULL, 1, 1000449700000ULL, 1000449900000ULL, 1)) == canonical(minor1(f, "clock-reply").wire), "minor-1 clock reply");
  check(canonical(encoder.end(10, 1000500000000ULL, EndReason::plugin_shutdown, EndCursor{2, 1, 0}, 1)) == canonical(minor1(f, "end").wire), "minor-1 end");
  // Availability parts against the hand-written minor-1 snapshots.
  auto counts_unseen = gearbox_of(0, 0, daf_12()); counts_unseen.forward_gears = {}; counts_unseen.reverse_gears = {};
  check(canonical(encoded_gearbox(counts_unseen)) == canonical(gearbox_node(minor1(f, "snapshot-counts-not-observed").wire)), "counts not observed, layout available");
  auto invalid_layout = gearbox_of(12, 4, {}); invalid_layout.hshifter.state = FieldState::invalid;
  check(canonical(encoded_gearbox(invalid_layout)) == canonical(gearbox_node(minor1(f, "snapshot-hshifter-invalid").wire)), "invalid layout");
  GearboxPod unsupported; unsupported.forward_gears.state = unsupported.reverse_gears.state = unsupported.hshifter.state = FieldState::not_supported;
  check(canonical(encoded_gearbox(unsupported)) == canonical(gearbox_node(minor1(f, "snapshot-gearbox-not-supported").wire)), "every part not supported");
  HShifterPod zero; zero.selector_count = 0;
  for (std::uint32_t i = 0; i < 8; ++i) zero.slots[i] = HShifterSlotRaw{i == 0 ? 0 : i == 1 ? -1 : static_cast<std::int32_t>(i - 1), i, 0, slot_complete};
  check(canonical(encoded_gearbox(gearbox_of(6, 1, available_field(zero)))) == canonical(gearbox_node(minor1(f, "snapshot-zero-selectors").wire)), "zero-selector layout");
  check(canonical(encoded_gearbox(gearbox_of(12, 4, sdk_layout({})))) == canonical(gearbox_node(minor1(f, "snapshot-all-neutral-slots").wire)), "every slot neutral: an empty available layout");
  check(gearbox_reason(GearboxPod{}, "forwardGears", "not-observed") && gearbox_reason(GearboxPod{}, "hshifter", "not-observed"), "a default gearbox is not observed");
  // B2 bounds: invalid as a whole, never truncated.
  const auto layout_with = [](const std::function<void(HShifterPod&)>& change) { auto l = daf_12(); change(l.value); return gearbox_of(12, 4, l); };
  const auto slots_of = [](const GearboxPod& g) { return std::get<Json::Array>(field(field(field(encoded_gearbox(g), "hshifter"), "value"), "slots").value).size(); };
  check(field(field(encoded_gearbox(gearbox_of(100, 100, daf_12())), "forwardGears"), "value").number() == 100 && gearbox_reason(gearbox_of(101, 4, daf_12()), "forwardGears", "invalid") &&
    gearbox_reason(gearbox_of(12, 101, daf_12()), "reverseGears", "invalid"), "gear counts 100 and 101");
  check(slots_of(layout_with([](HShifterPod& h) { h.slots[8].gear = 100; h.slots[4].gear = -100; })) == 16, "gears -100 and 100 are kept");
  check(gearbox_reason(layout_with([](HShifterPod& h) { h.slots[8].gear = 101; }), "hshifter", "invalid") && gearbox_reason(layout_with([](HShifterPod& h) { h.slots[8].gear = -101; }), "hshifter", "invalid"), "gear 101 and -101");
  check(gearbox_reason(layout_with([](HShifterPod& h) { h.slots[0].gear = 101; }), "hshifter", "invalid"), "an out-of-range neutral-position slot is not hidden by omission");
  check(slots_of(layout_with([](HShifterPod& h) { h.slots[31].handle_position = 255; })) == 16 && gearbox_reason(layout_with([](HShifterPod& h) { h.slots[31].handle_position = 256; }), "hshifter", "invalid"), "handle position 255 and 256");
  check(gearbox_reason(layout_with([](HShifterPod& h) { h.slots[8].selectors = 4; }), "hshifter", "invalid") && gearbox_reason(layout_with([](HShifterPod& h) { h.selector_count = 7; }), "hshifter", "invalid"), "selectors below 2^count; at most 6 selectors");
  check(slots_of(layout_with([](HShifterPod& h) { h.selector_count = 6; h.slots[8].selectors = 63; })) == 16 && gearbox_reason(layout_with([](HShifterPod& h) { h.selector_count = 6; h.slots[8].selectors = 64; }), "hshifter", "invalid"), "selectors 63 and 64 under 6 selectors");
  check(gearbox_reason(layout_with([](HShifterPod& h) { h.slots[9].seen = slot_gear_seen | slot_handle_seen; }), "hshifter", "invalid") && gearbox_reason(layout_with([](HShifterPod& h) { h.slots[40].seen = slot_gear_seen; h.slots[40].gear = 5; }), "hshifter", "invalid"), "an incomplete slot triple");
  check(gearbox_reason(layout_with([](HShifterPod& h) { h.slots[9].selectors = 0; }), "hshifter", "invalid") && gearbox_reason(layout_with([](HShifterPod& h) { h.slots[0].handle_position = 1; }), "hshifter", "invalid"), "a duplicate pair, also against a neutral slot");
  check(slots_of(layout_with([](HShifterPod& h) { h.slots[9].gear = 1; })) == 16, "a repeated gear is allowed; the wire does not check the layout against the counts");
  check(slots_of(layout_with([](HShifterPod& h) { h.slots[20] = {}; h.slots[40] = HShifterSlotRaw{20, 9, 0, slot_complete}; })) == 17, "an uncopied slot is skipped and slot order is SDK order");
  HShifterPod full; full.selector_count = 6; for (std::uint32_t i = 0; i < 64; ++i) full.slots[i] = HShifterSlotRaw{1, i / 64, i, slot_complete};
  check(slots_of(gearbox_of(1, 0, available_field(full))) == 64, "64 slots");
  const auto order = field(field(encoded_gearbox(layout_with([](HShifterPod& h) { h.slots[40] = HShifterSlotRaw{20, 9, 0, slot_complete}; })), "hshifter"), "value");
  check(std::get<Json::Array>(field(order, "slots").value).back().at("gear").number() == 20 && std::get<Json::Array>(field(order, "slots").value).front().at("gear").number() == -1, "SDK slot order");
  check(canonical(encoded_gearbox(worst_gearbox())) == canonical(gearbox_node(minor1(f, "checkpoint-worst").wire)), "worst-case gearbox matches minor1/checkpoint-worst");
  // The ET-002b Consumer at minor 1 accepts the encoder's minor-1 stream and rejects a minor-0 frame within it.
  Consumer consumer(true, 1); std::uint64_t seq = 0;
  const auto accept = [&](const Json& wire) { return consumer.accept(roundtrip1(wire)); };
  accept(encoder.welcome(++seq, 10, w, 1));
  const auto hydrated = accept(encoder.checkpoint(++seq, 20, daf, StatusInfo{single_player_weak(), true, StoreStatus{}, {}}, 1));
  check(hydrated.hydration && consumer.minor() == 1u, "a minor-1 checkpoint hydrates a minor-1 consumer");
  rejects([&] { consumer.accept(decode(encode(encoder.snapshot(++seq, 30, daf, StatusInfo{single_player_weak(), true, StoreStatus{}, {}})))); }, "a minor-0 snapshot on a minor-1 connection");
}

void streams_case() {
  // normal: events and a gap in order, ACK 5, end.
  {
    Harness h; h.open(true); h.ingest(h.next_event(synthetic_job())); h.snapshot(); h.ingest(h.next_event(synthetic_truck()));
    h.lose(2, LossCause::queue_count); h.ingest(h.next_event()); h.pump(); h.commit();
    check(h.ack() == 5u, "normal ACK 5"); const auto end = h.end(EndReason::plugin_shutdown);
    check(end.end->next_event_seq == 6 && end.end->acked_through_event_seq == 5 && end.end->retained_unacked == 0, "normal end");
    check(h.cursor->through_event_seq() == 5, "normal accept 5");
  }
  // late-attach: offline events become an offline gap before the first connection; the checkpoint only hydrates.
  {
    Harness h; h.tick(); h.store.lose(1, 3, LossCause::offline, h.now - 900, h.now - 100, h.now);
    const auto cp = h.open(true); check(cp.next_event_seq == 4 && cp.retained_entries == 1 && cp.retained_bytes == 1024 && cp.event_loss.offline == 3, "checkpoint-late");
    h.ingest(h.next_event()); h.pump();
    check(h.link->messages[2].gap && h.link->messages[2].gap->causes.offline == 3 && !h.link->messages[2].gap->redelivered, "gap-offline");
    h.commit(); check(h.ack() == 4u, "late-attach accept 4");
  }
  // reconnect-redelivery and lost-ack-reconnect.
  {
    Harness h; h.open(true); h.ingest(h.next_event(synthetic_job())); h.ingest(h.next_event(synthetic_truck())); h.pump(); h.commit(1); check(h.ack() == 1u, "ACK 1");
    h.commit(); check(h.cursor->ack().has_value(), "ACK 2 produced"); // lost with the connection
    h.close(); const auto cp = h.open(true); check(cp.acked_through_event_seq == 1 && cp.next_event_seq == 3, "checkpoint-reconnect");
    check(!h.cursor->ack(), "A:- before redelivery");
    h.ingest(h.next_event()); h.pump();
    check(h.link->messages[2].event->redelivered && h.link->messages[2].event->event_seq == 2 && !h.link->messages[3].event->redelivered, "redelivered then live");
    h.commit(); check(h.ack() == 3u && h.cursor->through_event_seq() == 3, "lost-ack-reconnect accept 3");
  }
  // queue-count-overflow and queue-bytes-overflow at their stream positions.
  {
    Harness h; h.open(true); h.ingest(h.next_event());
    for (unsigned i = 0; i < 254; ++i) h.admit_sized(h.next_event(), 10);
    check(h.admit_sized(h.next_event(), 10) == EventStore::Admission::lost_queue_count, "queueCount");
    h.pump(); h.commit(); check(h.ack() == 256u, "the overflow gap is acknowledged with its events");
    check(h.link->messages.back().gap && h.link->messages.back().gap->causes.queue_count == 1, "gap-queue-count");
    check(h.admit_sized(h.next_event(), 10) == EventStore::Admission::retained, "event-after-queue-count");
    h.pump(); h.commit(); check(h.ack() == 257u, "queue-count-overflow");
  }
  // A durable reconnect after a live-only connection: noDurableConsumer coverage is retained for the durable consumer.
  {
    Harness h; h.open(false); h.tick(); h.store.lose(1, 2, LossCause::no_durable_consumer, h.now - 10, h.now, h.now);
    const auto live = h.snapshot(); check(!live.state->status.delivery.durable && live.state->status.delivery.next_event_seq == 3 && live.state->status.event_loss.no_durable_consumer == 2, "snapshot-live");
    check(!h.store.next_outbound(), "nothing is written to a live-only client");
    h.close(); check(!h.store.retention_deadline_ns(), "a live-only client starts no retention window");
    h.open(true); h.pump(); check(h.link->messages[2].gap->causes.no_durable_consumer == 2, "noDurableConsumer gap"); h.commit(); check(h.ack() == 2u, "acknowledged");
  }
  // plugin-restart: a new plugin session restarts eventSeq at 1 with a new cursor.
  {
    Harness first; first.open(true); first.ingest(first.next_event()); first.ingest(first.next_event()); first.pump(); first.close();
    Harness second(SESSION_2); const auto cp = second.open(true); check(cp.next_event_seq == 1 && cp.acked_through_event_seq == 0, "checkpoint-restart");
    second.ingest(second.next_event()); second.pump(); second.commit(); check(second.ack() == 1u && second.cursor->plugin_session_id() == SESSION_2, "plugin-restart accept 1");
  }
  // Snapshots between items stay consistent with the coverage written so far; a gap extended twice yields two deltas.
  {
    Harness h; h.open(true); h.lose(1, LossCause::queue_count); h.pump(); h.snapshot();
    h.lose(2, LossCause::offline); h.snapshot(); h.pump(); h.lose(1, LossCause::encoding_failed); h.pump(); h.snapshot();
    const auto gaps = std::count_if(h.link->messages.begin(), h.link->messages.end(), [](const Message& m) { return m.gap.has_value(); });
    check(gaps == 3 && h.store.entries() == 1 && same(h.store.entry(0).causes, counts(2, 0, 1, 0, 0, 1)), "three gap messages, one record");
    h.commit(); check(h.ack() == 4u && h.store.entries() == 0, "deltas acknowledged together");
  }
  // Sequence exhaustion ends the session with sequence-exhausted.
  {
    Harness h; h.open(true); h.ingest(h.next_event()); h.tick(); h.store.lose(2, max_event_seq, LossCause::offline, h.now, h.now, h.now);
    check(h.store.exhausted(), "exhausted"); h.pump(); h.commit(); check(h.ack() == max_event_seq, "last eventSeq acknowledged");
    const auto end = h.end(EndReason::sequence_exhausted);
    check(end.end->next_event_seq == u64_max && end.end->acked_through_event_seq == max_event_seq && end.end->retained_unacked == 0, "sequence-exhausted end");
  }
}

// Seeded operation mix with the oracle and a conservation ledger: every eventSeq ends as an acknowledged event or as
// gap coverage, the loss counters equal the eventSeqs carried by gaps, and redelivery never changes an event.
void randomized_case() {
  for (const std::uint64_t seed : {1ULL, 2ULL, 3ULL, 20261014ULL, 0x5eedULL}) {
    std::mt19937_64 random(seed); Harness h; std::uint64_t expiries = 0;
    const auto pick = [&](std::uint64_t n) { return random() % n; };
    for (unsigned step = 0; step < 1500; ++step) {
      const auto op = pick(100);
      if (op < 40) {
        RecordBody body = records::SimulationPaused{};
        const auto kind = pick(6);
        if (kind == 0) body = synthetic_job(); else if (kind == 1) body = synthetic_truck(); else if (kind == 2) body = records::TrailerCleared{static_cast<std::uint8_t>(pick(11))};
        else if (kind == 3) { records::JobDelivered d; d.revenue = available_field(static_cast<std::int64_t>(random())); body = d; }
        if (h.link && h.link->durable && pick(4) == 0) for (auto n = pick(20); n--;) h.admit_sized(h.next_event(), 1 + pick(limits.event_bytes));
        else h.ingest(h.next_event(body));
      } else if (op < 50) h.lose(1 + pick(4), static_cast<LossCause>(pick(6)));
      else if (op < 62) { if (h.link && h.link->durable) h.pump(1 + pick(30)); }
      else if (op < 72) { if (h.link && h.link->durable) h.commit(pick(20)); }
      else if (op < 82) { if (h.link && h.link->durable) h.ack(); }
      else if (op < 86) { if (h.link) h.snapshot(); }
      else if (op < 92) { if (h.link) h.close(); else h.open(pick(5) != 0); }
      else {
        const auto before = h.store.status().event_loss.retention_expired;
        h.tick(pick(3) == 0 ? retention_ns + pick(1000) : 1 + pick(10'000'000'000ULL)); h.store.expire(h.now); check_store(h.store, &h.monotone);
        if (h.store.status().event_loss.retention_expired > before) ++expiries;
      }
    }
    // Final drain: one durable connection writes, commits and acknowledges everything.
    if (h.link && !h.link->durable) h.close();
    if (!h.link) h.open(true);
    h.pump(); h.commit(); h.ack();
    const auto s = h.store.status(); const auto& l = s.event_loss;
    check(h.store.entries() == 0 && s.acked_through_event_seq == s.next_event_seq - 1 && h.cursor->through_event_seq() == s.next_event_seq - 1, "everything acknowledged");
    check(l.offline + l.no_durable_consumer + l.queue_count + l.queue_bytes + l.retention_expired + l.encoding_failed == h.gaps_received.size(), "loss counters equal gap coverage");
    for (std::uint64_t seq = 1; seq < s.next_event_seq; ++seq) check(h.committed.count(seq) || h.gaps_committed.contains(seq), "every eventSeq committed as an event or a gap");
    for (const auto& [seq, committed] : h.committed) check(h.admitted.at(seq) == committed, "committed event identity");
    check(expiries > 0 && h.redelivered_items > 0 && l.queue_count > 0 && l.queue_bytes > 0 && l.encoding_failed > 0 && s.next_event_seq > 1000, "seed exercised expiry, redelivery and every admission loss");
    std::cout << "seed " << seed << ": N=" << s.next_event_seq << " connections=" << h.connections << " redelivered=" << h.redelivered_items << " expiries=" << expiries
      << " loss offline=" << l.offline << " noDurableConsumer=" << l.no_durable_consumer << " queueCount=" << l.queue_count << " queueBytes=" << l.queue_bytes
      << " retentionExpired=" << l.retention_expired << " encodingFailed=" << l.encoding_failed << "; ";
  }
}

// Bounded mutation of copied values: texts, numbers, availability states and identifiers within the records.
struct Mutator {
  std::mt19937_64& random;
  FieldState state() { const auto n = random() % 8; return n < 5 ? FieldState::available : static_cast<FieldState>(n % 4 == 1 ? 7 : n % 4); }
  template<std::size_t N> void operator()(FixedText<N>& t) {
    t.state = state(); t.length = static_cast<std::uint16_t>(random() % (N + 8));
    static const char special[] = {'"', '\\', '\x01', '\x7f', '\xc3', '\xa9', '\xed', '\xa0', '\x80', '\xf4', '\x90', '\0', 'a'};
    for (auto n = random() % 6; n--;) t.bytes[random() % N] = random() % 2 ? special[random() % sizeof special] : static_cast<char>(random());
  }
  void operator()(Field<double>& f) {
    static const double values[] = {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
      std::numeric_limits<double>::max(), -0.0, 1e-300, 1e12 + 1, -1e9 - 1, 0.5};
    f.state = state(); if (random() % 2) f.value = values[random() % std::size(values)]; else { const auto bits = random(); std::memcpy(&f.value, &bits, sizeof bits); }
  }
  // A finite double outside the float range cannot be converted (undefined behavior), so it saturates at the float limit.
  void operator()(Field<float>& f) {
    Field<double> d; (*this)(d); f.state = d.state; constexpr float limit = std::numeric_limits<float>::max();
    f.value = !std::isfinite(d.value) || std::fabs(d.value) <= limit ? static_cast<float>(d.value) : d.value > 0 ? limit : -limit;
  }
  void operator()(Field<bool>& f) { f.state = state(); f.value = random() % 2 != 0; }
  template<class T> void operator()(Field<T>& f) { f.state = state(); f.value = static_cast<T>(random()); }
  void operator()(GameTimePod& g) { (*this)(g.minutes); if (random() % 8 == 0) g.clock_id.text[random() % 36] = static_cast<char>(random()); }
  void operator()(GameModePod& g) {
    g.mode = static_cast<GameModeKind>(random() % 4); g.method = static_cast<DetectionMethod>(random() % 4); g.confidence = static_cast<Confidence>(random() % 4); (*this)(g.module);
  }
  void operator()(records::JobConfigured& j) {
    for (auto* t : {&j.source_city_id, &j.source_company_id, &j.destination_city_id, &j.destination_company_id, &j.cargo_id, &j.market}) (*this)(*t);
    for (auto* t : {&j.source_city, &j.source_company, &j.destination_city, &j.destination_company, &j.cargo}) (*this)(*t);
    (*this)(j.cargo_mass_kg); (*this)(j.cargo_unit_mass_kg); (*this)(j.cargo_unit_count); (*this)(j.is_special_job); (*this)(j.cargo_loaded);
    (*this)(j.planned_distance_km); (*this)(j.expected_income); (*this)(j.delivery_deadline_min);
  }
  void operator()(records::TruckConfigured& t) {
    for (auto* x : {&t.brand_id, &t.id, &t.plate_country_id}) (*this)(*x);
    for (auto* x : {&t.brand, &t.name, &t.license_plate, &t.plate_country}) (*this)(*x);
    (*this)(t.fuel_capacity_l);
  }
  void operator()(records::TrailerConfigured& t) {
    if (random() % 4 == 0) t.index = static_cast<std::uint8_t>(random());
    for (auto* x : {&t.id, &t.body_type, &t.chain_type, &t.cargo_accessory_id, &t.brand_id, &t.plate_country_id}) (*this)(*x);
    for (auto* x : {&t.brand, &t.name, &t.license_plate, &t.plate_country}) (*this)(*x);
  }
  void operator()(records::TrailerCleared& t) { if (random() % 4 == 0) t.index = static_cast<std::uint8_t>(random()); }
  void operator()(records::GameTimeRegression& r) { (*this)(r.from); (*this)(r.to); }
  void operator()(records::JobDelivered& d) {
    (*this)(d.revenue); (*this)(d.earned_xp); (*this)(d.cargo_damage); (*this)(d.distance_km); (*this)(d.delivery_duration_min); (*this)(d.auto_park_used); (*this)(d.auto_load_used);
  }
  void operator()(records::JobCancelled& c) { (*this)(c.penalty); }
  void operator()(records::PlayerFined& p) { (*this)(p.offence); (*this)(p.amount); }
  void operator()(records::PlayerTollgatePaid& p) { (*this)(p.amount); }
  void transfer(records::Transfer& t) { (*this)(t.amount); (*this)(t.source_id); (*this)(t.target_id); (*this)(t.source_name); (*this)(t.target_name); }
  void operator()(records::PlayerUseFerry& t) { transfer(t); }
  void operator()(records::PlayerUseTrain& t) { transfer(t); }
  void operator()(records::SourceGameMode& m) { (*this)(m.mode); }
  template<class T> void operator()(T&) {}
  void operator()(OccurrencePod& o) {
    (*this)(o.monotonic_ns); (*this)(o.game_time); (*this)(o.utc_unix_ms); o.simulation = static_cast<SimulationState>(random() % 4);
    if (random() % 4 == 0) o.configuration_revision = random(); if (random() % 4 == 0) o.boundary_order = random();
  }
  void operator()(StatePod& s) {
    for (auto* m : {&s.speed_mps, &s.fuel_l, &s.fuel_capacity_l, &s.engine_rpm, &s.odometer_km, &s.average_consumption_l_per_km, &s.estimated_range_km, &s.navigation_distance_m}) (*this)(*m);
    (*this)(s.gear); (*this)(s.game_time.minutes); (*this)(s.capture_utc_unix_ms); s.simulation = static_cast<SimulationState>(random() % 4);
    s.world_placement.state = state(); for (auto* v : {&s.world_placement.value.x, &s.world_placement.value.heading, &s.world_placement.value.roll}) { Field<double> d; (*this)(d); *v = d.value; }
    s.window.state = state(); s.window.value.handle = random() % 3; s.window.value.x = static_cast<std::int32_t>(random()); s.window.value.dpi = static_cast<std::uint32_t>(random() % 1200);
    s.window.value.display_mode = static_cast<DisplayMode>(random() % 5);
    s.configuration.job.state = state(); (*this)(s.configuration.job.value); s.configuration.truck.state = state(); (*this)(s.configuration.truck.value);
    for (auto& slot : s.configuration.trailers) { slot.state = state(); (*this)(slot.value); }
  }
};

void fuzz_case(const Fixtures& f) {
  // Client corpus: mutated hello, ACK and probe payloads reach the producer only through the contract decoder and
  // AckValidator; an accepted ACK always releases the store within its invariants.
  Harness h; h.open(true); for (unsigned i = 0; i < 4; ++i) h.ingest(h.next_event()); h.lose(2, LossCause::queue_count); h.pump();
  std::vector<std::string> corpus;
  for (const auto& row : rows(read(f.dir / "manifest.txt"))) if (row.size() == 2 && row[1] == "valid-client") corpus.push_back(read(f.dir / row[0]));
  check(corpus.size() >= 8, "client corpus");
  // ETS2TELEMETRY_NATIVE_FUZZ_MULTIPLIER multiplies the three seeded loops below (3,000, 2,000 and 300 rounds on a PR run).
  const unsigned multiplier = ets2telemetry::test::native_fuzz_multiplier();
  std::cout << "fuzzMultiplier=" << multiplier << " clientRounds=" << 3000 * multiplier << " recordRounds=" << 2000 * multiplier << " stateRounds=" << 300 * multiplier << std::endl;
  std::mt19937_64 random(0xC11E47ULL); unsigned decoded = 0, accepted = 0, released = 0;
  for (unsigned round = 0; round < 3000 * multiplier; ++round) {
    auto bytes = corpus[random() % corpus.size()];
    for (auto ops = 1 + random() % 3; ops--;) {
      const auto at = bytes.empty() ? 0 : random() % bytes.size();
      switch (random() % 5) {
        case 0: if (!bytes.empty()) bytes[at] = static_cast<char>(bytes[at] ^ (1 << (random() % 8))); break;
        case 1: if (!bytes.empty()) bytes[at] = "0123456789\"\\{}:,-ae"[random() % 19]; break;
        case 2: if (!bytes.empty()) bytes.erase(at, 1); break;
        case 3: bytes.insert(at, 1, static_cast<char>(random())); break;
        default: bytes.resize(at); break;
      }
    }
    try {
      const auto m = decode_payload(bytes, Sender::client); ++decoded;
      if (m.kind == "hello") negotiate(m);
      else if (m.kind == "ack") {
        AckValidator validator(SESSION, true); validator.checkpoint(h.store.release_point()); validator.sent(6);
        if (const auto through = validator.accept(m)) { ++accepted; const auto point = h.store.release(*through); check(point && *point <= *through, "accepted ACK releases"); ++released; check_store(h.store); }
      }
    } catch (const ProtocolError&) {}
    // The same bytes, framed and split at a random point, through the client-direction decoder.
    FrameDecoder decoder(Sender::client); std::vector<std::uint8_t> frame(4 + bytes.size());
    for (unsigned i = 0; i < 4; ++i) frame[i] = static_cast<std::uint8_t>((bytes.size() >> (8 * i)) & 255);
    std::copy(bytes.begin(), bytes.end(), frame.begin() + 4); const auto split = random() % (frame.size() + 1);
    try { decoder.push(frame.data(), split, [](Message) {}); decoder.push(frame.data() + split, frame.size() - split, [](Message) {}); decoder.end(); } catch (const ProtocolError&) {}
  }
  check(decoded > 0 && accepted > 0 && released == accepted, "mutations reached the validator and the store");
  // Structured ACKs against events 1-4 and the gap record [5, 6]: a fresh validator per message, as on a new connection
  // at the current release point. Hand-written outcome: the release point after each value, or "-" when rejected.
  Harness structured; structured.open(true); for (unsigned i = 0; i < 4; ++i) structured.ingest(structured.next_event()); structured.lose(2, LossCause::offline); structured.pump();
  const std::pair<std::string, std::string> acks[] = {{"0", "0"}, {"01", "-"}, {"-1", "-"}, {"1", "1"}, {"3", "3"}, {"2", "-"}, {"4", "4"}, {"5", "4"},
    {"7", "-"}, {"18446744073709551615", "-"}, {"18446744073709551616", "-"}, {"6", "6"}, {"6", "6"}};
  for (const auto& [value, expected] : acks) {
    const Json wire{Json::Object{{"version", Json{Json::Object{{"major", Json{1.0}}, {"minor", Json{0.0}}}}}, {"kind", Json{std::string("ack")}},
      {"data", Json{Json::Object{{"pluginSessionId", Json{SESSION}}, {"throughEventSeq", Json{value}}}}}}};
    Message ack; ack.wire = wire; AckValidator validator(SESSION, true); validator.checkpoint(structured.store.release_point()); validator.sent(6);
    std::string outcome = "-";
    try { const auto through = validator.accept(ack); outcome = std::to_string(through ? *structured.store.release(*through) : structured.store.release_point()); } catch (const ProtocolError&) {}
    check(outcome == expected, "structured ACK " + value); check_store(structured.store);
  }
  AckValidator foreign(SESSION_2, true); foreign.checkpoint(0); foreign.sent(6);
  Message foreign_ack; foreign_ack.wire = Json{Json::Object{{"version", Json{Json::Object{{"major", Json{1.0}}, {"minor", Json{0.0}}}}}, {"kind", Json{std::string("ack")}},
    {"data", Json{Json::Object{{"pluginSessionId", Json{SESSION}}, {"throughEventSeq", Json{std::string("6")}}}}}}};
  rejects([&] { foreign.accept(foreign_ack); }, "ACK for another plugin session");

  // Producer table: hand-written outcomes for edge readings. "invalid" means the field encodes as unavailable(invalid).
  const Encoder encoder(identity());
  struct Row { const char* name; std::function<void(StatePod&)> change; const char* key; const char* outcome; };
  const Row table[] = {
    {"speed NaN", [](StatePod& s) { s.speed_mps = available_field(std::numeric_limits<double>::quiet_NaN()); }, "speed", "invalid"},
    {"speed 1000.5 m/s", [](StatePod& s) { s.speed_mps = available_field(1000.5); }, "speed", "invalid"},
    {"reverse speed -1000 m/s", [](StatePod& s) { s.speed_mps = available_field(-1000.0); }, "speed", "available"},
    {"gear 101", [](StatePod& s) { s.gear = available_field<std::int32_t>(101); }, "gear", "invalid"},
    {"odometer 1e9 km", [](StatePod& s) { s.odometer_km = available_field(1e9); }, "odometer", "available"},
    {"odometer 1e9 + 1 km", [](StatePod& s) { s.odometer_km = available_field(1e9 + 1); }, "odometer", "invalid"},
    {"consumption infinity", [](StatePod& s) { s.average_consumption_l_per_km = available_field(std::numeric_limits<double>::infinity()); }, "averageConsumption", "invalid"},
    {"window dpi 0", [](StatePod& s) { WindowPod w; w.handle = 1; w.dpi = 0; s.window = available_field(w); }, "window", "invalid"},
    {"window handle 0", [](StatePod& s) { WindowPod w; w.dpi = 96; s.window = available_field(w); }, "window", "invalid"},
    {"heading 1.5", [](StatePod& s) { s.world_placement = available_field(PlacementPod{0, 0, 0, 1.5, 0, 0}); }, "worldPlacement", "invalid"},
    {"position 2e9", [](StatePod& s) { s.world_placement = available_field(PlacementPod{2e9, 0, 0, 0, 0, 0}); }, "worldPlacement", "invalid"},
    {"game time not supported", [](StatePod& s) { s.game_time.minutes.state = FieldState::not_supported; }, "gameTime", "not-supported"},
  };
  for (const auto& row : table) {
    auto s = minimal_state(); row.change(s);
    const auto m = decode(encode(encoder.snapshot(1, 1, s, StatusInfo{})));
    const auto& value = field(field(field(m.wire, "data"), "state"), row.key);
    const auto outcome = value.at("available").boolean() ? std::string("available") : value.at("reason").string();
    check(outcome == row.outcome, std::string("producer table: ") + row.name);
  }
  // Seeded record and state mutation: an event either measures and then encodes within its measurement under every
  // envelope, or becomes encodingFailed coverage; a state with valid clock identities always encodes.
  std::mt19937_64 records_random(0xF022ULL); Mutator mutate{records_random}; unsigned sendable = 0, failed = 0;
  const RecordBody bases[] = {synthetic_job(), records::JobCleared{}, synthetic_truck(), records::TruckCleared{}, synthetic_trailer(), records::TrailerCleared{3},
    records::SimulationPaused{}, records::SimulationStarted{}, records::TimersRestart{}, records::GameTimeRegression{}, records::JobDelivered{}, records::JobCancelled{},
    records::PlayerFined{}, records::PlayerTollgatePaid{}, records::PlayerUseFerry{}, records::PlayerUseTrain{}, records::SourceGameMode{}};
  EventStore sink; sink.connect();
  for (unsigned round = 0; round < 2000 * multiplier; ++round) {
    auto e = make_event(sink.next_event_seq(), bases[round % std::size(bases)], 1000149000000ULL);
    std::visit([&](auto& r) { mutate(r); }, e.record); if (records_random() % 3 == 0) mutate(e.occurred);
    const auto size = encoder.measure_event(e);
    if (size) {
      ++sendable; check(*size <= limits.event_bytes, "measured within the event bound");
      const auto capture = e.occurred.monotonic_ns.available() ? e.occurred.monotonic_ns.value : 0;
      for (const auto redelivered : {false, true}) for (const auto c : {capture, u64_max}) check(encode(encoder.event(1, c, e, redelivered)).size() - 4 <= *size, "encodes within its measurement");
    } else ++failed;
    const auto result = ingest_event(sink, encoder, e, 1000150000000ULL);
    check(result == (size ? Ingest::retained : Ingest::lost_encoding_failed) || (size && result == Ingest::lost_queue_count) || (size && result == Ingest::lost_queue_bytes), "ingestion outcome");
    if (sink.entries() > 200) { const auto through = sink.next_event_seq() - 1; while (sink.next_outbound()) {} sink.release(through); }
    check_store(sink);
  }
  check(sendable > 0 && failed > 0, "both outcomes exercised");
  for (unsigned round = 0; round < 300 * multiplier; ++round) {
    auto s = minimal_state(); mutate(s); s.game_time.clock_id = make_uuid(GAME_CLOCK);
    StoreStatus d; d.next_event_seq = 1 + records_random() % 1000;
    const auto frame = encode(encoder.checkpoint(1, 1, s, StatusInfo{{}, records_random() % 2 != 0, d, {}}));
    check(frame.size() - 4 <= limits.server_frame_bytes, "mutated state encodes");
  }
  auto bad_clock = minimal_state(); bad_clock.game_time.clock_id = Uuid{}; rejects([&] { encode(encoder.snapshot(1, 1, bad_clock, StatusInfo{})); }, "state game clock must be a UUID");
  std::cout << decoded << " decoded client mutations, " << accepted << " accepted ACKs; " << sendable << " sendable and " << failed << " unsendable mutated records; ";
}
}

int main(int argc, char** argv) {
  try {
    check(argc == 3, "arguments: <case> <protocol-v1 fixture directory>");
    const std::string name = argv[1]; const Fixtures f{std::filesystem::path(argv[2])};
    if (name == "store") store_case();
    else if (name == "release") release_case();
    else if (name == "retention") retention_case();
    else if (name == "overflow") overflow_case();
    else if (name == "encoding") encoding_case();
    else if (name == "messages") messages_case(f);
    else if (name == "streams") streams_case();
    else if (name == "randomized") randomized_case();
    else if (name == "fuzz") fuzz_case(f);
    else if (name == "gearbox") gearbox_case(f);
    else throw std::runtime_error("unknown case " + name);
    std::cout << "v1-producer " << name << " passed\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
