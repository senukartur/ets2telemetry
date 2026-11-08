import React, {useId} from 'react';
// Relative imports, so that renderer tests load the layout without the '@' alias (like info-hint.tsx).
import {Card} from '../components/ui/card';
import {Label} from '../components/ui/label';

// ET-078 (mockup T5): the presentational blocks of the Settings panels. A panel opens with its header; sections are
// cards of compact rows. They hold no state, so the panels and the cards render the same in tests.

/** A panel's heading (h2) and its optional muted subline. */
export function SettingsPanelHeader({title, sub}: {title: string; sub?: string}) {
  return <div className="yu-settings-head"><h2>{title}</h2>{sub ? <p>{sub}</p> : null}</div>;
}

interface SettingsSectionProps {
  /** A visible heading (h3) that names the section. */
  title?: string;
  /** The section's accessible name when it has no visible heading. */
  label?: string;
  /** A muted line at the right end of the heading row. */
  note?: React.ReactNode;
  /** The note's id, for a control that is described by it. */
  noteId?: string;
  testId?: string;
  children?: React.ReactNode;
}

/** A section card: an optional heading row, then its rows, one line between each. Only a named section is a region. */
export function SettingsSection({title, label, note, noteId, testId, children}: SettingsSectionProps) {
  const headingId = useId();
  return <Card size="sm" className="yu-settings-card" role={title || label ? 'region' : undefined} aria-labelledby={title ? headingId : undefined} aria-label={title ? undefined : label} data-testid={testId}>
    {title ? <div className="yu-settings-card-head"><h3 id={headingId}>{title}</h3>{note ? <p id={noteId} className="yu-settings-card-note">{note}</p> : null}</div> : null}
    {children}
  </Card>;
}

interface SettingRowProps {
  label: React.ReactNode;
  /** The control the label belongs to: the label is then a `<label>`. */
  labelFor?: string;
  /** The label's id, for a group or a slider named by it. */
  labelId?: string;
  hint?: React.ReactNode;
  hintId?: string;
  hintTestId?: string;
  testId?: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * One setting: its label and hint, then its controls as direct children of the row, so that an action's result region
 * can follow its button directly (ET-045b) and still span the row.
 */
export function SettingRow({label, labelFor, labelId, hint, hintId, hintTestId, testId, className, children}: SettingRowProps) {
  return <div className={className ? `yu-setting-row ${className}` : 'yu-setting-row'} data-testid={testId}>
    <div className="yu-setting-text">
      {labelFor ? <Label htmlFor={labelFor} id={labelId} className="yu-setting-label">{label}</Label> : <span id={labelId} className="yu-setting-label">{label}</span>}
      {hint ? <div id={hintId} className="yu-setting-hint" data-testid={hintTestId}>{hint}</div> : null}
    </div>
    {children}
  </div>;
}
