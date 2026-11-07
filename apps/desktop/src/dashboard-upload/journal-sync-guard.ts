import {refusal, type JournalQuery} from '../journal-contract';
import type {JournalCallResult} from '../../../../packages/contracts/src';
import {sameDashboardOwner, type DashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
import {validateJournalTripPage, type JournalTripPage} from '../../../../packages/contracts/src/journal';

/** Private, main-only read authority; never serialized to the renderer. */
export interface JournalUploadScope {owner: DashboardOwner; connectionVersion: string; documentEpoch: number; utilityGeneration: string}
export function guardJournalSync(page: JournalTripPage, before: JournalUploadScope | undefined, after: JournalUploadScope | undefined): JournalTripPage {
  validateJournalTripPage(page);
  if (!page.sync) return page;
  if (before && after && before.documentEpoch === after.documentEpoch && before.utilityGeneration === after.utilityGeneration &&
      before.connectionVersion === after.connectionVersion && sameDashboardOwner(before.owner, after.owner) &&
      page.sync.connectionVersion === after.connectionVersion && sameDashboardOwner(page.sync.owner, after.owner)) return page;
  return {database: page.database, trips: page.trips, nextCursor: page.nextCursor};
}

/** Main's async Journal wiring. Sender and argument validation remain with the IPC handler. */
export async function readJournalWithSync(query: JournalQuery, request: (query: JournalQuery) => Promise<JournalCallResult<unknown>>, readScope: () => JournalUploadScope | undefined): Promise<JournalCallResult<unknown>> {
  if (query.kind !== 'trips') return request(query);
  const before = readScope(), result = await request(query);
  if (!result.ok) return result;
  try {return {ok: true, value: guardJournalSync(result.value as JournalTripPage, before, readScope())};}
  catch {return refusal('FAILED');}
}
