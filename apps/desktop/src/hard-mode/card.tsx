import React, {useEffect, useState} from 'react';
import {Flame} from 'lucide-react';
import type {HardModeDetails, HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
import {Button} from '../components/ui/button';
import {Badge} from '../components/ui/badge';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/card';
import {Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger} from '../components/ui/sheet';
import {hardModeView, HARD_MODE_NOTICE} from './view';
export function HardModeBadge({short = false}: {short?: boolean}) {
  return <Badge data-testid="hard-mode-badge"><Flame className="mr-1 size-3" aria-hidden="true" />{short ? 'HM' : 'Hard Mode'}</Badge>;
}
export function HardModeTrip({qualified, details}: {qualified: boolean; details: HardModeDetails | null}) {
  return <section className="space-y-1" data-testid="trip-hard-mode"><h4 className="flex items-center gap-1 font-medium"><Flame className="size-4" aria-hidden="true" />Hard Mode</h4>
    <p>{qualified ? 'Qualifies' : 'Does not qualify'}{qualified ? <> <HardModeBadge /></> : null}</p>
    {details ? <><p>At opening: {details.opening.state}. Latest observation: {details.latest.state}. Manual delivery: {details.manualDelivery === null ? 'unknown / pending' : details.manualDelivery ? 'confirmed' : 'not confirmed'}.</p>
      {details.firstLoss ? <p>First loss: {details.firstLoss.rule ?? 'evidence'} — {details.firstLoss.reason}; detected {details.firstLoss.values?.map(v => v === null ? 'Unknown' : String(v)).join(' / ') ?? 'Unknown'}, {new Date(details.firstLoss.atUtcMs).toISOString()}.</p> : null}
      <p>Settings snapshots kept with the trip.</p></> : <p>Not evaluated. Historical and late-attached trips cannot qualify retroactively.</p>}
    <p className="text-xs text-muted-foreground">{HARD_MODE_NOTICE}</p>
  </section>;
}
export function HardModeCard() {
  const [status, setStatus] = useState<HardModeStatus>(() => ({assessment: unknownHardMode(Date.now()), trip: null}));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true, pending = false;
    const read = () => {
      if (pending) return;
      pending = true;
      void window.desktop.getHardModeStatus().then(value => {if (active) {setStatus(value); setNow(Date.now()); setError(false); setLoaded(true);}}, () => {if (active) {setStatus({assessment: unknownHardMode(Date.now()), trip: null}); setError(true);}}).finally(() => {pending = false;});
    };
    read(); const timer = setInterval(read, 1000);
    return () => {active = false; clearInterval(timer);};
  }, []);
  const view = hardModeView(status, now);
  const check = () => {setBusy(true); void window.desktop.refreshHardMode().then(setStatus, () => setError(true)).finally(() => setBusy(false));};
  return <Card data-testid="hard-mode-card" data-state={status.trip?.firstLoss ? 'lost' : status.assessment.state}><CardHeader><CardTitle><h2 className="flex items-center gap-2"><Flame className="size-5" aria-hidden="true" />{view.headline}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3"><p role="status">{!loaded ? 'Reading settings…' : `${view.passed} of 12 configured rules pass`}</p>
      <progress className="h-2 w-full" value={view.passed} max={12} aria-label="Configured Hard Mode rules passing" />
      {view.loss ? <p role="status" data-testid="hard-mode-loss">{view.loss}</p> : null}
      <ul className="grid grid-cols-2 gap-2 text-sm">{view.rows.map(row => <li key={row.id}>{row.state === 'pass' ? '✓' : row.state === 'fail' ? '✕' : '?'} {row.label}</li>)}</ul>
      <Sheet><SheetTrigger asChild><Button variant="outline" data-testid="hard-mode-checklist">View checklist</Button></SheetTrigger><SheetContent>
        <SheetTitle className="flex items-center gap-2 pr-6 text-lg font-semibold"><Flame className="size-5" aria-hidden="true" />Hard Mode checklist</SheetTitle><SheetDescription>{view.headline}. {view.passed} of 12 configured rules pass.</SheetDescription>
        <p>{view.source} · {view.age}</p><Button variant="outline" disabled={busy} onClick={check} data-testid="hard-mode-refresh">{busy ? 'Checking…' : 'Check again'}</Button>
        {error ? <p role="status">Settings could not be read. Required evidence is unknown.</p> : null}
        {view.loss ? <p role="status">{view.loss}</p> : null}
        <ol className="space-y-4">{view.rows.map(row => <li key={row.id} data-testid={`hard-mode-rule-${row.id}`} className="space-y-1 border-b pb-3">
          <p className="font-medium">{row.label}: {row.state}</p><p className="break-words font-mono text-xs">{row.keys}</p>
          <p className={row.state === 'fail' ? 'font-semibold text-destructive' : undefined}>Detected: {row.detected} · Required: {row.required}</p><p className="text-sm text-muted-foreground">{row.reason}</p>
        </li>)}</ol><p className="text-sm text-muted-foreground">{HARD_MODE_NOTICE}</p>
      </SheetContent></Sheet><p className="text-xs text-muted-foreground">Current settings pass is separate from delivered-trip qualification.</p>
    </CardContent></Card>;
}
