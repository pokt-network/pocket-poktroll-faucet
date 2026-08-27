import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidAddress } from '../address.js';

// Real addresses observed on chain.
const VALID = 'pokt1ptj9f7epekgdn4e8w4mafkh2n7dkxgua7leszg';
const FAUCET = 'pokt1x5h2ukge8g0d2lfemevmgh2g962m5e300ax8zn';

test('accepts a well-formed address with the expected prefix', () => {
  assert.equal(isValidAddress(VALID, 'pokt'), true);
  assert.equal(isValidAddress(FAUCET, 'pokt'), true);
});

// The reason this validation exists: a prefix-only check passed these through
// to be signed and broadcast, and the chain rejected them with an
// invalid-address error after the fee had already been spent.
test('rejects a prefixed string that is not valid bech32', () => {
  assert.equal(isValidAddress('pokt1garbage', 'pokt'), false);
});

test('rejects a mistyped address that fails its checksum', () => {
  const mistyped = VALID.slice(0, -1) + 'a';
  assert.notEqual(mistyped, VALID);
  assert.equal(isValidAddress(mistyped, 'pokt'), false);
});

test('rejects a valid address belonging to another chain', () => {
  assert.equal(isValidAddress('cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', 'pokt'), false);
});

test('rejects a hex address', () => {
  // The old check allowed anything starting with 0x, left over from the
  // removed Ethermint path. On a Cosmos chain it can only fail.
  assert.equal(isValidAddress('0x1234567890abcdef1234567890abcdef12345678', 'pokt'), false);
});

test('rejects empty and malformed input without throwing', () => {
  for (const bad of ['', 'pokt', 'pokt1', 'not-an-address', '1pokt', ' ' + VALID]) {
    assert.equal(isValidAddress(bad, 'pokt'), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('rejects non-string input without throwing', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(isValidAddress(bad, 'pokt'), false);
  }
});
