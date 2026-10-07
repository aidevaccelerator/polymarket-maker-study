import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEE_RATE, REBATE_FRACTION, grossFee, makerRebatePerShare } from './fees.js';

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be ~${expected}`);
}

test('grossFee at politics 4% on 100 shares at p=0.5 is $1.00', () => {
  assertClose(grossFee(100, FEE_RATE.Politics, 0.5), 1.0);
});

test('grossFee at crypto 7% on 100 shares at p=0.5 is $1.75', () => {
  assertClose(grossFee(100, FEE_RATE.Crypto, 0.5), 1.75);
});

test('makerRebatePerShare at politics 0.25 rebate fraction, takerShare 0.5', () => {
  // feeRate * p * (1-p) * rebateFraction * takerShare
  // = 0.04 * 0.5 * 0.5 * 0.25 * 0.5 = 0.00125
  assertClose(makerRebatePerShare(0.04, 0.5, REBATE_FRACTION.Politics, 0.5), 0.00125);
});

// ---------------------------------------------------------------------------
// The table above is transcribed from https://docs.polymarket.com/trading/fees
// (retrieved 2026-10-07). These tests PIN it, so a future edit to any value
// without a corresponding docs update fails the build rather than silently
// changing reported rebate economics.
// ---------------------------------------------------------------------------

test('FEE_RATE matches the documented Polymarket fee schedule (docs, 2026-10-07)', () => {
  assert.deepEqual(FEE_RATE, {
    Crypto: 0.07,
    Sports: 0.05,
    Finance: 0.04,
    Politics: 0.04,
    // Economics is 0.05 per the docs table, NOT 0.04. It previously read 0.04
    // here while src/analysis/rebates.ts carried 0.05, so the two halves of the
    // project silently disagreed on a category that IS in ALLOWED_CATEGORIES.
    // At p(1-p) ~ 0.25 that 0.04-vs-0.05 error moved the maker rebate by 25%.
    Economics: 0.05,
    Culture: 0.05,
    Weather: 0.05,
    Other: 0.05,
    Mentions: 0.04,
    Tech: 0.04,
    Geopolitics: 0,
  });
});

test('REBATE_FRACTION matches the documented schedule (docs, 2026-10-07)', () => {
  assert.deepEqual(REBATE_FRACTION, {
    Crypto: 0.2,
    Sports: 0.15,
    Finance: 0.25,
    Politics: 0.25,
    Economics: 0.25,
    Culture: 0.25,
    Weather: 0.25,
    Other: 0.25,
    Mentions: 0.25,
    Tech: 0.25,
    Geopolitics: 0,
  });
});

test('both tables cover exactly the same category set (no unpriced category)', () => {
  assert.deepEqual(
    Object.keys(FEE_RATE).sort(),
    Object.keys(REBATE_FRACTION).sort(),
  );
});
