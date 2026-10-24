import React, {useRef, useState} from 'react';
import type {AppLanguage, OverlayEditState, SettingsView} from '../../../packages/contracts/src';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Slider} from '@/components/ui/slider';
import {OVERLAY_OPACITY_MAX, OVERLAY_OPACITY_MIN} from './overlay-opacity';
import {Switch} from '@/components/ui/switch';
import {OVERLAY_SECTION_ICONS} from './overlay-icons';
import {OVERLAY_SCALE_MAX, OVERLAY_SCALE_MIN, stepOverlayScale} from './overlay-placement';
import {
  DEFAULT_OVERLAY_SETTINGS, enabledSectionCount, isOverlayLayout, OVERLAY_GROUPS, OVERLAY_LAYOUTS, OVERLAY_PRESET_IDS, OVERLAY_PRESETS,
  OVERLAY_SECTION_REQUIREMENTS, sameSections
} from './overlay-sections';
import {
  getOverlayEditPlacementText, getOverlayGroupText, getOverlayLayoutText, getOverlayPresetText,
  getOverlayRequirementText, getOverlaySectionText, getSettingsSaveErrorText, getStrings
} from './strings';

const percent = (scale: number) => `${Math.round(scale * 100)}%`;

/**
 * The main window's overlay settings (ET-012a decision L13). Like the units card it shows only saved values: a choice
 * appears selected after main saved it, and a refused save leaves the previous one. Every change is one narrow bridge
 * call; a preset sends a complete section record. The last enabled section cannot be switched off.
 *
 * Position and size (ET-012b decision M12): "Edit position" enters main's edit mode, in which the overlay is outlined
 * over the game and can be dragged; the scale buttons, reset, Done and Cancel act on main's draft. The edit state shown
 * here is the one main pushes; the layout cannot change while editing.
 */
export function OverlaySettingsCard({settings, edit, onSaved, onRequest, showSaveError}: {
  settings: SettingsView | undefined;
  edit: OverlayEditState | undefined;
  onSaved: (view: SettingsView) => void;
  /** Called when this card starts a save, so the dashboard shows a refusal in the card that caused it. */
  onRequest: () => void;
  showSaveError: boolean;
}) {
  const [opacityDraft, setOpacityDraft] = useState<number>();
  const opacitySaving = useRef(false);
  const [request, setRequest] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [editRequest, setEditRequest] = useState<'idle' | 'pending' | 'failed'>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const strings = getStrings(language);
  const overlay = settings?.overlay ?? DEFAULT_OVERLAY_SETTINGS;
  const locked = !settings?.writable || request === 'saving';
  const editing = edit?.active === true;
  const enabled = enabledSectionCount(overlay.sections);
  const save = (start: () => Promise<SettingsView>) => {
    onRequest(); setRequest('saving');
    void start().then(view => {onSaved(view); setRequest('idle');}, () => setRequest('failed'));
  };
  const editCall = (start: () => Promise<unknown>) => {
    setEditRequest('pending');
    void start().then(() => setEditRequest('idle'), () => setEditRequest('failed'));
  };
  const finish = (outcome: 'save' | 'cancel') => {
    if (outcome === 'save') onRequest();
    setEditRequest('pending');
    void window.desktop.finishOverlayEdit(outcome).then(view => {onSaved(view); setEditRequest('idle');}, () => setEditRequest('failed'));
  };
  const commitOpacity = ([value]: number[]) => {
    if (opacitySaving.current || !settings?.writable) return;
    if (value === overlay.backgroundOpacity) {setOpacityDraft(undefined); return;}
    opacitySaving.current = true; onRequest(); setRequest('saving');
    void window.desktop.setOverlayBackgroundOpacity(value).then(view => {onSaved(view); setRequest('idle');}, () => setRequest('failed'))
      .finally(() => {opacitySaving.current = false; setOpacityDraft(undefined);});
  };
  const busy = editRequest === 'pending' || request === 'saving';
  return <Card size="sm" className="yu-overlay-settings" data-testid="overlay-settings"><CardHeader><CardTitle><h2>{strings.overlayTitle}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <section className="yu-overlay-block" aria-labelledby="overlay-visibility-label">
        <div className="flex items-center gap-2">
          <Switch id="overlay-enabled" data-testid="overlay-enabled" checked={overlay.enabled} disabled={locked}
            aria-describedby="overlay-enabled-help" onCheckedChange={next => save(() => window.desktop.setOverlayEnabled(next))} />
          <Label id="overlay-visibility-label" htmlFor="overlay-enabled">{strings.overlayEnabledLabel}</Label>
        </div>
        <p id="overlay-enabled-help" className="text-xs text-muted-foreground" data-testid="overlay-enabled-help">{strings.overlayEnabledHelp}</p>
      </section>
      <section className="yu-overlay-block" aria-labelledby="overlay-layout-label">
        <h3 id="overlay-layout-label" className="font-medium">{strings.overlayLayoutLabel}</h3>
        <RadioGroup aria-labelledby="overlay-layout-label" data-testid="overlay-layout" className="yu-layout-options" value={overlay.layout} disabled={locked || editing}
          onValueChange={value => {if (isOverlayLayout(value)) save(() => window.desktop.setOverlayLayout(value));}}>
          {OVERLAY_LAYOUTS.map(layout => <div key={layout} className="yu-layout-option" data-selected={overlay.layout === layout}>
            <RadioGroupItem value={layout} id={`overlay-layout-${layout}`} /><Label htmlFor={`overlay-layout-${layout}`}><svg viewBox="0 0 160 75" aria-hidden="true" className={`yu-layout-preview yu-layout-preview-${layout}`}><rect className="yu-preview-window" x="1" y="1" width="158" height="73" rx="5" />
              {layout === 'strip' ? <rect x="28" y="8" width="104" height="13" rx="3" /> : layout === 'card' ? <rect x="112" y="8" width="38" height="57" rx="4" /> : layout === 'hud' ? <><rect x="10" y="10" width="60" height="6" rx="2" /><rect x="10" y="22" width="44" height="6" rx="2" /><rect x="10" y="34" width="54" height="6" rx="2" /></> : <><circle cx="34" cy="48" r="19" /><rect x="58" y="41" width="58" height="25" rx="4" /></>}
            </svg><span>{getOverlayLayoutText(layout, language)}</span></Label>
          </div>)}
        </RadioGroup>
      </section>
      <section className="yu-overlay-block" aria-labelledby="overlay-opacity-label">
        <Label id="overlay-opacity-label" htmlFor="overlay-opacity-thumb">{strings.overlayOpacityLabel}</Label>
        <div className="flex flex-wrap items-center gap-4">
          <Slider className="max-w-sm min-w-32" data-testid="overlay-opacity" thumbId="overlay-opacity-thumb"
            labelId="overlay-opacity-label" descriptionId="overlay-opacity-help" min={OVERLAY_OPACITY_MIN} max={OVERLAY_OPACITY_MAX} step={1}
            value={[opacityDraft ?? overlay.backgroundOpacity]} disabled={locked || busy}
            onPointerCancel={() => setOpacityDraft(undefined)} onValueChange={([value]) => setOpacityDraft(value)} onValueCommit={commitOpacity} />
          <span className="text-sm tabular-nums" data-testid="overlay-opacity-saved">{strings.overlayOpacitySaved}: {overlay.backgroundOpacity}%</span>
        </div>
        <p id="overlay-opacity-help" className="text-xs text-muted-foreground">{strings.overlayOpacityHelp}</p>
      </section>
      <section className="yu-overlay-block" aria-labelledby="overlay-placement-label" data-testid="overlay-placement">
        <h3 id="overlay-placement-label" className="font-medium">{strings.overlayPlacementLabel}</h3>
        {edit?.active ? <>
          <p role="status" data-testid="overlay-edit-status">{getOverlayEditPlacementText(edit.placement, language)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || edit.scale <= OVERLAY_SCALE_MIN} data-testid="overlay-scale-down"
              onClick={() => editCall(() => window.desktop.setOverlayEditScale(stepOverlayScale(edit.scale, -1)))}>{strings.overlayScaleDown}</Button>
            <span data-testid="overlay-edit-scale">{strings.overlayScaleLabel}: {percent(edit.scale)}</span>
            <Button size="sm" variant="outline" disabled={busy || edit.scale >= OVERLAY_SCALE_MAX} data-testid="overlay-scale-up"
              onClick={() => editCall(() => window.desktop.setOverlayEditScale(stepOverlayScale(edit.scale, 1)))}>{strings.overlayScaleUp}</Button>
            <Button size="sm" variant="outline" disabled={busy} data-testid="overlay-placement-reset"
              onClick={() => editCall(() => window.desktop.resetOverlayEditPlacement())}>{strings.overlayResetPlacement}</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} data-testid="overlay-edit-done" onClick={() => finish('save')}>{strings.overlayEditDone}</Button>
            <Button size="sm" variant="outline" disabled={busy} data-testid="overlay-edit-cancel" onClick={() => finish('cancel')}>{strings.overlayEditCancel}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{strings.overlayEditHelp}</p>
        </> : <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={locked || busy || !overlay.enabled} data-testid="overlay-edit-start"
            onClick={() => editCall(() => window.desktop.beginOverlayEdit())}>{strings.overlayEditAction}</Button>
          <span data-testid="overlay-saved-scale">{strings.overlayScaleLabel}: {percent(overlay.placements[overlay.layout].scale)}</span>
        </div>}
        {editRequest === 'failed' ? <p role="status" data-testid="overlay-edit-error">{strings.overlayEditFailed}</p> : null}
      </section>
      <section className="yu-overlay-block" aria-labelledby="overlay-presets-label">
        <h3 id="overlay-presets-label" className="font-medium">{strings.overlayPresetsLabel}</h3>
        <div className="flex flex-wrap gap-2" data-testid="overlay-presets">
          {OVERLAY_PRESET_IDS.map(preset => {
            const pressed = sameSections(overlay.sections, OVERLAY_PRESETS[preset]);
            return <Button key={preset} size="sm" variant={pressed ? 'secondary' : 'outline'} aria-pressed={pressed} disabled={locked}
              data-testid={`overlay-preset-${preset}`} onClick={() => save(() => window.desktop.setOverlaySections(OVERLAY_PRESETS[preset]))}>
              {getOverlayPresetText(preset, language)}
            </Button>;
          })}
        </div>
      </section>
      <section className="yu-overlay-block" aria-labelledby="overlay-sections-label" data-testid="overlay-sections">
        <h3 id="overlay-sections-label" className="font-medium">{strings.overlaySectionsLabel}</h3>
        <div className="yu-overlay-section-groups">
        {OVERLAY_GROUPS.map(group => <section key={group.id} className="space-y-2" aria-labelledby={`overlay-group-${group.id}`}>
          <h4 id={`overlay-group-${group.id}`} className="text-sm text-muted-foreground">{getOverlayGroupText(group.id, language)}</h4>
          {group.sections.map(id => {
            const Icon = OVERLAY_SECTION_ICONS[id], requirement = OVERLAY_SECTION_REQUIREMENTS[id], checked = overlay.sections[id];
            return <div key={id} className="yu-overlay-section-row">
              <Switch id={`overlay-section-${id}`} data-testid={`overlay-switch-${id}`} checked={checked} disabled={locked || (checked && enabled === 1)}
                onCheckedChange={next => save(() => window.desktop.setOverlaySections({...overlay.sections, [id]: next}))} />
              <div><Label htmlFor={`overlay-section-${id}`}><Icon className="size-4" aria-hidden="true" />{getOverlaySectionText(id, language)}</Label>
              {requirement ? <span className="text-xs text-muted-foreground" data-testid={`overlay-requirement-${id}`}>({getOverlayRequirementText(requirement, language)})</span> : null}</div>
            </div>;
          })}
        </section>)}
        </div>
        {enabled === 1 ? <p className="text-xs text-muted-foreground" data-testid="overlay-last-section">{strings.overlayLastSection}</p> : null}
        <p className="text-xs text-muted-foreground">{strings.overlayHiddenNote}</p>
      </section>
      {/* A refused save is reported by main in the settings view; other request failures only locally. */}
      {showSaveError && settings?.saveError ? <p role="status" data-testid="overlay-settings-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
        : request === 'failed' ? <p role="status" data-testid="overlay-settings-error">{strings.overlaySaveFailed}</p> : null}
    </CardContent></Card>;
}
