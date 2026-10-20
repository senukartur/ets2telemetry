// Bounded runtime smoke only: derived synthetic roots, never renderer paths or real game configuration.
import path from 'node:path';
import {recordingPlan} from '../recording-policy';
import {HardModeReader, type HardModeReaderOptions} from './reader';
export function hardModeFixtureOptions(env: Readonly<Record<string, string | undefined>>): HardModeReaderOptions | null {
  const target = recordingPlan(env, {gameHistory: false}).database;
  if (env.ETS2TELEMETRY_LIVE_SMOKE !== '1' || env.ETS2TELEMETRY_HARD_MODE_FIXTURE !== '1' || target.purpose === 'history'
    || !env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) return null;
  const root = path.join(env.LOCALAPPDATA, 'ETS2Telemetry', 'synthetic', 'hard-mode-fixture');
  return {documents: path.join(root, 'Documents'), steamRoot: path.join(root, 'Steam'), fixtureOrigin: target.purpose,
    process: source => Promise.resolve({pid: source.processId, createdUtcMs: new Date(2026, 9, 20, 12, 0, 0).getTime(),
      executable: source.game === 'ets2' ? 'C:\\Synthetic\\eurotrucks2.exe' : 'C:\\Synthetic\\amtrucks.exe', commandLine: 'synthetic fixture'})};
}
export function hardModeFixtureReader(env: Readonly<Record<string, string | undefined>>): HardModeReader | null {
  const options = hardModeFixtureOptions(env);
  return options ? new HardModeReader(options) : null;
}
