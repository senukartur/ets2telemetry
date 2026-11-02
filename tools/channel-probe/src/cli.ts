import net from 'node:net';
import path from 'node:path';
import {NativePipeClient} from '../../../apps/desktop/src/native-pipe-client';
import {parseArguments, stagingBroker} from './options';
import {runProbe, MAX_SECONDS} from './probe';

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2)), game = args['--game'] as 'ets2' | 'ats';
  const seconds = args['--seconds'] === undefined ? 600 : Number(args['--seconds']);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) throw new Error(`--seconds must be an integer from 1 to ${MAX_SECONDS}`);
  const fixture = args['--fixture-endpoint'];
  let connect;
  if (fixture) connect = () => net.connect(fixture);
  else {
    const localAppData = process.env.LOCALAPPDATA;
    if (!args['--broker'] && !localAppData) throw new Error('LOCALAPPDATA is not set; pass --broker and --discovery-dir.');
    const broker = args['--broker'] ? {executable: path.resolve(args['--broker']), discoveryDirectory: path.resolve(args['--discovery-dir'])} : await stagingBroker(localAppData!);
    console.log(`Broker: ${broker.executable}`);
    connect = () => new NativePipeClient(broker, game, undefined, 'v0');
  }
  const controller = new AbortController();
  process.once('SIGINT', () => {console.log('Stopping…'); controller.abort();});
  console.log(`Recording up to ${seconds} s; press Ctrl+C to stop early.`);
  const result = await runProbe({output: args['--output'], game, origin: fixture ? 'synthetic' : 'game', seconds, connect, signal: controller.signal, log: line => console.log(line)});
  const {consumption, zeroRuns, frameIntervalMs, missed} = result.summary;
  console.log(`Stopped: ${result.stopReason}. Frames ${result.summary.frames}, consumption observed ${consumption.observed}, zero ${consumption.zero} (${consumption.zeroPercent} %), ` +
    `zero runs ${zeroRuns.count} (median ${zeroRuns.durationMs.median ?? '-'} ms), frame interval median ${frameIntervalMs.median ?? '-'} ms, missed frames ${missed.coalescedSnapshots}.`);
  console.log(`Written to ${result.directory}`);
  if (result.stopReason === 'protocol-error' || result.stopReason === 'diagnostics-refused') process.exitCode = 1;
}
void main().catch((error: unknown) => {console.error(error instanceof Error ? error.message : 'Channel probe failed'); process.exitCode = 1;});
