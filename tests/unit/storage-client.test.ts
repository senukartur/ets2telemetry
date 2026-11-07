import {isUploadSyncResult,isUploadSyncRequest} from '../../packages/storage/src/upload-sync';
import {unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CompletenessOptions, JournalResult, Result, SampleAppendOptions, SampleInput, StorageError, StorageErrorCode, TripPage} from '../../packages/storage/src/api';
import {COMMAND_DEADLINE_MS, MAX_QUEUED_COMMANDS, OPEN_DEADLINE_MS, StorageClient, type StorageClientOptions, type StorageWorkerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import {parseRequest, type StorageRequest} from '../../packages/storage/src/worker/protocol';
import {job, trailer, truck} from '../shared/trip-messages';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const P1 = '10000000-0000-4000-8000-000000000001';
const OPEN = {path: 'C:\\isolated\\ETS2Telemetry\\synthetic\\test.sqlite', purpose: 'synthetic' as const, backupsDirectory: 'C:\\isolated\\ETS2Telemetry\\synthetic\\backups', appVersion: '0.1.0-test'};
const SUMMARY = {schemaVersion: 1, created: true, databaseUuid: '50000000-0000-4000-8000-000000000001', purpose: 'synthetic'};
const COMMITTED = {status: 'committed', committedThroughEventSeq: '1'};

/** A scripted worker: it records requests, and the test answers, fails or ends it explicitly. */
function fixture(options: StorageClientOptions = {}) {
  const sent: StorageRequest[] = [];
  const listeners: {message?: (message: unknown) => void; error?: (error: unknown) => void; exit?: (code: number) => void} = {};
  let exited = false;
  const exit = (code: number) => { if (exited) return; exited = true; listeners.exit?.(code); };
  const handle: StorageWorkerHandle = {
    postMessage: message => { sent.push(structuredClone(message)); },
    onMessage: listener => { listeners.message = listener; },
    onError: listener => { listeners.error = listener; },
    onExit: listener => { listeners.exit = listener; },
    // Like worker_threads: termination ends the thread with exit code 1 before the promise resolves.
    terminate: vi.fn(() => { exit(1); return Promise.resolve(1); })
  };
  const failures: StorageError[] = [];
  const client = new StorageClient(handle, {onFailure: error => failures.push(error), ...options});
  return {
    client, sent, handle, failures,
    reply(id: number, result: Result<unknown>) { listeners.message?.({type: 'storage.response', id, result}); },
    ok(id: number, value: unknown) { listeners.message?.({type: 'storage.response', id, result: {ok: true, value}}); },
    raw(message: unknown) { listeners.message?.(message); },
    error() { listeners.error?.(new Error('worker crashed')); },
    exit
  };
}
/** Tracks a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: {value?: T} = {};
  void promise.then(value => { state.value = value; });
  return state;
}
const code = (result: Result<unknown> | undefined) => result && !result.ok ? result.error.code : result?.ok ? 'ok' : 'pending';
const error = (value: StorageErrorCode) => ({ok: false, error: storageError(value)});

describe('StorageClient command flow', () => {
  it.each(['commitEvent','appendSamples'] as const)('admits %s at the combined limit by refusing only the newest queued background request',async name=>{
    const f=fixture({maxQueued:2}),opening=f.client.open(OPEN),oldest=f.client.beginUploadProjection({pinId:P1,tripUuid:P1});
    const newest=track(f.client.advanceUploadProjection(P1));
    const recorder=name==='commitEvent'?f.client.commitEvent({message:{}}):f.client.appendSamples(P1,[]);
    await Promise.resolve();expect(newest.value).toEqual(error('STORAGE_BUSY'));
    expect(f.sent).toHaveLength(1);
    await expect(f.client.releaseUploadProjection(P1)).resolves.toEqual(error('STORAGE_BUSY'));
    f.ok(1,SUMMARY);await opening;expect(f.sent[1].command.name).toBe(name);
    f.ok(2,name==='commitEvent'?COMMITTED:{appended:0,skipped:0});await expect(recorder).resolves.toMatchObject({ok:true});
    expect(f.sent[2].command.name).toBe('beginUploadProjection');f.ok(3,{pinId:P1,state:'preparing',examined:0,projection:null});await oldest;
    expect(f.sent.map(request=>request.command.name)).toEqual(['open',name,'beginUploadProjection']);
  });
  it('keeps FIFO within the surviving mixed queue while repeated recorder admission uses the same capacity',async()=>{
    const f=fixture({maxQueued:4}),opening=f.client.open(OPEN),first=f.client.beginUploadProjection({pinId:P1,tripUuid:P1});
    const coverage=f.client.committedThrough(P1),second=f.client.advanceUploadProjection(P1),newest=f.client.releaseUploadProjection(P1);
    const commit=f.client.commitEvent({message:{}});await expect(newest).resolves.toEqual(error('STORAGE_BUSY'));
    const samples=f.client.appendSamples(P1,[]);await expect(second).resolves.toEqual(error('STORAGE_BUSY'));
    await expect(f.client.getUploadProjectionPreparation(P1)).resolves.toEqual(error('STORAGE_BUSY'));
    f.ok(1,SUMMARY);await opening;expect(f.sent[1].command.name).toBe('committedThrough');
    f.ok(2,'1');await coverage;expect(f.sent[2].command.name).toBe('commitEvent');
    f.ok(3,COMMITTED);await commit;expect(f.sent[3].command.name).toBe('appendSamples');
    f.ok(4,{appended:0,skipped:0});await samples;expect(f.sent[4].command.name).toBe('beginUploadProjection');
    f.ok(5,{pinId:P1,state:'preparing',examined:0,projection:null});await first;expect(f.sent).toHaveLength(5);
  });
  it('refuses overflow when the queue contains only recorder work or its configured capacity is zero',async()=>{
    for(const maxQueued of [0,1]){
      const f=fixture({maxQueued}),opening=f.client.open(OPEN);
      const queued=maxQueued===1?f.client.commitEvent({message:{}}):undefined;
      await expect(f.client.appendSamples(P1,[])).resolves.toEqual(error('STORAGE_BUSY'));
      await expect(f.client.advanceUploadProjection(P1)).resolves.toEqual(error('STORAGE_BUSY'));
      f.ok(1,SUMMARY);await opening;
      if(queued){f.ok(2,COMMITTED);await queued;}expect(f.sent).toHaveLength(maxQueued+1);
    }
  });
  it('keeps an evicted request busy across close while admitted work is cancelled and in-flight work finishes',async()=>{
    const f=fixture({maxQueued:1}),advance=f.client.advanceUploadProjection(P1),evicted=f.client.releaseUploadProjection(P1),commit=f.client.commitEvent({message:{}});
    await expect(evicted).resolves.toEqual(error('STORAGE_BUSY'));
    const closing=f.client.close();await expect(commit).resolves.toEqual(error('STORAGE_CLOSED'));
    f.ok(1,{pinId:P1,state:'invalidated',examined:0,projection:null});await expect(advance).resolves.toMatchObject({ok:true});
    expect(f.sent[1].command.name).toBe('close');f.ok(2,undefined);f.exit(0);await expect(closing).resolves.toEqual({clean:true});
  });
  it('keeps the original in-flight deadline after admission evicts background work',async()=>{
    const f=fixture({maxQueued:1}),advance=f.client.advanceUploadProjection(P1),evicted=f.client.releaseUploadProjection(P1);
    vi.advanceTimersByTime(COMMAND_DEADLINE_MS-1);
    const commit=f.client.commitEvent({message:{}});await expect(evicted).resolves.toEqual(error('STORAGE_BUSY'));
    vi.advanceTimersByTime(1);await expect(advance).resolves.toEqual(error('TIMEOUT'));await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.sent).toHaveLength(1);expect(f.client.state).toBe('failed');
  });
  it('prioritizes queued recorder commands and keeps FIFO within both classes under the combined limit',async()=>{
    const f=fixture({maxQueued:4}),opening=f.client.open(OPEN),begin=f.client.beginUploadProjection({pinId:P1,tripUuid:P1}),advance=f.client.advanceUploadProjection(P1);
    const commit=f.client.commitEvent({message:{}}),coverage=f.client.committedThrough(P1);
    await expect(f.client.releaseUploadProjection(P1)).resolves.toEqual(error('STORAGE_BUSY'));
    f.ok(1,SUMMARY);await opening;expect(f.sent[1].command.name).toBe('commitEvent');
    f.ok(2,COMMITTED);await commit;expect(f.sent[2].command.name).toBe('committedThrough');
    f.ok(3,'1');await coverage;expect(f.sent[3].command.name).toBe('beginUploadProjection');
    f.ok(4,{pinId:P1,state:'preparing',examined:0,projection:null});await begin;expect(f.sent[4].command.name).toBe('advanceUploadProjection');
    f.ok(5,{pinId:P1,state:'preparing',examined:100,projection:null});await advance;expect(f.sent).toHaveLength(5);
  });
  it('starts a background deadline only on dispatch and fails closed if that bounded request stalls',async()=>{
    const f=fixture(),opening=f.client.open(OPEN),begin=f.client.beginUploadProjection({pinId:P1,tripUuid:P1});
    vi.advanceTimersByTime(COMMAND_DEADLINE_MS+1);expect(f.client.state).toBe('running');expect(f.sent).toHaveLength(1);
    f.ok(1,SUMMARY);await opening;vi.advanceTimersByTime(COMMAND_DEADLINE_MS);
    await expect(begin).resolves.toEqual(error('TIMEOUT'));expect(f.client.state).toBe('failed');
  });
  it('closes queued recorder and background work while allowing the one bounded request in flight to finish',async()=>{
    const f=fixture(),advance=f.client.advanceUploadProjection(P1),commit=f.client.commitEvent({message:{}}),release=f.client.releaseUploadProjection(P1);
    const closing=f.client.close();await expect(commit).resolves.toEqual(error('STORAGE_CLOSED'));await expect(release).resolves.toEqual(error('STORAGE_CLOSED'));
    f.ok(1,{pinId:P1,state:'invalidated',examined:0,projection:null});await expect(advance).resolves.toMatchObject({ok:true});
    expect(f.sent[1].command.name).toBe('close');f.ok(2,undefined);f.exit(0);await expect(closing).resolves.toEqual({clean:true});
  });
  it.each(['getUploadProjectionPreparation','advanceUploadProjection','releaseUploadProjection'] as const)('strictly checks %s arguments and bounded status answers',async name=>{
    for(const command of [{name,pinId:'bad'},{name,pinId:P1,sql:'SELECT 1'}])expect(parseRequest({type:'storage.request',id:1,command})).toEqual({ok:false,id:1});
    const f=fixture(),result=f.client[name](P1);f.ok(1,{pinId:P1,state:'preparing',examined:101,projection:null});await expect(result).resolves.toEqual(error('WORKER_FAILED'));
  });
  it('strictly validates private upload requests and rejects malformed or mismatched answers', async () => {
    const snapshot=`u2:${SUMMARY.databaseUuid}:${P1}:80000000-0000-4000-8000-000000000001:${P1}:1`,query={snapshot,kind:'members' as const,limit:1};
    expect(parseRequest({type:'storage.request',id:1,command:{name:'beginUploadProjection',input:{pinId:P1,tripUuid:P1}}}).ok).toBe(true);
    for(const command of [{name:'beginUploadProjection',input:{pinId:P1,tripUuid:P1},renderer:true},{name:'beginUploadProjection',input:{pinId:'bad',tripUuid:P1}},
      {name:'readUploadProjectionPage',query:{...query,limit:101}},{name:'readUploadProjectionPage',query:{...query,cursor:`${snapshot}:intervals:1`}},
      {name:'readUploadProjectionPage',query:{...query,extra:true}},{name:'readUploadProjectionPage',query:{...query,snapshot:snapshot.replace(/:1$/,':01')}}])
      expect(parseRequest({type:'storage.request',id:1,command})).toEqual({ok:false,id:1});
    const f=fixture(),request=f.client.readUploadProjectionPage({...query,extra:true} as typeof query);
    expect(f.sent[0].command).toEqual({name:'readUploadProjectionPage',query:{...query,cursor:undefined}});
    f.ok(1,{snapshot,kind:'members',cursor:null,nextCursor:null,total:1,rows:[{id:'1',extra:true}]});
    await expect(request).resolves.toEqual(error('WORKER_FAILED'));
    const g=fixture(),pin=g.client.beginUploadProjection({pinId:P1,tripUuid:P1});g.ok(1,{readiness:'ready',tripUuid:P1});await expect(pin).resolves.toEqual(error('WORKER_FAILED'));
    const h=fixture(),page=h.client.readUploadProjectionPage({...query,kind:'intervals'});
    h.ok(1,{snapshot,kind:'intervals',cursor:null,nextCursor:null,total:0,rows:[]});await expect(page).resolves.toMatchObject({ok:true});
  });
  it('copies only the private sample mode/page fields without allowing extra worker authority', async () => {
    const f = fixture(); const scope = {tripUuid: P1, injected: true}, page = {limit: 2, includeExcluded: true, injected: true};
    const request = f.client.listSamples(scope, page);
    page.includeExcluded = false;
    expect(f.sent[0].command).toEqual({name: 'listSamples', scope: {tripUuid: P1}, page: {afterId: undefined, limit: 2, includeExcluded: true}});
    f.ok(1, []); await request;
    for (const includeExcluded of [true, false, undefined]) expect(parseRequest({type:'storage.request',id:1,command:{name:'listSamples',scope:{tripUuid:P1},page:{includeExcluded}}}).ok).toBe(true);
    for (const page of [{includeExcluded: 'true'}, {includeExcluded: 1}, {includeExcluded: null}, {injected: true}])
      expect(parseRequest({type:'storage.request',id:1,command:{name:'listSamples',scope:{tripUuid:P1},page}})).toEqual({ok:false,id:1});
  });
  it('sends one command at a time with monotonic request ids and returns each result', async () => {
    const f = fixture();
    const first = f.client.committedThrough(P1), second = f.client.committedThrough(P1), third = f.client.storageInfo();
    expect(f.sent.map(request => [request.id, request.command.name])).toEqual([[1, 'committedThrough']]);
    f.ok(1, '5');
    await expect(first).resolves.toEqual({ok: true, value: '5'});
    expect(f.sent.map(request => request.id)).toEqual([1, 2]);
    f.ok(2, '6'); await expect(second).resolves.toEqual({ok: true, value: '6'});
    f.ok(3, {schemaVersion: 1}); await expect(third).resolves.toEqual({ok: true, value: {schemaVersion: 1}});
    expect(f.sent.map(request => request.id)).toEqual([1, 2, 3]);
    // Every request is a well-formed storage request.
    for (const request of f.sent) expect(parseRequest(request).ok).toBe(true);
  });
  it('copies only the four open fields: in-process test hooks and migrations never reach the worker', () => {
    const f = fixture();
    void f.client.open({...OPEN, testHooks: {beforeCommit: () => undefined}, migrations: []} as unknown as typeof OPEN);
    expect(f.sent[0].command).toEqual({name: 'open', options: OPEN});
  });
  it(`queues ${MAX_QUEUED_COMMANDS} commands behind the one in flight and refuses the next with STORAGE_BUSY`, async () => {
    const f = fixture();
    const accepted = Array.from({length: MAX_QUEUED_COMMANDS + 1}, () => f.client.committedThrough(P1));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('STORAGE_BUSY'));
    expect(storageError('STORAGE_BUSY').retryable).toBe(true);
    expect(f.sent).toHaveLength(1);
    for (let id = 1; id <= accepted.length; id++) f.ok(id, String(id));
    expect((await Promise.all(accepted)).map(result => result.ok && result.value)).toEqual(accepted.map((_, index) => String(index + 1)));
    expect(f.sent).toHaveLength(MAX_QUEUED_COMMANDS + 1);
  });
  it('passes a storage error through and keeps serving: a failed commit is not a worker failure', async () => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    f.reply(1, error('DISK_FULL') as Result<unknown>);
    await expect(commit).resolves.toEqual(error('DISK_FULL'));
    const retry = f.client.commitEvent({message: {}});
    f.ok(2, COMMITTED);
    await expect(retry).resolves.toEqual({ok: true, value: COMMITTED});
    expect(f.failures).toEqual([]);
    expect(f.client.state).toBe('running');
  });
});

describe('ET-015a trip filter and completeness options at the worker boundary', () => {
  const INTERVAL = {kind: 'restore-loss' as const, firstEventSeq: '3', lastEventSeq: '5'};
  const request = (command: Record<string, unknown>) => ({type: 'storage.request', id: 1, command});
  it('sends the listTrips filter and copies only the page fields', () => {
    const f = fixture();
    void f.client.listTrips({game: 'ats', outcome: 'open', cursor: '5', limit: 10, testHooks: {}} as Parameters<StorageClient['listTrips']>[0]);
    expect(f.sent[0].command).toEqual({name: 'listTrips', page: {game: 'ats', outcome: 'open', cursor: '5', limit: 10}});
    expect(Object.keys((f.sent[0].command as {page: object}).page).sort()).toEqual(['cursor', 'game', 'limit', 'outcome']);
    expect(parseRequest(f.sent[0]).ok).toBe(true);
  });
  it('sends ifAbsent and nothing else of the completeness options, and no options when none are given', async () => {
    const f = fixture();
    const first = f.client.recordCompleteness(P1, INTERVAL, {ifAbsent: true, testHooks: {}} as Parameters<StorageClient['recordCompleteness']>[2]);
    expect(f.sent[0].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options: {ifAbsent: true}});
    f.ok(1, undefined);
    await expect(first).resolves.toEqual({ok: true, value: undefined});
    void f.client.recordCompleteness(P1, INTERVAL);
    expect(f.sent[1].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL});
    expect(Object.hasOwn(f.sent[1].command, 'options')).toBe(false);
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  // Review pass 1: a non-object page or options value used to throw a TypeError in the client. It is forwarded as given,
  // so the strict worker parser refuses it and the caller gets an INVALID_INPUT result.
  it.each([['null', null], ['a number', 5], ['a string', 'ets2']])('forwards %s as the page or options value instead of throwing', (_name, value) => {
    const f = fixture();
    expect(() => f.client.listTrips(value as unknown as TripPage)).not.toThrow();
    expect(() => f.client.recordCompleteness(P1, INTERVAL, value as unknown as CompletenessOptions)).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'listTrips', page: value});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
    f.reply(1, error('INVALID_INPUT') as Result<unknown>);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options: value});
    expect(parseRequest(f.sent[1])).toEqual({ok: false, id: 2});
  });
  it('returns the INVALID_INPUT answer of a refused page to the caller', async () => {
    const f = fixture();
    const listed = f.client.listTrips(null as unknown as TripPage);
    f.reply(1, error('INVALID_INPUT') as Result<unknown>);
    await expect(listed).resolves.toEqual(error('INVALID_INPUT'));
  });
  it.each([
    ['no page', undefined],
    ['an empty page', {}],
    ['every field', {cursor: '7', limit: 100, game: 'ets2', outcome: 'cancelled'}],
    ['undefined fields', {cursor: undefined, limit: undefined, game: undefined, outcome: undefined}],
    ['outcome none', {outcome: 'none'}],
    ['outcome delivered', {outcome: 'delivered'}]
  ])('accepts a listTrips page with %s', (_name, page) => {
    expect(parseRequest(request({name: 'listTrips', page}))).toMatchObject({ok: true, id: 1});
  });
  it.each([
    ['an unknown key', {game: 'ets2', testHooks: {}}],
    ['an unknown game', {game: 'ETS2'}],
    ['an unknown outcome', {outcome: 'closed'}],
    ['a numeric cursor', {cursor: 5}],
    ['a text limit', {limit: '10'}],
    ['an array', []],
    ['null', null]
  ])('refuses a listTrips page with %s', (_name, page) => {
    expect(parseRequest(request({name: 'listTrips', page}))).toEqual({ok: false, id: 1});
  });
  it.each([
    ['no options', undefined, true],
    ['ifAbsent true', {ifAbsent: true}, true],
    ['ifAbsent false', {ifAbsent: false}, true],
    ['ifAbsent undefined', {ifAbsent: undefined}, true],
    ['a text ifAbsent', {ifAbsent: 'yes'}, false],
    ['an unknown key', {ifAbsent: true, testHooks: {}}, false],
    ['an array', [], false],
    ['null', null, false]
  ])('checks recordCompleteness options strictly: %s', (_name, options, accepted) => {
    expect(parseRequest(request({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options})).ok).toBe(accepted);
  });
});

describe('ET-015b sample options and counts at the worker boundary', () => {
  const ROWS: SampleInput[] = [];
  const request = (options: unknown) => ({type: 'storage.request', id: 1, command: {name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options}});
  it('sends uniqueSeconds and nothing else of the sample options, and no options when none are given', async () => {
    const f = fixture();
    const first = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true, testHooks: {beforeCommit: () => undefined}} as Parameters<StorageClient['appendSamples']>[2]);
    expect(f.sent[0].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options: {uniqueSeconds: true}});
    expect(Object.keys((f.sent[0].command as {options: object}).options)).toEqual(['uniqueSeconds']);
    f.ok(1, {appended: 0, skipped: 0});
    await expect(first).resolves.toEqual({ok: true, value: {appended: 0, skipped: 0}});
    void f.client.appendSamples(P1, ROWS);
    expect(f.sent[1].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS});
    expect(Object.hasOwn(f.sent[1].command, 'options')).toBe(false);
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  it('forwards sample options that are not an object as given, so the worker parser refuses them', () => {
    const f = fixture();
    expect(() => f.client.appendSamples(P1, ROWS, null as unknown as SampleAppendOptions)).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options: null});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
  });
  it.each([
    ['no options', undefined, true],
    ['uniqueSeconds true', {uniqueSeconds: true}, true],
    ['uniqueSeconds false', {uniqueSeconds: false}, true],
    ['uniqueSeconds undefined', {uniqueSeconds: undefined}, true],
    ['an empty object', {}, true],
    ['a text uniqueSeconds', {uniqueSeconds: 'true'}, false],
    ['a numeric uniqueSeconds', {uniqueSeconds: 1}, false],
    ['an unknown key', {uniqueSeconds: true, testHooks: {}}, false],
    ['an array', [], false],
    ['null', null, false]
  ])('checks appendSamples options strictly: %s', (_name, options, accepted) => {
    expect(parseRequest(request(options)).ok).toBe(accepted);
  });
  it.each([
    ['both counts zero', {appended: 0, skipped: 0}],
    ['a full batch', {appended: 3_600, skipped: 0}],
    ['skipped rows', {appended: 59, skipped: 1}]
  ])('accepts a sample answer with %s', async (_name, value) => {
    const f = fixture();
    const append = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true});
    f.ok(1, value);
    await expect(append).resolves.toEqual({ok: true, value});
    expect(f.client.state).toBe('running');
  });
  it.each([
    ['no skipped count', {appended: 1}],
    ['a negative skipped count', {appended: 1, skipped: -1}],
    ['a fractional appended count', {appended: 1.5, skipped: 0}],
    ['a text count', {appended: '1', skipped: 0}],
    ['an unsafe count', {appended: 2 ** 53, skipped: 0}],
    ['a count that is not finite', {appended: Number.POSITIVE_INFINITY, skipped: 0}],
    ['no value object', 1]
  ])('fails closed on a sample answer with %s', async (_name, value) => {
    const f = fixture();
    const append = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true});
    f.ok(1, value);
    await expect(append).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
});

describe('StorageClient deadlines and worker failures', () => {
  it(`times out a command after ${COMMAND_DEADLINE_MS} ms, terminates the worker and never reports a later success`, async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitEvent({message: {}}));
    await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS - 1);
    expect(code(commit.value)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(commit.value).toEqual(error('TIMEOUT'));
    expect(queued.value).toEqual(error('WORKER_FAILED'));
    expect(f.handle.terminate).toHaveBeenCalledOnce();
    expect(f.failures.map(failure => failure.code)).toEqual(['TIMEOUT']);
    // The late answer of the timed-out commit is ignored; it never becomes a commit result.
    f.ok(1, COMMITTED);
    expect(commit.value).toEqual(error('TIMEOUT'));
    await expect(f.client.commitEvent({message: {}})).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.sent).toHaveLength(1);
  });
  it(`allows open ${OPEN_DEADLINE_MS} ms for a verified backup and migration`, async () => {
    const f = fixture();
    const open = track(f.client.open(OPEN));
    await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS - 1);
    expect(code(open.value)).toBe('pending');
    f.ok(1, SUMMARY);
    await vi.advanceTimersByTimeAsync(0);
    expect(open.value).toEqual({ok: true, value: SUMMARY});
    const slow = track(f.client.open(OPEN));
    await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS);
    expect(slow.value).toEqual(error('TIMEOUT'));
  });
  it('fails the command in flight and every queued command when the worker errors, and ignores a later answer', async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitGap({message: {}}));
    f.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(queued.value).toEqual(error('WORKER_FAILED'));
    f.ok(1, COMMITTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
    expect(f.client.state).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed when the worker exits unexpectedly', async () => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    f.exit(0);
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
  });
  it.each([
    ['an answer for another request id', (f: ReturnType<typeof fixture>) => f.ok(2, COMMITTED)],
    ['a commit result with a numeric coverage', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'committed', committedThroughEventSeq: 1})],
    ['a commit result with an unknown status', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'stored', committedThroughEventSeq: '1'})],
    ['an event commit reported as covered', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'covered', committedThroughEventSeq: '1'})],
    ['an error with an unknown code', (f: ReturnType<typeof fixture>) => f.reply(1, {ok: false, error: {code: 'LOST' as StorageErrorCode, retryable: true, message: 'x'}})],
    ['a message that is not a response', (f: ReturnType<typeof fixture>) => f.raw({type: 'verified'})]
  ])('fails closed on %s', async (_name, answer) => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    answer(f);
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
  it('fails closed on an unsolicited message while nothing is in flight', () => {
    const f = fixture();
    f.ok(1, COMMITTED);
    expect(f.client.state).toBe('failed');
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
  });
});

describe('StorageClient close', () => {
  it('finishes the command in flight, refuses queued and new commands, then closes and waits for the thread to end', async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitEvent({message: {}}));
    const closed = track(f.client.close());
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.value).toEqual(error('STORAGE_CLOSED'));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('STORAGE_CLOSED'));
    expect(f.sent.map(request => request.command.name)).toEqual(['commitEvent']);
    f.ok(1, COMMITTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual({ok: true, value: COMMITTED});
    expect(f.sent.map(request => [request.id, request.command.name])).toEqual([[1, 'commitEvent'], [2, 'close']]);
    f.ok(2, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toBeUndefined();
    f.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toEqual({clean: true});
    expect(f.client.state).toBe('closed');
    expect(f.handle.terminate).not.toHaveBeenCalled();
    expect(f.failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.client.close()).toBe(f.client.close());
  });
  it('terminates the worker after the close grace; the command in flight never succeeds', async () => {
    const f = fixture({closeGraceMs: 800});
    const commit = track(f.client.commitEvent({message: {}}));
    const closed = track(f.client.close());
    await vi.advanceTimersByTimeAsync(799);
    expect(closed.value).toBeUndefined();
    // Requirement change (October 18, 2026): the verdict runs one event-loop turn after the grace (an immediate), which
    // the fake clock schedules 1 ms later. Until then nothing is terminated.
    await vi.advanceTimersByTimeAsync(1);
    expect(closed.value).toBeUndefined();
    expect(f.handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(closed.value).toEqual({clean: false});
    expect(f.handle.terminate).toHaveBeenCalledOnce();
    f.ok(1, COMMITTED);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('overrides closeGraceMs when explicit graceMs is passed to close()', async () => {
    const f = fixture({closeGraceMs: 800});
    const commit = track(f.client.commitEvent({message: {}}));
    const closed = track(f.client.close(1500));
    await vi.advanceTimersByTimeAsync(802);
    expect(closed.value).toBeUndefined();
    expect(f.handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500 - 802 - 1);
    expect(closed.value).toBeUndefined();
    expect(f.handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(closed.value).toEqual({clean: false});
    expect(f.handle.terminate).toHaveBeenCalledOnce();
  });
  it('allows a slow close to finish cleanly when graceMs is extended', async () => {
    const f = fixture({closeGraceMs: 800});
    const closed = track(f.client.close(1500));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent.map(r => r.command.name)).toEqual(['close']);
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.handle.terminate).not.toHaveBeenCalled();
    expect(closed.value).toBeUndefined();
    f.ok(1, undefined);
    f.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toEqual({clean: true});
    expect(f.handle.terminate).not.toHaveBeenCalled();
    expect(f.client.state).toBe('closed');
  });
  it('bounds close of a failed client by explicit graceMs when terminate hangs', async () => {
    const f = fixture({closeGraceMs: 800});
    f.handle.terminate = vi.fn(() => new Promise(() => undefined));
    f.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.state).toBe('failed');
    const closed = track(f.client.close(1200));
    await vi.advanceTimersByTimeAsync(1199);
    expect(closed.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed.value).toEqual({clean: false});
  });
  // Regression (packaged recording smoke, October 18, 2026): `history-storage` failed at 807 ms against the 800 ms grace
  // while the service process used almost no CPU. A stalled service thread runs the due grace timer before the close
  // answer and exit that arrived meanwhile; the verdict now waits one loop turn, so they still count.
  it('counts a close answer and exit that arrived while the grace timer was already due', async () => {
    const f = fixture({closeGraceMs: 800});
    const started = Date.now();
    const closed = track(f.client.close());
    expect(f.sent.map(request => [request.id, request.command.name])).toEqual([[1, 'close']]);
    // Only the grace timer runs, as after a stall; the answer and exit are delivered before the verdict.
    vi.advanceTimersToNextTimer();
    expect(Date.now() - started).toBe(800);
    expect(closed.value).toBeUndefined();
    f.ok(1, undefined);
    f.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toEqual({clean: true});
    expect(f.client.state).toBe('closed');
    expect(f.handle.terminate).not.toHaveBeenCalled();
    expect(f.failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('after the grace, terminates a worker that acknowledged the close but whose thread did not end, and stays clean', async () => {
    const f = fixture({closeGraceMs: 800});
    const closed = track(f.client.close());
    f.ok(1, undefined);
    await vi.advanceTimersByTimeAsync(800);
    expect(closed.value).toBeUndefined();
    expect(f.handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The database was closed when the worker answered; ending the thread loses nothing.
    expect(f.handle.terminate).toHaveBeenCalledOnce();
    expect(closed.value).toEqual({clean: true});
    expect(f.client.state).toBe('closed');
    expect(f.failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('is not clean when the worker exits before acknowledging the close or refuses it', async () => {
    const early = fixture();
    const first = track(early.client.close());
    early.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value).toEqual({clean: false});
    const refused = fixture();
    const second = track(refused.client.close());
    refused.reply(1, error('IO_ERROR') as Result<unknown>);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value).toEqual({clean: false});
    expect(refused.handle.terminate).toHaveBeenCalledOnce();
  });
  // Requirement change (PR #60 review): an earlier failure means the database was not closed in order, so the close of
  // a failed client is never clean, after a worker error and after a missed deadline alike.
  it('after a worker failure, close waits for the terminated thread and reports an unclean close', async () => {
    const f = fixture();
    f.error();
    await expect(f.client.close()).resolves.toEqual({clean: false});
    await expect(f.client.commitEvent({message: {}})).resolves.toEqual(error('STORAGE_CLOSED'));
  });
  it('after a missed deadline, close reports an unclean close', async () => {
    const f = fixture();
    void f.client.commitEvent({message: {}});
    await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS);
    expect(f.client.state).toBe('failed');
    await expect(f.client.close()).resolves.toEqual({clean: false});
  });
});

/**
 * ET-016 PR-2: the journal commands at the worker boundary. Requests are copied field by field and checked strictly;
 * every answer is validated against the journal contract, and a malformed one fails the client closed like a
 * malformed commit result. The valid answers below are written by hand in the documented shapes.
 */
describe('ET-016 journal reads at the worker boundary', () => {
  const TRIP = '7a000000-0000-4000-8000-000000000001';
  const NO = {available: false, reason: 'not-observed'} as const;
  const DATABASE = {purpose: 'synthetic', schemaVersion: 2};
  const LIST_ITEM = {isHardMode: false, hardModeDetails: null, tripUuid: TRIP, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', closeReason: null,
    recordingCompleteness: 'unknown', startedUtcMs: 1_791_676_800_000, endedUtcMs: null, observedDistanceM: {available: true, value: 0}, fuelUsedL: NO,
    job: {source: 'event', sourceCity: {available: true, value: ''}, sourceCompany: NO, destinationCity: NO, destinationCompany: NO, cargo: NO,
      plannedDistance: {available: true, value: 0, unit: 'm'}, expectedIncome: {available: true, value: {raw: '18446744073709551615', sdkType: 'u64', currency: {status: 'unknown'}}}}};
  const INTERVAL = {id: '1', kind: 'discontinuity', annotation: true, cause: 'truck-change', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null,
    sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: {cause: 'truck-change', annotation: true, atEventSeq: '2'}};
  const WINDOW = {known: true, pluginSessionId: P1, fromEventSeq: '1', throughEventSeq: null, end: 'open'};
  const configured = JSON.parse(readFileSync(path.resolve('tests/fixtures/protocol-v1/event-job-configured.json'), 'utf8')) as {data: {occurred: unknown; record: unknown}};
  const EVENT = {eventSeq: '1', type: 'job.configured', occurred: configured.data.occurred, record: configured.data.record, attribution: null};
  const PAGE = {database: DATABASE, trips: [LIST_ITEM], nextCursor: null};
  const EVENTS = {database: DATABASE, window: WINDOW, events: [EVENT, {...EVENT, eventSeq: '2', attribution: {kind: 'ambiguous', tripUuid: null}}], nextCursor: null};
  const INTERVALS = {database: DATABASE, intervals: [INTERVAL], total: 1, nextCursor: null};
  const DETAIL = {database: DATABASE, trip: {...LIST_ITEM, pluginSessionId: P1, openedBy: 'event', openedEventSeq: '1', outcomeEventSeq: null, closedBy: null},
    job: {source: 'event', eventSeq: '1', checkpointNextEventSeq: null, values: job()}, truck: {eventSeq: '2', values: truck()}, trailers: {items: [{eventSeq: '3', values: trailer(0)}], total: 1},
    outcomeDetails: null,
    money: {incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: {status: 'unknown'}, raw: '-18446744073709551616', count: 2}],
      unavailable: [{category: 'toll', reason: 'invalid', count: 1}]},
    window: WINDOW, intervals: {items: [INTERVAL], total: 1, nextCursor: null}, samples: {count: 0, firstUtcMs: null, lastUtcMs: null},
    exportBounds: {committedThroughEventSeq: '3', lastSampleId: null, lastIntervalId: '1'}};
  type Call = (client: StorageClient) => Promise<JournalResult<unknown>>;
  const CALLS: Record<'trips' | 'trip' | 'events' | 'intervals', Call> = {
    trips: client => client.journalTrips(), trip: client => client.journalTrip(TRIP),
    events: client => client.journalEvents(TRIP, {limit: 100}), intervals: client => client.journalIntervals(TRIP, {limit: 100})
  };
  const VALID = {trips: PAGE, trip: DETAIL, events: EVENTS, intervals: INTERVALS};
  const changed = <T>(value: T, change: (copy: T) => void): T => { const copy = structuredClone(value); change(copy); return copy; };
  const request = (command: Record<string, unknown>) => ({type: 'storage.request', id: 1, command});

  it('copies only the listed query and page fields, and sends no query when none is given', () => {
    const f = fixture();
    void f.client.journalTrips({cursor: '5', game: 'ats', outcome: 'open', completeness: 'partial', limit: 51} as Parameters<StorageClient['journalTrips']>[0]);
    expect(f.sent[0].command).toEqual({name: 'journalTrips', query: {cursor: '5', game: 'ats', outcome: 'open', completeness: 'partial'}});
    f.ok(1, PAGE);
    void f.client.journalTrips();
    expect(f.sent[1].command).toEqual({name: 'journalTrips'});
    expect(Object.hasOwn(f.sent[1].command, 'query')).toBe(false);
    f.ok(2, PAGE);
    void f.client.journalEvents(TRIP, {limit: 500, cursor: '9', testHooks: {}} as Parameters<StorageClient['journalEvents']>[1]);
    expect(f.sent[2].command).toEqual({name: 'journalEvents', tripUuid: TRIP, page: {limit: 500, cursor: '9'}});
    f.ok(3, EVENTS);
    void f.client.journalIntervals(TRIP, {limit: 100, after: '1'} as Parameters<StorageClient['journalIntervals']>[1]);
    expect(f.sent[3].command).toEqual({name: 'journalIntervals', tripUuid: TRIP, page: {limit: 100, cursor: undefined}});
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  it('forwards a page that is not an object as given, so the worker parser refuses it', () => {
    const f = fixture();
    expect(() => f.client.journalEvents(TRIP, null as unknown as {limit: number})).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'journalEvents', tripUuid: TRIP, page: null});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
  });
  it.each([
    ['journalTrips without a query', {name: 'journalTrips'}, true],
    ['journalTrips with every filter', {name: 'journalTrips', query: {cursor: '9223372036854775807', game: 'ets2', outcome: 'none', completeness: 'complete'}}, true],
    ['journalTrips with undefined fields', {name: 'journalTrips', query: {cursor: undefined, game: undefined}}, true],
    ['journalTrips with a page size', {name: 'journalTrips', query: {limit: 50}}, false],
    ['journalTrips with cursor 0', {name: 'journalTrips', query: {cursor: '0'}}, false],
    ['journalTrips with a cursor beyond 2^63 - 1', {name: 'journalTrips', query: {cursor: '9223372036854775808'}}, false],
    ['journalTrips with an unknown completeness', {name: 'journalTrips', query: {completeness: 'full'}}, false],
    ['journalTrips with an extra field', {name: 'journalTrips', query: {}, testHooks: {}}, false],
    ['journalTrip', {name: 'journalTrip', tripUuid: TRIP}, true],
    ['journalTrip with an upper-case id', {name: 'journalTrip', tripUuid: TRIP.toUpperCase()}, false],
    ['journalEvents of 100', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 100}}, true],
    ['journalEvents of 500 after the last eventSeq', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 500, cursor: '18446744073709551614'}}, true],
    ['journalEvents of 51', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 51}}, false],
    ['journalEvents of 300', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 300}}, false],
    ['journalEvents beyond the last eventSeq', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 100, cursor: '18446744073709551615'}}, false],
    ['journalEvents without a page', {name: 'journalEvents', tripUuid: TRIP}, false],
    ['journalIntervals of 500', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: 500, cursor: '1'}}, true],
    ['journalIntervals of 3,600', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: 3_600}}, false],
    ['journalIntervals with a text limit', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: '100'}}, false]
  ])('checks %s strictly', (_name, command, accepted) => {
    expect(parseRequest(request(command)).ok).toBe(accepted);
  });
  it.each(Object.keys(CALLS) as (keyof typeof CALLS)[])('accepts a well-formed %s answer', async name => {
    const f = fixture();
    const read = CALLS[name](f.client);
    f.ok(1, VALID[name]);
    await expect(read).resolves.toEqual({ok: true, value: VALID[name]});
    expect(f.client.state).toBe('running');
  });
  it('accepts a detail with the latest ten of twelve trailer configurations', async () => {
    const f = fixture();
    const detail = changed(DETAIL, p => { p.trailers = {items: Array(10).fill(p.trailers.items[0]) as typeof p.trailers.items, total: 12}; });
    const read = f.client.journalTrip(TRIP);
    f.ok(1, detail);
    await expect(read).resolves.toEqual({ok: true, value: detail});
  });
  const COMMANDS = {trips: 'journalTrips', trip: 'journalTrip', events: 'journalEvents', intervals: 'journalIntervals'} as const;
  it.each<[string, keyof typeof CALLS, unknown]>([
    ['51 trips on a page', 'trips', changed(PAGE, p => { p.trips = Array<typeof LIST_ITEM>(51).fill(LIST_ITEM); })],
    ['an unknown database purpose', 'trips', changed(PAGE, p => { p.database.purpose = 'game'; })],
    ['a cursor of 0', 'trips', changed(PAGE, p => { (p as {nextCursor: unknown}).nextCursor = '0'; })],
    ['an available distance without a value', 'trips', changed(PAGE, p => { (p.trips[0] as {observedDistanceM: unknown}).observedDistanceM = {available: true}; })],
    ['a negative distance', 'trips', changed(PAGE, p => { p.trips[0].observedDistanceM = {available: true, value: -1}; })],
    ['an unknown availability reason', 'trips', changed(PAGE, p => { (p.trips[0] as {fuelUsedL: unknown}).fuelUsedL = {available: false, reason: 'zero'}; })],
    ['money as a number', 'trips', changed(PAGE, p => { (p.trips[0].job as {expectedIncome: unknown}).expectedIncome = {available: true, value: {raw: 5, sdkType: 'u64', currency: {status: 'unknown'}}}; })],
    ['an open trip with a close reason', 'trips', changed(PAGE, p => { (p.trips[0] as {closeReason: unknown}).closeReason = 'gap'; })],
    ['an extra field', 'trips', changed(PAGE, p => { (p.trips[0] as Record<string, unknown>).processId = 4242; })],
    ['an interval flag that disagrees with its detail', 'intervals', changed(INTERVALS, p => { p.intervals[0].annotation = false; })],
    ['an interval total below its page', 'trip', changed(DETAIL, p => { p.intervals.total = 0; })],
    ['an event whose type differs from its record', 'events', changed(EVENTS, p => { p.events[0].type = 'job.cleared'; })],
    ['an event occurrence with an invalid clock', 'events', changed(EVENTS, p => { (p.events[0].occurred as {gameTime: {clockId: string}}).gameTime.clockId = 'clock'; })],
    ['a free-driving event with a trip', 'events', changed(EVENTS, p => { (p.events[1] as {attribution: unknown}).attribution = {kind: 'free-driving', tripUuid: TRIP}; })],
    ['501 events', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(501).fill(EVENT); })],
    ['an open window with an end', 'events', changed(EVENTS, p => { (p.window as {throughEventSeq: unknown}).throughEventSeq = '9'; })],
    ['a window of another session', 'trip', changed(DETAIL, p => { p.window = {...WINDOW, pluginSessionId: '10000000-0000-4000-8000-000000000002'}; })],
    ['job values outside the protocol', 'trip', changed(DETAIL, p => { (p.job.values as unknown as {plannedDistance: unknown}).plannedDistance = {available: true, value: 1_500, unit: 'm'}; })],
    ['incomplete money with totals', 'trip', changed(DETAIL, p => { p.money.incomplete = true; })],
    ['a money total that is not an integer', 'trip', changed(DETAIL, p => { p.money.totals[0].raw = '1.5'; })],
    ['a sample label without samples', 'trip', changed(DETAIL, p => { (p.samples as {firstUtcMs: unknown}).firstUtcMs = 1; })],
    ['export bounds that disagree with the intervals', 'trip', changed(DETAIL, p => { (p.exportBounds as {lastIntervalId: unknown}).lastIntervalId = null; })],
    ['an event-opened trip without its opening event', 'trip', changed(DETAIL, p => { (p.trip as {openedEventSeq: unknown}).openedEventSeq = null; })],
    ['a checkpoint-opened trip with an opening event', 'trip', changed(DETAIL, p => { p.trip.openedBy = 'checkpoint'; })],
    ['a missing value', 'trip', undefined],
    // Review pass 1: lists bounded like the storage reads, and pages tied to the requested limit.
    ['eleven trailer configurations', 'trip', changed(DETAIL, p => { p.trailers = {items: Array(11).fill(p.trailers.items[0]) as typeof p.trailers.items, total: 11}; })],
    ['fewer trailer configurations than the total allows', 'trip', changed(DETAIL, p => { p.trailers.total = 5; })],
    ['101 events for a page of 100', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(101).fill(EVENT); })],
    ['a full page of 100 events without a cursor', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(100).fill(EVENT); })],
    ['a cursor on a short page', 'trips', changed(PAGE, p => { (p as {nextCursor: unknown}).nextCursor = '5'; })],
    ['101 intervals for a page of 100', 'intervals', changed(INTERVALS, p => { p.intervals = Array<typeof INTERVAL>(101).fill(INTERVAL); p.total = 101; })]
  ])('refuses a journal answer with %s for that read alone, and the client keeps serving (review pass 1)', async (_name, name, value) => {
    const refusals: unknown[] = [];
    const f = fixture({onJournalAnswerInvalid: facts => refusals.push(facts)});
    const read = CALLS[name](f.client);
    f.ok(1, value);
    await expect(read).resolves.toEqual({ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false,
      message: 'The storage worker returned a journal page that does not match the journal contract.'}});
    expect(refusals).toEqual([{command: COMMANDS[name]}]);
    expect(f.client.state).toBe('running');
    expect(f.failures).toEqual([]);
    expect(f.handle.terminate).not.toHaveBeenCalled();
    // The recorder's next command is sent and answered as usual.
    const next = f.client.commitEvent({message: {}});
    expect(f.sent.map(sent => sent.command.name)).toEqual([COMMANDS[name], 'commitEvent']);
    f.ok(2, COMMITTED);
    await expect(next).resolves.toEqual({ok: true, value: COMMITTED});
  });
  it('resolves the read and sends the next command even when the report callback throws (review pass 2)', async () => {
    const f = fixture({onJournalAnswerInvalid: () => { throw new Error('the log sink is closing'); }});
    const read = f.client.journalTrips();
    const next = f.client.commitEvent({message: {}});
    // The worker answers the journal read with a page that breaks the contract; the throw must not escape the listener.
    expect(() => f.ok(1, changed(PAGE, p => { p.database.purpose = 'game'; }))).not.toThrow();
    await expect(read).resolves.toEqual({ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false,
      message: 'The storage worker returned a journal page that does not match the journal contract.'}});
    expect(f.sent.map(sent => sent.command.name)).toEqual(['journalTrips', 'commitEvent']);
    f.ok(2, COMMITTED);
    await expect(next).resolves.toEqual({ok: true, value: COMMITTED});
    expect(f.client.state).toBe('running');
  });
  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['a success without a value', f => f.raw({type: 'storage.response', id: 1, result: {ok: true}})],
    ['an error with an unknown code', f => f.reply(1, {ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false, message: 'x'}} as unknown as Result<unknown>)],
    ['an answer for another id', f => f.ok(2, PAGE)],
    ['a frame of another type', f => f.raw({type: 'storage.request', id: 1, result: {ok: true, value: PAGE}})]
  ])('still fails the client closed on a malformed journal frame: %s', async (_name, answer) => {
    const f = fixture();
    const read = f.client.journalTrips();
    answer(f);
    await expect(read).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
  it('still fails the client closed on an invalid answer to a recorder command', async () => {
    const f = fixture({onJournalAnswerInvalid: () => { throw new Error('not a journal command'); }});
    const commit = f.client.commitEvent({message: {}});
    f.ok(1, {status: 'committed', committedThroughEventSeq: '01'});
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
});

describe('StorageClient openAttachedTrip (ET-016 PR-7, J9)', () => {
  const INPUT = {pluginSessionId: P1, nextEventSeq: '3', job: job(), effects: []};
  const attachRequest = (input: unknown): StorageRequest => ({type: 'storage.request', id: 1, command: {name: 'openAttachedTrip', input} as StorageRequest['command']});
  it('copies only the four input fields, which the worker parser accepts', () => {
    const f = fixture();
    void f.client.openAttachedTrip({...INPUT, testHooks: {}} as Parameters<StorageClient['openAttachedTrip']>[0]);
    expect(f.sent[0].command).toEqual({name: 'openAttachedTrip', input: INPUT});
    expect(parseRequest(f.sent[0]).ok).toBe(true);
  });
  it.each([
    ['an unknown input key', {...INPUT, extra: 1}, false],
    ['no input', undefined, false],
    ['an array input', [], false],
    ['the four fields', INPUT, true]
  ])('checks the input strictly at the worker boundary: %s', (_name, input, accepted) => {
    expect(parseRequest(attachRequest(input)).ok).toBe(accepted);
  });
  it.each([['committed', {status: 'committed'}], ['duplicate', {status: 'duplicate'}]])('accepts a %s answer', async (_name, value) => {
    const f = fixture();
    const attach = f.client.openAttachedTrip(INPUT);
    f.ok(1, value);
    await expect(attach).resolves.toEqual({ok: true, value});
  });
  it.each([['another status', {status: 'covered'}], ['an extra key', {status: 'committed', committedThroughEventSeq: '3'}], ['no object', 'committed']])(
    'fails closed on an attach answer with %s', async (_name, value) => {
      const f = fixture();
      const attach = f.client.openAttachedTrip(INPUT);
      f.ok(1, value);
      await expect(attach).resolves.toEqual(error('WORKER_FAILED'));
      expect(f.client.state).toBe('failed');
    });
});

it('strictly validates private Hard Mode freshness verdicts on observer and event requests', () => {
  const observation = {assessment: unknownHardMode(1), binding: null, pluginSessionId: null, sourceMonotonicNs: null};
  const request = (command: unknown) => ({type: 'storage.request', id: 1, command});
  for (const fresh of [true, false]) expect(parseRequest(request({name: 'observeHardMode', game: 'ets2', observation, fresh})).ok).toBe(true);
  for (const fresh of [undefined, null, 1, 'true', {}]) {
    expect(parseRequest(request({name: 'observeHardMode', game: 'ets2', observation, fresh})).ok).toBe(false);
    if (fresh !== undefined) expect(parseRequest(request({name: 'commitEvent', input: {message: {}, hardMode: observation, hardModeFresh: fresh}})).ok).toBe(false);
  }
});

describe('REG-007/010/011/012 private upload synchronization boundary',()=>{
  const command={name:'claimUploadAttempt' as const,input:{attemptId:P1,registrationId:P1,expectedVersion:'1',mode:'live' as const,nowMs:0}};
  it('validates exact owner/CAS/class fields and bounded typed receipt bytes without accepting secrets or hooks',()=>{
    expect(isUploadSyncRequest(command)).toBe(true);
    for(const bad of [{...command,input:{...command.input,mode:'fair'}},{...command,input:{...command.input,expectedVersion:'01'}},{...command,input:{...command.input,registrationId:'other'}},{...command,input:{...command.input,nowMs:Infinity}},{...command,input:{...command.input,token:'private'}},{...command,testHooks:{}}]){
      expect(isUploadSyncRequest(bad)).toBe(false);expect(parseRequest({type:'storage.request',id:1,command:bad})).toEqual({ok:false,id:1});
    }
    expect(isUploadSyncRequest({name:'commitUploadReceipt',input:{attemptId:P1,statusCode:202,body:new Uint8Array(4096)}})).toBe(true);
    expect(isUploadSyncRequest({name:'commitUploadReceipt',input:{attemptId:P1,statusCode:202,body:new Uint8Array(4097)}})).toBe(false);
    expect(isUploadSyncRequest({name:'reclaimUploadPayloads',input:{limit:101}})).toBe(false);
    expect(isUploadSyncRequest({name:'recordUploadRegistration',input:{registrationId:P1,clientInstallationId:P1,origin:'https://dashboard.example/path',accountId:'A',companyId:'C',identityEpoch:'e',installationId:P1,bindingId:P1}})).toBe(false);
  });
  it('refuses malformed success identity, missing payload, extra fields and impossible bounded counters',()=>{
    const claimed={status:'claimed',attemptId:P1,eventId:P1,registrationId:P1,registration:{registrationId:P1,clientInstallationId:P1,origin:'https://dashboard.example',accountId:'A',companyId:'C',identityEpoch:'e',installationId:P1,bindingId:P1},payload:new Uint8Array([1])};expect(isUploadSyncResult(command,claimed)).toBe(true);
    for(const bad of [{...claimed,payload:null},{...claimed,attemptId:'80000000-0000-4000-8000-000000000001'},{...claimed,eventId:null},{...claimed,extra:1},{...claimed,status:'empty'}])expect(isUploadSyncResult(command,bad)).toBe(false);
    expect(isUploadSyncResult({name:'reclaimUploadPayloads',input:{limit:1}},{examined:1,reclaimed:2,events:0,bytes:0})).toBe(false);
    expect(isUploadSyncResult({name:'ensureUploadInstallation'},{status:'ready',clientInstallationId:null})).toBe(false);
  });
  it('applies combined-cap admission and recorder priority to new ownership/queue work',async()=>{
    const f=fixture({maxQueued:2}),opening=f.client.open(OPEN),old=f.client.ensureUploadInstallation(),newest=f.client.claimUploadAttempt(command.input),recorder=f.client.commitEvent({message:{}});
    await expect(newest).resolves.toEqual(error('STORAGE_BUSY'));f.ok(1,SUMMARY);await opening;expect(f.sent[1].command.name).toBe('commitEvent');f.ok(2,COMMITTED);await recorder;
    expect(f.sent[2].command.name).toBe('ensureUploadInstallation');f.ok(3,{status:'ready',clientInstallationId:P1});await old;
    const claim=f.client.claimUploadAttempt({...command.input,mode:'backfill'});expect(f.sent[3].command).toEqual({...command,input:{...command.input,mode:'backfill'}});
    f.ok(4,{status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null});await claim;
  });
  it('keeps new background deadlines and close behavior within existing budgets',async()=>{
    const f=fixture({commandDeadlineMs:50}),opening=f.client.open(OPEN);f.ok(1,SUMMARY);await opening;
    const pending=f.client.advanceUploadMaterialization({workId:P1});await vi.advanceTimersByTimeAsync(50);await expect(pending).resolves.toEqual(error('TIMEOUT'));
    const g=fixture(),opened=g.client.open(OPEN);g.ok(1,SUMMARY);await opened;const queued=g.client.getUploadStoreStatus({registrationId:P1}),closing=g.client.close();
    g.ok(2,{registrationId:P1,version:'0',active:false,paused:null,discoveryAfter:'0',identityPendingSources:0,pendingSources:0,heldSources:0,queuedEvents:0,queuedBytes:0,deliveredEvents:0,pressure:false});await queued;expect(g.sent[2].command.name).toBe('close');g.ok(3,undefined);g.exit(0);await expect(closing).resolves.toEqual({clean:true});
  });
});

it('REG-007/010/012 validates explicit startup recovery as an exclusive private input and never treats ordinary busy as recovery',async()=>{
  const command={name:'recoverUploadAttempt' as const,input:{startup:true as const}};expect(isUploadSyncRequest(command)).toBe(true);
  const invalid=fixture();for(const input of [{startup:false},{startup:true,attemptId:P1},{startup:true,registrationId:P1},{}, {startup:'true'}]){expect(isUploadSyncRequest({...command,input})).toBe(false);await expect(invalid.client.recoverUploadAttempt(input as never)).resolves.toEqual(error('INVALID_INPUT'));}expect(invalid.sent).toEqual([]);
  const recovered={status:'recovered',attemptId:P1,eventId:P1,registrationId:P1,registration:null,payload:null},empty={status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null};
  expect(isUploadSyncResult(command,recovered)).toBe(true);expect(isUploadSyncResult(command,empty)).toBe(true);
  for(const bad of [{...recovered,attemptId:null},{...recovered,payload:new Uint8Array([1])},{...empty,eventId:P1},{...recovered,status:'busy'}])expect(isUploadSyncResult(command,bad)).toBe(false);
  expect(isUploadSyncResult({name:'recoverUploadAttempt',input:{attemptId:P1}},empty)).toBe(false);
  const f=fixture(),opening=f.client.open(OPEN),recovery=f.client.recoverUploadAttempt({startup:true}),recorder=f.client.commitEvent({message:{}});f.ok(1,SUMMARY);await opening;expect(f.sent[1].command.name).toBe('commitEvent');f.ok(2,COMMITTED);await recorder;expect(f.sent[2].command).toEqual(command);f.ok(3,empty);await expect(recovery).resolves.toEqual({ok:true,value:empty});
});

it('REG-005/010/011/012 strictly accepts command-specific stale outcomes and claim replay without payload or authority',async()=>{
  const input={attemptId:P1,kind:'authentication' as const,retryAtMs:9000,nowMs:1000},command={name:'recordUploadAttemptOutcome' as const,input},stale={status:'stale',attemptId:P1,eventId:P1,registrationId:P1,payload:null,registration:null};expect(isUploadSyncResult(command,stale)).toBe(true);
  for(const value of [{...stale,attemptId:'80000000-0000-4000-8000-000000000001'},{...stale,eventId:null},{...stale,payload:new Uint8Array([1])},...['claimed','recovered','empty','busy'].map(status=>({...stale,status}))])expect(isUploadSyncResult(command,value)).toBe(false);
  const claim={name:'claimUploadAttempt' as const,input:{attemptId:P1,registrationId:P1,expectedVersion:'2',mode:'any' as const,nowMs:1000}};expect(isUploadSyncResult(claim,stale)).toBe(true);
  for(const value of [{...stale,registrationId:'80000000-0000-4000-8000-000000000001'},{...stale,attemptId:null},{...stale,payload:new Uint8Array([1])},{...stale,status:'recovered'}])expect(isUploadSyncResult(claim,value)).toBe(false);
  const f=fixture(),opening=f.client.open(OPEN);f.ok(1,SUMMARY);await opening;const outcome=f.client.recordUploadAttemptOutcome(input);f.ok(2,stale);await expect(outcome).resolves.toEqual({ok:true,value:stale});const replay=f.client.claimUploadAttempt(claim.input);f.ok(3,stale);await expect(replay).resolves.toEqual({ok:true,value:stale});expect(f.failures).toEqual([]);
});
it('REG-005/010/012 closes retained-inventory and phase-specific progress inputs/results',()=>{
  const command={name:'readRetainedUploadMaterializations' as const,input:{}},good={examined:1,unmanagedPins:0,items:[{workId:P1,registrationId:P1,state:'preparing'}]};expect(isUploadSyncRequest(command)).toBe(true);expect(isUploadSyncRequest({...command,input:{registrationId:P1}})).toBe(false);expect(isUploadSyncResult(command,good)).toBe(true);
  for(const bad of [{...good,examined:9},{...good,unmanagedPins:1},{...good,items:[...good.items,...good.items]},{...good,items:[{...good.items[0],state:'released'}]},{...good,items:[{...good.items[0],workId:'bad'}]},{...good,secret:'x'}])expect(isUploadSyncResult(command,bad)).toBe(false);
  const sources={name:'pageUploadSources' as const,input:{registrationId:P1,phase:'sources' as const,after:'2',limit:1}},page={phase:'sources',after:'2',next:'3',examined:1,sources:[],receipts:[]};expect(isUploadSyncResult(sources,page)).toBe(true);
  for(const bad of [{...page,next:`r:0:${P1}`},{...page,next:'2'},{...page,examined:0},{...page,next:null},{...page,receipts:[{eventId:P1,firstReceivedUtcMs:1}]}])expect(isUploadSyncResult(sources,bad)).toBe(false);
  const receipts={name:'pageUploadSources' as const,input:{registrationId:P1,phase:'receipts' as const,after:`r:2:${P1}`,limit:1}};expect(isUploadSyncResult(receipts,{phase:'receipts',after:receipts.input.after,next:`r:3:${P1}`,examined:1,sources:[],receipts:[{eventId:P1,firstReceivedUtcMs:1}]})).toBe(true);expect(isUploadSyncRequest({...receipts,input:{...receipts.input,after:'2'}})).toBe(false);
});
it('REG-005/010/012 rejects original extra read inputs before cloning or dispatch',async()=>{
  const f=fixture();await expect(f.client.readRetainedUploadMaterializations({registrationId:P1})).resolves.toEqual(error('INVALID_INPUT'));await expect(f.client.getUploadConfiguration('secret')).resolves.toEqual(error('INVALID_INPUT'));
  for(const input of [null,{registrationId:P1,after:null,limit:101},{registrationId:P1,after:null,limit:1,extra:true}])await expect(f.client.pageUploadScanRuns(input as never)).resolves.toEqual(error('INVALID_INPUT'));
  await expect(f.client.pageUploadSources({registrationId:P1,phase:'sources',after:null,limit:1,secret:'x'} as never)).resolves.toEqual(error('INVALID_INPUT'));await expect(f.client.getUploadSchedulingHints({registrationId:P1,extra:true} as never)).resolves.toEqual(error('INVALID_INPUT'));expect(f.sent).toEqual([]);
});
it('REG-005/010/011/012 strictly validates bounded authoritative scheduling diagnostics',()=>{
  const command={name:'getUploadSchedulingHints' as const,input:{registrationId:P1}},value={status:'ready',registrationId:P1,version:'1',credentialGeneration:P1,retryAtMs:300000,failureStreak:1,paused:null,held:'validation'};
  expect(isUploadSyncResult(command,value)).toBe(true);for(const bad of [{...value,status:'missing'},{...value,paused:'arbitrary'},{...value,held:'unknown'},{...value,failureStreak:10},{...value,retryAtMs:-1},{...value,registrationId:'80000000-0000-4000-8000-000000000001'},{...value,rawError:'private'}])expect(isUploadSyncResult(command,bad)).toBe(false);
});
