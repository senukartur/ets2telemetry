// ET-019 finding F1 (stale checkpoints, docs/trips.md): normal-delivery with a derived transport in which the first
// durable connection commits and acknowledges nothing, so the producer retains eventSeq 1-9 and redelivers them after the
// second connection's checkpoint at 1,200 ms. That checkpoint's state is the slot published at the last frame (200 ms,
// OD-5 S7): it still shows job 3 at configuration revision 3, although the retained events deliver (8) and clear (9,
// revision 5) that job. A live fine at 1,250 ms (eventSeq 10) follows the replay. Shared by the reducer replay
// (tests/unit/trip-simulator-replay.test.ts) and the storage-worker run (tests/storage/stale-checkpoint.test.ts), which
// compare with the hand-written tests/fixtures/recording/normal-delivery-stale-checkpoint.rows.expected.json.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {scenarioPath} from './simulator-v1-expected';

type Json = Record<string, unknown>;
export const STALE_CHECKPOINT_ID = 'normal-delivery-stale-checkpoint';

export function staleCheckpointScenario(): Json {
  const base = structuredClone(readFixtureFile(scenarioPath('normal-delivery'))) as Json & {steps: Json[]};
  return {...base, id: STALE_CHECKPOINT_ID,
    steps: [...base.steps, {atMs: 1250, action: 'gameplay', id: 'player.fined', attributes: [{name: 'fine.offence', sdkType: 'string', value: 'speeding'},
      {name: 'fine.amount', sdkType: 's64', value: '150'}]}],
    transport: [{atMs: 0, action: 'connect', client: {durable: true, commit: 'none', ack: 'withhold'}}, {atMs: 1100, action: 'disconnect'},
      {atMs: 1200, action: 'connect', client: {durable: true}}, {atMs: 1300, action: 'disconnect'}]};
}

export interface StaleCheckpointExpected {
  scenario: string; authoredFrom: string[]; trips: unknown[]; attributions: unknown[]; intervals: unknown[];
  coverage: {committedThroughEventSeq: string; committed: number; duplicate: number; covered: number};
  view: unknown;
}
export const staleCheckpointExpected = (): StaleCheckpointExpected =>
  JSON.parse(readFileSync(path.resolve('tests/fixtures/recording', `${STALE_CHECKPOINT_ID}.rows.expected.json`), 'utf8')) as StaleCheckpointExpected;
