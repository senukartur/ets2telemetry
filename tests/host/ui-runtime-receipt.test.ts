import {expect, it} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporaryResources} from '../shared/resources';
import {receiptBatchTimeout, validateRuntimeReceipts} from '../shared/runtime-receipt-validator';

const screens = {shell: ['live', 'hardMode', 'journal', 'settings', 'account'], live: ['current', 'zero', 'missing', 'paused', 'stale'],
  journal: ['list', 'mode-trip', 'weak-mode-trip', 'trip', 'intervals', 'timeline', 'samples'], settings: ['general', 'overlay', 'overlay-sections', 'plugin', 'about', 'data', 'save-error'], overlay: ['strip', 'card', 'cluster', 'hud']};
const common = ['bilingual', 'bothSizes', 'security', 'offlineFonts', 'recordingIndicator', 'osPointerIsolated', 'hoverUnderDesktopCursor', 'versionLine', 'updateHidden'];
const flags = {shell: ['navigation', 'headingFocus','hardModePage', 'journalUnmount', 'exitHintKeyboard', 'exitAvailable', 'noAccountPlaceholder', 'accountBuildConfiguration'],
  live: ['numericGauge', 'unavailableVsZero', 'paused', 'staleDashes', 'rawNames', 'noTripPlaceholder', 'jobViewport', 'jobRowsAfterV1Gap', 'hmNamesReadable','fullWidthTelemetry','tankUnknownVsZero','mandatoryBreak'],
  journal: ['syntheticBanner', 'pageReturn', 'chartBounded', 'rawTabs', 'noPlannedSearch', 'tripRegions', 'tableReadable','signedChart','syncHidden'], settings: ['allPanels', 'allSections', 'committedSave', 'sourceSelector', 'uninstallRefusal', 'refusedSave', 'readOnly', 'controlsKeyboard', 'lastEnabled', 'fontLicense', 'overlayVisibility', 'visibilityFailedSave', 'actionResult', 'overlayOpacity','opacityFailedSave','opacityReadOnly','overlayUnified', 'overlayEditing', 'overlayScroll', 'scaleControl', 'gearDisplay', 'gearDisplayFailedSave'],
  overlay: ['fourLayouts', 'transparent', 'contained', 'independentFont', 'missing', 'paused', 'staleDashes', 'heroSubsets','formatterProfiles', 'stableNumbers', 'opacityKeyboardFocus','opacityGestures','backgroundOpacityOverlay','clusterRpmContained', 'scaleRange', 'clusterSpeedArc', 'gearDisplayManual', 'gearboxLabels','overlayExamplePreview']};
// ET-045e: six English 1280x800 overlay scale references, captured at their own window sizes, beside the 64 layout screenshots.
const references = ['scale-strip', 'scale-card', 'scale-cluster', 'scale-hud', 'scale-strip-old70', 'scale-strip-old100'];
const previewScreens = ['settings-preview-strip', 'settings-preview-card', 'settings-preview-cluster', 'settings-preview-hud', 'settings-preview-narrow'];
const previewNames = ['strip', 'card', 'cluster', 'hud', 'narrow-strip', 'large-strip', 'large-card'];
const previewSections = ['speed', 'gear', 'rpm', 'cruise-control', 'fuel', 'range', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income', 'game-time', 'mandatory-break'];
type Case = keyof typeof screens;
const sizes = [{width: 1280, height: 800}, {width: 1100, height: 720}];
const mainEvents = [{event: 'APP_EXIT', detail: {code: 0}}, {event: 'SERVICE_EXIT', detail: {code: 0}}];
const serviceEvents = [{event: 'STORAGE_VERIFIED'}, ...['ingestion', 'capture', 'storage-probe'].map(name => ({event: 'SHUTDOWN_STEP', facts: {name, outcome: 'ok'}})), {event: 'SERVICE_REPORT', detail: {type: 'stopped', clean: true}}];
const windows = [{url: 'file:///app/renderer/index.html', rendererPid: 100, sandbox: true, isolation: true, node: false, isDefaultSession: true, isOverlaySession: false, sessionPersistent: true, alwaysOnTop: false},
  {url: 'file:///app/renderer/index.html?view=overlay', rendererPid: 101, sandbox: true, isolation: true, node: false, isDefaultSession: false, isOverlaySession: true, sessionPersistent: false, alwaysOnTop: true}];
const uploadScreens = ['no-token', 'confirmation', 'first-upload', 'offline', 'journal'];
const uploadFlags = ['paste', 'password', 'visibility', 'enter', 'tokenCleared', 'cancelNavigation', 'cancelConfirmation', 'confirmNavigation', 'fixedRefusals', 'progress', 'chipNavigation', 'rowStates', 'headingFocus', 'contained', 'sharedStyles', 'bridgeIsolation'];
function uploadFixture() {
  return {origin: 'synthetic', passed: true, productionAuthority: false, tokenPresentInScreenshots: false, moduleGraphs: [8, 6, 2100],
    flags: Object.fromEntries(uploadFlags.map(flag => [flag, true])),
    security: {sandbox: true, contextIsolation: true, nodeIntegration: false, persistentSession: false, localDocument: true, remoteFetchDenied: true, navigationDenied: true, newWindowDenied: true, permissionsDenied: true},
    screenshots: ['en', 'ru'].flatMap(language => sizes.flatMap(size => uploadScreens.map(screen => ({file: `ui-upload-${screen}-${language}-${size.width}x${size.height}.png`, screen, language, ...size, imageWidth: size.width, imageHeight: size.height, bytes: 600, tokenCleared: true}))))};
}
function fixture(uiCase: Case) {
  return {passed: true, commit: 'candidate', mode: 'packaged', scenarioKind: 'ui', phases: ['upload-ui-fixture-started', 'upload-ui-fixture-completed', 'telemetry-source-started', 'launch-requested'].map(phase => ({phase})), uploadUi: uiCase === 'shell' ? uploadFixture() : undefined, // ET-050: the settings shard refuses units, visibility, opacity and gear display once per language and size (16, before 12).
    mainEvents: [...mainEvents, ...Array.from({length: 16}, () => ({event: 'SETTINGS_WRITE_FAILED', facts: {step: 'target', code: null}}))], serviceEvents, ui: {case: uiCase, languages: ['en', 'ru'], sizes,
    dashboardConfigured: false, firstLauncherExit: 0, saveFailureFacts: Array.from({length: 16}, () => ({step: 'target', code: null})),
    readOnly: {state: 'newer-version', writable: false, language: 'en', bytesUnchanged: true, launcherExit: 0, windows, mainEvents: [...mainEvents, {event: 'SETTINGS_FALLBACK', facts: {state: 'newer-version'}}], serviceEvents},
    flags: Object.fromEntries([...common, ...flags[uiCase]].map(flag => [flag, true])),
    overlayPreview: uiCase === 'overlay' ? ['en', 'ru'].flatMap(language => previewNames.map(name => ({language, viewportWidth: 1280, viewportHeight: 800, name,
      layout: name.endsWith('strip') ? 'strip' : name.endsWith('card') ? 'card' : name, scale: name.startsWith('large-') ? '3' : '1',
      width: 210, height: 320, outside: [] as string[], fitsScene: true, sections: [...previewSections],
      cardRows: name.endsWith('card') ? {count: 14, display: ['inline'], verticalAlign: ['-2px'], sameLine: true, matchesActual: true} : undefined}))) : [],
    screenshots: ['en', 'ru'].flatMap(language => sizes.flatMap(size => (uiCase === 'overlay' ? screens.overlay.flatMap(layout => [layout, `${layout}-missing`, `${layout}-paused`, `${layout}-stale`]) : screens[uiCase]).map(screen => ({file: `ui-${uiCase}-${screen}-${language}-${size.width}x${size.height}.png`, language,
      ...size, screen, imageWidth: size.width, imageHeight: size.height, bytes: 600})))).concat(uiCase === 'settings' ? sizes.map(size => ({file: `ui-settings-read-only-en-${size.width}x${size.height}.png`, language: 'en', ...size, screen: 'read-only', imageWidth: size.width, imageHeight: size.height, bytes: 600})) : [])
      .concat(uiCase === 'overlay' ? references.map(screen => ({file: `ui-overlay-${screen}-en-1280x800.png`, language: 'en', ...sizes[0], screen, imageWidth: 1280, imageHeight: 56, bytes: 600})) : [])
      .concat(uiCase === 'overlay' ? ['en', 'ru'].flatMap(language => previewScreens.map(screen => ({file: `ui-overlay-${screen}-${language}-1280x800.png`, language, ...sizes[0], screen, imageWidth: 1280, imageHeight: 800, bytes: 600}))) : [])}};
}
type Fixture = ReturnType<typeof fixture>;
// Deliberately inert, bounded PNG headers: the validator checks identity/dimensions/files; actual pixels are reviewed separately.
const png = (width: number, height: number) => {const bytes = Buffer.alloc(600); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;};
const variants: {name: string; uiCase: Case; change?: (value: Fixture) => void; omitFile?: boolean; badPng?: boolean; omitScreen?: string; badScreen?: string; accepted?: boolean}[] = [
    ...Object.keys(screens).map(uiCase => ({name: `${uiCase} intact`, uiCase: uiCase as Case, accepted: true})),
    {name: 'absent configured upload fixture', uiCase: 'shell', change: value => {value.uploadUi = undefined;}},
    {name: 'failed configured upload fixture', uiCase: 'shell', change: value => {value.uploadUi!.passed = false;}},
    {name: 'configured fixture production authority', uiCase: 'shell', change: value => {value.uploadUi!.productionAuthority = true;}},
    {name: 'configured fixture token screenshot', uiCase: 'shell', change: value => {value.uploadUi!.screenshots[0].tokenCleared = false;}},
    {name: 'configured fixture missing locale-size-state', uiCase: 'shell', change: value => {value.uploadUi!.screenshots.pop();}},
    {name: 'configured fixture duplicate screenshot', uiCase: 'shell', change: value => {value.uploadUi!.screenshots[0] = {...value.uploadUi!.screenshots[1]};}},
    {name: 'configured fixture node enabled', uiCase: 'shell', change: value => {value.uploadUi!.security.nodeIntegration = true;}},
    {name: 'configured fixture missing module graphs', uiCase: 'shell', change: value => {Reflect.deleteProperty(value.uploadUi!, 'moduleGraphs');}},
    {name: 'configured fixture unchecked renderer build', uiCase: 'shell', change: value => {value.uploadUi!.moduleGraphs.pop();}},
    {name: 'configured fixture empty module graph', uiCase: 'shell', change: value => {value.uploadUi!.moduleGraphs[0] = 0;}},
    {name: 'configured fixture extra bridge authority', uiCase: 'shell', change: value => {value.uploadUi!.flags.bridgeIsolation = false;}},
    {name: 'configured fixture permission allowed', uiCase: 'shell', change: value => {value.uploadUi!.security.permissionsDenied = false;}},
    {name: 'missing packaged Dashboard state', uiCase: 'shell', change: value => {Reflect.deleteProperty(value.ui, 'dashboardConfigured');}},
    {name: 'configured fixture reordered launch phases', uiCase: 'shell', change: value => {value.phases.reverse();}},
    {name: 'configured fixture missing source phase', uiCase: 'shell', change: value => {value.phases.splice(2, 1);}},
    {name: 'configured fixture remote request allowed', uiCase: 'shell', change: value => {value.uploadUi!.security.remoteFetchDenied = false;}},
    ...uploadFlags.map(flag => ({name: `configured fixture absent ${flag}`, uiCase: 'shell' as const, change: (value: Fixture) => {delete value.uploadUi!.flags[flag];}})),
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
    ...['mode-trip', 'weak-mode-trip'].map(screen => ({name: `missing RU minimum-size ${screen}`, uiCase: 'journal' as const, change: (value: Fixture) => {value.ui.screenshots = value.ui.screenshots.filter(shot => !(shot.screen === screen && shot.language === 'ru' && shot.width === 1100));}})),
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
    ...previewScreens.map(screen => ({name: `missing RU ${screen}`, uiCase: 'overlay' as const, change: (value: Fixture) => {value.ui.screenshots = value.ui.screenshots.filter(shot => !(shot.screen === screen && shot.language === 'ru'));}})),
    {name: 'preview file absent', uiCase: 'overlay', omitScreen: 'settings-preview-narrow'},
    {name: 'preview PNG signature invalid', uiCase: 'overlay', badScreen: 'settings-preview-card'},
    {name: 'preview PNG has incorrect metadata', uiCase: 'overlay', change: value => {value.ui.screenshots.find(shot => shot.screen === 'settings-preview-card')!.imageHeight = 799;}},
    {name: 'preview screenshot duplicates another identity', uiCase: 'overlay', change: value => {const index = value.ui.screenshots.findIndex(shot => shot.screen === 'settings-preview-card'); value.ui.screenshots[index] = {...value.ui.screenshots[index + 1]};}},
    {name: 'preview screenshot uses another viewport', uiCase: 'overlay', change: value => {value.ui.screenshots.find(shot => shot.screen === 'settings-preview-strip')!.width = 1100;}},
    {name: 'preview screenshot filename escapes', uiCase: 'overlay', change: value => {value.ui.screenshots.find(shot => shot.screen === 'settings-preview-hud')!.file = '../outside.png';}},
    {name: 'preview observation missing', uiCase: 'overlay', change: value => {value.ui.overlayPreview.pop();}},
    {name: 'preview observation duplicates another identity', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0] = {...value.ui.overlayPreview[1]};}},
    {name: 'preview observation wrong viewport', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].viewportWidth = 1100;}},
    {name: 'preview observation wrong layout', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].layout = 'card';}},
    {name: 'large preview uses saved scale', uiCase: 'overlay', change: value => {value.ui.overlayPreview.find(row => row.name === 'large-card')!.scale = '1';}},
    {name: 'preview sections omitted', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].sections.pop();}},
    {name: 'preview sections reordered', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].sections.reverse();}},
    {name: 'preview has escaped rows', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].outside = ['overlay-section-cargo'];}},
    {name: 'preview does not fit scene', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].fitsScene = false;}},
    {name: 'preview has no visible bounds', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].height = 0;}},
    {name: 'preview width exceeds viewport', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].width = 1281;}},
    {name: 'preview bounds invalid', uiCase: 'overlay', change: value => {value.ui.overlayPreview[0].height = Number.NaN;}},
    {name: 'Card preview loses fixed footer row', uiCase: 'overlay', change: value => {value.ui.overlayPreview[1].cardRows!.count = 13;}},
    {name: 'Card preview has block icons', uiCase: 'overlay', change: value => {value.ui.overlayPreview[1].cardRows!.display = ['block'];}},
    {name: 'Card preview has mismatched vertical alignment', uiCase: 'overlay', change: value => {value.ui.overlayPreview[1].cardRows!.verticalAlign = ['baseline'];}},
    {name: 'Card preview label breaks line', uiCase: 'overlay', change: value => {value.ui.overlayPreview[1].cardRows!.sameLine = false;}},
    {name: 'Card preview lacks actual comparison', uiCase: 'overlay', change: value => {value.ui.overlayPreview[1].cardRows!.matchesActual = false;}},
    // ET-045d: the stable strip numbers and the contained Cluster centre are mandatory overlay assertions; ET-045f adds the
    // Cluster speed arc.
    ...['formatterProfiles', 'stableNumbers', 'opacityKeyboardFocus','opacityGestures','backgroundOpacityOverlay','clusterRpmContained', 'scaleRange', 'clusterSpeedArc', 'gearDisplayManual', 'gearboxLabels','overlayExamplePreview'].flatMap(flag => [
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
it('requires every UI language/size/screen, assertion and plain screenshot file without relaxing other receipts', async () => {
  const resources = await temporaryResources();
  try {
    const inputs = [];
    for (const [index, variant] of variants.entries()) {
      const directory = path.join(resources.directory, String(index)); await mkdir(directory);
      const value = fixture(variant.uiCase);
      for (const [imageIndex, shot] of [...value.ui.screenshots, ...(value.uploadUi?.screenshots ?? [])].entries()) {
        if ((variant.omitFile && imageIndex === 0) || (variant.omitScreen === shot.screen && shot.language === 'ru')) continue;
        await writeFile(path.join(directory, shot.file), (variant.badPng && imageIndex === 0) || variant.badScreen === shot.screen ? Buffer.alloc(600) : png(shot.imageWidth, shot.imageHeight));
      }
      variant.change?.(value);
      const receipt = path.join(directory, 'result.json'); await writeFile(receipt, JSON.stringify(value));
      inputs.push({receipt, code: 0, scenario: 'ui', uiCase: variant.uiCase});
    }
    const results = await validateRuntimeReceipts(resources.directory, inputs);
    variants.forEach((variant, index) => expect(results[index], variant.name).toMatchObject({passed: variant.accepted === true, driverResultAvailable: true,
      reason: variant.accepted ? null : 'UI_RESULT_INCOMPLETE_OR_INVALID'}));
  } finally {await resources.dispose();}
}, receiptBatchTimeout(variants.length) + 5000);
