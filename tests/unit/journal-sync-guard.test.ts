import {expect, it, vi} from 'vitest';
import type {JournalTripPage} from '../../packages/contracts/src/journal';
import type {JournalCallResult} from '../../packages/contracts/src';
import {guardJournalSync, readJournalWithSync, type JournalUploadScope} from '../../apps/desktop/src/dashboard-upload/journal-sync-guard';
const owner = {origin: 'https://dashboard.example', accountId: 'a', companyId: 'c', identityEpoch: 'e'};
const scope: JournalUploadScope = {owner, connectionVersion: '2', documentEpoch: 1, utilityGeneration: 'g'};
const page: JournalTripPage = {database: {purpose: 'history', schemaVersion: 6}, trips: [], nextCursor: null, sync: {owner, connectionVersion: '2', rows: []}};
it('REG-010/012/014 removes metadata across origin, owner, version, document and utility fences without losing Journal data', () => {
  expect(guardJournalSync(page, scope, structuredClone(scope))).toEqual(page);
  for (const after of [undefined, {...scope, owner: {...owner, origin: 'https://other.example'}}, {...scope, owner: {...owner, accountId: 'b'}}, {...scope, owner: {...owner, identityEpoch: 'new'}}, {...scope, connectionVersion: '3'}, {...scope, documentEpoch: 2}, {...scope, utilityGeneration: 'retired'}]) {
    expect(guardJournalSync(page, scope, after)).toEqual({database: page.database, trips: [], nextCursor: null});
  }
  expect(guardJournalSync(page, undefined, scope).sync).toBeUndefined();
});
it('REG-010/014 keeps the first-page totals when it removes the sync facts (ET-076)', () => {
  const withTotals: JournalTripPage = {...page, totals: {trips: 12, recordedSeconds: 3_600}};
  expect(guardJournalSync(withTotals, scope, {...scope, connectionVersion: '3'})).toEqual({database: page.database, trips: [], nextCursor: null, totals: {trips: 12, recordedSeconds: 3_600}});
  expect(guardJournalSync(withTotals, scope, structuredClone(scope))).toEqual(withTotals);
});
it('REG-010/014 refuses malformed and extra sync facts before forwarding', () => {
  expect(() => guardJournalSync({...page, sync: {...page.sync!, credentialGeneration: 'secret'} as never}, scope, scope)).toThrow();
  expect(() => guardJournalSync({...page, sync: {...page.sync!, rows: [{} as never]}}, scope, scope)).toThrow();
});
it('REG-010/012/014 wires a trips request through before/after scopes around a deferred broker reply', async () => {
  let current: JournalUploadScope | undefined = scope, resolve!: (value: JournalCallResult<unknown>) => void;
  const reply = new Promise<JournalCallResult<unknown>>(done => {resolve = done;}), request = vi.fn(() => reply), readScope = vi.fn(() => current);
  const query = {kind: 'trips', query: {}} as const, pending = readJournalWithSync(query, request, readScope);
  expect(readScope).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledExactlyOnceWith(query);
  current = {...scope, connectionVersion: '3'}; resolve({ok: true, value: page});
  expect(await pending).toEqual({ok: true, value: {database: page.database, trips: [], nextCursor: null}}); expect(readScope).toHaveBeenCalledTimes(2);
  expect(await readJournalWithSync(query, () => Promise.resolve({ok: true, value: page}), () => scope)).toEqual({ok: true, value: page});
});
it('REG-010/014 forwards non-trips and refusals untouched and maps defensive validation failure to fixed FAILED', async () => {
  const query = {kind: 'trip', tripUuid: '70000000-0000-4000-8000-000000000001'} as const;
  const answer = {ok: true, value: {trip: 'opaque non-trips result'}} as const, refusal = {ok: false, code: 'DATABASE_OPENING'} as const;
  const noScope = vi.fn(() => {throw Error('PRIVATE_SCOPE');});
  expect(await readJournalWithSync(query, () => Promise.resolve(answer), noScope)).toBe(answer); expect(noScope).not.toHaveBeenCalled();
  expect(await readJournalWithSync({kind: 'trips', query: {}}, () => Promise.resolve(refusal), () => scope)).toBe(refusal);
  const malformed = {...page, sync: {...page.sync!, privateError: 'PRIVATE_DIAGNOSTIC'}};
  const result = await readJournalWithSync({kind: 'trips', query: {}}, () => Promise.resolve({ok: true, value: malformed}), () => scope);
  expect(result).toEqual({ok: false, code: 'FAILED'}); expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC');
});
