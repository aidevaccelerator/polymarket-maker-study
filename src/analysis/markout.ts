/**
 * Horizon markout: measures how many cents the mid moves against us between our
 * fill and a fixed horizon after it.
 *
 * The sign convention is THE critical piece of this project. See `ourDirection`
 * below and `ASSUMPTIONS.md` for the full reconciliation with the project brief.
 */

import type { TopOfBook } from '../shared/schema.js';
import type { Distribution, OurSide } from './types.js';

/** Markout horizons, in seconds, used throughout the report. */
export const MARKOUT_HORIZONS_SECONDS = [1, 5, 30, 60] as const;

/**
 * Direction multiplier for the LOSS metric.
 *
 * We are always the passive maker:
 *   - QuoteTouch.side 'BUY'  => an aggressor BOUGHT, hitting our resting ASK,
 *     so WE SELL into it (we are short).
 *   - QuoteTouch.side 'SELL' => an aggressor SOLD, hitting our resting BID,
 *     so WE BUY (we are long).
 *
 * `adverseCents = (midAtHorizon - fillPrice) * 100 * ourDirection` must be
 * POSITIVE when the market moved AGAINST us (a LOSS metric), and NEGATIVE when
 * it moved in our favor.
 *
 *   - SELL (short): we want the price to FALL. Price RISING is adverse, and
 *     (mid - fill) is then positive, so ourDirection must be +1.
 *   - BUY  (long):  we want the price to RISE.  Price FALLING is adverse, and
 *     (mid - fill) is then negative, so ourDirection must be -1.
 *
 * NOTE ON THE BRIEF: the brief writes "our_direction = -1 when we sold, +1 when
 * we bought". Under that assignment the expression (mid - fill)*100*dir is a
 * PROFIT metric (positive = favorable), which contradicts (a) the brief's own
 * sentence "POSITIVE adverseCents = the market moved AGAINST us" and (b) the
 * required test "a fill followed by a mid move in our favor must produce
 * NEGATIVE adverseCents". Both of those pin the LOSS convention, so we use
 * SELL -> +1, BUY -> -1. This is not a silent deviation; it is documented in
 * ASSUMPTIONS.md and enforced by unit tests.
 */
export function ourDirection(ourSide: OurSide): 1 | -1 {
  return ourSide === 'SELL' ? 1 : -1;
}

/** Per-share adverse move in cents. Positive = against us (loss), negative = favor. */
export function adverseCents(fillPrice: number, midAtHorizon: number, ourSide: OurSide): number {
  const dir = ourDirection(ourSide);
  return (midAtHorizon - fillPrice) * 100 * dir;
}

/**
 * Parse a collector timestamp string to epoch milliseconds.
 *
 * Numeric strings are assumed to be epoch MILLISECONDS (the collector uses
 * Date.now()). Non-numeric strings fall back to ISO-8601 / `Date.parse`.
 * Documented in ASSUMPTIONS.md.
 */
export function parseTs(ts: string): number {
  const trimmed = ts.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Cannot parse timestamp: ${JSON.stringify(ts)}`);
  }
  return parsed;
}

/**
 * Non-throwing variant for dataset iteration. A single malformed timestamp must
 * not abort an entire analysis run, but it must also not be silently dropped:
 * callers count nulls and surface them as data-quality warnings.
 */
export function tryParseTs(ts: string): number | null {
  try {
    return parseTs(ts);
  } catch {
    return null;
  }
}

/** A single usable (time, mid) reading. */
export interface MidPoint {
  tsMs: number;
  mid: number;
}

/** Build a time-sorted series of non-null mids from raw TopOfBook rows. */
export function buildMidSeries(tops: TopOfBook[]): MidPoint[] {
  const out: MidPoint[] = [];
  for (const top of tops) {
    if (top.mid === null || top.mid === undefined) continue;
    out.push({ tsMs: parseTs(top.ts), mid: top.mid });
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

/** Index of the last element with tsMs <= targetMs, or -1 if none. */
export function upperBoundIndex(series: MidPoint[], targetMs: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const val = series[mid];
    if (val !== undefined && val.tsMs <= targetMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Mid at or before `targetMs` (the "nearest-but-not-after" lookup). Returns
 * null when there is no observation at or before the target.
 */
export function midAtOrBefore(series: MidPoint[], targetMs: number): number | null {
  const idx = upperBoundIndex(series, targetMs);
  if (idx < 0) return null;
  return series[idx]!.mid;
}

/**
 * Compute markout for a fill at a single horizon. Returns null when there is no
 * mid observation at or before t+horizon.
 */
export function markoutAtHorizon(
  series: MidPoint[],
  fillTsMs: number,
  fillPrice: number,
  ourSide: OurSide,
  horizonSeconds: number,
): number | null {
  const targetMs = fillTsMs + horizonSeconds * 1000;
  const mid = midAtOrBefore(series, targetMs);
  if (mid === null) return null;
  return adverseCents(fillPrice, mid, ourSide);
}

/**
 * Weighted percentile distribution over samples. `weights` are fill fractions so
 * partial/median-model fills contribute proportionally. Uses nearest-rank
 * quantiles (smallest value whose cumulative weight reaches q * totalWeight).
 */
export function weightedDistribution(values: number[], weights: number[]): Distribution | null {
  if (values.length === 0) return null;

  const pairs: [number, number][] = [];
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = weights[i];
    if (v === undefined || w === undefined || w <= 0) continue;
    pairs.push([v, w]);
    totalWeight += w;
    weightedSum += v * w;
  }
  if (pairs.length === 0 || totalWeight === 0) return null;

  pairs.sort((a, b) => a[0] - b[0]);

  const quantile = (q: number): number => {
    const target = q * totalWeight;
    let cum = 0;
    for (const [v, w] of pairs) {
      cum += w;
      if (cum >= target) return v;
    }
    return pairs[pairs.length - 1]![0];
  };

  return {
    n: values.length,
    nWeighted: totalWeight,
    mean: weightedSum / totalWeight,
    p10: quantile(0.1),
    p25: quantile(0.25),
    p50: quantile(0.5),
    p75: quantile(0.75),
    p90: quantile(0.9),
  };
}

/** Unweighted convenience wrapper. */
export function distribution(values: number[]): Distribution | null {
  return weightedDistribution(
    values,
    values.map(() => 1),
  );
}
