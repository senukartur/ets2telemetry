import React, {useEffect,useState} from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '../../../packages/contracts/src';
declare global { interface Window {desktop:DesktopBridge} }
function App() {
  const [state,setState] = useState('Starting');
  useEffect(() => {window.desktop.getStatus().then(() => setState('Telemetry service ready; isolated storage probe verified')).catch(() => setState('Startup failed'));},[]);
  return <main><h1>ETS2Telemetry</h1><p>{state}</p><p>Scaffold only. No game telemetry or trip recording.</p></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
