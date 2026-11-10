import React from 'react';
import {Cloud, CloudOff} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {t} from '../i18n';
import {uploadView} from './view';
import type {UploadUiState} from './ui-controller';

/** The site sync chip (ET-110): one word for the connection, or the sending count while trips are being sent. */
export function SyncChip({state, language, onOpen}: {state: UploadUiState; language: AppLanguage; onOpen: () => void}) {
  const view = uploadView(state, language);
  if (!view.available) return null;
  const Icon = view.sync?.kind === 'offline' && !view.busy ? CloudOff : Cloud;
  return <button type="button" className="yu-sync-chip" data-tone={view.tone} onClick={onOpen} data-testid="shell.status.sync" aria-label={`${t('nav.account', undefined, language)}: ${view.chip}`}><Icon aria-hidden="true" />{view.chip}</button>;
}
