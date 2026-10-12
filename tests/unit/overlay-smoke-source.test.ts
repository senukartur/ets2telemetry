import {describe, expect, it, vi} from 'vitest';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';

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
  async function observe(sample: typeof current, alteration?: string) {
    const {overlayObservation} = await import(observationModule);
    const document = {querySelectorAll: (selector: string) => {
      const field = selector.includes('status') ? 'status' : selector.includes('speed') ? 'speed' : 'fuel';
      const value = field === 'status' ? `${sample.source} · ${sample.origin} · ${sample.status} · ${sample.freshness}` : sample[field];
      const node = {innerText: value, parentElement: {lastElementChild: {innerText: field === 'speed' ? sample.speedUnit : sample.fuelUnit}},
        getBoundingClientRect: () => ({width: alteration === 'zero-box' ? 0 : 100, height: 20, top: 10, bottom: 30, left: 10, right: 110})};
      return alteration === 'missing' ? [] : alteration === 'duplicate' ? [node, node] : [node];
    }};
    return runInNewContext(`(${overlayObservation.toString()})(expected)`, {expected: {...current, statuses: ['connected']},
      document, innerWidth: 300, innerHeight: 132, getComputedStyle: () => ({visibility: alteration === 'hidden' ? 'hidden' : 'visible'})});
  }
  it('accepts one complete current observation with explicit origin and units', async () => {
    const {overlayObservation} = await import(observationModule);
    expect(typeof overlayObservation).toBe('function');
    // The exact-state form also protects the callback from requiring module closures.
    const fakeDocument = {querySelectorAll: (selector: string) => {
      const field = selector.includes('status') ? 'status' : selector.includes('speed') ? 'speed' : 'fuel';
      return [{innerText: field === 'status' ? 'ETS2 · synthetic · connected · current' : current[field],
        parentElement: {lastElementChild: {innerText: field === 'speed' ? 'km/h' : 'L'}},
        getBoundingClientRect: () => ({width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110})}];
    }};
    expect(runInNewContext(`(${overlayObservation.toString()})(expected)`, {expected: current, document: fakeDocument, innerWidth: 300, innerHeight: 132,
      getComputedStyle: () => ({visibility: 'visible'})})).toEqual(current);
  });
  it.each(['missing','duplicate','hidden','zero-box'])('rejects %s DOM fields', async alteration => {expect(await observe(current, alteration)).toBe(false);});
  it.each([
    {...current, status: 'stale', freshness: 'stale'}, {...current, origin: 'game'}, {...current, speed: '72.0'},
    {...current, fuel: '71.0'}, {...current, speedUnit: 'mph'}, {...current, fuelUnit: 'US gal'}
  ])('cannot accept mismatched state, readings, origin or units', async sample => {expect(await observe(sample)).toBe(false);});
});

describe('definite stall-start and independent-observation ordering', () => {
  async function exercise(mode: 'during' | 'after' | 'before-barrier' | 'no-barrier' | 'late-metadata' | 'missing-reading-time') {
    const {proveIndependentDuringStall} = await import(observationModule);
    const order: string[] = [], proof: ReturnType<typeof JSON.parse> = {};
    let start!: (event: {text(): string}) => void;
    let finish!: (timing: {rendererStartedMonotonicMs: number; rendererCompletedMonotonicMs: number}) => void;
    const page = {
      waitForEvent: (_event: string, options: {predicate: (event: {text(): string}) => boolean; timeout: number}) => {
        order.push('start-listener'); expect(options.timeout).toBe(10000);
        return new Promise<{text(): string}>((resolve, reject) => {
          start = event => {expect(options.predicate(event)).toBe(true); order.push('start-barrier'); resolve(event);};
          if (mode === 'no-barrier') reject(new Error('controlled missing start barrier'));
        });
      },
      evaluate: (_callback: unknown, argument: {marker: string}) => {
        order.push('evaluate-request');
        return new Promise<{rendererStartedMonotonicMs: number; rendererCompletedMonotonicMs: number}>(resolve => {
          finish = timing => {order.push('renderer-completed'); resolve(timing);};
          if (mode === 'before-barrier' || mode === 'no-barrier') finish({rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 6100});
          queueMicrotask(() => {if (mode !== 'no-barrier') start({text: () => `${argument.marker} 100`});});
        });
      }
    };
    const source = {setReading: (speed: number, fuel: number) => {order.push('reading-changed'); expect([speed, fuel]).toEqual([20, 71]);},
      statistics: () => ({connections: 1, activeClients: 1})};
    const observation = async () => {
      if (mode === 'after') {finish({rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 6100}); await Promise.resolve();}
      order.push('independent-observed');
      const observedObserverMonotonicMs = performance.now();
      if (mode === 'during' || mode === 'missing-reading-time') setTimeout(() => finish({rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 6100}), 5);
      if (mode === 'late-metadata') {finish({rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 6100}); await Promise.resolve();}
      return {reading: {status: 'connected: current', speed: 'Speed: 72.0 km/h', fuel: 'Fuel: 71.0 L',
        ...(mode === 'missing-reading-time' ? {} : {observedObserverMonotonicMs})}};
    };
    const promise = proveIndependentDuringStall(page, 'overlay', observation, source, proof);
    return {promise, proof, order};
  }
  it('changes source only after the unique start event, observes before completion and retains timing evidence', async () => {
    const {promise, proof, order} = await exercise('during'); await promise;
    expect(order).toEqual(['start-listener','evaluate-request','start-barrier','reading-changed','independent-observed','renderer-completed']);
    expect(proof).toMatchObject({started: true, completed: true, pendingAtObservation: true, requestedMilliseconds: 6000,
      rendererStartBarrierMonotonicMs: 100, rendererStartedMonotonicMs: 100, rendererCompletedMonotonicMs: 6100});
    expect(proof.observedObserverMonotonicMs).toBeLessThan(proof.completedObserverMonotonicMs);
    expect(proof.readingObservedObserverMonotonicMs).toBeGreaterThan(proof.readingChangedObserverMonotonicMs);
    expect(proof.readingObservedObserverMonotonicMs).toBeLessThanOrEqual(proof.observedObserverMonotonicMs);
  });
  it('rejects an observation made after the stalled renderer completed', async () => {
    const {promise, proof} = await exercise('after');
    await expect(promise).rejects.toThrow('Independent reading arrived after'); expect(proof.pendingAtObservation).toBe(false);
  });
  it('rejects a start barrier delivered after renderer completion without changing source', async () => {
    const {promise, order} = await exercise('before-barrier');
    await expect(promise).rejects.toThrow('Renderer completed before'); expect(order).not.toContain('reading-changed');
  });
  it('retains an early DOM timestamp but rejects a composite whose metadata arrived after completion', async () => {
    const {promise, proof} = await exercise('late-metadata');
    await expect(promise).rejects.toThrow('Independent reading arrived after');
    expect(proof.readingObservedObserverMonotonicMs).toBeLessThan(proof.completedObserverMonotonicMs);
    expect(proof.pendingAtObservation).toBe(false);
  });
  it('rejects a missing DOM receipt time without inventing when the reading was observed', async () => {
    const {promise, proof} = await exercise('missing-reading-time');
    await expect(promise).rejects.toThrow('Changed DOM reading must precede');
    expect(proof.readingObservedObserverMonotonicMs).toBeUndefined();
  });
  it('rejects a missing start barrier without inventing a started observation', async () => {
    const {promise, proof, order} = await exercise('no-barrier');
    await expect(promise).rejects.toThrow('controlled missing start barrier'); expect(proof.started).toBe(false); expect(order).not.toContain('reading-changed');
  });
});

function validReceipt() {
  const windows = [{url: 'file:///fixture/renderer/index.html', rendererPid: 111, isDefaultSession: true, isOverlaySession: false, sessionPersistent: true,
    sandbox: true, isolation: true, node: false, visible: true, focusable: true},
    {url: 'file:///fixture/renderer/index.html?view=overlay', rendererPid: 222, isDefaultSession: false, isOverlaySession: true, sessionPersistent: false,
      sandbox: true, isolation: true, node: false, visible: false, focusable: false}];
  const identity = {origin: 'synthetic', game: 'ets2', processId: 1234, pluginSessionId: '00000000-0000-4000-8000-000000000001',
    processInstanceId: '00000000-0000-4000-8000-000000000002', clockId: '00000000-0000-4000-8000-000000000003'};
  const source = {connections: 1, origin: 'synthetic', history: false, identity, activeClients: 1};
  // Authentic binary64 timestamps from retained development receipt 41623d / 4cf3af26.
  // PS5.1 parses their JSON decimal spellings as Decimal; subtracting those spellings
  // gives 5999.99999999999977/5999.9999999999997 instead of the producer's exact 6000.
  const timing = {
    overlay: {rendererStartBarrierMonotonicMs: 58.70000000298023, rendererStartedMonotonicMs: 58.70000000298023,
      rendererCompletedMonotonicMs: 6058.70000000298, startedObserverMonotonicMs: 2372.7528, readingChangedObserverMonotonicMs: 2372.7617,
      observedObserverMonotonicMs: 2542.5261, completedObserverMonotonicMs: 8384.7904},
    dashboard: {rendererStartBarrierMonotonicMs: 194.3999999910593, rendererStartedMonotonicMs: 194.3999999910593,
      rendererCompletedMonotonicMs: 6194.399999991059, startedObserverMonotonicMs: 8883.1131, readingChangedObserverMonotonicMs: 8883.1189,
      observedObserverMonotonicMs: 9008.7316, completedObserverMonotonicMs: 14885.1964}
  };
  const stallProof = (kind: 'overlay' | 'dashboard') => ({kind, marker: `ETS2TELEMETRY_${kind.toUpperCase()}_STALL_00000000-0000-4000-8000-000000000004`,
    requestedMilliseconds: 6000, started: true, completed: true, pendingAtObservation: true,
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

it('requires the complete current overlay receipt and rejects missing results, mixed phases, visibility and cleanup failures', async () => {
  const resources = await temporaryResources();
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const valid = validReceipt();
  const cases: {name: string; mutate?: (receipt: ReturnType<typeof JSON.parse>) => void; code?: number; reason: string | null}[] = [
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
  try {
    for (const [index, scenario] of cases.entries()) {
      const receipt = structuredClone(valid); scenario.mutate?.(receipt);
      const file = path.join(resources.directory, `overlay-receipt-${index}.json`), config = path.join(resources.directory, `overlay-config-${index}.json`);
      // Preserve the exact JSON spelling: Number would erase this fractional Decimal PID before PS5.1 sees it.
      const original = scenario.name === 'tiny fractional Decimal process identity'
        ? JSON.stringify(receipt).replace('"rendererPid":222', '"rendererPid":222.00000000000000001') : JSON.stringify(receipt);
      await writeFile(file, original);
      await writeFile(config, JSON.stringify({receipt: file, code: scenario.code ?? 0, scenario: 'overlay'}));
      const output = execFileSync(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        path.resolve('tests/shared/Read-RuntimeReceipt.ps1'), '-Configuration', config],
      {encoding: 'utf8', timeout: 5000, windowsHide: true, env: {...process.env, PSModulePath: ''}});
      expect(JSON.parse(output), scenario.name).toMatchObject({passed: scenario.reason === null, driverResultAvailable: true, reason: scenario.reason});
      expect(await readFile(file, 'utf8')).toBe(original);
    }
  } finally {await resources.dispose();}
}, 30000);
