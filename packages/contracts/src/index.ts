// Scaffold status only. The telemetry wire protocol belongs to ET-002a.
export interface ScaffoldStatus { service: 'ready'; storage: 'verified'; synthetic: true }
export interface DesktopBridge { getStatus(): Promise<ScaffoldStatus> }
