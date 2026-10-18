// The in-app uninstall IPC contract between the dashboard and main (ET-018 PR-4, plan U8 and O8). Renderer-safe: no
// Node or Electron API, so the sandboxed preload can import it.

/** The one fixed invoke channel; it takes no argument. */
export const UNINSTALL_CHANNEL = 'app:uninstall';
