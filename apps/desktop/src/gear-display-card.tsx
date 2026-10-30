import React, {useState} from 'react';
import {Info} from 'lucide-react';
import type {AppLanguage, GearDisplayMode, SettingsView, UnitGame} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {chooseGearDisplay, type GearDisplayRequest} from './gear-display-choice';
import {DEFAULT_GEAR_DISPLAY, GEAR_DISPLAY_MODE_IDS, UNIT_GAMES} from './unit-profiles';
import {getSettingsSaveErrorText, getUnitGameText} from './strings';
import {t} from './i18n';
import {InfoHint} from './info-hint';

export interface GearDisplayCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  /** Called before each request, so that the dashboard shows main's save error in this card. */
  onRequest?: () => void;
  /** True when this card made the last settings request. */
  showSaveError?: boolean;
}

/** Example labels in each option's hint: an ETS2 Scania 12+2 and an ATS Mack 18-speed for manual, a 13+1 for crawler. */
const GEAR_EXAMPLES: Readonly<Record<UnitGame, Readonly<Record<GearDisplayMode, readonly string[]>>>> = {
  ets2: {automatic: ['N', '1', '2', '3', '…', '12', 'R1'], manual: ['C1', 'C2', '1L', '1H', '2L', '…', '6H'], crawler: ['N', 'C', '1', '2', '…', '12', 'R1']},
  ats: {automatic: ['N', '1', '2', '3', '…', '12', 'R1'], manual: ['LL', 'LH', '1L', '1H', '2L', '…', '8H'], crawler: ['N', 'L', '1', '2', '…', '12', 'R1']}
};
const hintKey = (game: UnitGame, mode: GearDisplayMode) => mode === 'automatic' ? 's.gear.hint.automatic' as const : `s.gear.hint.${mode}.${game}` as const;

/**
 * ET-050: the per-game gear display mode on Settings > Units. Each game has one labelled radio group, whose crawler
 * option names that game's crawler (ET-050b: C in ETS2, L in ATS); it shows only the
 * mode main has committed, so a failed save leaves the previous choice selected. The groups are disabled while a save is
 * in flight and while the settings cannot be saved.
 * Each option opens its own hint on hover or keyboard focus, as the recording indicator does. The trigger is the option,
 * not the radio, because the trigger's data-state would replace the radio's checked state. The hint's text is also the
 * radio's accessible description, so a screen reader hears it without the tooltip.
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
    <CardHeader><CardTitle><h2 className="yu-label-hint">{t('s.gear', undefined, language)}<InfoHint label={t('ui.moreAbout', {v: t('s.gear', undefined, language)}, language)}>{t('s.gear.d', undefined, language)}</InfoHint></h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p id="gear-display-description" className="sr-only">{t('s.gear.d', undefined, language)}</p>
      <TooltipProvider disableHoverableContent delayDuration={150} skipDelayDuration={0}>{UNIT_GAMES.map(game => <div key={game} className="space-y-2">
        <p id={`gear-display-${game}-label`}>{getUnitGameText(game, language)}</p>
        <RadioGroup aria-labelledby={`gear-display-${game}-label`} aria-describedby="gear-display-description" data-testid={`gear-display-${game}`}
          className="yu-segmented yu-segmented-stacked" value={settings?.gearDisplay[game] ?? DEFAULT_GEAR_DISPLAY[game]} disabled={locked} onValueChange={value => choose(game, value)}>
          {GEAR_DISPLAY_MODE_IDS.map(mode => {
            const id = `gear-display-${game}-${mode}`;
            const hint = [t(hintKey(game, mode), undefined, language), mode === 'manual' ? t('s.gear.hint.manualFallback', undefined, language) : null, t('s.gear.hint.reverse', undefined, language)];
            return <Tooltip key={mode}><TooltipTrigger asChild><div className="yu-segment-option yu-segment-option-hinted">
              <RadioGroupItem value={mode} id={id} aria-describedby={`${id}-hint`} /><Label htmlFor={id}>{t(mode === 'crawler' ? `s.gear.crawler.${game}` : `s.gear.${mode}`, undefined, language)}</Label>
              <Info className="yu-segment-info" aria-hidden="true" />
              <span id={`${id}-hint`} className="sr-only">{hint.filter(Boolean).join(' ')}</span>
            </div></TooltipTrigger><TooltipContent side="bottom" align="end" data-testid={`${id}-tooltip`}><div className="space-y-1.5">
              <p className="font-medium">{t(`s.gear.name.${mode}`, undefined, language)}</p>
              <p>{hint[0]}</p>
              <p className="yu-gear-examples" aria-hidden="true">{GEAR_EXAMPLES[game][mode].map((label, index) => <span key={index} className="yu-gear-chip">{label}</span>)}</p>
              {hint[1] ? <p className="text-xs text-muted-foreground">{hint[1]}</p> : null}
              <p className="text-xs text-muted-foreground">{hint[2]}</p>
            </div></TooltipContent></Tooltip>;
          })}
        </RadioGroup>
      </div>)}</TooltipProvider>
      {/* A refused save is reported by main in the settings view; other request failures only locally. Neither is shown
          once another card made a later request. */}
      {showSaveError && settings?.saveError ? <p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
        : request === 'failed' && showSaveError !== false ?<p role="status" className="text-sm text-destructive" data-testid="gear-display-error">{t('s.gear.saveFailed', undefined, language)}</p> : null}
    </CardContent>
  </Card>;
}
