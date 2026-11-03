import {describe, expect, it} from 'vitest';
import {MAX_SELECTED_FILES, planChecks, type Plan} from '../../scripts/test-affected-plan.mjs';

// ET-066: the local check plan (docs/TESTING.md section 5). Every expected plan below is written by hand from the rules in
// scripts/test-affected-plan.mjs and the CI job layout in docs/ci.md, never produced by running the planner.
const ids = (plan: Plan) => plan.steps.map(step => step.id);
const command = (plan: Plan, id: string) => plan.steps.find(step => step.id === id)?.command;
const RUNTIME = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode packaged';
const PACKAGED = ['native:configure', 'build', 'package', 'inspect:package'];

describe('local check plan', () => {
  it('plans nothing for no change and no application check for documentation', () => {
    expect(planChecks({changed: []})).toMatchObject({kind: 'empty', steps: []});
    expect(planChecks({changed: ['docs/TESTING.md', 'AGENTS.md', 'docs/validation/et-066.md']})).toMatchObject({kind: 'documentation', steps: []});
  });

  it('runs the importing unit tests, lint of the file and the overlay scenarios for an overlay module', () => {
    const plan = planChecks({changed: ['apps/desktop/src/overlay-geometry.ts'], affectedTests: ['tests/unit/overlay-geometry.test.ts', 'tests/unit/overlay.test.ts']});
    expect(ids(plan)).toEqual(['typecheck', 'lint', 'vitest', ...PACKAGED, 'runtime:overlay', 'runtime:ui:overlay']);
    expect(command(plan, 'vitest')).toBe('npm test -- tests/unit/overlay-geometry.test.ts tests/unit/overlay.test.ts');
    expect(command(plan, 'lint')).toBe('node tools/lint/node_modules/eslint/bin/eslint.js --max-warnings 0 --no-warn-ignored apps/desktop/src/overlay-geometry.ts');
    expect(command(plan, 'runtime:overlay')).toBe(`${RUNTIME} -Scenario overlay -ForceRendererReuse`);
    expect(command(plan, 'runtime:ui:overlay')).toBe(`${RUNTIME} -Scenario ui -UiCase overlay`);
    expect(plan.unmapped).toEqual([]);
    expect(plan.areas).toEqual(['overlay']);
  });

  it('runs native tests, both chains and the lock check, but no Vitest file, for a native plugin source', () => {
    const plan = planChecks({changed: ['native/telemetry-plugin/src/v1-transport.cpp']});
    expect(ids(plan)).toEqual(['typecheck', 'native:configure', 'build', 'ctest:client', 'native:build', 'native:test', 'cap0-chain', 'v1-chain', 'plugin-lock']);
    expect(plan.steps.find(step => step.id === 'native:test')?.needs).toEqual(['native:build']);
    expect(plan.areas).toEqual(['native-plugin']);
  });

  it('treats the shared protocol fixtures as inputs of the native, simulator and importing tests', () => {
    const plan = planChecks({changed: ['tests/fixtures/protocol-v0/snapshot.json'], references: {'tests/fixtures/protocol-v0/snapshot.json': ['tests/unit/protocol-v0.test.ts']}});
    expect(ids(plan)).toEqual(['typecheck', 'vitest', 'native:configure', 'build', 'ctest:client', 'native:build', 'native:test', 'cap0-chain', 'v1-chain', 'plugin-lock']);
    expect(command(plan, 'vitest')).toBe('npm test -- tests/unit/protocol-v0.test.ts');
  });

  it('runs the whole Vitest and storage suites and the packaged scaffold when dependencies change', () => {
    const plan = planChecks({changed: ['package-lock.json']});
    expect(ids(plan)).toEqual(['typecheck', 'media:build', 'vitest', 'storage', ...PACKAGED, 'runtime:scaffold']);
    expect(command(plan, 'vitest')).toBe('npm test');
    expect(command(plan, 'storage')).toBe('npm run test:storage');
    expect(command(plan, 'runtime:scaffold')).toBe(RUNTIME);
  });

  it('runs the whole storage suite when the import graph reaches a storage bundle entry', () => {
    const plan = planChecks({changed: ['packages/telemetry-core/src/trip-reducer.ts'], affectedTests: ['tests/unit/trip-reducer.test.ts', 'tests/storage/trip-recorder.test.ts'],
      affectedEntries: ['apps/desktop/src/trip-recorder.ts']});
    expect(command(plan, 'vitest')).toBe('npm test -- tests/unit/trip-reducer.test.ts');
    expect(command(plan, 'storage')).toBe('npm run test:storage');
    expect(ids(plan).filter(id => id.startsWith('runtime:'))).toEqual(['runtime:telemetry', 'runtime:journal', 'runtime:ui:live', 'runtime:ui:journal']);
  });

  it('selects storage files alone when no bundle entry is reached', () => {
    const plan = planChecks({changed: ['tests/storage/journal-reads.test.ts']});
    expect(ids(plan)).toEqual(['typecheck', 'lint', 'storage']);
    expect(command(plan, 'storage')).toBe('npm run test:storage -- tests/storage/journal-reads.test.ts');
  });

  it('runs the scenario an observation script serves and the tests that name it', () => {
    const plan = planChecks({changed: ['scripts/ci/journal-observation.mjs'], references: {'scripts/ci/journal-observation.mjs': ['tests/unit/journal-observation.test.ts']}});
    expect(ids(plan)).toEqual(['typecheck', 'lint', 'vitest', ...PACKAGED, 'runtime:journal']);
  });

  it('runs every packaged scenario when the runtime driver changes, and PowerShell analysis for a script', () => {
    const plan = planChecks({changed: ['scripts/ci/Invoke-RuntimeSmoke.ps1']});
    expect(ids(plan)).toEqual(['typecheck', 'lint:ps', ...PACKAGED, 'runtime:scaffold', 'runtime:telemetry', 'runtime:overlay', 'runtime:now-playing', 'runtime:lifecycle',
      'runtime:plugin', 'runtime:recording', 'runtime:journal', 'runtime:hard-mode', 'runtime:ui:shell', 'runtime:ui:live', 'runtime:ui:journal', 'runtime:ui:settings',
      'runtime:ui:overlay', 'runtime:refusal']);
  });

  it('runs the scaffold for the scenario driver and leaves the other scenarios to the files that select them', () => {
    const plan = planChecks({changed: ['scripts/ci/runtime-smoke.mjs', 'apps/desktop/src/hard-mode/reader.ts'], affectedTests: ['tests/unit/hard-mode-reader.test.ts']});
    expect(ids(plan).filter(id => id.startsWith('runtime:'))).toEqual(['runtime:scaffold', 'runtime:hard-mode']);
  });

  it('treats Codex agent definitions as instructions, like the Markdown ones', () => {
    expect(planChecks({changed: ['.codex/agents/verifier.toml', '.claude/agents/verifier.md']}).kind).toBe('documentation');
  });

  it('runs the simulator smokes on its own build when nothing else needs the full build', () => {
    const plan = planChecks({changed: ['tools/telemetry-simulator/src/cli.ts'], affectedTests: ['tests/unit/simulator-v0.test.ts']});
    expect(ids(plan)).toEqual(['typecheck', 'lint', 'vitest', 'simulator:build', 'smoke:v0', 'smoke:v1']);
    expect(plan.steps.find(step => step.id === 'smoke:v1')?.needs).toEqual(['simulator:build']);
  });

  it('runs the media reader tests, its host test and the now-playing scenario for a media reader source', () => {
    const plan = planChecks({changed: ['native/media-session-reader/src/reader.cpp']});
    expect(ids(plan)).toEqual(['typecheck', 'media:build', 'vitest', 'native:configure', 'build', 'ctest:media', 'package', 'inspect:package', 'runtime:now-playing']);
    expect(plan.steps.find(step => step.id === 'vitest')?.needs).toEqual(['media:build']);
    expect(command(plan, 'vitest')).toBe('npm test -- tests/host/media-session-reader.test.ts');
  });

  it('installs the lint dependencies first when they are missing, and lints only files that still exist', () => {
    const plan = planChecks({changed: ['scripts/old.mjs', 'scripts/new.mjs'], existing: ['scripts/new.mjs'], lintInstalled: false});
    expect(ids(plan).slice(0, 3)).toEqual(['lint:install', 'typecheck', 'lint']);
    expect(command(plan, 'lint')).toBe('node tools/lint/node_modules/eslint/bin/eslint.js --max-warnings 0 --no-warn-ignored scripts/new.mjs');
  });

  it('falls back to the whole suite above the selection limit', () => {
    const many = Array.from({length: MAX_SELECTED_FILES + 1}, (_, index) => `tests/unit/case-${index}.test.ts`);
    const plan = planChecks({changed: ['packages/contracts/src/units.ts'], affectedTests: many});
    expect(command(plan, 'vitest')).toBe('npm test');
  });

  it('reports a changed file that no rule, import or test name covers', () => {
    const plan = planChecks({changed: ['.gitattributes', 'scripts/ci/versions.mjs']});
    expect(plan.unmapped).toEqual(['.gitattributes']);
    expect(ids(plan)).toEqual(['typecheck', 'lint']);
  });
});
