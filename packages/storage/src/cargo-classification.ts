import {isCargoClassification, isCargoId} from '../../contracts/src/cargo-classification';
import {isUint64} from '../../contracts/src/protocol-v0';
import type {CargoOpening, FillCargoClassification} from './api';
import {isUuid} from './codec';

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
