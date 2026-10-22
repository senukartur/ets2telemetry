import {chooseSource, chooseLanguage} from './ui-navigation.mjs';
// Isolated ET-026 app journey: production file reader/monitor -> recorder -> real SQLite worker -> UI/journal/export.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rm, open} from 'node:fs/promises';
import path from 'node:path';
import {until} from './lifecycle-observation.mjs';
import {clickTestId, openDetail, stubSaveDialog, exportValidator} from './journal-observation.mjs';
import {waitForHardModeProof} from './hard-mode-proof-observation.mjs';
export const HARD_MODE_TARGET = 'synthetic:hard-mode';
const CONFIG = `uset g_fuel_simulation "1"
uset g_hardcore_simulation "1"
uset g_police "1"
uset g_fatigue "1"
uset g_use_speed_limiter "1"
uset g_truck_stability "0.5"
uset g_trailer_stability "0.5"
uset g_simple_parking_doubles "0"
uset g_parking_difficulty "2"
uset g_bad_weather_factor "0.12"
uset g_road_events "0.30"
uset g_brake_intensity "0.75"
uset g_traffic "1.0"`;
export async function startHardModeSource(config) {
  const directory = path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'hard-mode-fixture', 'Documents', 'Euro Truck Simulator 2');
  const id = Buffer.from('Synthetic Hard Mode').toString('hex').toUpperCase(), profile = path.join(directory, 'profiles', id);
  await mkdir(profile, {recursive: true});
  await writeFile(path.join(directory, 'game.log.txt'), `************ : log created on : Tuesday October 20 2026 @ 12:00:00\n00:00:01.000 : New profile selected: 'Synthetic Hard Mode'\n00:00:02.000 : Loading save. Type: 0, path: <MEMFILE><UFS>/home/profiles/${id}/save/autosave/game.sii\n`);
  await writeFile(path.join(directory, 'config.cfg'), 'uset g_traffic "1.0"');
  await writeFile(path.join(profile, 'config_local.cfg'), 'uset g_brake_intensity "0.75"');
  const profileConfig = path.join(profile, 'config.cfg');
  // Missing config initially proves unknown. The driver writes fail and pass bytes in order after the UI is ready.
  const fixture = async name => JSON.parse(await readFile(path.join(config.checkout, 'tests', 'fixtures', 'protocol-v1', `${name}.json`), 'utf8'));
  const welcome = await fixture('welcome'), checkpoint = await fixture('checkpoint'), configured = await fixture('event-job-configured'), delivered = await fixture('event-job-delivered');
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  let socket, timer, seq = 0n, next = 1n, acked = 0n, revision = 1n, order = 1n, ns = 1000000000000n, durable = false;
  const events = [], errors = [], state = structuredClone(checkpoint.data.state);
  state.configuration.job = {available: false, reason: 'not-observed'}; state.configuration.revision = '1'; state.boundaryOrder = '1';
  const capture = () => ({clockId: welcome.capture.clockId, monotonicNs: (ns += 100000000n).toString()});
  const status = () => ({...checkpoint.data.status, delivery: {durable, ackedThroughEventSeq: acked.toString(), nextEventSeq: next.toString(), retainedEvents: 0, retainedBytes: 0, oldestRetainedMonotonicNs: {available: false, reason: 'not-observed'}}});
  const send = (kind, data) => {
    const message = {...welcome, kind, seq: (++seq).toString(), capture: capture(), data};
    if (kind === 'checkpoint') data.boundarySeq = message.seq;
    if (socket && !socket.destroyed) {const bytes = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes]));}
    return message;
  };
  const snapshot = () => {state.captureUtcUnixMs = {available: true, value: String(Date.now())}; state.boundaryOrder = (++order).toString(); send('snapshot', {state, status: status(), continuity: {coalescedSnapshots: '0', offlineTransitions: '0'}});};
  const server = createServer(incoming => {
    socket?.destroy(); clearInterval(timer); socket = incoming; incoming.on('error', e => {if (errors.length < 5) errors.push(e.code ?? 'SOCKET_ERROR');});
    let bytes = Buffer.alloc(0), greeted = false;
    incoming.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 8192) {incoming.destroy(); return;}
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
        const length = bytes.readUInt32LE(0); if (length > 4096) {incoming.destroy(); return;}
        const message = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')); bytes = bytes.subarray(4 + length);
        if (message.kind === 'hello' && !greeted) {
          greeted = true; durable = message.data.durableEvents; seq = 0n;
          send('welcome', {...welcome.data, durableEvents: durable});
          send('checkpoint', {...checkpoint.data, state, status: status(), continuity: {coalescedSnapshots: '0', offlineTransitions: '0'}});
          timer = setInterval(snapshot, 100);
        } else if (message.kind === 'clock.probe') send('clock.reply', {probeId: message.data.probeId, receivedMonotonicNs: (ns + 1n).toString(), sentMonotonicNs: (ns + 2n).toString()});
        else if (message.kind === 'ack') acked = BigInt(message.data.throughEventSeq);
      }
    });
    incoming.on('close', () => {if (socket === incoming) {socket = undefined; durable = false; clearInterval(timer);}});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
  const event = record => {
    assert.equal(durable, true); state.boundaryOrder = (++order).toString();
    const data = {eventSeq: (next++).toString(), redelivered: false, occurred: {...configured.data.occurred, monotonicNs: {available: true, value: (ns + 100000000n).toString()},
      utcUnixMs: {available: true, value: String(Date.now())}, configurationRevision: revision.toString(), boundaryOrder: order.toString()}, record};
    const m = send('event', data); events.push(m); snapshot(); return m.data.eventSeq;
  };
  return {endpoint, errors, connected: () => durable, acked: () => acked.toString(),
    settings: async kind => {if (kind === 'unknown') await rm(profileConfig, {force: true}); else await writeFile(profileConfig, kind === 'fail' ? CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"') : CONFIG);},
    begin: label => {revision++; state.configuration.revision = revision.toString(); const job = {...configured.data.record, cargoId: {available: true, value: `synthetic_${label}`}, cargo: {available: true, value: `Synthetic ${label}`}}; const {type, ...value} = job; void type; state.configuration.job = {available: true, value}; return event(job);},
    deliver: () => event({...delivered.data.record, autoParkUsed: {available: true, value: false}}),
    stop: async () => {clearInterval(timer); socket?.destroy(); await new Promise(resolve => server.close(resolve));}
  };
}
const current = page => page.evaluate(() => globalThis.desktop.getHardModeStatus());
const trips = page => page.evaluate(async () => {const result = await globalThis.desktop.listJournalTrips(); return result.ok ? result.value.trips : [];});
export async function runHardModeSmoke({application, dashboard, source, config, record}) {
  const proof = (message, accept, timeoutMs = 8000) => {
    const observation = {message}; (record.proofWaits ??= []).push(observation);
    return waitForHardModeProof({message, accept, timeoutMs, record: observation, read: () => current(dashboard),
      refresh: () => dashboard.evaluate(() => globalThis.desktop.refreshHardMode())});
  };
  await chooseSource(dashboard, 'synthetic');
  await until(source.connected, Boolean, 'HARD_MODE_DURABLE_SOURCE', 10000);
  await until(async () => (await current(dashboard)).assessment.state, value => value === 'unknown', 'HARD_MODE_UNKNOWN', 5000); record.unknown = true; await until(() => dashboard.locator('[data-testid^="hard-mode-rule-"][data-state="unknown"]').count(), count => count === 12, 'HARD_MODE_UNKNOWN_NAMES', 5000); await dashboard.getByTestId('hard-mode-card').screenshot({path: path.join(config.output, 'hard-mode-unknown.png')});
  await source.settings('fail');
  await until(async () => (await current(dashboard)).assessment.state, value => value === 'fail', 'HARD_MODE_FAIL', 8000); record.fail = true;
  const hints = [
    ['fuel', 'On (1)', 'On (1)', 'Meets the required setting'], ['air', 'On (1)', 'On (1)', 'Meets the required setting'],
    ['police', 'On (1)', 'On (1)', 'Meets the required setting'], ['fatigue', 'Off (0)', 'On (1)', 'Does not meet the required setting'],
    ['limiter', 'On (1)', 'On (1)', 'Meets the required setting'], ['truck', '50% (0.5)', '≤ 50% (0.5)', 'Meets the required setting'],
    ['trailer', '50% (0.5)', '≤ 50% (0.5)', 'Meets the required setting'], ['parking', 'Off (0) / Skilled (2)', 'Off (0) and skilled (2); manual delivery required', 'Meets the required setting'],
    ['rain', '12% (0.12)', '≥ 12% (0.12)', 'Meets the required setting'], ['events', '30% (0.3)', '≥ 30% (0.3)', 'Meets the required setting'],
    ['braking', '75% (0.75)', '≤ 75% (0.75)', 'Meets the required setting'], ['traffic', '100% (1)', '≥ 100% (1)', 'Meets the required setting']
  ];
  const language = async value => {
    await chooseLanguage(dashboard, value);
    await until(() => dashboard.evaluate(() => globalThis.desktop.getAppState()), state => state.settings?.language === value, 'HARD_MODE_LANGUAGE_SAVED', 5000);
  };
  const localizedHints = value => value === 'en' ? hints : hints.map(([id, detected, required, reason]) => [id,
    detected.replaceAll('On', 'Вкл.').replaceAll('Off', 'Выкл.').replaceAll('Skilled', 'Умелая'),
    id === 'parking' ? 'Выкл. (0) и умелая (2); требуется ручная парковка' : required.replaceAll('On', 'Вкл.'),
    reason === 'Meets the required setting' ? 'Соответствует требуемой настройке' : 'Не соответствует требуемой настройке']);
  for (const lang of ['en', 'ru']) {
    await language(lang);
    const names = lang === 'en' ? ['Realistic fuel consumption', 'Air brake simulation', 'Police and fines', 'Fatigue simulation', 'Speed limiter', 'Truck stability', 'Trailer stability', 'Configured skilled parking', 'Rain probability', 'Random road events', 'Braking intensity', 'Traffic density'] : ['Реалистичный расход топлива', 'Пневмотормоза', 'Штрафы / полиция', 'Усталость', 'Ограничитель скорости', 'Стабилизация тягача', 'Стабилизация прицепа', 'Настроенная умелая парковка', 'Вероятность дождя', 'Случайные события', 'Интенсивность торможения', 'Плотность трафика'];
    const expected = localizedHints(lang), fail = lang === 'en' ? 'fail' : 'не выполнено', pass = lang === 'en' ? 'pass' : 'выполнено';
    const detectedLabel = lang === 'en' ? 'Detected' : 'Обнаружено', requiredLabel = lang === 'en' ? 'Required' : 'Требуется', reasonLabel = lang === 'en' ? 'Reason' : 'Причина';
    assert.equal(await dashboard.locator('[data-testid^="hard-mode-rule-"]').count(), 12);
    await until(() => dashboard.getByTestId('hard-mode-name-fatigue').getAttribute('aria-label'), text => text.endsWith(fail), 'HARD_MODE_RENDERED_FAIL', 5000);
    await dashboard.getByTestId('hard-mode-name-fuel').focus(); await dashboard.keyboard.press('Shift+Tab');
    for (const [index, [id, detected, required, reason]] of expected.entries()) {
      const trigger = dashboard.getByTestId(`hard-mode-name-${id}`), hint = dashboard.getByTestId(`hard-mode-hint-${id}`);
      assert.equal(await trigger.getAttribute('aria-label'), `${names[index]}: ${id === 'fatigue' ? fail : pass}`);
      assert.equal(await trigger.locator('span').last().innerText(), names[index]);
      assert.equal(await dashboard.getByTestId(`hard-mode-rule-${id}`).getAttribute('data-state'), id === 'fatigue' ? 'fail' : 'pass');
      await trigger.hover(); await hint.waitFor({state: 'visible'});
      const text = await hint.innerText();
      assert.ok(text.includes(`${detectedLabel}: ${detected}`) && text.includes(`${requiredLabel}: ${required}`) && text.includes(`${reasonLabel}: ${reason}`), `Incorrect ${lang}/${id} hint: ${text}`);
      await dashboard.keyboard.press('Escape'); await hint.waitFor({state: 'hidden'});
      await dashboard.mouse.move(0, 0); await dashboard.keyboard.press('Tab');
      assert.equal(await trigger.evaluate(element => element === globalThis.document.activeElement), true, `Tab did not focus ${lang}/${id}`);
      await hint.waitFor({state: 'visible'}); await dashboard.keyboard.press('Escape'); await hint.waitFor({state: 'hidden'});
      assert.equal(await trigger.evaluate(element => element === globalThis.document.activeElement), true, `Escape moved focus from ${lang}/${id}`);
    }
    await dashboard.getByTestId('hard-mode-name-fatigue').focus(); await dashboard.getByTestId('hard-mode-hint-fatigue').waitFor({state: 'visible'});
    await dashboard.screenshot({path: path.join(config.output, `hard-mode-parameter-hint-${lang}.png`)}); await dashboard.keyboard.press('Escape');
    await clickTestId(dashboard, 'hard-mode-checklist');
    const drawer = dashboard.getByTestId('hard-mode-drawer'); await drawer.waitFor({state: 'visible'});
    assert.equal(await drawer.locator('[data-testid^="hard-mode-drawer-rule-"]').count(), 12);
    assert.equal(Math.round((await drawer.boundingBox()).width), 470);
    for (const [id, detected, required, reason] of expected) {
      const text = await dashboard.getByTestId(`hard-mode-drawer-rule-${id}`).innerText();
      assert.ok(text.includes(`${detectedLabel}: ${detected}`) && text.includes(`${requiredLabel}: ${required}`) && text.includes(reason), `Incorrect ${lang}/${id} drawer row`);
    }
    const drawerText = await drawer.innerText();
    for (const caveat of (lang === 'en' ? ['Read-only checks observe persisted settings.', 'Unpersisted menu or console changes and transient changes between checks are not verified.', 'Manual delivery is required; actual Expert placement is not verified.', 'Current settings pass is separate from delivered-trip qualification.'] : ['Проверка только читает сохранённые настройки.', 'Несохранённые изменения в меню или консоли и временные изменения между проверками не проверяются.', 'Требуется ручная парковка; фактическое место уровня «Эксперт» не подтверждается.', 'Соответствие текущих настроек не означает, что завершённый рейс будет засчитан как Hard Mode.'])) assert.ok(drawerText.includes(caveat), `Missing ${lang} drawer caveat: ${caveat}`);
    if (lang === 'ru') assert.doesNotMatch(await drawer.innerText(), /Detected:|Required:|Reason:|Check again|Current settings|Read-only/);
    await dashboard.screenshot({path: path.join(config.output, `hard-mode-checklist-${lang}.png`)});
    await clickTestId(dashboard, 'hard-mode-drawer-refresh'); await dashboard.keyboard.press('Escape'); await drawer.waitFor({state: 'hidden'});
    assert.equal(await dashboard.getByTestId('hard-mode-checklist').evaluate(element => element === globalThis.document.activeElement), true);
    assert.equal(await dashboard.getByRole('dialog').count(), 0);
  }
  await language('en');
  assert.match(await dashboard.getByTestId('hard-mode-source').innerText(), /Synthetic \/ replay settings.*s since observation/);
  await clickTestId(dashboard, 'hard-mode-refresh');
  record.hints = true; record.hover = true; record.drawer = true; record.bilingual = true; record.keyboard = true; record.refresh = true;
  await source.settings('pass'); await until(async () => (await current(dashboard)).assessment.state, value => value === 'pass', 'HARD_MODE_PASS', 8000); record.pass = true; await until(() => dashboard.getByTestId('hard-mode-card').getAttribute('data-state'), state => state === 'pass', 'HARD_MODE_RENDERED_PASS', 5000); await dashboard.getByTestId('hard-mode-card').screenshot({path: path.join(config.output, 'hard-mode-pass.png')});
  // Screenshots and the bilingual hint journey may outlive proof. Arm a new genuine publication immediately before
  // opening; subsequent waits drive the trusted refresh boundary instead of assuming a periodic tick was eligible.
  const beforeOpening = (await current(dashboard)).assessment.observedUtcMs;
  await proof('HARD_MODE_ARMED_PASS', value => value.assessment.state === 'pass' && value.assessment.observedUtcMs !== beforeOpening);
  source.begin('qualifying');
  await proof('HARD_MODE_OPEN', async () => {const rows = await trips(dashboard); return rows.length === 1 && rows[0].outcome === 'open';}, 5000);
  // Require two distinct persisted passing publications while this trip is open, through the production adapter.
  let observed = (await proof('HARD_MODE_OPEN_AUDIT', value => value.trip?.latest.state === 'pass' && value.trip.firstLoss === null, 5000)).trip.latest.observedUtcMs;
  for (let refresh = 0; refresh < 2; refresh++) {
    const next = await proof('HARD_MODE_OPEN_PASSING_REFRESH', async value => {
      if (value.trip?.latest.state !== 'pass' || value.trip.firstLoss !== null || value.trip.latest.observedUtcMs === observed) return false;
      assert.equal((await trips(dashboard))[0].outcome, 'open'); return true;
    });
    observed = next.trip.latest.observedUtcMs;
  }
  source.deliver();
  let positive;
  await proof('HARD_MODE_QUALIFIED', async () => {positive = await trips(dashboard); return positive.length === 1 && positive[0].isHardMode === true;}, 5000);
  record.qualified = positive[0].tripUuid;
  source.begin('lost');
  await until(async () => await trips(dashboard), rows => rows.length === 2 && rows[0].outcome === 'open', 'HARD_MODE_SECOND_OPEN', 5000);
  await source.settings('unknown');
  await until(async () => await current(dashboard), value => value.assessment.state === 'unknown' && Boolean(value.trip?.firstLoss), 'HARD_MODE_LOST', 8000);
  await until(() => dashboard.getByTestId('hard-mode-card').getAttribute('data-state'), state => state === 'lost', 'HARD_MODE_RENDERED_LOSS', 5000);
  assert.match(await dashboard.getByTestId('hard-mode-loss').innerText(), /Qualification cannot be restored/);
  record.lost = true; await dashboard.getByTestId('hard-mode-card').screenshot({path: path.join(config.output, 'hard-mode-lost.png')});
  await source.settings('pass'); await until(async () => (await current(dashboard)).assessment.state, value => value === 'pass', 'HARD_MODE_RESTORED_SETTINGS', 8000);
  await until(() => dashboard.getByTestId('hard-mode-card').innerText(), text => text.includes('12 of 12 configured rules pass'), 'HARD_MODE_RENDERED_RESTORATION', 5000);
  assert.equal(await dashboard.getByTestId('hard-mode-card').getAttribute('data-state'), 'lost');
  assert.match(await dashboard.getByTestId('hard-mode-card').innerText(), /Hard Mode lost for this trip/);
  record.restoredLost = true; await dashboard.getByTestId('hard-mode-card').screenshot({path: path.join(config.output, 'hard-mode-restored-lost.png')});
  await clickTestId(dashboard, 'hard-mode-checklist');
  await dashboard.getByTestId('hard-mode-drawer').waitFor({state: 'visible'});
  await dashboard.evaluate(() => globalThis.desktop.setLanguage('ru'));
  await until(() => dashboard.getByTestId('hard-mode-drawer').innerText(), text => text.includes('Выполнено 12 из 12') && text.includes('восстановить нельзя'), 'HARD_MODE_DRAWER_HOT_LANGUAGE', 5000);
  assert.doesNotMatch(await dashboard.getByTestId('hard-mode-drawer').innerText(), /Detected:|Required:|Current settings|Qualification cannot/);
  await dashboard.screenshot({path: path.join(config.output, 'hard-mode-restored-lost-ru.png')});
  await dashboard.keyboard.press('Escape');
  assert.equal(await dashboard.getByTestId('hard-mode-checklist').evaluate(element => element === globalThis.document.activeElement), true);
  assert.match(await dashboard.getByTestId('hard-mode-card').innerText(), /Hard Mode потерян для этого рейса/);
  record.languageHotChange = true;
  await language('en');
  source.deliver();
  const rows = await until(async () => await trips(dashboard), rows => rows.length === 2 && rows.every(row => row.outcome === 'delivered'), 'HARD_MODE_DELIVERIES', 5000);
  assert.deepEqual(rows.map(row => row.isHardMode), [false, true]); record.irreversible = true;
  await clickTestId(dashboard, 'tab-journal');
  await dashboard.getByTestId('journal-row').first().waitFor({state: 'visible'});
  assert.equal(await dashboard.getByTestId('hard-mode-badge').count(), 1); record.badge = true;
  await openDetail(dashboard, record.qualified);
  assert.match(await dashboard.getByTestId('trip-hard-mode').innerText(), /This trip qualifies/);
  await dashboard.evaluate(() => globalThis.desktop.setLanguage('ru'));
  await until(() => dashboard.getByTestId('trip-hard-mode').innerText(), text => text.includes('Рейс засчитывается как Hard Mode') && text.includes('Ручная парковка: подтверждена'), 'HARD_MODE_RUSSIAN_TRIP_AUDIT', 5000);
  assert.doesNotMatch(await dashboard.getByTestId('trip-hard-mode').innerText(), /At opening:|Latest observation:|Manual delivery:|Settings snapshots|Read-only/);
  assert.match(await dashboard.getByTestId('journal-detail').innerText(), /Synthetic qualifying/); // SDK cargo text is never translated.
  await dashboard.screenshot({path: path.join(config.output, 'hard-mode-trip-ru.png')});
  await dashboard.evaluate(() => globalThis.desktop.setLanguage('en'));
  await until(() => dashboard.getByTestId('trip-hard-mode').innerText(), text => text.includes('This trip qualifies'), 'HARD_MODE_ENGLISH_TRIP_AUDIT', 5000);
  const file = path.join(config.output, 'hard-mode-export.json'); await stubSaveDialog(application, {canceled: false, filePath: file});
  await clickTestId(dashboard, 'journal-export-button');
  await dashboard.getByTestId('journal-export-result').filter({hasText: 'Saved the trip as JSON'}).waitFor({state: 'visible', timeout: 10000});
  const exported = JSON.parse(await readFile(file, 'utf8'));
  const validate = await exportValidator(config); assert.deepEqual(validate(exported), []);
  assert.equal(exported.formatVersion, 2); assert.equal(exported.trip.is_hard_mode, true); assert.equal(exported.trip.hard_mode_details.manualDelivery, true);
  record.export = true; record.flags = rows.map(row => row.isHardMode); record.errors = source.errors; assert.deepEqual(source.errors, []);
  const overlay = application.windows().find(page => page.url().endsWith('?view=overlay'));
  assert.equal(await overlay.evaluate(() => typeof globalThis.overlay.getHardModeStatus), 'undefined'); record.overlayExcluded = true;
}
export async function verifyHardModeRun({config, record}) {
  const filename = path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'hard-mode.sqlite');
  const file = await open(filename, 'r'), bytes = Buffer.alloc(100);
  try {await file.read(bytes, 0, 100, 0);} finally {await file.close();}
  assert.equal(bytes.readUInt32BE(60), 3); record.schemaVersion = 3;
  // Running-app journal and export are read through the real worker; independent SQL reconciliation is in storage tests.
  assert.deepEqual(record.flags, [false, true]); record.persisted = true;
}
