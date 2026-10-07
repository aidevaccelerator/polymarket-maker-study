/**
 * Drift guard: the analysis half must produce the DOCUMENTED rebate, for every
 * category, at known inputs — checked against a literal table written out here.
 *
 * Why this file exists: `src/analysis/rebates.ts` used to declare its own
 * `Category`, `CATEGORY_FEE_RATES` and `CATEGORY_REBATE_FRACTIONS`. The shared
 * table said Economics 0.04; the analysis table said 0.05. Both halves compiled,
 * both halves passed their own tests, and the disagreement was invisible until
 * someone read both files side by side.
 *
 * WHY THESE ASSERTIONS HAVE TEETH. An earlier version of this file compared
 * `rebates.ts`'s exported tables to `shared/fees.ts`'s exported tables. Since
 * `rebates.ts` re-exports the shared objects by ALIAS
 * (`export const CATEGORY_FEE_RATES = FEE_RATE`), that comparison was the shared
 * table compared with itself — structurally incapable of failing, no matter what
 * either half was edited to. Comparing an alias to its target proves nothing.
 *
 * So every assertion below is anchored to the literal tables in this file,
 * transcribed independently from https://docs.polymarket.com/trading/fees
 * (retrieved 2026-10-07). Editing `FEE_RATE`, `REBATE_FRACTION`, or the wiring
 * in `rebates.ts` without changing these numbers now makes this test fail —
 * which is the whole point. The expected values are NOT recomputed from the
 * shared table.
 *
 * Rebate formula (from the docs page): feeRate * p * (1 - p) * rebateFraction * takerShare.
 *
 * NOTE ON PLACEMENT: this test deliberately lives under src/analysis, not
 * src/shared. `tsconfig.collector.json` scopes `npm run build` to
 * src/shared + src/collector so the collector half can be verified without the
 * analysis half; a src/shared test importing ../analysis/ would drag analysis back
 * into that program and undo that isolation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FEE_RATE, REBATE_FRACTION } from '../shared/fees.js';
import {
  accrueRebates,
  isCategory,
  makerRebatePerShare,
  takerFeePerShare,
  type Category,
} from './rebates.js';

/**
 * The documented schedule, transcribed by hand from
 * https://docs.polymarket.com/trading/fees (retrieved 2026-10-07).
 * This literal is the oracle: nothing in the code under test feeds it.
 */
const DOCUMENTED_SCHEDULE: Record<Category, { feeRate: number; rebateFraction: number }> = {
  Crypto: { feeRate: 0.07, rebateFraction: 0.2 },
  Sports: { feeRate: 0.05, rebateFraction: 0.15 },
  Finance: { feeRate: 0.04, rebateFraction: 0.25 },
  Politics: { feeRate: 0.04, rebateFraction: 0.25 },
  Economics: { feeRate: 0.05, rebateFraction: 0.25 },
  Culture: { feeRate: 0.05, rebateFraction: 0.25 },
  Weather: { feeRate: 0.05, rebateFraction: 0.25 },
  Other: { feeRate: 0.05, rebateFraction: 0.25 },
  Mentions: { feeRate: 0.04, rebateFraction: 0.25 },
  Tech: { feeRate: 0.04, rebateFraction: 0.25 },
  Geopolitics: { feeRate: 0, rebateFraction: 0 },
};

const CATEGORIES = Object.keys(DOCUMENTED_SCHEDULE) as readonly Category[];

/** Probe inputs, in the order the expected tables below are indexed. */
const PROBE_POINTS = [
  { price: 0.5, takerShare: 0.5 },
  { price: 0.8, takerShare: 0.5 },
  { price: 0.5, takerShare: 0.75 },
  { price: 0.8, takerShare: 0.75 },
] as const;

/** Distinct prices, used by the taker-fee table (it does not depend on takerShare). */
const PROBE_PRICES = [0.5, 0.8] as const;

/**
 * feeRate * p * (1 - p) * rebateFraction * takerShare, evaluated by hand for each
 * (category, PROBE_POINTS) pair and written out as a literal.
 */
const EXPECTED_REBATE_PER_SHARE: Record<Category, readonly number[]> = {
  // 0.07 * p(1-p) * 0.20 * takerShare
  Crypto: [0.00175, 0.00112, 0.002625, 0.00168],
  // 0.05 * p(1-p) * 0.15 * takerShare
  Sports: [0.0009375, 0.0006, 0.00140625, 0.0009],
  // 0.04 * p(1-p) * 0.25 * takerShare
  Finance: [0.00125, 0.0008, 0.001875, 0.0012],
  Politics: [0.00125, 0.0008, 0.001875, 0.0012],
  // 0.05 * p(1-p) * 0.25 * takerShare  <- corrected from 0.04 on 2026-10-07
  Economics: [0.0015625, 0.001, 0.00234375, 0.0015],
  Culture: [0.0015625, 0.001, 0.00234375, 0.0015],
  Weather: [0.0015625, 0.001, 0.00234375, 0.0015],
  Other: [0.0015625, 0.001, 0.00234375, 0.0015],
  Mentions: [0.00125, 0.0008, 0.001875, 0.0012],
  Tech: [0.00125, 0.0008, 0.001875, 0.0012],
  // Fee-free, no pool: nothing to accrue.
  Geopolitics: [0, 0, 0, 0],
};

/** Taker fee per share: feeRate * p * (1 - p), same literal discipline. */
const EXPECTED_TAKER_FEE_PER_SHARE: Record<Category, readonly number[]> = {
  Crypto: [0.0175, 0.0112],
  Sports: [0.0125, 0.008],
  Finance: [0.01, 0.0064],
  Politics: [0.01, 0.0064],
  Economics: [0.0125, 0.008],
  Culture: [0.0125, 0.008],
  Weather: [0.0125, 0.008],
  Other: [0.0125, 0.008],
  Mentions: [0.01, 0.0064],
  Tech: [0.01, 0.0064],
  Geopolitics: [0, 0],
};

const CLOSE = 1e-12;

function expectedAt(table: Record<Category, readonly number[]>, category: Category, index: number): number {
  const value = table[category]?.[index];
  if (value === undefined) {
    assert.fail(`expected-value table for "${category}" has no entry at index ${index}`);
  }
  return value;
}

/** A minimal Fill; only price and size are read by `accrueRebates`. */
const FILL = {
  ts: '2026-10-07T00:00:00.000Z',
  tsMs: Date.parse('2026-10-07T00:00:00.000Z'),
  conditionId: 'cond-1',
  tokenId: 'tok-1',
  ourSide: 'SELL',
  price: 0.5,
  size: 40,
  bookTs: '2026-10-07T00:00:00.000Z',
  queueAhead: 0,
  takerSize: 40,
} as const;

test('the analysis module recognises every documented category', () => {
  for (const category of CATEGORIES) {
    assert.ok(isCategory(category), `analysis must recognise documented category "${category}"`);
  }
  assert.equal(isCategory('NotACategory'), false);
});

test('the shared schedule still matches the documented table for all 11 categories', () => {
  assert.deepEqual(
    Object.keys(FEE_RATE).sort(),
    CATEGORIES.slice().sort(),
    'the shared fee table must cover exactly the documented category set',
  );
  for (const category of CATEGORIES) {
    const documented = DOCUMENTED_SCHEDULE[category];
    assert.equal(
      FEE_RATE[category],
      documented.feeRate,
      `taker fee drifted for "${category}": docs say ${documented.feeRate}`,
    );
    assert.equal(
      REBATE_FRACTION[category],
      documented.rebateFraction,
      `rebate fraction drifted for "${category}": docs say ${documented.rebateFraction}`,
    );
  }
});

test('rebate computed by the analysis module equals the documented literal, per category', () => {
  for (const category of CATEGORIES) {
    PROBE_POINTS.forEach((point, index) => {
      const documented = expectedAt(EXPECTED_REBATE_PER_SHARE, category, index);
      const actual = makerRebatePerShare(point.price, category, point.takerShare);
      assert.ok(
        Math.abs(actual - documented) < CLOSE,
        `rebate drifted for "${category}" at p=${point.price} takerShare=${point.takerShare}: ` +
          `documented ${documented}, computed ${actual}`,
      );
    });
  }
});

test('taker fee computed by the analysis module equals the documented literal, per category', () => {
for (const category of CATEGORIES) {
    PROBE_PRICES.forEach((price, index) => {
      const documented = expectedAt(EXPECTED_TAKER_FEE_PER_SHARE, category, index);
      const actual = takerFeePerShare(price, category);
      assert.ok(
        Math.abs(actual - documented) < CLOSE,
        `taker fee drifted for "${category}" at p=${price}: documented ${documented}, computed ${actual}`,
      );
    });
  }
});

test('accrued rebate total is the documented per-share rebate times filled size', () => {
  // The aggregate path must not apply the schedule differently from the
  // per-share function: 40 shares at p=0.5, takerShare=0.5, in each category.
  for (const category of CATEGORIES) {
    const accrual = accrueRebates([FILL], 0.5, () => category);
    const expected = makerRebatePerShare(0.5, category, 0.5) * 40;
    assert.ok(
      Math.abs(accrual.totalRebate - expected) < CLOSE,
      `accrual drifted for "${category}": expected ${expected}, got ${accrual.totalRebate}`,
    );
    assert.equal(accrual.fills, 1);
    assert.equal(accrual.categories[category], 1);
  }
});

test('an unmeasurable taker share yields zero accrual and a warning, never a guess', () => {
  const accrual = accrueRebates([FILL], null);
  assert.equal(accrual.totalRebate, 0);
  assert.equal(accrual.fills, 0);
  assert.equal(accrual.warnings.length, 1);
});