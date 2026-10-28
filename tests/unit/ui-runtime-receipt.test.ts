import {expect, it} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

const screens = {shell: ['live', 'hardMode', 'journal', 'settings', 'account'], live: ['current', 'zero', 'missing', 'paused', 'stale'],
  journal: ['list', 'trip', 'intervals', 'timeline', 'samples'], settings: ['general', 'units', 'overlay', 'overlay-sections', 'plugin', 'data', 'about', 'save-error'], overlay: ['strip', 'card', 'cluster', 'hud']};
const common = ['bilingual', 'bothSizes', 'security', 'offlineFonts', 'recordingIndicator', 'versionLine', 'updateHidden'];
const flags = {shell: ['navigation', 'headingFocus','hardModePage', 'journalUnmount', 'menuKeyboard', 'exitAvailable', 'laterAccount'],
  live: ['numericGauge', 'unavailableVsZero', 'paused', 'staleDashes', 'rawNames', 'unsupportedTrip', 'jobViewport', 'hmNamesReadable','fullWidthTelemetry','tankUnknownVsZero','mandatoryBreak'],
  journal: ['syntheticBanner', 'pageReturn', 'chartBounded', 'rawTabs', 'searchPlanned', 'tripRegions', 'tableReadable','signedChart'], settings: ['allPanels', 'allSections', 'committedSave', 'sourceSelector', 'uninstallRefusal', 'refusedSave', 'readOnly', 'controlsKeyboard', 'lastEnabled', 'fontLicense', 'overlayVisibility', 'visibilityFailedSave', 'actionResult', 'overlayOpacity','opacityFailedSave','opacityReadOnly','overlayUnified', 'overlayEditing', 'overlayScroll', 'scaleControl', 'gearDisplay', 'gearDisplayFailedSave'],
  overlay: ['fourLayouts', 'transparent', 'contained', 'independentFont', 'missing', 'paused', 'staleDashes', 'heroSubsets','formatterProfiles', 'stableNumbers', 'opacityKeyboardFocus','opacityGestures','backgroundOpacityOverlay','clusterRpmContained', 'scaleRange', 'clusterSpeedArc', 'gearDisplayManual', 'gearboxLabels']};
// ET-045e: six English 1280x800 overlay scale references, captured at their own window sizes, beside the 64 layout screenshots.
const references = ['scale-strip', 'scale-card', 'scale-cluster', 'scale-hud', 'scale-strip-old70', 'scale-strip-old100'];
type Case = keyof typeof screens;
const sizes = [{width: 1280, height: 800}, {width: 1100, height: 720}];
const mainEvents = [{event: 'APP_EXIT', detail: {code: 0}}, {event: 'SERVICE_EXIT', detail: {code: 0}}];
const serviceEvents = [{event: 'STORAGE_VERIFIED'}, ...['ingestion', 'capture', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})), {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
const windows = [{url: 'file:///app/renderer/index.html', rendererPid: 100, sandbox: true, isolation: true, node: false, isDefaultSession: true, isOverlaySession: false, sessionPersistent: true, alwaysOnTop: false},
  {url: 'file:///app/renderer/index.html?view=overlay', rendererPid: 101, sandbox: true, isolation: true, node: false, isDefaultSession: false, isOverlaySession: true, sessionPersistent: false, alwaysOnTop: true}];
function fixture(uiCase: Case) {
  return {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'ui', // ET-050: the settings shard refuses units, visibility, opacity and gear display once per language and size (16, before 12).
    mainEvents: [...mainEvents, ...Array.from({length: 16}, () => ({event: 'SETTINGS_WRITE_FAILED', facts: {step: 'target', code: null}}))], serviceEvents, ui: {case: uiCase, languages: ['en', 'ru'], sizes,
    firstLauncherExit: 0, saveFailureFacts: Array.from({length: 16}, () => ({step: 'target', code: null})),
    readOnly: {state: 'newer-version', writable: false, language: 'en', bytesUnchanged: true, launcherExit: 0, windows, mainEvents: [...mainEvents, {event: 'SETTINGS_FALLBACK', facts: {state: 'newer-version'}}], serviceEvents},
    flags: Object.fromEntries([...common, ...flags[uiCase]].map(flag => [flag, true])),
    screenshots: ['en', 'ru'].flatMap(language => sizes.flatMap(size => (uiCase === 'overlay' ? screens.overlay.flatMap(layout => [layout, `${layout}-missing`, `${layout}-paused`, `${layout}-stale`]) : screens[uiCase]).map(screen => ({file: `ui-${uiCase}-${screen}-${language}-${size.width}x${size.height}.png`, language,
      ...size, screen, imageWidth: size.width, imageHeight: size.height, bytes: 600})))).concat(uiCase === 'settings' ? sizes.map(size => ({file: `ui-settings-read-only-en-${size.width}x${size.height}.png`, language: 'en', ...size, screen: 'read-only', imageWidth: size.width, imageHeight: size.height, bytes: 600})) : [])
      .concat(uiCase === 'overlay' ? references.map(screen => ({file: `ui-overlay-${screen}-en-1280x800.png`, language: 'en', ...sizes[0], screen, imageWidth: 1280, imageHeight: 56, bytes: 600})) : [])}};
}
type Fixture = ReturnType<typeof fixture>;
// Deliberately inert, bounded PNG headers: the validator checks identity/dimensions/files; actual pixels are reviewed separately.
const png = (width: number, height: number) => {const bytes = Buffer.alloc(600); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;};
it('requires every UI language/size/screen, assertion and plain screenshot file without relaxing other receipts', async () => {
  const resources = await temporaryResources();
  const variants: {name: string; uiCase: Case; change?: (value: Fixture) => void; omitFile?: boolean; badPng?: boolean; accepted?: boolean}[] = [
    ...Object.keys(screens).map(uiCase => ({name: `${uiCase} intact`, uiCase: uiCase as Case, accepted: true})),
    {name: 'read-only writable contradiction', uiCase: 'settings', change: value => {value.ui.readOnly.writable = true;}},
    {name: 'forced future-format language', uiCase: 'settings', change: value => {value.ui.readOnly.language = 'ru';}},
    {name: 'read-only bytes changed', uiCase: 'settings', change: value => {value.ui.readOnly.bytesUnchanged = false;}},
    {name: 'unverified second renderer security', uiCase: 'settings', change: value => {value.ui.readOnly.windows = value.ui.readOnly.windows.map(window => ({...window, sandbox: false}));}},
    {name: 'extra expected error not allowed', uiCase: 'settings', change: value => {value.ui.saveFailureFacts.pop();}},
    {name: 'obsolete separate sections screenshot', uiCase: 'settings', change: value => {const shot = value.ui.screenshots.find(shot => shot.screen === 'overlay-sections')!; shot.screen = 'sections'; shot.file = shot.file.replace('overlay-sections', 'sections');}},
    {name: 'missing unified lower screenshot', uiCase: 'settings', change: value => {value.ui.screenshots = value.ui.screenshots.filter(shot => !(shot.screen === 'overlay-sections' && shot.language === 'ru' && shot.width === 1100));}},
    {name: 'missing language', uiCase: 'live', change: value => {value.ui.languages.pop();}},
    {name: 'missing size', uiCase: 'live', change: value => {value.ui.sizes = value.ui.sizes.slice(0, 1);}},
    {name: 'wrong shard', uiCase: 'live', change: value => {value.ui.case = 'shell';}},
    {name: 'missing minimum-size stale overlay', uiCase: 'overlay', change: value => {value.ui.screenshots = value.ui.screenshots.filter(shot => !(shot.language === 'ru' && shot.width === 1100 && shot.screen === 'cluster-stale'));}},
    {name: 'missing screenshot', uiCase: 'live', change: value => {value.ui.screenshots.pop();}},
    {name: 'duplicate replacing another screenshot', uiCase: 'live', change: value => {value.ui.screenshots[0] = {...value.ui.screenshots[1]};}},
    {name: 'file absent', uiCase: 'live', omitFile: true}, {name: 'invalid PNG signature', uiCase: 'live', badPng: true},
    {name: 'escaping filename', uiCase: 'live', change: value => {value.ui.screenshots[0].file = '../outside.png';}},
    {name: 'wrong image size', uiCase: 'live', change: value => {value.ui.screenshots[0].imageWidth = 1279;}},
    ...['hardModePage'].flatMap(flag => [
      {name: `false shell ${flag}`, uiCase: 'shell' as const, change: (value: Fixture) => {value.ui.flags[flag] = false;}},
      {name: `missing shell ${flag}`, uiCase: 'shell' as const, change: (value: Fixture) => {delete value.ui.flags[flag];}}
    ]),
    // ET-045e: the 50% scale range and its six reference screenshots are mandatory; a missing or wrongly sized reference fails.
    {name: 'missing overlay scale reference', uiCase: 'overlay', change: value => {value.ui.screenshots = value.ui.screenshots.filter(shot => shot.screen !== 'scale-strip-old70');}},
    {name: 'overlay scale reference in another size', uiCase: 'overlay', change: value => {value.ui.screenshots.find(shot => shot.screen === 'scale-hud')!.width = 1100;}},
    {name: 'overlay scale reference with another image size', uiCase: 'overlay', change: value => {value.ui.screenshots.find(shot => shot.screen === 'scale-card')!.imageHeight = 57;}},
    // ET-045d: the stable strip numbers and the contained Cluster centre are mandatory overlay assertions; ET-045f adds the
    // Cluster speed arc.
    ...['formatterProfiles', 'stableNumbers', 'opacityKeyboardFocus','opacityGestures','backgroundOpacityOverlay','clusterRpmContained', 'scaleRange', 'clusterSpeedArc', 'gearDisplayManual', 'gearboxLabels'].flatMap(flag => [
      {name: `false overlay ${flag}`, uiCase: 'overlay' as const, change: (value: Fixture) => {value.ui.flags[flag] = false;}},
      {name: `missing overlay ${flag}`, uiCase: 'overlay' as const, change: (value: Fixture) => {delete value.ui.flags[flag];}}
    ]),
    ...['signedChart'].flatMap(flag => [
      {name: `false journal ${flag}`, uiCase: 'journal' as const, change: (value: Fixture) => {value.ui.flags[flag] = false;}},
      {name: `missing journal ${flag}`, uiCase: 'journal' as const, change: (value: Fixture) => {delete value.ui.flags[flag];}}
    ]),
    ...['controlsKeyboard', 'lastEnabled', 'fontLicense', 'overlayVisibility', 'visibilityFailedSave', 'actionResult', 'overlayOpacity','opacityFailedSave','opacityReadOnly','overlayUnified', 'overlayEditing', 'overlayScroll', 'scaleControl', 'gearDisplay', 'gearDisplayFailedSave'].flatMap(flag => [
      {name: `false settings ${flag}`, uiCase: 'settings' as const, change: (value: Fixture) => {value.ui.flags[flag] = false;}},
      {name: `missing settings ${flag}`, uiCase: 'settings' as const, change: (value: Fixture) => {delete value.ui.flags[flag];}}
    ]),
    ...[...common, ...flags.live].flatMap(flag => [
      {name: `false ${flag}`, uiCase: 'live' as const, change: (value: Fixture) => {value.ui.flags[flag] = false;}},
      {name: `missing ${flag}`, uiCase: 'live' as const, change: (value: Fixture) => {delete value.ui.flags[flag];}}
    ])
  ];
  try {
    const inputs = [];
    for (const [index, variant] of variants.entries()) {
      const directory = path.join(resources.directory, String(index)); await mkdir(directory);
      const value = fixture(variant.uiCase);
      for (const [imageIndex, shot] of value.ui.screenshots.entries()) {
        if (variant.omitFile && imageIndex === 0) continue;
        await writeFile(path.join(directory, shot.file), variant.badPng && imageIndex === 0 ? Buffer.alloc(600) : png(shot.imageWidth, shot.imageHeight));
      }
      variant.change?.(value);
      const receipt = path.join(directory, 'result.json'); await writeFile(receipt, JSON.stringify(value));
      inputs.push({receipt, code: 0, scenario: 'ui', uiCase: variant.uiCase});
    }
    const results = await validateRuntimeReceipts(resources.directory, inputs);
    variants.forEach((variant, index) => expect(results[index], variant.name).toMatchObject({passed: variant.accepted === true, driverResultAvailable: true,
      reason: variant.accepted ? null : 'UI_RESULT_INCOMPLETE_OR_INVALID'}));
  } finally {await resources.dispose();}
}, receiptBatchTimeout(101) + 5000);
