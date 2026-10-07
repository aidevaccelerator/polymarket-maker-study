// Fee / rebate math, verified against the documented Polymarket fee schedule.
//
// SOURCE OF TRUTH: https://docs.polymarket.com/trading/fees
// Retrieved 2026-10-07. Do NOT re-derive these numbers, and do NOT copy them
// into another module — import them from here so a correction cannot land in
// one file and miss the other.
//
// Documented table (retrieved 2026-10-07):
//
//   Category      | Taker Fee Rate | Maker Fee Rate | Maker Rebate
//   Crypto        | 0.07           | 0              | 20%
//   Sports        | 0.05           | 0              | 15%
//   Finance       | 0.04           | 0              | 25%
//   Politics      | 0.04           | 0              | 25%
//   Economics     | 0.05           | 0              | 25%
//   Culture       | 0.05           | 0              | 25%
//   Weather       | 0.05           | 0              | 25%
//   Other/General | 0.05           | 0              | 25%
//   Mentions      | 0.04           | 0              | 25%
//   Tech          | 0.04           | 0              | 25%
//   Geopolitics   | 0              | 0              | 0%  (fee-free, no pool)
//
// CORRECTION HISTORY:
//   2026-10-07 — `Economics` read 0.04 here while the docs table says 0.05.
//   `Economics` is in the collector's ALLOWED_CATEGORIES, so real collected
//   markets hit it, and at p(1-p) ~ 0.25 the 0.04-vs-0.05 error moved the maker
//   rebate by 25%. Fixed to 0.05. `src/analysis/rebates.ts` had independently
//   carried 0.05 and the two halves had silently disagreed for the lifetime of
//   this file; it now imports from here, and
//   `src/analysis/feeConsistency.test.ts` fails the build if they drift apart
//   again.
//
// Gross fee on a trade of `C` shares at price `p` (p in [0,1]):
//     fee = C * feeRate * p * (1 - p)
// Check: politics feeRate 4% at p=0.5 on 100 shares ->
//     100 * 0.04 * 0.5 * 0.5 = 1.00
// Check: crypto feeRate 7% at p=0.5 on 100 shares ->
//     100 * 0.07 * 0.5 * 0.5 = 1.75
//
// Maker rebate per share:
//     makerRebatePerShare = feeRate * p * (1-p) * rebateFraction * takerShare
// `takerShare = T / (M + T)` is MEASURED from observed flow, never assumed.

export type FeeCategory =
  | 'Crypto'
  | 'Sports'
  | 'Finance'
  | 'Politics'
  | 'Economics'
  | 'Culture'
  | 'Weather'
  | 'Other'
  | 'Mentions'
  | 'Tech'
  | 'Geopolitics';

// Documented taker fee rates, keyed by category.
//
// This is a TOTAL record (`satisfies Record<FeeCategory, number>`, not
// `Partial`): adding a category to `FeeCategory` without giving it a documented
// rate here is a compile error, so no consumer can ever read `undefined` and
// silently fall back to a wrong number. Every value below is transcribed from
// the docs table above.
//
// `Geopolitics` is 0, not a guess: those markets carry no fee and no pool.
// `Other` is the general/default schedule and is what real collected fills
// resolve to, because the shared schema carries no market-category field (see
// `defaultCategory` in src/analysis/index.ts).
export const FEE_RATE = {
  Crypto: 0.07,
  Sports: 0.05,
  Finance: 0.04,
  Politics: 0.04,
  Economics: 0.05,
  Culture: 0.05,
  Weather: 0.05,
  Other: 0.05,
  Mentions: 0.04,
  Tech: 0.04,
  Geopolitics: 0,
} as const satisfies Record<FeeCategory, number>;

// Documented maker-rebate fractions by category. Same source and same retrieval
// date as FEE_RATE. Total record for the same reason.
export const REBATE_FRACTION = {
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
} as const satisfies Record<FeeCategory, number>;

export function grossFee(shareCount: number, feeRate: number, price: number): number {
  return shareCount * feeRate * price * (1 - price);
}

export function makerRebatePerShare(
  feeRate: number,
  price: number,
  rebateFraction: number,
  takerShare: number,
): number {
  return feeRate * price * (1 - price) * rebateFraction * takerShare;
}
