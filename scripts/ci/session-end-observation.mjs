import assert from 'node:assert/strict';
import path from 'node:path';
import {observeExit} from './exit-observation.mjs';

/** Only the sender's verified owned-window receipt can establish delivery; process exit alone is insufficient. */
export function assertSessionSender(receipt, target, executable, mode) {
  assert.ok(receipt && typeof receipt === 'object', 'Native sender receipt missing');
  assert.equal(receipt.ownerPidVerified, true); assert.equal(receipt.imageVerified, true);
  assert.equal(receipt.broadcast, false); assert.equal(receipt.mode, mode);
  assert.equal(receipt.verifiedPid, target.pid);
  assert.equal(typeof receipt.verifiedHwnd, 'string');
  assert.match(receipt.verifiedHwnd, /^[0-9a-f]{1,16}$/i);
  assert.equal(BigInt(`0x${receipt.verifiedHwnd}`), BigInt(`0x${target.handle}`));
  assert.equal(typeof receipt.verifiedImage, 'string');
  assert.equal(path.win32.normalize(receipt.verifiedImage).toLowerCase(), path.win32.normalize(executable).toLowerCase());
  assert.equal(typeof receipt.sendReturnedSuccess, 'boolean');
  assert.equal(typeof receipt.targetActiveAfterSend, 'boolean');
  assert.ok(Number.isInteger(receipt.win32Error) && receipt.win32Error >= 0 && receipt.win32Error <= 0xffffffff);
  if (mode === 'cancel') {
    assert.equal(receipt.sendReturnedSuccess, true); assert.equal(receipt.targetActiveAfterSend, true);
  } else {
    assert.equal(mode, 'end');
    // Electron can exit inside its window procedure before SendMessageTimeout receives a normal reply.
    assert.ok(receipt.sendReturnedSuccess || !receipt.targetActiveAfterSend, 'Native message failed while target remained active');
  }
}

export async function observeSessionEnd({application, launcher, send, target, executable, record}) {
  return await observeExit({application, launcher, record: record.exitObservation = {}, message: 'SESSION_END_EXIT_TIMEOUT_8_SECONDS', requireRequest: true,
    request: async () => {
      record.sender = await send();
      assertSessionSender(record.sender, target, executable, 'end');
    }});
}
