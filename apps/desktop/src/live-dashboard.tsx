import React, {useMemo} from 'react';
import type {LiveTelemetry, UnitProfiles} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {liveDashboardText} from './live-dashboard-text';
import {STRINGS} from './strings';

/**
 * The complete live field set (ET-010b), a thin map over `liveDashboardText`. Values update at the bridge rate (at most
 * 20 Hz), so they carry no live region; the paused banner is a status.
 */
export function LiveDashboard({live, units}: {live: LiveTelemetry | undefined; units: UnitProfiles | undefined}) {
  const text = useMemo(() => liveDashboardText(live, units), [live, units]);
  return <Card size="sm" data-testid="live-telemetry"><CardHeader><CardTitle><h2>{STRINGS.liveTitle}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {text.paused ? <p role="status" data-testid="live-paused">{STRINGS.livePaused}</p> : null}
      {text.sections.map(section => <section key={section.id} data-testid={section.testId} className="space-y-1">
        <h3 className="font-medium">{section.title}</h3>
        {section.missing ? <p data-testid="live-job-missing">{section.missing}</p> : null}
        {section.rows.length ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {section.rows.map(row => <div key={row.id} className="contents">
            <dt>{row.label}{row.note ? <span className="text-xs text-muted-foreground"> (<span data-testid={`${row.testId}-note`}>{row.note}</span>)</span> : null}</dt>
            <dd><span data-testid={row.testId}>{row.value}</span>{row.reason ? <> (<span data-testid={`${row.testId}-reason`}>{row.reason}</span>)</> : null}</dd>
          </div>)}
        </dl> : null}
      </section>)}
    </CardContent></Card>;
}
