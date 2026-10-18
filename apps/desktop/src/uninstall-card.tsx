import React, {useState} from 'react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {UNINSTALL_STRINGS} from './strings';
import {appUninstallResultText} from './uninstall-text';

/**
 * The Live tab's last card (ET-018 PR-4, plan U8 and U9): the data-loss warning and one button. Main asks for confirmation
 * in its own dialog, checks every game folder first and answers with fixed codes and target ids; the card shows the
 * answer through uninstall-text.ts, never a path. A portable or development copy answers that uninstalling is available
 * only in an installed copy.
 */
export function UninstallCard() {
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{line: string; folders: string[]} | null>(null);
  const uninstall = () => {
    setPending(true); setAnswer(null);
    void window.desktop.uninstallApplication().then(result => {setAnswer(appUninstallResultText(result)); setPending(result.outcome === 'started');},
      () => {setAnswer({line: UNINSTALL_STRINGS.requestFailed, folders: []}); setPending(false);});
  };
  return <Card size="sm" data-testid="uninstall-card"><CardHeader><CardTitle><h2>{UNINSTALL_STRINGS.title}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <Alert variant="destructive" data-testid="uninstall-warning"><AlertTitle>{UNINSTALL_STRINGS.warningTitle}</AlertTitle>
        <AlertDescription><ul className="list-disc space-y-1 pl-4">{UNINSTALL_STRINGS.warning.map(line => <li key={line}>{line}</li>)}</ul></AlertDescription></Alert>
      <Button size="sm" variant="destructive" disabled={pending} data-testid="uninstall-button" onClick={uninstall}>{pending && !answer ? UNINSTALL_STRINGS.pending : UNINSTALL_STRINGS.button}</Button>
      {answer ? <div className="space-y-1" role="status"><p data-testid="uninstall-result">{answer.line}</p>
        {answer.folders.map(line => <p key={line} className="text-sm" data-testid="uninstall-blocked-folder">{line}</p>)}</div> : null}
    </CardContent></Card>;
}
