import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_FEE_RATES,
  CATEGORY_REBATE_FRACTIONS,
  accrueRebates,
  makerRebatePerShare,
  takerFeePerShare,
} from './rebates.js';
import type { Fill } from './types.js';

test('rebate math: 0.04 * 0.5 * 0.5 * 0.25 * 0.6 = 0.0015 per share', () => {
  // Finance feeRate 0.04, p=0.5, (1-p)=0.5, rebateFraction 0.25, takerShare 0.6.
  const perShare = makerRebatePerShare(0.5, 'Finance', 0.6);
  assert.ok(Math.abs(perShare - 0.0015) < 1e-12, `expected 0.0015, got ${perShare}`);
});

test('category fee schedule matches the verified table', () => {
  assert.equal(CATEGORY_FEE_RATES.Crypto, 0.07);
  assert.equal(CATEGORY_FEE_RATES.Sports, 0.05);
  assert.equal(CATEGORY_FEE_RATES.Finance, 0.04);
  assert.equal(CATEGORY_FEE_RATES.Economics, 0.05);
  assert.equal(CATEGORY_REBATE_FRACTIONS.Crypto, 0.2);
  assert.equal(CATEGORY_REBATE_FRACTIONS.Sports, 0.15);
  assert.equal(CATEGORY_REBATE_FRACTIONS.Finance, 0.25);
});

test('taker fee per share is feeRate * p * (1-p)', () => {
  const fee = takerFeePerShare(0.5, 'Finance');
  assert.ok(Math.abs(fee - 0.01) < 1e-12, `expected 0.01, got ${fee}`);
});

function fill(overrides: Partial<Fill>): Fill {
  return {
    ts: '1000',
    tsMs: 1000,
    conditionId: 'c',
    tokenId: 't',
    ourSide: 'SELL',
    price: 0.5,
    size: 100,
    bookTs: '999',
    queueAhead: 0,
    takerSize: 100,
    ...overrides,
  };
}

test('accrueRebates sums per-share rebate times size over fills', () => {
  const fills = [fill({}), fill({})]; // two 100-share fills at p=0.5, Finance, takerShare 0.6
  const accrual = accrueRebates(fills, 0.6, () => 'Finance');
  // per share 0.0015 * 100 shares * 2 fills = 0.3
  assert.ok(Math.abs(accrual.totalRebate - 0.3) < 1e-9);
  assert.equal(accrual.fills, 2);
  assert.deepEqual(accrual.categories, { Finance: 2 });
});

test('accrueRebates emits zero + a warning (not a guess) when takerShare is null', () => {
  const accrual = accrueRebates([fill({})], null, () => 'Finance');
  assert.equal(accrual.totalRebate, 0);
  assert.equal(accrual.fills, 0);
  assert.ok(accrual.warnings.length > 0, 'must warn, never substitute a guess');
});
