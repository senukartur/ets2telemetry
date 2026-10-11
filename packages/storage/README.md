# Storage boundary

The ET-001 isolated SQLite probe runs in the desktop storage worker under Electron. No production schema or migration exists yet. The pinned better-sqlite3 uses platform N-API prebuilds; Node unit tests still must never import the native storage addon. Actual Electron/package checks own that boundary.
