#pragma once
#include "pipe-security.hpp"
#include <mutex>

namespace ets2telemetry::transport {
// Lets a stopping thread cancel an owned worker's synchronous I/O only while the worker holds a window open, around
// reads whose cancellation it handles (peer image and policy inspection, v0 startup checks). Outside a window a
// cancelled synchronous call would fail silently: a discovery record deletion that ends with STATUS_CANCELLED leaves
// the record or its temporary file behind. The mutex orders each cancellation request with the window's open and close,
// so no request reaches synchronous I/O issued after the window has closed.
class CancelWindow final {
 public:
  // Worker side: the window is open for the lifetime of the scope.
  class Scope final {
   public:
    explicit Scope(CancelWindow& window) : window_(window) { window_.set(true); }
    ~Scope() { window_.set(false); }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
   private:
    CancelWindow& window_;
  };
  // Stopping thread: requests cancellation of `worker`'s synchronous I/O, and only while a window is open.
  void cancel(HANDLE worker) noexcept {
    try { std::lock_guard<std::mutex> lock(mutex_); if (open_) CancelSynchronousIo(worker); } catch (...) {}
  }
 private:
  void set(bool open) { std::lock_guard<std::mutex> lock(mutex_); open_ = open; }
  std::mutex mutex_; bool open_ = false;
};
}
