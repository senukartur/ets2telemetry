#include "protocol-v0.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>

using namespace ets2telemetry::v0;
namespace {
void check(bool ok, const std::string& name) { if (!ok) throw std::runtime_error(name); }
template<class F> void rejects(F f, const std::string& name) {
  bool rejected = false; try { f(); } catch (const ProtocolError&) { rejected = true; } check(rejected, name);
}
std::string read(const std::filesystem::path& p) {
  std::ifstream s(p, std::ios::binary); if (!s) throw std::runtime_error("Missing fixture: " + p.string());
  return {std::istreambuf_iterator<char>(s), std::istreambuf_iterator<char>()};
}
std::vector<std::string> split(const std::string& s, char delimiter) {
  std::vector<std::string> result; std::istringstream input(s); std::string part;
  while (std::getline(input, part, delimiter)) result.push_back(part); return result;
}
}
int main(int argc, char** argv) {
  try {
    check(argc == 2, "fixture directory argument"); const auto dir = std::filesystem::path(argv[1]);
    const auto load = [&](const std::string& name) { return decode_payload(read(dir / (name + ".json"))); };
    std::istringstream manifest(read(dir / "manifest.txt")); std::string filename, expected; unsigned fixtures = 0;
    while (manifest >> filename >> expected) {
      const auto payload = read(dir / filename);
      if (expected == "invalid") rejects([&] { decode_payload(payload); }, filename);
      else { check(expected == "valid", "unknown expected result"); auto parsed = decode_payload(payload); auto frame = encode_frame(parsed);
        auto roundtrip = decode_payload(std::string(frame.begin() + 4, frame.end())); check(roundtrip.kind == parsed.kind && roundtrip.seq == parsed.seq, filename + " roundtrip"); }
      ++fixtures;
    }
    check(fixtures >= 50, "shared fixture inventory");
    const auto negotiated = negotiate(load("hello")); check(negotiated.major == 0 && negotiated.minor == 0 && negotiated.diagnostics && !negotiated.durable_recording, "minor negotiation");
    rejects([&] { negotiate(load("snapshot")); }, "hello required for negotiation");
    check(*normalize_sdk_measurement(SdkField::odometer, {{12.5}, AvailabilityReason::not_observed}).reading.value == 12500, "odometer km to m");
    check(*normalize_sdk_measurement(SdkField::estimated_range, {{10}, AvailabilityReason::not_observed}).reading.value == 10000, "range km to m");
    check(*normalize_sdk_measurement(SdkField::average_consumption, {{0.25}, AvailabilityReason::not_observed}).reading.value == 25, "SDK mean L/km to L/100km");
    check(*normalize_sdk_measurement(SdkField::speed, {{0}, AvailabilityReason::not_observed}).reading.value == 0, "zero speed available");
    check(normalize_sdk_measurement(SdkField::fuel, {std::nullopt, AvailabilityReason::not_supported}).reading.reason == AvailabilityReason::not_supported, "unsupported channel remains unavailable");
    for (const auto value : {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), -1.0})
      check(!normalize_sdk_measurement(SdkField::fuel, {{value}, AvailabilityReason::not_observed}).reading.value, "invalid scalar unavailable");
    check(!normalize_sdk_measurement(SdkField::gear, {{1.5}, AvailabilityReason::not_observed}).reading.value, "fractional gear unavailable");
    // Invalid caller-owned trees must be rejected before copying/serializing their unbounded contents.
    auto huge_string = load("hello");
    std::get<Json::Object>(std::get<Json::Object>(huge_string.wire.value).at("data").value).at("clientInstanceId").value = std::string(1'000'000, 'x');
    rejects([&] { encode_frame(huge_string); }, "huge caller-owned invalid string");
    auto huge_array = load("diagnostic");
    std::get<Json::Object>(std::get<Json::Object>(huge_array.wire.value).at("data").value).at("observations").value = Json::Array(100'000, Json{nullptr});
    rejects([&] { encode_frame(huge_array); }, "huge caller-owned invalid observation array");
    auto expanded = load("diagnostic");
    auto& expanded_data = std::get<Json::Object>(std::get<Json::Object>(expanded.wire.value).at("data").value);
    Json::Array batch;
    for (unsigned i = 0; i < 32; ++i) batch.push_back(Json{Json::Object{
      {"channel", Json{std::string("channel") + std::to_string(i)}}, {"sdkType", Json{std::string("string")}},
      {"value", Json{Json::Object{{"available", Json{true}}, {"value", Json{std::string(1024, 'x')}}}}}, {"unit", Json{std::string("raw")}}
    }});
    expanded_data.at("observations").value = batch; check(encode_frame(expanded).size() < max_frame_bytes + 4, "maximum valid diagnostic batch");
    for (auto& obs : batch) std::get<Json::Object>(std::get<Json::Object>(obs.value).at("value").value).at("value").value = std::string(1024, '"');
    expanded_data.at("observations").value = std::move(batch);
    rejects([&] { encode_frame(expanded); }, "valid schema expanding beyond encoded byte bound");
    auto cp = load("checkpoint"); check(cp.source->origin == "synthetic", "synthetic provenance");
    check(cp.seq == 9007199254740994ULL && cp.capture.monotonic_ns == 9007199254740993ULL, "uint64 identity");
    check(cp.state->speed.reading.value && *cp.state->speed.reading.value == 0 && cp.state->speed.unit == "m/s", "zero speed");
    check(!cp.state->fuel.reading.value && cp.state->fuel.unit == "L", "unavailable fuel");
    check(cp.state->average_consumption.unit == "L/100km" && *cp.state->average_consumption.reading.value == 25, "SDK mean conversion contract");
    check(cp.state->window.value->handle == std::numeric_limits<std::uint64_t>::max(), "exact handle");
    check(cp.state->configuration.revision == 9007199254740993ULL, "config revision");
    check(cp.state->configuration.job.value->expected_income.raw_value == "9007199254740993.123456" && !cp.state->configuration.job.value->expected_income.currency_code, "raw money unknown currency");
    const auto diagnostic = load("diagnostic"); check(std::get<std::uint64_t>(*diagnostic.observations[0].reading.value) == std::numeric_limits<std::uint64_t>::max(), "exact diagnostic u64");
    check(std::get<std::string>(*diagnostic.observations[1].reading.value).empty(), "empty copied SDK string");
    check(std::get<std::string>(*load("escaped-unicode").observations[2].reading.value) == std::get<std::string>(*diagnostic.observations[2].reading.value), "Unicode scalar decoding");
    std::istringstream streams(read(dir / "streams.txt")); std::string name, request, inputs, outcome, effects; unsigned scenarios = 0;
    while (streams >> name >> request >> inputs >> outcome >> effects) {
      Consumer consumer(request == "1"); std::string applied;
      const auto run = [&] { for (const auto& input : split(inputs, ',')) { auto result = consumer.accept(load(input)); if (result) {
        if (!applied.empty()) applied += ','; applied += (result->hydration ? "1:" : "0:") + std::to_string(result->skipped_sequences); } } };
      if (outcome == "reject") { rejects(run, name); rejects([&] { consumer.accept(load("snapshot")); }, name + " stays closed"); }
      else { check(outcome == "accept", "unknown stream result"); run(); check(applied == effects, name + " checkpoint/skip semantics"); }
      ++scenarios;
    }
    check(scenarios >= 11, "shared ordering inventory");
    auto combined = encode_frame(load("hello")); const auto second = encode_frame(cp); combined.insert(combined.end(), second.begin(), second.end());
    for (std::size_t split_at = 0; split_at <= combined.size(); ++split_at) {
      FrameDecoder decoder; std::vector<std::string> kinds; const auto emit = [&](Message m) { kinds.push_back(m.kind); };
      decoder.push(combined.data(), split_at, emit); decoder.push(combined.data() + split_at, combined.size() - split_at, emit); decoder.end();
      check(kinds == std::vector<std::string>{"hello", "checkpoint"}, "arbitrary framing split");
    }
    auto unicode = encode_frame(diagnostic); FrameDecoder bytewise; unsigned observed = 0;
    for (const auto& b : unicode) bytewise.push(&b, 1, [&](Message) { ++observed; }); bytewise.end(); check(observed == 1, "bytewise Unicode");
    for (auto length : {0U, 65537U, 0xffffffffU}) {
      std::uint8_t header[4]; for (unsigned i = 0; i < 4; ++i) header[i] = static_cast<std::uint8_t>((length >> (8 * i)) & 255);
      FrameDecoder decoder; rejects([&] { decoder.push(header, 4, [](Message) {}); }, "length bound");
      rejects([&] { decoder.push(combined.data(), combined.size(), [](Message) {}); }, "failed decoder cannot resume");
    }
    const auto hello = encode_frame(load("hello"));
    for (auto n : {std::size_t(1), std::size_t(2), std::size_t(3), std::size_t(4), hello.size() - 1}) {
      FrameDecoder decoder; decoder.push(hello.data(), n, [](Message) {}); rejects([&] { decoder.end(); }, "truncated EOF");
    }
    FrameDecoder clean; clean.end(); rejects([&] { clean.push(hello.data(), hello.size(), [](Message) {}); }, "clean EOF closes");
    std::string exact = read(dir / "hello.json"); exact.resize(max_frame_bytes, ' ');
    std::vector<std::uint8_t> exact_frame{0, 0, 1, 0}; exact_frame.insert(exact_frame.end(), exact.begin(), exact.end());
    FrameDecoder exact_decoder; unsigned exact_count = 0; exact_decoder.push(exact_frame.data(), exact_frame.size(), [&](Message) { ++exact_count; }); exact_decoder.end(); check(exact_count == 1, "exact frame bound");
    std::vector<std::uint8_t> bad{1, 0, 0, 0, '{'}; bad.insert(bad.end(), hello.begin(), hello.end()); FrameDecoder malformed; unsigned emitted = 0;
    rejects([&] { malformed.push(bad.data(), bad.size(), [&](Message) { ++emitted; }); }, "malformed combined stream"); check(emitted == 0, "no resynchronization");
    Consumer consumer(true); consumer.accept(load("welcome")); consumer.accept(cp); auto skip = consumer.accept(load("snapshot"));
    check(skip->skipped_sequences == 3 && skip->continuity.lost_observations == 2, "skip is distinct from loss");
    consumer.accept(load("max-uint64")); rejects([&] { consumer.accept(load("snapshot")); }, "sequence exhaustion does not wrap");
    std::cout << fixtures << " shared payload fixtures; " << scenarios << " shared streams; framing and typed semantics passed\n"; return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
