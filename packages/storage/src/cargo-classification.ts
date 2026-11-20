import {isCargoClassification, isCargoId} from '../../contracts/src/cargo-classification';
import {isUint64} from '../../contracts/src/protocol-v0';
import type {CargoOpening, FillCargoClassification} from './api';
import {isUuid} from './codec';
import {fail} from './errors';

/** Both Journal and upload projections read the opening evidence from the selected logical revision. */
export function readCargoClassification(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 1024) fail('DATABASE_CORRUPT');
  let classification: unknown;
  try {classification = JSON.parse(value);} catch {fail('DATABASE_CORRUPT');}
  if (!isCargoClassification(classification)) fail('DATABASE_CORRUPT');
  return classification;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isCargoOpening(value: unknown): value is CargoOpening {
  return record(value) && Object.keys(value).sort().join(',') === 'cargoId,classification,generation'
    && isCargoId(value.cargoId) && isUuid(value.generation)
    && (value.classification === null || isCargoClassification(value.classification));
}

export function isFillCargoClassification(value: unknown): value is FillCargoClassification {
  return record(value) && Object.keys(value).sort().join(',') === 'boundary,cargoId,classification,game,generation,opening,pluginSessionId,tripUuid'
    && isCargoId(value.cargoId) && isUuid(value.generation) && isCargoClassification(value.classification)
    && (value.game === 'ets2' || value.game === 'ats') && isUuid(value.pluginSessionId) && isUuid(value.tripUuid)
    && (value.opening === 'event' || value.opening === 'checkpoint') && isUint64(value.boundary) && value.boundary !== '0';
}
