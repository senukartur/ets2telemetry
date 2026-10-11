export function isScaffoldStatus(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Record<string, unknown>;
  return status.service === 'ready' && status.storage === 'verified' && status.synthetic === true;
}
