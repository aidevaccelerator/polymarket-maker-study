/**
 * Round-trip pairing: FIFO matching of opposing fills.
 *
 * A round trip is a matched buy<->sell of OUR position. Fills are processed in
 * time order; each fill offsets the OLDEST outstanding opposite-direction fill
 * first (FIFO), so realized PnL uses first-in-first-out cost basis.
 */

import { distribution } from './markout.js';
import type { Distribution, Fill, OurSide, RoundTrip } from './types.js';

/** Per-share gross PnL in cents for a matched pair. Positive = profit. */
export function grossPnlCents(entry: Fill, exit: Fill): number {
  // entry.ourSide 'BUY'  => long (bought first), position sign +1
  // entry.ourSide 'SELL' => short (sold first), position sign -1
  const positionSign: 1 | -1 = entry.ourSide === 'BUY' ? 1 : -1;
  return (exit.price - entry.price) * 100 * positionSign;
}

/** Sign of an open position in shares (long positive, short negative). */
function positionSignShares(ourSide: OurSide): 1 | -1 {
  return ourSide === 'BUY' ? 1 : -1;
}

/** Pair opposing fills FIFO. Returns matched round trips (entry = older fill). */
export function pairRoundTrips(fills: Fill[]): RoundTrip[] {
  const sorted = [...fills].sort((a, b) => a.tsMs - b.tsMs);
  // Outstanding shares, signed (long positive, short negative), in FIFO order.
  const open: { fill: Fill; remaining: number }[] = [];
  const trips: RoundTrip[] = [];

  for (const fill of sorted) {
    const sign = positionSignShares(fill.ourSide);
    let remaining = fill.size;

    let i = 0;
    while (remaining > 0 && i < open.length) {
      const slot = open[i];
      if (slot === undefined) break;

      if (slot.remaining * sign < 0) {
        // Opposite sign: close against the oldest outstanding position first.
        const matched = Math.min(remaining, Math.abs(slot.remaining));
        trips.push({
          entry: slot.fill,
          exit: fill,
          matchedSize: matched,
          holdingMs: fill.tsMs - slot.fill.tsMs,
          grossPnlCents: grossPnlCents(slot.fill, fill),
        });

        remaining -= matched;
        const slotSign = positionSignShares(slot.fill.ourSide);
        slot.remaining -= matched * slotSign;

        if (Math.abs(slot.remaining) < 1e-9) {
          open.splice(i, 1); // next slot shifts into index i
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    }

    if (remaining > 0) {
      open.push({ fill, remaining: remaining * sign });
    }
  }

  return trips;
}

export interface RoundTripSummary {
  trips: number;
  matchedShares: number;
  avgHoldingSeconds: number;
  grossPnlCentsSum: number;
  grossEdgeBps: number;
  perTripGrossPnlCents: Distribution | null;
}

/** Summarize paired trips. `avgEntryPrice` converts cents to bps. */
export function summarizeRoundTrips(trips: RoundTrip[], avgEntryPrice: number): RoundTripSummary {
  const matchedShares = trips.reduce((s, t) => s + t.matchedSize, 0);
  const holdingTotalMs = trips.reduce((s, t) => s + t.holdingMs, 0);
  const pnlCentsSum = trips.reduce((s, t) => s + t.grossPnlCents * t.matchedSize, 0);

  const perTrip = trips.map((t) => t.grossPnlCents);
  const perTripDist = distribution(perTrip);

  const grossEdgeBps =
    avgEntryPrice > 0 ? (pnlCentsSum / (matchedShares * avgEntryPrice)) * 10000 : 0;

  return {
    trips: trips.length,
    matchedShares,
    avgHoldingSeconds: trips.length > 0 ? holdingTotalMs / trips.length / 1000 : 0,
    grossPnlCentsSum: pnlCentsSum,
    grossEdgeBps,
    perTripGrossPnlCents: perTripDist,
  };
}
