import {useEffect, useState} from 'react';
/**
 * Whether the dashboard window has focus. The recording dot pulses only then: an endless animation repaints every frame
 * while the window is visible, which measurably slowed the CPU-capped Hard Mode smoke, and must not cost a game that has
 * focus while the dashboard sits on another monitor.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener('focus', update); window.addEventListener('blur', update);
    update();
    return () => {window.removeEventListener('focus', update); window.removeEventListener('blur', update);};
  }, []);
  return focused;
}
