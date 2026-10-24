import path from 'node:path';

/**
 * Builds a path with the exact target character length under `parentDir` ending in `fileName`,
 * creating intermediate directory segments as needed.
 */
export function exactLengthPath(parentDir: string, fileName: string, targetLen = 282): string {
  let remaining = targetLen - path.join(parentDir, fileName).length - 1;
  const segments: string[] = [];
  while (remaining > 0) {
    const chunk = Math.min(remaining, 80);
    segments.push('d'.repeat(chunk));
    remaining -= chunk;
    if (remaining > 0) remaining -= 1;
  }
  return path.join(parentDir, ...segments, fileName);
}
