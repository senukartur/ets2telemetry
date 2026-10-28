import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {UpdateView} from '../../../packages/contracts/src';
import {AboutUpdateCheck, SidebarUpdateControl} from '../../../apps/desktop/src/update-control';
import {ABOUT_CHECK_WAIT_MS} from '../../../apps/desktop/src/update-control-text';

// ET-055 PR-7 real-DOM scenarios for tests/unit/update-control-dom.test.ts. The test bundles this page with Vite and opens
// it in a hidden Electron window; the page runs the real components with React DOM, records plain facts in
// `window.__result` and never touches the bridge (every bridge call is a fake passed as a prop).

type Facts = Record<string, unknown>;
declare global {
  interface Window {__result?: {scenarios: Record<string, Facts>; error: string | null}}
}

const view = (patch: Partial<UpdateView>): UpdateView => ({state: 'idle', available: null, progress: null, refusal: null, failure: null, lastCheck: null, ...patch});
const offered = (state: UpdateView['state'], patch: Partial<UpdateView> = {}) => view({state, available: '0.2.0', ...patch});
const realSetTimeout = window.setTimeout.bind(window), realClearTimeout = window.clearTimeout.bind(window);
/** Polls an observable condition every 5 ms until it holds; fails after 5 s instead of trusting a fixed delay. */
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>(resolve => realSetTimeout(resolve, 5));
  }
}

/** Fake timers for the About wait only: a timer of exactly ABOUT_CHECK_WAIT_MS is recorded, every other one is real. */
const fakeTimers = new Map<number, () => void>();
let nextFake = 1_000_000;
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  if (timeout !== ABOUT_CHECK_WAIT_MS || typeof handler !== 'function') return realSetTimeout(handler, timeout, ...args);
  const id = nextFake++;
  fakeTimers.set(id, () => (handler as (...values: unknown[]) => void)(...args));
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  if (id !== undefined && fakeTimers.delete(id)) return;
  realClearTimeout(id);
}) as typeof window.clearTimeout;
const renderErrors: string[] = [];
const fireFakeTimers = () => {const pending = [...fakeTimers.values()]; fakeTimers.clear(); for (const run of pending) run();};

/** Counts committed root renders: its passive effect runs after every effect of the element it wraps. */
let commits = 0;
function Committed({children}: {children: React.ReactNode}) {
  React.useEffect(() => {commits++;});
  return children;
}

/** A root whose render resolves once React DOM has committed it (its updates are scheduled, not synchronous). */
function mount(): {root: Root; host: HTMLElement; render: (element: React.ReactElement) => Promise<void>} {
  const host = document.createElement('div');
  document.body.append(host);
  // A render error would otherwise only reach reportError and leave an empty root; it fails the page instead.
  const root = createRoot(host, {onUncaughtError: error => renderErrors.push(String(error)), onRecoverableError: error => renderErrors.push(String(error))});
  return {root, host, render: async element => {
    const target = commits + 1;
    root.render(React.createElement(Committed, null, element));
    await until(() => commits >= target, 'a committed render');
  }};
}
const text = (host: HTMLElement, testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

/** The sidebar button keeps its DOM node and keyboard focus as the view moves through failure and back. */
async function sidebarFocus(): Promise<Facts> {
  const {root, host, render} = mount();
  const sidebar = (update: UpdateView) => React.createElement(SidebarUpdateControl, {view: update, language: 'en', windowFocused: false, apply: () => Promise.resolve(update)});
  await render(sidebar(offered('failed', {failure: 'OFFLINE'})));
  const button = host.querySelector<HTMLButtonElement>('[data-testid="shell.sidebar.update"]');
  button?.focus();
  const initial = {exists: button !== null, active: document.activeElement === button};
  const steps: Facts[] = [];
  for (const update of [offered('downloading', {progress: 42}), offered('failed', {failure: 'DISK_FULL'}), offered('refused', {refusal: 'GAME_RUNNING'}), offered('available')]) {
    await render(sidebar(update));
    const now = host.querySelector('[data-testid="shell.sidebar.update"]');
    steps.push({state: update.state, same: now === button, active: document.activeElement === button, rendered: now?.getAttribute('data-update-state') ?? null});
  }
  root.unmount(); host.remove();
  return {initial, steps};
}

interface AboutRun {
  calls: () => number;
  set: (update: UpdateView) => Promise<void>;
  /** Clicks the button, then waits until every bridge reply has settled and `ready(facts)` holds. */
  click: (ready: (facts: Facts) => boolean) => Promise<void>;
  facts: () => Facts;
  done: () => void;
}
async function about(initial: UpdateView, reply: () => Promise<UpdateView>): Promise<AboutRun> {
  const {root, host, render} = mount();
  let calls = 0, replied = 0;
  // The counter's handlers are attached before the component's, so the component's handler runs right after the count.
  const check = () => {calls++; const answer = reply(); answer.then(() => {replied++;}, () => {replied++;}); return answer;};
  const set = (update: UpdateView) => render(React.createElement(AboutUpdateCheck, {view: update, language: 'en', check}));
  await set(initial);
  const button = () => host.querySelector<HTMLButtonElement>('[data-testid="settings-about-update-check"]');
  const facts = (): Facts => ({busy: button()?.getAttribute('aria-disabled') === 'true', disabled: button()?.disabled ?? null, note: text(host, 'settings-about-update-check-note'),
      message: text(host, 'settings-about-update-check-result-message'), severity: host.querySelector('[data-testid="settings-about-update-check-result"]')?.getAttribute('data-severity') ?? null,
      fakeTimers: fakeTimers.size});
  return {calls: () => calls, set, facts,
    click: async ready => {button()?.click(); await until(() => replied === calls && ready(facts()), 'the About answer');},
    done: () => {root.unmount(); host.remove(); fakeTimers.clear();}};
}

const LATEST = 'You have the latest version.', CHECKING = 'Checking for updates…';
const OFFERED_TEXT = 'Version 0.2.0 is available. Use the button in the sidebar to install it.';
const showing = (message: string) => (facts: Facts) => facts.message === message;

async function scenarios(): Promise<Record<string, Facts>> {
  const before = {outcome: 'up-to-date' as const, failure: null, atUtcMs: 1000};
  const result: Record<string, Facts> = {sidebarFocus: await sidebarFocus()};

  // A check that does not start (the 10 s throttle): the reply is idle, so About answers at once from it.
  let run = await about(view({lastCheck: before}), () => Promise.resolve(view({lastCheck: before})));
  await run.click(showing(LATEST));
  result.throttled = {...run.facts(), calls: run.calls()};
  run.done();

  // A started check: pending and busy, one 30 s fake timer, then the newer finished check answers.
  run = await about(view({lastCheck: before}), () => Promise.resolve(view({state: 'checking', lastCheck: before})));
  await run.click(facts => facts.message === CHECKING && facts.fakeTimers === 1);
  const pending = run.facts();
  await run.set(view({state: 'checking', lastCheck: before}));
  await run.set(view({lastCheck: {outcome: 'failed', failure: 'OFFLINE', atUtcMs: 2000}}));
  result.started = {pending, ...run.facts(), calls: run.calls()};
  run.done();

  // A started check that never reports: the 30 s fake timer ends the wait with the latest finished check.
  run = await about(view({lastCheck: before}), () => Promise.resolve(view({state: 'checking', lastCheck: before})));
  await run.click(facts => facts.message === CHECKING && facts.fakeTimers === 1);
  await run.set(view({state: 'checking', lastCheck: before}));
  const waiting = run.facts();
  fireFakeTimers();
  await until(() => run.facts().message === LATEST, 'the end of the 30 s wait');
  result.fallback = {waiting, ...run.facts()};
  run.done();

  // A rejected bridge call answers at once from the latest finished check.
  run = await about(view({lastCheck: before}), () => Promise.reject(new Error('rejected')));
  await run.click(showing(LATEST));
  result.rejected = {...run.facts(), calls: run.calls()};
  run.done();

  // `ready`: About is busy with a fixed note and the click does nothing.
  run = await about(offered('ready', {lastCheck: before}), () => Promise.resolve(offered('ready', {lastCheck: before})));
  // The click handler runs synchronously inside click(), so a call it made would already be counted.
  await run.click(() => true);
  result.ready = {...run.facts(), calls: run.calls()};
  run.done();

  // An offer already stands: the check answers at once with the offered version.
  run = await about(offered('available', {lastCheck: {outcome: 'available', failure: null, atUtcMs: 1000}}), () => Promise.resolve(offered('available', {lastCheck: {outcome: 'available', failure: null, atUtcMs: 1000}})));
  await run.click(showing(OFFERED_TEXT));
  result.offered = {...run.facts(), calls: run.calls()};
  run.done();
  return result;
}

scenarios().then(found => {window.__result = {scenarios: found, error: renderErrors.length ? renderErrors.join('\n') : null};},
  (error: unknown) => {window.__result = {scenarios: {}, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)};});
