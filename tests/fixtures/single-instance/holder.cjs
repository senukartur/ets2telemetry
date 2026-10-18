// ET-018 U6 relock proof, the running instance's side: an Electron main script that holds the single-instance lock of an
// isolated userData folder and reports each second-instance signal on stdout. With HOLDER_EXIT=1 it exits 600 ms after the
// first signal whose data is the uninstall-exit payload, as main's explicit exit would; otherwise it never exits on a
// signal. It exits 7 after 20 s in any case. Only tests/unit/single-instance-relock.test.ts runs it.
const {app} = require('electron');

app.setPath('userData', process.env.LOCK_DIR);
if (!app.requestSingleInstanceLock()) {
  process.stdout.write('HOLDER_NO_LOCK\n');
  app.exit(9);
} else {
  process.stdout.write('HOLDER_LOCKED\n');
  let exiting = false;
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    const plain = typeof data === 'object' && data !== null && Object.getPrototypeOf(data) === Object.prototype;
    process.stdout.write(`HOLDER_SIGNAL ${JSON.stringify({plain, data})}\n`);
    if (process.env.HOLDER_EXIT === '1' && plain && data.ets2telemetry === 'uninstall-exit' && !exiting) {
      exiting = true;
      setTimeout(() => app.exit(0), 600);
    }
  });
  setTimeout(() => app.exit(7), 20000);
}
