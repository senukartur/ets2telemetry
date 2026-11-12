import type {JournalTripDetail} from '../../../../packages/contracts/src';
import {journalDetailText, journalDurationText, journalPartialText, type JournalTextOptions} from '../journal-view';
import {t} from '../i18n';
/** Hero text and provenance are separate typed bindings; neither digits nor currency are parsed out of formatted strings. */
export function journalTileValues(detail: JournalTripDetail, options: JournalTextOptions = {}) {
  const text = journalDetailText(detail, options), language = options.language ?? 'en';
  const field = (section: string, id: string) => text.sections.find(item => item.id === section)?.fields.find(value => value.id === id)?.value ?? '—';
  const record = detail.outcomeDetails?.record;
  const delivered = record?.type === 'job.delivered' ? record : undefined;
  const money = delivered ? delivered.revenue : record?.type === 'job.cancelled' ? record.penalty : undefined;
  const kind = detail.trip.outcome === 'cancelled' ? 'penalty' : detail.trip.outcome === 'delivered' ? 'revenue' : 'revenueOrPenalty';
  // Each stored sample is one source second, the basis of the list's recorded hours; UTC labels are never a duration (J13).
  const seconds = detail.samples.count;
  const observed = field('distance', 'observedDistance'), planned = field('distance', 'plannedDistance');
  const distancePartial = journalPartialText(detail.trip.accounting?.distance, language);
  // ET-112e: a delivered trip's game distance is the tile's hero, with the odometer distance as a separate note.
  const distanceTile = delivered?.distance.available
    ? {label: t('tr.gameDistance', undefined, language), value: field('distance', 'deliveredDistance'),
      notes: [`${t('tr.odometer', {v: observed}, language)}${distancePartial ? ` · ${t('j.qty.partial', undefined, language)}` : ''}`, t('tr.planned', {v: planned}, language)]}
    : {label: t('tr.distance', undefined, language), value: detail.trip.observedDistanceM.available ? observed : '—',
      notes: [...(detail.trip.observedDistanceM.available ? [] : [observed]), t('tr.planned', {v: planned}, language), ...(distancePartial ? [distancePartial] : []),
        ...(delivered ? [t('tr.delivered', {v: field('distance', 'deliveredDistance')}, language)] : [])]};
  return {
    distance: {value: detail.trip.observedDistanceM.available ? field('distance', 'observedDistance') : '—',
      note: detail.trip.observedDistanceM.available ? null : field('distance', 'observedDistance')},
    fuel: {value: detail.trip.fuelUsedL.available ? field('fuel', 'fuelUsed') : '—', note: detail.trip.fuelUsedL.available ? null : field('fuel', 'fuelUsed')},
    money: {value: money?.available ? `${money.value.raw}${money.value.currency.status === 'sdk-documented' ? ` ${money.value.currency.code}` : ''}` : '—',
      note: money?.available ? t(money.value.currency.status === 'sdk-documented' ? 'ui.moneyBasisKnown' : 'ui.moneyBasisUnknown', undefined, language) : field('money', kind)},
    planned,
    // The distance tile's label, hero value and notes; `distance` stays the observed value.
    distanceTile,
    fuelPartial: journalPartialText(detail.trip.accounting?.fuel, language),
    // Null unless the game reported a delivery: a trip without one has no game-reported distance to label.
    gameDistance: delivered ? field('distance', 'deliveredDistance') : null,
    expected: field('money', 'expectedIncome'),
    recorded: seconds > 0 ? {value: journalDurationText(seconds, language), note: t('tr.recordedNote', undefined, language)} : {value: '—', note: t('tr.recordedNone', undefined, language)},
    gameTime: delivered?.deliveryDuration.available ? t('tr.gameTime', {v: field('delivery', 'deliveryDuration')}, language) : t('tr.gameTimeNone', undefined, language)
  };
}
