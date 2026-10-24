import {zeroLiveObservation} from '../../scripts/ci/renderer-observation.mjs';
import type {Page} from '@playwright/test';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  clusterCentreProbe, completeLiveObservation, currentTelemetryObservation, notCurrentLiveObservation, overlayOverflow, overlayV1Observation, SYNTHETIC_V0_HIDDEN_ROWS,
  SYNTHETIC_V0_LIVE_ROWS, SYNTHETIC_V0_VALUE_IDS, SYNTHETIC_V0V1_HIDDEN_ROWS, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V1_OVERLAY_CURRENT, SYNTHETIC_V1_OVERLAY_STOPPED,
  SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_V1_STALE, SYNTHETIC_V1_LIVE_ROWS, SYNTHETIC_V1_VALUE_IDS, stripNumberProbe, v1NotCurrentObservation, waitForCompleteLive, waitForCurrentTelemetry,
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

// The real Yukon content area scrolls: primary instruments are in view, while Details follows Current job.
function scrollableDetails(v1Stale: boolean) {
  const elements = v1Stale ? v1NotCurrentElements() : notCurrentElements();
  if (!v1Stale) {
    for (const [id, text] of SYNTHETIC_V1_LIVE_ROWS) elements[id] = one(text, {box: {width: 100, height: 20, top: 900}});
  }
  for (const [id, nodes] of Object.entries(elements)) if (id.startsWith('live-')) {
    for (const node of nodes) node.box = {width: 100, height: 20, top: 900};
  }
  const observe = () => {
    const globals = fakeGlobals(elements), read = globals.document.querySelectorAll, style = globals.getComputedStyle;
    const scroll = {visibility: 'visible', opacity: '1', overflowX: 'hidden', overflowY: 'auto',
      getBoundingClientRect: () => ({left: 0, right: 784, top: 0, bottom: 435})};
    globals.document.querySelectorAll = selector => read(selector).map(node => ({...node, parentElement: scroll}));
    globals.getComputedStyle = node => ({...style(node), ...node});
    const expected = v1Stale ? {values: SYNTHETIC_V1_VALUE_IDS, status: '^stale:', speed: 'Speed: 90 km/h', statusId: 'live-v1-status', omitFuel: true}
      : {values: SYNTHETIC_V0_VALUE_IDS, status: '^stale:', hidden: []};
    return runInNewContext('(' + notCurrentLiveObservation.toString() + ')(expected)', {...globals, expected}) as unknown;
  };
  return {elements, observe, id: v1Stale ? 'live-route-remaining' : 'live-gear'};
}
it.each([false, true])('accepts exact below-fold details inside a real-shaped scrolling ancestor (v1 stale: %s)', v1Stale => {
  const fixture = scrollableDetails(v1Stale);
  expect(fixture.observe()).toMatchObject({[fixture.id]: 'unavailable', speed: v1Stale ? 'Speed: 90 km/h' : 'Speed: unavailable'});
});
it.each([false, true])('still rejects wrong/missing/duplicate/hidden below-fold detail values and reasons (v1 stale: %s)', v1Stale => {
  for (const reason of [false, true]) for (const fault of ['wrong', 'missing', 'duplicate', 'hidden', 'zero box']) {
    const fixture = scrollableDetails(v1Stale), id = fixture.id + (reason ? '-reason' : '');
    if (fault === 'wrong') fixture.elements[id] = one('unexpected');
    if (fault === 'missing') delete fixture.elements[id];
    if (fault === 'duplicate') fixture.elements[id].push(fixture.elements[id][0]);
    if (fault === 'hidden') fixture.elements[id][0].visibility = 'hidden';
    if (fault === 'zero box') fixture.elements[id][0].box = {width: 0, height: 20, top: 900};
    expect(fixture.observe(), id + '/' + fault).toBe(false);
  }
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

// ET-045d probes over a small fake layout: each value's width is 8 px per character, at least its reserve when `reserve` is
// set, and the strip lays its sections out from the left with a 14 px gap. Playwright serializes the probes, so they run
// from source in a fresh context, as above.
interface FakeText {nodeType: 3; nodeValue: string; parentElement?: FakeValue}
interface FakeValue {childNodes: FakeText[]; firstChild: FakeText; readonly scrollWidth: number; readonly clientWidth: number}
function fakeValue(text: string, width: (value: string) => number, cap = 1000): FakeValue {
  const node: FakeText = {nodeType: 3, nodeValue: text};
  const element = {childNodes: [node], firstChild: node, get scrollWidth() {return width(node.nodeValue);}, get clientWidth() {return Math.min(cap, width(node.nodeValue));}};
  node.parentElement = element; return element;
}
const edges = (left: number, top: number, width: number, height: number) => ({left, top, right: left + width, bottom: top + height, width, height});
const testId = (selector: string) => /data-testid="([^"]+)"/.exec(selector)?.[1] ?? '';
function fakeStrip({reserve = true, jitter = 0, rpmCap = 1000, omit = [] as string[], layout = 'strip', throwAt = -1} = {}) {
  const reserves: Record<string, number> = {speed: 3, gear: 2, rpm: 4};
  const width = (key: string) => (value: string) => 8 * Math.max(value.length, reserve ? reserves[key] : 0);
  const values: Record<string, FakeValue> = {'overlay-speed': fakeValue('90', width('speed')), 'overlay-speed-unit': fakeValue('km/h', () => 32),
    'overlay-gear': fakeValue('R1', width('gear')), 'overlay-rpm': fakeValue('600', width('rpm'), rpmCap), 'overlay-rpm-unit': fakeValue('rpm', () => 24)};
  for (const id of omit) delete values[id];
  let measured = 0;
  const sectionWidth = (id: string) => id === 'speed' ? 22 + values['overlay-speed'].clientWidth + 36 : id === 'gear' ? 22 + values['overlay-gear'].clientWidth
    : id === 'rpm' ? 22 + values['overlay-rpm'].clientWidth + 28 : 100;
  const order = ['speed', 'gear', 'rpm', 'fuel'];
  const sections = order.map((id, index) => ({getAttribute: () => `overlay-section-${id}`, getBoundingClientRect: () => {
    if (id === 'speed' && measured++ === throwAt) throw new Error('layout failed');
    const left = 12 + order.slice(0, index).reduce((sum, other) => sum + sectionWidth(other) + 14, 0) + (id === 'fuel' ? jitter * measured : 0);
    return edges(left, 1, sectionWidth(id), 38);
  }}));
  const row = {getBoundingClientRect: () => edges(0, 0, 1280, 40)};
  const root = {offsetWidth: 1280, getAttribute: () => layout, querySelectorAll: () => sections,
    querySelector: (selector: string) => selector === '.overlay-strip-row' ? row : values[testId(selector)] ?? null};
  const document = {querySelector: (selector: string) => selector === '[data-testid="overlay-root"]' ? root : null};
  const texts = () => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value.firstChild.nodeValue]));
  return {globals: {document}, texts};
}
interface ProbeResult {ok: boolean; reason?: string; restored: boolean; ring?: {track: string; limit: number};
  steps: {texts: Record<string, string>; moved?: string[]; truncated: string[]; outside?: string[]}[]}
const runProbe = (probe: {toString(): string}, globals: object, steps: unknown) =>
  JSON.parse(JSON.stringify(runInNewContext(`(${probe.toString()})(steps)`, {...globals, steps}))) as ProbeResult;
describe('ET-045d strip number probe', () => {
  const steps = [{speed: '0', speedUnit: 'km/h', rpm: '0', rpmUnit: 'rpm'}, {speed: '9'}, {speed: '10'}, {speed: '99'}, {speed: '100'}, {speed: '-5'}, {speed: '—'},
    {gear: 'N'}, {gear: '10'}, {gear: 'R1'}, {rpm: '999'}, {rpm: '1000'}, {rpm: '9999'}, {rpm: '—'}];
  it('accepts reserved widths and restores every text node', () => {
    const fake = fakeStrip(), before = fake.texts();
    const result = runProbe(stripNumberProbe, fake.globals, steps);
    expect(result).toMatchObject({ok: true, restored: true}); expect(result.steps).toHaveLength(steps.length);
    expect(result.steps.every(step => !step.moved?.length && !step.truncated.length)).toBe(true);
    expect(result.steps[4].texts).toEqual({speed: '100', speedUnit: 'km/h', gear: 'R1', rpm: '0', rpmUnit: 'rpm'});
    expect(fake.texts()).toEqual(before);
  });
  it('reports the section that grows with a digit and every neighbour it moves', () => {
    const fake = fakeStrip({reserve: false}), before = fake.texts();
    const result = runProbe(stripNumberProbe, fake.globals, steps);
    expect(result.ok).toBe(false); expect(result.restored).toBe(true);
    expect(result.steps[1].moved).toEqual([]);
    expect(result.steps[2].moved).toEqual(['speed', 'gear', 'rpm', 'fuel']);
    expect(result.steps[11].moved).toEqual(['rpm', 'fuel']);
    expect(fake.texts()).toEqual(before);
  });
  it('ignores differences up to 0.01 px and reports larger ones', () => {
    expect(runProbe(stripNumberProbe, fakeStrip({jitter: 0.0004}).globals, steps).ok).toBe(true);
    const result = runProbe(stripNumberProbe, fakeStrip({jitter: 0.02}).globals, steps);
    expect(result.ok).toBe(false); expect(result.steps[1].moved).toEqual(['fuel']);
  });
  it('reports a value cut off inside its box', () => {
    const result = runProbe(stripNumberProbe, fakeStrip({rpmCap: 24}).globals, steps);
    expect(result.ok).toBe(false); expect(result.steps[11].truncated).toEqual(['rpm']);
  });
  it('fails closed without a strip or a text node a step needs, and restores texts when layout throws', () => {
    expect(runProbe(stripNumberProbe, {document: {querySelector: () => null}}, steps)).toMatchObject({ok: false, reason: 'no-strip', steps: []});
    expect(runProbe(stripNumberProbe, fakeStrip({layout: 'card'}).globals, steps)).toMatchObject({ok: false, reason: 'no-strip'});
    expect(runProbe(stripNumberProbe, fakeStrip().globals, [])).toMatchObject({ok: false, reason: 'no-strip'});
    expect(runProbe(stripNumberProbe, fakeStrip({omit: ['overlay-rpm-unit']}).globals, steps)).toMatchObject({ok: false, reason: 'missing rpmUnit'});
    expect(runProbe(stripNumberProbe, fakeStrip().globals, [{fuel: '1.0'}])).toMatchObject({ok: false, reason: 'missing fuel'});
    const fake = fakeStrip({throwAt: 3}), before = fake.texts();
    expect(() => runInNewContext(`(${stripNumberProbe.toString()})(steps)`, {...fake.globals, steps})).toThrow('layout failed');
    expect(fake.texts()).toEqual(before);
  });
});

// The fake gauge: a 186 px ring frame at the origin (centre 93, 93; scale 1.55), the speed centred, the gear above and the
// RPM below it, 8 px per character wide; the RPM ring's inner edge is (40 - 1.5) x 1.55 = 59.675 px from the centre.
function fakeCluster({rpmTrack = true, speedTrack = true, omit = [] as string[], layout = 'cluster'} = {}) {
  const values: Record<string, FakeValue> = {'overlay-speed': fakeValue('90', value => 20 * value.length), 'overlay-speed-unit': fakeValue('km/h', () => 30),
    'overlay-gear': fakeValue('R1', value => 8 * value.length), 'overlay-rpm': fakeValue('600', value => 8 * value.length), 'overlay-rpm-unit': fakeValue('rpm', () => 24)};
  for (const id of omit) delete values[id];
  const centred = (width: number, top: number, height: number) => edges(93 - width / 2, 93 + top, width, height);
  const wide = (id: string) => values[id]?.scrollWidth ?? 0;
  const boxes: Record<string, () => ReturnType<typeof edges>> = {
    'overlay-speed': () => centred(wide('overlay-speed'), -23, 34), 'overlay-speed-unit': () => centred(30, 11, 12),
    'overlay-gear': () => centred(wide('overlay-gear'), -44, 16), 'overlay-rpm': () => centred(wide('overlay-rpm'), 27, 14),
    'overlay-rpm-unit': () => centred(24, 27, 14), 'overlay-section-speed': () => centred(Math.max(wide('overlay-speed'), 30), -23, 46),
    'overlay-section-gear': () => centred(wide('overlay-gear') + 16, -45, 18), 'overlay-section-rpm': () => centred(wide('overlay-rpm') + 27, 27, 14)};
  const tracks: Record<string, {r: string; stroke: string}> = {...(rpmTrack ? {'overlay-rpm-track': {r: '40', stroke: '3px'}} : {}), ...(speedTrack ? {'overlay-speed-track': {r: '52', stroke: '6px'}} : {})};
  const element = (id: string) => {
    if (id in tracks) return {getAttribute: (name: string) => name === 'r' ? tracks[id].r : id, strokeWidth: tracks[id].stroke};
    if (!(id in boxes) || (!id.startsWith('overlay-section-') && !(id in values))) return null;
    return Object.assign(values[id] ?? {}, {getBoundingClientRect: boxes[id]});
  };
  const svg = {getBoundingClientRect: () => edges(0, 0, 186, 186)};
  const root = {offsetWidth: 440, getAttribute: () => layout, querySelector: (selector: string) => selector === '.overlay-ring' ? svg : element(testId(selector))};
  const document = {querySelector: (selector: string) => selector === '[data-testid="overlay-root"]' ? root : null};
  const texts = () => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value.firstChild.nodeValue]));
  return {globals: {document, getComputedStyle: (node: {strokeWidth?: string}) => ({strokeWidth: node.strokeWidth})}, texts};
}
describe('ET-045d cluster centre probe', () => {
  const steps = [{rpm: '999', rpmUnit: 'rpm'}, {rpm: '1000'}, {rpm: '9999', rpmUnit: 'об/мин'}, {gear: 'N'}, {gear: '12'}, {speed: '100'}, {speed: '—', speedUnit: 'миль/ч'}];
  it('accepts parts inside the inner ring and restores every text node', () => {
    const fake = fakeCluster(), before = fake.texts();
    const result = runProbe(clusterCentreProbe, fake.globals, steps);
    expect(result).toMatchObject({ok: true, restored: true, ring: {track: 'overlay-rpm-track'}});
    expect(result.ring?.limit).toBeCloseTo(59.665, 3);
    expect(result.steps[2].texts).toEqual({speed: '90', speedUnit: 'km/h', gear: 'R1', rpm: '9999', rpmUnit: 'об/мин'});
    expect(fake.texts()).toEqual(before);
  });
  it('reports a centre part that crosses the inner ring', () => {
    const fake = fakeCluster(), before = fake.texts();
    const result = runProbe(clusterCentreProbe, fake.globals, [{rpm: '2528 об/мин'}]);
    expect(result.ok).toBe(false); expect(result.steps[0].outside).toEqual(['overlay-rpm', 'overlay-section-rpm']);
    expect(fake.texts()).toEqual(before);
  });
  it('measures against the speed ring while RPM is off', () => {
    const result = runProbe(clusterCentreProbe, fakeCluster({rpmTrack: false}).globals, [{rpm: '2528 об/мин'}]);
    expect(result).toMatchObject({ok: true, ring: {track: 'overlay-speed-track'}});
  });
  it('fails closed without a gauge, a ring or a text node a step needs', () => {
    expect(runProbe(clusterCentreProbe, {document: {querySelector: () => null}}, steps)).toMatchObject({ok: false, reason: 'no-gauge', steps: []});
    expect(runProbe(clusterCentreProbe, fakeCluster({layout: 'strip'}).globals, steps)).toMatchObject({ok: false, reason: 'no-gauge'});
    expect(runProbe(clusterCentreProbe, fakeCluster({rpmTrack: false, speedTrack: false}).globals, steps)).toMatchObject({ok: false, reason: 'no-gauge'});
    expect(runProbe(clusterCentreProbe, fakeCluster({omit: ['overlay-gear']}).globals, steps)).toMatchObject({ok: false, reason: 'missing gear'});
  });
});
