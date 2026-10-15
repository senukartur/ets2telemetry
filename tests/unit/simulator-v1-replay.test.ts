import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {expectedPath, manifest, mismatches, scenarioPath, type Expected} from '../shared/simulator-v1-expected';

// Every corpus scenario is replayed through the adapter model, the producer and the scripted ET-002b client, then
// compared with its hand-written expectation file. The comparator never rewrites an expectation.
describe('simulator v1 synthetic corpus (tests/fixtures/simulator-v1)', () => {
  const ids = manifest();
  it('lists each scenario once, with an expectation and synthetic origin', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const scenario = readFixtureFile(scenarioPath(id)) as {id: string; origin: string};
      expect([scenario.id, scenario.origin]).toEqual([id, 'synthetic']);
      expect((JSON.parse(readFileSync(expectedPath(id), 'utf8')) as Expected).scenario).toBe(id);
    }
  });
  for (const id of ids) it(`scenario ${id} meets its hand-written expectation`, () => {
    const result = replayV1(readFixtureFile(scenarioPath(id)));
    expect(mismatches(result, JSON.parse(readFileSync(expectedPath(id), 'utf8')) as Expected)).toEqual([]);
  });
});
