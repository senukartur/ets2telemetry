using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Sends only session messages to one already-owned test HWND. It cannot log off Windows or broadcast a message.
internal static class SessionEndSender {
  [DllImport("kernel32.dll", SetLastError = true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder image, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  static int Main(string[] args) {
    try {
      if (args.Length != 4 || (args[3] != "cancel" && args[3] != "end")) throw new ArgumentException("pid hwnd image cancel|end required");
      uint pid = UInt32.Parse(args[0]);
      var window = new IntPtr(Int64.Parse(args[1], System.Globalization.NumberStyles.HexNumber));
      if (pid == 0 || window == IntPtr.Zero || window == new IntPtr(-1) || !Path.IsPathRooted(args[2])) throw new ArgumentException("A specific process, HWND and absolute image are required");
      using (var process = OpenProcess(0x1000, false, pid)) {
        if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint owner;
        if (GetWindowThreadProcessId(window, out owner) == 0 || owner != pid) throw new InvalidOperationException("HWND does not belong to the launched application");
        var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
        if (!QueryFullProcessImageName(process, 0, image, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!String.Equals(Path.GetFullPath(image.ToString()), Path.GetFullPath(args[2]), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Owned process image changed");
        IntPtr result; bool delivered = true; int sendError = 0; bool targetActive = true;
        if (args[3] == "cancel") {
          if (SendMessageTimeout(window, 0x11, IntPtr.Zero, new IntPtr(0x80000000L), 2, 2000, out result) == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());
          if (result == IntPtr.Zero) throw new InvalidOperationException("Application vetoed the test query");
          if (SendMessageTimeout(window, 0x16, IntPtr.Zero, new IntPtr(0x80000000L), 2, 2000, out result) == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        } else {
          // Electron can terminate its target before SendMessageTimeout returns; the driver observes that process exit.
          SetLastError(0);
          delivered = SendMessageTimeout(window, 0x16, new IntPtr(1), new IntPtr(0x80000000L), 2, 2000, out result) != IntPtr.Zero;
          sendError = Marshal.GetLastWin32Error();
          uint code;
          if (!GetExitCodeProcess(process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
          targetActive = code == 259;
          if (!delivered && targetActive) throw new InvalidOperationException("WM_ENDSESSION did not complete and the target is still active; Win32 error " + sendError);
        }
        Console.WriteLine("{\"ownerPidVerified\":true,\"imageVerified\":true,\"verifiedPid\":" + owner +
          ",\"verifiedHwnd\":\"" + window.ToInt64().ToString("x", System.Globalization.CultureInfo.InvariantCulture) +
          "\",\"verifiedImage\":\"" + Path.GetFullPath(image.ToString()).Replace("\\", "\\\\").Replace("\"", "\\\"") +
          "\",\"broadcast\":false,\"mode\":\"" + args[3] +
          "\",\"sendReturnedSuccess\":" + delivered.ToString().ToLowerInvariant() + ",\"win32Error\":" + sendError + ",\"targetActiveAfterSend\":" + targetActive.ToString().ToLowerInvariant() + "}");
      }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
  }
}
