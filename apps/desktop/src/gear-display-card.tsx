import React, {useState} from 'react';
import type {AppLanguage, SettingsView, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {chooseGearDisplay, type GearDisplayRequest} from './gear-display-choice';
import {DEFAULT_GEAR_DISPLAY, GEAR_DISPLAY_MODE_IDS, UNIT_GAMES} from './unit-profiles';
import {getSettingsSaveErrorText, getUnitGameText} from './strings';
import {t} from './i18n';

export interface GearDisplayCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  /** Called before each request, so that the dashboard shows main's save error in this card. */
  onRequest?: () => void;
  /** True when this card made the last settings request. */
  showSaveError?: boolean;
}

/**
 * ET-050: the per-game gear display mode on Settings > Units. Each game has one labelled radio group; it shows only the
 * mode main has committed, so a failed save leaves the previous choice selected. The groups are disabled while a save is
 * in flight and while the settings cannot be saved.
 */
export function GearDisplayCard({settings, onSaved, onRequest, showSaveError}: GearDisplayCardProps) {
  const [request, setRequest] = useState<GearDisplayRequest>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const locked = !settings?.writable || request === 'saving';
  const choose = (game: UnitGame, value: string) => {
    onRequest?.();
    void chooseGearDisplay(window.desktop, game, value, {onSaved, onState: setRequest});
  };
  return <Card size="sm" data-testid="gear-display-card">
    <CardHeader><CardTitle><h2>{t('s.gear', undefined, language)}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p id="gear-display-description" className="text-sm text-muted-foreground">{t('s.gear.d', undefined, language)}</p>
      {UNIT_GAMES.map(game => <div key={game} className="space-y-2">
        <p id={`gear-display-${game}-label`}>{getUnitGameText(game, language)}</p>
        <RadioGroup aria-labelledby={`gear-display-${game}-label`} aria-describedby="gear-display-description" data-testid={`gear-display-${game}`}
          className="yu-segmented" value={settings?.gearDisplay[game] ?? DEFAULT_GEAR_DISPLAY[game]} disabled={locked} onValueChange={value => choose(game, value)}>
          {GEAR_DISPLAY_MODE_IDS.map(mode => <div key={mode} className="yu-segment-option">
            <RadioGroupItem value={mode} id={`gear-display-${game}-${mode}`} /><Label htmlFor={`gear-display-${game}-${mode}`}>{t(`s.gear.${mode}`, undefined, language)}</Label>
          </div>)}
        </RadioGroup>
      </div>)}
      {/* A refused save is reported by main in the settings view; other request failures only locally. Neither is shown
          once another card made a later request. */}
      {showSaveError && settings?.saveError ? <p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
        : request === 'failed' && showSaveError !== false ?<p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{t('s.gear.saveFailed', undefined, language)}</p> : null}
    </CardContent>
  </Card>;
}
