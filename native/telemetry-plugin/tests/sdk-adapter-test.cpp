#include "sdk-adapter.hpp"
#include "game-mode-detector.hpp"
#include "protocol-v1-producer.hpp"
#include "protocol-v1-delivery.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <iterator>
#include "protocol-json.hpp"
#include "common/scssdk_telemetry_common_gameplay_events.h"

using namespace ets2telemetry::sdk;
namespace v1 = ets2telemetry::v1;
namespace ets2telemetry::sdk {
struct AdapterTestAccess {
  static std::unique_lock<std::mutex> hold(Adapter& adapter) { return std::unique_lock<std::mutex>(adapter.publication_mutex_); }
  static std::unique_lock<std::mutex> hold_pending(Adapter& adapter) { return std::unique_lock<std::mutex>(adapter.pending_mutex_); }
  static std::unique_lock<std::mutex> hold_v1(Adapter& adapter) { return std::unique_lock<std::mutex>(adapter.v1_mutex_); }
  static bool no_pending(Adapter& adapter) { auto lock = hold_pending(adapter); return adapter.producer_.observation_count == 0; }
  static std::uint64_t order(const Adapter& adapter) { return adapter.producer_.boundary_order; }
  static void exhaust(Adapter& adapter) { adapter.producer_.boundary_order = UINT64_MAX; }
};
}
namespace {
unsigned assertions = 0;
void require(bool condition, const char* message) { ++assertions; if (!condition) throw std::runtime_error(message); }
struct Registration { scs_telemetry_channel_callback_t callback{}; scs_context_t context{}; scs_value_type_t type{}; };
struct Host {
  static Host* current;
  std::map<scs_event_t, std::pair<scs_telemetry_event_callback_t, scs_context_t>> events;
  std::map<std::string, Registration> channels;
  std::thread::id sdk_thread = std::this_thread::get_id();
  unsigned api_calls = 0, wrong_thread = 0, unregister_calls = 0;
  std::string missing, erroneous, unsupported_type;
  scs_result_t erroneous_result = SCS_RESULT_generic_error;
  scs_event_t fail_event = 0, throw_event = 0;
  bool throw_cleanup = false, throw_log = false;
  std::vector<std::pair<scs_log_type_t, std::string>> logs;
  Host() { current = this; }
  static SCSAPI_VOID log(scs_log_type_t type, scs_string_t message) { current->api_call(); if (current->throw_log) throw std::runtime_error("fake logger failure"); current->logs.emplace_back(type, message); }
  void api_call() { ++api_calls; if (std::this_thread::get_id() != sdk_thread) ++wrong_thread; }
  static SCSAPI_RESULT register_event(scs_event_t event_id, scs_telemetry_event_callback_t cb, scs_context_t ctx) {
    current->api_call(); if (current->throw_event == event_id) throw std::runtime_error("fake host registration failure");
    if (current->fail_event == event_id) return SCS_RESULT_generic_error;
    current->events[event_id] = {cb, ctx}; return SCS_RESULT_ok;
  }
  static SCSAPI_RESULT unregister_event(scs_event_t event_id) { current->api_call(); ++current->unregister_calls; current->events.erase(event_id); if (current->throw_cleanup) throw std::runtime_error("fake host cleanup failure"); return SCS_RESULT_ok; }
  static SCSAPI_RESULT register_channel(scs_string_t name, scs_u32_t index, scs_value_type_t type, scs_u32_t flags, scs_telemetry_channel_callback_t cb, scs_context_t ctx) {
    current->api_call(); require(index == SCS_U32_NIL && flags == (SCS_TELEMETRY_CHANNEL_FLAG_each_frame | SCS_TELEMETRY_CHANNEL_FLAG_no_value), "channel unavailable/every-frame registration flags");
    if (name == current->missing) return SCS_RESULT_not_found;
    if (name == current->unsupported_type) return SCS_RESULT_unsupported_type;
    if (name == current->erroneous) return current->erroneous_result;
    current->channels[name] = {cb, ctx, type}; return SCS_RESULT_ok;
  }
  static SCSAPI_RESULT unregister_channel(scs_string_t name, scs_u32_t, scs_value_type_t) { current->api_call(); ++current->unregister_calls; current->channels.erase(name); if (current->throw_cleanup) throw std::runtime_error("fake cleanup failure"); return SCS_RESULT_ok; }
  scs_telemetry_init_params_v100_t params(const char* game = "eut2", unsigned game_version = SCS_MAKE_VERSION(1,20)) {
    scs_telemetry_init_params_v100_t p{}; p.common.game_id = game; p.common.game_version = game_version;
    p.register_for_event = register_event; p.unregister_from_event = unregister_event; p.register_for_channel = register_channel; p.unregister_from_channel = unregister_channel; return p;
  }
  void event(scs_event_t event_id, const void* value = nullptr) { const auto cb = events.at(event_id); cb.first(event_id, value, cb.second); }
  void channel(Field field, const scs_value_t* value) { const auto name = channel_specs()[static_cast<std::size_t>(field)].name; const auto registered = channels.at(name); registered.callback(name, SCS_U32_NIL, value, registered.context); }
  void frame_end() { event(SCS_TELEMETRY_EVENT_frame_end); }
  void config(const char* name, const scs_named_value_t* values) { scs_telemetry_configuration_t config{name, values}; event(SCS_TELEMETRY_EVENT_configuration, &config); }
  void gameplay(const char* name, const scs_named_value_t* values) { scs_telemetry_gameplay_event_t event_info{name, values}; event(SCS_TELEMETRY_EVENT_gameplay, &event_info); }
};
Host* Host::current = nullptr;
scs_value_t floating(float value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_float; v.value_float.value = value; return v; }
scs_value_t text(const char* value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_string; v.value_string.value = value; return v; }
scs_value_t u32(std::uint32_t value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_u32; v.value_u32.value = value; return v; }
scs_value_t u64(std::uint64_t value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_u64; v.value_u64.value = value; return v; }
scs_value_t s64(std::int64_t value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_s64; v.value_s64.value = value; return v; }
scs_named_value_t attribute(const char* name, scs_value_t value, scs_u32_t index = SCS_U32_NIL) { scs_named_value_t v{}; v.name = name; v.index = index; v.value = value; return v; }
std::unique_ptr<Snapshot> read(Adapter& adapter) { auto output = std::make_unique<Snapshot>(); require(adapter.read_latest(*output), "coherent publication available"); return output; }
Reading<double> reading(const Snapshot& snapshot, Field field) { return snapshot.state.channels[static_cast<std::size_t>(field)]; }
Reading<double> reading(const std::unique_ptr<Snapshot>& snapshot, Field field) { return reading(*snapshot, field); }
void game_mode_evidence() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  auto channel = std::make_unique<v1::EventChannel>();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok && channel->prepare(), "mode initialization");
  const auto mode = ets2telemetry::game_mode::detect(v1::GameId::ets2, [](const wchar_t*) noexcept { return ets2telemetry::game_mode::LookupResult::present; });
  adapter->set_game_mode(mode); adapter->attach_events(channel.get());
  auto current = std::make_unique<V1Current>();
  require(adapter->read_v1_current(*current) && current->game_mode.module.view() == "core_ets2mp.dll" && current->state.boundary_order == 0, "attachment immediately publishes mode without a fabricated callback");
  require(channel->next_event_seq() == 1 && !channel->front(), "attachment assigns no mode event or loss");
  host.frame_end(); host.frame_end(); channel->set_gate(v1::Gate::live); host.frame_end();
  require(channel->next_event_seq() == 1 && !channel->front(), "offline and live-only frames leave mode pending without loss");
  host.event(SCS_TELEMETRY_EVENT_started); host.frame_end();
  auto* slot = channel->front();
  require(slot && slot->has_loss && !slot->has_record && slot->loss_before.first_event_seq == 1 && slot->loss_before.last_event_seq == 1 && slot->loss_before.causes.no_durable_consumer == 1, "genuine SDK lifecycle loss is preserved");
  channel->pop(); channel->set_gate(v1::Gate::durable);
  auto minutes = u32(123); host.channel(Field::game_time, &minutes);
  scs_named_value_t empty[]{{}}; host.config("job", empty);
  slot = channel->front(); require(slot && slot->has_record && slot->record.event_seq == 2 && std::holds_alternative<v1::records::JobCleared>(slot->record.record), "SDK configuration precedes source notification"); channel->pop();
  const auto before_order = AdapterTestAccess::order(*adapter);
  std::uint64_t before_ns = 0, after_ns = 0;
  require(adapter->source_monotonic_ns(before_ns), "pre-publication source clock"); host.frame_end();
  require(adapter->source_monotonic_ns(after_ns), "post-publication source clock");
  slot = channel->front(); require(slot && slot->has_record && slot->record.event_seq == 3, "first durable frame publishes one pending mode");
  const auto& record = slot->record;
  require(std::get<v1::records::SourceGameMode>(record.record).mode.module.view() == "core_ets2mp.dll", "cached module evidence");
  require(record.occurred.monotonic_ns.available() && record.occurred.monotonic_ns.value >= before_ns && record.occurred.monotonic_ns.value <= after_ns &&
    record.occurred.utc_unix_ms.available() && record.occurred.boundary_order == before_order + 1 && record.occurred.configuration_revision == 1 &&
    record.occurred.simulation == v1::SimulationState::running && record.occurred.game_time.minutes.available() && record.occurred.game_time.minutes.value == 123, "occurrence uses publishing callback time, order and current state");
  channel->pop(); host.frame_end(); adapter->attach_events(nullptr); adapter->attach_events(channel.get()); host.frame_end();
  require(channel->next_event_seq() == 4 && !channel->front(), "later frames and reattachment do not repeat notification");
  adapter->shutdown(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok && channel->prepare(), "fresh session");
  adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable); host.frame_end();
  require(adapter->read_v1_current(*current) && current->game_mode.mode == v1::GameModeKind::unknown && channel->next_event_seq() == 1 && !channel->front(), "reset clears evidence and unknown is silent");
  adapter->shutdown(); adapter->attach_events(nullptr);
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok && channel->prepare(), "full-ring session");
  adapter->set_game_mode(mode); adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  for (std::size_t i = 0; i < v1::channel_slots; ++i) host.gameplay(SCS_TELEMETRY_GAMEPLAY_EVENT_job_cancelled, empty);
  host.frame_end();
  require(channel->next_event_seq() == v1::channel_slots + 2, "full ring still assigns source notification exactly once");
  for (std::size_t i = 0; i < v1::channel_slots; ++i) {
    slot = channel->front(); require(slot && slot->has_record && !slot->has_loss && slot->record.event_seq == i + 1 && std::holds_alternative<v1::records::JobCancelled>(slot->record.record), "full ring preserves ordered SDK records"); channel->pop();
  }
  host.frame_end(); slot = channel->front();
  require(slot && slot->has_loss && !slot->has_record && slot->loss_before.first_event_seq == v1::channel_slots + 1 && slot->loss_before.last_event_seq == v1::channel_slots + 1 && slot->loss_before.causes.queue_count == 1, "lost source notification has explicit queueCount coverage");
  channel->pop(); host.frame_end();
  require(channel->next_event_seq() == v1::channel_slots + 2 && !channel->front(), "assigned notification loss is never retried");
  adapter->shutdown(); adapter->attach_events(nullptr);
}
void lifecycle() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_MAKE_VERSION(2,0), &params) == SCS_RESULT_unsupported && host.api_calls == 0, "negotiate unsupported API without SDK side effects");
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, nullptr) == SCS_RESULT_invalid_parameter, "null initialization rejected");
  auto wrong_game = host.params("other"); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &wrong_game) == SCS_RESULT_unsupported, "unknown game rejected");
  auto wrong_major = host.params("eut2", SCS_MAKE_VERSION(2,0)); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &wrong_major) == SCS_RESULT_unsupported, "unknown game telemetry major rejected");
  auto invalid = params; invalid.register_for_event = nullptr; require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &invalid) == SCS_RESULT_invalid_parameter, "missing function pointer rejected");
  host.missing = "truck.fuel.range";
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "supported API initializes");
  auto initial = read(*adapter);
  require(initial->active && initial->state.simulation == Simulation::paused && host.events.size() == 6, "initial paused lifecycle and complete events");
  require(reading(initial, Field::range).status == Availability::not_supported && reading(initial, Field::speed).status == Availability::not_observed, "missing capability differs from unobserved supported channel");
  require(std::string(initial->identity.currency.c_str()) == "EUR" && initial->identity.currency_source.status == Availability::available, "EUR primary header source");
  require(initial->identity.plugin_session_id.status == Availability::available && initial->identity.process_id > 0, "owned session and process identity");
  const auto calls = host.api_calls;
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_already_registered && host.api_calls == calls, "repeated init does not orphan callbacks");
  host.event(SCS_TELEMETRY_EVENT_started); auto zero = floating(0); host.channel(Field::speed, &zero); host.frame_end();
  auto live = read(*adapter); require(live->state.simulation == Simulation::running && reading(live, Field::speed).status == Availability::available && reading(live, Field::speed).value == 0, "real zero speed and running state");
  require(live->observation_count == 0 && live->continuity.lost_observations >= 2 && live->continuity.offline_transitions == 1, "app absent has current state and omission counters only");
  auto reverse = floating(-7.5F); host.channel(Field::speed, &reverse); auto liters = floating(20.5F); host.channel(Field::fuel, &liters);
  auto odo = floating(123.25F); host.channel(Field::odometer, &odo); auto consumption = floating(0.25F); host.channel(Field::consumption, &consumption); host.frame_end();
  auto normalized = read(*adapter); require(reading(normalized, Field::speed).value == -7.5 && reading(normalized, Field::fuel).value == 20.5 && reading(normalized, Field::odometer).value == 123250 && reading(normalized, Field::consumption).value == 25, "signed speed/liters/km and L/km conversions");
  auto checkpoint = std::make_unique<Snapshot>(); require(adapter->read_current(*checkpoint) && checkpoint->boundary_order == normalized->boundary_order && checkpoint->observation_count == 0, "current checkpoint remains available after live slot consumed");
  auto remaining = floating(1000); host.channel(Field::navigation_distance, &remaining);
  scs_value_t placement{}; placement.type = SCS_VALUE_TYPE_dplacement; placement.value_dplacement.position = {123.5, -4.0, 99.0}; placement.value_dplacement.orientation = {0.25F, 0.1F, -0.1F}; host.channel(Field::world_placement, &placement); placement.value_dplacement.position.x = 999; host.frame_end();
  auto position = read(*adapter); require(reading(position, Field::navigation_distance).value == 1000 && position->state.world_placement.status == Availability::available && position->state.world_placement.value.position.x == 123.5 && position->state.world_placement.value.orientation.heading == 0.25F, "navigation meters and owned game-world placement/orientation");
  placement.value_dplacement.position.x = NAN; host.channel(Field::world_placement, &placement); host.frame_end(); require(read(*adapter)->state.world_placement.status == Availability::invalid, "nonfinite placement unavailable");
  host.channel(Field::fuel, nullptr); auto nan = floating(NAN); host.channel(Field::speed, &nan); host.frame_end();
  auto invalid_readings = read(*adapter); require(reading(invalid_readings, Field::fuel).status == Availability::not_observed && reading(invalid_readings, Field::speed).status == Availability::invalid, "null/nonfinite do not manufacture zero");
  auto wrong_type = u32(1); host.channel(Field::rpm, &wrong_type); auto negative_fuel = floating(-1); host.channel(Field::fuel, &negative_fuel); host.frame_end();
  auto invalid_bounds = read(*adapter); require(reading(invalid_bounds, Field::rpm).status == Availability::invalid && reading(invalid_bounds, Field::fuel).status == Availability::invalid, "wrong scalar type/range rejected");
  const auto sdk_calls_before_worker = host.api_calls;
  std::thread consumer([&] { Snapshot output; adapter->set_consumer(true, true); adapter->read_latest(output); }); consumer.join();
  require(host.api_calls == sdk_calls_before_worker && host.wrong_thread == 0, "worker cache/gating never invokes SDK");
  adapter->shutdown(); auto stopped = read(*adapter);
  require(!stopped->active && stopped->source_retired && stopped->state.simulation == Simulation::unavailable && host.channels.empty() && host.events.empty(), "shutdown unregisters and invalidates active lifecycle");
  const auto cleaned = host.unregister_calls; adapter->shutdown(); require(cleaned == host.unregister_calls, "shutdown idempotent");
  host.missing.clear(); params = host.params("ats", SCS_MAKE_VERSION(1,7));
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_00, &params) == SCS_RESULT_ok, "API 1.00 fallback"); auto reinit = read(*adapter);
  require(std::string(initial->identity.plugin_session_id.c_str()) != reinit->identity.plugin_session_id.c_str() && std::string(initial->identity.process_instance_id.c_str()) == reinit->identity.process_instance_id.c_str(), "plugin session rotates/process lifetime survives reinit");
  require(std::string(reinit->identity.currency.c_str()) == "USD" && reinit->gameplay_result == SCS_RESULT_unsupported && !host.events.count(SCS_TELEMETRY_EVENT_gameplay), "ATS currency source/API100 gameplay unavailable");
  require(reinit->boundary_order == 0 && reinit->continuity.lost_observations == 0 && reading(reinit, Field::speed).status == Availability::not_observed, "reinit has clean state/counters/order");
  adapter->shutdown();
}
void config_terminal_and_bounds() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "config fixture init"); read(*adapter); adapter->set_consumer(true, true);
  char truck_id[] = "truck.model.a"; char city[] = "city.alpha";
  scs_named_value_t truck[]{attribute("id", text(truck_id)), attribute("fuel.capacity", floating(800)), {}};
  scs_named_value_t job[]{attribute("cargo.id", text("cargo.a")), attribute("destination.city.id", text(city)), attribute("income", u64(UINT64_MAX)), attribute("planned_distance.km", u32(700)), {}};
  host.config("truck", truck); host.config("job", job); truck_id[0] = 'X'; city[0] = 'X'; host.frame_end(); auto configured = read(*adapter);
  require(std::string(configured->state.truck_id.c_str()) == "truck.model.a" && std::string(configured->state.job.destination_city_id.c_str()) == "city.alpha", "callback strings are deeply owned");
  require(configured->state.configuration_revision == 2 && configured->state.fuel_capacity_l.value == 800 && configured->state.job.planned_distance_m.value == 700000 && configured->state.job.expected_income.value == UINT64_MAX, "config types/units/u64 exactness");
  require(configured->observations[1].value.string.c_str() == std::string("truck.model.a"), "diagnostic string deep copy");
  // Indexed wheel values do not hide later scalar fields in a normal larger truck config.
  std::vector<scs_named_value_t> large_truck(180, attribute("wheel.radius", floating(0.5F), 0));
  large_truck[175] = attribute("id", text("truck.after.wheels")); large_truck[178] = attribute("fuel.capacity", floating(1000)); large_truck.back() = {};
  host.config("truck", large_truck.data()); host.frame_end(); auto large_config = read(*adapter);
  require(std::string(large_config->state.truck_id.c_str()) == "truck.after.wheels" && large_config->state.fuel_capacity_l.value == 1000 && large_config->observation_count == max_observations, "large indexed truck configuration bounded scan retains scalar fields");
  char source_name[] = "Terminal payload";
  scs_named_value_t terminal[]{attribute("revenue", s64(INT64_MIN)), attribute("source.name", text(source_name)), attribute("distance.km", floating(42.5F)), {}};
  host.gameplay("job.delivered", terminal); source_name[0] = 'X'; scs_named_value_t empty[]{{}}; host.config("job", empty); host.config("truck", empty); host.frame_end(); auto cleared = read(*adapter);
  require(cleared->state.job.status == Availability::not_observed && cleared->state.truck_id.status == Availability::not_observed, "configuration clear is current state, never a fabricated delivery");
  require(cleared->observation_count == 6 && std::string(cleared->observations[0].group.c_str()) == "job.delivered" && cleared->observations[1].value.signed_integer == INT64_MIN && std::string(cleared->observations[2].value.string.c_str()) == "Terminal payload", "terminal payload survives later job/truck clear with exact s64");
  require(cleared->observations[0].callback_order < cleared->observations[4].callback_order && cleared->observations[4].callback_order < cleared->boundary_order, "event/config callback ordering preserved");
  host.config("job", empty); host.gameplay("job.cancelled", terminal); host.frame_end(); auto late = read(*adapter);
  require(std::string(late->observations[1].group.c_str()) == "job.cancelled" && late->observations[2].value.signed_integer == INT64_MIN, "clear-before-terminal keeps explicit cancellation payload");
  std::string too_long(1025, 'a'); scs_named_value_t strings[]{attribute("long", text(too_long.c_str())), attribute("unicode", text("\xc3\xa9")), attribute("invalid", text("\xc0\x80")), {}};
  host.gameplay("test.strings", strings); host.frame_end(); auto bounded = read(*adapter);
  require(bounded->observations[1].value.status == Availability::invalid && bounded->observations[2].value.status == Availability::available && bounded->observations[3].value.status == Availability::invalid, "bounded valid UTF8/truncation/overlong rejection");
  std::array<scs_named_value_t, max_attributes> excessive{};
  for (auto& value : excessive) value = attribute("x", u32(1));
  const auto prior_loss = bounded->continuity.lost_observations;
  host.config("job", excessive.data()); host.frame_end(); auto overflow = read(*adapter);
  require(overflow->observation_count == max_observations && overflow->state.job.status == Availability::invalid && overflow->continuity.lost_observations > prior_loss, "unterminated bounded array rejected/counts unknown tail and full batch");
  host.gameplay("job.delivered", terminal); host.frame_end();
  host.gameplay("job.cancelled", terminal); host.frame_end(); auto replaced = read(*adapter);
  require(std::string(replaced->observations[0].group.c_str()) == "job.cancelled" && replaced->continuity.coalesced_snapshots >= 1 && replaced->continuity.lost_observations >= overflow->continuity.lost_observations + 4, "one ready batch replaces stalled-reader payload with explicit loss");
  host.gameplay("job.delivered", terminal); host.frame_end(); adapter->set_consumer(false, false); auto disconnected = read(*adapter);
  require(disconnected->observation_count == 0, "disconnect erases ready payload");
  host.gameplay("job.cancelled", terminal); host.frame_end(); auto offline = read(*adapter);
  require(offline->observation_count == 0 && offline->continuity.lost_observations >= disconnected->continuity.lost_observations + 8, "disabled/offline and erased ready payload omissions counted");
  adapter->set_consumer(true, true); host.gameplay("job.delivered", terminal);
  std::thread disconnect([&] { adapter->set_consumer(false, false); }); disconnect.join();
  require(AdapterTestAccess::no_pending(*adapter), "disconnect synchronously removes pending callback payload before frame end");
  host.frame_end(); auto after_disconnect = read(*adapter); require(after_disconnect->observation_count == 0 && after_disconnect->continuity.lost_observations >= offline->continuity.lost_observations + 4, "pending disconnect omissions counted at next coherent boundary");
  adapter->shutdown();
}
void clocks_and_contention() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params(); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "clock fixture init"); auto initial = read(*adapter);
  auto time = u32(500); host.channel(Field::game_time, &time); auto speed = floating(5); host.channel(Field::speed, &speed); host.frame_end(); auto timed = read(*adapter);
  require(timed->state.game_time_minutes.value == 500 && timed->state.game_time_minutes.status == Availability::available, "game minutes exact");
  time = u32(100); host.channel(Field::game_time, &time); host.frame_end(); auto regressed = read(*adapter);
  require(regressed->state.game_time_minutes.value == 100 && std::string(regressed->state.game_clock_id.c_str()) != timed->state.game_clock_id.c_str() && reading(regressed, Field::speed).status == Availability::not_observed, "time regression rotates clock/invalidate ambiguous previous readings");
  scs_telemetry_frame_start_t frame{}; frame.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); auto restarted = read(*adapter);
  require(std::string(restarted->state.game_clock_id.c_str()) != regressed->state.game_clock_id.c_str() && restarted->state.game_time_minutes.status == Availability::not_observed, "SDK timer restart boundary");
  frame.flags = 0; frame.render_time = frame.simulation_time = frame.paused_simulation_time = 50; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); auto before_reset = read(*adapter);
  frame.render_time = frame.simulation_time = frame.paused_simulation_time = 1; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); auto implicit = read(*adapter);
  require(std::string(implicit->state.game_clock_id.c_str()) != before_reset->state.game_clock_id.c_str(), "unflagged frame timestamp regression rotates game clock");
  host.channel(Field::speed, &speed); host.frame_end(); auto coherent = read(*adapter);
  std::promise<void> held, release; auto release_signal = release.get_future();
  std::thread blocked_consumer([&] { auto lock = AdapterTestAccess::hold(*adapter); held.set_value(); release_signal.wait(); }); held.get_future().wait();
  adapter->set_consumer(true, true); speed = floating(9); host.channel(Field::speed, &speed); host.frame_end();
  release.set_value(); blocked_consumer.join();
  Snapshot skipped; require(!adapter->read_latest(skipped), "contended publication does not replace complete consumed boundary");
  host.frame_end(); auto recovered = read(*adapter);
  require(reading(recovered, Field::speed).value == 9 && recovered->continuity.coalesced_snapshots == coherent->continuity.coalesced_snapshots + 1 && recovered->continuity.lost_observations == coherent->continuity.lost_observations + 1 && recovered->observation_count == 0, "contention preserves latest producer state and explicit frame diagnostic loss");
  require(recovered->boundary_order > coherent->boundary_order && recovered->capture_monotonic_ns >= initial->capture_monotonic_ns, "session callback order/real clock never regress");
  std::promise<void> pending_held, pending_release; auto pending_signal = pending_release.get_future();
  std::thread pending_reader([&] { auto lock = AdapterTestAccess::hold_pending(*adapter); pending_held.set_value(); pending_signal.wait(); }); pending_held.get_future().wait();
  speed = floating(10); host.channel(Field::speed, &speed); host.frame_end(); pending_release.set_value(); pending_reader.join();
  host.frame_end(); auto pending_recovered = read(*adapter);
  require(reading(pending_recovered, Field::speed).value == 10 && pending_recovered->continuity.coalesced_snapshots == recovered->continuity.coalesced_snapshots + 1 && pending_recovered->continuity.lost_observations == recovered->continuity.lost_observations + 1, "pending-discard lock cannot block current callback copying and publication retries");
  // Sustained bounded callback/cache exercise runs in ASan too. Values always share one frame boundary.
  std::atomic<bool> finished{false}; std::atomic<bool> mismatch{false};
  std::thread reader([&] { auto output = std::make_unique<Snapshot>(); while (!finished.load()) if (adapter->read_latest(*output)) { auto s = reading(*output, Field::speed); auto f = reading(*output, Field::fuel); if (s.status == Availability::available && f.status == Availability::available && s.value != f.value) mismatch.store(true); } });
  for (unsigned i = 0; i < 10000; ++i) { auto v = floating(static_cast<float>(i % 100)); host.channel(Field::speed, &v); host.channel(Field::fuel, &v); host.frame_end(); }
  finished.store(true); reader.join(); host.frame_end(); auto sustained = read(*adapter);
  require(!mismatch.load() && sustained->observation_count <= max_observations && host.wrong_thread == 0, "concurrent reader sees coherent pairs under sustained bounded input");
  // A final shutdown publication can be skipped by contention; the separate lifetime fence retires old state.
  host.frame_end();
  std::promise<void> shutdown_held, shutdown_release; auto shutdown_signal = shutdown_release.get_future();
  std::thread shutdown_reader([&] { auto lock = AdapterTestAccess::hold(*adapter); shutdown_held.set_value(); shutdown_signal.wait(); }); shutdown_held.get_future().wait();
  adapter->shutdown(); shutdown_release.set_value(); shutdown_reader.join(); auto retired = read(*adapter);
  require(retired->source_retired && retired->observation_count == 0, "contended final shutdown boundary cannot expose cached state as current source");
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "reinit after contended shutdown"); read(*adapter);
  AdapterTestAccess::exhaust(*adapter); host.channel(Field::speed, &speed); adapter->shutdown(); auto exhausted = read(*adapter);
  require(exhausted->exhausted && !exhausted->active && exhausted->boundary_order == UINT64_MAX, "callback order never wraps");
}
void failure_cleanup() {
  for (bool throwing : {false, true}) {
    auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
    if (throwing) host.throw_event = SCS_TELEMETRY_EVENT_configuration; else host.fail_event = SCS_TELEMETRY_EVENT_configuration;
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_generic_error, "failed/throwing registration contained");
    require(host.events.empty() && host.channels.empty() && host.unregister_calls == 4, "partial registration cleanup removes all prior registrations");
    host.throw_event = 0; host.fail_event = 0;
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "failed init allows retry");
    host.throw_cleanup = true; adapter->shutdown(); auto stopped = read(*adapter);
    require(host.events.empty() && host.channels.empty() && stopped->continuity.callback_failures == 17, "throwing unregister isolates all cleanup operations"); // 11 channels (ET-052 adds the break channel) and 6 events
  }
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params(); host.erroneous = "truck.engine.rpm";
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_generic_error && host.channels.empty() && host.events.empty(), "unexpected channel registration errors fail closed");
}
void deferred_log() {
  static const DeferredLog first{SCS_LOG_TYPE_warning, "first"}, second{SCS_LOG_TYPE_error, "second"};
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params(); params.common.log = Host::log;
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "deferred log fixture init");
  host.frame_end(); require(host.logs.empty(), "no entry, no log");
  // A worker thread hands entries over; the latest unlogged one replaces an earlier one.
  std::thread([&] { adapter->defer_log(&first); adapter->defer_log(&second); }).join();
  scs_telemetry_frame_start_t frame{}; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); require(host.logs.empty(), "only frame_end logs a deferred entry");
  host.frame_end(); host.frame_end();
  require(host.logs.size() == 1 && host.logs[0].first == SCS_LOG_TYPE_error && host.logs[0].second == "second" && host.wrong_thread == 0, "latest entry logged once on the SDK thread");
  adapter->defer_log(&first); adapter->shutdown();
  require(host.logs.size() == 2 && host.logs[1].second == "first", "explicit shutdown logs a waiting entry");
  adapter->defer_log(&second); require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "deferred log fixture reinit");
  host.frame_end(); require(host.logs.size() == 2, "initialization discards an entry from an earlier session");
  // Control delta: two frame boundaries without a logger failure.
  host.frame_end(); const auto base = read(*adapter); host.frame_end(); host.frame_end(); const auto control = read(*adapter);
  host.throw_log = true; adapter->defer_log(&first); host.frame_end(); host.frame_end(); const auto thrown = read(*adapter); host.throw_log = false;
  require(thrown->continuity.callback_failures == control->continuity.callback_failures + 1 && control->continuity.callback_failures == base->continuity.callback_failures, "throwing game logger counted as one callback failure");
  require(thrown->continuity.lost_observations - control->continuity.lost_observations == control->continuity.lost_observations - base->continuity.lost_observations, "throwing game logger fabricates no lost observation");
  host.frame_end(); require(host.logs.size() == 2, "a failed entry is not retried");
  // The v0 transport and the protocol v1 endpoint have separate slots: entries that both arrive before one frame_end
  // are both logged, in slot order, and neither replaces the other.
  std::thread([&] { adapter->defer_log(&second, DeferredLogSlot::transport_v1); adapter->defer_log(&first); }).join();
  host.frame_end();
  require(host.logs.size() == 4 && host.logs[2].second == "first" && host.logs[3].second == "second" && host.wrong_thread == 0, "both slots logged once, in slot order");
  adapter->shutdown();
}
void missing_game_time_reset() {
  auto adapter = std::make_unique<Adapter>(); Host host; host.missing = "game.time"; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "missing game-time reset init"); auto initial = read(*adapter);
  require(initial->state.game_time_minutes.status == Availability::not_supported, "missing game-time capability before restart");
  scs_telemetry_frame_start_t frame{}; frame.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart;
  host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); auto reset = read(*adapter);
  require(reset->state.game_time_minutes.status == Availability::not_supported && reading(reset, Field::game_time).status == Availability::not_supported, "missing game-time typed/scalar capability survives timer restart");
  frame.flags = 0; frame.render_time = frame.simulation_time = 100; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); read(*adapter);
  frame.render_time = frame.simulation_time = 1; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end(); auto implicit = read(*adapter);
  require(implicit->state.game_time_minutes.status == Availability::not_supported && reading(implicit, Field::game_time).status == Availability::not_supported, "missing game-time capability survives unflagged frame regression");
  adapter->shutdown();
}
void game_time_reset_callback_orders() {
  std::array<Field, 4> order{{Field::speed, Field::fuel, Field::game_time, Field::world_placement}};
  do {
    auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "frame-order reset init"); read(*adapter);
    scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = 10;
    host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
    auto old_time = u32(500), old_speed = floating(5), old_fuel = floating(20), old_rpm = floating(1200);
    scs_value_t old_placement{}; old_placement.type = SCS_VALUE_TYPE_dplacement; old_placement.value_dplacement.position = {1,2,3};
    host.channel(Field::game_time, &old_time); host.channel(Field::speed, &old_speed); host.channel(Field::fuel, &old_fuel); host.channel(Field::rpm, &old_rpm); host.channel(Field::world_placement, &old_placement); host.frame_end(); auto previous = read(*adapter);
    frame.render_time = frame.simulation_time = 20; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
    auto time = u32(100), speed = floating(9), fuel = floating(30);
    scs_value_t placement{}; placement.type = SCS_VALUE_TYPE_dplacement; placement.value_dplacement.position = {10,20,30};
    for (auto field : order) {
      const auto* value = field == Field::speed ? &speed : field == Field::fuel ? &fuel : field == Field::game_time ? &time : &placement;
      host.channel(field, value);
    }
    host.frame_end(); auto current = read(*adapter);
    require(reading(current, Field::speed).status == Availability::available && reading(current, Field::speed).value == 9, "current-frame speed survives late game-time regression");
    require(reading(current, Field::fuel).status == Availability::available && reading(current, Field::fuel).value == 30, "current-frame fuel survives late game-time regression");
    require(current->state.world_placement.status == Availability::available && current->state.world_placement.value.position.x == 10, "current-frame placement survives late game-time regression");
    require(current->state.game_time_minutes.status == Availability::available && current->state.game_time_minutes.value == 100 && std::string(current->state.game_clock_id.c_str()) != previous->state.game_clock_id.c_str(), "same frame regressed time keeps new observation and rotates clock");
    require(reading(current, Field::rpm).status == Availability::not_observed, "regression still clears unobserved previous-frame RPM");
    // The next actual frame observes only the regressed clock: previous frame's fresh values are now stale.
    frame.render_time = frame.simulation_time = 30; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); time = u32(50); host.channel(Field::game_time, &time); host.frame_end(); auto next = read(*adapter);
    require(reading(next, Field::speed).status == Availability::not_observed && reading(next, Field::fuel).status == Availability::not_observed && next->state.world_placement.status == Availability::not_observed, "freshness expires across explicit frame boundaries");
    adapter->shutdown();
  } while (std::next_permutation(order.begin(), order.end()));
}
void game_time_reset_frame_delimitation() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "frame-delimitation reset init"); read(*adapter);
  scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = 10; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
  auto time = u32(500), speed = floating(5), fuel = floating(20);
  scs_value_t placement{}; placement.type = SCS_VALUE_TYPE_dplacement; placement.value_dplacement.position = {1,2,3};
  host.channel(Field::game_time, &time); host.channel(Field::speed, &speed); host.channel(Field::fuel, &fuel); host.channel(Field::world_placement, &placement); host.frame_end(); read(*adapter);
  // These callbacks happen outside a delimited frame. A subsequent start cannot adopt them as fresh.
  speed = floating(9); fuel = floating(30); placement.value_dplacement.position.x = 10;
  host.channel(Field::speed, &speed); host.channel(Field::fuel, &fuel); host.channel(Field::world_placement, &placement);
  frame.render_time = frame.simulation_time = 20; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); time = u32(100); host.channel(Field::game_time, &time); host.frame_end(); auto outside = read(*adapter);
  require(reading(outside, Field::speed).status == Availability::not_observed && reading(outside, Field::fuel).status == Availability::not_observed && outside->state.world_placement.status == Availability::not_observed, "frame start cannot adopt preceding callbacks as current-frame readings");
  host.event(SCS_TELEMETRY_EVENT_frame_start, nullptr);
  host.channel(Field::speed, &speed); host.channel(Field::fuel, &fuel); host.channel(Field::world_placement, &placement); time = u32(50); host.channel(Field::game_time, &time); host.frame_end(); auto invalid_frame = read(*adapter);
  require(reading(invalid_frame, Field::speed).status == Availability::not_observed && reading(invalid_frame, Field::fuel).status == Availability::not_observed && invalid_frame->state.world_placement.status == Availability::not_observed, "invalid frame-start payload cannot establish current-frame freshness");
  frame.render_time = frame.simulation_time = 30; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
  host.channel(Field::speed, nullptr); fuel = floating(NAN); host.channel(Field::fuel, &fuel); placement.value_dplacement.position.x = NAN; host.channel(Field::world_placement, &placement);
  time = u32(25); host.channel(Field::game_time, &time); host.frame_end(); auto unavailable = read(*adapter);
  require(reading(unavailable, Field::speed).status == Availability::not_observed && reading(unavailable, Field::fuel).status == Availability::invalid && unavailable->state.world_placement.status == Availability::invalid, "current-frame unavailable/invalid observations retain their meanings after time reset");
  adapter->shutdown();
}

// Protocol v1 callback capture (ET-004b). The test plays the v1 transport worker: it prepares and attaches the event
// channel, sets its gate and drains it. Expected values are written by hand from docs/protocol/v1.md §6-§9 and
// docs/native-transport-v1.md; captured records are checked through the ET-002b contract encoder and decoder.
scs_value_t boolean(bool value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_bool; v.value_bool.value = value ? 1 : 0; return v; }
scs_value_t s32(std::int32_t value) { scs_value_t v{}; v.type = SCS_VALUE_TYPE_s32; v.value_s32.value = value; return v; }
std::unique_ptr<V1Current> v1_read(Adapter& adapter) { auto output = std::make_unique<V1Current>(); require(adapter.read_v1_current(*output), "v1 slot available"); return output; }
std::string type_of(const v1::EventRecord& record) { return v1::record_type(record); }
bool same_clock(const v1::Uuid& a, const v1::Uuid& b) { return std::memcmp(a.text, b.text, sizeof a.text) == 0; }
// The worker's view of the ring: coverage contiguous from `next`, each loss run before the record that closed it.
struct V1Ring {
  std::uint64_t next = 1; v1::LossCounts lost; std::vector<v1::EventRecord> records;
  std::vector<v1::EventRecord> drain(v1::EventChannel& channel) {
    std::vector<v1::EventRecord> fresh;
    while (const auto* slot = channel.front()) {
      if (slot->has_loss) {
        const auto& run = slot->loss_before;
        require(run.first_event_seq == next && run.last_event_seq >= run.first_event_seq, "v1 loss run contiguous");
        lost.offline += run.causes.offline; lost.no_durable_consumer += run.causes.no_durable_consumer; lost.queue_count += run.causes.queue_count; next = run.last_event_seq + 1;
      }
      if (slot->has_record) { require(slot->record.event_seq == next, "v1 record contiguous"); fresh.push_back(slot->record); ++next; }
      channel.pop();
    }
    records.insert(records.end(), fresh.begin(), fresh.end()); return fresh;
  }
};
v1::SessionIdentity v1_identity(const V1Current& current) {
  const auto& id = current.identity; v1::SessionIdentity output;
  output.source.game = std::string(id.game.c_str()) == "ats" ? v1::GameId::ats : v1::GameId::ets2;
  output.source.plugin_session_id = v1::make_uuid(id.plugin_session_id.c_str()); output.source.process_instance_id = v1::make_uuid(id.process_instance_id.c_str());
  output.source.process_id = id.process_id; output.source.windows_session_id = id.windows_session_id; output.source.origin = v1::Origin::synthetic;
  output.capture_clock_id = v1::make_uuid(id.capture_clock_id.c_str());
  output.currency = v1::Currency{v1::Currency::Status::sdk_documented, id.currency.c_str(), id.currency_source.c_str()};
  return output;
}
v1::Message v1_decode(const std::vector<std::uint8_t>& frame) { return v1::decode_payload(std::string(frame.begin() + 4, frame.end()), v1::Sender::server); }
// The wire record of one captured event. Encoding validates every field against the contract (§6, §8, D12).
v1::Json v1_record(const v1::Encoder& encoder, const v1::EventRecord& record) { return v1_decode(v1::encode(encoder.event(1, UINT64_MAX, record, false))).wire.at("data").at("record"); }
bool v1_available(const v1::Json& value) { return value.at("available").boolean(); }
std::string v1_reason(const v1::Json& value) { return v1_available(value) ? std::string() : value.at("reason").string(); }
std::string v1_text(const v1::Json& value) { return value.at("value").string(); }
double v1_number(const v1::Json& value) { return value.at("value").number(); }
std::string v1_raw(const v1::Json& money) { return money.at("value").at("raw").string(); }

void v1_capture_records() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "v1 capture init"); read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
  adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  const v1::Encoder encoder(v1_identity(*v1_read(*adapter))); V1Ring ring;
  scs_named_value_t empty[]{{}};
  scs_named_value_t job[]{attribute("source.city.id", text("synthetic_city_a")), attribute("source.city", text("Synthetic City A")),
    attribute("source.company.id", text("synthetic_company_a")), attribute("source.company", text("Synthetic Company A")),
    attribute("destination.city.id", text("synthetic_city_b")), attribute("destination.city", text("Synthetic City B")),
    attribute("destination.company.id", text("synthetic_company_b")), attribute("destination.company", text("Synthetic Company B")),
    attribute("cargo.id", text("synthetic_cargo")), attribute("cargo", text("")), attribute("cargo.mass", floating(18000)), attribute("cargo.unit.mass", floating(1000)),
    attribute("cargo.unit.count", u32(18)), attribute("job.market", text("freight_market")), attribute("is.special.job", boolean(false)), attribute("cargo.loaded", boolean(true)),
    attribute("planned_distance.km", u32(700)), attribute("income", u64(UINT64_MAX)), attribute("delivery.time", u32(13000)), attribute("wheel.radius", floating(0.5F), 0), {}};
  // D13: one job.configured per callback, including an identical re-send, each with its own v1 revision.
  host.config("job", job); host.config("job", job); host.frame_end();
  const auto jobs = ring.drain(*channel);
  require(jobs.size() == 2 && jobs[0].event_seq == 1 && jobs[1].event_seq == 2 && type_of(jobs[0]) == "job.configured" && type_of(jobs[1]) == "job.configured", "D13: an identical job re-send is a second job.configured");
  require(jobs[0].occurred.configuration_revision == 1 && jobs[1].occurred.configuration_revision == 2 && jobs[0].occurred.boundary_order < jobs[1].occurred.boundary_order, "v1 revision and callback order per configuration");
  const auto configured = v1_record(encoder, jobs[0]);
  require(v1_number(configured.at("plannedDistance")) == 700000 && configured.at("plannedDistance").at("unit").string() == "m", "planned_distance.km x 1,000 on the wire");
  const auto& income = configured.at("expectedIncome");
  require(v1_raw(income) == "18446744073709551615" && income.at("value").at("sdkType").string() == "u64" && income.at("value").at("currency").at("code").string() == "EUR", "u64 income exact with the documented currency");
  require(v1_available(configured.at("cargo")) && v1_text(configured.at("cargo")).empty() && v1_text(configured.at("sourceCity")) == "Synthetic City A" && v1_text(configured.at("destinationCompanyId")) == "synthetic_company_b", "D12: a provided empty name stays available");
  require(v1_number(configured.at("cargoUnitCount")) == 18 && v1_number(configured.at("cargoMass")) == 18000 && !configured.at("isSpecialJob").at("value").boolean() && configured.at("cargoLoaded").at("value").boolean() && v1_text(configured.at("deliveryDeadline")) == "13000", "job value types");
  const auto occurred = v1_decode(v1::encode(encoder.event(1, UINT64_MAX, jobs[0], false))).wire.at("data").at("occurred");
  require(occurred.at("simulation").string() == "paused" && v1_available(occurred.at("monotonicNs")) && std::stoull(v1_text(occurred.at("utcUnixMs"))) > 1600000000000ULL, "occurrence: simulation, source clock and UTC label");
  host.config("job", empty); auto cleared = ring.drain(*channel);
  require(cleared.size() == 1 && type_of(cleared[0]) == "job.cleared" && cleared[0].occurred.configuration_revision == 3, "an empty job configuration is job.cleared");
  // A null list is a present configuration whose fields were not seen; an unterminated list keeps what was seen.
  host.config("job", nullptr); auto unseen = ring.drain(*channel);
  require(unseen.size() == 1 && type_of(unseen[0]) == "job.configured", "a null job list is still a configuration");
  const auto& unseen_job = std::get<v1::records::JobConfigured>(unseen[0].record);
  require(unseen_job.cargo_id.state == v1::FieldState::invalid && unseen_job.planned_distance_km.state == v1::FieldState::invalid && unseen_job.expected_income.state == v1::FieldState::invalid, "null list: every field invalid");
  std::array<scs_named_value_t, max_attributes> unterminated{};
  for (auto& value : unterminated) value = attribute("x", u32(1));
  unterminated[0] = attribute("cargo.id", text("seen_cargo"));
  host.config("job", unterminated.data()); auto partial = ring.drain(*channel);
  const auto& partial_job = std::get<v1::records::JobConfigured>(partial.at(0).record);
  require(partial_job.cargo_id.state == v1::FieldState::available && partial_job.cargo_id.view() == "seen_cargo" && partial_job.source_city_id.state == v1::FieldState::invalid && partial_job.delivery_deadline_min.state == v1::FieldState::invalid, "unterminated list: seen fields kept, unseen fields invalid");
  // D12 text: never truncated; wrong types, null strings and invalid UTF-8 are invalid.
  const std::string long_id(129, 'a'), name_limit(256, 'n'), long_name(257, 'p');
  scs_named_value_t truck[]{attribute("brand_id", text(long_id.c_str())), attribute("brand", text("Synthetic Brand")), attribute("id", u32(7)), attribute("name", text(name_limit.c_str())),
    attribute("fuel.capacity", floating(800)), attribute("license.plate", text(long_name.c_str())), attribute("license.plate.country.id", text(nullptr)), attribute("license.plate.country", text("\xc0\x80")), {}};
  host.config("truck", truck); const auto trucks = ring.drain(*channel); const auto t = v1_record(encoder, trucks.at(0));
  require(v1_reason(t.at("brandId")) == "invalid" && v1_reason(t.at("licensePlate")) == "invalid", "D12: oversized text is invalid, never truncated");
  require(v1_text(t.at("name")).size() == 256 && v1_text(t.at("brand")) == "Synthetic Brand", "a 256-byte name fits");
  require(v1_reason(t.at("id")) == "invalid" && v1_reason(t.at("plateCountryId")) == "invalid" && v1_reason(t.at("plateCountry")) == "invalid", "wrong type, null string and invalid UTF-8 are invalid");
  require(v1_number(t.at("fuelCapacity")) == 800 && t.at("fuelCapacity").at("unit").string() == "L", "truck fuel capacity in L");
  host.config("truck", empty); auto truck_cleared = ring.drain(*channel);
  require(truck_cleared.size() == 1 && type_of(truck_cleared[0]) == "truck.cleared", "an empty truck configuration is truck.cleared");
  // Trailer slots (D13): legacy and unknown ids, an empty slot that was already empty, bus and car jobs emit nothing.
  scs_named_value_t trailer[]{attribute("id", text("trailer.synthetic_box")), attribute("body.type", text("dryvan")), attribute("chain.type", text("single")), attribute("cargo.accessory.id", text("")),
    attribute("brand_id", text("synthetic_brand")), attribute("brand", text("Synthetic Brand")), attribute("name", text("Synthetic Trailer")), attribute("license.plate", text("SYN 0002")),
    attribute("license.plate.country.id", text("synthetica")), attribute("license.plate.country", text("Synthetica")), attribute("wheel.radius", floating(0.5F), 0), {}};
  const auto before_unmapped = channel->next_event_seq();
  host.config("trailer", trailer); host.config("trailer.1", empty); host.config("trailer.10", trailer); host.config("trailer.01", trailer); host.config("trailer.", trailer);
  host.config("bus_job", job); host.config("car_job", job); host.config("substances", trailer);
  require(channel->next_event_seq() == before_unmapped && ring.drain(*channel).empty(), "legacy and unknown trailer ids, an empty-after-empty slot, bus and car jobs: no record and no eventSeq");
  host.config("trailer.0", trailer); host.config("trailer.0", empty); host.config("trailer.0", empty); host.config("trailer.9", trailer);
  const auto trailers = ring.drain(*channel);
  require(trailers.size() == 3 && type_of(trailers[0]) == "trailer.configured" && std::get<v1::records::TrailerConfigured>(trailers[0].record).index == 0, "a non-empty trailer slot");
  require(type_of(trailers[1]) == "trailer.cleared" && std::get<v1::records::TrailerCleared>(trailers[1].record).index == 0 && std::get<v1::records::TrailerConfigured>(trailers[2].record).index == 9, "a clear after a non-empty slot, then slot 9");
  const auto trailer_wire = v1_record(encoder, trailers[2]);
  require(trailer_wire.at("index").number() == 9 && v1_text(trailer_wire.at("bodyType")) == "dryvan" && v1_available(trailer_wire.at("cargoAccessoryId")) && v1_text(trailer_wire.at("cargoAccessoryId")).empty(), "trailer fields and slot index");
  host.frame_end(); const auto current = v1_read(*adapter); const auto& configuration = current->state.configuration;
  require(configuration.revision == trailers[2].occurred.configuration_revision && configuration.job.available() && configuration.job.value.cargo_id.view() == "seen_cargo" && !configuration.truck.available(), "current configuration follows the records");
  require(configuration.trailers[9].available() && configuration.trailers[9].value.index == 9 && !configuration.trailers[0].available() && !configuration.trailers[1].available(), "trailer slots in the current configuration");
  // Lifecycle records at the callback moment.
  host.event(SCS_TELEMETRY_EVENT_started); host.event(SCS_TELEMETRY_EVENT_paused); const auto lifecycle_records = ring.drain(*channel);
  require(lifecycle_records.size() == 2 && type_of(lifecycle_records[0]) == "simulation.started" && lifecycle_records[0].occurred.simulation == v1::SimulationState::running, "simulation.started");
  require(type_of(lifecycle_records[1]) == "simulation.paused" && lifecycle_records[1].occurred.simulation == v1::SimulationState::paused, "simulation.paused");
  scs_telemetry_frame_start_t frame{}; frame.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.frame_end();
  const auto restart = ring.drain(*channel); require(restart.size() == 1 && type_of(restart[0]) == "timers.restart", "SDK timer restart is timers.restart");
  auto minutes = u32(500); host.channel(Field::game_time, &minutes); host.frame_end(); const auto before_regression = v1_read(*adapter);
  minutes = u32(100); host.channel(Field::game_time, &minutes); const auto regressions = ring.drain(*channel);
  require(regressions.size() == 1 && type_of(regressions[0]) == "gameTime.regression", "game-time regression record");
  const auto& regression = std::get<v1::records::GameTimeRegression>(regressions[0].record);
  require(regression.from.minutes.available() && regression.from.minutes.value == 500 && same_clock(regression.from.clock_id, before_regression->state.game_time.clock_id), "from: the reading and clock before the rotation");
  require(regression.to.minutes.value == 100 && !same_clock(regression.to.clock_id, regression.from.clock_id), "to: the regressed reading under the rotated clock");
  require(same_clock(regressions[0].occurred.game_time.clock_id, regression.to.clock_id) && regressions[0].occurred.game_time.minutes.value == 100, "occurred.gameTime equals to");
  require(v1_record(encoder, regressions[0]).at("to").at("minutes").at("value").string() == "100", "the contract accepts the regression");
  // Gameplay events (§6): exact s64 money, units and booleans; vehicle.damage has no v1 field.
  scs_named_value_t delivered[]{attribute("revenue", s64(INT64_MIN)), attribute("earned.xp", s32(250)), attribute("cargo.damage", floating(0.05F)), attribute("distance.km", floating(151.25F)),
    attribute("delivery.time", u32(300)), attribute("auto.park.used", boolean(true)), attribute("auto.load.used", boolean(false)), attribute("vehicle.damage", floating(0.5F)), {}};
  scs_named_value_t cancelled[]{attribute("cancel.penalty", s64(1000)), {}};
  scs_named_value_t fined[]{attribute("fine.offence", text("speeding")), attribute("fine.amount", s64(INT64_MAX)), {}};
  scs_named_value_t toll[]{attribute("pay.amount", s64(0)), {}};
  scs_named_value_t ferry[]{attribute("pay.amount", s64(450)), attribute("source.id", text("port_a")), attribute("source.name", text("Port A")), attribute("target.id", text("port_b")), attribute("target.name", text("Port B")), {}};
  host.gameplay("job.delivered", delivered); host.gameplay("job.cancelled", cancelled); host.gameplay("player.fined", fined); host.gameplay("player.tollgate.paid", toll);
  host.gameplay("player.use.ferry", ferry); host.gameplay("player.use.train", ferry);
  const auto before_car = channel->next_event_seq();
  host.gameplay("car_job.delivered", delivered); host.gameplay("car_job.cancelled", cancelled); host.gameplay("test.unknown", toll); host.gameplay(nullptr, toll);
  require(channel->next_event_seq() == before_car, "car_job and unknown gameplay events: no eventSeq");
  const auto gameplay = ring.drain(*channel);
  require(gameplay.size() == 6 && type_of(gameplay[0]) == "job.delivered" && type_of(gameplay[1]) == "job.cancelled" && type_of(gameplay[2]) == "player.fined" && type_of(gameplay[3]) == "player.tollgate.paid" && type_of(gameplay[4]) == "player.use.ferry" && type_of(gameplay[5]) == "player.use.train", "the six gameplay types");
  require(gameplay[0].occurred.configuration_revision == configuration.revision, "gameplay events carry the current v1 revision");
  const auto d = v1_record(encoder, gameplay[0]);
  require(v1_raw(d.at("revenue")) == "-9223372036854775808" && d.at("revenue").at("value").at("sdkType").string() == "s64" && v1_number(d.at("earnedXp")) == 250, "s64 revenue exact, s32 experience");
  require(v1_number(d.at("distance")) == 151250 && d.at("distance").at("unit").string() == "m" && v1_number(d.at("cargoDamage")) == static_cast<double>(0.05F) && v1_text(d.at("deliveryDuration")) == "300", "distance.km x 1,000, damage fraction, duration minutes");
  require(d.at("autoParkUsed").at("value").boolean() && !d.at("autoLoadUsed").at("value").boolean(), "delivery flags");
  require(v1_raw(v1_record(encoder, gameplay[1]).at("penalty")) == "1000", "cancellation penalty");
  const auto f = v1_record(encoder, gameplay[2]); require(v1_text(f.at("offence")) == "speeding" && v1_raw(f.at("amount")) == "9223372036854775807", "fine offence and INT64_MAX amount");
  require(v1_raw(v1_record(encoder, gameplay[3]).at("amount")) == "0", "a zero toll is an available reading");
  for (std::size_t i = 4; i < 6; ++i) {
    const auto transfer = v1_record(encoder, gameplay[i]);
    require(v1_raw(transfer.at("amount")) == "450" && v1_text(transfer.at("sourceId")) == "port_a" && v1_text(transfer.at("sourceName")) == "Port A" && v1_text(transfer.at("targetId")) == "port_b" && v1_text(transfer.at("targetName")) == "Port B", "ferry and train transfers");
  }
  host.gameplay("job.cancelled", nullptr);
  std::array<scs_named_value_t, max_attributes> long_delivery{};
  for (auto& value : long_delivery) value = attribute("x", u32(1));
  long_delivery[0] = attribute("revenue", s64(7));
  host.gameplay("job.delivered", long_delivery.data()); const auto unseen_gameplay = ring.drain(*channel);
  require(unseen_gameplay.size() == 2 && std::get<v1::records::JobCancelled>(unseen_gameplay[0].record).penalty.state == v1::FieldState::invalid, "null gameplay list: fields invalid");
  const auto& long_record = std::get<v1::records::JobDelivered>(unseen_gameplay[1].record);
  require(long_record.revenue.available() && long_record.revenue.value == 7 && long_record.earned_xp.state == v1::FieldState::invalid && long_record.auto_load_used.state == v1::FieldState::invalid, "unterminated gameplay list: unseen fields invalid");
  require(ring.next == channel->next_event_seq() && ring.lost.offline + ring.lost.no_durable_consumer + ring.lost.queue_count == 0, "every record copied while durable");
  adapter->shutdown(); const auto retired = v1_read(*adapter);
  require(!retired->active && retired->source_retired && retired->state.simulation == v1::SimulationState::unavailable, "shutdown publishes a retired v1 slot");
  adapter->attach_events(nullptr);
}

void v1_state_and_gate() {
  {
    auto inert = std::make_unique<Adapter>(); Host host; auto params = host.params();
    require(inert->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "inert init"); host.event(SCS_TELEMETRY_EVENT_started); host.frame_end();
    V1Current none; require(!inert->read_v1_current(none), "no channel, no v1 slot"); inert->shutdown();
  }
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "v1 state init"); const auto v0_initial = read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared"); adapter->attach_events(channel.get());
  const auto initial = v1_read(*adapter);
  require(std::string(initial->identity.plugin_session_id.c_str()) == v0_initial->identity.plugin_session_id.c_str() && initial->active && initial->gameplay_result == SCS_RESULT_ok, "the v1 slot shares the v0 identity");
  require(initial->state.simulation == v1::SimulationState::paused && initial->state.boundary_order == v0_initial->boundary_order && initial->state.configuration.revision == 0 && !initial->state.window.available() && initial->state.capture_utc_unix_ms.available(), "the first v1 slot at attachment");
  // Gate none: lifecycle and configuration boundaries are offline transitions (S10); every event is offline loss.
  scs_named_value_t job[]{attribute("cargo.id", text("cargo.a")), {}}; scs_named_value_t penalty[]{attribute("cancel.penalty", s64(5)), {}};
  host.event(SCS_TELEMETRY_EVENT_started); host.config("job", job); host.gameplay("job.cancelled", penalty);
  require(!channel->front(), "gate none copies nothing");
  host.frame_end(); V1Ring ring;
  require(ring.drain(*channel).empty() && ring.lost.offline == 3 && ring.next == 4, "the offline run is flushed at frame_end");
  const auto offline = v1_read(*adapter);
  require(offline->continuity.offline_transitions == 2 && offline->state.configuration.revision == 1 && offline->state.configuration.job.available() && offline->state.configuration.job.value.cargo_id.view() == "cargo.a", "S10 boundaries and the current configuration while offline");
  // Gate live: noDurableConsumer loss, and a live client is connected, so no offline transition.
  channel->set_gate(v1::Gate::live); host.event(SCS_TELEMETRY_EVENT_paused); host.gameplay("job.cancelled", penalty); host.frame_end();
  ring.drain(*channel); const auto live = v1_read(*adapter);
  require(ring.lost.no_durable_consumer == 2 && ring.next == 6 && live->continuity.offline_transitions == 2 && live->state.simulation == v1::SimulationState::paused, "live-only client: noDurableConsumer loss, no offline transition");
  // Current state in SDK units, at the v0 boundary.
  host.event(SCS_TELEMETRY_EVENT_started);
  scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = 10; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
  auto speed = floating(-7.5F), fuel = floating(20.5F), rpm = floating(1200), odometer = floating(123.25F), consumption = floating(0.25F), range = floating(500.5F), navigation = floating(1000);
  auto gear = s32(-1); auto minutes = u32(500);
  scs_value_t placement{}; placement.type = SCS_VALUE_TYPE_dplacement; placement.value_dplacement.position = {123.5, -4.0, 99.0}; placement.value_dplacement.orientation = {0.25F, 0.1F, -0.1F};
  host.channel(Field::speed, &speed); host.channel(Field::fuel, &fuel); host.channel(Field::rpm, &rpm); host.channel(Field::odometer, &odometer); host.channel(Field::consumption, &consumption);
  host.channel(Field::range, &range); host.channel(Field::navigation_distance, &navigation); host.channel(Field::gear, &gear); host.channel(Field::game_time, &minutes); host.channel(Field::world_placement, &placement);
  host.frame_end(); const auto v0_state = read(*adapter); const auto state = v1_read(*adapter); const auto& s = state->state;
  require(s.speed_mps.available() && s.speed_mps.value == -7.5 && s.fuel_l.value == 20.5 && s.engine_rpm.value == 1200 && s.gear.available() && s.gear.value == -1, "speed m/s, fuel L, rpm and signed gear");
  require(s.odometer_km.value == static_cast<double>(123.25F) && s.average_consumption_l_per_km.value == static_cast<double>(0.25F) && s.estimated_range_km.value == static_cast<double>(500.5F) && s.navigation_distance_m.value == 1000, "v1 state keeps SDK units: km and L/km");
  require(s.game_time.minutes.value == 500 && s.world_placement.available() && s.world_placement.value.x == 123.5 && s.world_placement.value.heading == static_cast<double>(0.25F), "game time and placement");
  require(s.boundary_order == v0_state->boundary_order && s.simulation == v1::SimulationState::running && s.capture_utc_unix_ms.available(), "the v1 slot shares the v0 boundary");
  // The adapter's state is a valid checkpoint in wire units, with all ten trailer slots (OD-6).
  v1::EventStore store; const v1::Encoder encoder(v1_identity(*state)); v1::StatusInfo status; status.delivery = store.status(); status.continuity = state->continuity;
  const auto checkpoint = v1_decode(v1::encode(encoder.checkpoint(1, UINT64_MAX, s, status))); const auto& wire_state = checkpoint.wire.at("data").at("state");
  require(v1_number(wire_state.at("odometer")) == 123250 && v1_number(wire_state.at("averageConsumption")) == 25 && v1_number(wire_state.at("estimatedRange")) == 500500 && v1_text(wire_state.at("gameTime")) == "500", "checkpoint from the adapter state in wire units");
  require(std::get<v1::Json::Array>(wire_state.at("configuration").at("trailers").value).size() == 10 && checkpoint.wire.at("data").at("continuity").at("offlineTransitions").string() == "2", "ten trailer slots and the v1 continuity");
  // A truck configuration invalidates dynamic truck readings in v1 as it does in v0.
  scs_named_value_t truck[]{attribute("id", text("truck.model.a")), attribute("fuel.capacity", floating(800)), {}};
  host.config("truck", truck); host.frame_end(); const auto changed = v1_read(*adapter);
  require(!changed->state.speed_mps.available() && changed->state.fuel_capacity_l.value == 800 && changed->state.game_time.minutes.available() && changed->state.configuration.truck.available(), "truck boundary invalidates dynamic readings");
  // A worker holding the v1 slot never stalls a callback: the older slot stays whole, contention is counted, and a
  // configuration change made meanwhile still reaches the next publication.
  const auto coherent = v1_read(*adapter);
  std::promise<void> held, release; auto release_signal = release.get_future();
  std::thread worker([&] { auto lock = AdapterTestAccess::hold_v1(*adapter); held.set_value(); release_signal.wait(); }); held.get_future().wait();
  speed = floating(9); host.channel(Field::speed, &speed); scs_named_value_t other_job[]{attribute("cargo.id", text("cargo.b")), {}}; host.config("job", other_job); host.frame_end(); host.frame_end();
  release.set_value(); worker.join();
  const auto stale = v1_read(*adapter);
  require(stale->state.boundary_order == coherent->state.boundary_order && !stale->state.speed_mps.available() && stale->state.configuration.job.value.cargo_id.view() == "cargo.a", "a contended publication keeps the older slot whole");
  host.frame_end(); const auto recovered = v1_read(*adapter);
  require(recovered->state.speed_mps.value == 9 && recovered->continuity.coalesced_snapshots == coherent->continuity.coalesced_snapshots + 2 && recovered->state.boundary_order > coherent->state.boundary_order, "v1 slot contention counted");
  require(recovered->state.configuration.job.value.cargo_id.view() == "cargo.b" && recovered->state.configuration.revision == coherent->state.configuration.revision + 1, "a configuration change survives a contended publication");
  adapter->shutdown(); adapter->attach_events(nullptr);
}

void v1_nonblocking() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "non-blocking init"); read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
  adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  host.event(SCS_TELEMETRY_EVENT_started); host.frame_end();
  const auto before = v1_read(*adapter);
  // A worker that holds the v1 slot lock while it is still reading the oldest ring slot.
  std::promise<void> held, release; auto release_signal = release.get_future(); std::atomic<bool> oldest_seen{false};
  std::thread worker([&] {
    auto lock = AdapterTestAccess::hold_v1(*adapter);
    const auto* oldest = channel->front(); oldest_seen.store(oldest && oldest->has_record && oldest->record.event_seq == 1);
    held.set_value(); release_signal.wait(); lock.unlock(); channel->pop();
  });
  held.get_future().wait();
  scs_named_value_t penalty[]{attribute("cancel.penalty", s64(5)), {}};
  auto callbacks = std::async(std::launch::async, [&] {
    for (unsigned frame = 0; frame < 200; ++frame) { host.gameplay("job.cancelled", penalty); host.event(frame % 2 ? SCS_TELEMETRY_EVENT_started : SCS_TELEMETRY_EVENT_paused); host.frame_end(); }
  });
  const bool completed = callbacks.wait_for(std::chrono::seconds(10)) == std::future_status::ready;
  release.set_value(); worker.join(); callbacks.get();
  require(oldest_seen.load(), "the worker held the oldest slot");
  require(completed, "SDK callbacks complete while the worker holds the v1 slot and a ring slot");
  // The ring kept 128 records; the rest is one queueCount run that reaches the worker at the next frame_end.
  V1Ring ring; ring.next = 2; ring.drain(*channel); host.frame_end(); ring.drain(*channel);
  require(ring.records.size() == v1::channel_slots - 1 && ring.lost.queue_count == 401 - v1::channel_slots && ring.next == 402 && channel->next_event_seq() == 402, "overflow is queueCount with complete coverage");
  const auto after = v1_read(*adapter);
  require(after->continuity.coalesced_snapshots == before->continuity.coalesced_snapshots + 200 && after->state.boundary_order > before->state.boundary_order, "every contended frame counted, then the slot recovers");
  require(read(*adapter)->boundary_order == after->state.boundary_order, "v0 publication continued");
  adapter->shutdown(); adapter->attach_events(nullptr);
}

// v0 and CAP0 isolation: one deterministic callback script runs on an adapter without and with an attached v1 channel.
// Every v0 publication (state, continuity, revision, diagnostics) and every CAP0 envelope must be identical.
namespace cap0 = ets2telemetry::cap0;
struct IsolationFrame { std::unique_ptr<Snapshot> snapshot; std::vector<cap0::Envelope> evidence; };
// break_mode 0: the host registers the break channel and never calls it; 1: the game does not provide it; 2: it is called in every frame.
std::vector<IsolationFrame> isolation_run(bool attach, int break_mode = 0) {
  auto adapter = std::make_unique<Adapter>(); Host host; if (break_mode == 1) host.missing = "mandatory.break"; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "isolation init"); read(*adapter);
  auto queue = std::make_unique<cap0::EvidenceQueue>(); require(queue->prepare(), "CAP0 queue prepared"); queue->open(); adapter->attach_evidence(queue.get());
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
  if (attach) { adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable); }
  adapter->set_consumer(true, true);
  std::vector<IsolationFrame> frames;
  const auto end_frame = [&] {
    if (break_mode == 2) { auto left = s32(static_cast<std::int32_t>(frames.size()) * 7 - 3); host.channel(Field::mandatory_break, &left); }
    host.frame_end(); IsolationFrame output; output.snapshot = std::make_unique<Snapshot>(); require(adapter->read_latest(*output.snapshot), "v0 frame published");
    cap0::Envelope envelope; while (queue->pop(envelope)) output.evidence.push_back(envelope);
    while (channel->front()) channel->pop();
    frames.push_back(std::move(output));
  };
  scs_named_value_t empty[]{{}};
  scs_named_value_t truck[]{attribute("id", text("truck.model.a")), attribute("fuel.capacity", floating(800)), attribute("brand", text("Brand")), {}};
  scs_named_value_t job[]{attribute("cargo.id", text("cargo.a")), attribute("destination.city.id", text("city.b")), attribute("income", u64(UINT64_MAX)), attribute("planned_distance.km", u32(700)), {}};
  scs_named_value_t trailer[]{attribute("id", text("trailer.a")), attribute("wheel.radius", floating(0.5F), 0), {}};
  scs_named_value_t delivered[]{attribute("revenue", s64(INT64_MIN)), attribute("distance.km", floating(42.5F)), attribute("source.name", text("")), {}};
  host.event(SCS_TELEMETRY_EVENT_started); host.config("truck", truck); host.config("job", job); host.config("trailer.0", trailer); host.config("trailer", trailer); host.config("bus_job", job); end_frame();
  scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = 10; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame);
  auto speed = floating(12.5F), odometer = floating(1000.5F); auto minutes = u32(500);
  host.channel(Field::speed, &speed); host.channel(Field::odometer, &odometer); host.channel(Field::game_time, &minutes); end_frame();
  host.gameplay("job.delivered", delivered); host.gameplay("car_job.delivered", delivered); host.config("job", empty); host.config("trailer.0", empty); host.config("job", nullptr); end_frame();
  frame.render_time = frame.simulation_time = 20; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); minutes = u32(100); host.channel(Field::game_time, &minutes); host.channel(Field::speed, &speed); end_frame();
  frame.flags = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); host.event(SCS_TELEMETRY_EVENT_paused); end_frame();
  std::array<scs_named_value_t, max_attributes> unterminated{};
  for (auto& value : unterminated) value = attribute("x", u32(1));
  host.config("job", unterminated.data()); host.config("truck", empty); end_frame();
  adapter->set_consumer(false, false); host.gameplay("job.cancelled", delivered); host.event(SCS_TELEMETRY_EVENT_started); end_frame();
  adapter->shutdown(); frames.push_back({std::make_unique<Snapshot>(), {}}); require(adapter->read_latest(*frames.back().snapshot), "v0 shutdown frame");
  queue->close(); adapter->attach_evidence(nullptr); adapter->attach_events(nullptr);
  return frames;
}
template<std::size_t N> bool same_text(const Text<N>& a, const Text<N>& b) { return a.status == b.status && a.bytes == b.bytes; }
bool same_epoch(const ets2telemetry::sdk::Uuid& a, const ets2telemetry::sdk::Uuid& b) { return std::string(a.c_str()).substr(24) == std::string(b.c_str()).substr(24); }
void same_v0(const Snapshot& a, const Snapshot& b, std::size_t skip_channel = SIZE_MAX) {
  require(a.boundary_order == b.boundary_order && a.active == b.active && a.exhausted == b.exhausted && a.source_retired == b.source_retired, "v0 isolation: boundary order and lifecycle");
  const auto& x = a.state; const auto& y = b.state;
  require(x.configuration_revision == y.configuration_revision && x.simulation == y.simulation && x.frame_available == y.frame_available && same_epoch(x.game_clock_id, y.game_clock_id), "v0 isolation: revision, simulation and game clock epoch");
  for (std::size_t i = 0; i < x.channels.size(); ++i) if (i != skip_channel) require(x.channels[i].status == y.channels[i].status && x.channels[i].value == y.channels[i].value, "v0 isolation: channel readings");
  require(x.game_time_minutes.status == y.game_time_minutes.status && x.game_time_minutes.value == y.game_time_minutes.value && x.fuel_capacity_l.status == y.fuel_capacity_l.status && x.fuel_capacity_l.value == y.fuel_capacity_l.value, "v0 isolation: game time and fuel capacity");
  require(x.world_placement.status == y.world_placement.status && std::memcmp(&x.world_placement.value, &y.world_placement.value, sizeof x.world_placement.value) == 0 && same_text(x.truck_id, y.truck_id), "v0 isolation: placement and truck");
  const auto& j = x.job; const auto& k = y.job;
  require(j.status == k.status && same_text(j.cargo_id, k.cargo_id) && same_text(j.destination_city_id, k.destination_city_id) && same_text(j.source_city_id, k.source_city_id) && same_text(j.market, k.market) &&
    j.planned_distance_m.status == k.planned_distance_m.status && j.planned_distance_m.value == k.planned_distance_m.value && j.expected_income.status == k.expected_income.status && j.expected_income.value == k.expected_income.value, "v0 isolation: job");
  const auto& c = a.continuity; const auto& d = b.continuity;
  require(c.coalesced_snapshots == d.coalesced_snapshots && c.lost_observations == d.lost_observations && c.offline_transitions == d.offline_transitions && c.callback_failures == d.callback_failures, "v0 isolation: continuity");
  require(a.observation_count == b.observation_count, "v0 isolation: diagnostic batch size");
  for (std::size_t i = 0; i < a.observation_count; ++i) {
    const auto& o = a.observations[i]; const auto& p = b.observations[i];
    require(o.kind == p.kind && same_text(o.group, p.group) && same_text(o.name, p.name) && o.index == p.index && o.callback_order == p.callback_order, "v0 isolation: observation identity");
    require(o.value.type == p.value.type && o.value.status == p.value.status && o.value.boolean == p.value.boolean && o.value.signed_integer == p.value.signed_integer &&
      o.value.unsigned_integer == p.value.unsigned_integer && o.value.number == p.value.number && same_text(o.value.string, p.value.string), "v0 isolation: observation value");
  }
}
void same_cap0(const cap0::Envelope& a, const cap0::Envelope& b) {
  require(a.kind == b.kind && a.id.status == b.id.status && a.id.value == b.id.value && a.seq == b.seq && a.dropped_before == b.dropped_before && a.boundary_order == b.boundary_order && a.configuration_revision == b.configuration_revision, "CAP0 isolation: envelope identity and revision");
  require(a.frame_available == b.frame_available && a.render_us == b.render_us && a.simulation_us == b.simulation_us && a.game_time_status == b.game_time_status && a.game_time_minutes == b.game_time_minutes &&
    a.simulation == b.simulation && a.game_clock_id.substr(24) == b.game_clock_id.substr(24), "CAP0 isolation: envelope context");
  require(a.attributes_expected == b.attributes_expected && a.attributes_null == b.attributes_null && a.terminated == b.terminated && a.attributes.size() == b.attributes.size(), "CAP0 isolation: attribute list");
  for (std::size_t i = 0; i < a.attributes.size(); ++i) {
    const auto& x = a.attributes[i]; const auto& y = b.attributes[i];
    require(x.name.value == y.name.value && x.index == y.index && x.value.type == y.value.type && x.value.status == y.value.status && x.value.signed_integer == y.value.signed_integer &&
      x.value.unsigned_integer == y.value.unsigned_integer && x.value.numbers == y.value.numbers && x.value.text == y.value.text, "CAP0 isolation: attribute values");
  }
}
void v1_isolation() {
  const auto without = isolation_run(false), with = isolation_run(true);
  require(without.size() == with.size() && without.size() == 8, "isolation frames");
  std::size_t observations = 0, envelopes = 0;
  for (std::size_t i = 0; i < without.size(); ++i) {
    same_v0(*without[i].snapshot, *with[i].snapshot); observations += without[i].snapshot->observation_count;
    require(without[i].evidence.size() == with[i].evidence.size(), "CAP0 isolation: envelope count");
    for (std::size_t e = 0; e < without[i].evidence.size(); ++e) same_cap0(without[i].evidence[e], with[i].evidence[e]);
    envelopes += without[i].evidence.size();
  }
  require(observations > 20 && envelopes > 15 && without.back().snapshot->source_retired, "the script exercised diagnostics, evidence and shutdown");
}

// End to end: SDK callbacks -> ring -> the PR A EventStore -> encoder -> the ET-002b Consumer, with DurableAckCursor
// commits and AckValidator releases. This is the drain loop docs/native-transport-v1.md specifies for the endpoint.
struct V1Worker {
  Adapter& adapter; v1::EventChannel& channel; v1::Encoder encoder; v1::EventStore store; std::string session;
  std::optional<v1::Consumer> consumer; std::optional<v1::AckValidator> validator; v1::DurableAckCursor cursor;
  std::uint64_t seq = 0, capture = 0, events_written = 0, gaps_written = 0;
  // Every loss run drained from the ring and every gap the Consumer accepted, in order.
  std::vector<v1::LossRun> runs; std::vector<v1::GapView> gaps;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> received; std::vector<v1::Ingest> ingested; std::map<std::uint64_t, std::string> drained_types;
  V1Worker(Adapter& a, v1::EventChannel& c, const V1Current& current)
    : adapter(a), channel(c), encoder(v1_identity(current)), session(current.identity.plugin_session_id.c_str()), cursor(current.identity.plugin_session_id.c_str()) {}
  std::uint64_t now() { std::uint64_t ns = 0; require(adapter.source_monotonic_ns(ns), "source clock"); return ns; }
  // capture = max(now, last capture, the latest source-clock time the message carries).
  std::uint64_t stamp(std::uint64_t carried = 0) { capture = std::max({now(), capture, carried}); return capture; }
  // A loss run becomes store coverage one cause at a time in a fixed order; each part carries the run's lost times, so
  // the merged gap record has the exact counts and the run's earliest and latest lost observation.
  void record_run(const v1::LossRun& run, std::uint64_t t) {
    runs.push_back(run);
    const std::pair<v1::LossCause, std::uint64_t> parts[]{{v1::LossCause::offline, run.causes.offline}, {v1::LossCause::no_durable_consumer, run.causes.no_durable_consumer}, {v1::LossCause::queue_count, run.causes.queue_count}};
    const auto first_ns = run.times_available ? std::optional<std::uint64_t>(run.first_lost_ns) : std::nullopt, last_ns = run.times_available ? std::optional<std::uint64_t>(run.last_lost_ns) : std::nullopt;
    auto first = run.first_event_seq;
    for (const auto& [cause, count] : parts) if (count) { require(store.lose(first, first + count - 1, cause, first_ns, last_ns, t), "a drained loss run is never rejected"); first += count; }
    require(first == run.last_event_seq + 1, "loss run parts cover the run");
  }
  void drain() {
    while (const auto* slot = channel.front()) {
      const auto t = now();
      if (slot->has_loss) record_run(slot->loss_before, t);
      if (slot->has_record) {
        drained_types[slot->record.event_seq] = type_of(slot->record);
        const auto result = v1::ingest_event(store, encoder, slot->record, t); require(result != v1::Ingest::rejected, "a drained record is never rejected"); ingested.push_back(result);
      }
      channel.pop();
    }
  }
  v1::Applied send(v1::Json wire, v1::Message* accepted = nullptr) {
    const auto message = v1_decode(v1::encode(std::move(wire))); const auto applied = consumer->accept(message);
    if (accepted) *accepted = message;
    return applied;
  }
  void open() {
    // Connect before the gate opens, so that every record copied for this consumer is retained.
    store.connect(); channel.set_gate(v1::Gate::durable);
    consumer.emplace(true); validator.emplace(session, true);
    const auto current = v1_read(adapter);
    v1::WelcomeInfo welcome; welcome.durable_events = true; welcome.gameplay_events_registered = current->gameplay_result == SCS_RESULT_ok; welcome.telemetry_api = {1, 1}; welcome.game_telemetry = {1, 20};
    send(encoder.welcome(++seq, stamp(), welcome));
    drain();
    v1::StatusInfo info; info.durable = true; info.delivery = store.status(); info.continuity = current->continuity;
    const auto applied = send(encoder.checkpoint(++seq, stamp(info.delivery.oldest_retained_ns.value_or(0)), current->state, info));
    require(applied.hydration && !applied.coverage, "the checkpoint hydrates only");
    validator->checkpoint(info.delivery.acked_through_event_seq); cursor.begin_connection(info.delivery.acked_through_event_seq);
  }
  void pump() {
    while (const auto item = store.next_outbound()) {
      const auto carried = item->gap ? item->range.last_lost_ns.value_or(0) : item->event.occurred.monotonic_ns.available() ? item->event.occurred.monotonic_ns.value : 0;
      v1::Message message; const auto applied = send(encoder.outbound(++seq, stamp(carried), *item), &message);
      require(applied.coverage && applied.coverage->first_event_seq == item->first_event_seq() && applied.coverage->last_event_seq == item->last_event_seq(), "written coverage");
      if (item->gap) { ++gaps_written; gaps.push_back(*message.gap); } else { ++events_written; require(drained_types.at(item->event.event_seq) == type_of(item->event), "event identity preserved"); }
      validator->sent(item->last_event_seq()); cursor.received(item->first_event_seq(), item->last_event_seq()); received.emplace_back(item->first_event_seq(), item->last_event_seq());
    }
  }
  void commit_and_ack() {
    for (const auto& [first, last] : received) cursor.commit(first, last);
    received.clear();
    if (const auto ack = cursor.ack()) if (const auto through = validator->accept(*ack)) require(store.release(*through).has_value(), "release after the validated ACK");
  }
  void close() { channel.set_gate(v1::Gate::none); store.disconnect(now()); consumer.reset(); validator.reset(); }
};
void v1_drain_into_store() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "drain init"); read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared"); adapter->attach_events(channel.get());
  auto worker = std::make_unique<V1Worker>(*adapter, *channel, *v1_read(*adapter));
  scs_named_value_t job[]{attribute("cargo.id", text("cargo.a")), attribute("planned_distance.km", u32(700)), {}}; scs_named_value_t penalty[]{attribute("cancel.penalty", s64(5)), {}};
  // No v1 client: offline. The worker records the run before any durable connection (OD-4).
  host.event(SCS_TELEMETRY_EVENT_started); host.config("job", job); host.gameplay("job.cancelled", penalty); host.frame_end(); worker->drain();
  require(worker->store.next_event_seq() == 4 && worker->store.status().event_loss.offline == 3 && worker->store.entries() == 1, "offline run recorded before the first durable connection");
  // A live-only client: noDurableConsumer, merged into the same trailing gap record.
  channel->set_gate(v1::Gate::live); host.gameplay("job.cancelled", penalty); host.event(SCS_TELEMETRY_EVENT_paused); host.frame_end(); worker->drain();
  require(worker->store.status().event_loss.no_durable_consumer == 2 && worker->store.entries() == 1 && worker->store.next_event_seq() == 6, "noDurableConsumer extends the gap record");
  // A durable consumer: copied records are retained and written in order after the gap.
  worker->open();
  host.event(SCS_TELEMETRY_EVENT_started); host.config("job", job); host.gameplay("job.cancelled", penalty); host.gameplay("player.fined", penalty); host.gameplay("job.delivered", penalty); host.frame_end();
  worker->drain(); worker->pump(); worker->commit_and_ack();
  require(worker->ingested.size() == 5 && std::all_of(worker->ingested.begin(), worker->ingested.end(), [](v1::Ingest r) { return r == v1::Ingest::retained; }), "copied records retained");
  require(worker->gaps_written == 1 && worker->events_written == 5 && worker->consumer->next_event_seq() == 11 && worker->store.release_point() == 10, "gap [1, 5] then five events, acknowledged");
  // Ring overflow while durable: 140 records without a drain. 128 are copied; 12 become one queueCount run, which a
  // full ring keeps open at the first frame_end and the next frame_end delivers.
  for (unsigned i = 0; i < 140; ++i) host.gameplay("job.cancelled", penalty);
  host.frame_end(); worker->drain(); host.frame_end(); worker->drain();
  require(worker->store.status().event_loss.queue_count == 12 && worker->store.next_event_seq() == 151, "ring overflow is queueCount coverage");
  worker->pump(); worker->commit_and_ack();
  // One run with several causes: within one frame and without a flush, a full ring (queueCount 279-282), then a
  // live-only gate (noDurableConsumer 283-284), then no client (offline 285). The next copied record (286) carries it.
  for (unsigned i = 0; i < v1::channel_slots; ++i) host.gameplay("job.cancelled", penalty);
  const auto before_queue = worker->now();
  for (unsigned i = 0; i < 4; ++i) host.gameplay("job.cancelled", penalty);
  const auto after_queue = worker->now(); channel->set_gate(v1::Gate::live);
  host.gameplay("player.fined", penalty); host.gameplay("job.cancelled", penalty);
  channel->set_gate(v1::Gate::none); const auto before_offline = worker->now();
  host.event(SCS_TELEMETRY_EVENT_paused);
  const auto after_offline = worker->now();
  worker->drain();
  require(worker->runs.size() == 3 && worker->store.next_event_seq() == 279, "the run stays open until a record or a flush carries it");
  channel->set_gate(v1::Gate::durable); host.gameplay("job.cancelled", penalty); worker->drain();
  const auto& run = worker->runs.back();
  require(run.first_event_seq == 279 && run.last_event_seq == 285 && run.causes.queue_count == 4 && run.causes.no_durable_consumer == 2 && run.causes.offline == 1, "one run with three causes");
  worker->pump(); worker->commit_and_ack();
  const auto& gap = worker->gaps.back();
  require(worker->gaps_written == 3 && gap.first_event_seq == 279 && gap.last_event_seq == 285 && !gap.redelivered, "the Consumer receives one gap for the whole run");
  require(gap.causes.queue_count == 4 && gap.causes.no_durable_consumer == 2 && gap.causes.offline == 1 && gap.causes.queue_bytes == 0 && gap.causes.retention_expired == 0 && gap.causes.encoding_failed == 0, "exact per-cause counts in one gap");
  require(gap.first_lost_monotonic_ns.value && gap.last_lost_monotonic_ns.value && *gap.first_lost_monotonic_ns.value == run.first_lost_ns && *gap.last_lost_monotonic_ns.value == run.last_lost_ns, "the gap keeps the run's lost times");
  require(before_queue <= run.first_lost_ns && run.first_lost_ns <= after_queue && before_offline <= run.last_lost_ns && run.last_lost_ns <= after_offline, "S1: the first queueCount and the last offline observation");
  const auto merged = worker->store.status().event_loss;
  require(merged.offline == 4 && merged.no_durable_consumer == 4 && merged.queue_count == 16 && worker->consumer->next_event_seq() == 287, "store loss counters include every cause of the run");
  // OD-5 S4: records copied while durable and drained after the disconnect are retained for the next connection.
  host.gameplay("player.tollgate.paid", penalty); host.gameplay("job.cancelled", penalty); worker->close(); worker->drain();
  require(worker->ingested.size() == 264 && worker->ingested[262] == v1::Ingest::retained && worker->ingested[263] == v1::Ingest::retained, "S4: drained after the disconnect, still retained");
  worker->open(); host.event(SCS_TELEMETRY_EVENT_paused); host.frame_end(); worker->drain(); worker->pump(); worker->commit_and_ack();
  const auto status = worker->store.status(); const auto& loss = status.event_loss;
  require(worker->consumer->next_event_seq() == channel->next_event_seq() && channel->next_event_seq() == 290 && worker->events_written == 265 && worker->gaps_written == 3, "contiguous coverage of every eventSeq accepted by the Consumer");
  require(loss.offline == 4 && loss.no_durable_consumer == 4 && loss.queue_count == 16 && loss.queue_bytes == 0 && loss.retention_expired == 0 && loss.encoding_failed == 0, "exact loss causes");
  require(worker->cursor.through_event_seq() == 289 && status.acked_through_event_seq == 289 && status.retained_entries == 0, "every eventSeq committed and released");
  adapter->shutdown(); adapter->attach_events(nullptr);
}

// initialize() starts a new plugin session: a contended initialization (`not_now`) changes no state, and a channel left
// attached from the previous session is detached, so eventSeq never continues under a new pluginSessionId (§9).
void v1_session_boundary() {
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "session boundary init"); read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
  adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  host.event(SCS_TELEMETRY_EVENT_started); require(channel->next_event_seq() == 2, "the first session assigned eventSeq 1");
  // The caller shuts down without attach_events(nullptr).
  adapter->shutdown();
  auto retired = std::make_unique<Snapshot>(); require(adapter->read_current(*retired) && retired->source_retired, "retired v0 state");
  const auto retired_v1 = v1_read(*adapter);
  std::promise<void> held, release; auto release_signal = release.get_future();
  std::thread worker([&] { auto lock = AdapterTestAccess::hold_v1(*adapter); held.set_value(); release_signal.wait(); }); held.get_future().wait();
  const auto deferred = adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params);
  release.set_value(); worker.join();
  require(deferred == SCS_RESULT_not_now && host.events.empty() && host.channels.empty(), "a held v1 slot defers initialization before any registration");
  auto unchanged = std::make_unique<Snapshot>();
  require(adapter->read_current(*unchanged) && std::string(unchanged->identity.plugin_session_id.c_str()) == retired->identity.plugin_session_id.c_str() && unchanged->boundary_order == retired->boundary_order, "not_now leaves the v0 slot unchanged");
  const auto unchanged_v1 = v1_read(*adapter);
  require(std::string(unchanged_v1->identity.plugin_session_id.c_str()) == retired_v1->identity.plugin_session_id.c_str() && !unchanged_v1->active, "not_now leaves the v1 slot unchanged");
  // The next initialization starts a new session and detaches the stale channel.
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "initialization after the slot is released"); const auto second = read(*adapter);
  require(std::string(second->identity.plugin_session_id.c_str()) != retired->identity.plugin_session_id.c_str(), "a new plugin session");
  scs_named_value_t penalty[]{attribute("cancel.penalty", s64(5)), {}};
  host.event(SCS_TELEMETRY_EVENT_started); host.gameplay("job.cancelled", penalty); host.frame_end();
  V1Current none;
  require(channel->next_event_seq() == 2 && !adapter->read_v1_current(none), "the stale channel receives nothing and v1 stays inert");
  // A prepared channel attached again starts the new session at eventSeq 1.
  require(channel->prepare(), "channel prepared for the new session"); adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  host.event(SCS_TELEMETRY_EVENT_paused);
  const auto* first = channel->front();
  require(first && first->has_record && first->record.event_seq == 1 && v1_read(*adapter)->identity.plugin_session_id.c_str() == std::string(second->identity.plugin_session_id.c_str()), "the new session starts at eventSeq 1");
  adapter->shutdown(); adapter->attach_events(nullptr);
}

// ET-050b PR-4: the minor-1 gearbox capture. The CAP-01 run4 (ATS Mack Anthem 18-speed) and run2 (ETS2 DAF, then Volvo,
// 12-speed) truck and hshifter configuration callbacks are replayed attribute by attribute from the committed sanitized
// replay fixtures, in their capture order, and the encoded `state.gearbox` must equal the hand-written minor-1 fixtures.
struct CapturedConfig {
  std::string id; std::deque<std::string> names, strings; std::vector<scs_named_value_t> attributes;
  const scs_named_value_t* list() const { return attributes.data(); }
};
std::string read_file(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary); require(static_cast<bool>(input), "fixture readable");
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
v1::Json parse_file(const std::filesystem::path& path) { return ets2telemetry::v0::detail::Parser(read_file(path)).parse(); }
// The truck and hshifter configuration callbacks of one CAP-01 replay, in step order, with their exact attribute names,
// SDK indices, types and values. Every value type these callbacks carry is mapped; another type fails the test.
std::vector<std::unique_ptr<CapturedConfig>> cap01_configs(const std::filesystem::path& path) {
  const auto root = parse_file(path); std::vector<std::unique_ptr<CapturedConfig>> output;
  for (const auto& step : std::get<v1::Json::Array>(root.at("steps").value)) {
    if (step.at("action").string() != "capture") continue;
    const auto& data = step.at("data"); const auto& callback = data.at("callback");
    if (callback.at("group").string() != "configuration" || !callback.at("id").at("available").boolean()) continue;
    const auto id = callback.at("id").at("value").string();
    if (id != "truck" && id != "hshifter") continue;
    auto config = std::make_unique<CapturedConfig>(); config->id = id;
    const auto& observations = std::get<v1::Json::Array>(data.at("observations").value);
    require(data.at("attributes").at("terminated").boolean() && data.at("attributes").at("count").number() == static_cast<double>(observations.size()), "a complete terminated capture");
    for (const auto& o : observations) {
      const auto& name = config->names.emplace_back(o.at("name").at("value").string());
      const auto& index = o.at("arrayIndex");
      const auto i = index.at("available").boolean() ? static_cast<scs_u32_t>(index.at("value").number()) : SCS_U32_NIL;
      const auto& type = o.at("sdkType").string(); const auto& value = o.at("value").at("value");
      scs_value_t v{};
      if (type == "u32") v = u32(static_cast<std::uint32_t>(value.number()));
      else if (type == "s32") v = s32(static_cast<std::int32_t>(value.number()));
      else if (type == "float") v = floating(static_cast<float>(value.number()));
      else if (type == "bool") v = boolean(value.boolean());
      else if (type == "string") v = text(config->strings.emplace_back(value.string()).c_str());
      else if (type == "fvector") { v.type = SCS_VALUE_TYPE_fvector; v.value_fvector = {static_cast<float>(value.at("x").number()), static_cast<float>(value.at("y").number()), static_cast<float>(value.at("z").number())}; }
      else throw std::runtime_error("unmapped CAP-01 value type " + type);
      config->attributes.push_back(attribute(name.c_str(), v, i));
    }
    config->attributes.push_back({});
    output.push_back(std::move(config));
  }
  return output;
}
v1::Message decode_minor1(const std::vector<std::uint8_t>& frame) { return v1::decode_payload(std::string(frame.begin() + 4, frame.end()), v1::Sender::server, 1); }
// The encoded minor-1 gearbox of the adapter's current v1 slot, through the encoder and the minor-1 contract decoder.
std::string gearbox_wire(Adapter& adapter) {
  const auto current = v1_read(adapter); const v1::Encoder encoder(v1_identity(*current)); v1::StatusInfo status; status.continuity = current->continuity;
  return ets2telemetry::v0::detail::serialize(decode_minor1(v1::encode(encoder.checkpoint(1, UINT64_MAX, current->state, status, 1), 1)).wire.at("data").at("state").at("gearbox"));
}
std::string fixture_gearbox(const std::filesystem::path& minor1, const char* name) {
  const auto message = v1::decode_payload(read_file(minor1 / (std::string(name) + ".json")), v1::Sender::server, 1);
  return ets2telemetry::v0::detail::serialize(message.wire.at("data").at("state").at("gearbox"));
}
std::string part_reason(Adapter& adapter, const char* part) {
  const auto node = ets2telemetry::v0::detail::Parser(gearbox_wire(adapter)).parse().at(part);
  return node.at("available").boolean() ? std::string("available") : node.at("reason").string();
}
// One hshifter or truck callback that must change no revision, assign no eventSeq, copy no record and call no SDK API.
struct Quiet {
  Adapter& adapter; Host& host; v1::EventChannel& channel; std::uint64_t revision, next; unsigned calls;
  Quiet(Adapter& a, Host& h, v1::EventChannel& c) : adapter(a), host(h), channel(c), revision(v1_read(a)->state.configuration.revision), next(c.next_event_seq()), calls(h.api_calls) {}
  void check(const char* what) const {
    require(!channel.front() && channel.next_event_seq() == next && host.api_calls == calls, what);
    require(v1_read(adapter)->state.configuration.revision == revision, "the hshifter callback changes no configuration revision");
  }
};
void v1_gearbox(const std::filesystem::path& fixtures) {
  const auto minor1 = fixtures / "protocol-v1" / "minor1";
  // run4: hshifter (CAP0 revision 3) arrives before the truck (revision 4).
  {
    const auto configs = cap01_configs(fixtures / "simulator-v1" / "cap01" / "cap01-run4.json");
    require(configs.size() == 4 && configs[0]->id == "hshifter" && configs[1]->id == "truck" && configs[0]->attributes.size() == 99, "run4: hshifter (98 attributes), then three truck callbacks");
    auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params("ats");
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "run4 init"); read(*adapter);
    auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
    adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
    host.event(SCS_TELEMETRY_EVENT_started); host.frame_end(); V1Ring ring; ring.drain(*channel);
    require(part_reason(*adapter, "hshifter") == "not-observed" && part_reason(*adapter, "forwardGears") == "not-observed", "no gearbox before its callbacks");
    const Quiet quiet(*adapter, host, *channel);
    host.config("hshifter", configs[0]->list()); quiet.check("the hshifter callback copies no v1 record and calls no SDK API");
    host.frame_end(); quiet.check("the publication after the hshifter callback");
    const auto pod = v1_read(*adapter)->state.gearbox;
    require(pod.hshifter.available() && pod.hshifter.value.selector_count == 2 && !pod.forward_gears.available(), "run4 POD: an available two-selector layout, counts not observed yet");
    unsigned copied = 0, nonzero = 0;
    for (std::size_t i = 0; i < pod.hshifter.value.slots.size(); ++i) {
      const auto& slot = pod.hshifter.value.slots[i];
      if (!slot.seen) continue;
      ++copied; if (slot.gear) ++nonzero;
      require(slot.seen == (v1::slot_gear_seen | v1::slot_handle_seen | v1::slot_selectors_seen) && slot.handle_position == i / 4 && slot.selectors == i % 4, "run4 POD: every SDK slot copied whole, in SDK order");
    }
    require(copied == 32 && nonzero == 22 && pod.hshifter.value.slots[8].gear == -1 && pod.hshifter.value.slots[12].gear == 1 && pod.hshifter.value.slots[13].gear == 0 && pod.hshifter.value.slots[31].gear == 18, "run4 POD: 32 slots, 22 geared, the crawler and the top gear");
    host.config("truck", configs[1]->list()); host.frame_end(); ring.drain(*channel);
    require(ring.records.size() == 2 && type_of(ring.records.back()) == "truck.configured", "the truck callback still emits truck.configured");
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "checkpoint-ats-mack"), "run4 replay equals minor1/checkpoint-ats-mack's gearbox");
    // A later truck re-send keeps the layout; minor 0 never carries it.
    host.config("truck", configs[2]->list()); host.frame_end();
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "checkpoint-ats-mack"), "the layout survives a truck re-send");
    const auto current = v1_read(*adapter); const v1::Encoder encoder(v1_identity(*current)); v1::StatusInfo status; status.continuity = current->continuity;
    const auto minor0 = v1_decode(v1::encode(encoder.checkpoint(1, UINT64_MAX, current->state, status)));
    require(minor0.minor == 0 && !minor0.state->gearbox && !std::get<v1::Json::Object>(minor0.wire.at("data").at("state").value).count("gearbox"), "a minor-0 checkpoint has no gearbox");
    adapter->shutdown(); adapter->attach_events(nullptr);
  }
  // run2: the truck (8), then hshifter (9) before a truck change (10), then hshifter (11) and truck (12) again.
  {
    const auto configs = cap01_configs(fixtures / "simulator-v1" / "cap01" / "cap01-run2.json");
    require(configs.size() == 5 && configs[0]->id == "truck" && configs[1]->id == "hshifter" && configs[2]->id == "truck" && configs[3]->id == "hshifter" && configs[4]->id == "truck", "run2 callback order");
    auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "run2 init"); read(*adapter);
    auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
    adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
    host.event(SCS_TELEMETRY_EVENT_started); host.config("truck", configs[0]->list()); host.frame_end();
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "snapshot"), "counts 12/4 before any layout (minor1/snapshot)");
    V1Ring ring; ring.drain(*channel);
    const Quiet quiet(*adapter, host, *channel);
    host.config("hshifter", configs[1]->list()); host.frame_end(); quiet.check("run2 hshifter callback");
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "checkpoint"), "run2 replay equals minor1/checkpoint's gearbox");
    host.config("truck", configs[2]->list()); host.frame_end();
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "checkpoint"), "a truck change keeps the latest layout");
    host.config("hshifter", configs[3]->list()); host.config("truck", configs[4]->list()); host.frame_end();
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "checkpoint"), "the second hshifter and truck callbacks");
    // A truck clear makes the counts not-observed and keeps the layout (minor1/snapshot-counts-not-observed).
    scs_named_value_t empty[]{{}};
    host.config("truck", empty); host.frame_end();
    require(gearbox_wire(*adapter) == fixture_gearbox(minor1, "snapshot-counts-not-observed"), "truck clear: counts not observed, layout kept");
    adapter->shutdown(); adapter->attach_events(nullptr);
  }
  // Synthetic edge cases: empty, null, partial, over-bound and inconsistent lists.
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params();
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_ok, "gearbox edge init"); read(*adapter);
  auto channel = std::make_unique<v1::EventChannel>(); require(channel->prepare(), "v1 channel prepared");
  adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable); host.frame_end();
  const auto run2 = cap01_configs(fixtures / "simulator-v1" / "cap01" / "cap01-run2.json");
  const auto layout = [&](const scs_named_value_t* list) { const Quiet quiet(*adapter, host, *channel); host.config("hshifter", list); host.frame_end(); quiet.check("hshifter edge case"); return part_reason(*adapter, "hshifter"); };
  const auto state = [&] { return v1_read(*adapter)->state.gearbox.hshifter.state; };
  require(layout(run2[1]->list()) == "available", "the CAP-01 layout");
  scs_named_value_t empty[]{{}};
  require(layout(empty) == "not-observed" && state() == v1::FieldState::not_observed, "an empty list replaces the layout with not-observed");
  require(layout(nullptr) == "invalid" && state() == v1::FieldState::invalid, "a null list is invalid");
  scs_named_value_t only_count[]{attribute("selector.count", u32(0)), {}};
  require(layout(only_count) == "available" && v1_read(*adapter)->state.gearbox.hshifter.value.selector_count == 0, "a layout with no slots");
  scs_named_value_t partial[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", u32(1), 0), {}};
  require(layout(partial) == "invalid" && state() == v1::FieldState::available, "an incomplete slot triple: copied, then invalid on the wire");
  scs_named_value_t over[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 64), attribute("slot.handle.position", u32(1), 64), attribute("slot.selectors", u32(0), 64), {}};
  require(layout(over) == "invalid" && state() == v1::FieldState::invalid, "slot index 64 is invalid, never truncated");
  scs_named_value_t edge[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 63), attribute("slot.handle.position", u32(1), 63), attribute("slot.selectors", u32(0), 63), {}};
  require(layout(edge) == "available", "slot index 63 is the last slot");
  scs_named_value_t wrong_gear[]{attribute("selector.count", u32(2)), attribute("slot.gear", u32(1), 0), attribute("slot.handle.position", u32(1), 0), attribute("slot.selectors", u32(0), 0), {}};
  scs_named_value_t wrong_count[]{attribute("selector.count", s32(2)), {}};
  scs_named_value_t wrong_handle[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", s32(1), 0), attribute("slot.selectors", u32(0), 0), {}};
  require(layout(wrong_gear) == "invalid" && layout(wrong_count) == "invalid" && layout(wrong_handle) == "invalid", "a type mismatch is invalid");
  scs_named_value_t disagree[]{attribute("selector.count", u32(2)), attribute("selector.count", u32(3), 0), {}};
  scs_named_value_t agree[]{attribute("selector.count", u32(2)), attribute("selector.count", u32(2), 0), {}};
  require(layout(disagree) == "invalid" && layout(agree) == "available", "selector.count copies must agree");
  scs_named_value_t uncounted[]{attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", u32(1), 0), attribute("slot.selectors", u32(0), 0), {}};
  scs_named_value_t unindexed[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1)), {}};
  scs_named_value_t repeated[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 0), attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", u32(1), 0), attribute("slot.selectors", u32(0), 0), {}};
  require(layout(uncounted) == "invalid" && layout(unindexed) == "invalid" && layout(repeated) == "invalid", "a missing count, an unindexed or a repeated slot attribute is invalid");
  scs_named_value_t duplicate[]{attribute("selector.count", u32(2)), attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", u32(1), 0), attribute("slot.selectors", u32(0), 0),
    attribute("slot.gear", s32(2), 1), attribute("slot.handle.position", u32(1), 1), attribute("slot.selectors", u32(0), 1), {}};
  scs_named_value_t range[]{attribute("selector.count", u32(1)), attribute("slot.gear", s32(1), 0), attribute("slot.handle.position", u32(1), 0), attribute("slot.selectors", u32(2), 0), {}};
  require(layout(duplicate) == "invalid" && layout(range) == "invalid", "a duplicate pair or out-of-range selectors are invalid on the wire");
  std::array<scs_named_value_t, max_attributes> unterminated{};
  for (auto& value : unterminated) value = attribute("selector.count", u32(2));
  require(layout(unterminated.data()) == "invalid", "an unterminated list is invalid");
  // Truck counts: a wrong type, a null list and an empty list.
  scs_named_value_t truck_wrong[]{attribute("id", text("truck.a")), attribute("gears.forward", s32(12)), attribute("gears.reverse", u32(4)), {}};
  host.config("truck", truck_wrong); host.frame_end();
  require(part_reason(*adapter, "forwardGears") == "invalid" && part_reason(*adapter, "reverseGears") == "available", "a mistyped gear count is invalid");
  host.config("truck", nullptr); host.frame_end();
  require(part_reason(*adapter, "forwardGears") == "invalid" && part_reason(*adapter, "reverseGears") == "invalid", "a null truck list makes unseen counts invalid");
  scs_named_value_t truck_none[]{attribute("id", text("truck.a")), {}};
  host.config("truck", truck_none); host.frame_end();
  require(part_reason(*adapter, "forwardGears") == "not-observed", "a truck without gear counts");
  // A worker holding the v1 slot never stalls the hshifter callback, and the layout reaches the next publication.
  host.config("hshifter", empty); host.frame_end();
  std::promise<void> held, release; auto release_signal = release.get_future();
  std::thread worker([&] { auto lock = AdapterTestAccess::hold_v1(*adapter); held.set_value(); release_signal.wait(); }); held.get_future().wait();
  auto callbacks = std::async(std::launch::async, [&] { host.config("hshifter", run2[1]->list()); host.frame_end(); });
  const bool completed = callbacks.wait_for(std::chrono::seconds(10)) == std::future_status::ready;
  release.set_value(); worker.join(); callbacks.get();
  require(completed, "the hshifter callback completes while a worker holds the v1 slot");
  require(state() == v1::FieldState::not_observed, "the contended publication keeps the older slot");
  host.frame_end(); require(part_reason(*adapter, "hshifter") == "available", "the layout reaches the next publication");
  adapter->shutdown(); adapter->attach_events(nullptr);
}

// ET-052 PR-3: the optional `mandatory.break` channel (s32 in-game minutes). The wire expectations are the hand-written
// minor-2 fixtures; the rest is written out by hand: zero is a value, NULL is not observed, a wrong type is invalid, a
// refused registration is not-supported and never fails initialization, and the channel changes nothing in v0 or CAP0.
std::string serialized(const v1::Json& node) { return ets2telemetry::v0::detail::serialize(node); }
// The encoded minor-2 `state.nextMandatoryBreak` of the adapter's current v1 slot, through the minor-2 contract decoder.
std::string break_wire(Adapter& adapter) {
  const auto current = v1_read(adapter); const v1::Encoder encoder(v1_identity(*current)); v1::StatusInfo status; status.continuity = current->continuity;
  const auto frame = v1::encode(encoder.checkpoint(1, UINT64_MAX, current->state, status, 2), 2);
  return serialized(v1::decode_payload(std::string(frame.begin() + 4, frame.end()), v1::Sender::server, 2).wire.at("data").at("state").at("nextMandatoryBreak"));
}
std::string fixture_break(const std::filesystem::path& minor2, const char* name) {
  return serialized(v1::decode_payload(read_file(minor2 / (std::string(name) + ".json")), v1::Sender::server, 2).wire.at("data").at("state").at("nextMandatoryBreak"));
}
// An adapter on the fake host with an attached v1 channel. Source frame timers increase strictly, so only a flagged restart
// or a game-time regression rotates the clock.
struct BreakRig {
  std::unique_ptr<Adapter> adapter = std::make_unique<Adapter>(); Host host; std::unique_ptr<v1::EventChannel> channel = std::make_unique<v1::EventChannel>(); std::uint64_t frames = 0;
  explicit BreakRig(const std::function<void(Host&)>& configure = {}, scs_result_t expected = SCS_RESULT_ok) {
    if (configure) configure(host);
    auto params = host.params();
    require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == expected, "break rig initialization result");
    if (expected != SCS_RESULT_ok) return;
    read(*adapter); require(channel->prepare(), "v1 channel prepared"); adapter->attach_events(channel.get()); channel->set_gate(v1::Gate::durable);
  }
  ~BreakRig() { adapter->shutdown(); adapter->attach_events(nullptr); }
  void start(std::uint32_t flags = 0) { scs_telemetry_frame_start_t frame{}; frame.render_time = frame.simulation_time = frame.paused_simulation_time = ++frames * 1000; frame.flags = flags; host.event(SCS_TELEMETRY_EVENT_frame_start, &frame); }
  // One frame that delivers `value` (nothing when `deliver` is false) and publishes it.
  std::unique_ptr<Snapshot> frame(const scs_value_t* value, bool deliver = true, std::uint32_t flags = 0) { start(flags); if (deliver) host.channel(Field::mandatory_break, value); host.frame_end(); return read(*adapter); }
  std::unique_ptr<Snapshot> current() const { auto output = std::make_unique<Snapshot>(); require(adapter->read_current(*output), "current v0 slot"); return output; }
  Reading<double> v0() const { return reading(*current(), Field::mandatory_break); }
  v1::Field<std::int32_t> v1_break() const { return v1_read(*adapter)->state.next_mandatory_break_min; }
};
void mandatory_break(const std::filesystem::path& fixtures) {
  const auto minor2 = fixtures / "protocol-v1" / "minor2";
  const auto expect = [&](Adapter& adapter, const char* fixture, const char* what) { require(break_wire(adapter) == fixture_break(minor2, fixture), what); };
  constexpr auto restart = SCS_TELEMETRY_FRAME_START_FLAG_timer_restart;
  // Values: positive, zero, negative, both s32 extremes, and a value that changes from frame to frame.
  {
    BreakRig rig; V1Ring ring; rig.host.event(SCS_TELEMETRY_EVENT_started);
    require(rig.host.channels.count("mandatory.break") == 1 && rig.host.channels.at("mandatory.break").type == SCS_VALUE_TYPE_s32, "registered once as the s32 channel mandatory.break");
    rig.frame(nullptr, false); ring.drain(*rig.channel);
    expect(*rig.adapter, "snapshot-break-not-observed", "before any callback the break is not observed");
    require(rig.v0().status == Availability::not_observed && rig.v1_break().state == v1::FieldState::not_observed, "not observed in v0 and v1 before any callback");
    const auto calls = rig.host.api_calls; const auto next = rig.channel->next_event_seq();
    struct Row { std::int32_t minutes; const char* fixture; };
    const Row rows[]{{95, "snapshot"}, {0, "snapshot-break-zero"}, {-30, "snapshot-break-negative"}, {INT32_MAX, "snapshot-break-int32-max"}, {INT32_MIN, "snapshot-break-int32-min"}};
    for (const auto& row : rows) {
      auto value = s32(row.minutes); const auto published = rig.frame(&value); const auto got = reading(*published, Field::mandatory_break);
      require(got.status == Availability::available && got.value == static_cast<double>(row.minutes), "the v0 channel reading holds the exact s32");
      require(rig.v1_break().available() && rig.v1_break().value == row.minutes, "the v1 copy holds the exact s32");
      expect(*rig.adapter, row.fixture, "the encoded break equals its hand-written fixture");
    }
    auto zero = s32(0); rig.frame(&zero);
    require(rig.v1_break().available() && rig.v1_break().value == 0 && break_wire(*rig.adapter) != fixture_break(minor2, "snapshot-break-not-observed"), "zero is available and distinct from unavailable");
    for (std::int32_t minutes = 95; minutes >= 92; --minutes) { auto value = s32(minutes); rig.frame(&value); require(rig.v1_break().value == minutes && rig.v0().value == minutes, "a changing value follows each frame"); }
    // The callback copies one value: no event, no eventSeq and no SDK call, and only the SDK thread ran.
    require(!rig.channel->front() && rig.channel->next_event_seq() == next && rig.host.api_calls == calls && rig.host.wrong_thread == 0, "the break callback emits no event and calls no SDK function");
  }
  // NULL is not observed, a wrong type is invalid, and a later valid reading recovers.
  {
    BreakRig rig; rig.host.event(SCS_TELEMETRY_EVENT_started);
    auto value = s32(40); rig.frame(&value);
    rig.frame(nullptr);
    require(rig.v0().status == Availability::not_observed && rig.v1_break().state == v1::FieldState::not_observed && !rig.v1_break().available(), "a NULL value is not observed, never zero");
    expect(*rig.adapter, "snapshot-break-not-observed", "NULL encodes as not-observed");
    const scs_value_t wrong_types[]{u32(5), floating(5), s64(5), boolean(true), text("5")};
    for (const auto& wrong : wrong_types) {
      rig.frame(&value);
      rig.frame(&wrong);
      require(rig.v0().status == Availability::invalid && rig.v1_break().state == v1::FieldState::invalid && !rig.v1_break().available(), "a wrong value type is invalid");
      expect(*rig.adapter, "snapshot-break-invalid", "a wrong type encodes as invalid");
    }
    auto zero = s32(0); rig.frame(&zero);
    require(rig.v0().status == Availability::available && rig.v1_break().available() && rig.v1_break().value == 0, "a valid reading recovers from invalid");
  }
  // Registration: any refusal of the optional channel is not-supported and initialization still succeeds.
  struct Refusal { const char* label; std::function<void(Host&)> configure; scs_result_t result; };
  const Refusal refusals[]{
    {"not found", [](Host& h) { h.missing = "mandatory.break"; }, SCS_RESULT_not_found},
    {"unsupported type", [](Host& h) { h.unsupported_type = "mandatory.break"; }, SCS_RESULT_unsupported_type},
    {"generic error", [](Host& h) { h.erroneous = "mandatory.break"; }, SCS_RESULT_generic_error},
    {"unsupported", [](Host& h) { h.erroneous = "mandatory.break"; h.erroneous_result = SCS_RESULT_unsupported; }, SCS_RESULT_unsupported},
    {"not now", [](Host& h) { h.erroneous = "mandatory.break"; h.erroneous_result = SCS_RESULT_not_now; }, SCS_RESULT_not_now},
    {"invalid parameter", [](Host& h) { h.erroneous = "mandatory.break"; h.erroneous_result = SCS_RESULT_invalid_parameter; }, SCS_RESULT_invalid_parameter}};
  for (const auto& refusal : refusals) {
    BreakRig rig(refusal.configure, SCS_RESULT_ok); const auto initial = rig.current();
    require(initial->channel_results[static_cast<std::size_t>(Field::mandatory_break)] == refusal.result, refusal.label);
    require(reading(*initial, Field::mandatory_break).status == Availability::not_supported, "a refused break registration is not-supported");
    require(!rig.host.channels.count("mandatory.break") && rig.host.channels.count("truck.speed") && rig.host.channels.count("game.time") && rig.host.channels.count("truck.world.placement") && rig.host.events.size() == 6, "every other channel and event is registered");
    rig.host.event(SCS_TELEMETRY_EVENT_started);
    auto speed = floating(12.5F); auto minutes = u32(500); scs_value_t placement{}; placement.type = SCS_VALUE_TYPE_dplacement; placement.value_dplacement.position = {1, 2, 3};
    rig.start(); rig.host.channel(Field::speed, &speed); rig.host.channel(Field::game_time, &minutes); rig.host.channel(Field::world_placement, &placement); rig.host.frame_end();
    const auto published = read(*rig.adapter);
    require(reading(*published, Field::speed).status == Availability::available && reading(*published, Field::speed).value == 12.5 && published->state.game_time_minutes.value == 500 && published->state.world_placement.status == Availability::available, "the other channels are intact");
    expect(*rig.adapter, "snapshot-break-not-supported", "a refused registration encodes as not-supported");
    rig.frame(nullptr, false, restart);
    require(rig.v0().status == Availability::not_supported && rig.v1_break().state == v1::FieldState::not_supported, "a timer restart keeps the capability verdict");
  }
  // A core channel stays strict: the same refusals still fail initialization and clean up.
  for (const char* core : {"truck.speed", "truck.world.placement"}) {
    BreakRig rig([&](Host& h) { h.erroneous = core; }, SCS_RESULT_generic_error);
    require(rig.host.channels.empty() && rig.host.events.empty(), "a refused core channel fails initialization and unregisters everything");
  }
  // Freshness: the previous frame's value does not survive a timer restart or a game-time regression unless the new frame
  // delivered it, and a value delivered outside any frame is never adopted as fresh.
  {
    BreakRig rig; rig.host.event(SCS_TELEMETRY_EVENT_started);
    auto value = s32(95); rig.frame(&value);
    rig.frame(nullptr, false, restart);
    require(rig.v0().status == Availability::not_observed && rig.v1_break().state == v1::FieldState::not_observed, "a timer restart without a new reading clears the break");
    auto fresh = s32(7); rig.frame(&fresh, true, restart);
    require(rig.v0().status == Availability::available && rig.v0().value == 7 && rig.v1_break().value == 7, "a break delivered in the restart frame stays");
    rig.host.channel(Field::mandatory_break, &value);
    rig.frame(nullptr, false, restart);
    require(rig.v0().status == Availability::not_observed, "a value delivered outside a frame is not adopted as fresh");
  }
  for (const bool break_first : {true, false}) {
    BreakRig rig; rig.host.event(SCS_TELEMETRY_EVENT_started);
    auto minutes = u32(500); auto value = s32(95);
    rig.start(); rig.host.channel(Field::game_time, &minutes); rig.host.channel(Field::mandatory_break, &value); rig.host.frame_end(); read(*rig.adapter);
    minutes = u32(100); value = s32(30); rig.start();
    if (break_first) { rig.host.channel(Field::mandatory_break, &value); rig.host.channel(Field::game_time, &minutes); } else { rig.host.channel(Field::game_time, &minutes); rig.host.channel(Field::mandatory_break, &value); }
    rig.host.frame_end(); read(*rig.adapter);
    require(rig.v0().status == Availability::available && rig.v0().value == 30 && rig.v1_break().value == 30, "the current frame's break survives a game-time regression in either order");
    minutes = u32(50); rig.start(); rig.host.channel(Field::game_time, &minutes); rig.host.frame_end(); read(*rig.adapter);
    require(rig.v0().status == Availability::not_observed && rig.v1_break().state == v1::FieldState::not_observed, "a regression frame without a break clears the previous frame's break");
  }
  // A truck configuration clears the dynamic channels like the others; each_frame delivery refills it.
  {
    BreakRig rig; rig.host.event(SCS_TELEMETRY_EVENT_started);
    scs_named_value_t truck[]{attribute("id", text("truck.model.a")), {}};
    auto value = s32(95); rig.frame(&value);
    rig.host.config("truck", truck); rig.host.frame_end(); read(*rig.adapter);
    require(rig.v0().status == Availability::not_observed && rig.v1_break().state == v1::FieldState::not_observed, "a truck configuration clears the break");
    value = s32(33); rig.start(); rig.host.config("truck", truck); rig.host.channel(Field::mandatory_break, &value); rig.host.frame_end(); read(*rig.adapter);
    require(rig.v0().value == 33 && rig.v1_break().value == 33, "a break delivered after the truck configuration stays");
    value = s32(44); rig.start(); rig.host.channel(Field::mandatory_break, &value); rig.host.config("truck", truck); rig.host.frame_end(); read(*rig.adapter);
    require(rig.v0().status == Availability::not_observed, "a break delivered before the truck configuration is cleared with the other dynamic channels");
  }
  // Lower minors never carry the break, whatever the slot holds.
  {
    BreakRig rig; rig.host.event(SCS_TELEMETRY_EVENT_started);
    auto value = s32(95); rig.frame(&value);
    const auto current = v1_read(*rig.adapter); const v1::Encoder encoder(v1_identity(*current)); v1::StatusInfo status; status.continuity = current->continuity;
    auto without = current->state; without.next_mandatory_break_min = {};
    for (const unsigned minor : {0U, 1U}) {
      require(v1::encode(encoder.checkpoint(1, UINT64_MAX, current->state, status, minor), minor) == v1::encode(encoder.checkpoint(1, UINT64_MAX, without, status, minor), minor), "lower-minor bytes are identical with and without a break");
      require(v1::encode(encoder.snapshot(1, UINT64_MAX, current->state, status, minor), minor) == v1::encode(encoder.snapshot(1, UINT64_MAX, without, status, minor), minor), "lower-minor snapshot bytes are identical with and without a break");
    }
    require(v1::encode(encoder.checkpoint(1, UINT64_MAX, current->state, status, 2), 2) != v1::encode(encoder.checkpoint(1, UINT64_MAX, without, status, 2), 2), "minor 2 carries the break");
  }
  // v0 and CAP0 isolation: a game that provides the channel and one that does not give the same v0 snapshots, ordering,
  // continuity, diagnostic batches and CAP0 envelopes, apart from the break reading itself.
  {
    const auto absent = isolation_run(true, 1), present = isolation_run(true, 2);
    require(absent.size() == present.size() && present.size() == 8, "break isolation frames");
    bool delivered = false; std::size_t observations = 0;
    for (std::size_t i = 0; i < absent.size(); ++i) {
      same_v0(*absent[i].snapshot, *present[i].snapshot, static_cast<std::size_t>(Field::mandatory_break));
      require(absent[i].evidence.size() == present[i].evidence.size(), "break isolation: CAP0 envelope count");
      for (std::size_t e = 0; e < absent[i].evidence.size(); ++e) same_cap0(absent[i].evidence[e], present[i].evidence[e]);
      require(absent[i].snapshot->state.channels[static_cast<std::size_t>(Field::mandatory_break)].status == Availability::not_supported, "the absent channel stays not-supported");
      delivered = delivered || present[i].snapshot->state.channels[static_cast<std::size_t>(Field::mandatory_break)].status == Availability::available;
      for (std::size_t o = 0; o < present[i].snapshot->observation_count; ++o) require(std::string(present[i].snapshot->observations[o].name.c_str()) != "mandatory.break", "no v0 diagnostic observation of the break");
      observations += present[i].snapshot->observation_count;
    }
    require(delivered && observations > 20, "the break was delivered and the script exercised diagnostics");
  }
}
}
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "missing-game-time-reset") missing_game_time_reset();
    else if (argc == 2 && std::string(argv[1]) == "callback-order-reset") game_time_reset_callback_orders();
    else if (argc == 2 && std::string(argv[1]) == "v1-capture") v1_capture_records();
    else if (argc == 2 && std::string(argv[1]) == "v1-state") v1_state_and_gate();
    else if (argc == 2 && std::string(argv[1]) == "v1-nonblocking") v1_nonblocking();
    else if (argc == 2 && std::string(argv[1]) == "v1-isolation") v1_isolation();
    else if (argc == 2 && std::string(argv[1]) == "v1-drain") v1_drain_into_store();
    else if (argc == 2 && std::string(argv[1]) == "v1-session") v1_session_boundary();
    // ET-050b: needs the repository's tests/fixtures directory for the CAP-01 replays and the minor-1 fixtures.
    else if (argc == 3 && std::string(argv[1]) == "v1-gearbox") v1_gearbox(argv[2]);
    // ET-052: the optional break channel; needs tests/fixtures for the hand-written minor-2 corpus.
    else if (argc == 3 && std::string(argv[1]) == "mandatory-break") mandatory_break(argv[2]);
    else {
      game_mode_evidence(); lifecycle(); config_terminal_and_bounds(); clocks_and_contention(); failure_cleanup(); deferred_log(); missing_game_time_reset(); game_time_reset_callback_orders(); game_time_reset_frame_delimitation();
      v1_capture_records(); v1_state_and_gate(); v1_nonblocking(); v1_isolation(); v1_drain_into_store(); v1_session_boundary();
    }
    std::cout << "SDK adapter: " << assertions << " checks passed; snapshot bytes=" << sizeof(Snapshot) << ", adapter bytes=" << sizeof(Adapter) << "\n"; return 0;
  }
  catch (const std::exception& error) { std::cerr << "SDK adapter failure: " << error.what() << '\n'; return 1; }
}
