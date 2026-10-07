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
  weightedDistribution,
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

// The three tests below pin the `weightedDistribution` contract that
// `Distribution.n` depends on. `n` is documented as the count of samples
// SUPPLIED, which equals the count that contributed to the percentiles only
// because every supplied weight is defined and > 0. The sole production caller
// (src/analysis/index.ts) enforces that with its `fillFraction <= 0` guard
// placed before the adjacent values.push/weights.push. Nothing inside
// `weightedDistribution` enforces it, so it is pinned here rather than assumed.

test('weightedDistribution: with all weights positive, n is the supplied count and nWeighted the weight sum', () => {
  const d = weightedDistribution([1, 2, 3, 4], [0.25, 0.5, 1, 2]);
  assert.ok(d !== null);
  if (d === null) return;
  // 4 samples supplied, 4 samples contributing -> the invariant holds.
  assert.equal(d.n, 4);
  assert.equal(d.nWeighted, 3.75); // 0.25 + 0.5 + 1 + 2
  approx(d.mean, (1 * 0.25 + 2 * 0.5 + 3 * 1 + 4 * 2) / 3.75);
  // Nearest-rank on cumulative weight over sorted [1, 2, 3, 4] with weights
  // [0.25, 0.5, 1, 2]: cum reaches 0.25, 0.75, 1.75, 3.75, so q*total (0.375,
  // 0.9375, 1.875, 2.8125, 3.375) first meets/exceeds at value 2, 3, 4, 4, 4.
  assert.equal(d.p10, 2);
  assert.equal(d.p25, 3);
  assert.equal(d.p50, 4);
  assert.equal(d.p75, 4);
  assert.equal(d.p90, 4);
});

test('weightedDistribution: a zero weight is excluded from the percentiles but STILL counted in n', () => {
  // This pins the documented divergence. The `w <= 0` guard drops the sample from
  // `pairs`, but `n` is `values.length`, so n (4) exceeds the contributing count (3).
  // The current production caller cannot reach this state; the test exists to make
  // the behaviour explicit rather than to endorse it. RECOMMENDATION (not applied —
  // changing `n` would be a behaviour change to a reported statistic): if this
  // function is ever called with non-positive weights, `n: pairs.length` would be
  // the honest count. Left as-is and pinned deliberately.
  const d = weightedDistribution([1, 2, 3, 4], [0, 0.5, 1, 2]);
  assert.ok(d !== null);
  if (d === null) return;
  assert.equal(d.n, 4, 'n counts SUPPLIED samples, including the zero-weight one');
  assert.equal(d.nWeighted, 3.5, 'the zero weight contributes nothing to the weight sum');
  // Only 3 samples contribute, so the quantiles are the nearest-rank over
  // [2, 3, 4] with weights [0.5, 1, 2] (total 3.5, cum 0.5 / 1.5 / 3.5). The
  // dropped value 1 is gone from the distribution entirely, which is why p10 is 2
  // and not 1 even though 1 was supplied.
  assert.equal(d.p10, 2);
  assert.equal(d.p25, 3);
  assert.equal(d.p50, 4);
  assert.equal(d.p75, 4);
  assert.equal(d.p90, 4);
});

test('weightedDistribution: a negative weight is dropped by the w <= 0 guard, which a zero weight does not need', () => {
  // Pins the guard that the zero-weight case cannot. A zero weight is an equivalent
  // mutant to remove: `cum += 0` never reaches a positive quantile target, so zero
  // weights are invisible whether or not the guard fires. A NEGATIVE weight is not —
  // it would subtract from totalWeight and drag the weighted mean. So `w <= 0` is
  // load-bearing for negatives specifically, and this is the test that covers it.
  const d = weightedDistribution([1, 2, 3], [-1, 0.5, 1]);
  assert.ok(d !== null);
  if (d === null) return;
  assert.equal(d.n, 3, 'n counts all three supplied samples, including the negative one');
  // The -1 was excluded, so the weight sum is 0.5 + 1, not -1 + 0.5 + 1.
  assert.equal(d.nWeighted, 1.5);
  approx(d.mean, (2 * 0.5 + 3 * 1) / 1.5);
  // Nearest-rank over [2, 3] with weights [0.5, 1] (total 1.5, cum 0.5 / 1.5).
  assert.equal(d.p10, 2);
  assert.equal(d.p25, 2);
  assert.equal(d.p50, 3);
  assert.equal(d.p75, 3);
  assert.equal(d.p90, 3);
});

test('weightedDistribution: a NaN weight is NOT filtered by w <= 0 and corrupts mean/nWeighted', () => {
  // Documents a real hazard. `NaN <= 0` is false, so the guard lets a NaN weight
  // through: totalWeight becomes NaN, mean becomes NaN, and every quantile's
  // `cum >= target` comparison is false against NaN, so the quantile loop falls
  // through to the last sorted value. This is currently unreachable in production
  // — `asNumber` in parquetRead.ts returns a finite fallback for size/queueAhead and
  // every division in queueModels.ts is guarded — but the guards HERE do not
  // provide that protection, so the hazard is pinned rather than left implied.
  const d = weightedDistribution([1, 2], [Number.NaN, 1]);
  assert.ok(d !== null);
  if (d === null) return;
  assert.equal(d.n, 2);
  assert.ok(Number.isNaN(d.nWeighted), `nWeighted should be NaN, got ${d.nWeighted}`);
  assert.ok(Number.isNaN(d.mean), `mean should be NaN, got ${d.mean}`);
  // The NaN-poisoned quantile falls through to the largest value.
  assert.equal(d.p50, 2);
});
