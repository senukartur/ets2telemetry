import {describe, expect, it} from 'vitest';
import type {DiagnosticsExportResult, PluginFolderChoice} from '../../packages/contracts/src';
import {actionResultId, createPluginActionController, SHOW_FILE_REFUSAL_SEVERITY, PLUGIN_ACTION_ANSWERS, pluginActionResultText, pluginActionSeverity, pluginActionSlot, pluginActionTriggerId, type ActionSeverity, type PluginAction,
  type PluginActionOutcome, type PluginActionResult} from '../../apps/desktop/src/plugin-action-result';

// REG-015 (ET-045b): every answer of a Game plugin card action has a hand-written severity, and representative results a
// hand-written EN/RU title and message. Nothing produced here may carry a path.

describe('severity of every answer', () => {
  const FOLDER: [PluginFolderChoice, ActionSeverity][] = [
    [{outcome: 'chosen'}, 'success'],
    [{outcome: 'cancelled'}, 'info'],
    [{outcome: 'refused', code: 'FOLDER_DUPLICATE'}, 'info'],
    [{outcome: 'refused', code: 'REGISTRY_UNAVAILABLE'}, 'failed'],
    [{outcome: 'refused', code: 'FOLDER_UNSUPPORTED_PATH'}, 'refused'],
    [{outcome: 'refused', code: 'FOLDER_NOT_GAME'}, 'refused'],
    [{outcome: 'refused', code: 'FOLDER_WRONG_GAME'}, 'refused'],
    [{outcome: 'refused', code: 'FOLDER_LINKED'}, 'refused'],
    [{outcome: 'refused', code: 'SETUP_DISABLED'}, 'refused'],
    [{outcome: 'refused', code: 'BUSY'}, 'refused']
  ];
  it.each(FOLDER)('folder choice %j is %s', (choice, severity) => {
    expect(pluginActionSeverity({kind: 'folder-choice', choice})).toBe(severity);
  });
  it('classifies both show-file answers', () => {
    expect(SHOW_FILE_REFUSAL_SEVERITY).toEqual({BUNDLE_UNAVAILABLE: 'failed'});
    expect(pluginActionSeverity({kind: 'show-file', result: {outcome: 'shown'}})).toBe('success');
    expect(pluginActionSeverity({kind: 'show-file', result: {outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'}})).toBe('failed');
  });
  const EXPORT: [DiagnosticsExportResult, ActionSeverity][] = [
    [{outcome: 'saved'}, 'success'],
    [{outcome: 'cancelled'}, 'info'],
    [{outcome: 'refused', code: 'EXPORT_IN_PROGRESS'}, 'refused'],
    [{outcome: 'refused', code: 'EXPORT_INTERRUPTED'}, 'refused'],
    [{outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'}, 'refused'],
    [{outcome: 'failed', code: 'DIALOG_FAILED'}, 'failed'],
    [{outcome: 'failed', code: 'BUNDLE_FAILED'}, 'failed'],
    [{outcome: 'failed', code: 'EXPORT_WRITE_FAILED'}, 'failed']
  ];
  it.each(EXPORT)('diagnostics export %j is %s', (result, severity) => {
    expect(pluginActionSeverity({kind: 'diagnostics-export', result})).toBe(severity);
  });
  it('treats a rejected call as a failure', () => {
    expect(pluginActionSeverity({kind: 'request-failed'})).toBe('failed');
  });
});

describe('successful answers', () => {
  it('shows no invented success line for the switch, Retry or an opened folder', () => {
    expect(PLUGIN_ACTION_ANSWERS.manage()).toBeNull();
    expect(PLUGIN_ACTION_ANSWERS.retry()).toBeNull();
    expect(PLUGIN_ACTION_ANSWERS.openFolder()).toBeNull();
  });
  it('keeps the fixed answer of the folder dialog, Show plugin file and the export', () => {
    expect(PLUGIN_ACTION_ANSWERS.chooseFolder({outcome: 'cancelled'})).toEqual({kind: 'folder-choice', choice: {outcome: 'cancelled'}});
    expect(PLUGIN_ACTION_ANSWERS.showFile({outcome: 'shown'})).toEqual({kind: 'show-file', result: {outcome: 'shown'}});
    expect(PLUGIN_ACTION_ANSWERS.exportDiagnostics({outcome: 'saved'})).toEqual({kind: 'diagnostics-export', result: {outcome: 'saved'}});
  });
});

describe('region and trigger ids', () => {
  const CASES: [PluginAction, string, string][] = [
    [{kind: 'manage', game: 'ets2'}, 'plugin-ets2-managed', 'plugin-ets2-managed'],
    [{kind: 'choose-folder', game: 'ats'}, 'plugin-ats-choose', 'plugin-ats-choose'],
    [{kind: 'show-file', game: 'ets2', targetId: 'ets2:steam:0'}, 'plugin-target-ets2-steam-0', 'plugin-target-ets2-steam-0-show-file'],
    [{kind: 'open-folder', game: 'ets2', targetId: 'ets2:manual:0'}, 'plugin-target-ets2-manual-0', 'plugin-target-ets2-manual-0-open-folder'],
    [{kind: 'retry'}, 'plugin-retry', 'plugin-retry'],
    [{kind: 'export-diagnostics'}, 'plugin-export-diagnostics', 'plugin-export-diagnostics']
  ];
  it.each(CASES)('%j has slot %s and trigger %s', (action, slot, trigger) => {
    expect(pluginActionSlot(action)).toBe(slot);
    expect(pluginActionTriggerId(action)).toBe(trigger);
    expect(actionResultId(slot)).toBe(`${slot}-result`);
  });
});

describe('localized text', () => {
  const duplicate: PluginActionOutcome = {kind: 'folder-choice', choice: {outcome: 'refused', code: 'FOLDER_DUPLICATE'}};
  it('names the ATS folder duplicate as information, never an error', () => {
    expect(pluginActionResultText({action: {kind: 'choose-folder', game: 'ats'}, outcome: duplicate}, null, 'en')).toEqual({severity: 'info', severityWord: 'Information',
      title: 'Information — Game folder for American Truck Simulator', message: 'This game folder is already found through Steam; nothing changed.'});
    expect(pluginActionResultText({action: {kind: 'choose-folder', game: 'ats'}, outcome: duplicate}, null, 'ru')).toEqual({severity: 'info', severityWord: 'Информация',
      title: 'Информация — Папка игры для American Truck Simulator', message: 'Эта папка игры уже найдена через Steam; ничего не изменено.'});
  });
  it('names the game and folder of a show-file failure', () => {
    const result = {action: {kind: 'show-file', game: 'ets2', targetId: 'ets2:steam:0'}, outcome: {kind: 'show-file', result: {outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'}}} as const;
    expect(pluginActionResultText(result, 'Steam folder 1', 'en')).toEqual({severity: 'failed', severityWord: 'Failed',
      title: 'Failed — Plugin file for Euro Truck Simulator 2 (Steam folder 1)', message: 'The bundled plugin file is not available; nothing was shown.'});
    expect(pluginActionResultText(result, 'Папка Steam 1', 'ru')).toEqual({severity: 'failed', severityWord: 'Ошибка',
      title: 'Ошибка — Файл плагина для Euro Truck Simulator 2 (Папка Steam 1)', message: 'Файл плагина из комплекта недоступен; ничего не показано.'});
  });
  it('shows nothing for a folder that is no longer listed', () => {
    expect(pluginActionResultText({action: {kind: 'open-folder', game: 'ets2', targetId: 'ets2:steam:3'}, outcome: {kind: 'request-failed'}}, null, 'en')).toBeNull();
    expect(pluginActionResultText({action: {kind: 'open-folder', game: 'ats', targetId: 'ats:manual:0'}, outcome: {kind: 'request-failed'}}, 'Chosen folder', 'en')).toEqual({severity: 'failed',
      severityWord: 'Failed', title: 'Failed — Plugins folder of American Truck Simulator (Chosen folder)', message: 'The request failed; nothing changed.'});
  });
  it('describes a cancelled diagnostics export and its rejected request', () => {
    const cancelled = {action: {kind: 'export-diagnostics'}, outcome: {kind: 'diagnostics-export', result: {outcome: 'cancelled'}}} as const;
    expect(pluginActionResultText(cancelled, null, 'en')).toEqual({severity: 'info', severityWord: 'Information', title: 'Information — Diagnostics export',
      message: 'Export cancelled. Nothing was written.'});
    expect(pluginActionResultText(cancelled, null, 'ru')).toEqual({severity: 'info', severityWord: 'Информация', title: 'Информация — Экспорт диагностики',
      message: 'Экспорт отменён. Ничего не записано.'});
    expect(pluginActionResultText({action: {kind: 'export-diagnostics'}, outcome: {kind: 'request-failed'}}, null, 'en')?.message).toBe('The diagnostics export request failed.');
    expect(pluginActionResultText({action: {kind: 'export-diagnostics'}, outcome: {kind: 'diagnostics-export', result: {outcome: 'saved'}}}, null, 'ru'))
      .toMatchObject({severity: 'success', severityWord: 'Готово', message: 'Диагностика сохранена.'});
  });
  it('describes rejected retry and management calls', () => {
    expect(pluginActionResultText({action: {kind: 'retry'}, outcome: {kind: 'request-failed'}}, null, 'en')).toEqual({severity: 'failed', severityWord: 'Failed',
      title: 'Failed — Plugin setup retry', message: 'The request failed; nothing changed.'});
    expect(pluginActionResultText({action: {kind: 'retry'}, outcome: {kind: 'request-failed'}}, null, 'ru')).toEqual({severity: 'failed', severityWord: 'Ошибка',
      title: 'Ошибка — Повтор настройки плагина', message: 'Запрос не выполнен; ничего не изменено.'});
    expect(pluginActionResultText({action: {kind: 'manage', game: 'ats'}, outcome: {kind: 'request-failed'}}, null, 'ru')?.title).toBe('Ошибка — Управление плагином для American Truck Simulator');
    expect(pluginActionResultText({action: {kind: 'manage', game: 'ets2'}, outcome: {kind: 'request-failed'}}, null, 'en')?.title).toBe('Failed — Plugin management for Euro Truck Simulator 2');
  });
  it('words a refusal as refused in both languages', () => {
    const refused = {action: {kind: 'choose-folder', game: 'ets2'}, outcome: {kind: 'folder-choice', choice: {outcome: 'refused', code: 'FOLDER_WRONG_GAME'}}} as const;
    expect(pluginActionResultText(refused, null, 'en')).toMatchObject({severity: 'refused', title: 'Refused — Game folder for Euro Truck Simulator 2', message: 'This folder holds the other game.'});
    expect(pluginActionResultText(refused, null, 'ru')?.severityWord).toBe('Отклонено');
    expect(pluginActionResultText({action: {kind: 'choose-folder', game: 'ets2'}, outcome: {kind: 'folder-choice', choice: {outcome: 'chosen'}}}, null, 'en')?.severityWord).toBe('Done');
  });
  it('never carries a path', () => {
    const actions: PluginAction[] = [{kind: 'manage', game: 'ets2'}, {kind: 'choose-folder', game: 'ats'}, {kind: 'show-file', game: 'ets2', targetId: 'ets2:steam:0'},
      {kind: 'open-folder', game: 'ats', targetId: 'ats:manual:0'}, {kind: 'retry'}, {kind: 'export-diagnostics'}];
    const outcomes: PluginActionOutcome[] = [{kind: 'request-failed'}, {kind: 'folder-choice', choice: {outcome: 'refused', code: 'FOLDER_UNSUPPORTED_PATH'}},
      {kind: 'show-file', result: {outcome: 'shown'}}, {kind: 'diagnostics-export', result: {outcome: 'failed', code: 'EXPORT_WRITE_FAILED'}}];
    const texts = (['en', 'ru'] as const).flatMap(language => actions.flatMap(action => outcomes.map(outcome => pluginActionResultText({action, outcome}, 'Steam folder 1', language))));
    expect(texts.every(Boolean)).toBe(true);
    expect(JSON.stringify(texts)).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\|steamapps|win_x64/);
  });
});

describe('the card action controller', () => {
  const BODY = {element: 'body'}, ELSEWHERE = {element: 'another control'};
  function harness(active: () => unknown = () => BODY) {
    const log: string[] = [], focused: string[] = [];
    let pending = false, result: PluginActionResult | null = null;
    const controller = createPluginActionController({
      setPending: value => {pending = value; log.push(`pending ${String(value)}`);},
      setResult: value => {result = value; log.push(value ? `result ${value.outcome.kind}` : 'result cleared');},
      activeElement: active, body: () => BODY, focus: id => {focused.push(id);}
    });
    return {controller, log, focused, state: () => ({pending, result})};
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {resolve = yes;});
    return {promise, resolve};
  }
  const choose = {kind: 'choose-folder', game: 'ats'} as const;

  it('ignores a second press or switch toggle while an action is pending, with no second bridge call', async () => {
    const {controller, state} = harness();
    const first = deferred<{outcome: 'cancelled'}>();
    let calls = 0;
    const settled = controller.run(choose, () => {calls++; return first.promise;}, PLUGIN_ACTION_ANSWERS.chooseFolder);
    expect(settled).not.toBeNull();
    expect(controller.run(choose, () => {calls++; return Promise.resolve({outcome: 'cancelled' as const});}, PLUGIN_ACTION_ANSWERS.chooseFolder)).toBeNull();
    expect(controller.run({kind: 'manage', game: 'ets2'}, () => {calls++; return Promise.resolve(undefined);}, PLUGIN_ACTION_ANSWERS.manage)).toBeNull();
    expect(calls).toBe(1);
    expect(state().pending).toBe(true);
    first.resolve({outcome: 'cancelled'});
    await settled;
    expect(state()).toEqual({pending: false, result: {action: choose, outcome: {kind: 'folder-choice', choice: {outcome: 'cancelled'}}}});
    // Once settled, the next action starts again.
    expect(controller.run(choose, () => {calls++; return Promise.resolve({outcome: 'cancelled' as const});}, PLUGIN_ACTION_ANSWERS.chooseFolder)).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('turns a rejected or throwing bridge call into a failed result of that action', async () => {
    const {controller, state} = harness();
    const retry = {kind: 'retry'} as const;
    await controller.run(retry, () => Promise.reject(new Error('IPC refused')), PLUGIN_ACTION_ANSWERS.retry);
    expect(state()).toEqual({pending: false, result: {action: retry, outcome: {kind: 'request-failed'}}});
    expect(pluginActionResultText(state().result!, null, 'en')?.severity).toBe('failed');
    const show = {kind: 'show-file', game: 'ets2', targetId: 'ets2:steam:0'} as const;
    await controller.run(show, () => {throw new Error('no bridge');}, PLUGIN_ACTION_ANSWERS.showFile);
    expect(state()).toEqual({pending: false, result: {action: show, outcome: {kind: 'request-failed'}}});
  });

  it('clears the shown result when the next action starts, and a successful switch change shows none', async () => {
    const {controller, log, state} = harness();
    await controller.run(choose, () => Promise.resolve({outcome: 'refused' as const, code: 'FOLDER_DUPLICATE' as const}), PLUGIN_ACTION_ANSWERS.chooseFolder);
    expect(state().result?.outcome).toEqual({kind: 'folder-choice', choice: {outcome: 'refused', code: 'FOLDER_DUPLICATE'}});
    const manage = deferred<undefined>();
    const settled = controller.run({kind: 'manage', game: 'ats'}, () => manage.promise, PLUGIN_ACTION_ANSWERS.manage);
    expect(state()).toEqual({pending: true, result: null});
    manage.resolve(undefined);
    await settled;
    expect(state()).toEqual({pending: false, result: null});
    expect(log).toEqual(['pending true', 'result cleared', 'pending false', 'result folder-choice', 'pending true', 'result cleared', 'pending false', 'result cleared']);
  });

  it('returns focus to the trigger only when focus was lost to the body or to nothing', async () => {
    let active: unknown = BODY;
    const {controller, focused} = harness(() => active);
    await controller.run(choose, () => Promise.resolve({outcome: 'cancelled' as const}), PLUGIN_ACTION_ANSWERS.chooseFolder);
    active = null;
    await controller.run({kind: 'show-file', game: 'ets2', targetId: 'ets2:manual:0'}, () => Promise.resolve({outcome: 'shown' as const}), PLUGIN_ACTION_ANSWERS.showFile);
    active = ELSEWHERE;
    await controller.run({kind: 'export-diagnostics'}, () => Promise.resolve({outcome: 'saved' as const}), PLUGIN_ACTION_ANSWERS.exportDiagnostics);
    expect(focused).toEqual(['plugin-ats-choose', 'plugin-target-ets2-manual-0-show-file']);
  });
});
