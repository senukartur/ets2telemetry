// ET-112a game.log.txt generation fixtures (REG-003, REG-008), shared by tests/unit/hard-mode-reader.test.ts and
// tests/unit/profile-observation.test.ts. The incident cases keep only the sanitized timing of one owner session: the game
// process was created at 01:31:00.886 local time and wrote the header "Wednesday November 11 2026 @ 01:31:06", 5,114 ms
// later; the previous session's log header was 01:13:40. No path, profile name, account or other player data is kept.
// The header is local wall-clock time truncated to whole seconds. Expected outcomes are written by hand from the rule:
// admit only when header > process creation - 1000 ms and header <= observation time, with no upper delay bound.

/** Local wall-clock time on the incident day, matching how the reader interprets the header. */
export const incidentLocal = (hours: number, minutes: number, seconds: number, milliseconds = 0): number =>
  new Date(2026, 10, 11, hours, minutes, seconds, milliseconds).getTime();
/** The game's first log line for a local `HH:MM:SS` creation time on the incident day. */
export const generationHeader = (time: string): string => `************ : log created on : Wednesday November 11 2026 @ ${time}\n`;

export const INCIDENT_PROCESS_CREATED_MS = incidentLocal(1, 31, 0, 886);
export const INCIDENT_HEADER = generationHeader('01:31:06');
export const PREVIOUS_SESSION_HEADER = generationHeader('01:13:40');
/** A later observation of the incident session, used by the scheduled-check cases. */
export const INCIDENT_OBSERVED_MS = INCIDENT_PROCESS_CREATED_MS + 30_000;

export interface ProfileLogGenerationCase {
  name: string;
  scenario: 'REG-003' | 'REG-008';
  origin: 'sanitized incident timing' | 'synthetic';
  /** Process creation from the authenticated process inspection, UTC milliseconds. */
  processCreatedUtcMs: number;
  /** The log's first line, or an empty string for a log without any creation header. */
  header: string;
  /** The verification request's wall-clock time, UTC milliseconds. */
  atUtcMs: number;
  expected: 'admitted' | 'PROFILE_LOG_GENERATION';
}

const P = INCIDENT_PROCESS_CREATED_MS;
export const PROFILE_LOG_GENERATION_CASES: readonly ProfileLogGenerationCase[] = [
  {name: 'incident header 5,114 ms after process creation', scenario: 'REG-003', origin: 'sanitized incident timing',
    processCreatedUtcMs: P, header: INCIDENT_HEADER, atUtcMs: INCIDENT_OBSERVED_MS, expected: 'admitted'},
  {name: 'header in the process creation second', scenario: 'REG-003', origin: 'synthetic',
    processCreatedUtcMs: P, header: generationHeader('01:31:00'), atUtcMs: P + 10_000, expected: 'admitted'},
  {name: 'header truncated 999 ms below process creation', scenario: 'REG-003', origin: 'synthetic',
    processCreatedUtcMs: incidentLocal(1, 31, 0, 999), header: generationHeader('01:31:00'), atUtcMs: P + 10_000, expected: 'admitted'},
  {name: 'header 30 s after process creation', scenario: 'REG-003', origin: 'synthetic',
    processCreatedUtcMs: P, header: generationHeader('01:31:31'), atUtcMs: P + 60_000, expected: 'admitted'},
  {name: 'header 10 min after process creation', scenario: 'REG-003', origin: 'synthetic',
    processCreatedUtcMs: P, header: generationHeader('01:41:01'), atUtcMs: P + 11 * 60_000, expected: 'admitted'},
  {name: 'late attachment 3 h after the incident start', scenario: 'REG-003', origin: 'sanitized incident timing',
    processCreatedUtcMs: P, header: INCIDENT_HEADER, atUtcMs: P + 3 * 3_600_000, expected: 'admitted'},
  {name: 'header one second before the process creation second', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: P, header: generationHeader('01:30:59'), atUtcMs: P + 10_000, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'header exactly 1,000 ms before process creation', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: incidentLocal(1, 31, 0), header: generationHeader('01:30:59'), atUtcMs: P + 10_000, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'previous-session header', scenario: 'REG-008', origin: 'sanitized incident timing',
    processCreatedUtcMs: P, header: PREVIOUS_SESSION_HEADER, atUtcMs: INCIDENT_OBSERVED_MS, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'header after the observation time', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: P, header: generationHeader('01:31:03'), atUtcMs: P + 1_000, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'missing header', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: P, header: '', atUtcMs: INCIDENT_OBSERVED_MS, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'header with an unknown month', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: P, header: INCIDENT_HEADER.replace('November', 'Smarch'), atUtcMs: INCIDENT_OBSERVED_MS, expected: 'PROFILE_LOG_GENERATION'},
  {name: 'header with an unpadded hour', scenario: 'REG-008', origin: 'synthetic',
    processCreatedUtcMs: P, header: INCIDENT_HEADER.replace('@ 01:', '@ 1:'), atUtcMs: INCIDENT_OBSERVED_MS, expected: 'PROFILE_LOG_GENERATION'},
];
