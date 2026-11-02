#include "../src/policy.hpp"
#include <atomic>
#include <memory>
#include <thread>
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  const std::string test = argv[1];
  if (test == "selection") {
    std::vector<media::Descriptor> sessions{{L"s1", L"Player", L"paused", true}, {L"s2", L"Chrome", L"playing", false}};
    if (media::choose(sessions, L"", L"s1") != L"s2" || media::choose(sessions, L"s3", L"s2") != L"") return 1;
    sessions[0].playback = L"playing";
    if (media::choose(sessions, L"", L"s2") != L"s2" || media::choose(sessions, L"", L"") != L"s1") return 1;
    sessions[0].current = false;
    if (media::choose(sessions, L"", L"") != L"s2") return 1;
    sessions[0].playback = sessions[1].playback = L"paused";
    if (media::choose(sessions, L"", L"s1") != L"s1") return 1;
    sessions.clear(); return media::choose(sessions, L"", L"s1").empty() ? 0 : 1;
  }
  if (test == "artwork") {
    auto square = media::bounded_image(300, 300), wide = media::bounded_image(1500, 830), portrait = media::bounded_image(400, 800);
    if (square.width != 300 || square.height != 300 || wide.width != 512 || wide.height != 283 || portrait.width != 256 || portrait.height != 512) return 1;
    if (media::bounded_image(4000000000u, 4000000000u).width || media::bounded_image(0, 100).height || media::bounded_image(2001, 2000).width) return 1;
    return 0;
  }
  if (test == "lifetime") {
    auto state = std::make_shared<std::atomic_bool>(false);
    std::weak_ptr<std::atomic_bool> weak = state;
    std::thread before([weak] {media::mark_dirty(weak);}); before.join();
    if (!state->load()) return 1;
    state.reset();
    std::thread late([weak] {media::mark_dirty(weak);}); late.join();
    return weak.expired() ? 0 : 1;
  }
  return 2;
}
