import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {NativeCaptureClient as Client} from '../../apps/desktop/src/capture-session';
import {captureActivation, validateCaptureGrant} from '../../apps/desktop/src/capture-activation';
import {frame, header} from '../shared/cap0-fixtures';

class Child extends EventEmitter {
  writes: Buffer[] = []; stdout = new PassThrough(); stderr = new PassThrough();
  stdin = new Writable({write: (chunk: Buffer, _encoding, callback) => {this.writes.push(Buffer.from(chunk)); callback();}});
}
const broker = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
const source = {game: 'ets2', processId: 4242, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: '22222222-2222-4222-8222-222222222222', origin: 'game'};
const receipt = (extra: Record<string, unknown> = {evidence: 'cap0'}) => frame({type: 'authority', schemaVersion: 1, source, processCreationTime: '133000000000000000', userTag: 'a'.repeat(64), ...extra});
let children: Child[], NativeCaptureClient: typeof Client, spawn: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules(); children = [];
  spawn = vi.fn(() => {const child = new Child(); children.push(child); return child;});
  vi.doMock('node:child_process', () => ({spawn}));
  ({NativeCaptureClient} = await import('../../apps/desktop/src/capture-session'));
});
afterEach(() => {vi.doUnmock('node:child_process');});
function client() {
  const instance = new NativeCaptureClient(broker, 'ets2'), child = children.at(-1)!;
  const events = {authority: vi.fn(), packet: vi.fn(), error: vi.fn(), waiting: vi.fn(), end: vi.fn()};
  for (const [name, listener] of Object.entries(events)) instance.on(name, listener);
  return {instance, child, ...events};
}

describe('native broker CAP0 mode', () => {
  it('launches only the fixed broker in explicit capture mode and requires a CAP0-marked receipt', () => {
    const c = client(); c.child.stdout.write(receipt());
    expect(spawn).toHaveBeenCalledWith(broker.executable, ['--game', 'ets2', '--discovery-dir', broker.discoveryDirectory, '--capture', 'cap0'], {windowsHide: true, stdio: 'pipe'});
    expect(c.authority).toHaveBeenCalledWith({game: 'ets2', processId: 4242, windowsSessionId: 1, processInstanceId: source.processInstanceId, pluginSessionId: source.pluginSessionId, processCreationTime: '133000000000000000'});
    c.instance.destroy();
  });
  it('rejects a v0 authority receipt, a mismatched game and a non-game origin', () => {
    for (const bad of [receipt({}), frame({type: 'authority', schemaVersion: 1, source: {...source, game: 'ats'}, processCreationTime: '1', userTag: 'a'.repeat(64), evidence: 'cap0'}),
      frame({type: 'authority', schemaVersion: 1, source: {...source, origin: 'synthetic'}, processCreationTime: '1', userTag: 'a'.repeat(64), evidence: 'cap0'})]) {
      const c = client(); c.child.stdout.write(bad); expect(c.error).toHaveBeenCalledOnce(); expect(c.authority).not.toHaveBeenCalled(); expect(c.child.stdin.writableEnded).toBe(true);
    }
  });
  it('relays one packet per credit and rejects uncredited or coalesced packets', () => {
    const c = client(); c.child.stdout.write(receipt());
    const hello = new Uint8Array(20); c.instance.sendHello(hello);
    expect(c.child.writes).toEqual([Buffer.from(hello), Buffer.from([1])]);
    c.child.stdout.write(frame(header())); expect(c.packet).toHaveBeenCalledOnce();
    c.instance.credit(); expect(c.child.writes.at(-1)).toEqual(Buffer.from([1]));
    c.child.stdout.write(Buffer.concat([frame(header()), frame(header())])); expect(c.packet).toHaveBeenCalledOnce(); expect(c.error).toHaveBeenCalledOnce();
    const early = client(); early.child.stdout.write(Buffer.concat([receipt(), frame(header())])); expect(early.error).toHaveBeenCalledOnce();
  });
  it('maps the waiting receipt and exits to explicit outcomes', () => {
    const waiting = client(); waiting.child.stdout.write(frame({type: 'waiting', schemaVersion: 1})); waiting.child.emit('close', 2); expect(waiting.waiting).toHaveBeenCalledOnce();
    const ended = client(); ended.child.stdout.write(receipt()); ended.child.emit('close', 3); expect(ended.end).toHaveBeenCalledOnce();
    const failed = client(); failed.child.emit('close', 1); expect(failed.error).toHaveBeenCalledOnce();
  });
});

describe('explicit default-off activation', () => {
  it('is off unless ETS2TELEMETRY_CAPTURE=cap0 and validates interval and label', () => {
    expect(captureActivation({})).toBeUndefined(); expect(captureActivation({ETS2TELEMETRY_CAPTURE: ''})).toBeUndefined();
    expect(captureActivation({ETS2TELEMETRY_CAPTURE: 'cap0'})).toEqual({format: 'cap0', deadlineMs: 600_000, operatorLabel: null});
    expect(captureActivation({ETS2TELEMETRY_CAPTURE: 'cap0', ETS2TELEMETRY_CAPTURE_MINUTES: '45', ETS2TELEMETRY_CAPTURE_LABEL: 'ets2-sp-windowed'})).toEqual({format: 'cap0', deadlineMs: 2_700_000, operatorLabel: 'ets2-sp-windowed'});
    for (const environment of [{ETS2TELEMETRY_CAPTURE: '1'}, {ETS2TELEMETRY_CAPTURE: 'cap0', ETS2TELEMETRY_CAPTURE_MINUTES: '61'}, {ETS2TELEMETRY_CAPTURE: 'cap0', ETS2TELEMETRY_CAPTURE_MINUTES: '0'},
      {ETS2TELEMETRY_CAPTURE: 'cap0', ETS2TELEMETRY_CAPTURE_MINUTES: '1.5'}, {ETS2TELEMETRY_CAPTURE: 'cap0', ETS2TELEMETRY_CAPTURE_LABEL: 'C:\\Users\\name'}]) expect(() => captureActivation(environment)).toThrow();
  });
  it('validates the one-shot grant crossing into the telemetry service', () => {
    const grant = {format: 'cap0', deadlineMs: 600_000, operatorLabel: null, displays: [{id: '1', bounds: {x: -1920, y: 0, width: 1920, height: 1080}, scaleFactor: 1.5, rotation: 0}]};
    expect(validateCaptureGrant(grant)).toEqual(grant);
    for (const bad of [{...grant, extra: 1}, {...grant, deadlineMs: 59_999}, {...grant, deadlineMs: 3_600_001}, {...grant, displays: [{...grant.displays[0], id: 'x'}]}, {...grant, root: 'C:\\anywhere'}])
      expect(() => validateCaptureGrant(bad)).toThrow();
  });
});
