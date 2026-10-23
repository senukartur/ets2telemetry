import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {NativePipeClient} from '../../../apps/desktop/src/native-pipe-client';
import {listProcesses} from '../../../apps/desktop/src/plugin-setup/game-processes';
import {encodeFrame, FrameDecoder, PROTOCOL_V1, type ClientMessage} from '../../../packages/contracts/src/protocol-v1';
import {computeClockMapping} from '../../../packages/contracts/src/protocol-v1-delivery';
import {EventProbe, EvidenceLog} from './event-probe';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--game', '--broker', '--sha256', '--discovery', '--output', '--seconds'].includes(flag) || !value || flags.has(flag)) throw new Error('Invalid or duplicate probe option');
    flags.set(flag, value);
  }
  if (flags.size !== 6) throw new Error('Expected --game --broker --sha256 --discovery --output --seconds');
  const game = flags.get('--game');
  if (game !== 'ets2' && game !== 'ats') throw new Error('Expected ets2 or ats');
  const broker = flags.get('--broker')!, discovery = flags.get('--discovery')!, output = flags.get('--output')!;
  const secondsText = flags.get('--seconds')!, sha256 = flags.get('--sha256')!;
  if (!/^\d+$/.test(secondsText) || +secondsText < 15 || +secondsText > 1800) throw new Error('Observation must be 15–1800 seconds');
  for (const file of [broker, discovery, output]) if (!path.isAbsolute(file)) throw new Error('Absolute paths required');
  if (!/^[0-9a-f]{64}$/.test(sha256) || createHash('sha256').update(readFileSync(broker)).digest('hex') !== sha256) throw new Error('Broker hash mismatch');
  if (path.basename(discovery) !== 'v1' || path.basename(path.dirname(discovery)) !== 'transport') throw new Error('Expected owned transport/v1 directory');
  // Resolve every existing ancestor before creating a new output directory; never overwrite evidence or write app data.
  const evidenceRoot = path.resolve('.local', 'validation');
  if (!output.startsWith(evidenceRoot + path.sep) || existsSync(output)) throw new Error('Use a fresh path under this checkout .local/validation');
  for (let ancestor = path.dirname(output);; ancestor = path.dirname(ancestor)) {
    if (!existsSync(ancestor) || lstatSync(ancestor).isSymbolicLink()) throw new Error('Output parent must exist and have no reparse ancestry');
    if (ancestor === path.dirname(ancestor)) break;
  }
  if (realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Output parent is not canonical');
  const listing = await listProcesses();
  if (!listing.ok || listing.rows.some(row => row.name.toLowerCase() === 'ets2telemetrydesktop.exe')) throw new Error('Exit the desktop application before using the standalone event probe');
  mkdirSync(output);
  const log = new EvidenceLog(path.join(output, 'evidence.jsonl'), 64 * 1024 * 1024);
  const probe = new EventProbe(log), clientInstanceId = randomUUID(), clientClockId = randomUUID();
  const input = createInterface({input: process.stdin, terminal: false});
  const startedUtc = new Date().toISOString();
  let socket: NativePipeClient | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let failure: string | undefined, stopping = false, finish: Promise<void> | undefined;
  let sequence: Promise<void> = Promise.resolve();
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => {resolveFinished = resolve;});
  const say = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const note = (record: unknown) => log.append(record, true);
  const send = (messages: ClientMessage[]) => {for (const message of messages) socket?.write(encodeFrame(message));};
  const stop = (reason: string): Promise<void> => finish ??= (async () => {
    stopping = true; clearTimeout(retry); clearTimeout(deadline); input.close();
    const current = socket;
    if (current) {current.destroy(); await current.completion;}
    try {note({type: 'stop', reason, failure: failure ?? null});} catch (error) {failure ??= String(error);}
    try {log.close();} catch (error) {failure ??= String(error);}
    const summary = {startedUtc, endedUtc: new Date().toISOString(), reason, failure: failure ?? null,
      purpose: 'native-game-event-validation', applicationHistoryRecording: false, clientInstanceId, brokerSha256: sha256,
      snapshotPolicy: 'All validated; raw diagnostic samples at most once per second, not application history', ...probe.summary()};
    writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), {flag: 'wx'});
    say({state: failure ? 'failed' : 'stopped', output, ...summary});
    process.exitCode = failure ? 1 : 0; resolveFinished();
  })();
  const fail = (error: unknown) => {failure ??= String(error).slice(0, 512); void stop('error');};
  const open = () => {
    if (stopping || socket) return;
    try {
      if (createHash('sha256').update(readFileSync(broker)).digest('hex') !== sha256) throw new Error('Broker changed before reconnect');
    } catch (error) {fail(error); return;}
    const decoder = new FrameDecoder('server');
    let connected = false, probeId = 0n, sentProbe: {id: string; at: bigint} | undefined;
    const current = socket = new NativePipeClient({executable: broker, discoveryDirectory: discovery}, game,
      diagnostic => {try {note({type: 'native-diagnostic', diagnostic});} catch (error) {fail(error);}}, 'v1');
    current.on('connect', () => {
      try {
        if (!current.authority) throw new Error('Missing native authority');
        probe.connect(current.authority); connected = true;
        const hello = {version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId, minMinor: 0, maxMinor: 0, durableEvents: true}} as const;
        note({type: 'send', message: hello}); current.write(encodeFrame(hello));
        say({state: 'authorized', source: current.authority});
      } catch (error) {fail(error);}
    });
    current.on('data', (bytes: Uint8Array) => {
      try {
        decoder.push(bytes, message => {
          const received = process.hrtime.bigint();
          send(probe.accept(message, received));
          if (message.kind === 'checkpoint') {
            const id = (++probeId).toString(), at = process.hrtime.bigint();
            sentProbe = {id, at}; probe.expectClock(id);
            const request = {version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: id}} as const;
            note({type: 'send', sentNs: at.toString(), message: request}); current.write(encodeFrame(request));
            say({state: 'checkpoint', pluginSessionId: message.source.pluginSessionId, ackedThrough: message.data.status.delivery.ackedThroughEventSeq});
          } else if (message.kind === 'clock.reply' && sentProbe) {
            const mapping = computeClockMapping({reply: message, probeId: sentProbe.id, clientClockId,
              probeSentNs: sentProbe.at.toString(), replyReceivedNs: received.toString()});
            note({type: 'clock-mapping', mapping: mapping ?? null}); sentProbe = undefined;
          } else if (message.kind === 'event') {
            say({state: 'event', eventSeq: message.data.eventSeq, eventType: message.data.record.type, redelivered: message.data.redelivered});
          } else if (message.kind === 'gap') {
            say({state: 'gap', firstEventSeq: message.data.firstEventSeq, lastEventSeq: message.data.lastEventSeq});
          } else if (message.kind === 'end') {
            say({state: 'end', reason: message.data.reason, nextEventSeq: message.data.nextEventSeq, ackedThrough: message.data.ackedThroughEventSeq});
          }
        });
      } catch (error) {fail(error);}
    });
    current.on('error', fail);
    current.on('waiting', () => {try {note({type: 'waiting'});} catch (error) {fail(error);}});
    current.once('close', () => {
      if (socket === current) socket = undefined;
      if (connected) {try {probe.disconnect(stopping ? 'operator-stop' : 'transport-closed');} catch (error) {fail(error);}}
      if (!stopping) retry = setTimeout(open, 2000);
    });
  };
  const deadline = setTimeout(() => {void stop('observation-deadline');}, +secondsText * 1000);
  input.on('line', (line: string) => {
    sequence = sequence.then(async () => {
      if (stopping) return;
      if (line === 'stop') {await stop('operator'); return;}
      if (line === 'acks off' || line === 'acks on') {send(probe.setAcknowledging(line === 'acks on')); return;}
      if (line === 'reconnect') {
        clearTimeout(retry); const current = socket;
        if (current) {current.destroy(); await current.completion;}
        clearTimeout(retry); open(); return;
      }
      if (line === 'status') {say(probe.summary()); return;}
      if (line.startsWith('mark ') && line.length <= 125) {note({type: 'operator-mark', utc: new Date().toISOString(), label: line.slice(5)}); return;}
      throw new Error('Unknown control command');
    }).catch(fail);
  });
  input.on('close', () => {if (!stopping) void stop('control-eof');});
  process.once('SIGINT', () => {void stop('signal');});
  process.once('SIGTERM', () => {void stop('signal');});
  note({type: 'run', startedUtc, purpose: 'native-game-event-validation', clientInstanceId, clientClockId, brokerSha256: sha256,
    applicationHistoryRecording: false, seconds: +secondsText});
  say({state: 'ready', applicationHistoryRecording: false, output, seconds: +secondsText});
  open(); await finished;
}

void run().catch(error => {process.stderr.write(String(error) + '\n'); process.exitCode = 1;});
