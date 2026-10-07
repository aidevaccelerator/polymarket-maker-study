import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adverseCents,
  buildMidSeries,
  distribution,
  markoutAtHorizon,
  midAtOrBefore,
  ourDirection,
  parseTs,
  upperBoundIndex,
} from './markout.js';
import type { TopOfBook } from '../shared/schema.js';

// Markout values are IEEE-754 results of (mid - price) * 100 * dir, so e.g.
// 0.53 - 0.50 is 0.030000000000000027, not 0.03. We assert with a tolerance
// rather than rounding the source: sub-cent precision is exactly the regime
// this study measures, so the arithmetic must stay unrounded.
function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);
}

function makeTop(tsMs: number, mid: number): TopOfBook {
  return {
    ts: String(tsMs),
    conditionId: 'c',
    tokenId: 't',
    bestBid: mid,
    bestAsk: mid,
    mid,
    spread: 0,
  };
}

test('sign convention: a mid move in our favor produces NEGATIVE adverseCents', () => {
  // We SOLD at 0.50 (an aggressor bought our resting ask). We want the price to
  // FALL. A fall to 0.48 is in our favor => adverseCents must be NEGATIVE.
  assert.ok(adverseCents(0.5, 0.48, 'SELL') < 0, 'sold, price fell -> favor -> negative');
  // A rise to 0.52 is against us => POSITIVE.
  assert.ok(adverseCents(0.5, 0.52, 'SELL') > 0, 'sold, price rose -> against -> positive');

  // We BOUGHT at 0.50 (an aggressor sold into our resting bid). We want the price
  // to RISE. A rise to 0.52 is in our favor => NEGATIVE.
  assert.ok(adverseCents(0.5, 0.52, 'BUY') < 0, 'bought, price rose -> favor -> negative');
  // A fall to 0.48 is against us => POSITIVE.
  assert.ok(adverseCents(0.5, 0.48, 'BUY') > 0, 'bought, price fell -> against -> positive');
});

test('ourDirection follows the LOSS convention: SELL -> +1, BUY -> -1', () => {
  assert.equal(ourDirection('SELL'), 1);
  assert.equal(ourDirection('BUY'), -1);
});

test('exact adverseCents values for a hand-built fixture', () => {
  // Sold at 0.50, mid at 0.53 -> (0.53 - 0.50)*100*(+1) = +3 cents adverse.
  approx(adverseCents(0.5, 0.53, 'SELL'), 3);
  // Bought at 0.50, mid at 0.47 -> (0.47 - 0.50)*100*(-1) = +3 cents adverse.
  approx(adverseCents(0.5, 0.47, 'BUY'), 3);
});

test('markout at +30s uses the mid nearest-but-not-after t+30s (boundary case)', () => {
  const BASE = 1_700_000_000_000;
  const series = buildMidSeries([
    makeTop(BASE, 0.5),
    makeTop(BASE + 29_999, 0.51),
    makeTop(BASE + 30_000, 0.52), // exactly t+30s -> MUST be used
    makeTop(BASE + 30_001, 0.53), // just after -> MUST NOT be used
  ]);

  // We SELL at 0.50. markout uses mid 0.52 (the t+30s observation).
  // adverse = (0.52 - 0.50) * 100 * (+1) = 2.
  const markout = markoutAtHorizon(series, BASE, 0.5, 'SELL', 30);
  assert.ok(markout !== null);
  if (markout !== null) approx(markout, 2);

  // Same lookups at a coarser level.
  assert.equal(midAtOrBefore(series, BASE + 30_000), 0.52);
  assert.equal(midAtOrBefore(series, BASE + 29_999), 0.51);
});

test('midAtOrBefore returns null when no observation is at or before the target', () => {
  const series = buildMidSeries([makeTop(2_000_000, 0.5)]);
  assert.equal(midAtOrBefore(series, 1_000_000), null);
  assert.equal(midAtOrBefore(series, 2_000_000), 0.5);
  assert.equal(upperBoundIndex(series, 1_000_000), -1);
  assert.equal(upperBoundIndex(series, 2_000_000), 0);
});

test('parseTs treats numeric strings as epoch milliseconds and ISO strings via Date.parse', () => {
  assert.equal(parseTs('1700000000000'), 1_700_000_000_000);
  const iso = new Date('2024-01-02T03:04:05.000Z').getTime();
  assert.equal(parseTs('2024-01-02T03:04:05.000Z'), iso);
});

test('distribution computes unweighted percentiles on a small fixture', () => {
  const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(d !== null);
  if (d === null) return;
  assert.equal(d.n, 10);
  assert.equal(d.p50, 5); // nearest-rank: 5th value (cum weight 5 >= 5)
  assert.equal(d.mean, 5.5);
});
