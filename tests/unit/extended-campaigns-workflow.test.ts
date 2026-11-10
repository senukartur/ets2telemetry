import {readFile} from 'node:fs/promises';
import {expect, it} from 'vitest';

// ET-105 (REG-010, REG-011): the protocol fuzz campaign of .github/workflows/windows-extended.yml runs in several steps
// split by -t pattern, and the step "Check the protocol fuzz partition" lists those steps and their JUnit files by hand.
// The job timeout is the sum of the step budgets plus a documented allowance. Text assertions over the workflow, as
// tests/unit/ci-build-channel-workflow.test.ts does for Windows CI, so that a new fuzz step or a changed budget cannot
// silently leave the partition check or the job timeout behind.

const workflow = async () => (await readFile('.github/workflows/windows-extended.yml', 'utf8')).replaceAll('\r\n', '\n');
const job = (text: string) => text.split('\n  windows-extended:\n')[1].split(/\n {2}[a-z-]+:\n/)[0];

interface Step { name?: string; id?: string; condition?: string; timeout?: number; body: string }
// Each step item starts at six spaces; its own keys sit at eight, so the first line holds name: or uses:.
const steps = (jobText: string): Step[] => jobText.split('\n    steps:\n')[1].split(/\n {6}- /).slice(1).map(body => {
  const timeout = /^ {8}timeout-minutes: (\d+)$/m.exec(body)?.[1];
  return {name: /^name: (.+)$/m.exec(body)?.[1], id: /^ {8}id: (.+)$/m.exec(body)?.[1], condition: /^ {8}if: (.+)$/m.exec(body)?.[1],
    timeout: timeout === undefined ? undefined : Number(timeout), body};
});
const FUZZ_NAME = 'Protocol fuzz campaign, ';
const fuzzSteps = (all: Step[]) => all.filter(step => step.id?.startsWith('fuzz-'));
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

it('bounds the job by the sum of its step budgets plus the documented 12-minute allowance', async () => {
  const jobText = job(await workflow());
  const budgets = steps(jobText).flatMap(step => step.timeout === undefined ? [] : [step.timeout]);
  const sum = budgets.reduce((total, minutes) => total + minutes, 0);
  const jobTimeout = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(jobText)?.[1]);
  // The comment above the job timeout spells out the same arithmetic.
  const comment = /\n {4}# Bounds the sum: the (\w+) step budgets below \(([\d + ]+) = (\d+) min\) plus (\d+) min\n/.exec(jobText);
  expect(comment).not.toBeNull();
  const [, count, terms, total, allowance] = comment as RegExpExecArray;
  expect(count).toBe(NUMBER_WORDS[budgets.length]);
  expect(terms.split(' + ').map(Number)).toEqual(budgets);
  expect(Number(total)).toBe(sum);
  expect(Number(allowance)).toBe(12);
  expect(jobTimeout).toBe(sum + 12);
});

it('budgets every protocol fuzz campaign step and gives it a fuzz- id', async () => {
  const all = steps(job(await workflow()));
  const campaigns = all.filter(step => step.name?.startsWith(FUZZ_NAME) || step.body.includes('tests/unit/protocol-fuzz.test.ts'));
  expect(campaigns.length).toBeGreaterThan(1);
  for (const step of campaigns) {
    expect(step.name, step.body).toMatch(/^Protocol fuzz campaign, /);
    expect(step.id, step.name).toMatch(/^fuzz-/);
    expect(step.timeout, step.name).toBeGreaterThan(0);
    expect(step.condition, step.name).toBe("${{ !cancelled() && steps.install.outcome == 'success' }}");
  }
  expect(fuzzSteps(all)).toEqual(campaigns);
});

it('requires every fuzz step and reads exactly their JUnit files in the partition check', async () => {
  const all = steps(job(await workflow()));
  const fuzz = fuzzSteps(all);
  const partition = all.filter(step => step.name === 'Check the protocol fuzz partition');
  expect(partition).toHaveLength(1);
  const [check] = partition;

  const required = [...(check.condition ?? '').matchAll(/steps\.([\w-]+)\.outcome == 'success'/g)].map(match => match[1]);
  expect(check.condition).toMatch(/^\$\{\{ !cancelled\(\) && steps\./);
  expect(check.condition).not.toContain('||');
  expect(new Set(required)).toEqual(new Set(fuzz.map(step => step.id)));
  expect(required).toHaveLength(fuzz.length);

  const outputs = fuzz.map(step => {
    const files = [...step.body.matchAll(/--outputFile=\.local\/ci\/([\w.-]+\.xml)/g)].map(match => match[1]);
    expect(files, step.name).toHaveLength(1);
    return files[0];
  });
  expect(new Set(outputs).size).toBe(outputs.length);
  const loop = /\n {10}foreach \(\$file in ((?:'[\w.-]+\.xml'(?:, )?)+)\) \{\n {12}foreach \(\$case in \(\[xml\]\(Get-Content -Raw -LiteralPath "\.local\/ci\/\$file"\)\)/.exec(check.body);
  expect(loop).not.toBeNull();
  const listed = [...(loop as RegExpExecArray)[1].matchAll(/'([\w.-]+\.xml)'/g)].map(match => match[1]);
  expect(new Set(listed)).toEqual(new Set(outputs));
  expect(listed).toHaveLength(outputs.length);
});
