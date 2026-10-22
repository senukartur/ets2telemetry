import {zeroLiveObservation} from '../../scripts/ci/renderer-observation.mjs';
import type {Page} from '@playwright/test';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  completeLiveObservation, currentTelemetryObservation, notCurrentLiveObservation, overlayOverflow, overlayV1Observation, SYNTHETIC_V0_HIDDEN_ROWS,
  SYNTHETIC_V0_LIVE_ROWS, SYNTHETIC_V0_VALUE_IDS, SYNTHETIC_V0V1_HIDDEN_ROWS, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V1_OVERLAY_CURRENT, SYNTHETIC_V1_OVERLAY_STOPPED,
  SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_V1_STALE, SYNTHETIC_V1_VALUE_IDS, v1NotCurrentObservation, waitForCompleteLive, waitForCurrentTelemetry,
  waitForNotCurrentLive, type RendererObservation
} from '../../scripts/ci/renderer-observation.mjs';

const current = {gauge: {number: '90', unit: 'km/h', accessibleName: 'Speed: 90 km/h; Engine RPM: 600 rpm', visible: true}, status: 'connected: Validated current observation', speed: 'Speed: 90 km/h', fuel: 'Fuel: 73.0 L'};
const stale = {status: 'stale: No recent current observation', speed: 'Speed: unavailable', fuel: 'Fuel: unavailable'};
function controlledPage(samples: RendererObservation[]) {
  let index = 0, elapsed = 0, disposed = false; const bounds: number[] = [];
  const next = () => samples[Math.min(index++, samples.length - 1)];
  const documentFor = (sample: RendererObservation) => fakeGlobals({'telemetry-status': one(sample.status), speed: one(sample.speed), fuel: one(sample.fuel)}).document;
  const page = {
    // These separate legacy reads intentionally advance between renderer observations.
    getByText: (text: string) => ({waitFor: () => {
      for (let count = 0; count <= 40; count++) {const sample = next(); if (sample.speed === text || sample.fuel === text) return Promise.resolve();}
      return Promise.reject(new Error('legacy visible wait timed out'));
    }}),
    getByTestId: () => ({innerText: () => Promise.resolve(next().status)}),
    waitForFunction: (predicate: () => unknown, _argument: unknown, options: {timeout: number}) => {
      bounds.push(options.timeout);
      // Recreate the callback from source as Playwright does: imported closures cannot help it.
      for (elapsed = 0; elapsed <= options.timeout; elapsed += 250) {
        const value: unknown = runInNewContext(`(${predicate.toString()})()`, {document: documentFor(next()), getComputedStyle: () => ({visibility: 'visible'}), innerWidth: 784, innerHeight: 435});
        if (value) return Promise.resolve({jsonValue: () => Promise.resolve(value), dispose: () => {disposed = true; return Promise.resolve();}});
      }
      return Promise.reject(new Error(`snapshot timeout ${options.timeout}`));
    }
  } as unknown as Page;
  return {page, bounds, elapsed: () => elapsed, disposed: () => disposed};
}
afterEach(() => vi.unstubAllGlobals());
describe('coherent renderer acceptance', () => {
  it('accepts a complete current observation despite a later separate status read becoming stale', async () => {
    const fake = controlledPage([current, current, stale, current]);
    expect(await waitForCurrentTelemetry(fake.page)).toEqual(current);
    expect(fake.bounds).toEqual([10000]); expect(fake.disposed()).toBe(true);
  });
  it('cannot combine speed, fuel and connected status from different observations', async () => {
    const fake = controlledPage([{...current, fuel: 'Fuel: 72.0 L'}, {...current, speed: 'Speed: 89.0 km/h'}, {...current, speed: 'Speed: unavailable'}]);
    await expect(waitForCurrentTelemetry(fake.page)).rejects.toThrow('snapshot timeout 10000');
    expect(fake.bounds).toEqual([10000]);
  });
  it('waits through stale and incorrect observations until all fields match together', async () => {
    const fake = controlledPage([stale, {...current, speed: 'Speed: 89.0 km/h'}, current]);
    expect(await waitForCurrentTelemetry(fake.page)).toEqual(current);
    expect(fake.elapsed()).toBe(500); expect(fake.bounds).toEqual([10000]);
  });
  it.each([
    {name: 'never connected', sample: {...current, status: stale.status}},
    {name: 'never correct speed', sample: {...current, speed: 'Speed: 89.0 km/h'}},
    {name: 'never correct fuel', sample: {...current, fuel: 'Fuel: 72.0 L'}},
    {name: 'unavailable', sample: stale}
  ])('times out within the unchanged bound when $name', async ({sample}) => {
    const fake = controlledPage([sample]);
    await expect(waitForCurrentTelemetry(fake.page)).rejects.toThrow('snapshot timeout 10000');
    expect(fake.bounds).toEqual([10000]); expect(fake.elapsed()).toBeLessThanOrEqual(10250);
  });
  it.each(['missing', 'duplicate', 'hidden', 'collapsed', 'empty box', 'offscreen'])('rejects %s elements even with correct text', visibility => {
    vi.stubGlobal('innerWidth', 784); vi.stubGlobal('innerHeight', 435);
    vi.stubGlobal('getComputedStyle', () => ({visibility: visibility === 'hidden' ? 'hidden' : visibility === 'collapsed' ? 'collapse' : 'visible'}));
    vi.stubGlobal('document', {querySelectorAll: (selector: string) => {
      const key = selector.includes('telemetry-status') ? 'status' : selector.includes('speed') ? 'speed' : 'fuel';
      const element = {innerText: current[key], getBoundingClientRect: () => ({width: visibility === 'empty box' ? 0 : 100, height: 20, top: visibility === 'offscreen' ? 500 : 10, bottom: 520, left: 10, right: 110})};
      return visibility === 'missing' ? [] : visibility === 'duplicate' ? [element, element] : [element];
    }});
    expect(currentTelemetryObservation()).toBe(false);
  });
});

// ET-010b live card predicates. The fake document returns elements by exact data-testid.
interface FakeElement {innerText: string; attributes?: Record<string, string>; visibility?: string; box?: {width: number; height: number; top: number}}
type Change = (elements: Record<string, FakeElement[]>) => void;
function fakeGlobals(elements: Record<string, FakeElement[]>) {
  if (elements['telemetry-status'] && !elements['shell.status.connection']) elements = {...elements, 'shell.status.connection': elements['telemetry-status']};
  // Semantic speed fixtures now materialize the existing visible SVG, without a legacy paragraph.
  if (elements.speed) {
    const input = elements.speed[0], text = input.innerText.slice('Speed: '.length), missing = text === 'unavailable';
    const pieces = text.split(' '), value = missing ? '—' : pieces[0], unit = missing ? 'km/h' : pieces.slice(1).join(' ');
    elements = {...elements, 'live-speed-number': [{...input, innerText: value}], 'live-speed-unit': [{...input, innerText: unit}],
      'live-speed-gauge': [{innerText: '', attributes: {role: 'img', 'aria-label': input.innerText + '; Engine RPM: 600 rpm'}}]};
    delete elements.speed;
  }
  return {innerWidth: 784, innerHeight: 435, getComputedStyle: (element: {visibility: string}) => ({visibility: element.visibility}), document: {documentElement: {lang: 'en'}, querySelectorAll: (selector: string) => {
    const id = /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
    if (!id) throw new Error(`unexpected selector ${selector}`);
    return (elements[id] ?? []).map(element => {
      const box = element.box ?? {width: 100, height: 20, top: 10};
      return {innerText: element.innerText, textContent: element.innerText, getAttribute: (name: string) => element.attributes?.[name] ?? null, visibility: element.visibility ?? 'visible',
        getBoundingClientRect: () => ({...box, left: 10, right: 10 + box.width, bottom: box.top + box.height})};
    });
  }}};
}
function stubDocument(elements: Record<string, FakeElement[]>) {
  for (const [name, value] of Object.entries(fakeGlobals(elements))) vi.stubGlobal(name, value);
}
const one = (innerText: string, extra: Partial<FakeElement> = {}) => [{innerText, ...extra}];
// Every live row offscreen (top 900, below the 435 px viewport): rows need no viewport intersection (B6).
const completeElements = (): Record<string, FakeElement[]> =>
  Object.fromEntries(SYNTHETIC_V0_LIVE_ROWS.map(([id, text]) => [id, one(text, {box: {width: 100, height: 20, top: 900}})]));
const expected = {rows: SYNTHETIC_V0_LIVE_ROWS, hidden: SYNTHETIC_V0_HIDDEN_ROWS};
describe('ET-010b complete live card observation', () => {
  it('accepts every row with its exact text, including rows below the fold', () => {
    stubDocument(completeElements());
    expect(completeLiveObservation(expected)).toEqual(Object.fromEntries(SYNTHETIC_V0_LIVE_ROWS));
    expect(completeLiveObservation(expected)).toMatchObject({'live-gear': 'R1', 'live-sdk-average-consumption-note': 'SDK mean, not a trip average'});
  });
  it.each<[string, Change]>([
    ['a wrong value', (elements: Record<string, FakeElement[]>) => {elements['live-gear'] = one('R2');}],
    ['a duplicate element', (elements: Record<string, FakeElement[]>) => {elements['live-odometer'] = [...elements['live-odometer'], ...elements['live-odometer']];}],
    ['a missing element', (elements: Record<string, FakeElement[]>) => {delete elements['live-truck'];}],
    ['a hidden element', (elements: Record<string, FakeElement[]>) => {elements['live-cargo'] = one('cargo.logs', {visibility: 'hidden'});}],
    ['a zero box', (elements: Record<string, FakeElement[]>) => {elements['live-engine-rpm'] = one('600 rpm', {box: {width: 0, height: 20, top: 10}});}],
    ['a reason on a value row', (elements: Record<string, FakeElement[]>) => {elements['live-gear-reason'] = one('not current');}],
    ['a note on a row without an expected note', (elements: Record<string, FakeElement[]>) => {elements['live-odometer-note'] = one('game time');}],
    ...SYNTHETIC_V0_HIDDEN_ROWS.map((id): [string, Change] => [`the hidden element ${id}`, (elements: Record<string, FakeElement[]>) => {elements[id] = one('x');}])
  ])('rejects %s', (_name, change) => {
    const elements = completeElements(); change(elements); stubDocument(elements);
    expect(completeLiveObservation(expected)).toBe(false);
  });
  it('waits within the unchanged 10000 ms bound and passes the expected rows as the Playwright argument', async () => {
    const calls: {argument: unknown; timeout: number}[] = [];
    const page = {waitForFunction: (predicate: (argument: unknown) => unknown, argument: unknown, options: {timeout: number}) => {
      calls.push({argument, timeout: options.timeout});
      // Recreate the callback from source with a JSON argument, as Playwright does: imported closures cannot help it.
      const value: unknown = runInNewContext(`(${predicate.toString()})(${JSON.stringify(argument)})`, fakeGlobals(completeElements()));
      return value ? Promise.resolve({jsonValue: () => Promise.resolve(value), dispose: () => Promise.resolve()}) : Promise.reject(new Error('timeout'));
    }} as unknown as Page;
    expect(await waitForCompleteLive(page)).toEqual(Object.fromEntries(SYNTHETIC_V0_LIVE_ROWS));
    expect(calls).toEqual([{argument: expected, timeout: 10000}]);
    const stale = {values: SYNTHETIC_V0_VALUE_IDS, status: '^stale:', hidden: []};
    await expect(waitForNotCurrentLive(page, SYNTHETIC_V0_VALUE_IDS, '^stale:')).rejects.toThrow('timeout');
    expect(calls[1]).toEqual({argument: stale, timeout: 10000});
  });
});

const notCurrentElements = (status = 'stale: No recent SDK capture'): Record<string, FakeElement[]> => ({
  'telemetry-status': one(status), 'speed': one('Speed: unavailable'), 'fuel': one('Fuel: unavailable'),
  ...Object.fromEntries(SYNTHETIC_V0_VALUE_IDS.flatMap(id => [[id, one('unavailable', {box: {width: 100, height: 20, top: 900}})], [`${id}-reason`, one('not current')]]))
});
describe('ET-010b not-current live card observation', () => {
  const stale = {values: SYNTHETIC_V0_VALUE_IDS, status: '^stale:', hidden: SYNTHETIC_V0_HIDDEN_ROWS};
  it('accepts a stale dashboard whose every row is unavailable and not current', () => {
    stubDocument(notCurrentElements());
    expect(notCurrentLiveObservation(stale)).toMatchObject({status: 'stale: No recent SDK capture', speed: 'Speed: unavailable', 'live-gear': 'unavailable'});
  });
  it.each<[string, Change]>([
    ['a connected status', (elements: Record<string, FakeElement[]>) => {elements['telemetry-status'] = one('connected: Validated current observation');}],
    ['a current legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: 90 km/h');}],
    ['an offscreen legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: unavailable', {box: {width: 100, height: 20, top: 500}});}],
    ['a row still showing R1', (elements: Record<string, FakeElement[]>) => {elements['live-gear'] = one('R1'); delete elements['live-gear-reason'];}],
    ['a row with another reason', (elements: Record<string, FakeElement[]>) => {elements['live-cargo-reason'] = one('not yet observed');}],
    ['a hidden row present', (elements: Record<string, FakeElement[]>) => {elements['live-position'] = one('unavailable');}]
  ])('rejects %s', (_name, change) => {
    const elements = notCurrentElements(); change(elements); stubDocument(elements);
    expect(notCurrentLiveObservation(stale)).toBe(false);
  });
});

// ET-010c: the v1 card and overlay predicates.
describe('ET-010c combined live card observation', () => {
  it('accepts the combined rows with the v1 status line and rejects a v1 row left over in the v0-only expectation', () => {
    const elements = Object.fromEntries(SYNTHETIC_V0V1_LIVE_ROWS.map(([id, text]) => [id, one(text, {box: {width: 100, height: 20, top: 900}})]));
    stubDocument(elements);
    expect(completeLiveObservation({rows: SYNTHETIC_V0V1_LIVE_ROWS, hidden: SYNTHETIC_V0V1_HIDDEN_ROWS})).toMatchObject({
      'live-cargo': 'Synthetic Cargo', 'live-v1-status': 'connected: Validated current observation', 'live-event-loss-note': 'this version records no gameplay events'});
    expect(completeLiveObservation({rows: SYNTHETIC_V0_LIVE_ROWS, hidden: SYNTHETIC_V0_HIDDEN_ROWS})).toBe(false);
  });
});
const v1NotCurrentElements = (): Record<string, FakeElement[]> => ({
  'live-v1-status': one('stale: Renderer has no recent v1 SDK capture', {box: {width: 100, height: 20, top: 900}}), 'speed': one('Speed: 90 km/h'),
  ...Object.fromEntries(SYNTHETIC_V1_VALUE_IDS.flatMap(id => [[id, one('unavailable', {box: {width: 100, height: 20, top: 900}})], [`${id}-reason`, one('not current')]]))
});
describe('ET-010c not-current v1 observation', () => {
  const expectedV1 = {values: SYNTHETIC_V1_VALUE_IDS, status: '^stale:', speed: 'Speed: 90 km/h', statusId: 'live-v1-status', omitFuel: true};
  it('accepts unavailable v1 rows below the fold beside a current legacy speed line', () => {
    stubDocument(v1NotCurrentElements());
    expect(v1NotCurrentObservation(expectedV1)).toMatchObject({status: 'stale: Renderer has no recent v1 SDK capture', speed: 'Speed: 90 km/h', 'live-route-remaining': 'unavailable'});
  });
  it.each<[string, Change]>([
    ['a connected v1 status', (elements: Record<string, FakeElement[]>) => {elements['live-v1-status'] = one('connected: Validated current observation');}],
    ['a missing v1 status', (elements: Record<string, FakeElement[]>) => {delete elements['live-v1-status'];}],
    ['an unavailable legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: unavailable');}],
    ['an offscreen legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: 90 km/h', {box: {width: 100, height: 20, top: 500}});}],
    ['a v1 row still showing its value', (elements: Record<string, FakeElement[]>) => {elements['live-route-remaining'] = one('151.0 km'); delete elements['live-route-remaining-reason'];}],
    ['a v1 row with another reason', (elements: Record<string, FakeElement[]>) => {elements['live-position-reason'] = one('not yet observed');}],
    ['a missing v1 row', (elements: Record<string, FakeElement[]>) => {delete elements['live-game-mode'];}]
  ])('rejects %s', (_name, change) => {
    const elements = v1NotCurrentElements(); change(elements); stubDocument(elements);
    expect(v1NotCurrentObservation(expectedV1)).toBe(false);
  });
});

/** A fake overlay document: text by test id, and the root's data attributes. */
function stubOverlay(texts: Record<string, string>, freshness = 'current', duplicate?: string) {
  vi.stubGlobal('document', {querySelectorAll: (selector: string) => {
    const id = /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
    if (!id) throw new Error(`unexpected selector ${selector}`);
    if (id === 'overlay-root') return [{getAttribute: (name: string) => name === 'data-freshness' ? freshness : null}];
    if (!(id in texts)) return [];
    const element = {textContent: texts[id]};
    return id === duplicate ? [element, element] : [element];
  }});
}
const overlayTexts = (expected: Readonly<Record<string, string | null>>) =>
  Object.fromEntries(Object.entries(expected).filter(([key, text]) => key !== 'freshness' && text !== null)) as Record<string, string>;
describe('ET-010c overlay v1 observation', () => {
  it.each([
    ['current', SYNTHETIC_V1_OVERLAY_CURRENT, 'current'],
    ['v0 stale', SYNTHETIC_V1_OVERLAY_V0_STALE, 'stale'],
    ['v1 stale', SYNTHETIC_V1_OVERLAY_V1_STALE, 'current'],
    ['stopped', SYNTHETIC_V1_OVERLAY_STOPPED, 'unavailable']
  ])('accepts the %s overlay', (_name, expected, freshness) => {
    stubOverlay(overlayTexts(expected), freshness);
    expect(overlayV1Observation(expected)).toEqual({...expected});
  });
  it('writes a dash, never zero, for every unavailable v1 section', () => {
    for (const expected of [SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_STOPPED]) {
      for (const id of ['overlay-origin', 'overlay-distance-remaining', 'overlay-deadline']) expect(expected[id]).toBe('—');
    }
  });
  it.each<[string, (texts: Record<string, string>) => string | undefined]>([
    ['a wrong text', texts => {texts['overlay-origin'] = 'Synthetic City A'; return undefined;}],
    ['a missing section', texts => {delete texts['overlay-deadline']; return undefined;}],
    ['a detail that should be absent', texts => {texts['overlay-cargo-detail'] = '18.0 t'; return undefined;}],
    ['a duplicate element', () => 'overlay-destination'],
    ['another freshness', () => 'freshness']
  ])('rejects %s', (_name, change) => {
    const texts = overlayTexts(SYNTHETIC_V1_OVERLAY_V1_STALE), special = change(texts);
    stubOverlay(texts, special === 'freshness' ? 'stale' : 'current', special === 'freshness' ? undefined : special);
    expect(overlayV1Observation(SYNTHETIC_V1_OVERLAY_V1_STALE)).toBe(false);
  });
  it('records the sections outside the overlay root and those with cut-off values for review', () => {
    const box = (left: number, top: number, width: number, height: number) => ({left, top, right: left + width, bottom: top + height, width, height});
    const section = (id: string, bounds: ReturnType<typeof box>, cut = false) => ({getAttribute: () => `overlay-section-${id}`, getBoundingClientRect: () => bounds,
      querySelectorAll: () => [{scrollWidth: cut ? 240 : 80, clientWidth: 80}]});
    vi.stubGlobal('document', {
      querySelector: () => ({getAttribute: () => 'strip', getBoundingClientRect: () => box(0, 0, 1280, 38)}),
      querySelectorAll: () => [section('speed', box(10, 1, 80, 36)), section('origin', box(10, 39, 300, 36)), section('deadline', box(1200, 1, 120, 36)), section('cargo', box(100, 1, 80, 36), true)]
    });
    expect(overlayOverflow()).toEqual({layout: 'strip', root: {width: 1280, height: 38}, sections: ['speed', 'origin', 'deadline', 'cargo'],
      outside: ['origin', 'deadline'], truncated: ['cargo']});
  });
});


it.each(['en', 'ru'])('accepts only a coherent exact zero speed/fuel and numeric geometry in %s', language => {
  const zero = {speed: language === 'en' ? 'Speed: 0.0 km/h' : 'Скорость: 0.0 км/ч', fuel: language === 'en' ? 'Fuel: 0.0 L' : 'Топливо: 0.0 л', number: '0', arc: false, height: '0%', tankState: 'value', unavailable: false};
  const observe = (patch: Partial<typeof zero>) => {
    const sample = {...zero, ...patch};
    const document = {querySelector: (selector: string) => selector === '[data-testid="speed"]' ? null : selector === '[data-testid="live-speed-number"]' ? {textContent: sample.number} : selector === '[data-testid="fuel"]' ? {innerText: sample.fuel} : selector === '.yu-gauge-number' ? {textContent: sample.number} : selector === '.yu-gauge-speed' ? sample.arc ? {} : null : selector === '[data-testid="live.instrument.tank"]' ? {getAttribute: () => sample.tankState} : selector === '.yu-tank-unavailable' ? sample.unavailable ? {} : null : {style: {height: sample.height}}};
    return runInNewContext(`(${zeroLiveObservation.toString()})(language)`, {document, language}) as unknown;
  };
  expect(observe({})).toBe(true);
  expect(observe({number: '90'})).toBe(false);
  expect(observe({fuel: zero.fuel.replace('0.0', '73.0')})).toBe(false);
  expect(observe({number: '90.0'})).toBe(false);
  expect(observe({arc: true})).toBe(false);
  expect(observe({height: '7.3%'})).toBe(false);
  expect(observe({tankState: 'unavailable'})).toBe(false); expect(observe({unavailable: true})).toBe(false);
});

it.each(['wrong number','wrong unit','wrong accessible name','missing accessible name','hidden number','outside gauge','duplicate number','legacy paragraph','transparent number','transparent ancestor','clipped viewport','clipped ancestor'])('rejects actual SVG gauge evidence: %s', fault => {
  const elements: Record<string, FakeElement[]> = {'telemetry-status': one(current.status), fuel: one(current.fuel),
    'live-speed-number': one(fault === 'wrong number' ? '91' : '90'), 'live-speed-unit': one(fault === 'wrong unit' ? 'mph' : 'km/h'),
    'live-speed-gauge': [{innerText: '', attributes: {role: 'img', 'aria-label': 'Speed: 90 km/h; Engine RPM: 600 rpm'}}]};
  if (fault === 'wrong accessible name') elements['live-speed-gauge'][0].attributes!['aria-label'] = 'Speed: unavailable';
  if (fault === 'missing accessible name') delete elements['live-speed-gauge'][0].attributes!['aria-label'];
  if (fault === 'hidden number') elements['live-speed-number'][0].visibility = 'hidden';
  if (fault === 'outside gauge') elements['live-speed-number'][0].box = {width: 100, height: 20, top: 31};
  if (fault === 'duplicate number') elements['live-speed-number'].push(elements['live-speed-number'][0]);
  const globals = fakeGlobals(elements);
  if (fault === 'legacy paragraph') {const read = globals.document.querySelectorAll; globals.document.querySelectorAll = selector => selector === '[data-testid="speed"]' ? read('[data-testid="live-speed-number"]') : read(selector);}
  const getStyle = globals.getComputedStyle;
  if (fault === 'transparent number' || fault === 'transparent ancestor' || fault === 'clipped ancestor') {
    const read = globals.document.querySelectorAll;
    globals.document.querySelectorAll = selector => read(selector).map(node => selector === '[data-testid="live-speed-number"]'
      ? {...node, ...(fault === 'transparent number' ? {opacity: '0'} : {parentElement: {visibility: 'visible', opacity: fault === 'transparent ancestor' ? '0' : '1', overflowX: 'hidden', getBoundingClientRect: () => ({left: 50, right: 80})}})} : node);
    globals.getComputedStyle = node => ({...getStyle(node), ...node});
  }
  if (fault === 'clipped viewport') globals.innerWidth = 100;
  expect(runInNewContext('(' + currentTelemetryObservation.toString() + ')()', globals)).toBe(false);
});
