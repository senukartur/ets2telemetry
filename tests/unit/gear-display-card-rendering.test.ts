import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {GearDisplayCard} from '../../apps/desktop/src/gear-display-card';
import {DEFAULT_OVERLAY_SETTINGS} from '../../apps/desktop/src/overlay-sections';
import {getSettingsSaveErrorText, getUnitGameText} from '../../apps/desktop/src/strings';
import {t} from '../../apps/desktop/src/i18n';
import type {AppLanguage, GearDisplayModes, SettingsView} from '../../packages/contracts/src';

// ET-050: the gear display card on Settings > Units. Substitute only the shadcn primitives; the card's labels, ids,
// committed state, locks and error rules remain real. Expected texts are the hand-written EN/RU copy.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
// The trigger renders its single child, as asChild does; the content renders in place of the portal.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({children}: {children?: React.ReactNode}) => React.createElement(React.Fragment, null, children),
  Tooltip: ({children}: {children?: React.ReactNode}) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({children}: {children?: React.ReactNode}) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({children, side, align, ...props}: {children?: React.ReactNode; side?: string; align?: string}) =>
    React.createElement('div', {...props, 'data-side': side, 'data-align': align}, children)
}));
vi.mock('@/components/ui/radio-group', () => ({
  // The change handler is not a DOM attribute; it is left out of the markup.
  RadioGroup: ({value, disabled, children, ...props}: {value: string; disabled?: boolean; children?: React.ReactNode; onValueChange?: unknown}) =>
    React.createElement('div', {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'onValueChange')), role: 'radiogroup', 'data-value': value,
      'aria-disabled': disabled ? 'true' : undefined}, children),
  RadioGroupItem: ({value, ...props}: {value: string}) => React.createElement('button', {...props, role: 'radio', value})
}));

const settings = (language: AppLanguage, gearDisplay: GearDisplayModes = {ets2: 'automatic', ats: 'automatic'}, patch: Partial<SettingsView> = {}): SettingsView => ({
  language, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay, overlay: DEFAULT_OVERLAY_SETTINGS, state: 'loaded', writable: true, saveError: null, ...patch});
const render = (view: SettingsView | undefined, showSaveError?: boolean) =>
  renderToStaticMarkup(React.createElement(GearDisplayCard, {settings: view, onSaved: vi.fn(), onRequest: vi.fn(), showSaveError}));
const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const group = (html: string, game: string) => html.match(new RegExp('<div[^>]*data-testid="gear-display-' + game + '"[^>]*>'))?.[0] ?? '';

const COPY = {
  en: {title: 'Gear display', description: 'How gears are labelled on the instruments and in the overlay. Recorded telemetry does not change.',
    names: {automatic: 'Automatic', manual: 'Manual range-splitter', crawler: 'Crawler first'},
    hints: {
      automatic: {ets2: 'Gears are labelled with their numbers. Suits an automatic gearbox, or when the range splitter does not matter.',
        ats: 'Gears are labelled with their numbers. Suits an automatic gearbox, or when the range splitter does not matter.'},
      manual: {ets2: 'When the game reports the truck\'s gearbox layout, the labels follow it, including the crawler gears C1, C2. Otherwise they are range-splitter pairs.',
        ats: 'When the game reports the truck\'s gearbox layout, the labels follow it, including the crawler gears LL, LH. Otherwise they are range-splitter pairs.'},
      crawler: {ets2: 'The first gear is the crawler C, and the others are numbered. For gearboxes such as the Scania 13+1.',
        ats: 'The first gear is the crawler L, and the others are numbered. For 13+1 gearboxes.'}},
    fallback: 'Without a layout: 1L, 1H, 2L, 2H…', reverse: 'Reverse R1, R2…, neutral N.', automatic: 'Automatic (1, 2, 3)', manual: 'Manual range-splitter (1L, 1H, 2L…)',
    crawler: {ets2: 'Crawler first (C, 1, 2, 3…)', ats: 'Crawler first (L, 1, 2, 3…)'},
    failed: 'The gear display change was not saved; the previous setting stays in use.'},
  ru: {title: 'Отображение передач', description: 'Как подписывать передачи на приборах и в оверлее. Записанная телеметрия не меняется.',
    names: {automatic: 'Автоматическая', manual: 'Механическая с делителем', crawler: 'С ползучей'},
    hints: {
      automatic: {ets2: 'Передачи подписаны своими номерами. Подходит для автоматической коробки или если делитель не важен.',
        ats: 'Передачи подписаны своими номерами. Подходит для автоматической коробки или если делитель не важен.'},
      manual: {ets2: 'Если игра сообщает схему коробки грузовика, подписи следуют ей, включая ползучие C1, C2. Иначе — пары с делителем.',
        ats: 'Если игра сообщает схему коробки грузовика, подписи следуют ей, включая ползучие LL, LH. Иначе — пары с делителем.'},
      crawler: {ets2: 'Первая передача — ползучая C, остальные по номерам. Для коробок вроде Scania 13+1.',
        ats: 'Первая передача — ползучая L, остальные по номерам. Для коробок вроде 13+1.'}},
    fallback: 'Без схемы: 1L, 1H, 2L, 2H…', reverse: 'Задний ход R1, R2…, нейтраль N.', automatic: 'Автоматическая (1, 2, 3)', manual: 'Механическая с делителем (1L, 1H, 2L…)',
    crawler: {ets2: 'С ползучей (C, 1, 2, 3…)', ats: 'С ползучей (L, 1, 2, 3…)'},
    failed: 'Изменение отображения передач не сохранено; действует прежняя настройка.'}
} as const;

it.each(['en', 'ru'] as const)('renders one labelled, described group per game with unique ids in %s', language => {
  const html = render(settings(language));
  expect(html).toContain(escaped(COPY[language].title));
  expect(t('s.gear', undefined, language)).toBe(COPY[language].title);
  expect(html).toContain(`id="gear-display-description"`);
  expect(html).toContain(`<p id="gear-display-description" class="sr-only">${escaped(COPY[language].description)}</p>`);
  for (const game of ['ets2', 'ats'] as const) {
    expect(html.match(new RegExp(`data-testid="gear-display-${game}"`, 'g'))).toHaveLength(1);
    expect(html).toContain(`<p id="gear-display-${game}-label">${escaped(getUnitGameText(game, language))}</p>`);
    expect(group(html, game)).toContain(`aria-labelledby="gear-display-${game}-label"`);
    expect(group(html, game)).toContain('aria-describedby="gear-display-description"');
    for (const mode of ['automatic', 'manual'] as const) {
      expect(html).toContain(`id="gear-display-${game}-${mode}"`);
      expect(html).toContain(`<label for="gear-display-${game}-${mode}">${escaped(COPY[language][mode])}</label>`);
    }
    // ET-050b owner option B: the third option names the game's own crawler.
    expect(html).toContain(`id="gear-display-${game}-crawler"`);
    expect(html).toContain(`<label for="gear-display-${game}-crawler">${escaped(COPY[language].crawler[game])}</label>`);
    expect(html.match(new RegExp(`<button[^>]*id="gear-display-${game}-`, 'g'))).toHaveLength(3);
    // Review finding: three options stack in one column instead of wrapping into the two-column segmented grid.
    expect(group(html, game)).toContain('class="yu-segmented yu-segmented-stacked"');
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toContain('data-testid="gear-display-error"');
});
it('shows only the committed mode of each game, and automatic before the settings arrive', () => {
  const html = render(settings('en', {ets2: 'manual', ats: 'automatic'}));
  expect(group(html, 'ets2')).toContain('data-value="manual"');
  expect(group(html, 'ats')).toContain('data-value="automatic"');
  const crawler = render(settings('en', {ets2: 'crawler', ats: 'manual'}));
  expect(group(crawler, 'ets2')).toContain('data-value="crawler"');
  expect(group(crawler, 'ats')).toContain('data-value="manual"');
  const none = render(undefined);
  expect(group(none, 'ets2')).toContain('data-value="automatic"');
  expect(group(none, 'ats')).toContain('data-value="automatic"');
  expect(group(none, 'ets2')).toContain('aria-disabled="true"');
});
it('disables both groups while the settings are read-only and enables them while writable', () => {
  const readOnly = render(settings('en', undefined, {state: 'newer-version', writable: false}));
  for (const game of ['ets2', 'ats']) expect(group(readOnly, game)).toContain('aria-disabled="true"');
  const writable = render(settings('en'));
  for (const game of ['ets2', 'ats']) expect(group(writable, game)).not.toContain('aria-disabled');
});
it.each(['en', 'ru'] as const)('shows main\'s save error only when this card made the last request in %s', language => {
  for (const code of ['SETTINGS_WRITE_FAILED', 'SETTINGS_READ_ONLY'] as const) {
    const view = settings(language, undefined, {saveError: code});
    const own = render(view, true);
    expect(own).toContain('role="status"');
    expect(own).toContain(`data-testid="gear-display-error">${escaped(getSettingsSaveErrorText(code, language))}</p>`);
    expect(render(view, false)).not.toContain('data-testid="gear-display-error"');
    expect(render(view)).not.toContain('data-testid="gear-display-error"');
  }
  expect(t('s.gear.saveFailed', undefined, language)).toBe(COPY[language].failed);
});
const EXAMPLES = {
  ets2: {automatic: ['N', '1', '2', '3', '…', '12', 'R1'], manual: ['C1', 'C2', '1L', '1H', '2L', '…', '6H'], crawler: ['N', 'C', '1', '2', '…', '12', 'R1']},
  ats: {automatic: ['N', '1', '2', '3', '…', '12', 'R1'], manual: ['LL', 'LH', '1L', '1H', '2L', '…', '8H'], crawler: ['N', 'L', '1', '2', '…', '12', 'R1']}
} as const;
it.each(['en', 'ru'] as const)('gives every option its own hint, as a tooltip and as the radio description, in %s', language => {
  const html = render(settings(language));
  const copy = COPY[language];
  for (const game of ['ets2', 'ats'] as const) for (const mode of ['automatic', 'manual', 'crawler'] as const) {
    const id = `gear-display-${game}-${mode}`, text = copy.hints[mode][game];
    const description = [text, ...(mode === 'manual' ? [copy.fallback] : []), copy.reverse].join(' ');
    expect(html).toMatch(new RegExp(`<button[^>]*id="${id}"[^>]*aria-describedby="${id}-hint"`));
    expect(html).toContain(`<span id="${id}-hint" class="sr-only">${escaped(description)}</span>`);
    const tooltip = html.match(new RegExp(`<div data-testid="${id}-tooltip"[^>]*>.*?</div></div>`))?.[0] ?? '';
    expect(tooltip).toContain('data-side="bottom" data-align="end"');
    expect(tooltip).toContain(`<p class="font-medium">${escaped(copy.names[mode])}</p><p>${escaped(text)}</p>`);
    expect(tooltip).toContain(`<p class="yu-gear-examples" aria-hidden="true">${EXAMPLES[game][mode].map(label => `<span class="yu-gear-chip">${label}</span>`).join('')}</p>`);
    expect(tooltip.includes(escaped(copy.fallback))).toBe(mode === 'manual');
    expect(tooltip).toContain(`<p class="text-xs text-muted-foreground">${escaped(copy.reverse)}</p>`);
    // The option, not the radio, is the trigger, and the icon only marks it.
    expect(html).toMatch(new RegExp(`<div class="yu-segment-option yu-segment-option-hinted"><button[^>]*id="${id}"`));
  }
  expect(html.match(/class="lucide[^"]*yu-segment-info"[^>]*aria-hidden="true"/g)).toHaveLength(6);
});
