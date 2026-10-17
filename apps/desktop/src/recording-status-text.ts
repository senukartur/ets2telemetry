// The user-visible text of the recording status (ET-015c PR-4, G8) for the dashboard's Application status card and the
// tray. A pure builder over AppState.health.recording: main validated the status, and this module only picks fixed
// texts from strings.ts. Renderer-safe: type imports and strings only. See docs/app-lifecycle.md#health-and-the-dashboard.
import type {RecordingCode, RecordingHealth, RecordingLosses} from '../../../packages/contracts/src';
import {
  PROTOTYPE_NOTICE_TEXT, RECORDING_ALERT_TEXT, RECORDING_CODE_TEXT, RECORDING_LOSS_TEXT, RECORDING_STATE_SHORT_TEXT, RECORDING_STATE_TEXT,
  RECORDING_TARGET_SHORT_TEXT, RECORDING_TARGET_TEXT, RECORDING_TRIP_TEXT, STRINGS
} from './strings';

export interface RecordingStatusText {
  /** The Recording row's headline. */
  headline: string;
  /** The tray's short form, after `Recording: `. */
  short: string;
  /** Lines under the headline: the test database note and the current trip. */
  detail: string[];
  /** Committed losses since ETS2Telemetry started: a title line, one line per non-zero counter and the TD-004 note. Empty without losses. */
  losses: string[];
  /** The Alert's description while recording is retrying, stopped or live-only; null otherwise. */
  alert: string | null;
  /** The status card's prototype notice for this state. */
  notice: string;
}

/** The order of the loss lines. */
const LOSS_ORDER = ['lostEvents', 'eventLoss', 'notConnected', 'sampleLoss', 'restoreLoss', 'droppedSamples'] as const satisfies readonly (keyof RecordingLosses)[];
/** The cause of a retrying or stopped state; INTERNAL when the status carries none. */
const cause = (code: RecordingCode | null): string => RECORDING_CODE_TEXT[code ?? 'INTERNAL'];
const withCause = (template: string, code: RecordingCode | null): string => template.replace('{cause}', cause(code));

function tripLines(trip: Extract<RecordingHealth, {losses: RecordingLosses}>['trip']): string[] {
  if (!trip) return [];
  const lines: string[] = [];
  if (trip.phase !== 'idle') {
    const base = trip.completeness ? RECORDING_TRIP_TEXT.completeness[trip.completeness] : RECORDING_TRIP_TEXT.open;
    const phase = RECORDING_TRIP_TEXT.phase[trip.phase];
    lines.push(phase ? `${base}; ${phase}` : base);
  }
  // ET-016 PR-7 (J9): an untracked job started before recording and has no trip yet, or a recording gap ended its trip.
  if (trip.untrackedJob) lines.push(RECORDING_TRIP_TEXT.untrackedJob);
  return lines;
}

function lossLines(losses: RecordingLosses): string[] {
  const lines = LOSS_ORDER.filter(key => losses[key] > 0).map(key => RECORDING_LOSS_TEXT[key].replace('{count}', String(losses[key])));
  if (!lines.length) return [];
  return [STRINGS.recordingLossesTitle, ...lines, ...(losses.restoreLoss > 0 ? [STRINGS.recordingUpperBound] : [])];
}

/** The texts of one recording status. Every state and code has a fixed text; loss lines appear only for non-zero counts. */
export function recordingStatusText(status: RecordingHealth): RecordingStatusText {
  if (status.state === 'disabled' || status.state === 'unknown') {
    return {headline: RECORDING_STATE_TEXT[status.state], short: RECORDING_STATE_SHORT_TEXT[status.state], detail: [], losses: [], alert: null,
      notice: PROTOTYPE_NOTICE_TEXT[status.state]};
  }
  const caused = status.state === 'retrying' || status.state === 'stopped';
  const headline = caused ? withCause(RECORDING_STATE_TEXT[status.state], status.code) : RECORDING_STATE_TEXT[status.state];
  const shortState = caused ? withCause(RECORDING_STATE_SHORT_TEXT[status.state], status.code) : RECORDING_STATE_SHORT_TEXT[status.state];
  const target = RECORDING_TARGET_TEXT[status.target], targetShort = RECORDING_TARGET_SHORT_TEXT[status.target];
  const alert = status.state === 'retrying' ? RECORDING_ALERT_TEXT.retrying : status.state === 'stopped' ? RECORDING_ALERT_TEXT.stopped
    : status.state === 'live-only' ? RECORDING_ALERT_TEXT.liveOnly : null;
  return {
    headline,
    short: targetShort ? `${shortState} · ${targetShort}` : shortState,
    detail: [...(target ? [target] : []), ...tripLines(status.trip)],
    losses: lossLines(status.losses),
    alert,
    notice: status.target === 'history' ? PROTOTYPE_NOTICE_TEXT.history : PROTOTYPE_NOTICE_TEXT.test
  };
}
