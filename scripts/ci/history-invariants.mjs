// ET-019: the history invariants every recovery test checks after a kill, a restart or a fault (REG-005, REG-006,
// REG-012). The checker is pure JavaScript over plain row objects, so the storage suite, the runtime smokes and a later
// soak can share it without loading SQLite; tests/storage/history-rows.ts reads the rows from a closed database.
//
// Each rule is written from the documents, never read back from the code under test:
// - I1 no duplicate delivered trips and no double accounting: docs/trips.md, "States and transitions" (an outcome closes
//   the trip it attributes, `{outcome, this-event}`; each game has one slot with at most one open trip) and "Attribution
//   (T14)" (each gameplay event gets exactly one `event.attribute`, other events none; an event of an active cargo_market
//   job before pickup, its outcome included, is `trip-before-loaded`, otherwise an event of the trip is `trip`).
// - I2 no acknowledged-but-lost events: docs/storage.md, "Storage API" (coverage is the contiguous committed prefix of
//   events and gap rows; an ACK may be built only from that value) and protocol v1 §10.
// - I3 no falsely complete trip: docs/trips.md, "What complete means (T13)": complete only when its gameplay outcome closes
//   it after a clean window; a late attach, a replayed configuration, a reconnection or consumer restart, an event loss
//   and every non-annotation interval make it partial, while annotations (`detail.annotation: true`) never downgrade.
//   Protocol v1 §5: an event is `redelivered` when it was already written to an earlier connection, so a window that
//   holds a first-stored redelivered event spans a reconnection or a replayed configuration. docs/storage.md "Overlapping
//   gap rows": the lost eventSeqs are the gap ranges minus the eventSeqs that have an event row, so a window in which
//   every eventSeq has an event row has no loss.
// - I4 a sound file: docs/storage.md, durability and backups (`integrity_check` is `ok`, `foreign_key_check` is empty).
// - I5 one sample per plugin session, source clock and source second: docs/trips.md, "One-second sampler" (H3, H6) and
//   docs/storage.md, `appendSamples` with `uniqueSeconds`.
//
// Every uint64 (eventSeq, coverage, ACK, monotonic nanoseconds) is a canonical decimal string and compared as BigInt.

/** docs/trips.md, Attribution (T14): the gameplay events; every other event type gets no attribution. */
export const GAMEPLAY_EVENTS = Object.freeze(['job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train']);
/** The outcome event type of each closed outcome. */
const OUTCOME_EVENT = {delivered: 'job.delivered', cancelled: 'job.cancelled'};
const closedByOutcome = outcome => Object.hasOwn(OUTCOME_EVENT, outcome);
/**
 * docs/trips.md, Attribution (T14): the attributions that bind an event to a trip. An outcome that closes an active
 * cargo_market trip before pickup (cargoLoaded available and false) is `trip-before-loaded`, any other closing outcome `trip`.
 */
const TRIP_ATTRIBUTIONS = ['trip', 'trip-before-loaded'];

const big = value => BigInt(value);
const eventKey = (session, eventSeq) => `${session}#${big(eventSeq)}`;

/** Merged closed ranges [first, last] of BigInt bounds, ascending. */
function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), out = [];
  for (const [first, last] of sorted) {
    const previous = out.at(-1);
    if (previous && first <= previous[1] + 1n) { if (last > previous[1]) previous[1] = last; } else out.push([first, last]);
  }
  return out;
}

function i1(rows, add) {
  const events = new Map(rows.events.map(e => [eventKey(e.pluginSessionId, e.eventSeq), e]));
  const attributions = new Map();
  for (const a of rows.attributions) {
    const k = eventKey(a.pluginSessionId, a.eventSeq);
    attributions.set(k, [...(attributions.get(k) ?? []), a]);
  }
  // Every gameplay event has exactly one attribution, every other event none (T14).
  for (const e of rows.events) {
    const found = attributions.get(eventKey(e.pluginSessionId, e.eventSeq)) ?? [], gameplay = GAMEPLAY_EVENTS.includes(e.type);
    if (gameplay && found.length !== 1) add('I1', 'a gameplay event has exactly one attribution', [e, ...found]);
    if (!gameplay && found.length) add('I1', 'an event that is not a gameplay event has no attribution', [e, ...found]);
  }
  for (const a of rows.attributions) if (!events.has(eventKey(a.pluginSessionId, a.eventSeq))) add('I1', 'an attribution names a stored event', [a]);
  // Each delivered or cancelled trip is closed by its own stored outcome event, which attributes it, and no outcome event
  // closes two trips.
  const closedBy = new Map();
  for (const t of rows.trips) {
    if (!closedByOutcome(t.outcome)) {
      if (t.outcomeEventSeq !== null) add('I1', 'only a delivered or cancelled trip has an outcome event', [t]);
      continue;
    }
    if (t.outcomeEventSeq === null || t.outcomeSessionId === null) { add('I1', 'a delivered or cancelled trip names its outcome event', [t]); continue; }
    const k = eventKey(t.outcomeSessionId, t.outcomeEventSeq), event = events.get(k);
    if (!event || event.type !== OUTCOME_EVENT[t.outcome]) add('I1', `a ${t.outcome} trip is closed by a stored ${OUTCOME_EVENT[t.outcome]} event`, [t, event ?? null]);
    if (t.closeReason !== 'outcome') add('I1', 'a delivered or cancelled trip has close reason outcome', [t]);
    const own = attributions.get(k) ?? [];
    if (own.length !== 1 || !TRIP_ATTRIBUTIONS.includes(own[0].attribution) || own[0].tripUuid !== t.tripUuid) add('I1', 'the outcome event is attributed to the trip it closes', [t, ...own]);
    closedBy.set(k, [...(closedBy.get(k) ?? []), t]);
  }
  for (const trips of closedBy.values()) if (trips.length > 1) add('I1', 'no outcome event closes two trips', trips);
  // Each game has one slot with at most one open trip.
  const open = new Map();
  for (const t of rows.trips) if (t.outcome === 'open') open.set(t.game, [...(open.get(t.game) ?? []), t]);
  for (const trips of open.values()) if (trips.length > 1) add('I1', 'at most one open trip per game', trips);
}

function i2(rows, acks, add) {
  const sessions = new Map(rows.sessions.map(s => [s.pluginSessionId, s]));
  for (const ack of acks) {
    const session = sessions.get(ack.pluginSessionId);
    const coverage = session ? big(session.committedThroughEventSeq) : 0n;
    if (big(ack.throughEventSeq) > coverage) add('I2', 'every acknowledged eventSeq is within committed coverage', [ack, session ?? null]);
  }
  // Coverage is the contiguous prefix of stored events and gap rows: every eventSeq at or below it is one or the other.
  for (const session of rows.sessions) {
    const coverage = big(session.committedThroughEventSeq);
    if (coverage === 0n) continue;
    const ranges = merge([
      ...rows.events.filter(e => e.pluginSessionId === session.pluginSessionId).map(e => [big(e.eventSeq), big(e.eventSeq)]),
      ...rows.gaps.filter(g => g.pluginSessionId === session.pluginSessionId).map(g => [big(g.firstEventSeq), big(g.lastEventSeq)])]);
    const first = ranges[0];
    if (!first || first[0] !== 1n || first[1] < coverage) {
      const missing = !first || first[0] !== 1n ? 1n : first[1] + 1n;
      add('I2', 'every eventSeq at or below coverage is a stored event or inside a stored gap', [session, {pluginSessionId: session.pluginSessionId, missingEventSeq: missing.toString()}]);
    }
  }
}

function i3(rows, add) {
  const events = new Map(rows.events.map(e => [eventKey(e.pluginSessionId, e.eventSeq), e]));
  for (const t of rows.trips) {
    if (t.recordingCompleteness !== 'complete') continue;
    const fail = (rule, extra = []) => add('I3', rule, [t, ...extra]);
    if (!closedByOutcome(t.outcome) || t.closeReason !== 'outcome') { fail('a complete trip is closed by its gameplay outcome'); continue; }
    if (t.openedBy !== 'event' || t.openedEventSeq === null) { fail('a complete trip opened at an event, not from a checkpoint (late attach)'); continue; }
    if (t.outcomeSessionId !== t.pluginSessionId || t.outcomeEventSeq === null) { fail('a complete trip opens and closes in one plugin session'); continue; }
    const intervals = rows.intervals.filter(i => i.tripUuid === t.tripUuid && !i.annotation);
    if (intervals.length) fail('a complete trip has no completeness interval other than annotations', intervals);
    const from = big(t.openedEventSeq), to = big(t.outcomeEventSeq);
    if (to < from) { fail('a complete trip closes after it opens'); continue; }
    // The walk is linear in the window and stops after four offending eventSeqs, enough to name the violation.
    const missing = [], redelivered = [];
    for (let seq = from; seq <= to && missing.length + redelivered.length < 4; seq++) {
      const event = events.get(eventKey(t.pluginSessionId, seq));
      if (!event) missing.push({pluginSessionId: t.pluginSessionId, eventSeq: seq.toString()});
      else if (event.firstRedelivered) redelivered.push(event);
    }
    if (missing.length) fail('every eventSeq between the opening and the outcome of a complete trip is a stored event (no event loss)', missing);
    if (redelivered.length) fail('no event in the window of a complete trip was first stored from a redelivery (reconnection, restart or replay)', redelivered);
  }
}

function i4(rows, add) {
  if (rows.integrity !== 'ok') add('I4', 'integrity_check is ok', [{integrity: rows.integrity}]);
  if (rows.foreignKeys.length) add('I4', 'foreign_key_check is empty', rows.foreignKeys);
}

function i5(rows, add) {
  const seen = new Map();
  for (const s of rows.samples) {
    const k = `${s.pluginSessionId}#${s.sourceClockId}#${big(s.monotonicNs) / 1_000_000_000n}`;
    seen.set(k, [...(seen.get(k) ?? []), s]);
  }
  for (const samples of seen.values()) if (samples.length > 1) add('I5', 'at most one sample per plugin session, source clock and source second', samples);
}

/**
 * Checks I1–I5 over the rows of one closed database and the ACKs written to the pipes. Returns every violation as
 * `{invariant, rule, rows}`, naming the offending rows; an empty array means the history holds every invariant.
 */
export function checkHistoryInvariants(rows, acks = []) {
  const violations = [];
  const add = (invariant, rule, offending) => { violations.push({invariant, rule, rows: offending}); };
  i1(rows, add);
  i2(rows, acks, add);
  i3(rows, add);
  i4(rows, add);
  i5(rows, add);
  return violations;
}

/** One line per violation, for a failure message: the invariant, its rule and the offending rows as JSON. */
export function formatViolations(violations) {
  return violations.map(v => `${v.invariant}: ${v.rule}: ${JSON.stringify(v.rows)}`).join('\n');
}
