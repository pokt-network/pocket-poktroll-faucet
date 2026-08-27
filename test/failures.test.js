import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure } from '../failures.js';

// Real messages seen from cosmjs and the chain.
const cases = [
  ["Account 'pokt1abc' does not exist on chain. Send some tokens there before trying to query sequence.", 'sender_not_on_chain'],
  ['account sequence mismatch, expected 42, got 41', 'sequence_mismatch'],
  ['insufficient funds: insufficient account funds', 'insufficient_funds'],
  ['Connection to blockchain node timed out.', 'timeout'],
  ['invalid to address: decoding bech32 failed', 'invalid_address'],
  ['something nobody predicted', 'other'],
];

for (const [message, expected] of cases) {
  test(`classifies: ${message.slice(0, 46)}`, () => {
    assert.equal(classifyFailure(new Error(message)), expected);
  });
}

// The unfunded-sender message contains the word "sequence", so a naive
// substring order files it as a sequence mismatch. It is the message every
// misconfigured deployment produces first, so getting it wrong would point
// operators at the wrong problem on day one.
test('an unfunded sender is not misfiled as a sequence mismatch', () => {
  const unfunded = new Error("Account 'pokt1x' does not exist on chain. Send some tokens there before trying to query sequence.");
  assert.equal(classifyFailure(unfunded), 'sender_not_on_chain');
  assert.notEqual(classifyFailure(unfunded), 'sequence_mismatch');
});

test('handles a missing or malformed error without throwing', () => {
  for (const bad of [undefined, null, {}, 'a string', new Error()]) {
    assert.equal(classifyFailure(bad), 'other');
  }
});
