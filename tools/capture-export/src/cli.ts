import path from 'node:path';
import {exportCapture} from './sanitize';

async function main(): Promise<void> {
  const [capture, output, ...extra] = process.argv.slice(2);
  if (!capture || !output || extra.length) throw new Error('Usage: cli.cjs <raw-capture-directory> <new-export-directory>');
  const result = await exportCapture(path.resolve(capture), path.resolve(output));
  console.log(JSON.stringify({sanitized: true, packets: result.packets, counts: result.counts, files: result.files}));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'CAP0 export failed'); process.exitCode = 1; });
