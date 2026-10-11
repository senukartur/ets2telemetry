const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const [mode, directory, ...values] = process.argv.slice(2);
if (mode === 'normal') {
  console.log(JSON.stringify(values));
  console.error('fixture stderr');
  process.exitCode = 7;
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
} else if (mode === 'leaf') {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, 'leaf', directory], {stdio: 'ignore', windowsHide: true, detached: mode === 'orphan'});
  child.once('spawn', () => {
    fs.writeFileSync(path.join(directory, 'fixture-pids.json'), JSON.stringify([process.pid, child.pid]));
    if (mode === 'orphan') process.exit(0);
  });
  setInterval(() => {}, 1000);
}
