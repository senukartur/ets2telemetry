import {expect, it} from 'vitest';
import type {JournalTripPage} from '../../packages/contracts/src/journal';
import {guardJournalSync, type JournalUploadScope} from '../../apps/desktop/src/dashboard-upload/journal-sync-guard';
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
it('REG-010/014 refuses malformed and extra sync facts before forwarding', () => {
  expect(() => guardJournalSync({...page, sync: {...page.sync!, credentialGeneration: 'secret'} as never}, scope, scope)).toThrow();
  expect(() => guardJournalSync({...page, sync: {...page.sync!, rows: [{} as never]}}, scope, scope)).toThrow();
});
