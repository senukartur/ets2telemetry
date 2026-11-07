import React from 'react';
import {Cloud} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {t} from '../i18n';
import {uploadView} from './view';
import type {UploadUiState} from './ui-controller';

export function SyncChip({state, language, onOpen}: {state: UploadUiState; language: AppLanguage; onOpen: () => void}) {
  const view = uploadView(state, language);
  if (!view.available) return null;
  return <button type="button" className="yu-sync-chip" data-tone={view.tone} onClick={onOpen} data-testid="shell.status.sync" aria-label={`${t('nav.account', undefined, language)}: ${view.headline}`}><Cloud aria-hidden="true" />{view.headline}</button>;
}
