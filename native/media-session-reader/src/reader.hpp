#pragma once
#include "protocol.hpp"
#include "policy.hpp"
#include <optional>

namespace media {
inline std::wstring reader_lifetime() {
  auto id = std::wstring(winrt::to_hstring(winrt::Windows::Foundation::GuidHelper::CreateNewGuid()));
  id.erase(std::remove_if(id.begin(), id.end(), [](wchar_t c) {return c == L'{' || c == L'}' || c == L'-';}), id.end());
  return L"s" + id;
}
/** Shared enumeration, identity, selection and coherence path; providers own OS reads and their selected-item cache. */
template<class Provider> class SnapshotReader {
  using Session = typename Provider::Session;
  struct Entry {Session session; Descriptor descriptor;};
  Provider& provider;
  std::vector<Entry> entries;
  uint64_t next = 0, revision = 0;
  std::wstring lifetime, previous, metadata;
  void clear() {try {provider.clear();} catch (...) {} entries.clear(); previous.clear(); metadata.clear();}
public:
  explicit SnapshotReader(Provider& source, std::wstring token = reader_lifetime()) : provider(source), lifetime(std::move(token)) {}
  JsonObject snapshot(Command const& command) {
    auto result = response(command.request);
    try {
      const auto sessions = provider.enumerate();
      if (sessions.size() > 32) {clear(); result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"SESSION_LIMIT")); return result;}
      const auto current = provider.current();
      std::vector<Entry> fresh;
      for (auto const& session : sessions) {
        const auto found = std::find_if(entries.begin(), entries.end(), [&](auto const& entry) {return entry.session == session;});
        const auto id = found == entries.end() ? lifetime + L"-" + std::to_wstring(++next) : found->descriptor.id;
        // Capture source/playback once. Descriptors, policy and the selected track all use this same observation.
        fresh.push_back({session, {id, std::wstring(clean(provider.source(session), 512)), provider.playback(session), session == current}});
      }
      entries = std::move(fresh);
      JsonArray descriptors; std::vector<Descriptor> policy;
      for (auto const& entry : entries) {
        auto const& captured = entry.descriptor;
        JsonObject descriptor;
        descriptor.SetNamedValue(L"id", JsonValue::CreateStringValue(captured.id));
        descriptor.SetNamedValue(L"sourceAppId", JsonValue::CreateStringValue(captured.source));
        descriptor.SetNamedValue(L"playback", JsonValue::CreateStringValue(captured.playback));
        descriptor.SetNamedValue(L"current", JsonValue::CreateBooleanValue(captured.current));
        descriptors.Append(descriptor); policy.push_back(captured);
      }
      result.SetNamedValue(L"sessions", descriptors);
      const auto chosen = choose(policy, command.selected, previous);
      const auto selected = std::find_if(entries.begin(), entries.end(), [&](auto const& entry) {return entry.descriptor.id == chosen;});
      if (selected == entries.end() || (selected->descriptor.playback != L"playing" && selected->descriptor.playback != L"paused")) {
        provider.clear(); previous.clear(); metadata.clear(); return result;
      }
      auto track = provider.read(selected->session);
      // A transition retires only this item, not the helper or its lifetime IDs. Retry on the next bounded poll.
      if (!track || provider.playback(selected->session) != selected->descriptor.playback) {metadata.clear(); return result;}
      JsonObject identity;
      for (auto key : {L"title", L"artist", L"album"}) identity.SetNamedValue(key, track->GetNamedValue(key));
      const auto fingerprint = chosen + std::wstring(identity.Stringify());
      if (fingerprint != metadata) {metadata = fingerprint; ++revision;}
      track->SetNamedValue(L"id", JsonValue::CreateStringValue(chosen));
      number(*track, L"revision", static_cast<double>(revision));
      track->SetNamedValue(L"playback", JsonValue::CreateStringValue(selected->descriptor.playback));
      previous = chosen; result.SetNamedValue(L"selected", *track); return result;
    } catch (...) {
      clear(); result = response(command.request); result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"API_ERROR")); return result;
    }
  }
};
}
