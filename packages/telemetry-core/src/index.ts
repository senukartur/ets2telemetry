export function isScaffoldStatus(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return status.service === 'ready' && status.storage === 'verified' && status.synthetic === true;
}
// Pure live-telemetry normalization and display (ET-010a). No Node.js, Electron or React imports; see
// tests/unit/telemetry-core-boundaries.test.ts.
export * from './units';
export * from './display-profile';
export * from './readings';
export * from './normalize-v0';
export * from './normalize-v1';
export * from './format';
export * from './derived';
export * from './live-view';
// Pure trip lifecycle and completeness reducer (ET-014); see docs/trips.md.
export * from './trips/identity';
export * from './trips/accounting';
export * from './trips/types';
export * from './trips/reducer';
export * from './trips/view';
