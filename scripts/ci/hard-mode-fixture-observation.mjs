import {performance} from 'node:perf_hooks';
// Fail-fixture presentation only. This never supplies or preserves delivered-trip qualification evidence.
export async function hardModeFixtureSnapshot({hint, details} = {}) {
  const status = await globalThis.desktop.getHardModeStatus();
  const nodes = selector => [...globalThis.document.querySelectorAll(selector)];
  const visible = node => Boolean(node && node.getClientRects().length && globalThis.getComputedStyle(node).visibility === 'visible');
  const rows = nodes('[data-testid^="hard-mode-rule-"]').map(row => {
    const id = row.getAttribute('data-testid').slice('hard-mode-rule-'.length), buttons = nodes('[data-testid="hard-mode-name-' + id + '"]');
    const button = buttons[0];
    return {id, state: row.getAttribute('data-state'), buttonCount: buttons.length,
      label: button?.getAttribute('aria-label'), name: button?.querySelector('span:last-child')?.textContent};
  });
  const snapshot = {status, language: globalThis.document.documentElement.lang, rows};
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
    const details = snapshot.details;
    if (!details || details.count !== 1 || !details.visible || details.rows?.length !== 12) return false;
    if (!expected.rules.every((rule, index) => details.rows[index].id === rule.id && JSON.stringify(details.rows[index].lines.slice(0, 4)) === JSON.stringify(rule.details))) return false;
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
