import React, {useId} from 'react';
import {Info} from 'lucide-react';
// A relative import, so that renderer tests load the hint without the '@' alias (like hard-mode/card.tsx).
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from './components/ui/tooltip';

/**
 * ET-057: an explanation behind an Info icon instead of a paragraph under its control. The tooltip opens on hover and on
 * keyboard focus (Radix closes it with Escape). The same text is the button's accessible description, held in a visually
 * hidden element that stays in the document, so a screen reader hears it without opening the tooltip and observations can
 * still read it by `testId`.
 */
export function InfoHint({label, children, side = 'top', align = 'center', testId, id: descriptionId}: {
  /** The subject, read as "More about: <label>"-style accessible name by the caller's text. */
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** The data-testid of the hidden description; its tooltip copy gets `<testId>-tooltip`. */
  testId?: string;
  /** The hidden description's id, for a control that is described by the same text (aria-describedby). */
  id?: string;
}) {
  const generated = useId(), id = descriptionId ?? generated;
  return <span className="yu-info-hint-wrap">
    <TooltipProvider delayDuration={150} skipDelayDuration={0}><Tooltip><TooltipTrigger asChild>
      <button type="button" className="yu-info-hint" aria-label={label} aria-describedby={id}><Info aria-hidden="true" /></button>
    </TooltipTrigger><TooltipContent side={side} align={align} data-testid={testId ? `${testId}-tooltip` : undefined}>
      <div className="space-y-1.5">{children}</div>
    </TooltipContent></Tooltip></TooltipProvider>
    <span id={id} className="sr-only" data-testid={testId}>{children}</span>
  </span>;
}
