import {isCargoClassification, isCargoId, type CargoClassification} from '../../../../packages/contracts/src/cargo-classification';
import {isJournalUuid} from '../../../../packages/contracts/src/journal';
import {isDrivePath} from '../plugin-setup/steam-discovery';

type Game = 'ets2' | 'ats';
export interface CargoLookupRequest {type: 'cargo:lookup'; generation: string; request: string; game: Game; executable: string; cargoId: string}
export interface CargoLookupReply {type: 'cargo:result'; generation: string; request: string; classification: CargoClassification | null}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function isCargoLookupRequest(value: unknown): value is CargoLookupRequest {
  return record(value) && Object.keys(value).sort().join(',') === 'cargoId,executable,game,generation,request,type'
    && value.type === 'cargo:lookup' && isJournalUuid(value.generation) && isJournalUuid(value.request)
    && (value.game === 'ets2' || value.game === 'ats') && isDrivePath(value.executable) && value.executable.length <= 8192 && isCargoId(value.cargoId);
}

export function isCargoLookupReply(value: unknown): value is CargoLookupReply {
  return record(value) && Object.keys(value).sort().join(',') === 'classification,generation,request,type'
    && value.type === 'cargo:result' && isJournalUuid(value.generation) && isJournalUuid(value.request)
    && (value.classification === null || isCargoClassification(value.classification));
}
