/**
 * Rebate accrual, using the verified fee schedule from docs.polymarket.com
 * (ground truth — NOT re-derived).
 *
 * The schedule itself lives in `src/shared/fees.ts` and is IMPORTED here, not
 * restated. This module previously carried its own copy of the fee/rebate
 * tables; the two copies disagreed on Economics (0.04 vs 0.05) and nobody
 * noticed, because duplicating a constant is the one edit that cannot be caught
 * by the compiler. `src/analysis/feeConsistency.test.ts` now asserts both
 * halves agree.
 *
 * Taker fee:      fee = C * feeRate * p * (1 - p).   Makers pay ZERO.
 * Maker rebate:   feeRate * p * (1 - p) * rebateFraction * takerShare
 *                 where takerShare = T/(M+T) is MEASURED (see takerShare.ts).
 *
 * C is the contract size; on a per-share basis C = 1 (one binary share).
 */

import {
  FEE_RATE,
  REBATE_FRACTION,
  type FeeCategory,
  makerRebatePerShare as sharedMakerRebatePerShare,
} from '../shared/fees.js';
import type { Fill } from './types.js';

/**
 * Fee category of a market. Re-exported from the shared schedule so this module
 * cannot name a category the shared table does not price.
 */
export type Category = FeeCategory;

/**
 * Re-export of the shared taker fee rates, under the name this module's callers
 * already use. Same object, one definition.
 */
export const CATEGORY_FEE_RATES: Record<Category, number> = FEE_RATE;

/** Re-export of the shared maker-rebate fractions. Same object, one definition. */
export const CATEGORY_REBATE_FRACTIONS: Record<Category, number> = REBATE_FRACTION;

/** All category names, for validation. Derived from the shared schedule. */
export const CATEGORIES: readonly Category[] = Object.keys(FEE_RATE).sort() as readonly Category[];

export function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(FEE_RATE, value);
}

/**
 * Maker rebate per share: feeRate * p * (1-p) * rebateFraction * takerShare.
 * Delegates to `src/shared/fees.ts` so the formula and the schedule it reads
 * both have exactly one definition.
 * `takerShare` must be the MEASURED T/(M+T); pass null only when unmeasurable
 * (the caller then reports accrual as unavailable rather than guessing).
 */
export function makerRebatePerShare(
  price: number,
  category: Category,
  takerShare: number,
): number {
  return sharedMakerRebatePerShare(
    FEE_RATE[category],
    price,
    REBATE_FRACTION[category],
    takerShare,
  );
}

/** Taker fee per share (makers pay zero — this is the counterparty's cost). */
export function takerFeePerShare(price: number, category: Category): number {
  return FEE_RATE[category] * price * (1 - price);
}

export interface RebateAccrual {
  /** Total rebate shares accrued (sum of rebate * size). */
  totalRebate: number;
  perShareAverage: number;
  fills: number;
  /** Categories encountered (for transparency about the fee schedule applied). */
  categories: Record<string, number>;
  warnings: string[];
}

/**
 * Accrue maker rebates over a list of fills. `takerShare` is the measured value;
 * when null, accrual is 0 and a warning is emitted (never a guess).
 * `categoryFor` maps a fill to its market category; the default is 'Other'
 * (the documented general schedule), because the shared schema carries no
 * market-category field and real collected fills therefore have none.
 */
export function accrueRebates(
  fills: Fill[],
  takerShare: number | null,
  categoryFor: (fill: Fill) => Category = () => 'Other',
): RebateAccrual {
  const warnings: string[] = [];
  const categories: Record<string, number> = {};
  let totalRebate = 0;
  let count = 0;

  if (takerShare === null) {
    warnings.push(
      'takerShare is unmeasurable from the data; maker rebate accrual is reported as 0 and NOT estimated.',
    );
    return { totalRebate: 0, perShareAverage: 0, fills: 0, categories, warnings };
  }

  for (const fill of fills) {
    const category = categoryFor(fill);
    categories[category] = (categories[category] ?? 0) + 1;
    const perShare = makerRebatePerShare(fill.price, category, takerShare);
    totalRebate += perShare * fill.size;
    count += 1;
  }

  return {
    totalRebate,
    perShareAverage: count > 0 ? totalRebate / count : 0,
    fills: count,
    categories,
    warnings,
  };
}
