import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grossPnlCents, pairRoundTrips } from './roundTrip.js';
import type { Fill } from './types.js';

function fill(tsMs: number, ourSide: 'BUY' | 'SELL', size: number, price: number): Fill {
  return {
    ts: String(tsMs),
    tsMs,
    conditionId: 'c',
    tokenId: 't',
    ourSide,
    price,
    size,
    bookTs: String(tsMs - 1),
    queueAhead: 0,
    takerSize: size,
  };
}

test('FIFO: two buys then one sell pairs the OLDEST buy first', () => {
  const buy1 = fill(1000, 'BUY', 100, 0.5);
  const buy2 = fill(2000, 'BUY', 100, 0.51);
  const sell = fill(3000, 'SELL', 100, 0.52);

  const trips = pairRoundTrips([buy1, buy2, sell]);
  assert.equal(trips.length, 1);
  const trip = trips[0];
  assert.ok(trip !== undefined);
  if (trip === undefined) return;
  assert.equal(trip.entry, buy1, 'oldest buy is the entry');
  assert.equal(trip.exit, sell);
  assert.equal(trip.matchedSize, 100);
});

test('FIFO: a sell larger than the oldest buy rolls into the next-oldest', () => {
  const buy1 = fill(1000, 'BUY', 100, 0.5);
  const buy2 = fill(2000, 'BUY', 100, 0.51);
  const sell = fill(3000, 'SELL', 150, 0.52);

  const trips = pairRoundTrips([buy1, buy2, sell]);
  assert.equal(trips.length, 2);
  assert.equal(trips[0]?.entry, buy1);
  assert.equal(trips[0]?.matchedSize, 100);
  assert.equal(trips[1]?.entry, buy2);
  assert.equal(trips[1]?.matchedSize, 50);
});

test('gross PnL: long bought 0.50 then sold 0.52 = +2 cents; short sold 0.52 then bought 0.50 = +2 cents', () => {
  const approx = (actual: number, expected: number): void => {
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
  };
  const longEntry = fill(1000, 'BUY', 100, 0.5);
  const longExit = fill(2000, 'SELL', 100, 0.52);
  approx(grossPnlCents(longEntry, longExit), 2);

  const shortEntry = fill(1000, 'SELL', 100, 0.52);
  const shortExit = fill(2000, 'BUY', 100, 0.5);
  approx(grossPnlCents(shortEntry, shortExit), 2);
});

test('unmatched fills leave no trips', () => {
  const buy1 = fill(1000, 'BUY', 100, 0.5);
  const buy2 = fill(2000, 'BUY', 100, 0.51);
  assert.equal(pairRoundTrips([buy1, buy2]).length, 0);
});
