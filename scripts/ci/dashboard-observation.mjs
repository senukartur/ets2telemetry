// Self-contained browser callback. All speed evidence comes from the visible SVG; never from backend state.
export function dashboardObservation(expected = {}) {
  const one = id => {const nodes = globalThis.document.querySelectorAll('[data-testid="' + id + '"]'); return nodes.length === 1 ? nodes[0] : undefined;};
  const visible = (node, viewport = true) => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0) || viewport && (box.left < 0 || box.top < 0 || box.right > globalThis.innerWidth || box.bottom > globalThis.innerHeight)) return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = globalThis.getComputedStyle(ancestor);
      if (style.visibility !== 'visible' || Number(style.opacity ?? 1) === 0) return false;
      if (ancestor === node) continue;
      const clip = ancestor.getBoundingClientRect();
      if (/(?:hidden|clip|auto|scroll)/.test(style.overflowX ?? '') && (box.left < clip.left || box.right > clip.right) ||
          /(?:hidden|clip|auto|scroll)/.test(style.overflowY ?? '') && (box.top < clip.top || box.bottom > clip.bottom)) return false;
    }
    return true;
  };
  const number = one('live-speed-number'), unit = one('live-speed-unit'), svg = one('live-speed-gauge');
  if (![number, unit, svg].every(node => visible(node)) || globalThis.document.querySelectorAll('[data-testid="speed"]').length || svg.getAttribute('role') !== 'img') return false;
  const outer = svg.getBoundingClientRect();
  if (![number, unit].every(node => {const box = node.getBoundingClientRect(); return box.left >= outer.left && box.top >= outer.top && box.right <= outer.right && box.bottom <= outer.bottom;})) return false;
  const language = globalThis.document.documentElement.lang;
  if (!['en', 'ru'].includes(language)) return false;
  const label = language === 'en' ? 'Speed' : 'Скорость', rpm = language === 'en' ? 'Engine RPM' : 'Обороты';
  const value = number.textContent, units = unit.textContent;
  const speed = label + ': ' + (value === '—' ? language === 'en' ? 'unavailable' : 'недоступно' : value + ' ' + units);
  const accessibleName = svg.getAttribute('aria-label'), prefix = speed + '; ' + rpm + ': ';
  if (typeof accessibleName !== 'string' || !accessibleName.startsWith(prefix) || accessibleName.length <= prefix.length) return false;
  const read = (id, viewport = false) => {const node = one(id); return visible(id === 'telemetry-status' ? one('shell.status.connection') : node, viewport) ? node?.innerText : undefined;};
  const observation = {status: read(expected.statusId ?? 'telemetry-status', !expected.statusId), speed,
    gauge: {number: value, unit: units, accessibleName, visible: true}};
  const unavailable = expected.values !== undefined;
  const wantedSpeed = expected.speed ?? (unavailable ? 'Speed: unavailable' : 'Speed: 90 km/h');
  if (!new RegExp(expected.status ?? '^connected:').test(observation.status ?? '') || speed !== wantedSpeed) return false;
  if (!expected.omitFuel) {
    observation.fuel = read('fuel', true);
    if (observation.fuel !== (expected.fuel ?? (unavailable ? 'Fuel: unavailable' : 'Fuel: 73.0 L'))) return false;
  }
  for (const id of expected.values ?? []) {
    if (read(id) !== 'unavailable' || read(id + '-reason') !== 'not current') return false;
    observation[id] = 'unavailable';
  }
  for (const id of expected.hidden ?? []) if (globalThis.document.querySelectorAll('[data-testid="' + id + '"]').length) return false;
  return observation;
}
