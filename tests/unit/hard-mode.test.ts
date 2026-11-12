import {describe, expect, it} from 'vitest';
import {advanceHardModeV2, newHardModeDetails, qualifiesHardMode, advanceHardMode, evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {isHardModeDetails, isHardModeObservation, isHardModeStatus} from '../../packages/contracts/src/hard-mode';
import {hardModeView} from '../../apps/desktop/src/hard-mode/view';
import {t} from '../../apps/desktop/src/i18n';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
const evaluate = (text = HARD_MODE_CONFIG) => evaluateHardMode(parseHardModeConfig(text), 1000, 'fixture');
describe('ET-026 persisted settings (REG-009/010)', () => {
  it.each(['truck', 'trailer'] as const)('uses the game slider scale and raw 0.25 limit for %s stability', id => {
    for (const [raw, percent, state] of [[0, 0, 'pass'], [0.25, 50, 'pass'], [0.255, 51, 'fail'], [0.26, 52, 'fail'], [0.5, 100, 'fail']] as const) {
      const a = evaluate(HARD_MODE_CONFIG.replace(new RegExp(`g_${id}_stability "[^"]+"`), `g_${id}_stability "${raw}"`));
      expect(a.rules.find(rule => rule.id === id)).toMatchObject({state, values: [raw]});
      for (const language of ['en', 'ru'] as const) {
        expect(hardModeView({assessment: a, trip: null}, 1000, language).rows.find(rule => rule.id === id)).toMatchObject({
          detected: `${percent}% (${raw})`, required: '≤ 50% (0.25)'});
      }
    }
  });
  it.each([0, 1])('accepts Normal parking with simplified double-trailer parking flag %s and retains both values', flag => {
    const a = evaluate(HARD_MODE_CONFIG.replace(/g_simple_parking_doubles "[^"]+"/, `g_simple_parking_doubles "${flag}"`));
    expect(a.rules.find(rule => rule.id === 'parking')).toMatchObject({state: 'pass', values: [flag, 2]});
    expect(advanceHardMode(null, a).manualDelivery).toBeNull();
  });
  it.each(['truck', 'trailer'] as const)('retains raw-unit tolerance and unavailable values for %s stability', id => {
    for (const [raw, state] of [[0.250001, 'pass'], [0.250002, 'fail']] as const) {
      expect(evaluate(HARD_MODE_CONFIG.replace(new RegExp(`g_${id}_stability "[^"]+"`), `g_${id}_stability "${raw}"`)).rules.find(rule => rule.id === id)).toMatchObject({state, values: [raw]});
    }
    const a = evaluate(HARD_MODE_CONFIG.replace(new RegExp(`uset g_${id}_stability "[^"]+"`), ''));
    expect(a.rules.find(rule => rule.id === id)).toMatchObject({state: 'unknown', reason: 'missing', values: [null]});
    expect(hardModeView({assessment: a, trip: null}, 1000).rows.find(rule => rule.id === id)).toMatchObject({detected: 'Unknown', required: '≤ 50% (0.25)'});
  });
  it('retains the existing display scales and limits for other numeric settings', () => {
    const rows = hardModeView({assessment: evaluate(), trip: null}, 1000).rows;
    for (const [id, detected, required] of [['rain', '12% (0.12)', '≥ 12% (0.12)'], ['events', '30% (0.3)', '≥ 30% (0.3)'], ['braking', '75% (0.75)', '≤ 75% (0.75)'], ['traffic', '100% (1)', '≥ 100% (1)']]) {
      expect(rows.find(rule => rule.id === id)).toMatchObject({detected, required});
    }
  });
  it.each([-1, 0.5, 2])('fails invalid simplified double-trailer parking flag %s', flag => {
    expect(evaluate(HARD_MODE_CONFIG.replace(/g_simple_parking_doubles "[^"]+"/, `g_simple_parking_doubles "${flag}"`)).rules[7]).toMatchObject({state: 'fail', values: [flag, 2]});
  });
  it.each([0, 1, 3])('fails parking difficulty %s regardless of a valid doubles flag', difficulty => {
    for (const flag of [0, 1]) {
      const config = HARD_MODE_CONFIG.replace(/g_simple_parking_doubles "[^"]+"/, `g_simple_parking_doubles "${flag}"`).replace('g_parking_difficulty "2"', `g_parking_difficulty "${difficulty}"`);
      expect(evaluate(config).rules[7]).toMatchObject({state: 'fail', values: [flag, difficulty]});
    }
  });
  it.each(['g_simple_parking_doubles', 'g_parking_difficulty'])('keeps missing, malformed and conflicting %s evidence unknown', key => {
    const missing = HARD_MODE_CONFIG.replace(new RegExp(`uset ${key} "[^"]+"`), '');
    expect(evaluate(missing).rules[7]).toMatchObject({state: 'unknown', reason: 'missing'});
    expect(evaluate(missing + `\nuset ${key} "NaN"`).rules[7]).toMatchObject({state: 'unknown', reason: 'malformed'});
    expect(evaluate(HARD_MODE_CONFIG + `\nuset ${key} "0"`).rules[7]).toMatchObject({state: 'unknown', reason: 'conflicting'});
  });
  it.each([0, 1])('labels double-trailer assistance and requires only Normal parking (flag %s)', flag => {
    const assessment = evaluate(HARD_MODE_CONFIG.replace(/g_simple_parking_doubles "[^"]+"/, `g_simple_parking_doubles "${flag}"`));
    const en = hardModeView({assessment, trip: null}, 1000, 'en').rows[7], ru = hardModeView({assessment, trip: null}, 1000, 'ru').rows[7];
    expect(en).toMatchObject({label: 'Configured Normal parking', detected: `Simplified double-trailer parking: ${flag ? 'On' : 'Off'} (${flag}) / Normal (2)`, required: 'Normal (2)'});
    expect(ru).toMatchObject({label: 'Настроенная нормальная парковка', detected: `Упрощённая парковка двойных прицепов: ${flag ? 'Вкл.' : 'Выкл.'} (${flag}) / Нормальная (2)`, required: 'Нормальная (2)'});
    expect(en.inline).toContain('required Normal'); expect(ru.inline).toContain('нужно Нормальная');
    expect(t('hm.notice', undefined, 'en')).toContain('Parking is checked only through its settings');
    expect(t('hm.notice', undefined, 'ru')).toContain('Парковка проверяется только по настройкам');
    expect(t('hm.audit', {opening: 'pass', latest: 'pass'}, 'en')).toBe('At opening: pass. Latest observation: pass.');
    expect(t('hm.audit', {opening: 'pass', latest: 'pass'}, 'ru')).toBe('В начале: pass. Последняя проверка: pass.');
  });
  it('formats historical raw stability without recalculating its retained audit', () => {
    const old = advanceHardMode(null, evaluate());
    for (const rule of old.latest.rules) if (rule.id === 'truck' || rule.id === 'trailer') rule.values = [0.5];
    old.firstLoss = {atUtcMs: 900, reason: 'outside-limit', rule: 'truck', values: [0.255]}; old.manualDelivery = true;
    const before = structuredClone(old);
    for (const language of ['en', 'ru'] as const) {
      const view = hardModeView({assessment: old.latest, trip: old}, 1000, language);
      expect(view.rows[5]).toMatchObject({state: 'pass', detected: '100% (0.5)', required: '≤ 50% (0.25)'});
      expect(view.loss).toContain('0.255'); expect(old).toEqual(before);
    }
  });
  it('passes exactly twelve independently supplied configured rules and retains the compatibility field', () => {
    const a = evaluate(); expect(a.state).toBe('pass'); expect(a.rules).toHaveLength(12);
    const details = advanceHardMode(null, a); expect(details.firstLoss).toBeNull(); expect(details.manualDelivery).toBeNull(); expect(isHardModeDetails(details)).toBe(true);
    expect(hardModeView({assessment: a, trip: details}, 2000)).toMatchObject({headline: 'Hard Mode settings active', passed: 12, age: '1 s since observation'});
  });
  it.each([
    ['g_fuel_simulation', '0', 'fuel'], ['g_hardcore_simulation', '0', 'air'], ['g_police', '0', 'police'], ['g_fatigue', '0', 'fatigue'],
    ['g_use_speed_limiter', '0', 'limiter'], ['g_truck_stability', '0.6', 'truck'], ['g_trailer_stability', '0.6', 'trailer'],
    ['g_simple_parking_doubles', '2', 'parking'], ['g_parking_difficulty', '1', 'parking'], ['g_bad_weather_factor', '0.1', 'rain'],
    ['g_road_events', '0.2', 'events'], ['g_brake_intensity', '0.8', 'braking'], ['g_traffic', '0.9', 'traffic']
  ])('fails %s independently without changing other rules', (key, value, id) => {
    const a = evaluate(HARD_MODE_CONFIG.replace(new RegExp(`${key} "[^"]+"`), `${key} "${value}"`));
    expect(a.state).toBe('fail'); expect(a.rules.filter(r => r.state === 'fail').map(r => r.id)).toEqual([id]);
  });
  it('handles whitespace, comments, exponent/decimal syntax and identical numeric duplicates', () => {
    const text = HARD_MODE_CONFIG.replace('uset g_traffic "1.0"', '  uset  g_traffic  "1e0" // comment\n uset g_traffic "+1.000" # identical');
    expect(evaluate(text).state).toBe('pass');
  });
  it.each(['NaN', 'Infinity', '1oops', '1e999', '', '0x1'])('does not accept partial/nonfinite numeric text %s', value => {
    expect(evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', `g_fatigue "${value}"`)).rules[3]).toMatchObject({state: 'unknown', reason: 'malformed', values: [null]});
  });
  it('rejects malformed relevant lines, missing inputs and conflicting duplicates', () => {
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police 1').rules[2].reason).toBe('malformed');
    expect(evaluate(HARD_MODE_CONFIG.replace('uset g_police "1"', '')).rules[2].reason).toBe('missing');
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police "0"').rules[2].reason).toBe('conflicting');
    expect(evaluate(HARD_MODE_CONFIG + '\nuset g_police "' + '1'.repeat(8192) + '"').rules[2].state).toBe('unknown');
    expect(evaluate('x'.repeat(256 * 1024 + 1)).state).toBe('unknown');
  });
  it('keeps exact booleans distinct from numeric comparison tolerance', () => {
    expect(evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0.9999999"')).state).toBe('fail');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_bad_weather_factor "0.12"', 'g_bad_weather_factor "0.119999"')).state).toBe('pass');
    expect(evaluate(HARD_MODE_CONFIG.replace('g_bad_weather_factor "0.12"', 'g_bad_weather_factor "0.119998"')).state).toBe('fail');
  });
  it('retains the first failure through restoration and unknown observations', () => {
    const pass = evaluate(), fail = evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
    const d = advanceHardMode(advanceHardMode(advanceHardMode(null, pass), fail), pass);
    expect(d.firstLoss).toEqual({atUtcMs: 1000, reason: 'outside-limit', rule: 'fatigue', values: [0]});
    expect(advanceHardMode(d, unknownHardMode(2000)).firstLoss).toEqual(d.firstLoss);
    const restored = hardModeView({assessment: pass, trip: d}, 2000);
    expect(restored.headline).toBe('Hard Mode lost for this trip');
    expect(restored.loss).toContain('Does not meet the required setting; detected 0');
    expect(hardModeView({assessment: fail, trip: d}, 2000).rows[3]).toMatchObject({reason: 'Does not meet the required setting', detected: 'Off (0)', required: 'On (1)'});
    expect(hardModeView({assessment: evaluate(HARD_MODE_CONFIG.replace('uset g_police "1"', '')), trip: null}, 2000).rows[2].reason).toBe('Required setting is missing');
  });
  it('orders published latest by actual offer order and preserves it against a numerically newer frozen intake', () => {
    const opening = {...evaluate(), observedUtcMs: 2000}, lost = {...evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), observedUtcMs: 1000};
    const details = advanceHardMode(advanceHardMode(advanceHardMode(null, opening), lost), opening, undefined, 'frozen');
    expect(details.latest).toEqual(lost); expect(details.firstLoss).toMatchObject({atUtcMs: 1000, rule: 'fatigue', values: [0]});
    expect(advanceHardMode(details, {...opening, observedUtcMs: 500})).toMatchObject({latest: {state: 'pass', observedUtcMs: 500}, firstLoss: {rule: 'fatigue', values: [0]}});
  });
  it('renders Russian rule states, exact values and retained loss without mutating the stored audit or global language', () => {
    const fail = evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), details = advanceHardMode(null, fail), before = JSON.stringify(details);
    const ru = hardModeView({assessment: fail, trip: details}, 2000, 'ru');
    expect(ru.headline).toBe('Hard Mode потерян для этого рейса');
    expect(ru.rows[3]).toMatchObject({stateText: 'не выполнено', detected: 'Выкл. (0)', required: 'Вкл. (1)', reason: 'Не соответствует требуемой настройке'});
    expect(ru.loss).toContain('обнаружено 0'); expect(ru.loss).not.toContain('outside-limit');
    expect(JSON.stringify(details)).toBe(before); expect(hardModeView({assessment: fail, trip: details}, 2000, 'en').rows[3].detected).toBe('Off (0)');
  });
  it('validates private batch provenance independently of nullable current proof', () => {
    const batch={tripUuid:'70000000-0000-4000-8000-000000000001',producer:'80000000-0000-4000-8000-000000000001',sequence:1,passingChecks:1,failingChecks:0,unknownChecks:0};
    const value={assessment:unknownHardMode(0),binding:null,pluginSessionId:null,sourceMonotonicNs:null,batch,batchSessionId:'90000000-0000-4000-8000-000000000001',member:batch.tripUuid};
    expect(isHardModeObservation(value)).toBe(true);
    expect(isHardModeObservation({...value,batchSessionId:'private text'})).toBe(false);
    expect(isHardModeObservation({...value,member:'70000000-0000-4000-8000-000000000002'})).toBe(false);
    const {batch:removed,...withoutBatch}=value;void removed;
    expect(isHardModeObservation(withoutBatch)).toBe(false);
  });
  it('rejects unlisted fields, identities, bad lengths and malformed cross-boundary values', () => {
    const verified = {state: 'verified', reason: null, checking: false, lastCheck: null};
    const status = {assessment: evaluate(), trip: null, verification: verified}; expect(isHardModeStatus(status)).toBe(true);
    expect(isHardModeStatus({...status, filename: 'private'})).toBe(false);
    expect(isHardModeStatus({...status, assessment: {...status.assessment, rules: []}})).toBe(false);
    // ET-112d: verification is required, and only a verified profile carries known settings.
    const {verification: omitted, ...withoutVerification} = status; void omitted;
    expect(isHardModeStatus(withoutVerification)).toBe(false);
    const unknown = {assessment: unknownHardMode(0), trip: null};
    const lastCheck = {atUtcMs: 1, state: 'unverified', reason: 'timeout'};
    for (const verification of [{state: 'waiting', reason: 'no-game', checking: false, lastCheck: null}, {state: 'waiting', reason: 'checking', checking: true, lastCheck},
      {state: 'unverified', reason: 'game-log', checking: false, lastCheck: {...lastCheck, state: 'waiting', reason: 'no-game'}}, {...verified, lastCheck: {atUtcMs: 1, state: 'verified', reason: null}}])
      expect(isHardModeStatus({...unknown, verification})).toBe(true);
    for (const verification of [{state: 'unverified', reason: null, checking: false, lastCheck: null}, {state: 'unverified', reason: 'no-game', checking: false, lastCheck: null},
      {state: 'waiting', reason: 'game-log', checking: false, lastCheck: null}, {state: 'verified', reason: 'timeout', checking: false, lastCheck: null},
      {state: 'verified', reason: null, checking: 'yes', lastCheck: null}, {...verified, lastCheck: {...lastCheck, atUtcMs: -1}}, {...verified, lastCheck: {...lastCheck, checking: false}},
      {...verified, lastCheck: {...lastCheck, reason: 'PROFILE_LOG_GENERATION'}}, {...verified, code: 'PROFILE_LOG_GENERATION'}])
      expect(isHardModeStatus({...unknown, verification})).toBe(false);
    for (const state of ['waiting', 'unverified'] as const)
      expect(isHardModeStatus({...status, verification: {state, reason: state === 'waiting' ? 'checking' : 'timeout', checking: false, lastCheck: null}})).toBe(false);
    expect(isHardModeObservation({assessment: evaluate(), binding: 'raw profile', pluginSessionId: null, sourceMonotonicNs: null})).toBe(false);
  });
});

describe('Hard Mode v2 known-check policy (REG-003/008/009/014)', () => {
  it.each([[95,5,true],[98,2,true],[94,6,false],[0,0,false]])('classifies %s passing / %s failing inclusively', (passingChecks,failingChecks,qualified) => {
    expect(qualifiesHardMode({passingChecks,failingChecks,unknownChecks: 1000})).toBe(qualified);
    expect(qualifiesHardMode({passingChecks,failingChecks,unknownChecks: 0},false)).toBe(false);
  });
  it('recovers, excludes unknown and never requires passing opening/final snapshots', () => {
    let audit = newHardModeDetails(unknownHardMode(0), null);
    const batch = {tripUuid: '70000000-0000-4000-8000-000000000001', producer: '80000000-0000-4000-8000-000000000001', sequence: 106, passingChecks: 94, failingChecks: 6, unknownChecks: 6};
    const observation = {assessment: unknownHardMode(1), binding: null, pluginSessionId: null, sourceMonotonicNs: null, batch};
    audit = advanceHardModeV2(audit, observation); expect(qualifiesHardMode(audit)).toBe(false);
    audit = advanceHardModeV2(audit, {...observation, batch: {...batch, sequence: 126, passingChecks: 114}});
    expect(qualifiesHardMode(audit)).toBe(true); expect(audit.latest.state).toBe('unknown'); expect(audit.firstLoss).toBeNull();
    expect(isHardModeDetails(audit)).toBe(true);
    expect(isHardModeDetails({...audit, passingChecks: -1})).toBe(false);
    expect(isHardModeDetails({...audit, checkpoint: {...batch, sequence: 1}})).toBe(false);
    for (const language of ['en','ru'] as const) {
      const view = hardModeView({assessment: audit.latest, trip: audit}, 2000, language);
      expect(view.ratio).toContain('114/120'); expect(view.ratio).toContain('95%'); expect(view.loss).toBeNull();
      expect(view.headline).not.toContain(language === 'en' ? 'lost' : 'потерян');
    }
  });
  it('deduplicates a cumulative checkpoint and retains original diagnostic values', () => {
    const fail = evaluate(HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));
    const observation = {assessment: fail, binding: null, pluginSessionId: null, sourceMonotonicNs: null,
      batch: {tripUuid: '70000000-0000-4000-8000-000000000001', producer: '80000000-0000-4000-8000-000000000001', sequence: 1, passingChecks: 0, failingChecks: 1, unknownChecks: 0}};
    const once = advanceHardModeV2(newHardModeDetails(evaluate(),null),observation);
    const twice = advanceHardModeV2(once,observation);
    expect(twice.failingChecks).toBe(1); expect(twice.firstDiagnostic).toMatchObject({code:'rule-failed',rule:'fatigue',values:[0]});
    expect(isHardModeDetails(twice)).toBe(true);
  });
});
