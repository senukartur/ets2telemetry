#include "protocol.hpp"
#include "reader.hpp"
#ifdef MEDIA_READER_PROVIDER_FIXTURE
#include "../tests/fixture-provider.hpp"
#endif
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
class WinRTProvider {
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
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
  using Session = GlobalSystemMediaTransportControlsSession;
  ~WinRTProvider() {try {unwatch();} catch (...) {}}
  void clear() {unwatch();}
  std::vector<Session> enumerate() {
    if (!manager) manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
    std::vector<Session> result;
    for (auto const& session : manager.GetSessions()) {result.push_back(session); if (result.size() > 32) break;}
    return result;
  }
  Session current() {return manager.GetCurrentSession();}
  hstring source(Session const& session) {return session.SourceAppUserModelId();}
  std::wstring playback(Session const& session) {return ::playback(session);}
  std::optional<JsonObject> read(Session const& session) {
      watch(session);
      // All asynchronous reads own their session/properties until completion. No event callbacks capture Reader state.
      const bool changed = dirty->exchange(false) || !cached;
      if (changed) {cached = nullptr; cached_art = JsonValue::CreateNullValue(); cached = session.TryGetMediaPropertiesAsync().get(); cached_art = artwork(cached);}
      auto properties = cached;
      JsonObject track; text(track, L"title", properties.Title()); text(track, L"artist", properties.Artist()); text(track, L"album", properties.AlbumTitle());
      track.SetNamedValue(L"artwork", cached_art);
      auto timeline = session.GetTimelineProperties(); auto info = session.GetPlaybackInfo();
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
        auto after = session.TryGetMediaPropertiesAsync().get();
        if (after.Title() != properties.Title() || after.Artist() != properties.Artist() || after.AlbumTitle() != properties.AlbumTitle()) dirty->store(true);
      }
      if (dirty->load()) return std::nullopt;
      return track;
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
#ifdef MEDIA_READER_PROVIDER_FIXTURE
  FixtureProvider provider;
  SnapshotReader<FixtureProvider> reader(provider);
#elif !defined(MEDIA_READER_FIXTURE)
  WinRTProvider provider;
  SnapshotReader<WinRTProvider> reader(provider);
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
#ifdef MEDIA_READER_PROVIDER_FIXTURE
      provider.prepare(request.request);
#endif
      auto result = reader.snapshot(request);
#endif
      auto output = to_string(result.Stringify()); auto length = static_cast<uint32_t>(output.size());
      {std::lock_guard<std::mutex> lock(mutex); occupied = false;}
      if (length > 1024 * 1024 || !write_exact(GetStdHandle(STD_OUTPUT_HANDLE), &length, 4) || !write_exact(GetStdHandle(STD_OUTPUT_HANDLE), output.data(), length)) ExitProcess(4);
    } catch (...) {ExitProcess(3);}
  }
}
