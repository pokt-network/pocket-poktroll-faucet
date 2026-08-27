import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FrequencyChecker } from '../checker.js';

const CHAIN = 'pocket-beta';

// Limits arrive from .env as strings, so keep them as strings here.
function makeChecker({ address = '2', ip = '10', hours = '24' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-checker-'));
  const checker = new FrequencyChecker({
    db: { path: path.join(dir, 'history.db') },
    blockchains: [{ name: CHAIN, limit: { address, ip, hours } }]
  });
  return { checker, cleanup: async () => { await checker.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('sequential requests are allowed up to the limit, then denied', async () => {
  const { checker, cleanup } = makeChecker({ address: '2' });
  try {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checker.checkAddress('pokt1abc', CHAIN));
    assert.deepEqual(results, [true, true, false, false]);
  } finally { await cleanup(); }
});

// This is the regression that matters. The previous implementation read the
// history of every concurrent request before any of them wrote, so all of them
// passed a limit of 2 and only one hit was recorded.
test('concurrent requests cannot exceed the limit', async () => {
  const { checker, cleanup } = makeChecker({ address: '2' });
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checker.checkAddress('pokt1burst', CHAIN))
    );
    const allowed = results.filter(Boolean).length;
    assert.equal(allowed, 2, `expected 2 of 10 concurrent requests allowed, got ${allowed}`);

    const recorded = await checker.read(checker.addressKey('pokt1burst', CHAIN));
    assert.equal(recorded.length, 2, `expected 2 recorded hits, got ${recorded.length}`);
  } finally { await cleanup(); }
});

test('concurrent requests cannot exceed the ip limit either', async () => {
  const { checker, cleanup } = makeChecker({ ip: '3' });
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => checker.checkIp('203.0.113.7', CHAIN))
    );
    assert.equal(results.filter(Boolean).length, 3);
  } finally { await cleanup(); }
});

test('address and ip quotas are independent', async () => {
  const { checker, cleanup } = makeChecker({ address: '1', ip: '5' });
  try {
    assert.equal(await checker.checkAddress('pokt1solo', CHAIN), true);
    assert.equal(await checker.checkAddress('pokt1solo', CHAIN), false);
    // Same principal, different key space: the ip quota is untouched.
    assert.equal(await checker.checkIp('203.0.113.8', CHAIN), true);
  } finally { await cleanup(); }
});

test('hits outside the window are pruned and stop counting', async () => {
  // 1 hour window, with a hit backdated well past it.
  const { checker, cleanup } = makeChecker({ address: '2', hours: '1' });
  try {
    const key = checker.addressKey('pokt1stale', CHAIN);
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    await checker.db.put(key, [twoHoursAgo, twoHoursAgo]);

    assert.equal(await checker.checkAddress('pokt1stale', CHAIN), true);
    const recorded = await checker.read(key);
    assert.equal(recorded.length, 1, 'expired hits should have been dropped, not accumulated');
  } finally { await cleanup(); }
});

test('refund returns a consumed hit', async () => {
  const { checker, cleanup } = makeChecker({ address: '1' });
  try {
    assert.equal(await checker.checkAddress('pokt1refund', CHAIN), true);
    assert.equal(await checker.checkAddress('pokt1refund', CHAIN), false);

    await checker.refund(checker.addressKey('pokt1refund', CHAIN));
    assert.equal(await checker.checkAddress('pokt1refund', CHAIN), true);
  } finally { await cleanup(); }
});

test('refund on an untouched key is a no-op', async () => {
  const { checker, cleanup } = makeChecker();
  try {
    await checker.refund(checker.addressKey('pokt1never', CHAIN));
    assert.deepEqual(await checker.read(checker.addressKey('pokt1never', CHAIN)), []);
  } finally { await cleanup(); }
});

test('an unknown chain is denied rather than allowed', async () => {
  const { checker, cleanup } = makeChecker();
  try {
    assert.equal(await checker.checkAddress('pokt1abc', 'no-such-chain'), false);
    assert.equal(await checker.checkIp('203.0.113.9', 'no-such-chain'), false);
  } finally { await cleanup(); }
});

test('a missing limit.hours falls back to 24h rather than a zero window', async () => {
  const { checker, cleanup } = makeChecker({ hours: undefined });
  try {
    assert.equal(checker.windowMs(CHAIN), 24 * 3600 * 1000);
  } finally { await cleanup(); }
});
