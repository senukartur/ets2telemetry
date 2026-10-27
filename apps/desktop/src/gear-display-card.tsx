import React, {useMemo, useState} from 'react';
import type {AppLanguage, GearboxGearDisplay, GearDisplayMode, LiveTelemetry, SettingsView, UnitGame} from '../../../packages/contracts/src';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {chooseGearboxGearDisplay, chooseGearDisplay, GAME_GEAR_DISPLAY, type GearDisplayRequest} from './gear-display-choice';
import {DEFAULT_GEARBOX_GEAR_DISPLAY, findGearboxGearDisplay} from './gearbox-gear-display';
import {liveGearbox} from './live-sources';
import {DEFAULT_GEAR_DISPLAY, GEAR_DISPLAY_MODE_IDS, UNIT_GAMES} from './unit-profiles';
import {getSettingsSaveErrorText, getUnitGameText} from './strings';
import {t} from './i18n';

export interface GearDisplayCardProps {
  settings?: SettingsView;
  /** The latest live update; its current gearbox (ET-050b, settings v12) can get its own mode. */
  live?: LiveTelemetry;
  onSaved: (view: SettingsView) => void;
  /** Called before each request, so that the dashboard shows main's save error in this card. */
  onRequest?: () => void;
  /** True when this card made the last settings request. */
  showSaveError?: boolean;
}

/**
 * ET-050: the per-game gear display mode on Settings > Units. Each game has one labelled radio group, whose crawler
 * option names that game's crawler (ET-050b: C in ETS2, L in ATS); it shows only the
 * mode main has committed, so a failed save leaves the previous choice selected. The groups are disabled while a save is
 * in flight and while the settings cannot be saved.
 *
 * ET-050b settings v12: under its game, the current truck's gearbox (shown while the gearbox-aware rules apply) has its
 * own group, "as for the game" or one mode, and every gearbox with its own mode is listed with a button that returns it
 * to the game's mode.
 */
export function GearDisplayCard({settings, live, onSaved, onRequest, showSaveError}: GearDisplayCardProps) {
  const [request, setRequest] = useState<GearDisplayRequest>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const locked = !settings?.writable || request === 'saving';
  const current = useMemo(() => live ? liveGearbox(live) : undefined, [live]);
  const gearboxes = settings?.gearboxGearDisplay ?? DEFAULT_GEARBOX_GEAR_DISPLAY;
  const choose = (game: UnitGame, value: string) => {
    onRequest?.();
    void chooseGearDisplay(window.desktop, game, value, {onSaved, onState: setRequest});
  };
  const chooseGearbox = (game: UnitGame, gearbox: Pick<GearboxGearDisplay, 'model' | 'forwardGears' | 'reverseGears' | 'label'>, value: string) => {
    onRequest?.();
    void chooseGearboxGearDisplay(window.desktop, game, {model: gearbox.model, forwardGears: gearbox.forwardGears, reverseGears: gearbox.reverseGears},
      gearbox.label, value, {onSaved, onState: setRequest});
  };
  const modeText = (game: UnitGame, mode: GearDisplayMode) => t(mode === 'crawler' ? `s.gear.crawler.${game}` : `s.gear.${mode}`, undefined, language);
  const gearboxText = (gearbox: Pick<GearboxGearDisplay, 'forwardGears' | 'reverseGears' | 'label'>) =>
    t('s.gear.box.name', {label: gearbox.label, forward: gearbox.forwardGears, reverse: gearbox.reverseGears}, language);
  return <Card size="sm" data-testid="gear-display-card">
    <CardHeader><CardTitle><h2>{t('s.gear', undefined, language)}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p id="gear-display-description" className="text-sm text-muted-foreground">{t('s.gear.d', undefined, language)}</p>
      {UNIT_GAMES.map(game => <div key={game} className="space-y-2">
        <p id={`gear-display-${game}-label`}>{getUnitGameText(game, language)}</p>
        <RadioGroup aria-labelledby={`gear-display-${game}-label`} aria-describedby="gear-display-description" data-testid={`gear-display-${game}`}
          className="yu-segmented yu-segmented-stacked" value={settings?.gearDisplay[game] ?? DEFAULT_GEAR_DISPLAY[game]} disabled={locked} onValueChange={value => choose(game, value)}>
          {GEAR_DISPLAY_MODE_IDS.map(mode => <div key={mode} className="yu-segment-option">
            <RadioGroupItem value={mode} id={`gear-display-${game}-${mode}`} /><Label htmlFor={`gear-display-${game}-${mode}`}>{modeText(game, mode)}</Label>
          </div>)}
        </RadioGroup>
        {current?.game === game ? <div className="space-y-2" data-testid={`gear-display-${game}-gearbox`}>
          <p id={`gear-display-${game}-gearbox-label`}>{t('s.gear.box.current', {gearbox: gearboxText(current)}, language)}</p>
          <RadioGroup aria-labelledby={`gear-display-${game}-gearbox-label`} className="yu-segmented yu-segmented-stacked" data-testid={`gear-display-${game}-gearbox-mode`}
            value={findGearboxGearDisplay(gearboxes[game], current)?.mode ?? GAME_GEAR_DISPLAY} disabled={locked} onValueChange={value => chooseGearbox(game, current, value)}>
            {[GAME_GEAR_DISPLAY, ...GEAR_DISPLAY_MODE_IDS].map(value => <div key={value} className="yu-segment-option">
              <RadioGroupItem value={value} id={`gear-display-${game}-gearbox-${value}`} />
              <Label htmlFor={`gear-display-${game}-gearbox-${value}`}>{value === GAME_GEAR_DISPLAY
                ? t('s.gear.box.game', {mode: modeText(game, settings?.gearDisplay[game] ?? DEFAULT_GEAR_DISPLAY[game])}, language) : modeText(game, value as GearDisplayMode)}</Label>
            </div>)}
          </RadioGroup>
        </div> : <p className="text-sm text-muted-foreground" data-testid={`gear-display-${game}-gearbox-none`}>{t('s.gear.box.none', undefined, language)}</p>}
        {gearboxes[game].length > 0 ? <ul className="space-y-1" aria-label={t('s.gear.box.saved', {game: getUnitGameText(game, language)}, language)} data-testid={`gear-display-${game}-gearboxes`}>
          {gearboxes[game].map(entry => <li key={`${entry.model}/${entry.forwardGears}/${entry.reverseGears}`} className="flex items-center justify-between gap-2 text-sm">
            <span>{gearboxText(entry)}: {modeText(game, entry.mode)}</span>
            <Button variant="outline" size="sm" disabled={locked} aria-label={t('s.gear.box.reset.named', {gearbox: gearboxText(entry)}, language)}
              onClick={() => chooseGearbox(game, entry, GAME_GEAR_DISPLAY)}>{t('s.gear.box.reset', undefined, language)}</Button>
          </li>)}
        </ul> : null}
      </div>)}
      {/* A refused save is reported by main in the settings view; other request failures only locally. Neither is shown
          once another card made a later request. */}
      {showSaveError && settings?.saveError ? <p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
        : request === 'failed' && showSaveError !== false ?<p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{t('s.gear.saveFailed', undefined, language)}</p> : null}
    </CardContent>
  </Card>;
}
