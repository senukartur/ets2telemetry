import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '../components/ui/select';
import React, {useState} from 'react';
import type {NowPlayingView, SettingsView} from '../../../../packages/contracts/src';
import {Button} from '../components/ui/button';
import {Switch} from '../components/ui/switch';
import {Slider} from '../components/ui/slider';
import {RadioGroup, RadioGroupItem} from '../components/ui/radio-group';
import {Label} from '../components/ui/label';
import {SettingRow, SettingsSection} from '../shell/settings-layout';
import {DEFAULT_NOW_PLAYING} from './contract';
import {mediaSourceName} from './presentation';
import {t} from '../i18n';
/** Settings > General > Current track (ET-061), as compact rows since ET-078; the locks and requests are unchanged. */
export function NowPlayingSettingsCard({settings, view, onSaved}: {settings: SettingsView | undefined; view: NowPlayingView | undefined; onSaved: (settings: SettingsView) => void}) {
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false), [opacity, setOpacity] = useState<number>();
  const saved = settings?.nowPlaying ?? DEFAULT_NOW_PLAYING, editing = view?.edit.active === true;
  const locked = !settings?.writable || pending;
  const text = (key: Parameters<typeof t>[0]) => t(key, undefined, settings?.language ?? 'en');
  const call = (run: () => Promise<unknown>) => {setPending(true); setFailed(false); void run().catch(() => setFailed(true)).finally(() => {setPending(false); setOpacity(undefined);});};
  const save = (run: () => Promise<SettingsView>) => call(() => run().then(onSaved));
  const finish = (outcome: 'save' | 'cancel') => save(() => window.desktop.finishNowPlayingEdit(outcome));
  return <SettingsSection title={text('np.title')} testId="now-playing-settings">
    <SettingRow label={text('np.enabled')} labelFor="now-playing-enabled" hint={text('np.enabledD')}>
      <Switch id="now-playing-enabled" data-testid="now-playing-enabled" checked={saved.enabled} disabled={locked} onCheckedChange={value => save(() => window.desktop.setNowPlayingEnabled(value))} />
    </SettingRow>
    {saved.enabled ? <>
      <p className="yu-setting-line yu-muted">{text(`np.state.${view?.state ?? 'waiting'}`)}</p>
      <SettingRow label={text('np.source')} labelFor="now-playing-source"><Select value={view?.selection.kind === 'session' ? view.selection.id : 'automatic'} disabled={locked} onValueChange={value => {call(() => window.desktop.selectNowPlayingSource(value === 'automatic' ? {kind: 'automatic'} : {kind: 'session', id: value}));}}><SelectTrigger id="now-playing-source" data-testid="now-playing-source"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="automatic">{text('np.automatic')}</SelectItem>
        {view?.selection.kind === 'session' && !view.sources.some(source => view.selection.kind === 'session' && source.id === view.selection.id) ? <SelectItem value={view.selection.id}>{text('np.state.unavailable')}</SelectItem> : null}
        {view?.sources.map(source => <SelectItem key={source.id} value={source.id}>{mediaSourceName(source.sourceAppId)}</SelectItem>)}
      </SelectContent></Select></SettingRow>
      <SettingRow label={text('np.style')} labelId="now-playing-style-label"><RadioGroup aria-labelledby="now-playing-style-label" className="yu-segmented" value={saved.style} disabled={locked || editing} onValueChange={value => {if (value === 'minimal' || value === 'full') save(() => window.desktop.setNowPlayingStyle(value));}}>
        {(['minimal', 'full'] as const).map(style => <div key={style} className="yu-segment-option"><RadioGroupItem id={`np-${style}`} value={style} /><Label htmlFor={`np-${style}`}>{text(`np.${style}`)}</Label></div>)}
      </RadioGroup></SettingRow>
      <SettingRow label={`${text('np.opacity')} — ${opacity ?? saved.backgroundOpacity}%`} labelId="now-playing-opacity-label">
        <div className="yu-setting-slider"><Slider labelId="now-playing-opacity-label" thumbId="now-playing-opacity" min={40} max={100} step={1} value={[opacity ?? saved.backgroundOpacity]} disabled={!settings?.writable} pending={pending} onValueChange={([value]) => setOpacity(value)} onValueCommit={([value]) => {if (value !== saved.backgroundOpacity) save(() => window.desktop.setNowPlayingBackgroundOpacity(value)); else setOpacity(undefined);}} /></div>
      </SettingRow>
      <SettingRow label={text('s.o.position')} hint={editing ? text(view?.edit.placement === 'visible' ? 'np.drag' : 'np.focus') : undefined}>
        <span className="yu-setting-controls">{editing ? <><Button size="sm" disabled={locked} onClick={() => finish('save')}>{text('np.done')}</Button><Button size="sm" variant="outline" disabled={pending} onClick={() => finish('cancel')}>{text('np.cancel')}</Button><Button size="sm" variant="outline" disabled={locked} onClick={() => call(() => window.desktop.resetNowPlayingEditPlacement())}>{text('np.reset')}</Button></> : <Button size="sm" variant="outline" disabled={locked} onClick={() => call(() => window.desktop.beginNowPlayingEdit())}>{text('np.edit')}</Button>}</span>
      </SettingRow>
    </> : null}
    {failed ? <p role="status" className="yu-setting-msg">{text('np.failed')}</p> : null}
  </SettingsSection>;
}
