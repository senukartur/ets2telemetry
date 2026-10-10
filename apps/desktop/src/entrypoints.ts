import path from 'node:path';

// Node workers and utility processes need real files, outside Electron's ASAR filesystem.
export function processEntrypoint(directory: string, name: 'telemetry-service' | 'storage-worker'): string {
  return path.join(directory, `${name}.cjs`).replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
}
