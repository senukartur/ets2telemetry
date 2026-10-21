// Inert installed-harness UI boundary: no application, registry, installer or user filesystem is touched.
import type {Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {settingsPanel, waitForStartup} from '../../scripts/ci/ui-navigation.mjs';
function fixture() {
  let route = 'live', panel = 'general', remaining = 900;
  const calls: {action: string; timeout: number}[] = [], caps: number[] = [];
  const record = (action: string, timeout: number) => {calls.push({action, timeout}); remaining -= 17;};
  const left = (cap: number) => {caps.push(cap); return Math.max(1, Math.min(cap, remaining));};
  const page = {
    getByTestId: (id: string) => ({
      click: ({timeout}: {timeout: number}) => {
        record(id, timeout);
        if (id.startsWith('tab-')) route = id.slice(4);
        if (id.startsWith('settings.nav.')) {if (route !== 'settings') return Promise.reject(new Error('Settings hidden')); panel = id.slice(13);}
        return Promise.resolve();
      },
      waitFor: ({state, timeout}: {state: string; timeout: number}) => {
        if (id !== 'uninstall-warning' || route !== 'settings' || panel !== 'about') return Promise.reject(new Error('About hidden'));
        expect(state).toBe('visible'); record('warning-visible', timeout); return Promise.resolve();
      },
      innerText: ({timeout}: {timeout: number} = {timeout: 10000}) => {
        if (id !== 'uninstall-warning' || route !== 'settings' || panel !== 'about') return Promise.reject(new Error('About hidden'));
        record('warning-text', timeout); return Promise.resolve('trip history, captures, exports');
      }
    }),
    locator: (selector: string) => ({evaluate: (_callback: unknown, _argument: unknown, {timeout}: {timeout: number}) => {expect(selector).toBe('.yu-content'); record('scroll-reset', timeout); return Promise.resolve();}}),
    getByText: (text: string, options: {exact: boolean}) => ({waitFor: ({state, timeout}: {state: string; timeout: number}) => {
      expect(text).toBe('Telemetry service ready; isolated storage probe verified'); expect(options).toEqual({exact: true}); expect(state).toBe('visible');
      if (route !== 'settings' || panel !== 'data') return Promise.reject(new Error('Data startup hidden')); record('startup-visible', timeout); return Promise.resolve();
    }})
  } as unknown as Page;
  return {page, calls, caps, left, current: () => ({route, panel})};
}
it('requires actual Data navigation for exact visible startup and retains the caller remaining budget for every operation', async () => {
  const f = fixture();
  await expect(f.page.getByText('Telemetry service ready; isolated storage probe verified', {exact: true}).waitFor({state: 'visible', timeout: 15000})).rejects.toThrow('Data startup hidden');
  await waitForStartup(f.page, f.left, 15000);
  expect(f.calls.map(call => call.action)).toEqual(['tab-settings', 'scroll-reset', 'settings.nav.data', 'startup-visible', 'tab-live', 'scroll-reset']);
  expect(f.calls.map(call => call.timeout)).toEqual([900, 883, 866, 849, 832, 815]);
  expect(f.caps).toEqual([5000, 5000, 5000, 15000, 5000, 5000]); expect(f.current().route).toBe('live');
});
it('requires actual About navigation before the uninstall warning and propagates the remaining cap', async () => {
  const f = fixture();
  await expect(f.page.getByTestId('uninstall-warning').innerText()).rejects.toThrow('About hidden');
  await settingsPanel(f.page, 'about', f.left);
  await f.page.getByTestId('uninstall-warning').waitFor({state: 'visible', timeout: f.left(10000)});
  expect(await f.page.getByTestId('uninstall-warning').innerText({timeout: f.left(10000)})).toBe('trip history, captures, exports');
  expect(f.calls).toEqual([{action: 'tab-settings', timeout: 900}, {action: 'scroll-reset', timeout: 883}, {action: 'settings.nav.about', timeout: 866}, {action: 'warning-visible', timeout: 849}, {action: 'warning-text', timeout: 832}]);
  expect(f.caps).toEqual([5000, 5000, 5000, 10000, 10000]);
});
it('preserves existing non-installer helper defaults and binds both installer startup paths and in-app About to these tested helpers', async () => {
  const f = fixture(); await waitForStartup(f.page);
  expect(f.calls.map(call => call.timeout)).toEqual([5000, 5000, 5000, 10000, 5000, 5000]);
  const source = readFileSync('scripts/installer/installer-lifecycle.mjs', 'utf8').replaceAll('\r\n', '\n');
  expect(source).toContain('await waitForStartup(dashboard, undefined, 15000);');
  expect(source).toContain('await waitForStartup(dashboard, left, 15000);');
  expect(source).toContain("await settingsPanel(dashboard, 'about', left);\n    await dashboard.getByTestId('uninstall-warning').waitFor({state: 'visible', timeout: left(10000)});");
  expect(source).not.toContain("dashboard.getByText('Telemetry service ready;");
});
