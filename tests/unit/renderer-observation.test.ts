import type {Page} from '@playwright/test';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  completeLiveObservation, currentTelemetryObservation, notCurrentLiveObservation, SYNTHETIC_V0_HIDDEN_ROWS, SYNTHETIC_V0_LIVE_ROWS, SYNTHETIC_V0_VALUE_IDS,
  waitForCompleteLive, waitForCurrentTelemetry, waitForNotCurrentLive, type RendererObservation
} from '../../scripts/ci/renderer-observation.mjs';

const current = {status: 'connected: Validated current observation', speed: 'Speed: 90.0 km/h', fuel: 'Fuel: 73.0 L'};
const stale = {status: 'stale: No recent current observation', speed: 'Speed: unavailable', fuel: 'Fuel: unavailable'};
function controlledPage(samples: RendererObservation[]) {
  let index = 0, elapsed = 0, disposed = false; const bounds: number[] = [];
  const next = () => samples[Math.min(index++, samples.length - 1)];
  const documentFor = (sample: RendererObservation) => ({querySelectorAll: (selector: string) => {
    const key = selector.includes('telemetry-status') ? 'status' : selector.includes('speed') ? 'speed' : 'fuel';
    return [{innerText: sample[key], getBoundingClientRect: () => ({width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110})}];
  }});
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
interface FakeElement {innerText: string; visibility?: string; box?: {width: number; height: number; top: number}}
type Change = (elements: Record<string, FakeElement[]>) => void;
function fakeGlobals(elements: Record<string, FakeElement[]>) {
  return {innerWidth: 784, innerHeight: 435, getComputedStyle: (element: {visibility: string}) => ({visibility: element.visibility}), document: {querySelectorAll: (selector: string) => {
    const id = /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
    if (!id) throw new Error(`unexpected selector ${selector}`);
    return (elements[id] ?? []).map(element => {
      const box = element.box ?? {width: 100, height: 20, top: 10};
      return {innerText: element.innerText, visibility: element.visibility ?? 'visible',
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
    ['a current legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: 90.0 km/h');}],
    ['an offscreen legacy speed', (elements: Record<string, FakeElement[]>) => {elements.speed = one('Speed: unavailable', {box: {width: 100, height: 20, top: 500}});}],
    ['a row still showing R1', (elements: Record<string, FakeElement[]>) => {elements['live-gear'] = one('R1'); delete elements['live-gear-reason'];}],
    ['a row with another reason', (elements: Record<string, FakeElement[]>) => {elements['live-cargo-reason'] = one('not yet observed');}],
    ['a hidden row present', (elements: Record<string, FakeElement[]>) => {elements['live-position'] = one('unavailable');}]
  ])('rejects %s', (_name, change) => {
    const elements = notCurrentElements(); change(elements); stubDocument(elements);
    expect(notCurrentLiveObservation(stale)).toBe(false);
  });
});
