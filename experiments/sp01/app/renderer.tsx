import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Reading = { game: 'eut2' | 'ats'; speedMps: number | null; fuelLitres: number | null; paused: boolean; dropped: string };
declare global { interface Window { sp01: { subscribe(callback: (value: Reading | null) => void): () => void } } }
function Overlay() {
  const [value, setValue] = useState<Reading | null>(null);
  useEffect(() => window.sp01.subscribe(setValue), []);
  return <main><div className="label">SP-01 {value?.game === 'ats' ? 'ATS' : 'ETS2'} · {!value ? 'disconnected' : value.paused ? 'paused' : 'live'}{value?.dropped !== '0' && value ? ' · frame gaps' : ''}</div>
    <div className="metrics"><span>{value?.speedMps == null ? '—' : (Math.abs(value.speedMps) * 3.6).toFixed(0)} <small>km/h</small></span><span>{value?.fuelLitres == null ? '—' : value.fuelLitres.toFixed(1)} <small>L</small></span></div></main>;
}
createRoot(document.getElementById('root')!).render(<Overlay />);
