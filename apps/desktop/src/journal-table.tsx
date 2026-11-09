import React from 'react';
import {Check, ChevronRight, Circle, CircleHelp, Construction, TriangleAlert, UserRound, UsersRound, X} from 'lucide-react';
import type {AppLanguage, JournalGame, JournalTripSync} from '../../../packages/contracts/src';
// Relative imports, so that renderer tests load the table without the '@' alias (like shell/settings-layout.tsx).
import {Badge} from './components/ui/badge';
import {Button} from './components/ui/button';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from './components/ui/table';
import {JournalSyncBadge} from './dashboard-upload/journal-sync';
import {HardModeBadge} from './hard-mode/card';
import {t} from './i18n';
import {InfoHint} from './info-hint';
import type {JournalBadge, JournalModeBadge, JournalTripRow} from './journal-view';

/**
 * The compact trip table (ET-076, mockup T3). It only presents the rows of one journal page: the row texts come from
 * journal-view.ts, and the site column exists only when the page carries sync facts. The container of the shadcn Table is
 * the horizontal scroller; the shell's content never scrolls sideways.
 */
export interface JournalOpenTrip {tripUuid: string; game: JournalGame}

const completenessVariant = (badge: JournalBadge) => badge.variant === 'secondary' ? 'ok' : badge.variant === 'destructive' ? 'warn' : 'neutral';

function ModeLine({mode}: {mode: JournalModeBadge}) {
  const Icon = mode.tone === 'warn' ? TriangleAlert : mode.kind === 'single-player' ? UserRound : mode.kind === 'truckersmp' || mode.kind === 'haulmp' ? UsersRound : CircleHelp;
  return <span className="yu-journal-mode" data-testid="journal-row-mode" data-kind={mode.kind} data-variant={mode.tone}><Icon aria-hidden="true" strokeWidth={1.8} /><span>{mode.text}</span></span>;
}

export function TripTable({rows, sync, language, onOpen}: {
  rows: readonly JournalTripRow[]; sync?: JournalTripSync; language: AppLanguage; onOpen: (trip: JournalOpenTrip) => void;
}) {
  const text = (key: Parameters<typeof t>[0]) => t(key, undefined, language);
  const incomeHint = t('ui.moreAbout', {v: text('col.income')}, language);
  return <Table className="yu-journal-table" data-testid="journal-table"><TableHeader><TableRow>
    <TableHead>{text('col.started')}</TableHead><TableHead>{text('col.gameMode')}</TableHead><TableHead>{text('col.cargo')}</TableHead><TableHead>{text('col.jobType')}</TableHead>
    <TableHead>{text('col.route')}</TableHead><TableHead className="yu-journal-num">{text('col.distance')}</TableHead>
    <TableHead className="yu-journal-num"><span className="yu-label-hint" style={{justifyContent: 'flex-end'}}>{text('col.income')}<InfoHint label={incomeHint}>{text('j.incomeNote')}</InfoHint></span></TableHead>
    <TableHead>{text('col.outcome')}</TableHead><TableHead>{text('col.recording')}</TableHead>
    {sync ? <TableHead data-testid="journal-sync-column">{text('col.sync')}</TableHead> : null}
    <TableHead><span className="sr-only">{text('col.open')}</span></TableHead>
  </TableRow></TableHeader><TableBody>
    {rows.map(row => {
      const OutcomeIcon = row.outcomeKind === 'delivered' ? Check : row.outcomeKind === 'cancelled' ? X : Circle;
      return <TableRow key={row.tripUuid} data-testid="journal-row" data-trip={row.tripUuid}>
        <TableCell data-testid="journal-row-started">{row.started}</TableCell>
        <TableCell data-testid="journal-row-game"><Badge variant={row.gameId} data-testid="journal-row-game-name">{row.game}</Badge>
          <div className="yu-journal-mode-line"><ModeLine mode={row.mode} /><InfoHint testId={`journal-mode-evidence-${row.tripUuid}`} label={t('ui.moreAbout', {v: text('col.gameMode')}, language)}>{row.mode.evidence}</InfoHint></div></TableCell>
        <TableCell><div data-testid="journal-row-cargo">{row.cargo}{row.isHardMode ? <> <HardModeBadge short language={language} /></> : null}</div></TableCell>
        <TableCell><div className={row.jobType.kind === 'world-of-trucks' ? 'yu-journal-job-world' : undefined}><Badge variant="neutral" className="yu-tag" data-testid="journal-row-job-type" data-kind={row.jobType.kind}>{row.jobType.text}</Badge></div>
          {row.jobType.sub ? <small data-testid="journal-row-job-sub">{row.jobType.sub}</small> : null}
          {row.specialTransport ? <div className="yu-journal-special" data-testid="journal-row-special"><Construction aria-hidden="true" strokeWidth={1.8} />{row.specialTransport}</div> : null}</TableCell>
        <TableCell><div data-testid="journal-row-route">{row.route}</div><small data-testid="journal-row-companies">{row.companies}</small></TableCell>
        <TableCell className="yu-journal-num"><div data-testid="journal-row-observed">{row.observedDistance}</div><small data-testid="journal-row-planned">{row.plannedOf}</small></TableCell>
        <TableCell className="yu-journal-num" data-testid="journal-row-expected">{row.expectedIncome}</TableCell>
        <TableCell data-testid="journal-row-outcome"><Badge variant={row.outcomeKind === 'delivered' ? 'ok' : row.outcomeKind === 'cancelled' ? 'error' : 'neutral'}><OutcomeIcon aria-hidden="true" className="size-3" />{row.outcome}</Badge></TableCell>
        <TableCell><Badge variant={completenessVariant(row.completeness)} data-testid="journal-row-completeness">{row.completeness.text}</Badge></TableCell>
        {sync ? <TableCell><JournalSyncBadge row={sync.rows.find(item => item.tripUuid === row.tripUuid)!} language={language} /></TableCell> : null}
        <TableCell><Button size="icon-sm" variant="ghost" className="yu-journal-open" aria-label={t('j.openTrip', {v: row.cargo}, language)} data-testid="journal-row-open" onClick={() => onOpen({tripUuid: row.tripUuid, game: row.gameId})}><ChevronRight aria-hidden="true" /></Button></TableCell>
      </TableRow>;
    })}
  </TableBody></Table>;
}
