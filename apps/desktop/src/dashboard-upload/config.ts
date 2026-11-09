import {isReleaseDashboardOrigin} from '../../../../packages/contracts/src/dashboard-upload';
import {ACTIVE_CHANNEL, type ReleaseChannel} from '../channel';

// The builder injects one origin for this artifact's channel. Nothing reads the runtime environment.
declare const __ETS2TELEMETRY_DASHBOARD_ORIGIN__: string | null;
export function configuredDashboardOrigin(channel: ReleaseChannel): string | null {
  if (channel !== ACTIVE_CHANNEL || typeof __ETS2TELEMETRY_DASHBOARD_ORIGIN__ === 'undefined' || __ETS2TELEMETRY_DASHBOARD_ORIGIN__ === null) return null;
  if (!isReleaseDashboardOrigin(__ETS2TELEMETRY_DASHBOARD_ORIGIN__)) throw Error('INVALID_UPLOAD_CONFIGURATION');
  return __ETS2TELEMETRY_DASHBOARD_ORIGIN__;
}
