import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {expect, it} from 'vitest';

type Target = {pid: number; handle: string};
type Launcher = EventEmitter & {exitCode: number | null; signalCode: string | null};
const {observeSessionEnd, assertSessionSender} = await import(pathToFileURL(path.resolve('scripts/ci/session-end-observation.mjs')).href) as {
  observeSessionEnd(input: {application: EventEmitter; launcher: Launcher; send: () => unknown; target: Target; executable: string; record: Record<string, unknown>}): Promise<unknown>;
  assertSessionSender(receipt: unknown, target: Target, executable: string, mode: string): void;
};
const target = {pid: 1234, handle: 'abcd'}, executable = 'C:\\isolated\\portable\\ETS2TelemetryDesktop.exe';
const receipt = {ownerPidVerified: true, imageVerified: true, broadcast: false, mode: 'end', verifiedPid: target.pid,
  verifiedHwnd: target.handle, verifiedImage: executable, sendReturnedSuccess: true, win32Error: 0, targetActiveAfterSend: false};
function fixture() {
  const application = new EventEmitter();
  const launcher = Object.assign(new EventEmitter(), {exitCode: null as number | null, signalCode: null as string | null});
  const exit = () => {launcher.exitCode = 0; launcher.emit('exit', 0, null);};
  return {application, launcher, exit};
}
it('rejects a failed native sender even when the application then exits successfully', async () => {
  const f = fixture(), record: Record<string, unknown> = {};
  await expect(observeSessionEnd({...f, target, executable, record, send: () => {
    f.exit(); throw new Error('owned native sender failed');
  }})).rejects.toThrow('owned native sender failed');
});
it.each([true, false])('accepts verified native termination with SendMessageTimeout success %s when the target already exited', async delivered => {
  const f = fixture(), record: Record<string, unknown> = {};
  const native = {...receipt, sendReturnedSuccess: delivered, win32Error: delivered ? 0 : 1460};
  await expect(observeSessionEnd({...f, target, executable, record, send: () => {f.exit(); return native;}})).resolves.toEqual({code: 0, signal: null});
  expect(record.sender).toEqual(native);
});
it.each([
  undefined,
  {...receipt, ownerPidVerified: false},
  {...receipt, imageVerified: false},
  {...receipt, verifiedPid: 1235},
  {...receipt, verifiedHwnd: 'abce'},
  {...receipt, verifiedImage: 'C:\\other\\ETS2TelemetryDesktop.exe'},
  {...receipt, broadcast: true},
  {...receipt, mode: 'cancel'},
  {...receipt, sendReturnedSuccess: false, targetActiveAfterSend: true},
  {...receipt, win32Error: -1}
])('rejects a missing or mismatched sender receipt despite a successful process exit: %j', async native => {
  const f = fixture();
  await expect(observeSessionEnd({...f, target, executable, record: {}, send: () => {f.exit(); return native;}})).rejects.toThrow();
});
it('requires the cancellation probe to return successfully while its verified target remains alive', () => {
  expect(() => assertSessionSender({...receipt, mode: 'cancel', targetActiveAfterSend: true}, target, executable, 'cancel')).not.toThrow();
  expect(() => assertSessionSender({...receipt, mode: 'cancel'}, target, executable, 'cancel')).toThrow();
});
