import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '../components/ui/select';
import React, {useState} from 'react';
import type {NowPlayingView, SettingsView} from '../../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/card';
import {Button} from '../components/ui/button';
import {Switch} from '../components/ui/switch';
import {Label} from '../components/ui/label';
import {Slider} from '../components/ui/slider';
import {RadioGroup, RadioGroupItem} from '../components/ui/radio-group';
import {DEFAULT_NOW_PLAYING} from './contract';
import {t} from '../i18n';
export function NowPlayingSettingsCard({settings, view, onSaved}: {settings: SettingsView | undefined; view: NowPlayingView | undefined; onSaved: (settings: SettingsView) => void}) {
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false), [opacity, setOpacity] = useState<number>();
  const saved = settings?.nowPlaying ?? DEFAULT_NOW_PLAYING, editing = view?.edit.active === true;
  const locked = !settings?.writable || pending;
  const text = (key: Parameters<typeof t>[0]) => t(key, undefined, settings?.language ?? 'en');
  const call = (run: () => Promise<unknown>) => {setPending(true); setFailed(false); void run().catch(() => setFailed(true)).finally(() => {setPending(false); setOpacity(undefined);});};
  const save = (run: () => Promise<SettingsView>) => call(() => run().then(onSaved));
  const finish = (outcome: 'save' | 'cancel') => save(() => window.desktop.finishNowPlayingEdit(outcome));
  return <Card size="sm" data-testid="now-playing-settings"><CardHeader><CardTitle><h2>{text('np.title')}</h2></CardTitle></CardHeader><CardContent className="space-y-4">
    <div className="flex items-center gap-2"><Switch id="now-playing-enabled" data-testid="now-playing-enabled" checked={saved.enabled} disabled={locked} onCheckedChange={value => save(() => window.desktop.setNowPlayingEnabled(value))} /><Label htmlFor="now-playing-enabled">{text('np.enabled')}</Label></div>
    {saved.enabled ? <>
      <p className="yu-muted">{text(`np.state.${view?.state ?? 'waiting'}`)}</p>
      <div className="yu-setting-row"><Label htmlFor="now-playing-source">{text('np.source')}</Label><Select value={view?.selection.kind === 'session' ? view.selection.id : 'automatic'} disabled={locked} onValueChange={value => {call(() => window.desktop.selectNowPlayingSource(value === 'automatic' ? {kind: 'automatic'} : {kind: 'session', id: value}));}}><SelectTrigger id="now-playing-source" data-testid="now-playing-source"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="automatic">{text('np.automatic')}</SelectItem>
        {view?.selection.kind === 'session' && !view.sources.some(source => view.selection.kind === 'session' && source.id === view.selection.id) ? <SelectItem value={view.selection.id}>{text('np.state.unavailable')}</SelectItem> : null}
        {view?.sources.map(source => <SelectItem key={source.id} value={source.id}>{source.sourceAppId}</SelectItem>)}
      </SelectContent></Select></div>
      <div><p id="now-playing-style-label">{text('np.style')}</p><RadioGroup aria-labelledby="now-playing-style-label" className="yu-segmented" value={saved.style} disabled={locked || editing} onValueChange={value => {if (value === 'minimal' || value === 'full') save(() => window.desktop.setNowPlayingStyle(value));}}>
        {(['minimal', 'full'] as const).map(style => <div key={style} className="yu-segment-option"><RadioGroupItem id={`np-${style}`} value={style} /><Label htmlFor={`np-${style}`}>{text(`np.${style}`)}</Label></div>)}
      </RadioGroup></div>
      <div><Label id="now-playing-opacity-label">{text('np.opacity')} — {opacity ?? saved.backgroundOpacity}%</Label><Slider labelId="now-playing-opacity-label" thumbId="now-playing-opacity" min={40} max={100} step={1} value={[opacity ?? saved.backgroundOpacity]} disabled={!settings?.writable} pending={pending} onValueChange={([value]) => setOpacity(value)} onValueCommit={([value]) => {if (value !== saved.backgroundOpacity) save(() => window.desktop.setNowPlayingBackgroundOpacity(value)); else setOpacity(undefined);}} /></div>
      <div className="flex gap-2">{editing ? <><Button disabled={locked} onClick={() => finish('save')}>{text('np.done')}</Button><Button variant="outline" disabled={pending} onClick={() => finish('cancel')}>{text('np.cancel')}</Button><Button variant="outline" disabled={locked} onClick={() => call(() => window.desktop.resetNowPlayingEditPlacement())}>{text('np.reset')}</Button></> : <Button variant="outline" disabled={locked} onClick={() => call(() => window.desktop.beginNowPlayingEdit())}>{text('np.edit')}</Button>}</div>
      {editing ? <p className="yu-muted">{text(view?.edit.placement === 'visible' ? 'np.drag' : 'np.focus')}</p> : null}
    </> : null}
    {failed ? <p role="status">{text('np.failed')}</p> : null}
  </CardContent></Card>;
}
