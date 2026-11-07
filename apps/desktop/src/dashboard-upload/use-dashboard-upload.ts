import {useEffect, useState, useSyncExternalStore} from 'react';
import type {DashboardUploadBridge} from '../../../../packages/contracts/src/dashboard-upload';
import {DashboardUploadUiController} from './ui-controller';

export function useDashboardUpload(active: boolean, bridge: DashboardUploadBridge = window.desktop) {
  const [controller] = useState(() => new DashboardUploadUiController(bridge));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {controller.start(); return () => controller.stop();}, [controller]);
  useEffect(() => {controller.setAccountActive(active);}, [controller, active]);
  return {controller, state};
}
