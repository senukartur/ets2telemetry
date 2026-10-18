/** A plain history row set read from one closed database (tests/storage/history-rows.ts). uint64 values are decimal strings. */
export interface HistoryRows {
  /** `PRAGMA integrity_check` (simple): `ok` for a sound file. */
  integrity: string;
  /** `PRAGMA foreign_key_check` rows; empty for a sound file. */
  foreignKeys: readonly unknown[];
  sessions: readonly {pluginSessionId: string; game: string; committedThroughEventSeq: string}[];
  events: readonly {pluginSessionId: string; eventSeq: string; type: string; firstRedelivered: boolean}[];
  gaps: readonly {pluginSessionId: string; firstEventSeq: string; lastEventSeq: string}[];
  trips: readonly {
    tripUuid: string; game: string; pluginSessionId: string; openedBy: 'event' | 'checkpoint'; openedEventSeq: string | null;
    outcome: 'open' | 'delivered' | 'cancelled' | 'none'; outcomeSessionId: string | null; outcomeEventSeq: string | null;
    closeReason: string | null; recordingCompleteness: 'complete' | 'partial' | 'unknown';
  }[];
  attributions: readonly {pluginSessionId: string; eventSeq: string; tripUuid: string | null; attribution: string}[];
  intervals: readonly {tripUuid: string | null; pluginSessionId: string; kind: string; firstEventSeq: string | null; lastEventSeq: string | null; annotation: boolean}[];
  samples: readonly {pluginSessionId: string; sourceClockId: string; monotonicNs: string}[];
}
/** An ACK written to a pipe: the plugin session and its `throughEventSeq`. */
export interface HistoryAck {pluginSessionId: string; throughEventSeq: string}
export interface HistoryViolation {invariant: 'I1' | 'I2' | 'I3' | 'I4' | 'I5'; rule: string; rows: unknown[]}
export const GAMEPLAY_EVENTS: readonly string[];
export function checkHistoryInvariants(rows: HistoryRows, acks?: readonly HistoryAck[]): HistoryViolation[];
export function formatViolations(violations: readonly HistoryViolation[]): string;
