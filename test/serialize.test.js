import test from 'node:test';
import assert from 'node:assert/strict';

import { createSerializer } from '../serialize.js';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// The reason this exists: cosmjs reads an account's sequence number just before
// signing, so two overlapping broadcasts from one account read the same value
// and the second is rejected. Serializing per account prevents the overlap.
test('work under one key never overlaps', async () => {
  const serialize = createSerializer();
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 10 }, () => serialize('acct-a', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
  })));

  assert.equal(maxActive, 1, `expected no overlap, saw ${maxActive} concurrent`);
});

test('work under one key runs in submission order', async () => {
  const serialize = createSerializer();
  const order = [];
  await Promise.all(
    [1, 2, 3, 4, 5].map(n => serialize('acct-a', async () => { await tick(5); order.push(n); }))
  );
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('different keys run concurrently', async () => {
  const serialize = createSerializer();
  let active = 0;
  let maxActive = 0;

  await Promise.all(['a', 'b', 'c'].map(k => serialize(k, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
  })));

  assert.equal(maxActive, 3, 'independent accounts should not block each other');
});

test('a failure does not wedge the queue for that key', async () => {
  const serialize = createSerializer();
  await assert.rejects(() => serialize('acct-a', async () => { throw new Error('broadcast failed') }));
  // A failed send must not stop the next one from ever running.
  assert.equal(await serialize('acct-a', async () => 'recovered'), 'recovered');
});

test('the caller receives the result and the error', async () => {
  const serialize = createSerializer();
  assert.equal(await serialize('k', async () => 42), 42);
  await assert.rejects(() => serialize('k', async () => { throw new Error('boom') }), /boom/);
});

test('a rejected task leaves no unhandled rejection behind', async () => {
  const serialize = createSerializer();
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await serialize('k', async () => { throw new Error('ignored') }).catch(() => {});
    await tick(50);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
