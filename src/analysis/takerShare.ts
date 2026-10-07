/**
 * Taker share T/(M+T).
 *
 * The rebate a maker earns scales with `takerShare = T/(M+T)`, where T is taker
 * (aggressive) volume and M is maker (resting, filled) volume. It must be
 * MEASURED from data, never assumed to be 1.0.
 *
 * The shared schema (BookSnapshot / TopOfBook / QuoteTouch) does not carry a
 * maker/taker volume split, so this is measured from the book as follows:
 *
 *   T = sum of QuoteTouch.size              (aggressive volume that touched us)
 *   M = sum over touches of min(size, restingSizeAtTouchPrice)
 *                                         (maker volume filled at our level)
 *
 * In a matched limit-order book each filled share has one taker and one maker,
 * so T ≈ M and takerShare ≈ 0.5 when the taker's order does not walk the book.
 * Values above 0.5 arise when takers over-consume thin resting liquidity. This
 * is an honest measurement with a documented method, NOT an assumption of 1.0.
 * See ASSUMPTIONS.md.
 */

import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';
import type { BookLookup, MarketTakerShare, TakerShareResult } from './types.js';

const METHOD =
  'T = sum(QuoteTouch.size); M = sum over touches of min(size, resting size at touch price in bookTs). takerShare = T/(T+M).';

/** Running T/M tallies for one market (or for the pooled total). */
interface Accumulator {
  takerVolume: number;
  makerVolume: number;
  samples: number;
  missingBooks: number;
  unmatchedLevels: number;
}

function emptyAccumulator(): Accumulator {
  return { takerVolume: 0, makerVolume: 0, samples: 0, missingBooks: 0, unmatchedLevels: 0 };
}

function ratioOf(acc: Accumulator): number | null {
  const denominator = acc.takerVolume + acc.makerVolume;
  return denominator > 0 ? acc.takerVolume / denominator : null;
}

/**
 * Warnings for under-counted maker volume. Both failure modes contribute 0 to M
 * while still adding their full size to T, so both bias takerShare UP toward
 * 1.0 -- the one value the brief forbids assuming.
 */
function biasWarnings(acc: Accumulator, label: string): string[] {
  const out: string[] = [];
  if (acc.missingBooks > 0) {
    out.push(
      `${acc.missingBooks} of ${acc.samples} ${label} reference a missing book snapshot; maker volume (M) is undercounted.`,
    );
  }
  if (acc.unmatchedLevels > 0) {
    out.push(
      `${acc.unmatchedLevels} of ${acc.samples} ${label} found no resting size at their price in the referenced book ` +
        `(${((acc.unmatchedLevels / acc.samples) * 100).toFixed(1)}% of samples); maker volume is undercounted and takerShare is biased UPWARD toward 1.0.`,
    );
  }
  return out;
}

/** Total resting size at a specific price on the side the aggressor hits. */
export function restingSizeAtPrice(
  book: BookSnapshot,
  side: 'BUY' | 'SELL',
  price: number,
): number {
  const levels = side === 'BUY' ? book.asks : book.bids;
  let size = 0;
  for (const level of levels) {
    const p = level[0];
    const sz = level[1];
    if (p === undefined || sz === undefined) continue;
    if (Math.abs(p - price) < 1e-12) size += sz;
  }
  return size;
}

export function measureTakerShare(
  touches: QuoteTouch[],
  bookLookup: BookLookup,
): TakerShareResult {
  const pooled = emptyAccumulator();
  const perMarket = new Map<string, Accumulator>();

  for (const touch of touches) {
    let acc = perMarket.get(touch.conditionId);
    if (acc === undefined) {
      acc = emptyAccumulator();
      perMarket.set(touch.conditionId, acc);
    }

    for (const a of [pooled, acc]) {
      a.takerVolume += touch.size;
      a.samples += 1;
      const book = bookLookup(touch.bookTs);
      if (book === undefined) {
        a.missingBooks += 1;
        continue;
      }
      const resting = restingSizeAtPrice(book, touch.side, touch.price);
      if (resting <= 0) a.unmatchedLevels += 1;
      a.makerVolume += Math.min(touch.size, resting);
    }
  }

  if (pooled.samples === 0) {
    return {
      takerShare: null,
      takerVolume: 0,
      makerVolume: 0,
      method: METHOD,
      samples: 0,
      warnings: ['no QuoteTouch records in the analysis window'],
      byMarket: [],
    };
  }

  const warnings = biasWarnings(pooled, 'touches');
  const takerShare = ratioOf(pooled);
  if (takerShare === null) {
    warnings.push('taker share could not be computed (zero matched volume).');
  }

  const byMarket: MarketTakerShare[] = [...perMarket.entries()]
    .map(([conditionId, acc]) => ({
      conditionId,
      takerShare: ratioOf(acc),
      takerVolume: acc.takerVolume,
      makerVolume: acc.makerVolume,
      samples: acc.samples,
      warnings: biasWarnings(acc, 'touches'),
    }))
    .sort((a, b) => b.takerVolume - a.takerVolume);

  return {
    takerShare,
    takerVolume: pooled.takerVolume,
    makerVolume: pooled.makerVolume,
    method: METHOD,
    samples: pooled.samples,
    warnings,
    byMarket,
  };
}
