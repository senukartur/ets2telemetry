import {dashboardOrigin} from '../../../../packages/contracts/src/dashboard-upload';
import type {ReleaseChannel} from '../channel';
// Activation requires a separately approved deployment change. No renderer/env/CLI override exists.
export const DASHBOARD_ORIGINS:Readonly<Record<ReleaseChannel,string|null>>=Object.freeze({production:null,staging:null});
export function isReleaseDashboardOrigin(value:unknown):value is string {
  if(!dashboardOrigin(value))return false;
  const host=new URL(value).hostname.toLowerCase();return !(host==='localhost'||host==='[::1]'||host==='0.0.0.0'||host.startsWith('127.')||host.endsWith('.localhost'));
}
export function configuredDashboardOrigin(channel:ReleaseChannel):string|null {
  const value=DASHBOARD_ORIGINS[channel];if(value===null)return null;
  if(!isReleaseDashboardOrigin(value))throw Error('INVALID_UPLOAD_CONFIGURATION');
  return value;
}
