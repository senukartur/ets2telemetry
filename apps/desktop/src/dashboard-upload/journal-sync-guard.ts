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
  const {sync: _sync, ...local} = page;
  return local;
}
