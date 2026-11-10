import {performance} from 'node:perf_hooks';
/** Browser-local passive capture. Fixed identifiers only; never inspect text or mutate tooltip/input state. */
export function hardModeTooltipDiagnostics({action, token, phase, criterion, language}) {
  const ids = ['fuel','air','police','fatigue','limiter','truck','trailer','parking','rain','events','braking','traffic','caveats'];
  if (!Number.isInteger(token) || token < 1 || token > 64 || !ids.includes(criterion) ||
      !['hover','keyboard'].includes(phase) || !['en','ru'].includes(language)) return null;
  const key = '__ets2HardModeTooltipDiagnosticsV1';
  const slot = globalThis[key] ??= {retired: 0, active: null};
  if (action === 'stop') {
    slot.retired = Math.max(slot.retired, token);
    if (slot.active?.token !== token) return null;
    const active = slot.active; slot.active = null;
    return active.stop();
  }
  if (action !== 'start' || token <= slot.retired) return null;
  if (slot.active?.token >= token) return null;
  if (slot.active) {slot.retired = Math.max(slot.retired, slot.active.token); slot.active.stop(); slot.active = null;}
  const doc = globalThis.document, started = globalThis.performance.now();
  const triggerSelector = criterion === 'caveats' ? '[data-testid="hard-mode-card"] h2 .yu-info-hint' : `[data-testid="hard-mode-name-${criterion}"]`;
  const hintId = criterion === 'caveats' ? 'hard-mode-caveats-tooltip' : `hard-mode-hint-${criterion}`;
  const trigger = () => doc.querySelector(triggerSelector), hints = () => [...doc.querySelectorAll(`[data-testid="${hintId}"]`)];
  const bounded = (value, min = -100000, max = 100000) => Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value)) * 10) / 10 : null;
  const id = node => {
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      if (node === doc.querySelector('[data-testid="hard-mode-card"] h2 .yu-info-hint')) return 'caveats-trigger';
      const value = node.getAttribute?.('data-testid');
      if (value === 'hard-mode-caveats-tooltip' || value === 'shell.content' || ids.some(item => value === `hard-mode-name-${item}` || value === `hard-mode-hint-${item}`)) return value;
    }
    return 'other';
  };
  const visible = node => Boolean(node?.getClientRects().length && globalThis.getComputedStyle(node).visibility === 'visible');
  const rect = node => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {x: bounded(box.x), y: bounded(box.y), width: bounded(box.width, 0), height: bounded(box.height, 0)};
  };
  const pointFacts = point => {
    const x = bounded(point?.x), y = bounded(point?.y);
    return x === null || y === null ? null : {x, y, element: id(doc.elementFromPoint(x, y))};
  };
  let pointer = null, dropped = 0, collectionErrors = 0, stopped = false;
  const events = [], listeners = [], landmarks = {};
  const landmarkKinds = ['hint-inserted','hint-removed','pointerleave','pointerout','pointerdown','blur','window-blur','ancestor-scroll','tooltip.open','escape'];
  const state = () => {
    const button = trigger(), nodes = hints(), box = rect(button);
    const dataState = button?.getAttribute('data-state');
    return {triggerState: ['closed','delayed-open','instant-open'].includes(dataState) ? dataState : 'unknown',
      hintCount: Math.min(2, nodes.length), hintVisible: visible(nodes[0]), active: id(doc.activeElement),
      documentFocused: doc.hasFocus(), visibility: ['visible','hidden'].includes(doc.visibilityState) ? doc.visibilityState : 'unknown',
      triggerHovered: Boolean(button?.matches(':hover')), hintHovered: Boolean(nodes[0]?.matches(':hover')), rect: box,
      center: box && Object.values(box).every(value => value !== null) ? pointFacts({x: box.x + box.width / 2, y: box.y + box.height / 2}) : null, pointer: pointFacts(pointer),
      scroll: {top: bounded(doc.querySelector('[data-testid="shell.content"]')?.scrollTop), left: bounded(doc.querySelector('[data-testid="shell.content"]')?.scrollLeft)}};
  };
  const add = (kind, facts = {}) => {
    if (stopped) return;
    if (events.length === 64) {events.shift(); dropped = Math.min(1000000, dropped + 1);}
    const event = {atMs: bounded(globalThis.performance.now() - started, 0, 60000), kind, ...facts, state: state()};
    events.push(event);
    if (landmarkKinds.includes(kind)) landmarks[kind] = [landmarks[kind]?.[0] ?? event, event];
  };
  const relevant = node => Boolean(node && (trigger()?.contains(node) || hints().some(hint => hint.contains(node))));
  const guarded = handler => (...args) => {try {handler(...args);} catch {collectionErrors = Math.min(1000000, collectionErrors + 1);}};
  const listen = (target, type, handler) => {const listener = guarded(handler); target.addEventListener(type, listener, {capture: true, passive: true}); listeners.push(() => target.removeEventListener(type, listener, true));};
  for (const type of ['pointermove','pointerleave','pointerout','pointerdown','pointerup','focus','blur']) listen(doc, type, event => {
    if (!relevant(event.target) && !['pointerdown','pointerup','focus','blur'].includes(type)) return;
    const x = bounded(event.clientX), y = bounded(event.clientY);
    if (x !== null && y !== null) pointer = {x, y};
    add(type, {target: id(event.target), related: id(event.relatedTarget), trusted: event.isTrusted === true,
      pointerType: ['mouse','pen','touch'].includes(event.pointerType) ? event.pointerType : 'unknown', buttons: bounded(event.buttons, 0, 31)});
  });
  listen(doc, 'keydown', event => {if (event.key === 'Escape') add('escape', {target: id(event.target), trusted: event.isTrusted === true});});
  listen(doc, 'tooltip.open', event => add('tooltip.open', {target: id(event.target), trusted: event.isTrusted === true}));
  listen(doc, 'visibilitychange', () => add('visibility'));
  for (const type of ['focus','blur']) listen(globalThis, type, event => {if (event.target === globalThis) add('window-' + type);});
  listen(globalThis, 'scroll', event => {
    if (event.target === doc || event.target === globalThis || event.target?.contains?.(trigger()))
      add('ancestor-scroll', {target: id(event.target), top: bounded(event.target?.scrollTop), left: bounded(event.target?.scrollLeft), trusted: event.isTrusted === true});
  });
  const includesHint = node => node?.getAttribute?.('data-testid') === hintId || Boolean(node?.querySelector?.(`[data-testid="${hintId}"]`));
  const mutations = guarded(records => {
    let changed = false;
    for (const record of records) {
      for (const node of record.addedNodes ?? []) if (includesHint(node)) {add('hint-inserted'); changed = true;}
      for (const node of record.removedNodes ?? []) if (includesHint(node)) {add('hint-removed'); changed = true;}
      if (record.type === 'attributes' && (relevant(record.target) || record.target?.contains?.(trigger()) || hints().some(hint => record.target?.contains?.(hint)))) changed = true;
    }
    if (changed) add('dom-state');
  });
  let observer;
  const snapshot = () => {
    const states = [], indices = new Map();
    const reference = value => {
      const serialized = JSON.stringify(value);
      if (!indices.has(serialized)) {indices.set(serialized, states.length); states.push(value);}
      return indices.get(serialized);
    };
    const event = value => ({...value, state: reference(value.state)});
    return {phase, criterion, language, events: events.map(event),
      landmarks: Object.fromEntries(Object.entries(landmarks).map(([kind, pair]) => [kind, pair.map(event)])),
      states, dropped, collectionErrors, last: reference(state())};
  };
  const stop = () => {
    try {add('finish'); return snapshot();}
    finally {
      stopped = true;
      try {observer?.disconnect();} finally {for (const remove of listeners) {try {remove();} catch {collectionErrors = Math.min(1000000, collectionErrors + 1);}}}
    }
  };
  slot.active = {token, stop};
  try {
    observer = new globalThis.MutationObserver(mutations);
    observer.observe(doc.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-state','class','style','hidden']});
    add('start'); return snapshot();
  } catch (error) {
    slot.active = null; slot.retired = Math.max(slot.retired, token);
    try {stop();} catch { /* Diagnostic setup/cleanup must not leak listeners or replace its original error. */ }
    throw error;
  }
}

async function tooltipEvidence(collect) {
  let timer;
  try {return await Promise.race([Promise.resolve().then(collect).then(value => value == null ? {available: false, reason: 'unavailable'} : {available: true, value},
    () => ({available: false, reason: 'collection-failed'})), new Promise(resolve => {timer = setTimeout(() => resolve({available: false, reason: 'collection-deadline'}), 250);})]);}
  finally {clearTimeout(timer);}
}
const tooltipBytes = phases => Buffer.byteLength(JSON.stringify({hardMode: {tooltipPhases: phases}}, null, 2), 'utf8');
const traceEvents = trace => (trace?.events?.length ?? 0) + Object.values(trace?.landmarks ?? {}).reduce((sum, pair) => sum + pair.length, 0);
const traceStates = trace => trace?.states?.length ?? (trace?.state ? 1 : 0);
function countTooltipDrops(observation, events, states) {
  observation.receiptDroppedEvents = Math.min(1000000, (observation.receiptDroppedEvents ?? 0) + events);
  observation.receiptDroppedStates = Math.min(1000000, (observation.receiptDroppedStates ?? 0) + states);
}
function pruneTooltipTrace(observation, trace, keep) {
  if (!Array.isArray(trace?.states)) return;
  const previousEvents = traceEvents(trace), previousStates = trace.states;
  trace.events = keep ? trace.events.slice(-keep) : [];
  const states = [], indices = new Map();
  const reference = index => {
    if (!indices.has(index)) {indices.set(index, states.length); states.push(previousStates[index]);}
    return indices.get(index);
  };
  for (const event of [...trace.events, ...Object.values(trace.landmarks ?? {}).flat()]) event.state = reference(event.state);
  trace.last = reference(trace.last); trace.states = states;
  countTooltipDrops(observation, previousEvents - traceEvents(trace), previousStates.length - states.length);
}
function summarizeTooltipPhase(observation) {
  const before = observation.before?.value, after = observation.after?.value;
  const open = after?.landmarks?.['hint-inserted'] ?? after?.events?.filter(event => event.kind === 'hint-inserted') ?? [];
  const close = after?.landmarks?.['hint-removed'] ?? after?.events?.filter(event => event.kind === 'hint-removed') ?? [];
  observation.summary = {firstOpenMs: open[0]?.atMs ?? null, lastCloseMs: close.at(-1)?.atMs ?? null,
    beforeAvailable: observation.before?.available === true, beforeReason: observation.before?.reason ?? null,
    afterAvailable: observation.after?.available === true, afterReason: observation.after?.reason ?? null,
    ringDropped: after?.dropped ?? null, collectionErrors: after?.collectionErrors ?? null};
  countTooltipDrops(observation, traceEvents(before) + traceEvents(after), traceStates(before) + traceStates(after));
  delete observation.before; delete observation.after;
}
/** Budget the actual indented receipt addition; old normal summaries yield space to the current failing phase. */
function budgetTooltipPhases(phases, current) {
  if (tooltipBytes([current]) > 64 * 1024 && current.before?.value?.states) {
    const trace = current.before.value;
    countTooltipDrops(current, traceEvents(trace), trace.states.length - 1);
    current.before.value = {state: trace.states[trace.events[0]?.state ?? trace.last]};
  }
  if (tooltipBytes([current]) > 64 * 1024) pruneTooltipTrace(current, current.after?.value, 16);
  if (tooltipBytes([current]) > 64 * 1024) pruneTooltipTrace(current, current.after?.value, 0);
  if (tooltipBytes([current]) > 64 * 1024) summarizeTooltipPhase(current);
  for (const previous of phases) {
    if (tooltipBytes(phases) <= 128 * 1024) break;
    if (previous !== current && !previous.summary) summarizeTooltipPhase(previous);
  }
}
/** Preserve the original action result/error; diagnostic failure and cleanup have independent short bounds. */
export async function observeHardModeTooltip({record, phase, criterion, language, start, stop, action, native}) {
  const observation = {phase, criterion, language, outcome: 'pending'}, phases = record.tooltipPhases ??= [];
  if (phases.length < 64) phases.push(observation);
  [observation.before, observation.nativeBefore] = await Promise.all([tooltipEvidence(start), tooltipEvidence(native)]);
  budgetTooltipPhases(phases, observation);
  try {const result = await action(); observation.outcome = 'completed'; return result;}
  catch (error) {observation.outcome = 'failed'; throw error;}
  finally {
    [observation.after, observation.nativeAfter] = await Promise.all([tooltipEvidence(stop), tooltipEvidence(native)]);
    budgetTooltipPhases(phases, observation);
  }
}

// Fail-fixture presentation only. This never supplies or preserves delivered-trip qualification evidence.
export async function hardModeFixtureSnapshot({hint, details, tripBanners} = {}) {
  const status = await globalThis.desktop.getHardModeStatus();
  const nodes = selector => [...globalThis.document.querySelectorAll(selector)];
  const visible = node => Boolean(node && node.getClientRects().length && globalThis.getComputedStyle(node).visibility === 'visible');
  const rows = nodes('[data-testid^="hard-mode-rule-"]').map(row => {
    const id = row.getAttribute('data-testid').slice('hard-mode-rule-'.length), buttons = nodes('[data-testid="hard-mode-name-' + id + '"]');
    const button = buttons[0];
    return {id, state: row.getAttribute('data-state'), buttonCount: buttons.length,
      label: button?.getAttribute('aria-label'), name: button?.querySelector('span:last-child')?.textContent};
  });
  const textFact = id => {
    const [node, duplicate] = nodes(`[data-testid="${id}"]`);
    return {count: duplicate ? 2 : node ? 1 : 0, visible: visible(node), text: (node?.innerText ?? '').slice(0, 256)};
  };
  const snapshot = {status, language: globalThis.document.documentElement.lang, rows, source: textFact('hard-mode-source')};
  if (tripBanners) snapshot.tripBanners = {ratio: textFact('hard-mode-trip-ratio'), diagnostic: textFact('hard-mode-diagnostic')};
  if (hint) {
    const matches = nodes('[data-testid="hard-mode-hint-' + hint + '"]'), node = matches[0];
    snapshot.hint = {count: matches.length, visible: visible(node), lines: node ? [...node.querySelectorAll(':scope > p')].map(p => p.innerText) : []};
  }
  if (details) {
    const matches = nodes('[data-testid="hard-mode-details"]');
    snapshot.details = {count: matches.length, visible: visible(matches[0]), rows: nodes('[data-testid^="hard-mode-detail-rule-"]').map(node => ({
      id: node.getAttribute('data-testid').slice('hard-mode-detail-rule-'.length), lines: [...node.querySelectorAll(':scope > p')].map(p => p.innerText)}))};
  }
  return snapshot;
}

function matchesFixture(snapshot, expected) {
  const assessment = snapshot.status?.assessment;
  if (snapshot.status?.trip?.firstLoss || assessment?.state !== 'fail' || assessment.source !== 'fixture' ||
      snapshot.language !== expected.language || assessment.rules?.length !== 12 || snapshot.rows?.length !== 12 || expected.rules.length !== 12) return false;
  if (expected.sourceText && (!snapshot.source || snapshot.source.count !== 1 || !snapshot.source.visible ||
      !snapshot.source.text.match(expected.sourceText))) return false;
  if (expected.tripBanners) {
    const trip = snapshot.status.trip;
    if (trip?.version !== 2 || trip.latestDiagnostic?.code !== 'rule-failed' || trip.latestDiagnostic.rule !== 'fatigue') return false;
    for (const [name, text] of Object.entries(expected.tripBanners)) {
      const banner = snapshot.tripBanners?.[name];
      if (!banner || banner.count !== 1 || !banner.visible || !banner.text.match(text)) return false;
    }
  }
  for (const [index, rule] of expected.rules.entries()) {
    const backend = assessment.rules[index], rendered = snapshot.rows[index];
    if (backend.id !== rule.id || backend.state !== rule.state || backend.reason !== rule.reason || JSON.stringify(backend.values) !== JSON.stringify(rule.values) ||
        rendered.id !== rule.id || rendered.state !== rule.state || rendered.buttonCount !== 1 || rendered.label !== rule.label || rendered.name !== rule.name) return false;
  }
  if (expected.hint) {
    const rule = expected.rules.find(rule => rule.id === expected.hint), hint = snapshot.hint;
    if (!hint || hint.count !== 1 || !hint.visible || JSON.stringify(hint.lines.slice(0, 4)) !== JSON.stringify(rule.tooltip)) return false;
  }
  if (expected.details) {
    // ET-057: only a failing rule shows its current and required values in the grid.
    const details = snapshot.details, shown = expected.rules.filter(rule => rule.state === 'fail');
    if (!details || details.count !== 1 || !details.visible || details.rows?.length !== shown.length) return false;
    if (!shown.every((rule, index) => details.rows[index].id === rule.id && JSON.stringify(details.rows[index].lines) === JSON.stringify(rule.details))) return false;
  }
  return true;
}

/** Reacquire genuine fixture evidence after interruption; one deadline covers every awaited request and DOM read. */
export async function waitForHardModeFixture({refresh, observe, expected, record, message, timeoutMs = 5000}) {
  const started = performance.now();
  let active = true, deadline, poll, wake;
  record.refreshRequests = 0;
  const run = async () => {
    while (active) {
      record.phase = 'refresh'; record.refreshRequests++; await refresh();
      if (!active) return;
      record.phase = 'snapshot'; const snapshot = await observe();
      if (!active) return;
      record.lastSnapshot = snapshot;
      if (snapshot.status?.trip?.firstLoss) throw new Error(message + '_QUALIFICATION_LOST');
      if (matchesFixture(snapshot, expected)) {
        record.phase = 'complete'; record.observedUtcMs = snapshot.status.assessment.observedUtcMs;
        // Successful UI phases need only their publication stamp; retain a full last snapshot only on failure.
        delete record.lastSnapshot; return snapshot;
      }
      record.phase = 'poll'; await new Promise(resolve => {wake = resolve; poll = setTimeout(resolve, 100);});
    }
  };
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      deadline = setTimeout(() => {active = false; wake?.(); reject(new Error(`${message} within ${timeoutMs} ms`));}, timeoutMs);
    })]);
  } finally {
    active = false; clearTimeout(deadline); clearTimeout(poll); wake?.();
    record.elapsedMilliseconds = Math.round(performance.now() - started);
  }
}
