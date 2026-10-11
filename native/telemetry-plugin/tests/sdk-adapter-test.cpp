#include "sdk-adapter.hpp"
#include <algorithm>
#include <cmath>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "common/scssdk_telemetry_common_gameplay_events.h"

using namespace ets2telemetry::sdk;
namespace ets2telemetry::sdk {
struct AdapterTestAccess {
  static std::unique_lock<std::mutex> hold(Adapter& adapter) { return std::unique_lock<std::mutex>(adapter.publication_mutex_); }
  static std::unique_lock<std::mutex> hold_pending(Adapter& adapter) { return std::unique_lock<std::mutex>(adapter.pending_mutex_); }
  static bool no_pending(Adapter& adapter) { auto lock = hold_pending(adapter); return adapter.producer_.observation_count == 0; }
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
  std::string missing, erroneous;
  scs_event_t fail_event = 0, throw_event = 0;
  bool throw_cleanup = false;
  Host() { current = this; }
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
    if (name == current->erroneous) return SCS_RESULT_generic_error;
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
    require(host.events.empty() && host.channels.empty() && stopped->continuity.callback_failures == 16, "throwing unregister isolates all cleanup operations");
  }
  auto adapter = std::make_unique<Adapter>(); Host host; auto params = host.params(); host.erroneous = "truck.engine.rpm";
  require(adapter->initialize(SCS_TELEMETRY_VERSION_1_01, &params) == SCS_RESULT_generic_error && host.channels.empty() && host.events.empty(), "unexpected channel registration errors fail closed");
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
}
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "missing-game-time-reset") missing_game_time_reset();
    else if (argc == 2 && std::string(argv[1]) == "callback-order-reset") game_time_reset_callback_orders();
    else { lifecycle(); config_terminal_and_bounds(); clocks_and_contention(); failure_cleanup(); missing_game_time_reset(); game_time_reset_callback_orders(); game_time_reset_frame_delimitation(); }
    std::cout << "SDK adapter: " << assertions << " checks passed; snapshot bytes=" << sizeof(Snapshot) << ", adapter bytes=" << sizeof(Adapter) << "\n"; return 0;
  }
  catch (const std::exception& error) { std::cerr << "SDK adapter failure: " << error.what() << '\n'; return 1; }
}
