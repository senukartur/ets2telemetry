'use strict';
// The caller supplies the existing physical-to-DIP conversion. Preserve the
// speed/fuel window's size and repair external size changes before showing it.
function updateOverlayBounds(overlay, rect) {
  const target = { x: Math.round(rect.x + 20), y: Math.round(rect.y + 20), width: 280, height: 96 };
  const current = overlay.getBounds();
  if (Object.keys(target).every((key) => current[key] === target[key])) return false;
  overlay.setBounds(target);
  return true;
}
module.exports = { updateOverlayBounds };
