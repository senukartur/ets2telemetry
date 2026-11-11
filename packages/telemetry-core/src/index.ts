// Pure live-telemetry normalization and display (ET-010a). No Node.js, Electron or React imports; see
// tests/unit/telemetry-core-boundaries.test.ts.
export * from './units';
export * from './display-profile';
export * from './readings';
export * from './normalize-v0';
export * from './normalize-v1';
export * from './format';
// Gearbox-aware gear labels (ET-050b).
export * from './gear-labels';
// The next mandatory break (ET-052).
export * from './mandatory-break';
// The cruise control set speed (ET-071).
export * from './cruise-control';
// The navigation speed limit (ET-084).
export * from './speed-limit';
export * from './derived';
export * from './live-view';
// Pure trip lifecycle and completeness reducer (ET-014); see docs/trips.md.
export * from './trips/identity';
export * from './trips/continuation';
export * from './trips/membership';
export * from './trips/progress';
export * from './trips/accounting';
export * from './trips/types';
export * from './trips/reducer';
export * from './trips/view';
// Pure one-second history sampler (ET-015b); see docs/trips.md.
export * from './history-samples';

export * from './hard-mode';
