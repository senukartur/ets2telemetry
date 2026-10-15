# Storage boundary

The durable history database of ET-013: schema version 1, verified durability settings, forward-only migrations with verified backups, restore into a new file, and typed write and read commands. The design, schema and error codes are in [docs/storage.md](../../docs/storage.md).

| Module | Loads native SQLite | Purpose |
| --- | --- | --- |
| `src/api.ts` | No | Command, result, error and trip-effect types |
| `src/codec.ts` | No | Exact encodings: 20-digit uint64 keys, raw money, availability columns, canonical JSON, sample masks |
| `src/errors.ts` | No | SQLite and operating-system failures mapped to stable, path-free error codes |
| `src/retention.ts` | No | Which pre-migration backups may be deleted |
| `src/sqlite/*` | Yes | Connection and durability, schema v1, migrations, backup and restore, logical digest, writes and reads |
| `src/index.ts` | Yes | In-process API (`openStorage`, `Storage`, `restoreBackup`) |
| `src/worker/protocol.ts` | No | Request and response messages between the client and the worker host |
| `src/worker/host.ts` | Yes | Serves requests on the storage worker thread with the in-process API |
| `src/client.ts` | No | `StorageClient`: one command at a time, a bounded queue, deadlines, fail-closed worker failures |

better-sqlite3 13.0.3 ships an N-API prebuild that the telemetry service loads under Electron. Only `src/sqlite`, the desktop storage worker and the Electron-runtime suite `tests/storage` (`npm run test:storage`) may import it. ESLint also keeps the SQLite core, `src/index.ts`, `src/worker/host.ts` and `tests/storage` out of Node unit tests, `tests/shared`, the other desktop modules and the Node-safe storage modules, including a dynamic `import()` or `require()` of those modules or of better-sqlite3 with a literal or expression-free template module name, and any `createRequire` call; see [docs/storage.md](../../docs/storage.md#tests) for what this does not cover. Since ET-013 PR-2, `apps/desktop/src/storage-worker.ts` runs the host in storage mode (`{kind: 'storage'}`) and keeps the unchanged ET-001 isolated probe for every other start; the telemetry service opens the history database through `StorageClient` ([docs/storage.md](../../docs/storage.md#storage-worker)).
