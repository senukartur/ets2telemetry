import {describe,it,expect} from 'vitest';
import {dataPaths} from '../../apps/desktop/src/paths';
import {processEntrypoint} from '../../apps/desktop/src/entrypoints';
describe('Scaffold boundaries',() => {
  it('keeps production data independent from installation identity',() => {
    expect(dataPaths('C:\\isolated').database).toBe('C:\\isolated\\ETS2Telemetry\\data\\telemetry.sqlite');
    // Synthetic and replay databases live apart from history (OD-10).
    expect(dataPaths('C:\\isolated').synthetic).toBe('C:\\isolated\\ETS2Telemetry\\synthetic');
    expect(() => dataPaths('relative')).toThrow();
  });
  it('uses physical unpacked entrypoints for packaged child processes',() => {
    expect(processEntrypoint('C:\\installed\\resources\\app.asar\\apps\\desktop\\dist','telemetry-service')).toBe('C:\\installed\\resources\\app.asar.unpacked\\apps\\desktop\\dist\\telemetry-service.cjs');
    expect(processEntrypoint('C:\\installed\\resources\\app.asar.unpacked\\apps\\desktop\\dist','storage-worker')).toBe('C:\\installed\\resources\\app.asar.unpacked\\apps\\desktop\\dist\\storage-worker.cjs');
    expect(processEntrypoint('C:\\source\\app.asar-project\\apps\\desktop\\dist','storage-worker')).toBe('C:\\source\\app.asar-project\\apps\\desktop\\dist\\storage-worker.cjs');
  });
});
