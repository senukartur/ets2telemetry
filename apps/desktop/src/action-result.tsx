import React from 'react';
import {Ban, CircleCheck, CircleX, Info, type LucideIcon} from 'lucide-react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import type {ActionResultText, ActionSeverity} from './plugin-action-result';

// ET-045b: the result of a user action, shown next to the control that started it. A tone, an icon and a severity word
// together carry the severity, never colour alone; the message is the fixed answer text. Presentational only.

const ICON: Readonly<Record<ActionSeverity, LucideIcon>> = Object.freeze({info: Info, success: CircleCheck, refused: Ban, failed: CircleX});

/** One result body: a shadcn Alert in the severity's Yukon tone. `role` is explicit because the Alert defaults to `alert`. */
export function ActionResult({id, testId, severity, severityWord, title, message, role}: ActionResultText & {id: string; testId: string; role?: 'alert'}) {
  const Icon = ICON[severity];
  // The title is "{severity} — {action}"; the severity word is marked so that it can be read on its own.
  const at = title.indexOf(severityWord);
  const before = at < 0 ? '' : title.slice(0, at), after = at < 0 ? ` ${title}` : title.slice(at + severityWord.length);
  return <Alert id={id} role={role} data-testid={testId} data-severity={severity} className="yu-action-result">
    <Icon aria-hidden="true" data-testid={`${testId}-icon`} />
    <AlertTitle data-testid={`${testId}-title`}>{before}<span data-testid={`${testId}-severity`}>{severityWord}</span>{after}</AlertTitle>
    <AlertDescription className="text-current" data-testid={`${testId}-message`}>{message}</AlertDescription>
  </Alert>;
}

/**
 * The region of one action's result, rendered from the first render so that screen readers track it. Information,
 * success and refusals appear inside the persistent polite live region; a failure appears alone, outside it, as an
 * assertive `role="alert"`, so it is announced once. The body's id is `<slot>-result`, which the trigger names in
 * aria-describedby while it is shown.
 */
export function ActionResultRegion({slot, result}: {slot: string; result: ActionResultText | null}) {
  const body = (role?: 'alert') => result ? <ActionResult {...result} id={`${slot}-result`} testId={`${slot}-result`} role={role} /> : null;
  const failed = result?.severity === 'failed';
  return <div data-testid={`${slot}-result-region`} className="yu-action-result-region">
    <div role="status" aria-live="polite" aria-atomic="true">{failed ? null : body()}</div>
    {failed ? body('alert') : null}
  </div>;
}
