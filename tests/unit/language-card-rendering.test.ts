import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {SettingsView} from '../../packages/contracts/src';
import {DEFAULT_SETTINGS} from '../../apps/desktop/src/settings-schema';

let lastOnValueChange: ((value: string) => void) | undefined;

vi.mock('@/components/ui/select', () => ({
  Select: ({children, value, disabled, onValueChange}: {children?: React.ReactNode; value?: string; disabled?: boolean; onValueChange?: (value: string) => void}) => {
    lastOnValueChange = onValueChange;
    return React.createElement('div', {'data-slot': 'select', 'data-value': value, disabled: disabled ? '' : undefined, 'data-disabled': disabled ? '' : undefined}, children);
  },
  SelectTrigger: ({children, className, ...props}: {children?: React.ReactNode; className?: string; [key: string]: unknown}) =>
    React.createElement('button', {type: 'button', className, ...props}, children),
  SelectValue: () => React.createElement('span', {'data-slot': 'select-value'}),
  SelectContent: ({children}: {children?: React.ReactNode}) => React.createElement('div', {'data-slot': 'select-content'}, children),
  SelectItem: ({value, children, ...props}: {value: string; children?: React.ReactNode; [key: string]: unknown}) =>
    React.createElement('div', {role: 'option', 'data-value': value, ...props}, children),
}));

import {LanguageCard} from '../../apps/desktop/src/language-card';

// ET-073: Interface language selector renders as a dropdown Select rather than a radio group.
const defaultSettings: SettingsView = {
  ...DEFAULT_SETTINGS,
  state: 'loaded',
  writable: true,
  saveError: null,
};

const makeController = (overrides?: Partial<{saving: boolean; failed: boolean; choose: (value: string) => void}>) => ({
  saving: false,
  failed: false,
  choose: () => undefined,
  ...overrides,
});

function verifyErrorBeneathRow(html: string) {
  const rowClassPos = html.indexOf('class="yu-setting-row"');
  expect(rowClassPos).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf('<div', rowClassPos);
  expect(rowStart).toBeGreaterThan(-1);
  const errorStart = html.indexOf('data-testid="language-save-error"');
  expect(errorStart).toBeGreaterThan(rowStart);
  const between = html.slice(rowStart, errorStart);
  // Count <div> and </div> in the segment from the start of yu-setting-row up to the error paragraph.
  // The yu-setting-row div itself (and any nested divs like Select/SelectContent) must be fully closed.
  const openDivCount = (between.match(/<div(\s|>)/g) || []).length;
  const closeDivCount = (between.match(/<\/div>/g) || []).length;
  expect(openDivCount).toBeGreaterThan(0);
  expect(openDivCount).toEqual(closeDivCount);
}

describe('LanguageCard rendering', () => {
  it('renders a Select dropdown with aria-labelledby linked to language-label and no radio buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: defaultSettings,
        onSaved: () => undefined,
        controller: makeController(),
      })
    );
    expect(html).toContain('id="language-label"');
    expect(html).toContain('data-testid="language-select"');
    expect(html).toContain('aria-labelledby="language-label"');
    expect(html).toContain('data-value="en"');
    expect(html).toContain('w-[180px]');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain('data-testid="language-radio-group"');
    expect(html).not.toContain('id="language-en"');
    expect(html).not.toContain('id="language-ru"');
  });

  it('renders autonyms for English and Russian options in the dropdown content', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: defaultSettings,
        onSaved: () => undefined,
        controller: makeController(),
      })
    );
    expect(html).toContain('English');
    expect(html).toContain('Русский');
    expect(html).toContain('data-testid="language-option-en"');
    expect(html).toContain('data-testid="language-option-ru"');
  });

  it('enables the dropdown when settings are writable and not saving', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: {...defaultSettings, writable: true},
        onSaved: () => undefined,
        controller: makeController({saving: false}),
      })
    );
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('data-disabled');
  });

  it('disables the dropdown when settings are read-only (!writable)', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: {...defaultSettings, writable: false},
        onSaved: () => undefined,
        controller: makeController(),
      })
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-disabled');
  });

  it('disables the dropdown while a save request is in flight (saving: true)', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: defaultSettings,
        onSaved: () => undefined,
        controller: makeController({saving: true}),
      })
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-disabled');
  });

  it('calls controller.choose when onValueChange is invoked', () => {
    let chosen: string | undefined;
    renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: defaultSettings,
        onSaved: () => undefined,
        controller: makeController({choose: value => { chosen = value; }}),
      })
    );
    expect(lastOnValueChange).toBeDefined();
    lastOnValueChange?.('ru');
    expect(chosen).toBe('ru');
  });

  it('renders save error beneath the row when showSaveError is true and settings.saveError exists', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: {...defaultSettings, saveError: 'SETTINGS_WRITE_FAILED'},
        showSaveError: true,
        onSaved: () => undefined,
        controller: makeController(),
      })
    );
    expect(html).toContain('data-testid="language-save-error"');
    expect(html).toContain('role="status"');
    expect(html).toContain('yu-setting-row');
    verifyErrorBeneathRow(html);
  });

  it('renders save failure beneath the row when controller reports failed', () => {
    const html = renderToStaticMarkup(
      React.createElement(LanguageCard, {
        settings: defaultSettings,
        onSaved: () => undefined,
        controller: makeController({failed: true}),
      })
    );
    expect(html).toContain('data-testid="language-save-error"');
    expect(html).toContain('role="status"');
    expect(html).toContain('yu-setting-row');
    verifyErrorBeneathRow(html);
  });
});
