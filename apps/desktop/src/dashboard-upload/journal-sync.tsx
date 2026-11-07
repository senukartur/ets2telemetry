import React from 'react';
import {Check, CircleHelp, Clock, ShieldAlert, Upload} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import type {JournalSyncRow} from '../../../../packages/contracts/src/journal';
import {Badge} from '@/components/ui/badge';
import {journalSyncView} from './view';

export function JournalSyncBadge({row, language}: {row: JournalSyncRow; language: AppLanguage}) {
  const view = journalSyncView(row, language), Icon = row.state === 'sent' ? Check : row.state === 'held' ? ShieldAlert : row.state === 'sending' ? Upload : row.state === 'unavailable' ? CircleHelp : Clock;
  return <Badge variant={view.tone} title={view.hint} data-testid="journal-row-sync" className="whitespace-normal"><Icon aria-hidden="true" className="size-3 shrink-0" />{view.text}<span className="sr-only">. {view.hint}</span></Badge>;
}
