/**
 * Queue-position models.
 *
 * We are always the passive maker. When an aggressive order of `takerSize`
 * touches our price, whether WE fill depends on how many shares were already
 * resting ahead of us (`queueAhead`). Three models are reported as a band:
 *
 *  - `pessimistic`: we are LAST in line. We fill only after the aggressive size
 *    consumes every share ahead of us (`takerSize > queueAhead`).
 *  - `median`: we are randomly positioned within the queue. Expected fill
 *    probability is min(1, takerSize / queueAhead) — the aggressive size reaches
 *    us with probability proportional to how deep we are.
 *  - `optimistic`: any touch fills us immediately (documented UPPER BOUND, not
 *    a headline number).
 *
 * The pessimistic number is the trustworthy one.
 */

// OUR_ORDER_SIZE moved to src/shared/config.js on 2026-10-07; it is imported
// (not redeclared) here and used as the default resting size for every model.
import { OUR_ORDER_SIZE } from '../shared/config.js';
import type { QueueModelName, QueueOutcome } from './types.js';

export function pessimisticFill(queueAhead: number, takerSize: number, ourSize: number = OUR_ORDER_SIZE): QueueOutcome {
  // We are last in line: fill only the leftover after the queue ahead is consumed.
  if (takerSize > queueAhead) {
    const fillSize = Math.min(takerSize - queueAhead, ourSize);
    return {
      fills: fillSize > 0,
      fillFraction: ourSize > 0 ? fillSize / ourSize : 0,
      fillSize,
    };
  }
  return { fills: false, fillFraction: 0, fillSize: 0 };
}

export function medianFill(queueAhead: number, takerSize: number, ourSize: number = OUR_ORDER_SIZE): QueueOutcome {
  // The brief defines the median model stochastically: fill when cumulative size
  // >= queueAhead * U, with U ~ U(0,1). We use the closed-form expectation over U
  // rather than Monte Carlo, so the result is deterministic and diffable across
  // runs (no seed, no sampling noise):
  //     P(fill) = P(queueAhead * U <= takerSize) = P(U <= takerSize / queueAhead)
  //             = min(1, takerSize / queueAhead)
  // With nothing ahead of us we fill on any positive touch.
  if (queueAhead <= 0) {
    const fillSize = takerSize > 0 ? ourSize : 0;
    return { fills: fillSize > 0, fillFraction: ourSize > 0 ? fillSize / ourSize : 0, fillSize };
  }
  const p = Math.min(1, takerSize / queueAhead);
  const fillSize = ourSize * p;
  return { fills: p > 0, fillFraction: p, fillSize };
}

export function optimisticFill(
  _queueAhead: number,
  takerSize: number,
  ourSize: number = OUR_ORDER_SIZE,
): QueueOutcome {
  // Upper bound: any touch at our price fills us, ignoring the queue entirely.
  // `_queueAhead` is kept for signature parity with the other two models.
  const fillSize = takerSize > 0 ? Math.min(ourSize, takerSize) : 0;
  return { fills: fillSize > 0, fillFraction: ourSize > 0 ? fillSize / ourSize : 0, fillSize };
}

const MODELS: Record<QueueModelName, (queueAhead: number, takerSize: number, ourSize?: number) => QueueOutcome> = {
  pessimistic: pessimisticFill,
  median: medianFill,
  optimistic: optimisticFill,
};

/** Apply a model by name. */
export function applyQueueModel(
  model: QueueModelName,
  queueAhead: number,
  takerSize: number,
  ourSize: number = OUR_ORDER_SIZE,
): QueueOutcome {
  return MODELS[model](queueAhead, takerSize, ourSize);
}

/** The ordered list of model names, pessimistic first (the headline). */
export const QUEUE_MODELS: readonly QueueModelName[] = ['pessimistic', 'median', 'optimistic'] as const;
