import {describe, expect, it, vi} from 'vitest';
import net from 'node:net';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts, type RuntimeReceiptCase} from '../shared/runtime-receipt-validator';

// Runtime helpers are JavaScript outside the application TypeScript project.
const sourceModule = pathToFileURL(path.resolve('scripts/ci/live-smoke-source.mjs')).href;
const observationModule = pathToFileURL(path.resolve('scripts/ci/overlay-observation.mjs')).href;
const current = {source: 'ETS2', origin: 'synthetic', status: 'connected', freshness: 'current', speed: '90.0', fuel: '73.0', speedUnit: 'km/h', fuelUnit: 'L'};
const phases = ['initial','changed','missing','zero','restored','silent-open-stale','resumed','overlay-reload',
  'overlay-credit-recovery','dashboard-reload','before-dashboard-stall','during-dashboard-stall','dashboard-credit-recovery','disconnected'];

it('holds an actual isolated synthetic pipe open, resumes fresh/missing/zero readings and preserves source identity', async () => {
  const {startLiveSmokeSource} = await import(sourceModule);
  const source = await startLiveSmokeSource(path.resolve('.'));
  const socket = net.createConnection(source.endpoint);
  const messages: ReturnType<typeof JSON.parse>[] = [];
  let bytes = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
      const length = bytes.readUInt32LE(0);
      messages.push(JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')));
      bytes = bytes.subarray(4 + length);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {socket.once('connect', resolve); socket.once('error', reject);});
    const hello = Buffer.from(JSON.stringify({kind: 'hello', version: {major: 0, minor: 0}, data: {diagnostics: false}}));
    const header = Buffer.alloc(4); header.writeUInt32LE(hello.length); socket.write(Buffer.concat([header, hello]));
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'snapshot')).toBe(true), {timeout: 1500, interval: 20});
    const initial = messages.find(message => message.kind === 'checkpoint')!;
    expect(initial.source.origin).toBe('synthetic'); expect(initial.data.state.window).toEqual({available: false, reason: 'not-observed'});
    expect(initial.data.state.speed).toEqual({available: true, value: 25, unit: 'm/s'});
    expect(initial.data.state.fuel).toEqual({available: true, value: 73, unit: 'L'});
    const identity = source.statistics().identity;
    source.hold(); await new Promise(resolve => setTimeout(resolve, 75));
    const frames = source.statistics().frames;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(source.statistics()).toMatchObject({connections: 1, activeClients: 1, held: true, frames, identity});
    const index = messages.length; source.setUnavailable(); source.resume();
    await vi.waitFor(() => expect(messages.slice(index).some(message => message.data?.state?.speed.available === false && message.data?.state?.fuel.available === false)).toBe(true), {timeout: 1500, interval: 20});
    const zero = messages.length; source.setReading(0, 0);
    await vi.waitFor(() => expect(messages.slice(zero).some(message => message.data?.state?.speed.value === 0 && message.data?.state?.speed.available === true && message.data?.state?.fuel.value === 0)).toBe(true), {timeout: 1500, interval: 20});
    const changed = messages.length; source.setReading(20, 71);
    await vi.waitFor(() => expect(messages.slice(changed).some(message => message.data?.state?.speed.value === 20 && message.data?.state?.fuel.value === 71)).toBe(true), {timeout: 1500, interval: 20});
    expect(() => source.setReading(Number.NaN, 0)).toThrow(); expect(() => source.setReading(0, -1)).toThrow();
    await source.stop();
    expect(source.statistics()).toMatchObject({connections: 1, activeClients: 0, stopped: true, origin: 'synthetic', history: false, identity});
    expect(messages.every(message => message.source.pluginSessionId === identity.pluginSessionId)).toBe(true);
    expect(messages.every(message => message.source.processInstanceId === identity.processInstanceId && message.capture.clockId === identity.clockId)).toBe(true);
  } finally {socket.destroy(); await source.stop();}
}, 6000);

describe('coherent hidden-renderer observations', () => {
  // ET-012a DOM contract: the layout root's data attributes and separate speed/fuel number and unit elements.
  // `affected` limits an alteration to one test id, so each required element is shown to be required.
  function fakeDocument(sample: typeof current, alteration?: string, affected?: string) {
    const elements: Record<string, {text?: string; data?: Record<string, string>}> = {
      'overlay-root': {data: {'data-source': sample.source, 'data-origin': sample.origin, 'data-status': sample.status, 'data-freshness': sample.freshness}},
      'overlay-speed': {text: sample.speed}, 'overlay-speed-unit': {text: sample.speedUnit},
      'overlay-fuel': {text: sample.fuel}, 'overlay-fuel-unit': {text: sample.fuelUnit}
    };
    return {querySelectorAll: (selector: string) => {
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1] ?? '';
      const element = elements[id];
      if (!element) return [];
      const altered = alteration !== undefined && (affected === undefined || affected === id);
      const node = {innerText: element.text, getAttribute: (name: string) => element.data?.[name] ?? null,
        getBoundingClientRect: () => ({width: altered && alteration === 'zero-box' ? 0 : 100, height: 20, top: altered && alteration === 'below' ? 38 : 10,
          bottom: 30, left: 10, right: 110}), hidden: altered && alteration === 'hidden'};
      return altered && alteration === 'missing' ? [] : altered && alteration === 'duplicate' ? [node, node] : [node];
    }};
  }
  async function observe(sample: typeof current, alteration?: string, affected?: string) {
    const {overlayObservation} = await import(observationModule);
    return runInNewContext(`(${overlayObservation.toString()})(expected)`, {expected: {...current, statuses: ['connected']},
      document: fakeDocument(sample, alteration, affected), innerWidth: 1280, innerHeight: 38,
      getComputedStyle: (node: {hidden: boolean}) => ({visibility: node.hidden ? 'hidden' : 'visible'})});
  }
  it('accepts one complete current observation with explicit origin and units', async () => {
    const {overlayObservation} = await import(observationModule);
    expect(typeof overlayObservation).toBe('function');
    // The exact-state form also protects the callback from requiring module closures.
    expect(runInNewContext(`(${overlayObservation.toString()})(expected)`, {expected: current, document: fakeDocument(current), innerWidth: 1280, innerHeight: 38,
      getComputedStyle: () => ({visibility: 'visible'})})).toEqual(current);
  });
  it.each(['missing','duplicate','hidden','zero-box','below'])('rejects %s DOM fields', async alteration => {expect(await observe(current, alteration)).toBe(false);});
  it.each(['overlay-root', 'overlay-speed', 'overlay-speed-unit', 'overlay-fuel', 'overlay-fuel-unit'])('requires exactly one visible %s', async id => {
    for (const alteration of ['missing', 'duplicate', 'hidden', 'zero-box']) expect(await observe(current, alteration, id), alteration).toBe(false);
  });
  it('rejects a root without the state attributes', async () => {
    const {overlayObservation} = await import(observationModule);
    const document = fakeDocument(current), select = document.querySelectorAll;
    document.querySelectorAll = (selector: string) => selector.includes('overlay-root')
      ? select(selector).map(node => ({...node, getAttribute: (name: string) => name === 'data-status' ? null : node.getAttribute(name)})) : select(selector);
    expect(runInNewContext(`(${overlayObservation.toString()})(expected)`, {expected: {speed: '90.0'}, document, innerWidth: 1280, innerHeight: 38,
      getComputedStyle: () => ({visibility: 'visible'})})).toBe(false);
  });
  it.each([
    {...current, status: 'stale', freshness: 'stale'}, {...current, origin: 'game'}, {...current, speed: '72.0'},
    {...current, fuel: '71.0'}, {...current, speedUnit: 'mph'}, {...current, fuelUnit: 'US gal'}
  ])('cannot accept mismatched state, readings, origin or units', async sample => {expect(await observe(sample)).toBe(false);});
});

describe('ET-012c strip containment observation', () => {
  // Hand-derived from tests/fixtures/protocol-v0/checkpoint.json: range stays hidden because its estimate is not observed.
  const EXPECTED = ['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time'];
  type Box = {left: number; top: number; width: number; height: number};
  interface Layout {sections?: string[]; roots?: number; layout?: string; freshness?: string; viewport?: {innerWidth: number; innerHeight: number};
    root?: Box; row?: Box; item?: Record<string, Box>; maxWidth?: Record<string, string>; truncated?: string[]}
  const rect = ({left, top, width, height}: Box) => ({left, top, width, height, right: left + width, bottom: top + height});
  // A 1280 x 110 window: the root fills it, the strip row is 1260 wide and three 36 px rows high, and every item is 90 x 36
  // on the first row after a 96 px synthetic tag. `item` moves single sections; `maxWidth` overrides computed maximum widths.
  function stripDocument({sections = EXPECTED, roots = 1, layout = 'strip', freshness = 'current', root = {left: 0, top: 0, width: 1280, height: 110},
    row = {left: 10, top: 0, width: 1260, height: 110}, item = {}, truncated = []}: Layout = {}) {
    const node = (testId: string, box: Box, extra: Record<string, unknown> = {}) => ({testId, className: testId === 'overlay-tag-origin' ? 'overlay-tag' : 'overlay-item',
      getAttribute: (name: string) => name === 'data-testid' ? testId : null, getBoundingClientRect: () => rect(box), ...extra});
    const nodes = sections.map((id, index) => node(`overlay-section-${id}`, item[id] ?? {left: 120 + index * 100, top: 1, width: 90, height: 36},
      {querySelector: (selector: string) => selector === '.overlay-value' ? {scrollWidth: truncated.includes(id) ? 200 : 60, clientWidth: 60} : null}));
    const strip = {...node('strip-row', row), children: [node('overlay-tag-origin', {left: 12, top: 8, width: 96, height: 20}), ...nodes]};
    const rootNode = {getAttribute: (name: string) => ({'data-layout': layout, 'data-freshness': freshness} as Record<string, string>)[name] ?? null,
      getBoundingClientRect: () => rect(root), querySelector: (selector: string) => selector === '.overlay-strip-row' ? strip : null,
      querySelectorAll: (selector: string) => selector === '[data-testid^="overlay-section-"]' ? nodes : []};
    return {querySelectorAll: (selector: string) => selector === '[data-testid="overlay-root"]' ? Array.from({length: roots}, () => rootNode) : []};
  }
  async function observeStrip(layout: Layout = {}, expected: string[] = EXPECTED) {
    const {stripLayoutObservation} = await import(observationModule);
    const viewport = layout.viewport ?? {innerWidth: 1280, innerHeight: 110};
    // The exact-state form also protects the callback from requiring module closures; the JSON round trip stands in for
    // Playwright's serialization, which returns plain objects of this realm.
    return JSON.parse(JSON.stringify(runInNewContext(`(${stripLayoutObservation.toString()})(expected)`, {expected: {sections: expected},
      document: stripDocument(layout), ...viewport,
      getComputedStyle: (node: {testId: string}) => ({maxWidth: layout.maxWidth?.[node.testId] ?? '140px'})}))) as false | Record<string, unknown>;
  }
  it('names the sections the synthetic checkpoint fixture shows in the strip', async () => {
    const {STRIP_SMOKE_SECTIONS, STRIP_SMOKE_VIEWPORT} = await import(observationModule);
    expect(STRIP_SMOKE_SECTIONS).toEqual(EXPECTED);
    expect(STRIP_SMOKE_VIEWPORT).toEqual({innerWidth: 1280, innerHeight: 110});
  });
  it('reports every shown section inside the window and the strip row, every item capped, and records truncation and rows', async () => {
    expect(await observeStrip({truncated: ['cargo']})).toEqual({viewport: {innerWidth: 1280, innerHeight: 110}, sections: EXPECTED,
      outside: [], uncapped: [], truncated: ['cargo'], rows: 1});
  });
  it.each([
    {name: 'below the window', item: {'game-time': {left: 120, top: 110, width: 90, height: 36}}},
    {name: 'partly below the window', item: {'game-time': {left: 120, top: 80, width: 90, height: 36}}},
    {name: 'past the right edge', item: {'game-time': {left: 1250, top: 1, width: 90, height: 36}}},
    {name: 'outside only the strip row', row: {left: 10, top: 0, width: 1260, height: 38}, item: {'game-time': {left: 120, top: 37, width: 90, height: 36}}},
    {name: 'with an empty box', item: {'game-time': {left: 120, top: 1, width: 0, height: 36}}}
  ])('lists a section $name as outside', async ({item, row}) => {
    expect(await observeStrip({item, ...(row ? {row} : {})})).toMatchObject({outside: ['game-time'], uncapped: []});
  });
  it('lists every strip item without a maximum width as uncapped', async () => {
    expect(await observeStrip({maxWidth: {'overlay-tag-origin': 'none', 'overlay-section-cargo': 'none'}}))
      .toMatchObject({outside: [], uncapped: ['overlay-tag-origin', 'overlay-section-cargo']});
  });
  it.each([
    {name: 'a missing section', layout: {sections: EXPECTED.slice(1)}},
    {name: 'an extra section', layout: {sections: [...EXPECTED, 'range']}},
    {name: 'another section order', layout: {sections: [EXPECTED[1], EXPECTED[0], ...EXPECTED.slice(2)]}},
    {name: 'another layout', layout: {layout: 'card'}},
    {name: 'a stale root', layout: {freshness: 'stale'}},
    {name: 'no root', layout: {roots: 0}},
    {name: 'two roots', layout: {roots: 2}}
  ])('waits instead of observing $name', async ({layout}) => {
    expect(await observeStrip(layout)).toBe(false);
  });
  it('accepts the reserved window with every section inside and capped, and rejects any other result', async () => {
    const {verifyStripLayout} = await import(observationModule);
    const valid = await observeStrip();
    expect(verifyStripLayout(valid)).toBe(valid);
    expect(() => verifyStripLayout({...valid, outside: ['expected-income', 'game-time']})).toThrow('Enabled strip sections lie outside the overlay window');
    expect(() => verifyStripLayout({...valid, viewport: {innerWidth: 1280, innerHeight: 38}})).toThrow('The strip overlay window must have its reserved size');
    expect(() => verifyStripLayout({...valid, uncapped: ['overlay-section-cargo']})).toThrow('Every strip item must have a maximum width');
    const unreserved = await observeStrip({viewport: {innerWidth: 1280, innerHeight: 38}});
    expect(() => verifyStripLayout(unreserved)).toThrow('reserved size');
  });
});

describe('debugger-paused stall start, independent observation and resume ordering', () => {
  // The fake DevTools session keeps the renderer "paused" until the code under test sends Debugger.resume.
  type Mode = 'during' | 'after' | 'late-metadata' | 'missing-reading-time' | 'foreign-frame' | 'exception-pause' | 'no-pause';
  async function exercise(mode: Mode, {requested = 40, now}: {requested?: number; now?: () => number} = {}) {
    const {proveIndependentDuringStall} = await import(observationModule);
    const order: string[] = [], proof: ReturnType<typeof JSON.parse> = {};
    const listeners = new Map<string, (event: unknown) => void>();
    let marker = '', finish!: (response: unknown) => void, resumed!: () => void;
    const resumeSent = new Promise<void>(resolve => {resumed = resolve;});
    const session = {
      on: (event: string, listener: (event: unknown) => void) => {listeners.set(event, listener);},
      detach: () => {order.push('detached'); return Promise.resolve();},
      send: async (method: string, params: {expression?: string} = {}) => {
        order.push(method);
        if (method === 'Runtime.evaluate') {
          marker = /"(ETS2TELEMETRY_OVERLAY_STALL_[0-9a-f-]{36})"/.exec(params.expression ?? '')![1];
          expect(params.expression).toContain('debugger;');
          return new Promise(resolve => {
            finish = resolve;
            if (mode !== 'no-pause') queueMicrotask(() => listeners.get('Debugger.paused')?.({reason: mode === 'exception-pause' ? 'exception' : 'other', callFrames: [{callFrameId: 'frame-1'}]}));
          });
        }
        if (method === 'Debugger.evaluateOnCallFrame') return {result: {value: {marker: mode === 'foreign-frame' ? 'unrelated' : marker, rendererStartedMonotonicMs: 100}}};
        if (method === 'Debugger.resume') {
          resumed();
          queueMicrotask(() => finish?.({result: {value: {marker, rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 100 + requested}}}));
        }
        return {};
      }
    };
    const page = {context: () => ({newCDPSession: (target: unknown) => {expect(target).toBe(page); return Promise.resolve(session);}})};
    const source = {setReading: (speed: number, fuel: number) => {order.push('reading-changed'); expect([speed, fuel]).toEqual([20, 71]);},
      statistics: () => ({connections: 1, activeClients: 1})};
    const observation = async () => {
      if (mode === 'after') await resumeSent;
      order.push('independent-observed');
      const observedObserverMonotonicMs = now ? now() : performance.now();
      if (mode === 'late-metadata') await resumeSent;
      return {reading: {status: 'connected: current', speed: 'Speed: 72.0 km/h', fuel: 'Fuel: 71.0 L',
        ...(mode === 'missing-reading-time' ? {} : {observedObserverMonotonicMs})}};
    };
    const promise = proveIndependentDuringStall(page, 'overlay', observation, source, proof, {requestedMilliseconds: requested, ...(now ? {now} : {})});
    return {promise, proof, order};
  }
  it('changes source only after the owned pause barrier, observes before resume and holds the full pause', async () => {
    const requested = 40, {promise, proof, order} = await exercise('during'); await promise;
    expect(order).toEqual(['Debugger.enable','Runtime.evaluate','Debugger.evaluateOnCallFrame','reading-changed','independent-observed','Debugger.resume','detached']);
    expect(proof).toMatchObject({started: true, completed: true, pendingAtObservation: true, requestedMilliseconds: requested, stallMethod: 'debugger-pause',
      pauseReason: 'other', rendererStartBarrierMonotonicMs: 100, rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 100 + requested});
    expect(proof.observedObserverMonotonicMs).toBeLessThan(proof.resumeRequestedObserverMonotonicMs);
    expect(proof.resumeRequestedObserverMonotonicMs - proof.startedObserverMonotonicMs).toBeGreaterThanOrEqual(requested);
    expect(proof.resumeRequestedObserverMonotonicMs).toBeLessThanOrEqual(proof.completedObserverMonotonicMs);
    expect(proof.readingObservedObserverMonotonicMs).toBeGreaterThan(proof.readingChangedObserverMonotonicMs);
    expect(proof.cleanupResumeObserverMonotonicMs).toBeUndefined();
  });
  it('keeps the renderer paused when a millisecond timer fires just before the high-resolution deadline', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      // Every read advances the injected driver clock slightly, as a real monotonic clock would.
      let clock = 1000;
      const {promise, proof, order} = await exercise('during', {requested: 6000, now: () => (clock += 0.001)});
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toContain('independent-observed'); expect(order).not.toContain('Debugger.resume');
      const resumeAt = proof.startedObserverMonotonicMs + 6000;
      clock = resumeAt - 0.05; await vi.advanceTimersByTimeAsync(6001);
      expect(order).not.toContain('Debugger.resume');
      clock = resumeAt; await vi.advanceTimersByTimeAsync(2); await promise;
      expect(order.slice(-2)).toEqual(['Debugger.resume','detached']);
      expect(proof.resumeRequestedObserverMonotonicMs - proof.startedObserverMonotonicMs).toBeGreaterThanOrEqual(6000);
    } finally {vi.useRealTimers();}
  });
  it('resumes at the requested time and rejects an observation received after resume', async () => {
    const {promise, proof, order} = await exercise('after');
    await expect(promise).rejects.toThrow('Independent reading arrived after'); expect(proof.pendingAtObservation).toBe(false);
    expect(order.indexOf('Debugger.resume')).toBeLessThan(order.indexOf('independent-observed')); expect(order.at(-1)).toBe('detached');
    expect(proof.resumeRequestedObserverMonotonicMs).toBeDefined(); expect(proof.cleanupResumeObserverMonotonicMs).toBeUndefined();
  });
  it('retains an early DOM timestamp but rejects a composite whose metadata arrived after resume', async () => {
    const {promise, proof} = await exercise('late-metadata');
    await expect(promise).rejects.toThrow('Independent reading arrived after');
    expect(proof.readingObservedObserverMonotonicMs).toBeLessThan(proof.resumeRequestedObserverMonotonicMs);
    expect(proof.pendingAtObservation).toBe(false);
  });
  it('rejects a missing DOM receipt time without inventing when the reading was observed', async () => {
    const {promise, proof, order} = await exercise('missing-reading-time');
    await expect(promise).rejects.toThrow('Changed DOM reading must precede');
    expect(proof.readingObservedObserverMonotonicMs).toBeUndefined(); expect(order.slice(-2)).toEqual(['Debugger.resume','detached']);
    // The early cleanup resume must not look like a completed six-second hold.
    expect(proof.resumeRequestedObserverMonotonicMs).toBeUndefined(); expect(proof.cleanupResumeObserverMonotonicMs).toBeDefined();
  });
  it.each([['foreign-frame', 'outside the owned stall frame'], ['exception-pause', 'unexpected reason']] as const)(
    'rejects a %s pause without changing source and never leaves the renderer paused', async (mode, message) => {
      const {promise, proof, order} = await exercise(mode);
      await expect(promise).rejects.toThrow(message);
      expect(proof.started).toBe(false); expect(order).not.toContain('reading-changed'); expect(order.slice(-2)).toEqual(['Debugger.resume','detached']);
      expect(proof.resumeRequestedObserverMonotonicMs).toBeUndefined(); expect(proof.cleanupResumeObserverMonotonicMs).toBeDefined();
    });
  it('rejects a renderer that never pauses without inventing a started observation', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const {promise, proof, order} = await exercise('no-pause');
      const rejection = expect(promise).rejects.toThrow('EXPECTED_RENDERER_PAUSE_WITHIN_10_SECONDS');
      await vi.advanceTimersByTimeAsync(10000); await rejection;
      expect(proof.started).toBe(false); expect(order).not.toContain('reading-changed'); expect(order.at(-1)).toBe('detached');
      expect(proof.resumeRequestedObserverMonotonicMs).toBeUndefined(); expect(proof.cleanupResumeObserverMonotonicMs).toBeDefined();
    } finally {vi.useRealTimers();}
  });
});

function validReceipt() {
  const windows = [{url: 'file:///fixture/renderer/index.html', rendererPid: 111, isDefaultSession: true, isOverlaySession: false, sessionPersistent: true,
    sandbox: true, isolation: true, node: false, visible: true, focusable: true, alwaysOnTop: false},
    {url: 'file:///fixture/renderer/index.html?view=overlay', rendererPid: 222, isDefaultSession: false, isOverlaySession: true, sessionPersistent: false,
      sandbox: true, isolation: true, node: false, visible: false, focusable: false, alwaysOnTop: true}];
  const identity = {origin: 'synthetic', game: 'ets2', processId: 1234, pluginSessionId: '00000000-0000-4000-8000-000000000001',
    processInstanceId: '00000000-0000-4000-8000-000000000002', clockId: '00000000-0000-4000-8000-000000000003'};
  const source = {connections: 1, origin: 'synthetic', history: false, identity, activeClients: 1};
  // Authentic binary64 timestamps from retained development receipt 41623d / 4cf3af26.
  // PS5.1 parses their JSON decimal spellings as Decimal; subtracting those spellings
  // gives 5999.99999999999977/5999.9999999999997 instead of the producer's exact 6000.
  // That receipt predates the debugger-pause stall; its resume-request times are representative additions.
  const timing = {
    overlay: {rendererStartBarrierMonotonicMs: 58.70000000298023, rendererStartedMonotonicMs: 58.70000000298023,
      rendererCompletedMonotonicMs: 6058.70000000298, startedObserverMonotonicMs: 2372.7528, readingChangedObserverMonotonicMs: 2372.7617,
      observedObserverMonotonicMs: 2542.5261, resumeRequestedObserverMonotonicMs: 8378.6113, completedObserverMonotonicMs: 8384.7904},
    dashboard: {rendererStartBarrierMonotonicMs: 194.3999999910593, rendererStartedMonotonicMs: 194.3999999910593,
      rendererCompletedMonotonicMs: 6194.399999991059, startedObserverMonotonicMs: 8883.1131, readingChangedObserverMonotonicMs: 8883.1189,
      observedObserverMonotonicMs: 9008.7316, resumeRequestedObserverMonotonicMs: 14883.9025, completedObserverMonotonicMs: 14885.1964}
  };
  const stallProof = (kind: 'overlay' | 'dashboard') => ({kind, marker: `ETS2TELEMETRY_${kind.toUpperCase()}_STALL_00000000-0000-4000-8000-000000000004`,
    requestedMilliseconds: 6000, stallMethod: 'debugger-pause', pauseReason: 'other', started: true, completed: true, pendingAtObservation: true,
    ...timing[kind],
    sourceAtObservation: structuredClone(source), independentObservation: {windows: structuredClone(windows),
      reading: kind === 'overlay' ? {status: 'connected: Validated current observation', speed: 'Speed: 72.0 km/h', fuel: 'Fuel: 71.0 L'} :
        {...current, phase: 'during-dashboard-stall', speed: '72.0', fuel: '71.0'}}});
  return {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'overlay', launcherExit: 0, probesAfterExit: [],
    runtime: {rendererProcessLimit: '1', windows: structuredClone(windows)},
    mainEvents: [{event: 'APP_EXIT', detail: {code: 0}}, {event: 'SERVICE_EXIT', detail: {code: 0}}],
    serviceEvents: [{event: 'STORAGE_VERIFIED'}, {event: 'SERVICE_REPORT', detail: {type: 'stopped'}}],
    overlay: {scope: 'hidden synthetic renderer; OS visibility, focus and input unverified', origin: 'synthetic', recording: false,
      bridge: {require: 'undefined', process: 'undefined', desktop: 'undefined', keys: ['subscribeOverlay'], frozen: true},
      missingDistinctFromZero: true, silentOpenStale: true, resumeRecovered: true, overlayReloadIndependent: true, overlayCreditRecovered: true,
      dashboardReloadIndependent: true, dashboardCreditIndependent: true, disconnectUnavailable: true, sourceIdentityPreserved: true,
      overlayStallMilliseconds: 6000, dashboardStallMilliseconds: 6000, changedReading: {speedKmh: 72, fuelL: 71},
      overlayStallProof: stallProof('overlay'), dashboardStallProof: stallProof('dashboard'),
      sourceBefore: source, silentOpenSource: {...structuredClone(source), held: true}, sourceAfter: {...structuredClone(source), activeClients: 0, stopped: true},
      windows: phases.map(phase => ({phase, windows: structuredClone(windows)})),
      observations: phases.map(phase => {
        const row = {...current, phase};
        if (['changed','overlay-credit-recovery','dashboard-reload','during-dashboard-stall','dashboard-credit-recovery'].includes(phase)) {row.speed = '72.0'; row.fuel = '71.0';}
        if (['missing','silent-open-stale','disconnected'].includes(phase)) {row.speed = row.fuel = '—';}
        if (phase === 'zero') {row.speed = row.fuel = '0.0';}
        if (phase === 'silent-open-stale') {row.status = row.freshness = 'stale';}
        if (phase === 'disconnected') {row.status = 'disconnected'; row.freshness = 'unavailable';}
        return row;
      })}};
}

type OverlayReceiptCase = {name: string; mutate?: (receipt: ReturnType<typeof JSON.parse>) => void; code?: number; reason: string | null};

// All cases share one PowerShell 5.1 validator process; a process per case pushed this file past its timeouts on hosted runners.
async function expectOverlayReceiptCases(cases: OverlayReceiptCase[]) {
  const resources = await temporaryResources();
  const valid = validReceipt();
  try {
    const originals: string[] = [], batch: RuntimeReceiptCase[] = [];
    for (const [index, scenario] of cases.entries()) {
      const receipt = structuredClone(valid); scenario.mutate?.(receipt);
      const file = path.join(resources.directory, `overlay-receipt-${index}.json`);
      // Preserve the exact JSON spelling: Number would erase this fractional Decimal PID before PS5.1 sees it.
      const original = scenario.name === 'tiny fractional Decimal process identity'
        ? JSON.stringify(receipt).replace('"rendererPid":222', '"rendererPid":222.00000000000000001') : JSON.stringify(receipt);
      await writeFile(file, original);
      originals.push(original); batch.push({receipt: file, code: scenario.code ?? 0, scenario: 'overlay'});
    }
    const results = await validateRuntimeReceipts(resources.directory, batch);
    for (const [index, scenario] of cases.entries()) {
      expect(results[index], scenario.name).toMatchObject({passed: scenario.reason === null, driverResultAvailable: true, reason: scenario.reason});
      expect(await readFile(batch[index].receipt, 'utf8'), scenario.name).toBe(originals[index]);
    }
  } finally {await resources.dispose();}
}

const topmostCases: OverlayReceiptCase[] = [
  {name: 'overlay lost topmost in one phase', mutate: receipt => {receipt.overlay.windows[7].windows[1].alwaysOnTop = false;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay topmost state absent at startup', mutate: receipt => {delete receipt.runtime.windows[1].alwaysOnTop;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay not topmost during stall', mutate: receipt => {receipt.overlay.dashboardStallProof.independentObservation.windows[1].alwaysOnTop = false;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'dashboard made topmost', mutate: receipt => {receipt.overlay.windows[0].windows[0].alwaysOnTop = true;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'topmost reported as text', mutate: receipt => {receipt.overlay.windows[3].windows[1].alwaysOnTop = 'true';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'}
];

const completeCases: OverlayReceiptCase[] = [
  {name: 'complete hidden-renderer result with authentic fractional timestamps', reason: null},
  {name: 'overlay result absent', mutate: receipt => {delete receipt.overlay;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay bridge absent', mutate: receipt => {delete receipt.overlay.bridge;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'raw geometry exposed', mutate: receipt => {receipt.overlay.bridge.keys.push('setBounds');}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'one expected phase absent', mutate: receipt => {receipt.overlay.observations.pop();}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'mixed old/current values', mutate: receipt => {receipt.overlay.observations[1].fuel = '73.0';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'missing treated as zero', mutate: receipt => {receipt.overlay.observations[2].speed = '0.0';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'stale treated as disconnected', mutate: receipt => {receipt.overlay.observations[5].freshness = 'unavailable';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'native overlay shown', mutate: receipt => {receipt.overlay.windows[0].windows[1].visible = true;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'renderer security absent', mutate: receipt => {delete receipt.overlay.windows[0].windows[1].sandbox;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'reuse pressure switch absent', mutate: receipt => {delete receipt.runtime.rendererProcessLimit;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'actual renderer PID absent', mutate: receipt => {delete receipt.overlay.windows[0].windows[1].rendererPid;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'renderer reused after overlay reload', mutate: receipt => {receipt.overlay.windows[7].windows[1].rendererPid = 111;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'renderer reused during stall', mutate: receipt => {receipt.overlay.overlayStallProof.independentObservation.windows[1].rendererPid = 111;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay session persists to disk', mutate: receipt => {receipt.overlay.windows[0].windows[1].sessionPersistent = true;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay uses dashboard session', mutate: receipt => {receipt.overlay.windows[0].windows[1].isDefaultSession = true;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'fractional process identity', mutate: receipt => {receipt.runtime.windows[0].rendererPid = 111.5;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'tiny fractional Decimal process identity', reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'fixture reconnected', mutate: receipt => {receipt.overlay.sourceAfter.connections = 2;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'silent pipe was closed', mutate: receipt => {receipt.overlay.silentOpenSource.activeClients = 0;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'identity changed', mutate: receipt => {receipt.overlay.sourceAfter.identity.clockId = '00000000-0000-4000-8000-000000000099';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'one shutdown event absent', mutate: receipt => {receipt.mainEvents.pop();}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'probe remains', mutate: receipt => {receipt.probesAfterExit.push('ets2telemetry-probe-unexpected');}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'one recovery result absent', mutate: receipt => {delete receipt.overlay.overlayCreditRecovered;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'stall proof absent', mutate: receipt => {delete receipt.overlay.overlayStallProof;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'missing start barrier', mutate: receipt => {receipt.overlay.overlayStallProof.started = false;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'observation after completion', mutate: receipt => {receipt.overlay.overlayStallProof.pendingAtObservation = false;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'observation timestamp after completion', mutate: receipt => {receipt.overlay.overlayStallProof.observedObserverMonotonicMs = receipt.overlay.overlayStallProof.completedObserverMonotonicMs + 1;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'observation timestamp after resume request', mutate: receipt => {receipt.overlay.dashboardStallProof.observedObserverMonotonicMs = receipt.overlay.dashboardStallProof.resumeRequestedObserverMonotonicMs;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'renderer resumed before the requested pause', mutate: receipt => {receipt.overlay.overlayStallProof.resumeRequestedObserverMonotonicMs = receipt.overlay.overlayStallProof.startedObserverMonotonicMs + 5999;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'completion before resume request', mutate: receipt => {receipt.overlay.overlayStallProof.resumeRequestedObserverMonotonicMs = receipt.overlay.overlayStallProof.completedObserverMonotonicMs + 1;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'resume request time absent', mutate: receipt => {delete receipt.overlay.dashboardStallProof.resumeRequestedObserverMonotonicMs;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'CPU-spinning stall method', mutate: receipt => {receipt.overlay.overlayStallProof.stallMethod = 'busy-loop';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'pause outside the debugger statement', mutate: receipt => {receipt.overlay.dashboardStallProof.pauseReason = 'exception';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'reading changed before start barrier', mutate: receipt => {receipt.overlay.overlayStallProof.readingChangedObserverMonotonicMs = 199;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'actual stall too short', mutate: receipt => {receipt.overlay.overlayStallProof.rendererCompletedMonotonicMs = 1300;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'overlay stall one millisecond below strict minimum', mutate: receipt => {receipt.overlay.overlayStallProof.rendererCompletedMonotonicMs = receipt.overlay.overlayStallProof.rendererStartedMonotonicMs + 5999;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'dashboard stall one millisecond below strict minimum', mutate: receipt => {receipt.overlay.dashboardStallProof.rendererCompletedMonotonicMs = receipt.overlay.dashboardStallProof.rendererStartedMonotonicMs + 5999;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'representably shorter fractional overlay stall', mutate: receipt => {receipt.overlay.overlayStallProof.rendererCompletedMonotonicMs = receipt.overlay.overlayStallProof.rendererStartedMonotonicMs + 5999.999999;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'malformed time value', mutate: receipt => {receipt.overlay.overlayStallProof.rendererCompletedMonotonicMs = 'invalid';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'barrier timing differs from actual execution', mutate: receipt => {receipt.overlay.overlayStallProof.rendererStartBarrierMonotonicMs = 99;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'source reconnected during stall', mutate: receipt => {receipt.overlay.overlayStallProof.sourceAtObservation.connections = 2;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'dashboard reading during overlay stall incorrect', mutate: receipt => {receipt.overlay.overlayStallProof.independentObservation.reading.speed = 'Speed: 90.0 km/h';}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'symmetric stall proof absent', mutate: receipt => {delete receipt.overlay.dashboardStallProof;}, reason: 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'},
  {name: 'wrong source scenario', mutate: receipt => {receipt.scenarioKind = 'telemetry';}, reason: 'DRIVER_RESULT_SCENARIO_MISMATCH'},
  {name: 'Job failure overrides intact result', code: 125, reason: 'JOB_FAILED'}
];

// The batch timeout bounds the PowerShell child; the margin covers writing and rereading every receipt file.
const receiptTestTimeout = (cases: OverlayReceiptCase[]) => receiptBatchTimeout(cases.length) + 5000;

it('rejects an overlay receipt that loses or misreports the topmost state', async () => {
  await expectOverlayReceiptCases(topmostCases);
}, receiptTestTimeout(topmostCases));

it('requires the complete current overlay receipt and rejects missing results, mixed phases, visibility and cleanup failures', async () => {
  await expectOverlayReceiptCases(completeCases);
}, receiptTestTimeout(completeCases));
