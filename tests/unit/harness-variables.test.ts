import {execFile, execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
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
    {encoding: 'utf8', timeout: 50000, windowsHide: true, maxBuffer: 4 * 1024 * 1024});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as {files: number; violations: string[]};
};

// ET-055 PR-8 (PR-5 review) changed one expectation here: a write in the parameter's own spelling (line 3) was allowed for
// every parameter, and is now reported when the parameter is typed or validated, because `[string]$StagingInput` converts
// that write as well. An own-spelling write to an unconstrained parameter stays allowed (the next test).
it('finds a local variable that reuses a parameter\'s name in another case, in a function and at script level', async () => {
  const resources = await temporaryResources();
  try {
    const fixture = path.join(resources.directory, 'Fixture-Shadowing.ps1');
    await writeFile(fixture, [
      'param([string]$StagingInput)',
      '$stagingInput = @{a = 1}',
      '$StagingInput = "the parameter itself, in its own spelling: converted to [string]"',
      'function Read-View([string]$Key, [string[]]$Names) {',
      '    $key = 1',
      '    foreach ($names in $Names) { $null = $names }',
      '    [int]$KEY = 2',
      '    $script:key = 3',
      '    function Inner([string]$Other) { $key = 4 }',
      '}',
      ''].join('\r\n'));
    expect(await check([fixture])).toEqual({files: 1, violations: ['Fixture-Shadowing.ps1:2 <script> $stagingInput -> $StagingInput',
      'Fixture-Shadowing.ps1:3 <script> $StagingInput -> $StagingInput (constrained)',
      'Fixture-Shadowing.ps1:5 Read-View $key -> $Key', 'Fixture-Shadowing.ps1:6 Read-View $names -> $Names', 'Fixture-Shadowing.ps1:7 Read-View $KEY -> $Key']});
  } finally {await resources.dispose();}
}, 60000);

// ET-055 PR-8 (PR-5 review): the wider set of writes, and a write in the parameter's own spelling when the parameter is
// typed or validated (the RegistryKey of hosted run 40689215872 would have become a string under `$Key = ...` as well).
it('also finds multi-assignments, [ref], -OutVariable, -PipelineVariable and Set-Variable targets, and own-spelling writes to constrained parameters', async () => {
  const resources = await temporaryResources();
  try {
    const fixture = path.join(resources.directory, 'Fixture-Writes.ps1');
    await writeFile(fixture, [
      'param([string]$Name, $Loose, [ValidateSet("a","b")]$Choice, [object]$Anything)',
      '$Loose = 1',
      '$Anything = 2',
      '$Name = "converted to a string"',
      '$Choice = "a"',
      'function Read-Many([string]$First, [string[]]$Rest, $Items, [string]$Result, $Plain) {',
      '    $first, $REST = 1, 2',
      '    $null = [Management.Automation.Language.Parser]::ParseInput("", [ref]$items, [ref]$null)',
      '    Get-Item . -OutVariable result | Out-Null',
      '    Get-Item . -ov +Result | Out-Null',
      '    Get-Item . -PipelineVariable plain | Out-Null',
      '    Set-Variable -Name first -Value 3',
      '    Set-Variable REST 4',
      '    sv -Name:first 5',
      '    $Plain = "own spelling of an unconstrained parameter: allowed"',
      '    Set-Variable -Name Other -Value 6',
      '}',
      // Review round 1: the other variable-naming common parameters, an abbreviation, New-Variable and scope prefixes.
      'function Read-More([string]$Errors, [string]$Warnings, [string]$Notes, $Made, $Scoped, $Hidden, $Kept) {',
      '    Get-Item . -ErrorVariable errors -WarningVariable warnings | Out-Null',
      '    Get-Item . -iv notes -OutVar made | Out-Null',
      '    New-Variable -Name MADE -Value 1',
      '    $local:scoped = 2',
      '    $private:hidden = 3',
      '    $env:Kept = "an environment variable is no parameter"',
      '    Get-Item . -Out kept | Out-Null',
      '}',
      ''].join('\r\n'));
    expect(await check([fixture])).toEqual({files: 1, violations: [
      'Fixture-Writes.ps1:4 <script> $Name -> $Name (constrained)', 'Fixture-Writes.ps1:5 <script> $Choice -> $Choice (constrained)',
      'Fixture-Writes.ps1:7 Read-Many $first -> $First', 'Fixture-Writes.ps1:7 Read-Many $REST -> $Rest',
      'Fixture-Writes.ps1:8 Read-Many $items -> $Items',
      'Fixture-Writes.ps1:9 Read-Many $result -> $Result', 'Fixture-Writes.ps1:10 Read-Many $Result -> $Result (constrained)',
      'Fixture-Writes.ps1:11 Read-Many $plain -> $Plain', 'Fixture-Writes.ps1:12 Read-Many $first -> $First', 'Fixture-Writes.ps1:13 Read-Many $REST -> $Rest',
      'Fixture-Writes.ps1:14 Read-Many $first -> $First',
      'Fixture-Writes.ps1:19 Read-More $errors -> $Errors', 'Fixture-Writes.ps1:19 Read-More $warnings -> $Warnings',
      'Fixture-Writes.ps1:20 Read-More $notes -> $Notes', 'Fixture-Writes.ps1:20 Read-More $made -> $Made', 'Fixture-Writes.ps1:21 Read-More $MADE -> $Made',
      'Fixture-Writes.ps1:22 Read-More $scoped -> $Scoped', 'Fixture-Writes.ps1:23 Read-More $hidden -> $Hidden']});
  } finally {await resources.dispose();}
}, 60000);

// ET-055 PR-8 (PR-5 review): every tracked .ps1 and .psm1 file, no longer only the scripts, resources and Windows test
// folders. The retired ET-001 host harness is the one exception: its body after the fixed RETIRED throw never runs and is
// kept unchanged as the record of that procedure (DECISION-LOG.md, ET-018 authorization).
const RETIRED = [path.join('tests', 'windows', 'Invoke-NativeInstallerAcceptance.ps1')];
it('keeps every tracked PowerShell script and module free of those writes', async () => {
  const files = execFileSync('git', ['-C', checkout, 'ls-files', '--', '*.ps1', '*.psm1'], {encoding: 'utf8', windowsHide: true})
    .split(/\r?\n/).filter(Boolean).map(file => path.join(checkout, file));
  expect(files).toContain(path.join(checkout, 'scripts', 'installer', 'Invoke-InstallerLifecycle.ps1'));
  expect(files).toContain(path.join(checkout, 'scripts', 'ci', 'Invoke-RuntimeSmoke.ps1'));
  expect(files).toContain(path.join(checkout, 'tests', 'watchdog', 'run.ps1'));
  for (const retired of RETIRED) {
    expect(files).toContain(path.join(checkout, retired));
    expect(await readFile(path.join(checkout, retired), 'utf8')).toContain("throw 'RETIRED_ET018_REAL_ROOTS:");
  }
  const checked = files.filter(file => !RETIRED.some(retired => file === path.join(checkout, retired)));
  expect(await check(checked)).toEqual({files: checked.length, violations: []});
}, 60000);
