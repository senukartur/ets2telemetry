import React from 'react';
import {ArrowDown, ArrowUp, ArrowUpDown, ChevronRight} from 'lucide-react';
import type {AppLanguage, JournalGame, JournalTripsQuery, JournalTripSync} from '../../../packages/contracts/src';
// Relative imports, so that renderer tests load the table without the '@' alias (like shell/settings-layout.tsx).
import {Badge} from './components/ui/badge';
import {Button} from './components/ui/button';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from './components/ui/table';
import {JournalSyncBadge} from './dashboard-upload/journal-sync';
import {HardModeBadge} from './hard-mode/card';
import {t} from './i18n';
import {InfoHint} from './info-hint';
import type {JournalTripRow} from './journal-view';
import {CompletenessBadge, JobTypeBadge, ModeBadge, OutcomeBadge, ProfileBadge, SpecialTransportBadge} from './trip-badges';

/**
 * The compact trip table (ET-076, mockup T3). It only presents the rows of one journal page: the row texts come from
 * journal-view.ts, and the site column exists only when the page carries sync facts. The container of the shadcn Table is
 * the horizontal scroller; the shell's content never scrolls sideways.
 */
export interface JournalOpenTrip {tripUuid: string; game: JournalGame}

type Sort = {sort: NonNullable<JournalTripsQuery['sort']>; direction: NonNullable<JournalTripsQuery['direction']>};
export function TripTable({rows, sync, language, onOpen, sort, onSort, busy}: {
  rows: readonly JournalTripRow[]; sync?: JournalTripSync; language: AppLanguage; onOpen: (trip: JournalOpenTrip) => void;
  sort?: Sort; onSort?: (value: Sort) => void; busy?: boolean;
}) {
  const text = (key: Parameters<typeof t>[0]) => t(key, undefined, language);
  const incomeHint = t('ui.moreAbout', {v: text('col.income')}, language);
  const sortable = (key: Sort['sort'], label: string) => {
    const active = sort?.sort === key, Icon = active ? sort.direction === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown;
    return <TableHead className={key === 'distance' ? 'yu-journal-num' : undefined} aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className="yu-journal-sort" disabled={busy} data-testid={`journal-sort-${key}`} onClick={() => onSort?.({sort: key, direction: active ? sort.direction === 'desc' ? 'asc' : 'desc' : key === 'cargo' ? 'asc' : 'desc'})}>{label}<Icon aria-hidden="true" /></button></TableHead>;
  };
  return <Table className="yu-journal-table" data-testid="journal-table" data-has-site={Boolean(sync)}>
    <colgroup>{['started', 'game', 'cargo', 'job', 'route', 'distance', 'income', 'outcome', 'recording', ...(sync ? ['site'] : []), 'open']
      .map(column => <col key={column} className={`yu-journal-col-${column}`} />)}</colgroup><TableHeader><TableRow>
    {onSort ? sortable('started', text('col.started')) : <TableHead>{text('col.started')}</TableHead>}<TableHead>{text('col.gameMode')}</TableHead>{onSort ? sortable('cargo', text('col.cargo')) : <TableHead>{text('col.cargo')}</TableHead>}<TableHead>{text('col.jobType')}</TableHead>
    <TableHead>{text('col.route')}</TableHead>{onSort ? sortable('distance', text('col.distance')) : <TableHead className="yu-journal-num">{text('col.distance')}</TableHead>}
    <TableHead className="yu-journal-num"><span className="yu-label-hint" style={{justifyContent: 'flex-end'}}>{text('col.income')}<InfoHint label={incomeHint}>{text('j.incomeNote')}</InfoHint></span></TableHead>
    <TableHead>{text('col.outcome')}</TableHead><TableHead>{text('col.recording')}</TableHead>
    {sync ? <TableHead data-testid="journal-sync-column">{text('col.sync')}</TableHead> : null}
    <TableHead><span className="sr-only">{text('col.open')}</span></TableHead>
  </TableRow></TableHeader><TableBody>
    {busy && rows.length === 0 ? Array.from({length: 8}, (_, index) => <TableRow key={index} aria-hidden="true">{Array.from({length: sync ? 11 : 10}, (_, column) => <TableCell key={column}><span className="yu-journal-skeleton" /></TableCell>)}</TableRow>) : null}
    {rows.map(row => {
      return <TableRow key={row.tripUuid} data-testid="journal-row" data-trip={row.tripUuid}>
        <TableCell data-testid="journal-row-started"><time title={row.started}>{row.startedLabel}</time></TableCell>
        <TableCell data-testid="journal-row-game"><Badge variant={row.gameId} data-testid="journal-row-game-name">{row.game}</Badge>
          <div className="yu-journal-mode-line"><ModeBadge mode={row.mode} testId="journal-row-mode" /></div></TableCell>
        <TableCell><div data-testid="journal-row-cargo">{row.cargo}{row.isHardMode ? <> <HardModeBadge short language={language} /></> : null}</div></TableCell>
        <TableCell><JobTypeBadge job={row.jobType} language={language} testId="journal-row-job-type" noteTestId="journal-row-job-sub" />
          {row.specialTransport ? <div className="yu-journal-mode-line"><SpecialTransportBadge text={row.specialTransport} testId="journal-row-special" /></div> : null}</TableCell>
        <TableCell><div data-testid="journal-row-route">{row.route}</div><small data-testid="journal-row-companies">{row.companies}</small></TableCell>
        <TableCell className="yu-journal-num"><div data-testid="journal-row-observed">{row.observedDistance}</div></TableCell>
        <TableCell className="yu-journal-num" data-testid="journal-row-expected">{row.expectedIncome}</TableCell>
        <TableCell data-testid="journal-row-outcome"><OutcomeBadge outcome={row.outcomeKind} text={row.outcome} /></TableCell>
        <TableCell><CompletenessBadge badge={row.completeness} testId="journal-row-completeness" />
          {row.membership ? <div className="yu-journal-mode-line"><ProfileBadge text={row.membership} testId="journal-row-membership" /><InfoHint label={t('ui.moreAbout', {v: row.membership}, language)}>{text('j.membershipPendingHint')}</InfoHint></div> : null}</TableCell>
        {sync ? <TableCell><JournalSyncBadge row={sync.rows.find(item => item.tripUuid === row.tripUuid)!} language={language} /></TableCell> : null}
        <TableCell><Button size="icon-sm" variant="ghost" className="yu-journal-open" aria-label={t('j.openTrip', {v: row.cargo}, language)} data-testid="journal-row-open" onClick={() => onOpen({tripUuid: row.tripUuid, game: row.gameId})}><ChevronRight aria-hidden="true" /></Button></TableCell>
      </TableRow>;
    })}
  </TableBody></Table>;
}
