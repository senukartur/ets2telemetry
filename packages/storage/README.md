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

better-sqlite3 13.0.3 ships an N-API prebuild that the telemetry service loads under Electron. Only `src/sqlite`, the desktop storage worker and the Electron-runtime suite `tests/storage` (`npm run test:storage`) may import it. ESLint also keeps the SQLite core, `src/index.ts` and `tests/storage` out of Node unit tests, `tests/shared`, the other desktop modules and the Node-safe storage modules, including dynamic `import()`, literal `require('better-sqlite3')` and `createRequire`; see [docs/storage.md](../../docs/storage.md#tests) for what this does not cover. The ET-001 isolated probe in `apps/desktop/src/storage-worker.ts` is unchanged; running this core in the storage worker is ET-013 PR-2.
