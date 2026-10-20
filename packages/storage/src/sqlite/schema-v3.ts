// Forward-only ET-026 migration. Historical trips are explicitly unqualified and have no invented audit evidence.
export const SCHEMA_V3: readonly string[] = [
  'ALTER TABLE trips ADD COLUMN is_hard_mode INTEGER NOT NULL DEFAULT 0 CHECK (is_hard_mode IN (0, 1))',
  `ALTER TABLE trips ADD COLUMN hard_mode_details TEXT CHECK (hard_mode_details IS NULL OR (length(hard_mode_details) <= 16384 AND json_valid(hard_mode_details)))`
];
