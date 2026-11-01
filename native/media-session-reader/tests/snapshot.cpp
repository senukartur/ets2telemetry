#include "fixture-provider.hpp"
int main() {
  winrt::init_apartment();
  media::FixtureProvider provider;
  media::SnapshotReader<media::FixtureProvider> reader(provider, L"s00000000000000000000000000000001");
  auto first = reader.snapshot({1, L""});
  auto sessions = first.GetNamedArray(L"sessions");
  const auto a = std::wstring(sessions.GetObjectAt(0).GetNamedString(L"id")), b = std::wstring(sessions.GetObjectAt(1).GetNamedString(L"id"));
  if (first.GetNamedObject(L"selected").GetNamedString(L"id") != a || provider.playback_reads != 3 || provider.metadata_reads != 1 || provider.cache_loads != 1) return 1;
  auto explicit_b = reader.snapshot({2, b});
  if (explicit_b.GetNamedObject(L"selected").GetNamedString(L"title") != L"Provider track B" || provider.cache_loads != 2) return 1;
  auto automatic = reader.snapshot({3, L""});
  if (automatic.GetNamedObject(L"selected").GetNamedString(L"id") != b || !automatic.GetNamedArray(L"sessions").GetObjectAt(0).GetNamedBoolean(L"current")) return 1;
  if (provider.cache_loads != 2 || automatic.GetNamedObject(L"selected").GetNamedNumber(L"revision") != explicit_b.GetNamedObject(L"selected").GetNamedNumber(L"revision")) return 1;
  provider.prepare(4);
  auto transition = reader.snapshot({4, b});
  if (provider.metadata_playback != L"paused") return 1;
  if (transition.GetNamedValue(L"selected").ValueType() != media::JsonValueType::Null || transition.GetNamedValue(L"error").ValueType() != media::JsonValueType::Null) return 1;
  if (transition.GetNamedArray(L"sessions").GetObjectAt(1).GetNamedString(L"playback") != L"playing") return 1;
  auto paused = reader.snapshot({5, b});
  if (paused.GetNamedObject(L"selected").GetNamedString(L"id") != b || paused.GetNamedObject(L"selected").GetNamedString(L"playback") != L"paused" || paused.GetNamedArray(L"sessions").GetObjectAt(1).GetNamedString(L"playback") != L"paused") return 1;
  if (provider.cache_loads != 2) return 1;
  auto prefer_playing = reader.snapshot({6, L""});
  if (prefer_playing.GetNamedObject(L"selected").GetNamedString(L"id") != a) return 1;
  provider.sessions = {provider.a};
  if (reader.snapshot({7, b}).GetNamedValue(L"selected").ValueType() != media::JsonValueType::Null) return 1;
  provider.b = std::make_shared<media::FixtureSession>(media::FixtureSession{L"Synthetic B", L"New provider track", L"playing"}); provider.sessions.push_back(provider.b);
  auto replaced = reader.snapshot({8, b});
  if (replaced.GetNamedValue(L"selected").ValueType() != media::JsonValueType::Null || replaced.GetNamedArray(L"sessions").GetObjectAt(1).GetNamedString(L"id") == b) return 1;
  provider.sessions.resize(33, provider.a);
  auto limit = reader.snapshot({9, L""});
  return limit.GetNamedString(L"error") == L"SESSION_LIMIT" && limit.GetNamedArray(L"sessions").Size() == 0 ? 0 : 1;
}
