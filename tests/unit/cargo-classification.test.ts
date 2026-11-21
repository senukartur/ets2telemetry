import {copyFile, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {CargoArchiveCache} from '../../apps/desktop/src/cargo-catalog/archive-cache';
import {classifyCargo} from '../../apps/desktop/src/cargo-catalog/classify';
import {CargoMainBridge} from '../../apps/desktop/src/cargo-catalog/main-bridge';
import {CargoSourceClient} from '../../apps/desktop/src/cargo-catalog/source-client';
import type {CargoLookupReply, CargoLookupRequest} from '../../apps/desktop/src/cargo-catalog/service-contract';
import {SharedGameProcessProbe} from '../../apps/desktop/src/hard-mode/process';
import {CargoBadges} from '../../apps/desktop/src/trip-badges';
import {isCargoClassification} from '../../packages/contracts/src/cargo-classification';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';

const source: SourceIdentity = {origin: 'game', game: 'ets2', processId: 101, windowsSessionId: 1,
  pluginSessionId: '10000000-0000-4000-8000-000000000001', processInstanceId: '10000000-0000-4000-8000-000000000002'};
const executable = 'C:\\Games\\ETS2\\bin\\win_x64\\eurotrucks2.exe';
const definition = {fragility: 0.75, adrClass: 8, valuable: true, overweight: null, oversize: null, groups: ['machinery', 'fragile', 'unknown']};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => {resolve = finish;});
  return {resolve, promise};
}

describe('cargo classification and badges (REG-009/010/014)', () => {
  it('derives the in-game fragile flag using the float threshold and the defined-cargo default', () => {
    expect(classifyCargo()).toBeNull();
    expect(classifyCargo({...definition, fragility: 0.69})).toMatchObject({fragile: false, groups: ['fragile', 'machinery']});
    expect(classifyCargo({...definition, fragility: 0.7})).toMatchObject({fragile: true});
    expect(classifyCargo({...definition, fragility: null, adrClass: 0, valuable: null})).toMatchObject({
      fragile: true, fragility: null, adr: {state: 'none'}, valuable: false, overweight: false, oversize: null,
    });
    expect(classifyCargo({...definition, adrClass: 77})).toMatchObject({adr: {state: 'unsupported'}});
  });

  it('rejects contradictory or oversized classification metadata', () => {
    const value = classifyCargo(definition)!;
    expect(isCargoClassification(value)).toBe(true);
    for (const invalid of [{...value, fragile: false}, {...value, fragility: Infinity}, {...value, groups: ['machinery', 'fragile']},
      {...value, groups: ['fragile', 'fragile']}, {...value, adr: {state: 'none', class: 8}}, {...value, oversize: 'true'}]) {
      expect(isCargoClassification(invalid)).toBe(false);
    }
  });

  it('uses one Heavy badge for overweight or positive oversize evidence', () => {
    const ordinary = classifyCargo({fragility: 0.2, adrClass: null, valuable: null, overweight: null, oversize: null, groups: ['machinery']})!;
    const render = (value: typeof ordinary) => renderToStaticMarkup(createElement(CargoBadges, {value, language: 'en'}));
    for (const value of [{...ordinary, overweight: true}, {...ordinary, oversize: true}, {...ordinary, groups: [...ordinary.groups, 'oversize' as const]}]) {
      const html = render(value);
      expect(html.match(/data-cargo-classification="[^"]+"/g)).toEqual(['data-cargo-classification="heavy"']);
      expect(html).toContain('<span>Heavy</span>');
    }
    expect(renderToStaticMarkup(createElement(CargoBadges, {language: 'en'}))).toBe('');
    expect(render(ordinary)).toBe('');
  });
});

describe('private cargo source and local cache (REG-003/010)', () => {
  it('classifies base and DLC archives in a confined installation inventory while skipping mod paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'et-cargo-inventory-'));
    try {
      const root = await realpath(directory), mod = join(root, 'mod');
      await mkdir(mod);
      await Promise.all([
        copyFile(new URL('../fixtures/cargo-catalog/def.scs', import.meta.url), join(root, 'def.scs')),
        copyFile(new URL('../fixtures/cargo-catalog/dlc_fixture.scs', import.meta.url), join(root, 'dlc_fixture.scs')),
        writeFile(join(root, 'mod_fake.scs'), 'admitting this file would invalidate the catalog'),
        writeFile(join(mod, 'dlc_fake.scs'), 'recursing here would invalidate the catalog'),
      ]);
      const cache = new CargoArchiveCache(), signal = new AbortController().signal;
      await expect(cache.lookup(root, 'synthetic_sensitive', signal)).resolves.toMatchObject({fragile: true, valuable: true, adr: {state: 'class', class: 8}});
      await expect(cache.lookup(root, 'synthetic_heavy', signal)).resolves.toMatchObject({overweight: true, oversize: true});
      await expect(cache.lookup(root, 'synthetic_conflict', signal)).resolves.toBeNull();
    } finally {await rm(directory, {recursive: true, force: true});}
  });

  it('shares one native probe and discards its result when the authenticated lifetime retires', async () => {
    const found = {pid: 101, createdUtcMs: 100, executable};
    const awaiting = deferred<typeof found>();
    const native = vi.fn<(source: SourceIdentity, signal: AbortSignal) => Promise<typeof found>>(() => Promise.resolve(found))
      .mockReturnValueOnce(awaiting.promise);
    let key = 'verified';
    const probe = new SharedGameProcessProbe(() => key, native), signal = new AbortController().signal;
    const hardMode = probe.read(source, signal), cargo = probe.read(source, signal);
    expect(native).toHaveBeenCalledTimes(1);
    probe.retire();
    expect(native.mock.calls[0][1].aborted).toBe(true);
    key = 'new-lifetime';
    const following = probe.read(source, signal);
    expect(native).toHaveBeenCalledTimes(1);
    awaiting.resolve(found);
    await expect(Promise.all([hardMode, cargo])).resolves.toEqual([null, null]);
    await expect(following).resolves.toEqual(found);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('lets a joined native probe finish after its first subscriber cancels', async () => {
    const cancelled = new AbortController(), other = new AbortController().signal;
    const found = {pid: 101, createdUtcMs: 100, executable}, awaiting = deferred<typeof found>();
    const native = vi.fn(async (_source: SourceIdentity, signal: AbortSignal) => {
      const result = await awaiting.promise;
      signal.throwIfAborted();
      return result;
    });
    const probe = new SharedGameProcessProbe(() => 'verified', native);
    const hardMode = probe.read(source, cancelled.signal), cargo = probe.read(source, other);
    cancelled.abort();
    await expect(hardMode).resolves.toBeNull();
    expect(native.mock.calls[0][1].aborted).toBe(false);
    awaiting.resolve(found);
    await expect(cargo).resolves.toEqual(found);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('joins duplicate cargo lookups and rejects replies from a retired source generation', async () => {
    const sent = deferred<CargoLookupRequest>();
    let active: SourceIdentity | undefined = source;
    const client = new CargoSourceClient(sent.resolve, input => input === active ? input.pluginSessionId : undefined,
      () => Promise.resolve({pid: 101, createdUtcMs: 100, executable}));
    const claim = client.lookup(source, 'cargo_a')!, repeated = client.lookup(source, 'cargo_a')!;
    expect(claim.result).toBe(repeated.result);
    const request = await sent.promise;
    expect(request).toMatchObject({game: 'ets2', executable, cargoId: 'cargo_a', generation: claim.opening.generation});
    active = undefined;
    client.retire();
    client.receive({type: 'cargo:result', generation: request.generation, request: request.request, classification: classifyCargo(definition)});
    await expect(claim.result).resolves.toBeNull();
    expect(claim.current()).toBe(false);
    expect(client.lookup(source, 'cargo_a')).toBeUndefined();
  });

  it('coalesces cache loads, reads the changed inventory, and scopes the main reply', async () => {
    let version = '1';
    const inventory = vi.fn(() => Promise.resolve({fingerprint: version, paths: ['test.scs']}));
    const read = vi.fn(() => Promise.resolve({
      definitions: new Map([['cargo_a', {...definition, fragile: false, valuable: version === '1'}]]),
      conflicts: new Set<string>(),
    }));
    const cache = new CargoArchiveCache(inventory, read), signal = new AbortController().signal;
    await expect(Promise.all([cache.lookup('root', 'cargo_a', signal), cache.lookup('root', 'cargo_a', signal)]))
      .resolves.toEqual([expect.objectContaining({valuable: true}), expect.objectContaining({valuable: true})]);
    expect(read).toHaveBeenCalledTimes(1);
    const sent = deferred<CargoLookupReply>(), resolve = vi.fn(() => Promise.resolve('root'));
    const bridge = new CargoMainBridge(cache, resolve, sent.resolve, game => game === 'ets2');
    const request = {type: 'cargo:lookup', generation: source.pluginSessionId, request: source.processInstanceId, executable, cargoId: 'cargo_a'} as const;
    bridge.receive({...request, game: 'ats'});
    bridge.receive({...request, game: 'ets2', executable: '\\\\server\\game.exe'});
    expect(resolve).not.toHaveBeenCalled();
    version = '2';
    bridge.receive({...request, game: 'ets2'});
    await expect(sent.promise).resolves.toEqual({type: 'cargo:result', generation: request.generation, request: request.request,
      classification: expect.objectContaining({valuable: false})});
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('finishes one keyed archive load for a replacement generation after the first wait is retired', async () => {
    const started = deferred<void>(), release = deferred<void>();
    const inventory = vi.fn(() => Promise.resolve({fingerprint: 'exact archive files', paths: ['def.scs']}));
    const read = vi.fn(async (_paths: readonly string[], signal?: AbortSignal) => {
      started.resolve();
      await release.promise;
      signal?.throwIfAborted();
      return {definitions: new Map([['cargo_a', definition]]), conflicts: new Set<string>()};
    });
    const cache = new CargoArchiveCache(inventory, read), first = new AbortController(), next = new AbortController();
    const retired = expect(cache.lookup('root', 'cargo_a', first.signal)).rejects.toMatchObject({name: 'AbortError'});
    await started.promise;
    first.abort();
    const active = cache.lookup('root', 'cargo_a', next.signal);
    await retired;
    release.resolve();
    await expect(active).resolves.toMatchObject({valuable: true});
    expect(read).toHaveBeenCalledTimes(1);
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});
