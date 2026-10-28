import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES} from '../../apps/desktop/src/channel';
import {applyChannelAppName, type ChannelApp} from '../../apps/desktop/src/channel-app-name';

// ET-055 UP12 (REG-017): Electron's application name and userData follow the build channel, so an unpackaged staging run
// never shares userData or the single-instance lock with production. A packaged build already carries its name.

function fakeApp(name: string) {
  const calls: string[] = [];
  const app: ChannelApp & {name: string} = {name, setName: value => {calls.push(`name ${value}`); app.name = value;}, getPath: () => 'C:\\Users\\driver\\AppData\\Roaming',
    setPath: (kind, value) => {calls.push(`${kind} ${value}`);}};
  return {app, calls};
}

describe('the application name of the build channel', () => {
  it('changes nothing when the name is already the channel productName', () => {
    for (const identity of [CHANNEL_IDENTITIES.production, CHANNEL_IDENTITIES.staging]) {
      const {app, calls} = fakeApp(identity.productName);
      expect(applyChannelAppName(app, identity)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('gives an unpackaged staging run its own name, userData and sessionData before the lock', () => {
    const {app, calls} = fakeApp('ETS2Telemetry Desktop');
    expect(applyChannelAppName(app, CHANNEL_IDENTITIES.staging)).toBe(true);
    const folder = path.join('C:\\Users\\driver\\AppData\\Roaming', 'ETS2Telemetry Desktop Staging');
    expect(calls).toEqual(['name ETS2Telemetry Desktop Staging', `userData ${folder}`, `sessionData ${folder}`]);
    expect(app.name).toBe('ETS2Telemetry Desktop Staging');
  });
});
