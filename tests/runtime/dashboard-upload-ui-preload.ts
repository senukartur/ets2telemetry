import {contextBridge, ipcRenderer} from 'electron';
import {dashboardUploadPreload} from '../../apps/desktop/src/dashboard-upload/contract';
import {validateJournalTripPage} from '../../packages/contracts/src/journal';

contextBridge.exposeInMainWorld('uploadUi', {
  ...dashboardUploadPreload(ipcRenderer),
  async listJournalTrips(...args: unknown[]) {
    if (args.length !== 1 || JSON.stringify(args[0]) !== '{}') throw Error('INVALID_FIXTURE_JOURNAL');
    const result: unknown = await ipcRenderer.invoke('journal:list-trips', {});
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('value' in result)) throw Error('INVALID_FIXTURE_REPLY');
    return {ok: true, value: validateJournalTripPage(result.value)};
  }
});
