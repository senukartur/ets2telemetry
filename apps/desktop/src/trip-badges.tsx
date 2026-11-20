import React from 'react';
import {Check, Circle, CircleHelp, Construction, Diamond, Gem, Globe, Package, TriangleAlert, Truck, UserRound, UsersRound, Weight, Wine, X, Zap} from 'lucide-react';
import type {AdrClass, AppLanguage, CargoClassification, JournalOutcome} from '../../../packages/contracts/src';
import {Badge} from './components/ui/badge';
import {t} from './i18n';
import type {JournalBadge, JournalJobBadge, JournalJobLine, JournalModeBadge} from './journal-view';

export function cargoAdrClassName(adrClass: AdrClass, language: AppLanguage): string {
  return t(`cargo.adrClass.${adrClass}`, undefined, language);
}

export function CargoBadges({value, language, compact = false}: {value?: CargoClassification; language: AppLanguage; compact?: boolean}) {
  if (!value) return null;
  const badges: {id: 'adr' | 'heavy' | 'fragile' | 'valuable'; text: string; Icon: typeof Diamond; adrClass?: AdrClass}[] = [];
  if (value.adr.state === 'class') {
    const adrClass = value.adr.class;
    badges.push({id: 'adr', text: t('cargo.adr', {v: String(adrClass)}, language), Icon: Diamond, adrClass});
  }
  if (value.overweight || value.oversize || value.groups.includes('oversize')) badges.push({id: 'heavy', text: t('cargo.heavy', undefined, language), Icon: Weight});
  if (value.fragile) badges.push({id: 'fragile', text: t('cargo.fragile', undefined, language), Icon: Wine});
  if (value.valuable) badges.push({id: 'valuable', text: t('cargo.valuable', undefined, language), Icon: Gem});
  return badges.length ? <span className="yu-cargo-badges" data-testid="cargo-badges" data-layout={compact ? 'compact' : 'full'}>
    {badges.map(({id, text, Icon, adrClass}) => {
      const label = adrClass ? `${text}: ${cargoAdrClassName(adrClass, language)}` : text;
      return <Badge key={id} variant={id === 'adr' ? 'warn' : 'neutral'} data-cargo-classification={id}
        {...(compact ? {role: 'img', 'aria-label': label, title: label} : {})}>
        <Icon aria-hidden="true" />{compact ? adrClass && <span>{adrClass}</span> : <span>{text}</span>}
      </Badge>;
    })}
  </span> : null;
}

/** One presentation in the Journal, trip header and Live. Explanations stay outside the fixed-height badge. */
function BadgeLabel({children, note, noteTestId}: {children: React.ReactNode; note?: string | null; noteTestId?: string}) {
  return note ? <span className="yu-badge-label">{children}<small className="yu-badge-note" data-testid={noteTestId}>{note}</small></span> : children;
}

export function ModeBadge({mode, testId}: {mode: Pick<JournalModeBadge, 'kind' | 'text' | 'tone'>; testId?: string}) {
  const [label, ...notes] = mode.text.split(' · ');
  const Icon = mode.tone === 'warn' ? TriangleAlert : mode.kind === 'single-player' ? UserRound
    : ['truckersmp', 'haulmp', 'convoy'].includes(mode.kind) ? UsersRound : CircleHelp;
  return <BadgeLabel note={notes.length ? ` · ${notes.join(' · ')}` : null}><Badge variant={mode.tone} data-testid={testId} data-kind={mode.kind}>
    <Icon aria-hidden="true" /><span>{label}</span></Badge></BadgeLabel>;
}

export function JobTypeBadge({job, language, testId, noteTestId}: {job: JournalJobBadge | JournalJobLine; language: AppLanguage; testId?: string; noteTestId?: string}) {
  const [label, ...notes] = job.text.split(' · ');
  const unknown = job.kind === 'unavailable' || job.kind === 'other';
  const Icon = job.kind === 'world-of-trucks' ? Globe : job.kind === 'quick-job' ? Zap : job.kind === 'cargo-market' ? Package : job.kind === 'freight-market' ? Truck : CircleHelp;
  const note = unknown ? job.text : 'sub' in job ? job.sub : notes.join(' · ');
  return <BadgeLabel note={note} noteTestId={noteTestId}><Badge variant={job.kind === 'world-of-trucks' ? 'info' : 'neutral'} data-testid={testId} data-kind={job.kind}>
    <Icon aria-hidden="true" /><span>{unknown ? t(job.kind === 'other' ? 'j.otherJobType' : 'j.unknownJobType', undefined, language) : label}</span></Badge></BadgeLabel>;
}

export function CompletenessBadge({badge, testId}: {badge: JournalBadge; testId?: string}) {
  const Icon = badge.variant === 'secondary' ? Check : badge.variant === 'destructive' ? TriangleAlert : CircleHelp;
  return <Badge variant={badge.variant === 'secondary' ? 'ok' : badge.variant === 'destructive' ? 'warn' : 'neutral'} data-testid={testId}>
    <Icon aria-hidden="true" /><span>{badge.text}</span></Badge>;
}

export function OutcomeBadge({outcome, text, testId}: {outcome: JournalOutcome; text: string; testId?: string}) {
  const [label, ...notes] = text.split(' — ');
  const Icon = outcome === 'delivered' ? Check : outcome === 'cancelled' ? X : outcome === 'open' ? Circle : CircleHelp;
  return <BadgeLabel note={notes.length ? ` — ${notes.join(' — ')}` : null}><Badge variant={outcome === 'delivered' ? 'ok' : outcome === 'cancelled' ? 'error' : 'neutral'} data-testid={testId}>
    <Icon aria-hidden="true" /><span>{label}</span></Badge></BadgeLabel>;
}

export function SpecialTransportBadge({text, testId}: {text: string; testId?: string}) {
  return <Badge variant="warn" data-testid={testId}><Construction aria-hidden="true" /><span>{text}</span></Badge>;
}

export function ProfileBadge({text, testId}: {text: string; testId?: string}) {
  return <Badge variant="neutral" data-testid={testId}><CircleHelp aria-hidden="true" /><span>{text}</span></Badge>;
}
