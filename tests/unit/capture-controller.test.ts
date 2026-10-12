import {describe, expect, it, vi} from 'vitest';
import {CaptureController, type CaptureSessionLike} from '../../apps/desktop/src/capture-controller';
import type {CaptureSessionOptions} from '../../apps/desktop/src/capture-session';

const broker = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
const grant = {format: 'cap0', deadlineMs: 600_000, operatorLabel: 'ets2-sp-windowed', displays: []};
function controller(localAppData: string | undefined = 'C:\\isolated\\local') {
  const log = vi.fn(), created: CaptureSessionOptions[] = [], sessions: (CaptureSessionLike & {stop: ReturnType<typeof vi.fn>})[] = [];
  const instance = new CaptureController({log, localAppData, identity: () => Promise.resolve({code: {brokerSha256: null}, platform: {arch: 'x64'}}),
    createSession: options => { created.push(options); const session = {captureSessionId: `session-${created.length}`, done: new Promise<undefined>(() => {}), start: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve(undefined))}; sessions.push(session); return session; }});
  return {instance, log, created, sessions};
}

describe('service capture controller', () => {
  it('starts exactly one capture per service lifetime under the fixed captures root', async () => {
    const c = controller();
    expect(c.instance.offer(grant, 'ets2', broker)).toBe(true);
    expect(c.instance.offer(grant, 'ats', broker)).toBe(false);
    await vi.waitFor(() => expect(c.created).toHaveLength(1));
    expect(c.created[0]).toMatchObject({root: 'C:\\isolated\\local\\ETS2Telemetry\\captures', game: 'ets2', context: {activation: {mechanism: 'environment', deadlineMs: 600_000, operatorLabel: 'ets2-sp-windowed'}, code: {brokerSha256: null}}});
    expect(c.log).toHaveBeenCalledWith('CAPTURE_REJECTED', expect.stringContaining('already used'));
    await vi.waitFor(() => expect(c.log).toHaveBeenCalledWith('CAPTURE_STARTED', {captureSessionId: 'session-1'}));
    await c.instance.stop(); expect(c.sessions[0].stop).toHaveBeenCalledOnce();
  });
  it('rejects invalid grants and missing prerequisites without throwing into source selection', () => {
    const cases: [unknown, 'ets2' | 'synthetic', typeof broker | undefined, string | undefined][] = [
      [{...grant, deadlineMs: 1}, 'ets2', broker, 'C:\\isolated'], [grant, 'synthetic', broker, 'C:\\isolated'], [grant, 'ets2', undefined, 'C:\\isolated'],
      [grant, 'ets2', broker, undefined], [grant, 'ets2', broker, 'relative\\path'], ['cap0', 'ets2', broker, 'C:\\isolated']];
    for (const [value, selection, configuration, local] of cases) {
      const c = controller(local);
      expect(() => c.instance.offer(value, selection, configuration)).not.toThrow();
      expect(c.instance.offer(value, selection, configuration)).toBe(false); expect(c.created).toEqual([]);
      expect(c.log).toHaveBeenCalledWith('CAPTURE_REJECTED', expect.any(String));
    }
  });
  it('stops cleanly when no capture was ever started', async () => {
    const c = controller(); await expect(c.instance.stop()).resolves.toBeUndefined(); expect(c.log).not.toHaveBeenCalled();
  });
});
