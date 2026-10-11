// Self-contained browser callback: Playwright serializes this function without module closures.
export function currentTelemetryObservation() {
  const observation = {};
  for (const [field, testId] of [['status', 'telemetry-status'], ['speed', 'speed'], ['fuel', 'fuel']]) {
    const elements = globalThis.document.querySelectorAll(`[data-testid="${testId}"]`);
    if (elements.length !== 1) return false;
    const element = elements[0], bounds = element.getBoundingClientRect();
    if (globalThis.getComputedStyle(element).visibility !== 'visible' || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= globalThis.innerHeight || bounds.left >= globalThis.innerWidth) return false;
    observation[field] = element.innerText;
  }
  return /^connected:/.test(observation.status) && observation.speed === 'Speed: 90.0 km/h' && observation.fuel === 'Fuel: 73.0 L' ? observation : false;
}

export async function waitForCurrentTelemetry(page) {
  const handle = await page.waitForFunction(currentTelemetryObservation, undefined, {timeout: 10000});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}
