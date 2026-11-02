#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>
#include <atomic>
#include <memory>
namespace media {
inline void mark_dirty(std::weak_ptr<std::atomic_bool> const& weak) {if (auto state = weak.lock()) state->store(true);}
struct Descriptor {std::wstring id, source, playback; bool current;};
inline std::wstring choose(std::vector<Descriptor> const& sessions, std::wstring const& explicit_id, std::wstring const& previous) {
  if (!explicit_id.empty()) {for (auto const& session : sessions) if (session.id == explicit_id) return session.id; return {};}
  for (auto tier : {L"playing", L"paused"}) {
    std::vector<Descriptor> candidates;
    for (auto const& session : sessions) if (session.playback == tier) candidates.push_back(session);
    if (candidates.empty()) continue;
    std::sort(candidates.begin(), candidates.end(), [](auto const& a, auto const& b) {return a.source == b.source ? a.id < b.id : a.source < b.source;});
    auto chosen = candidates.front().id;
    for (auto const& candidate : candidates) if (candidate.current) chosen = candidate.id;
    for (auto const& candidate : candidates) if (candidate.id == previous) chosen = candidate.id;
    return chosen;
  }
  return {};
}
struct ImageSize {uint32_t width, height;};
inline ImageSize bounded_image(uint32_t width, uint32_t height) {
  if (!width || !height || static_cast<uint64_t>(width) * height > 4000000) return {};
  const double scale = std::min(1.0, 512.0 / std::max(width, height));
  return {std::max(1u, static_cast<uint32_t>(width * scale)), std::max(1u, static_cast<uint32_t>(height * scale))};
}
}
