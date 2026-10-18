import {describe, expect, it} from 'vitest';
import {checkHistoryInvariants, formatViolations, type HistoryAck, type HistoryRows} from '../../scripts/ci/history-invariants.mjs';

// ET-019 (REG-005, REG-006, REG-012): the history invariants I1–I5 over hand-written row sets. Every set is written from
// docs/trips.md and docs/storage.md, never produced by the code under test: one set that holds every invariant, and for
// each rule a minimal change of it that breaks that rule alone.

const S = '10000000-0000-4000-8000-000000000001', T = '10000000-0000-4000-8000-000000000002';
const A = '20000000-0000-4000-8000-00000000000a', B = '20000000-0000-4000-8000-00000000000b', C = '20000000-0000-4000-8000-00000000000c';
const ev = (pluginSessionId: string, eventSeq: string, type: string, firstRedelivered = false) => ({pluginSessionId, eventSeq, type, firstRedelivered});
type Trip = HistoryRows['trips'][number];
const trip = (tripUuid: string, values: Partial<Trip>): Trip => ({tripUuid, game: 'ets2', pluginSessionId: S, openedBy: 'event', openedEventSeq: null, outcome: 'open',
  outcomeSessionId: null, outcomeEventSeq: null, closeReason: null, recordingCompleteness: 'unknown', ...values});

/**
 * One ETS2 session S: truck (1), job (2) opens trip A, start (3), a fine (4) and the delivery (5) attributed to A, which
 * closes complete with only a truck-change annotation (T13); the clear (6), a toll after the clear (7, free-driving), job
 * (8) opens trip B, the gap 9–10 closes B as gap, partial, with its interval (T10); the job stays untracked, so the fine
 * (11) and the cancellation (12) are ambiguous (T14). One ATS session T with an open trip C. Samples on two source clocks.
 */
function base(): HistoryRows {
  return {
    integrity: 'ok', foreignKeys: [],
    sessions: [{pluginSessionId: S, game: 'ets2', committedThroughEventSeq: '12'}, {pluginSessionId: T, game: 'ats', committedThroughEventSeq: '1'}],
    events: [ev(S, '1', 'truck.configured'), ev(S, '2', 'job.configured'), ev(S, '3', 'simulation.started'), ev(S, '4', 'player.fined'), ev(S, '5', 'job.delivered'),
      ev(S, '6', 'job.cleared'), ev(S, '7', 'player.tollgate.paid'), ev(S, '8', 'job.configured'), ev(S, '11', 'player.fined'), ev(S, '12', 'job.cancelled'),
      ev(T, '1', 'job.configured')],
    gaps: [{pluginSessionId: S, firstEventSeq: '9', lastEventSeq: '10'}],
    trips: [
      trip(A, {openedEventSeq: '2', outcome: 'delivered', outcomeSessionId: S, outcomeEventSeq: '5', closeReason: 'outcome', recordingCompleteness: 'complete'}),
      trip(B, {openedEventSeq: '8', outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial'}),
      trip(C, {game: 'ats', pluginSessionId: T, openedEventSeq: '1'})],
    attributions: [{pluginSessionId: S, eventSeq: '4', tripUuid: A, attribution: 'trip'}, {pluginSessionId: S, eventSeq: '5', tripUuid: A, attribution: 'trip'},
      {pluginSessionId: S, eventSeq: '7', tripUuid: null, attribution: 'free-driving'}, {pluginSessionId: S, eventSeq: '11', tripUuid: null, attribution: 'ambiguous'},
      {pluginSessionId: S, eventSeq: '12', tripUuid: null, attribution: 'ambiguous'}],
    intervals: [{tripUuid: A, pluginSessionId: S, kind: 'discontinuity', firstEventSeq: null, lastEventSeq: null, annotation: true},
      {tripUuid: B, pluginSessionId: S, kind: 'event-loss', firstEventSeq: '9', lastEventSeq: '10', annotation: false},
      {tripUuid: null, pluginSessionId: S, kind: 'sample-loss', firstEventSeq: null, lastEventSeq: null, annotation: false}],
    // Seconds 1000 and 1001 on clock k1 and second 1000 on clock k2: one row per session, clock and second.
    samples: [{pluginSessionId: S, sourceClockId: 'k1', monotonicNs: '1000000000000'}, {pluginSessionId: S, sourceClockId: 'k1', monotonicNs: '1001000000000'},
      {pluginSessionId: S, sourceClockId: 'k2', monotonicNs: '1000999999999'}]
  };
}
const ACKS: HistoryAck[] = [{pluginSessionId: S, throughEventSeq: '12'}, {pluginSessionId: T, throughEventSeq: '1'}];
/** A copy of the base set with `change` applied. */
function changed(change: (rows: {-readonly [K in keyof HistoryRows]: HistoryRows[K] extends readonly (infer R)[] ? R[] : HistoryRows[K]}) => void): HistoryRows {
  const rows = structuredClone(base()) as Parameters<typeof change>[0];
  change(rows);
  return rows;
}
/** The invariants a row set breaks, each with its offending rows. */
const broken = (rows: HistoryRows, acks: HistoryAck[] = ACKS) => checkHistoryInvariants(rows, acks).map(v => v.invariant);
const offending = (rows: HistoryRows, acks: HistoryAck[] = ACKS) => checkHistoryInvariants(rows, acks).flatMap(v => v.rows);

describe('history invariants over hand-written rows', () => {
  it('a history that follows docs/trips.md and docs/storage.md holds every invariant', () => {
    expect(checkHistoryInvariants(base(), ACKS)).toEqual([]);
    expect(checkHistoryInvariants(base())).toEqual([]);
  });

  describe('I1 no duplicate delivered trips or double accounting', () => {
    it('a gameplay event without its attribution', () => {
      const rows = changed(r => { r.attributions = r.attributions.filter(a => a.eventSeq !== '7'); });
      expect(broken(rows)).toEqual(['I1']);
      expect(offending(rows)).toContainEqual(ev(S, '7', 'player.tollgate.paid'));
    });
    it('an attribution of an event that is not a gameplay event', () => {
      const rows = changed(r => { r.attributions.push({pluginSessionId: S, eventSeq: '1', tripUuid: null, attribution: 'free-driving'}); });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('an attribution of an event that is not stored', () => {
      const rows = changed(r => { r.attributions.push({pluginSessionId: S, eventSeq: '13', tripUuid: null, attribution: 'free-driving'}); });
      expect(broken(rows)).toEqual(['I1']);
    });
    // T14: a cargo_market job configured while running and cancelled before pickup (cargoLoaded available and false): its
    // fine and its cancellation are `trip-before-loaded`, and the cancellation closes the trip {cancelled, outcome},
    // complete after a clean window.
    const cancelledBeforePickup = (outcomeTrip: string) => changed(r => {
      r.events = r.events.map(e => e.pluginSessionId === S && e.eventSeq === '5' ? {...e, type: 'job.cancelled'} : e);
      r.trips[0] = {...r.trips[0], outcome: 'cancelled'};
      r.attributions = r.attributions.map(a => a.eventSeq === '4' ? {...a, attribution: 'trip-before-loaded'}
        : a.eventSeq === '5' ? {...a, tripUuid: outcomeTrip, attribution: 'trip-before-loaded'} : a);
    });
    it('a cargo-market job cancelled before pickup closes its trip with a trip-before-loaded outcome', () => {
      expect(checkHistoryInvariants(cancelledBeforePickup(A), ACKS)).toEqual([]);
    });
    it('a trip-before-loaded outcome attributed to another trip than the one it closes', () => {
      const rows = cancelledBeforePickup(B);
      expect(broken(rows)).toEqual(['I1']);
      expect(checkHistoryInvariants(rows, ACKS)[0].rule).toBe('the outcome event is attributed to the trip it closes');
    });
    it('a delivered trip that names no outcome event', () => {
      const rows = changed(r => { r.trips[0] = {...r.trips[0], outcomeSessionId: null, outcomeEventSeq: null, recordingCompleteness: 'partial'}; });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('a delivered trip whose outcome event is a cancellation', () => {
      const rows = changed(r => {
        r.trips[0] = {...r.trips[0], outcomeEventSeq: '12', recordingCompleteness: 'partial'};
        r.attributions = r.attributions.map(a => a.eventSeq === '12' ? {...a, tripUuid: A, attribution: 'trip'} : a.eventSeq === '5' ? {...a, tripUuid: null, attribution: 'ambiguous'} : a);
      });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('a delivered trip whose outcome event is attributed elsewhere', () => {
      const rows = changed(r => { r.attributions = r.attributions.map(a => a.eventSeq === '5' ? {...a, tripUuid: null, attribution: 'ambiguous'} : a); });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('a delivered trip without its close reason outcome', () => {
      const rows = changed(r => { r.trips[0] = {...r.trips[0], closeReason: 'gap', recordingCompleteness: 'partial'}; });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('two trips closed by one delivery', () => {
      const rows = changed(r => { r.trips.push(trip(C.replace('c', 'd'), {openedEventSeq: '2', outcome: 'delivered', outcomeSessionId: S, outcomeEventSeq: '5', closeReason: 'outcome', recordingCompleteness: 'partial'})); });
      expect(broken(rows)).toEqual(['I1', 'I1']);
      expect(checkHistoryInvariants(rows, ACKS).map(v => v.rule)).toContain('no outcome event closes two trips');
    });
    it('a trip without an outcome that names an outcome event', () => {
      const rows = changed(r => { r.trips[1] = {...r.trips[1], outcomeSessionId: S, outcomeEventSeq: '12'}; });
      expect(broken(rows)).toEqual(['I1']);
    });
    it('two open trips of one game', () => {
      const rows = changed(r => { r.trips[1] = {...r.trips[1], outcome: 'open', closeReason: null}; r.trips.push(trip(C.replace('c', 'e'), {openedEventSeq: '2'})); });
      expect(broken(rows)).toEqual(['I1']);
      expect(checkHistoryInvariants(rows, ACKS)[0].rule).toBe('at most one open trip per game');
    });
  });

  describe('I2 no acknowledged-but-lost events', () => {
    it('an ACK beyond committed coverage', () => {
      expect(broken(base(), [...ACKS, {pluginSessionId: S, throughEventSeq: '13'}])).toEqual(['I2']);
      expect(offending(base(), [{pluginSessionId: S, throughEventSeq: '13'}])).toContainEqual({pluginSessionId: S, throughEventSeq: '13'});
    });
    it('an ACK of a session that was never stored', () => {
      expect(broken(base(), [{pluginSessionId: '10000000-0000-4000-8000-0000000000ff', throughEventSeq: '1'}])).toEqual(['I2']);
    });
    it('an ACK of 0 is never a loss', () => {
      expect(broken(base(), [{pluginSessionId: '10000000-0000-4000-8000-0000000000ff', throughEventSeq: '0'}])).toEqual([]);
    });
    it('coverage over an eventSeq that is neither an event nor inside a gap', () => {
      const rows = changed(r => { r.events = r.events.filter(e => !(e.pluginSessionId === S && e.eventSeq === '6')); });
      expect(broken(rows)).toEqual(['I2']);
      expect(offending(rows)).toContainEqual({pluginSessionId: S, missingEventSeq: '6'});
    });
    it('coverage that starts above eventSeq 1', () => {
      const rows = changed(r => { r.events = r.events.filter(e => !(e.pluginSessionId === T && e.eventSeq === '1')); r.trips.pop(); });
      expect(broken(rows)).toEqual(['I2']);
      expect(offending(rows)).toContainEqual({pluginSessionId: T, missingEventSeq: '1'});
    });
    it('overlapping gap rows and events count once (docs/storage.md, overlapping gap rows)', () => {
      const rows = changed(r => { r.gaps.push({pluginSessionId: S, firstEventSeq: '8', lastEventSeq: '10'}, {pluginSessionId: S, firstEventSeq: '9', lastEventSeq: '9'}); });
      expect(broken(rows)).toEqual([]);
    });
  });

  describe('I3 no falsely complete trip', () => {
    it('a complete trip with a not-connected interval', () => {
      const rows = changed(r => { r.intervals.push({tripUuid: A, pluginSessionId: S, kind: 'not-connected', firstEventSeq: null, lastEventSeq: null, annotation: false}); });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a complete trip whose window holds a lost eventSeq', () => {
      const rows = changed(r => { r.events = r.events.filter(e => !(e.pluginSessionId === S && e.eventSeq === '3')); r.gaps.push({pluginSessionId: S, firstEventSeq: '3', lastEventSeq: '3'}); });
      expect(broken(rows)).toEqual(['I3']);
      expect(offending(rows)).toContainEqual({pluginSessionId: S, eventSeq: '3'});
    });
    it('a complete trip whose window holds an event first stored from a redelivery', () => {
      const rows = changed(r => { r.events = r.events.map(e => e.pluginSessionId === S && e.eventSeq === '3' ? {...e, firstRedelivered: true} : e); });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a redelivered event outside the window of a complete trip is not a violation', () => {
      const rows = changed(r => { r.events = r.events.map(e => e.pluginSessionId === S && e.eventSeq === '6' ? {...e, firstRedelivered: true} : e); });
      expect(broken(rows)).toEqual([]);
    });
    it('a complete trip opened from a checkpoint (late attach)', () => {
      const rows = changed(r => { r.trips[0] = {...r.trips[0], openedBy: 'checkpoint', openedEventSeq: null}; });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a complete trip whose outcome comes before its opening', () => {
      const rows = changed(r => { r.trips[0] = {...r.trips[0], openedEventSeq: '6'}; });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a complete trip closed by a gap', () => {
      const rows = changed(r => { r.trips[1] = {...r.trips[1], recordingCompleteness: 'complete'}; });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a complete trip that is still open', () => {
      const rows = changed(r => { r.trips[2] = {...r.trips[2], recordingCompleteness: 'complete'}; });
      expect(broken(rows)).toEqual(['I3']);
    });
    it('a complete trip closed by an outcome of another plugin session', () => {
      const rows = changed(r => {
        r.events.push(ev(T, '2', 'job.delivered'));
        r.sessions[1] = {...r.sessions[1], committedThroughEventSeq: '2'};
        r.trips[2] = {...r.trips[2], openedEventSeq: '1', pluginSessionId: S, game: 'ets2', outcome: 'delivered', outcomeSessionId: T, outcomeEventSeq: '2', closeReason: 'outcome', recordingCompleteness: 'complete'};
        r.attributions.push({pluginSessionId: T, eventSeq: '2', tripUuid: C, attribution: 'trip'});
      });
      expect(broken(rows)).toEqual(['I3']);
    });
  });

  describe('I4 a sound database file', () => {
    it('integrity_check that is not ok', () => {
      expect(broken(changed(r => { r.integrity = '*** in database main ***\nPage 7: btreeInitPage() returns error code 11'; }))).toEqual(['I4']);
    });
    it('a foreign key violation', () => {
      expect(broken(changed(r => { r.foreignKeys = [{table: 'trips', rowid: 1, parent: 'events', fkid: 0}]; }))).toEqual(['I4']);
    });
  });

  describe('I5 one sample per plugin session, source clock and source second', () => {
    it('two samples in one source second of one clock', () => {
      const rows = changed(r => { r.samples.push({pluginSessionId: S, sourceClockId: 'k1', monotonicNs: '1000999999999'}); });
      expect(broken(rows)).toEqual(['I5']);
      expect(offending(rows)).toEqual([{pluginSessionId: S, sourceClockId: 'k1', monotonicNs: '1000000000000'}, {pluginSessionId: S, sourceClockId: 'k1', monotonicNs: '1000999999999'}]);
    });
    it('the same second in another plugin session is a separate second', () => {
      expect(broken(changed(r => { r.samples.push({pluginSessionId: T, sourceClockId: 'k1', monotonicNs: '1000000000000'}); }))).toEqual([]);
    });
  });

  it('the report names the invariant, its rule and the offending rows', () => {
    const text = formatViolations(checkHistoryInvariants(base(), [{pluginSessionId: S, throughEventSeq: '13'}]));
    expect(text).toMatch(/^I2: every acknowledged eventSeq is within committed coverage: \[\{"pluginSessionId":"10000000-0000-4000-8000-000000000001","throughEventSeq":"13"\}/);
  });
});
