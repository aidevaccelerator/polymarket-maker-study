/**
 * Fill rates by quote placement.
 *
 * We compare two passive placements of our resting order:
 *   - `touch`:       our quote sits AT the best bid/ask (front of the queue at
 *                    that level). queueAhead = 0.
 *   - `oneTickInside`: our quote sits one tick BEHIND the best (a less
 *                    competitive price), so every share resting at the best level
 *                    is ahead of us. queueAhead = bestLevelSize.
 *
 * Fill rate = fraction of aggressive touches that fill us, per queue model.
 * "Inside" here means "inside the book, behind the best level", i.e. deeper in
 * the queue — this is the adverse-selection/queue story we are testing.
 * Documented in ASSUMPTIONS.md.
 */

import { OUR_ORDER_SIZE } from '../shared/config.js';
import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';
import { applyQueueModel, QUEUE_MODELS } from './queueModels.js';
import type { BookLookup, QueueModelName } from './types.js';

export interface FillRateResult {
  placement: 'touch' | 'oneTickInside';
  model: QueueModelName;
  /** Number of touches evaluated. */
  total: number;
  /** Sum of fill fractions (weighted fill count). */
  filledWeighted: number;
  /** filledWeighted / total. */
  fillRate: number;
  /** Number of touches skipped (no book snapshot available). */
  skipped: number;
}

interface LevelInfo {
  bestPrice: number;
  bestLevelSize: number;
}

/**
 * Total resting size at the best level on the side the aggressor is hitting.
 * `side` is the AGGRESSOR side (mirror of the brief's QuoteTouch.side).
 */
export function bestLevelInfo(book: BookSnapshot, side: 'BUY' | 'SELL'): LevelInfo | null {
  const levels = side === 'BUY' ? book.asks : book.bids;
  const best = levels[0];
  if (best === undefined) return null;
  const bestPrice = best[0];
  if (bestPrice === undefined) return null;

  let bestLevelSize = 0;
  for (const level of levels) {
    const price = level[0];
    const size = level[1];
    if (price === undefined || size === undefined) continue;
    if (price === bestPrice) bestLevelSize += size;
  }
  return { bestPrice, bestLevelSize };
}

/** Compute fill rates for touch vs 1-tick-inside placement, across all models. */
export function computeFillRates(
  touches: QuoteTouch[],
  bookLookup: BookLookup,
): FillRateResult[] {
  const accumulators = new Map<string, { total: number; filledWeighted: number; skipped: number }>();

  const keyFor = (placement: FillRateResult['placement'], model: QueueModelName): string =>
    `${placement}:${model}`;

  const placements: FillRateResult['placement'][] = ['touch', 'oneTickInside'];
  for (const placement of placements) {
    for (const model of QUEUE_MODELS) {
      accumulators.set(keyFor(placement, model), { total: 0, filledWeighted: 0, skipped: 0 });
    }
  }

  for (const touch of touches) {
    const book = bookLookup(touch.bookTs);
    if (book === undefined) {
      for (const placement of placements) {
        for (const model of QUEUE_MODELS) {
          const acc = accumulators.get(keyFor(placement, model));
          if (acc !== undefined) acc.skipped += 1;
        }
      }
      continue;
    }

    const info = bestLevelInfo(book, touch.side);
    const queueAheadByPlacement: Record<FillRateResult['placement'], number> = {
      touch: 0,
      oneTickInside: info === null ? 0 : info.bestLevelSize,
    };

    for (const placement of placements) {
      for (const model of QUEUE_MODELS) {
        const outcome = applyQueueModel(model, queueAheadByPlacement[placement], touch.size, OUR_ORDER_SIZE);
        const acc = accumulators.get(keyFor(placement, model));
        if (acc !== undefined) {
          acc.total += 1;
          acc.filledWeighted += outcome.fillFraction;
        }
      }
    }
  }

  const results: FillRateResult[] = [];
  for (const placement of placements) {
    for (const model of QUEUE_MODELS) {
      const acc = accumulators.get(keyFor(placement, model));
      if (acc === undefined) continue;
      results.push({
        placement,
        model,
        total: acc.total,
        filledWeighted: acc.filledWeighted,
        fillRate: acc.total > 0 ? acc.filledWeighted / acc.total : 0,
        skipped: acc.skipped,
      });
    }
  }
  return results;
}
