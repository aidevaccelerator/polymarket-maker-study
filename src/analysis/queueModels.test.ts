import { test } from 'node:test';
import assert from 'node:assert/strict';

import { medianFill, optimisticFill, pessimisticFill } from './queueModels.js';

test('queue models: queueAhead=100, touch size=60 -> pessimistic does NOT fill, optimistic DOES', () => {
  const pessim = pessimisticFill(100, 60);
  assert.equal(pessim.fills, false, 'we are last in line and 60 < 100 shares ahead');
  assert.equal(pessim.fillFraction, 0);

  const optim = optimisticFill(100, 60);
  assert.equal(optim.fills, true, 'optimistic ignores the queue');
  assert.equal(optim.fillSize, 60, 'capped by the taker size');
});

test('median model: fill probability is min(1, takerSize / queueAhead)', () => {
  const med = medianFill(100, 60);
  assert.ok(Math.abs(med.fillFraction - 0.6) < 1e-12);
  assert.equal(med.fills, true);

  const medFull = medianFill(100, 250);
  assert.equal(medFull.fillFraction, 1);

  const medNothingAhead = medianFill(0, 10);
  assert.equal(medNothingAhead.fillFraction, 1, 'nothing ahead -> fill on any touch');
});

test('pessimistic partial fill: leftover after the queue is consumed', () => {
  // 100 shares ahead, taker wants 130 -> we fill 30 (capped by our 100-share order).
  const p = pessimisticFill(100, 130, 100);
  assert.equal(p.fills, true);
  assert.equal(p.fillSize, 30);

  // 100 ahead, taker wants exactly 100 -> nothing left for us.
  const none = pessimisticFill(100, 100, 100);
  assert.equal(none.fills, false);
  assert.equal(none.fillSize, 0);
});

test('optimistic is an upper bound: fills immediately on any positive touch', () => {
  const o = optimisticFill(1000, 5, 100);
  assert.equal(o.fills, true);
  assert.equal(o.fillSize, 5, 'taker only wanted 5');

  const zero = optimisticFill(0, 0, 100);
  assert.equal(zero.fills, false);
});
