import {CARGO_GROUPS, fragileCargo, isAdrClass, isCargoClassification, type CargoClassification} from '../../../../packages/contracts/src/cargo-classification';
import type {OfficialCargoDefinition} from './official-cargo';

export function classifyCargo(definition?: OfficialCargoDefinition): CargoClassification | null {
  if (!definition) return null;
  const {fragility, adrClass, oversize} = definition;
  const value: CargoClassification = {
    version: 1, fragility, fragile: fragileCargo(fragility), valuable: definition.valuable ?? false,
    adr: isAdrClass(adrClass) ? {state: 'class', class: adrClass} : {state: adrClass === null || adrClass === 0 ? 'none' : 'unsupported'},
    overweight: definition.overweight ?? false, oversize, groups: CARGO_GROUPS.filter(group => definition.groups.includes(group)),
  };
  return isCargoClassification(value) ? value : null;
}
