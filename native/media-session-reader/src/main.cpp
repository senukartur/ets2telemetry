#include "protocol.hpp"
#include "policy.hpp"
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <cmath>
#include <memory>

using namespace winrt;
using namespace Windows::Media::Control;
using namespace Windows::Storage::Streams;
using namespace Windows::Graphics::Imaging;
using namespace media;

namespace {
std::wstring playback(GlobalSystemMediaTransportControlsSession const& session) {
  switch (session.GetPlaybackInfo().PlaybackStatus()) {
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing: return L"playing";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused: return L"paused";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped: return L"stopped";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed: return L"closed";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing: return L"changing";
    default: return L"unknown";
  }
}
IJsonValue artwork(GlobalSystemMediaTransportControlsSessionMediaProperties const& properties) {
  try {
    auto reference = properties.Thumbnail(); if (!reference) return JsonValue::CreateNullValue();
    auto input = reference.OpenReadAsync().get();
    if (input.Size() == 0 || input.Size() > 2 * 1024 * 1024) return JsonValue::CreateNullValue();
    auto decoder = BitmapDecoder::CreateAsync(input).get();
    const auto dimensions = bounded_image(decoder.PixelWidth(), decoder.PixelHeight());
    if (!dimensions.width || !dimensions.height) return JsonValue::CreateNullValue();
    const auto width = dimensions.width, height = dimensions.height;
    BitmapTransform transform; transform.ScaledWidth(width); transform.ScaledHeight(height);
    auto pixels = decoder.GetPixelDataAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, transform, ExifOrientationMode::IgnoreExifOrientation, ColorManagementMode::DoNotColorManage).get().DetachPixelData();
    InMemoryRandomAccessStream output;
    auto encoder = BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId(), output).get();
    encoder.SetPixelData(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, width, height, 96, 96, pixels); encoder.FlushAsync().get();
    if (!output.Size() || output.Size() > 256 * 1024) return JsonValue::CreateNullValue();
    output.Seek(0); DataReader reader(output); auto size = static_cast<uint32_t>(output.Size());
    if (reader.LoadAsync(size).get() != size) return JsonValue::CreateNullValue();
    auto bytes = reader.ReadBuffer(size);
    JsonObject result; number(result, L"width", width); number(result, L"height", height);
    result.SetNamedValue(L"png", JsonValue::CreateStringValue(Windows::Security::Cryptography::CryptographicBuffer::EncodeToBase64String(bytes)));
    return result;
  } catch (...) {return JsonValue::CreateNullValue();}
}
struct Entry {GlobalSystemMediaTransportControlsSession session{nullptr}; std::wstring id;};
class Reader {
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  std::vector<Entry> entries;
  uint64_t next = 0, revision = 0;
  std::wstring lifetime = [] {
    auto id = std::wstring(to_hstring(Windows::Foundation::GuidHelper::CreateNewGuid()));
    id.erase(std::remove_if(id.begin(), id.end(), [](wchar_t c) {return c == L'{' || c == L'}' || c == L'-';}), id.end());
    return L"s" + id;
  }();
  std::wstring previous;
  std::wstring metadata;
  GlobalSystemMediaTransportControlsSession watched{nullptr};
  event_token media_token{};
  std::shared_ptr<std::atomic_bool> dirty;
  GlobalSystemMediaTransportControlsSessionMediaProperties cached{nullptr};
  IJsonValue cached_art{JsonValue::CreateNullValue()};
  void unwatch() {
    if (watched) {watched.MediaPropertiesChanged(media_token); watched = nullptr;}
    dirty.reset(); cached = nullptr; cached_art = JsonValue::CreateNullValue();
  }
  void watch(GlobalSystemMediaTransportControlsSession const& session) {
    if (watched == session) return;
    unwatch(); watched = session; dirty = std::make_shared<std::atomic_bool>(true);
    std::weak_ptr<std::atomic_bool> weak = dirty;
    media_token = watched.MediaPropertiesChanged([weak](auto const&, auto const&) {mark_dirty(weak);});
  }
public:
  ~Reader() {try {unwatch();} catch (...) {}}
  JsonObject snapshot(Command const& command) {
    auto result = response(command.request);
    try {
      if (!manager) manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
      auto sessions = manager.GetSessions();
      if (sessions.Size() > 32) {unwatch(); entries.clear(); previous.clear(); result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"SESSION_LIMIT")); return result;}
      std::vector<Entry> fresh;
      for (auto const& session : sessions) {
        auto found = std::find_if(entries.begin(), entries.end(), [&](auto const& e) {return e.session == session;});
        fresh.push_back({session, found == entries.end() ? lifetime + L"-" + std::to_wstring(++next) : found->id});
      }
      entries = std::move(fresh);
      auto current = manager.GetCurrentSession(); JsonArray descriptors; std::vector<Descriptor> policy;
      Entry* selected = nullptr;
      for (auto& entry : entries) {
        JsonObject descriptor; descriptor.SetNamedValue(L"id", JsonValue::CreateStringValue(entry.id));
        descriptor.SetNamedValue(L"sourceAppId", JsonValue::CreateStringValue(clean(entry.session.SourceAppUserModelId(), 512)));
        descriptor.SetNamedValue(L"playback", JsonValue::CreateStringValue(playback(entry.session)));
        descriptor.SetNamedValue(L"current", JsonValue::CreateBooleanValue(entry.session == current)); descriptors.Append(descriptor);
        policy.push_back({entry.id, std::wstring(clean(entry.session.SourceAppUserModelId(), 512)), playback(entry.session), entry.session == current});
      }
      result.SetNamedValue(L"sessions", descriptors);
      auto chosen = choose(policy, command.selected, previous);
      for (auto& entry : entries) if (entry.id == chosen) selected = &entry;
      if (!selected) {unwatch(); previous.clear(); metadata.clear(); return result;}
      auto state = playback(selected->session);
      if (state != L"playing" && state != L"paused") {unwatch(); previous.clear(); metadata.clear(); return result;}
      watch(selected->session);
      // All asynchronous reads own their session/properties until completion. No event callbacks capture Reader state.
      const bool changed = dirty->exchange(false) || !cached;
      if (changed) {cached = nullptr; cached_art = JsonValue::CreateNullValue(); cached = selected->session.TryGetMediaPropertiesAsync().get(); cached_art = artwork(cached);}
      auto properties = cached;
      JsonObject track; text(track, L"title", properties.Title()); text(track, L"artist", properties.Artist()); text(track, L"album", properties.AlbumTitle());
      auto fingerprint = selected->id + std::wstring(track.Stringify());
      if (fingerprint != metadata) {metadata = fingerprint; ++revision;}
      track.SetNamedValue(L"id", JsonValue::CreateStringValue(selected->id)); number(track, L"revision", static_cast<double>(revision));
      track.SetNamedValue(L"playback", JsonValue::CreateStringValue(state)); track.SetNamedValue(L"artwork", cached_art);
      auto timeline = selected->session.GetTimelineProperties(); auto info = selected->session.GetPlaybackInfo();
      auto start = timeline.StartTime().count() / 10000, end = timeline.EndTime().count() / 10000, position = timeline.Position().count() / 10000;
      track.SetNamedValue(L"timeline", JsonValue::CreateNullValue());
      auto updated = timeline.LastUpdatedTime().time_since_epoch().count() / 10000 - 11644473600000LL;
      if (start >= 0 && end > start && end <= 9007199254740991LL && position >= start && position <= end && updated >= 0 && updated <= 9007199254740991LL) {
        JsonObject time; number(time, L"start", static_cast<double>(start)); number(time, L"end", static_cast<double>(end)); number(time, L"position", static_cast<double>(position));
        number(time, L"lastUpdatedUtc", static_cast<double>(updated));
        auto rate = info.PlaybackRate(); time.SetNamedValue(L"rate", rate && std::isfinite(rate.Value()) ? JsonValue::CreateNumberValue(rate.Value()) : JsonValue::CreateNullValue()); track.SetNamedValue(L"timeline", time);
      }
      // A session/track transition while artwork was read cannot attach the old thumbnail to new metadata.
      if (changed) {
        auto after = selected->session.TryGetMediaPropertiesAsync().get();
        if (after.Title() != properties.Title() || after.Artist() != properties.Artist() || after.AlbumTitle() != properties.AlbumTitle()) dirty->store(true);
      }
      if (dirty->load() || playback(selected->session) != state) {metadata.clear(); return result;}
      previous = selected->id; result.SetNamedValue(L"selected", track); return result;
    } catch (...) {try {unwatch();} catch (...) {} entries.clear(); previous.clear(); metadata.clear(); result = response(command.request); result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"API_ERROR")); return result;}
  }
};
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 3 || std::wstring(argv[1]) != L"--parent") return 2;
  wchar_t* end{}; auto pid = wcstoul(argv[2], &end, 10); if (!pid || !end || *end) return 2;
  winrt::handle parent(OpenProcess(SYNCHRONIZE, FALSE, pid)); if (!parent) return 2;
  // Parent death and stdin EOF retire even an OS async call which has not completed. The process owns no durable data.
  std::thread([handle = parent.get()] {WaitForSingleObject(handle, INFINITE); TerminateProcess(GetCurrentProcess(), 0);}).detach();
  std::mutex mutex; std::condition_variable ready; std::string pending; bool occupied = false;
  std::thread([&] {
    for (;;) {
      uint32_t length{}; if (!read_exact(GetStdHandle(STD_INPUT_HANDLE), &length, 4)) ExitProcess(0);
      if (length < 2 || length > 1024) ExitProcess(3);
      std::string bytes(length, '\0'); if (!read_exact(GetStdHandle(STD_INPUT_HANDLE), bytes.data(), length)) ExitProcess(0);
      {std::lock_guard<std::mutex> lock(mutex); if (occupied) ExitProcess(3); pending = std::move(bytes); occupied = true;} ready.notify_one();
    }
  }).detach();
  init_apartment(apartment_type::multi_threaded);
#ifndef MEDIA_READER_FIXTURE
  Reader reader;
#endif
  for (;;) {
    std::string bytes; {std::unique_lock<std::mutex> lock(mutex); ready.wait(lock, [&] {return occupied;}); bytes = std::move(pending);}
    try {
      auto request = command(bytes);
#ifdef MEDIA_READER_FIXTURE
      if (request.selected == L"s999") Sleep(INFINITE);
      if (request.selected == L"s998") {uint32_t length = 2; const char invalid[] = {static_cast<char>(0xff), static_cast<char>(0xff)}; write_exact(GetStdHandle(STD_OUTPUT_HANDLE), &length, 4); write_exact(GetStdHandle(STD_OUTPUT_HANDLE), invalid, 2); continue;}
      auto result = response(request.request);
#else
      auto result = reader.snapshot(request);
#endif
      auto output = to_string(result.Stringify()); auto length = static_cast<uint32_t>(output.size());
      {std::lock_guard<std::mutex> lock(mutex); occupied = false;}
      if (length > 1024 * 1024 || !write_exact(GetStdHandle(STD_OUTPUT_HANDLE), &length, 4) || !write_exact(GetStdHandle(STD_OUTPUT_HANDLE), output.data(), length)) ExitProcess(4);
    } catch (...) {ExitProcess(3);}
  }
}
