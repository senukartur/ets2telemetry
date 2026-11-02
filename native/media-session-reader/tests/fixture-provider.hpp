#pragma once
#include "../src/reader.hpp"
#include <memory>
namespace media {
struct FixtureSession {std::wstring source, title, state = L"playing";};
/** Nonshipping OS substitute; SnapshotReader still owns production enumeration, IDs, history, revision and coherence. */
class FixtureProvider {
public:
  using Session = std::shared_ptr<FixtureSession>;
  Session a = std::make_shared<FixtureSession>(FixtureSession{L"Synthetic A", L"Provider track A", L"playing"});
  Session b = std::make_shared<FixtureSession>(FixtureSession{L"Synthetic B", L"Provider track B", L"playing"});
  std::vector<Session> sessions{a, b};
  Session windows_current = a;
  Session cached;
  bool transition_after_sample = false;
  std::wstring metadata_playback;
  int playback_reads = 0, metadata_reads = 0, cache_loads = 0;
  void prepare(double request) {transition_after_sample = request == 4;}
  std::vector<Session> enumerate() {return sessions;}
  Session current() {return windows_current;}
  winrt::hstring source(Session const& session) {return winrt::hstring(session->source);}
  std::wstring playback(Session const& session) {
    ++playback_reads; const auto captured = session->state;
    // Change after the descriptor sample, before any later policy/item or metadata read.
    if (transition_after_sample && session == b) {session->state = L"paused"; transition_after_sample = false;}
    return captured;
  }
  void clear() {cached.reset();}
  std::optional<JsonObject> read(Session const& session) {
    ++metadata_reads;
    metadata_playback = session->state;
    if (cached != session) {cached = session; ++cache_loads;}
    JsonObject track; text(track, L"title", winrt::hstring(session->title)); text(track, L"artist", L"Synthetic artist"); text(track, L"album", L"");
    track.SetNamedValue(L"timeline", JsonValue::CreateNullValue()); track.SetNamedValue(L"artwork", JsonValue::CreateNullValue());
    return track;
  }
};
}
