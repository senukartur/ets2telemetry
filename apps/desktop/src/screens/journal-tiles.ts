import type {JournalTripDetail} from '../../../../packages/contracts/src';
import {journalDetailText, type JournalTextOptions} from '../journal-view';
import {t} from '../i18n';
/** Hero text and provenance are separate typed bindings; neither digits nor currency are parsed out of formatted strings. */
export function journalTileValues(detail: JournalTripDetail, options: JournalTextOptions = {}) {
  const text = journalDetailText(detail, options), language = options.language ?? 'en';
  const field = (section: string, id: string) => text.sections.find(item => item.id === section)?.fields.find(value => value.id === id)?.value ?? '—';
  const record = detail.outcomeDetails?.record;
  const money = record?.type === 'job.delivered' ? record.revenue : record?.type === 'job.cancelled' ? record.penalty : undefined;
  const kind = detail.trip.outcome === 'cancelled' ? 'penalty' : detail.trip.outcome === 'delivered' ? 'revenue' : 'revenueOrPenalty';
  return {
    distance: {value: detail.trip.observedDistanceM.available ? field('distance', 'observedDistance') : '—',
      note: detail.trip.observedDistanceM.available ? null : field('distance', 'observedDistance')},
    fuel: {value: detail.trip.fuelUsedL.available ? field('fuel', 'fuelUsed') : '—', note: detail.trip.fuelUsedL.available ? null : field('fuel', 'fuelUsed')},
    money: {value: money?.available ? `${money.value.raw}${money.value.currency.status === 'sdk-documented' ? ` ${money.value.currency.code}` : ''}` : '—',
      note: money?.available ? t(money.value.currency.status === 'sdk-documented' ? 'ui.moneyBasisKnown' : 'ui.moneyBasisUnknown', undefined, language) : field('money', kind)},
    realDuration: '—'
  };
}
