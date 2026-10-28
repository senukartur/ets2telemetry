// ET-018 U6 relock proof, the uninstall hook's side: requests the same lock with the uninstall-exit payload, then again
// every 200 ms until it holds it or REQUEST_WAIT_MS passes, as squirrel-events.ts closeInstance does. It prints the result,
// the number of requests and the elapsed milliseconds. tests/unit/single-instance-relock.test.ts runs it, and so does
// the hosted update-from-feed lifecycle (scripts/installer/installer-lifecycle.mjs, ET-055 PR-8) to ask an instance that
// Update.exe or Squirrel's stub started to run its explicit exit, as the uninstall hook does.
const {app} = require('electron');

app.setPath('userData', process.env.LOCK_DIR);
const wait = Number(process.env.REQUEST_WAIT_MS);
const started = Date.now();
let requests = 0;
function attempt() {
  requests++;
  if (app.requestSingleInstanceLock({ets2telemetry: 'uninstall-exit'})) {
    process.stdout.write(`REQUESTER ${JSON.stringify({locked: true, requests, elapsedMs: Date.now() - started})}\n`);
    app.exit(0);
  } else if (Date.now() - started >= wait) {
    process.stdout.write(`REQUESTER ${JSON.stringify({locked: false, requests, elapsedMs: Date.now() - started})}\n`);
    app.exit(3);
  } else setTimeout(attempt, 200);
}
attempt();
