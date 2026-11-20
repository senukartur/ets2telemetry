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

  it('rejects contradictory or oversized metadata and presents simultaneous localized badges', () => {
    const value = classifyCargo(definition)!;
    expect(isCargoClassification(value)).toBe(true);
    for (const invalid of [{...value, fragile: false}, {...value, fragility: Infinity}, {...value, groups: ['machinery', 'fragile']},
      {...value, groups: ['fragile', 'fragile']}, {...value, adr: {state: 'none', class: 8}}, {...value, oversize: 'true'}]) {
      expect(isCargoClassification(invalid)).toBe(false);
    }
    const en = renderToStaticMarkup(createElement(CargoBadges, {value, language: 'en'}));
    const ru = renderToStaticMarkup(createElement(CargoBadges, {value, language: 'ru'}));
    for (const label of ['Fragile', 'High value', 'ADR 8', 'Machinery']) expect(en).toContain(label);
    for (const label of ['Хрупкий', 'Ценный', 'ADR 8', 'Техника']) expect(ru).toContain(label);
    expect(en.match(/data-cargo-classification="fragile"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(CargoBadges, {language: 'en'}))).toBe('');
    const ordinary = classifyCargo({fragility: 0.2, adrClass: null, valuable: null, overweight: null, oversize: null, groups: []})!;
    expect(renderToStaticMarkup(createElement(CargoBadges, {value: ordinary, language: 'en'}))).toBe('');
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
    const native = vi.fn(() => Promise.resolve(found)).mockReturnValueOnce(awaiting.promise);
    let key = 'verified';
    const probe = new SharedGameProcessProbe(() => key, native), signal = new AbortController().signal;
    const hardMode = probe.read(source, signal), cargo = probe.read(source, signal);
    expect(native).toHaveBeenCalledTimes(1);
    probe.retire();
    key = 'new-lifetime';
    const following = probe.read(source, signal);
    expect(native).toHaveBeenCalledTimes(1);
    awaiting.resolve(found);
    await expect(Promise.all([hardMode, cargo])).resolves.toEqual([null, null]);
    await expect(following).resolves.toEqual(found);
    expect(native).toHaveBeenCalledTimes(2);
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
});
