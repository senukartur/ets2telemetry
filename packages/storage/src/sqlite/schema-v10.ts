// Schema version 10 (ET-112c): the distance and fuel engine of each logical trip and the engine-1 ledger flags. Additive:
// no table rebuild, no backfill and no index. accounting_engine 0 and quantity_flags NULL keep the schema 9 meaning, so
// every existing group and ledger row stays on engine 0; the flag bits are QUANTITY_FLAGS of telemetry-core.
export const SCHEMA_V10: readonly string[] = [
  'ALTER TABLE logical_trips ADD COLUMN accounting_engine INTEGER NOT NULL DEFAULT 0 CHECK (accounting_engine IN (0, 1))',
  'ALTER TABLE logical_progress ADD COLUMN quantity_flags INTEGER CHECK (quantity_flags IS NULL OR quantity_flags BETWEEN 0 AND 65535)'
];
