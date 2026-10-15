import React, {useState} from 'react';
import type {OverlayEditState, SettingsView} from '../../../packages/contracts/src';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Switch} from '@/components/ui/switch';
import {OVERLAY_SECTION_ICONS} from './overlay-icons';
import {OVERLAY_SCALE_MAX, OVERLAY_SCALE_MIN, stepOverlayScale} from './overlay-placement';
import {
  DEFAULT_OVERLAY_SETTINGS, enabledSectionCount, isOverlayLayout, OVERLAY_GROUPS, OVERLAY_LAYOUTS, OVERLAY_PRESET_IDS, OVERLAY_PRESETS,
  OVERLAY_SECTION_REQUIREMENTS, sameSections
} from './overlay-sections';
import {
  OVERLAY_EDIT_PLACEMENT_TEXT, OVERLAY_GROUP_TEXT, OVERLAY_LAYOUT_TEXT, OVERLAY_PRESET_TEXT, OVERLAY_REQUIREMENT_TEXT, OVERLAY_SECTION_TEXT,
  SETTINGS_SAVE_ERROR_TEXT, STRINGS
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
  const [request, setRequest] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [editRequest, setEditRequest] = useState<'idle' | 'pending' | 'failed'>('idle');
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
  const busy = editRequest === 'pending';
  return <Card size="sm" data-testid="overlay-settings"><CardHeader><CardTitle><h2>{STRINGS.overlayTitle}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-2">
        <p id="overlay-layout-label" className="font-medium">{STRINGS.overlayLayoutLabel}</p>
        <RadioGroup aria-labelledby="overlay-layout-label" data-testid="overlay-layout" value={overlay.layout} disabled={locked || editing}
          onValueChange={value => {if (isOverlayLayout(value)) save(() => window.desktop.setOverlayLayout(value));}}>
          {OVERLAY_LAYOUTS.map(layout => <div key={layout} className="flex items-center gap-2">
            <RadioGroupItem value={layout} id={`overlay-layout-${layout}`} /><Label htmlFor={`overlay-layout-${layout}`}>{OVERLAY_LAYOUT_TEXT[layout]}</Label>
          </div>)}
        </RadioGroup>
      </div>
      <div className="space-y-2" data-testid="overlay-placement">
        <p className="font-medium">{STRINGS.overlayPlacementLabel}</p>
        {edit?.active ? <>
          <p role="status" data-testid="overlay-edit-status">{OVERLAY_EDIT_PLACEMENT_TEXT[edit.placement]}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy || edit.scale <= OVERLAY_SCALE_MIN} data-testid="overlay-scale-down"
              onClick={() => editCall(() => window.desktop.setOverlayEditScale(stepOverlayScale(edit.scale, -1)))}>{STRINGS.overlayScaleDown}</Button>
            <span data-testid="overlay-edit-scale">{STRINGS.overlayScaleLabel}: {percent(edit.scale)}</span>
            <Button size="sm" variant="outline" disabled={busy || edit.scale >= OVERLAY_SCALE_MAX} data-testid="overlay-scale-up"
              onClick={() => editCall(() => window.desktop.setOverlayEditScale(stepOverlayScale(edit.scale, 1)))}>{STRINGS.overlayScaleUp}</Button>
            <Button size="sm" variant="outline" disabled={busy} data-testid="overlay-placement-reset"
              onClick={() => editCall(() => window.desktop.resetOverlayEditPlacement())}>{STRINGS.overlayResetPlacement}</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} data-testid="overlay-edit-done" onClick={() => finish('save')}>{STRINGS.overlayEditDone}</Button>
            <Button size="sm" variant="outline" disabled={busy} data-testid="overlay-edit-cancel" onClick={() => finish('cancel')}>{STRINGS.overlayEditCancel}</Button>
          </div>
          <p className="text-xs text-muted-foreground">{STRINGS.overlayEditHelp}</p>
        </> : <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={locked || busy} data-testid="overlay-edit-start"
            onClick={() => editCall(() => window.desktop.beginOverlayEdit())}>{STRINGS.overlayEditAction}</Button>
          <span data-testid="overlay-saved-scale">{STRINGS.overlayScaleLabel}: {percent(overlay.placements[overlay.layout].scale)}</span>
        </div>}
        {editRequest === 'failed' ? <p role="status" data-testid="overlay-edit-error">{STRINGS.overlayEditFailed}</p> : null}
      </div>
      <div className="space-y-2">
        <p className="font-medium">{STRINGS.overlayPresetsLabel}</p>
        <div className="flex flex-wrap gap-2" data-testid="overlay-presets">
          {OVERLAY_PRESET_IDS.map(preset => {
            const pressed = sameSections(overlay.sections, OVERLAY_PRESETS[preset]);
            return <Button key={preset} size="sm" variant={pressed ? 'secondary' : 'outline'} aria-pressed={pressed} disabled={locked}
              data-testid={`overlay-preset-${preset}`} onClick={() => save(() => window.desktop.setOverlaySections(OVERLAY_PRESETS[preset]))}>
              {OVERLAY_PRESET_TEXT[preset]}
            </Button>;
          })}
        </div>
      </div>
      <div className="space-y-3">
        <p className="font-medium">{STRINGS.overlaySectionsLabel}</p>
        {OVERLAY_GROUPS.map(group => <section key={group.id} className="space-y-2" aria-labelledby={`overlay-group-${group.id}`}>
          <h3 id={`overlay-group-${group.id}`} className="text-sm text-muted-foreground">{OVERLAY_GROUP_TEXT[group.id]}</h3>
          {group.sections.map(id => {
            const Icon = OVERLAY_SECTION_ICONS[id], requirement = OVERLAY_SECTION_REQUIREMENTS[id], checked = overlay.sections[id];
            return <div key={id} className="flex items-center gap-2">
              <Switch id={`overlay-section-${id}`} data-testid={`overlay-switch-${id}`} checked={checked} disabled={locked || (checked && enabled === 1)}
                onCheckedChange={next => save(() => window.desktop.setOverlaySections({...overlay.sections, [id]: next}))} />
              <Label htmlFor={`overlay-section-${id}`}><Icon className="size-4" aria-hidden="true" />{OVERLAY_SECTION_TEXT[id]}</Label>
              {requirement ? <span className="text-xs text-muted-foreground" data-testid={`overlay-requirement-${id}`}>({OVERLAY_REQUIREMENT_TEXT[requirement]})</span> : null}
            </div>;
          })}
        </section>)}
        {enabled === 1 ? <p className="text-xs text-muted-foreground" data-testid="overlay-last-section">{STRINGS.overlayLastSection}</p> : null}
        <p className="text-xs text-muted-foreground">{STRINGS.overlayHiddenNote}</p>
      </div>
      {/* A refused save is reported by main in the settings view; other request failures only locally. */}
      {showSaveError && settings?.saveError ? <p role="status" data-testid="overlay-settings-error">{SETTINGS_SAVE_ERROR_TEXT[settings.saveError]}</p>
        : request === 'failed' ? <p role="status" data-testid="overlay-settings-error">{STRINGS.overlaySaveFailed}</p> : null}
    </CardContent></Card>;
}
