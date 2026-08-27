import test from 'node:test';
import assert from 'node:assert/strict';

// cosmjs raises TimeoutError when a transaction was accepted by the node but
// has not appeared in a block before broadcastTimeoutMs. Its only reliable
// marker is txId; the message deliberately does not say "timeout".
class TimeoutError extends Error {
  constructor(message, txId) { super(message); this.txId = txId; }
}

const COSMJS_TIMEOUT_MESSAGE = (id, secs) =>
  `Transaction with ID ${id} was submitted but was not yet found on the chain. You might want to check later. There was a wait of ${secs} seconds.`;

test('the cosmjs timeout message contains no matchable "timeout" substring', () => {
  const message = COSMJS_TIMEOUT_MESSAGE('ABC123', 90);
  // This is why matching on the text silently disabled the pending path: a
  // submitted transaction was reported to the user as an outright failure,
  // and its quota was refunded, inviting a retry that could grant twice.
  assert.equal(message.toLowerCase().includes('timeout'), false);
});

test('txId is the reliable marker for a submitted-but-unconfirmed transaction', () => {
  const err = new TimeoutError(COSMJS_TIMEOUT_MESSAGE('ABC123', 90), 'ABC123');
  assert.equal(Boolean(err.txId), true);
  assert.equal(err.txId, 'ABC123');

  // An ordinary failure carries no txId, so the two are distinguishable.
  assert.equal(Boolean(new Error('some other failure').txId), false);
});

test('a pending result keeps the hash so the user can look it up', () => {
  const err = new TimeoutError(COSMJS_TIMEOUT_MESSAGE('DEADBEEF', 90), 'DEADBEEF');
  const result = err.txId
    ? { code: 1, status: 'PENDING', txhash: err.txId }
    : null;
  assert.equal(result.status, 'PENDING');
  assert.equal(result.txhash, 'DEADBEEF');
});
