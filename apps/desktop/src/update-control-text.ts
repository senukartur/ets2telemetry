import type {AppLanguage, ApplicationInfo, UpdateFailure, UpdateRefusal, UpdateView} from '../../../packages/contracts/src';
import {t, type I18nKey} from './i18n';
import {UNKNOWN_APP_VERSION} from './updater/update-view';
import type {ActionResultText, ActionSeverity} from './plugin-action-result';

// ET-055 UP10 and UP11: the words of the sidebar update control, the version line and the About check (docs/design/ui-spec.md,
// `shell.sidebar.update`, `shell.sidebar.version`). Pure: the update view and the application info come validated from
// main through the dashboard preload; every text is a fixed EN/RU string with at most the offered version or a percentage.

/** What the sidebar update control shows in one update state; null while the control is hidden. */
export interface UpdateControlText {
  readonly state: UpdateView['state'];
  /** The visible words of the button. */
  readonly label: string;
  /** The button's accessible name. */
  readonly accessibleName: string;
  /** Downloading, installing or restarting: the button stays focusable but `aria-disabled`, and a click does nothing. */
  readonly busy: boolean;
  /** `arrow-up` is lucide ArrowUpCircle, `refresh` RefreshCw. */
  readonly icon: 'arrow-up' | 'refresh';
  /** The button's tone: the accent for an offer, neutral while busy, warn for a refusal, error for a failure. */
  readonly tone: 'accent' | 'neutral' | 'warn' | 'error';
  /** The 10 px accent dot that marks an update the user can install or finish. */
  readonly dot: boolean;
  /** The download percentage 0–100 for `role=progressbar`, null otherwise. */
  readonly progress: number | null;
  /** The text of the persistent polite live region; never the changing percentage, so progress does not chatter. */
  readonly announcement: string;
  /** The fixed explanation of a failure code: the tooltip, the description and the assertive alert. Null otherwise. */
  readonly failure: string | null;
}

/** States in which the control is not shown (UP10): nothing to install, or this launch never checks. */
export const HIDDEN_UPDATE_STATES: readonly UpdateView['state'][] = Object.freeze(['idle', 'checking', 'unsupported']);

const REFUSAL_KEY: Readonly<Record<UpdateRefusal, I18nKey>> = Object.freeze({
  GAME_RUNNING: 'upd.refused.GAME_RUNNING', GAME_CHECK_FAILED: 'upd.refused.GAME_CHECK_FAILED', BUSY: 'upd.refused.BUSY', EXITING: 'upd.refused.EXITING'});
const FAILURE_KEY: Readonly<Record<UpdateFailure, I18nKey>> = Object.freeze({
  OFFLINE: 'upd.failure.OFFLINE', MANIFEST_INVALID: 'upd.failure.MANIFEST_INVALID', SIGNATURE_INVALID: 'upd.failure.SIGNATURE_INVALID',
  DOWNLOAD_FAILED: 'upd.failure.DOWNLOAD_FAILED', HASH_MISMATCH: 'upd.failure.HASH_MISMATCH', DISK_FULL: 'upd.failure.DISK_FULL',
  APPLY_FAILED: 'upd.failure.APPLY_FAILED', APPLY_TIMEOUT: 'upd.failure.APPLY_TIMEOUT'});

/** The fixed explanation of a failure code (EN/RU). */
export const updateFailureText = (failure: UpdateFailure, language: AppLanguage): string => t(FAILURE_KEY[failure], undefined, language);
/** The fixed text of a refusal code (EN/RU). */
export const updateRefusalText = (refusal: UpdateRefusal, language: AppLanguage): string => t(REFUSAL_KEY[refusal], undefined, language);

/** The sidebar control of `view` in `language`, or null while it is hidden (idle, checking, unsupported, or no view yet). */
export function updateControlText(view: UpdateView | undefined, language: AppLanguage): UpdateControlText | null {
  if (!view || HIDDEN_UPDATE_STATES.includes(view.state)) return null;
  const version = view.available ?? '';
  const plain = (fields: Pick<UpdateControlText, 'label' | 'busy' | 'icon' | 'tone' | 'dot'> & Partial<UpdateControlText>): UpdateControlText =>
    ({state: view.state, accessibleName: fields.label, progress: null, announcement: fields.label, failure: null, ...fields});
  switch (view.state) {
    case 'available': {
      const accessibleName = t('upd.availableA', {version}, language);
      return plain({label: t('upd.available', {version}, language), accessibleName, announcement: accessibleName, busy: false, icon: 'arrow-up', tone: 'accent', dot: true});
    }
    case 'downloading': {
      const progress = view.progress ?? 0;
      return plain({label: t('upd.downloading', {percent: progress}, language), announcement: t('upd.downloadingA', undefined, language), busy: true,
        icon: 'refresh', tone: 'neutral', dot: false, progress});
    }
    case 'installing': return plain({label: t('upd.installing', undefined, language), busy: true, icon: 'refresh', tone: 'neutral', dot: false});
    case 'restarting': return plain({label: t('upd.restarting', undefined, language), busy: true, icon: 'refresh', tone: 'neutral', dot: false});
    // A restart refused because a game runs keeps `ready` with the refusal; its words say what to do.
    case 'ready': return view.refusal
      ? plain({label: updateRefusalText(view.refusal, language), busy: false, icon: 'refresh', tone: 'warn', dot: true})
      : plain({label: t('upd.ready', undefined, language), busy: false, icon: 'refresh', tone: 'accent', dot: true});
    // The button stays enabled, so the user can try again once the game is closed (UP7).
    case 'refused': return plain({label: updateRefusalText(view.refusal ?? 'BUSY', language), busy: false, icon: 'arrow-up', tone: 'warn', dot: false});
    case 'failed': {
      const label = t('upd.failed', undefined, language), failure = updateFailureText(view.failure ?? 'DOWNLOAD_FAILED', language);
      return plain({label, busy: false, icon: 'refresh', tone: 'error', dot: false, failure});
    }
  }
  return null;
}

/** The version line (UP11): its visible text, the staging badge and the accessible name of the whole line. */
export interface VersionLineText {
  readonly text: string;
  /** "Staging" in both languages for a staging build, null otherwise. */
  readonly badge: string | null;
  readonly accessibleName: string;
}

/** The version line of `info` in `language`, or null before main's first application state. */
export function versionLineText(info: ApplicationInfo | undefined, language: AppLanguage): VersionLineText | null {
  if (!info) return null;
  // An unpackaged run shows that it is a development build, not a version a user could have installed.
  const text = !info.packaged ? t('ver.dev', undefined, language)
    : info.version === UNKNOWN_APP_VERSION ? t('ver.unknown', undefined, language) : t('ver.line', {version: info.version}, language);
  if (info.channel !== 'staging') return {text, badge: null, accessibleName: text};
  return {text, badge: t('ver.staging', undefined, language), accessibleName: `${text}, ${t('ver.stagingA', undefined, language)}`};
}

/**
 * The About check's answer. `pending` from the click until the update view reports a newer finished check, or until
 * ABOUT_CHECK_WAIT_MS pass (a check started within 10 s of the previous one does not run again; the controller says so
 * only by not changing `lastCheck`). The answer then stays until the next click.
 */
export type AboutCheckRequest = {readonly phase: 'pending'; readonly before: number | null} | {readonly phase: 'answered'; readonly before: number | null};
export const ABOUT_CHECK_WAIT_MS = 30_000;

export interface AboutCheckText {
  /** The button's words. */
  readonly button: string;
  /** A click does nothing: a check or an update runs. The button keeps focus (`aria-disabled`). */
  readonly busy: boolean;
  /** This launch never checks (unpackaged, portable, isolated or not a Squirrel install): the button is disabled with `note`. */
  readonly unsupported: boolean;
  /** The fixed note beside a disabled button, or null. */
  readonly note: string | null;
  /** The ET-045b action result next to the button, or null before the first click. */
  readonly result: ActionResultText | null;
}

const UPDATE_RUNNING: readonly UpdateView['state'][] = Object.freeze(['downloading', 'installing', 'restarting']);

/** The About check of `view` after the user's `request` (null before the first click). */
export function aboutCheckText(view: UpdateView | undefined, request: AboutCheckRequest | null, language: AppLanguage): AboutCheckText {
  const button = t('upd.check', undefined, language);
  if (!view || view.state === 'unsupported') return {button, busy: false, unsupported: true, note: t('upd.check.unsupported', undefined, language), result: null};
  const finished = view.lastCheck && view.lastCheck.atUtcMs !== request?.before ? view.lastCheck : null;
  const pending = request?.phase === 'pending' && !finished;
  const busy = pending || view.state === 'checking' || UPDATE_RUNNING.includes(view.state);
  const answer = (severity: ActionSeverity, message: string): ActionResultText => {
    const severityWord = t(`act.sev.${severity}`, undefined, language);
    return {severity, severityWord, title: t('act.title', {severity: severityWord, action: button}, language), message};
  };
  if (!request) return {button, busy, unsupported: false, note: null, result: null};
  if (pending) return {button, busy, unsupported: false, note: null, result: answer('info', t('upd.check.pending', undefined, language))};
  // After the wait, the latest finished check answers, if there is one.
  const last = finished ?? view.lastCheck;
  if (!last) return {button, busy, unsupported: false, note: null, result: null};
  const result = last.outcome === 'up-to-date' ? answer('success', t('upd.check.upToDate', undefined, language))
    : last.outcome === 'available' ? answer('info', t('upd.check.available', {version: view.available ?? ''}, language))
    : answer('failed', `${t('upd.check.failed', undefined, language)} ${updateFailureText(last.failure ?? 'OFFLINE', language)}`);
  return {button, busy, unsupported: false, note: null, result};
}
