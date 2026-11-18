import React from 'react';
import {Check, CloudOff, Clock, Pause, Unlink, Upload} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import type {JournalSyncRow} from '../../../../packages/contracts/src/journal';
import {Badge} from '@/components/ui/badge';
import {journalSyncView} from './view';

export function JournalSyncBadge({row, language, testId = 'journal-row-sync'}: {row: JournalSyncRow; language: AppLanguage; testId?: string}) {
  const view = journalSyncView(row, language), Icon = row.state === 'sent' ? Check : row.state === 'held' ? Pause : row.state === 'sending' ? Upload : row.state === 'unavailable' ? CloudOff : row.state === 'unbound' ? Unlink : Clock;
  return <Badge variant={view.tone} title={view.hint} data-testid={testId}><Icon aria-hidden="true" />{view.text}<span className="sr-only">. {view.hint}</span></Badge>;
}
