/** Approved CAP-01a writer bounds; a longer interval must be selected explicitly at activation. */
export const CAPTURE_LIMITS = {pendingBytes: 2 * 1024 * 1024, fileBytes: 20 * 1024 * 1024, deadlineMs: 10 * 60 * 1000} as const;

export interface CaptureDisplay {id: string; bounds: {x: number; y: number; width: number; height: number}; scaleFactor: number; rotation: number}
/** A one-shot main-process grant forwarded with the first explicit ETS2/ATS selection only. */
export interface CaptureGrant {format: 'cap0'; deadlineMs: number; operatorLabel: string | null; displays: CaptureDisplay[]}
export const MAX_CAPTURE_MINUTES = 60;
const LABEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * Default off. Only ETS2TELEMETRY_CAPTURE=cap0 in the launch environment enables one capture interval.
 * ETS2TELEMETRY_CAPTURE_MINUTES (1-60, default 10) explicitly selects a different interval and
 * ETS2TELEMETRY_CAPTURE_LABEL records an operator label. Invalid values reject activation.
 */
export function captureActivation(environment: Record<string, string | undefined>): Omit<CaptureGrant, 'displays'> | undefined {
  const mode = environment.ETS2TELEMETRY_CAPTURE;
  if (mode === undefined || mode === '') return undefined;
  if (mode !== 'cap0') throw new Error('Unsupported capture activation');
  const minutes = environment.ETS2TELEMETRY_CAPTURE_MINUTES;
  let deadlineMs: number = CAPTURE_LIMITS.deadlineMs;
  if (minutes !== undefined && minutes !== '') {
    if (!/^[1-9][0-9]?$/.test(minutes) || Number(minutes) > MAX_CAPTURE_MINUTES) throw new Error('Invalid capture interval');
    deadlineMs = Number(minutes) * 60_000;
  }
  const label = environment.ETS2TELEMETRY_CAPTURE_LABEL;
  if (label !== undefined && label !== '' && !LABEL.test(label)) throw new Error('Invalid capture label');
  return {format: 'cap0', deadlineMs, operatorLabel: label ? label : null};
}
const finiteInteger = (value: unknown, limit: number) => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= limit;
/** Service-side validation of the grant crossing the main/utility boundary. */
export function validateCaptureGrant(value: unknown): CaptureGrant {
  const grant = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!grant || Object.keys(grant).length !== 4 || grant.format !== 'cap0' || !finiteInteger(grant.deadlineMs, MAX_CAPTURE_MINUTES * 60_000) || (grant.deadlineMs as number) < 60_000 ||
    !(grant.operatorLabel === null || (typeof grant.operatorLabel === 'string' && LABEL.test(grant.operatorLabel))) || !Array.isArray(grant.displays) || grant.displays.length > 16) throw new Error('Invalid capture grant');
  for (const display of grant.displays as unknown[]) {
    const d = display && typeof display === 'object' && !Array.isArray(display) ? display as Record<string, unknown> : undefined;
    const b = d?.bounds && typeof d.bounds === 'object' && !Array.isArray(d.bounds) ? d.bounds as Record<string, unknown> : undefined;
    if (!d || Object.keys(d).length !== 4 || typeof d.id !== 'string' || !/^[0-9]{1,20}$/.test(d.id) || !b || Object.keys(b).length !== 4 || !['x', 'y', 'width', 'height'].every(key => finiteInteger(b[key], 1_000_000)) ||
      typeof d.scaleFactor !== 'number' || !Number.isFinite(d.scaleFactor) || d.scaleFactor <= 0 || d.scaleFactor > 16 || !finiteInteger(d.rotation, 360)) throw new Error('Invalid capture display');
  }
  return grant as unknown as CaptureGrant;
}
