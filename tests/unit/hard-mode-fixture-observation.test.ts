import {performance} from 'node:perf_hooks';
import {runInNewContext} from 'node:vm';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import type {HardModeStatus, HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {hardModeFixtureSnapshot, waitForHardModeFixture, type FixtureExpectation, type FixtureSnapshot, type FixtureRecord} from '../../scripts/ci/hard-mode-fixture-observation.mjs';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());});
afterEach(() => {vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();});
const failing = (at = Date.now()) => evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), at, 'fixture');
const ids = ['fuel','air','police','fatigue','limiter','truck','trailer','parking','rain','events','braking','traffic'];
const values = [[1],[1],[1],[0],[1],[0.5],[0.5],[0,2],[0.12],[0.3],[0.75],[1]];
const expected: FixtureExpectation = {language: 'ru', hint: 'air', details: true, rules: ids.map((id, i) => ({
  id: id as FixtureExpectation['rules'][number]['id'], state: id === 'fatigue' ? 'fail' : 'pass', values: values[i], reason: id === 'fatigue' ? 'outside-limit' : 'compliant',
  label: id + ': ' + (id === 'fatigue' ? 'не выполнено' : 'выполнено'), name: id,
  tooltip: [id, 'Обнаружено: ' + values[i].join('/'), 'Требуется: fixture', 'Причина: fixture'],
  details: ['Обнаружено: ' + values[i].join('/'), 'Требуется: fixture']}))};
function snapshot(status: HardModeStatus = {assessment: failing(), trip: null}): FixtureSnapshot {
  return {status, language: 'ru', source: {count: 1, visible: true, text: 'Synthetic / replay settings · 0s since observation'},
    rows: expected.rules.map(({id, state, label, name}) => ({id, state, label, name, buttonCount: 1})),
    hint: {count: 1, visible: true, lines: [...expected.rules[1].tooltip]},
    details: {count: 1, visible: true, rows: expected.rules.filter(rule => rule.state === 'fail').map(rule => ({id: rule.id, lines: [...rule.details]}))}};
}
it('waits for genuine same-source reacquisition and rendered source after the language is already ready', async () => {
  const source: SourceIdentity = {game: 'ets2', origin: 'synthetic', processId: 123, windowsSessionId: 1,
    processInstanceId: '10000000-0000-4000-8000-000000000001', pluginSessionId: '20000000-0000-4000-8000-000000000001'};
  let release!: () => void, held = false;
  const read = vi.fn(async () => {
    if (held) await new Promise<void>(resolve => {release = resolve;});
    return {assessment: failing(), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: null};
  });
  const monitor = new HardModeMonitor(read, () => undefined, () => BigInt(Date.now()) * 1_000_000n);
  const sourceText = /Synthetic \/ replay settings.*s since observation/;
  let renderedSource = 'Synthetic / replay settings · 0s since observation';
  const observe = () => Promise.resolve({...snapshot(monitor.status()), language: 'en',
    source: {count: 1, visible: true, text: renderedSource}});
  try {
    monitor.select({source, monotonicNs: '100', clockId: 'clock'}); await vi.advanceTimersByTimeAsync(100);
    monitor.select(null); held = true; monitor.select({source, monotonicNs: '200', clockId: 'clock'});
    renderedSource = 'Source unproven · 0s since observation';
    expect((await observe()).language).toBe('en'); expect(monitor.status().assessment.state).toBe('unknown');
    // The former synchronous assertion fails even though language/navigation has completed.
    expect(() => expect(renderedSource).toMatch(sourceText)).toThrow();
    const record: FixtureRecord = {};
    let settled = false;
    const pending = waitForHardModeFixture({refresh: () => {void monitor.refresh(); return Promise.resolve();}, observe,
      expected: {...expected, language: 'en', sourceText}, record, message: 'FINAL_ENGLISH'}).then(value => {settled = true; return value;});
    await vi.advanceTimersByTimeAsync(900); expect(read).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    release(); await vi.advanceTimersByTimeAsync(100);
    expect(monitor.status().assessment.state).toBe('fail'); expect(settled).toBe(false);
    expect(record.lastSnapshot).toMatchObject({source: {text: 'Source unproven · 0s since observation'}});
    renderedSource = 'Synthetic / replay settings · 0s since observation';
    await vi.advanceTimersByTimeAsync(100); const accepted = await pending;
    expect(accepted).toMatchObject({source: {text: renderedSource}, status: {assessment: {state: 'fail', source: 'fixture'}}});
    expect(record.phase).toBe('complete'); expect(record.elapsedMilliseconds).toBe(1100);
  } finally {monitor.close();}
});
it('reacquires genuine fail evidence after real monitor selection loss and waits for backend plus rendered agreement', async () => {
  const source: SourceIdentity = {game: 'ets2', origin: 'synthetic', processId: 123, windowsSessionId: 1,
    processInstanceId: '10000000-0000-4000-8000-000000000001', pluginSessionId: '20000000-0000-4000-8000-000000000001'};
  const publications: HardModeObservation[] = [];
  let rendered = snapshot();
  const monitor = new HardModeMonitor(() => Promise.resolve({assessment: failing(), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: null}),
    value => {publications.push(value); setTimeout(() => {rendered = snapshot({assessment: value.assessment, trip: null});
      rendered.rows = rendered.rows.map(row => ({...row, state: value.assessment.rules.find(rule => rule.id === row.id)!.state}));}, 50);}, () => BigInt(Date.now()) * 1_000_000n);
  try {
    monitor.select({source, monotonicNs: '100', clockId: 'clock'}); await vi.advanceTimersByTimeAsync(100);
    expect(monitor.status().assessment.state).toBe('fail');
    monitor.select(null); expect(monitor.status().assessment.state).toBe('unknown');
    expect(rendered.status.assessment.state).toBe('fail');
    setTimeout(() => monitor.select({source, monotonicNs: '200', clockId: 'clock'}), 200);
    const refresh = vi.fn(() => {void monitor.refresh(); return Promise.resolve();});
    const observe = vi.fn(() => Promise.resolve({...structuredClone(rendered), status: monitor.status()}));
    const record: FixtureRecord = {};
    const outcome = waitForHardModeFixture({refresh, observe, expected, record, message: 'FAIL_FIXTURE'}).then(value => ({value, error: undefined}), (error: unknown) => ({value: undefined, error}));
    await vi.advanceTimersByTimeAsync(1300); const result = await outcome;
    expect(result.error).toBeUndefined(); expect(result.value?.status.assessment.state).toBe('fail');
    expect(result.value?.status.assessment.observedUtcMs).toBeGreaterThan(100);
    expect(publications.map(value => value.assessment.state)).toEqual(['unknown','fail','unknown','unknown','fail']);
    expect(record.phase).toBe('complete'); expect(refresh.mock.calls.length).toBeGreaterThan(1);
  } finally {monitor.close();}
});
it.each(['persistent unknown','wrong air value','wrong RU label','missing criterion','duplicate criterion','missing tooltip value','wrong tooltip reason','hidden tooltip','wrong details value'])(
  'rejects %s under the single condition deadline', async fault => {
    const bad = snapshot();
    if (fault === 'persistent unknown') {bad.status.assessment.state = 'unknown'; bad.status.assessment.rules[1].state = 'unknown';}
    if (fault === 'wrong air value') bad.status.assessment.rules[1].values = [0];
    if (fault === 'wrong RU label') bad.rows[1].label = 'Air brake simulation: pass';
    if (fault === 'missing criterion') bad.rows.splice(1, 1);
    if (fault === 'duplicate criterion') bad.rows[1] = {...bad.rows[0]};
    if (fault === 'missing tooltip value') bad.hint!.lines.splice(1, 1);
    if (fault === 'wrong tooltip reason') bad.hint!.lines[3] = 'Причина: неверно';
    if (fault === 'hidden tooltip') bad.hint!.visible = false;
    if (fault === 'wrong details value') bad.details!.rows[0].lines[0] = 'Обнаружено: Выкл. (1)';
    const record: FixtureRecord = {}, refresh = vi.fn(() => Promise.resolve());
    const pending = waitForHardModeFixture({refresh, observe: () => Promise.resolve(bad), expected, record, message: 'FAIL_FIXTURE'});
    const rejected = expect(pending).rejects.toThrow('FAIL_FIXTURE within 5000 ms');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(record.elapsedMilliseconds).toBe(5000); expect(vi.getTimerCount()).toBe(0);
  });
it.each(['unknown source','missing source','duplicate source','hidden source','wrong source text','wrong backend source','unknown backend','wrong criterion','wrong label'])(
  'retains the final source snapshot and rejects %s at exactly 5000 ms', async fault => {
    const bad = snapshot();
    if (fault === 'unknown source') bad.source.text = 'Source unproven · 0s since observation';
    if (fault === 'missing source') bad.source.count = 0;
    if (fault === 'duplicate source') bad.source.count = 2;
    if (fault === 'hidden source') bad.source.visible = false;
    if (fault === 'wrong source text') bad.source.text = 'Verified game settings · 0s since observation';
    if (fault === 'wrong backend source') bad.status.assessment.source = 'local';
    if (fault === 'unknown backend') bad.status.assessment.state = 'unknown';
    if (fault === 'wrong criterion') bad.status.assessment.rules[1].values = [0];
    if (fault === 'wrong label') bad.rows[1].label = 'wrong';
    const record: FixtureRecord = {};
    const pending = waitForHardModeFixture({refresh: () => Promise.resolve(), observe: () => Promise.resolve(bad),
      expected: {...expected, sourceText: /Synthetic \/ replay settings.*s since observation/}, record, message: 'FINAL_ENGLISH'});
    const rejected = expect(pending).rejects.toThrow('FINAL_ENGLISH within 5000 ms');
    await vi.advanceTimersByTimeAsync(4999); expect(record.phase).not.toBe('complete');
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(record.lastSnapshot).toEqual(bad); expect(record.elapsedMilliseconds).toBe(5000); expect(vi.getTimerCount()).toBe(0);
  });
it.each([0, 1, 3])('bounds source facts from the actual snapshot collector with %i source nodes', async count => {
  const source = {getClientRects: () => [], innerText: 'x'.repeat(1000)};
  const observed = await runInNewContext('(' + hardModeFixtureSnapshot.toString() + ')()', {
    desktop: {getHardModeStatus: () => Promise.resolve({assessment: failing(), trip: null})},
    document: {documentElement: {lang: 'en'}, querySelectorAll: (selector: string) => selector === '[data-testid="hard-mode-source"]' ? Array.from({length: count}, () => source) : []},
    getComputedStyle: () => ({visibility: 'visible'})}) as FixtureSnapshot;
  expect(observed.source).toEqual({count: Math.min(count, 2), visible: false, text: count ? 'x'.repeat(256) : ''});
});
it.each(['refresh','observe'] as const)('bounds a held %s and stops after late settlement', async phase => {
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const refresh = vi.fn(() => phase === 'refresh' ? held : Promise.resolve());
  const observe = vi.fn(async () => {if (phase === 'observe') await held; return snapshot();});
  const record: FixtureRecord = {};
  const pending = waitForHardModeFixture({refresh, observe, expected, record, message: 'FAIL_FIXTURE'});
  const rejected = expect(pending).rejects.toThrow('FAIL_FIXTURE within 5000 ms');
  await vi.advanceTimersByTimeAsync(5000); await rejected; const calls = [refresh.mock.calls.length, observe.mock.calls.length];
  expect(calls).toEqual(phase === 'refresh' ? [1, 0] : [1, 1]);
  release(); await vi.advanceTimersByTimeAsync(1000);
  expect([refresh.mock.calls.length, observe.mock.calls.length]).toEqual(calls); expect(vi.getTimerCount()).toBe(0);
});
it('awaits backend status before one self-contained DOM snapshot, including exact active tooltip and details paragraphs', async () => {
  let release!: (value: HardModeStatus) => void;
  const held = new Promise<HardModeStatus>(resolve => {release = resolve;});
  let domReads = 0;
  const paragraphs = (lines: string[]) => lines.map(innerText => ({innerText}));
  const buttons = expected.rules.map(rule => ({getAttribute: () => rule.label, querySelector: () => ({textContent: rule.name})}));
  const rules = expected.rules.map(rule => ({getAttribute: (key: string) => key === 'data-testid' ? 'hard-mode-rule-' + rule.id : rule.state}));
  const tooltip = {getClientRects: () => [{}], querySelectorAll: () => paragraphs(expected.rules[1].tooltip)};
  const details = {getClientRects: () => [{}]};
  const detailsRows = expected.rules.filter(rule => rule.state === 'fail').map(rule => ({getAttribute: () => 'hard-mode-detail-rule-' + rule.id, querySelectorAll: () => paragraphs(rule.details)}));
  const document = {documentElement: {lang: 'ru'}, querySelectorAll: (selector: string) => {
    domReads++;
    if (selector === '[data-testid^="hard-mode-rule-"]') return rules;
    if (selector === '[data-testid="hard-mode-hint-air"]') return [tooltip];
    if (selector === '[data-testid="hard-mode-details"]') return [details];
    if (selector === '[data-testid="hard-mode-source"]') return [{getClientRects: () => [{}], innerText: snapshot().source.text}];
    if (selector === '[data-testid^="hard-mode-detail-rule-"]') return detailsRows;
    const id = /^\[data-testid="hard-mode-name-([^"]+)"\]$/.exec(selector)?.[1];
    return id ? [buttons[ids.indexOf(id)]] : [];
  }};
  const pending = runInNewContext('(' + hardModeFixtureSnapshot.toString() + ')({hint:"air",details:true})',
    {desktop: {getHardModeStatus: () => held}, document, getComputedStyle: () => ({visibility: 'visible'})}) as Promise<FixtureSnapshot>;
  await Promise.resolve(); expect(domReads).toBe(0);
  release({assessment: failing(), trip: null}); const observed = await pending;
  expect(observed).toEqual(snapshot());
  const record: FixtureRecord = {};
  await expect(waitForHardModeFixture({refresh: () => Promise.resolve(), observe: () => Promise.resolve(observed), expected, record, message: 'SNAPSHOT'})).resolves.toEqual(observed);
  expect(record.phase).toBe('complete'); expect(vi.getTimerCount()).toBe(0);
});
