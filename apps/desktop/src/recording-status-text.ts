// The user-visible text of the recording status (ET-015c PR-4, G8) for the dashboard's Application status card and the
// tray. A pure builder over AppState.health.recording: main validated the status, and this module only picks fixed
// texts from strings.ts. Renderer-safe: type imports and strings only. See docs/app-lifecycle.md#health-and-the-dashboard.
import type {AppLanguage, RecordingCode, RecordingHealth, RecordingLosses} from '../../../packages/contracts/src';
import {
  getPrototypeNoticeText, getRecordingAlertText, getRecordingCodeText, getRecordingLossText,
  getRecordingStateLabelText, getRecordingStateShortText, getRecordingStateText, getRecordingTargetBadgeText,
  getRecordingTargetShortText, getRecordingTargetText,
  getRecordingTripText, getStrings
} from './strings';

export interface RecordingStatusText {
  /** The Recording row's headline. */
  headline: string;
  /** The tray's short form, after `Recording: `. */
  short: string;
  /** The sidebar indicator's one- or two-word label; its tooltip shows the headline, detail, alert and losses. */
  label: string;
  /** The sidebar indicator's badge for a test database target; null for history and without a target. */
  testBadge: string | null;
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
const cause = (code: RecordingCode | null, language: AppLanguage): string => getRecordingCodeText(code ?? 'INTERNAL', language);
const withCause = (template: string, code: RecordingCode | null, language: AppLanguage): string => template.replace('{cause}', cause(code, language));

function tripLines(trip: Extract<RecordingHealth, {losses: RecordingLosses}>['trip'], language: AppLanguage): string[] {
  if (!trip) return [];
  const lines: string[] = [];
  const tripTexts = getRecordingTripText(language);
  if (trip.phase !== 'idle') {
    const base = trip.completeness ? tripTexts.completeness[trip.completeness] : tripTexts.open;
    const phase = tripTexts.phase[trip.phase];
    lines.push(phase ? `${base}; ${phase}` : base);
  }
  // ET-016 PR-7 (J9): an untracked job started before recording and has no trip yet, or a recording gap ended its trip.
  if (trip.untrackedJob) lines.push(tripTexts.untrackedJob);
  return lines;
}

function lossLines(losses: RecordingLosses, language: AppLanguage): string[] {
  const lines = LOSS_ORDER.filter(key => losses[key] > 0).map(key => getRecordingLossText(key, language).replace('{count}', String(losses[key])));
  if (!lines.length) return [];
  const strings = getStrings(language);
  return [strings.recordingLossesTitle, ...lines, ...(losses.restoreLoss > 0 ? [strings.recordingUpperBound] : [])];
}

/** The texts of one recording status. Every state and code has a fixed text; loss lines appear only for non-zero counts. */
export function recordingStatusText(status: RecordingHealth, language: AppLanguage = 'en'): RecordingStatusText {
  if (status.state === 'disabled' || status.state === 'unknown') {
    return {
      headline: getRecordingStateText(status.state, language),
      short: getRecordingStateShortText(status.state, language),
      label: getRecordingStateLabelText(status.state, language),
      testBadge: null,
      detail: [],
      losses: [],
      alert: null,
      notice: getPrototypeNoticeText(status.state, language)
    };
  }
  const caused = status.state === 'retrying' || status.state === 'stopped';
  const headline = caused ? withCause(getRecordingStateText(status.state, language), status.code, language) : getRecordingStateText(status.state, language);
  const shortState = caused ? withCause(getRecordingStateShortText(status.state, language), status.code, language) : getRecordingStateShortText(status.state, language);
  const target = getRecordingTargetText(status.target, language);
  const targetShort = getRecordingTargetShortText(status.target, language);
  const alert = status.state === 'retrying' ? getRecordingAlertText('retrying', language)
    : status.state === 'stopped' ? getRecordingAlertText('stopped', language)
    : status.state === 'live-only' ? getRecordingAlertText('liveOnly', language) : null;
  return {
    headline,
    short: targetShort ? `${shortState} · ${targetShort}` : shortState,
    label: getRecordingStateLabelText(status.state, language),
    testBadge: getRecordingTargetBadgeText(status.target, language),
    detail: [...(target ? [target] : []), ...tripLines(status.trip, language)],
    losses: lossLines(status.losses, language),
    alert,
    notice: status.target === 'history' ? getPrototypeNoticeText('history', language) : getPrototypeNoticeText('test', language)
  };
}
