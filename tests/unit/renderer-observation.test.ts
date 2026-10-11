import type {Page} from '@playwright/test';
import {runInNewContext} from 'node:vm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {currentTelemetryObservation, waitForCurrentTelemetry, type RendererObservation} from '../../scripts/ci/renderer-observation.mjs';

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
