import {execFile, execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';
import {temporaryResources} from '../shared/resources';

// ET-055 PR-5 fix round 2 (hosted run 40689215872): the hosted staging lifecycle failed with "[System.String] does not
// contain a method named 'Dispose'". Read-RegistrationView's local `$key` was its own `[string]$Key` parameter, because
// PowerShell variable names are case-insensitive, and the parameter's type turned the RegistryKey into its name. The same
// collision turned the side-by-side scenario's parsed `$stagingInput` record into the `[string]$StagingInput` parameter.
// tests/windows/Test-HarnessVariables.ps1 parses scripts (never runs them) and reports such assignments.
const checkout = path.resolve('.');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const checker = path.join(checkout, 'tests', 'windows', 'Test-HarnessVariables.ps1');
const check = async (files: string[]) => {
  const {stdout} = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker, '-Path', files.join('|')],
    {encoding: 'utf8', timeout: 30000, windowsHide: true});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as {files: number; violations: string[]};
};

it('finds a local variable that reuses a parameter\'s name in another case, in a function and at script level', async () => {
  const resources = await temporaryResources();
  try {
    const fixture = path.join(resources.directory, 'Fixture-Shadowing.ps1');
    await writeFile(fixture, [
      'param([string]$StagingInput)',
      '$stagingInput = @{a = 1}',
      '$StagingInput = "kept: the parameter itself, in its own spelling"',
      'function Read-View([string]$Key, [string[]]$Names) {',
      '    $key = 1',
      '    foreach ($names in $Names) { $null = $names }',
      '    [int]$KEY = 2',
      '    $script:key = 3',
      '    function Inner([string]$Other) { $key = 4 }',
      '}',
      ''].join('\r\n'));
    expect(await check([fixture])).toEqual({files: 1, violations: ['Fixture-Shadowing.ps1:2 <script> $stagingInput -> $StagingInput',
      'Fixture-Shadowing.ps1:5 Read-View $key -> $Key', 'Fixture-Shadowing.ps1:6 Read-View $names -> $Names', 'Fixture-Shadowing.ps1:7 Read-View $KEY -> $Key']});
  } finally {await resources.dispose();}
}, 40000);

it('keeps every tracked PowerShell script of the scripts, resources and Windows test folders free of that collision', async () => {
  const files = execFileSync('git', ['-C', checkout, 'ls-files', '--', 'scripts/*.ps1', 'resources/*.ps1', 'tests/windows/*.ps1'], {encoding: 'utf8', windowsHide: true})
    .split(/\r?\n/).filter(Boolean).map(file => path.join(checkout, file));
  expect(files).toContain(path.join(checkout, 'scripts', 'installer', 'Invoke-InstallerLifecycle.ps1'));
  expect(files).toContain(path.join(checkout, 'scripts', 'ci', 'Invoke-RuntimeSmoke.ps1'));
  expect(await check(files)).toEqual({files: files.length, violations: []});
}, 40000);
