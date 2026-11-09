import {describe, expect, it} from 'vitest';
import {isJournalListCursor, isJournalTripsQuery, validateJournalTripPage, type JournalTripListItem} from '../../packages/contracts/src/journal';
import {desktopLiveView, liveGameMode} from '../../apps/desktop/src/screens/desktop-ui-view';
import {smokePair} from '../shared/live-v1-fixtures';

describe('ET-062 HaulMP game mode contracts and live detection', () => {
  it('accepts haulmp in query filters and list cursors, rejecting invalid modes', () => {
    expect(isJournalTripsQuery({mode: 'haulmp'})).toBe(true);
    expect(isJournalTripsQuery({mode: 'truckersmp'})).toBe(true);
    expect(isJournalTripsQuery({mode: 'single-player'})).toBe(true);
    expect(isJournalTripsQuery({mode: 'invalid' as unknown as 'haulmp'})).toBe(false);

    const validHaulmpCursor = 'l5:00000000-0000-4000-8000-000000000001:1:1:ets2.delivered.complete.haulmp.freight-market';
    const invalidCursor = 'l5:00000000-0000-4000-8000-000000000001:1:1:ets2.delivered.complete.invalid-mode.freight-market';
    expect(isJournalListCursor(validHaulmpCursor)).toBe(true);
    expect(isJournalListCursor(invalidCursor)).toBe(false);
  });

  it('validates a journal trip list item with haulmp game mode', () => {
    const item: JournalTripListItem = {
      isHardMode: false,
      hardModeDetails: null,
      tripUuid: '00000000-0000-4000-8000-000000000001',
      game: 'ets2',
      gameMode: {mode: 'haulmp', method: 'module-scan', confidence: 'strong'},
      gameModeAmbiguous: false,
      outcome: 'delivered',
      closeReason: 'outcome',
      recordingCompleteness: 'complete',
      startedUtcMs: 1700000000000,
      endedUtcMs: 1700001000000,
      observedDistanceM: {available: true, value: 50000},
      fuelUsedL: {available: true, value: 20},
      job: {
        source: 'event',
        sourceCity: {available: true, value: 'Berlin'},
        sourceCompany: {available: true, value: 'EuroGoodies'},
        destinationCity: {available: true, value: 'Paris'},
        destinationCompany: {available: true, value: 'Tradeaux'},
        cargo: {available: true, value: 'Apples'},
        market: {available: true, value: 'freight_market'},
        isSpecialJob: {available: true, value: false},
        plannedDistance: {available: true, value: 50000, unit: 'm'},
        expectedIncome: {available: true, value: {raw: '1000', sdkType: 'u64', currency: {status: 'unknown'}}}
      }
    };
    expect(() => validateJournalTripPage({database: {purpose: 'history', schemaVersion: 7}, trips: [item], nextCursor: null})).not.toThrow();
  });

  it('determines liveGameMode from desktop sources for HaulMP', () => {
    const live = smokePair();
    live.v1!.observation!.sourceStatus.gameMode = {
      mode: 'haulmp',
      method: 'module-scan',
      confidence: 'strong',
      module: {available: true, value: 'haulmp_stub.dll'}
    };
    const view = desktopLiveView(live);
    expect(liveGameMode(view.sources)).toBe('haulmp');

    // Weak confidence does not qualify as confirmed HaulMP
    const weakLive = smokePair();
    weakLive.v1!.observation!.sourceStatus.gameMode = {
      mode: 'haulmp',
      method: 'module-scan',
      confidence: 'weak',
      module: {available: true, value: 'haulmp_stub.dll'}
    };
    expect(liveGameMode(desktopLiveView(weakLive).sources)).toBeNull();
  });
});
