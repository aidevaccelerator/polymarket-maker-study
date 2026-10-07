/**
 * Analysis-internal types.
 *
 * IMPORTANT: these are DERIVED types for the analysis pipeline only. The shared
 * schema types (BookSnapshot, TopOfBook, QuoteTouch) are the source of truth and
 * are imported from `../shared/schema.js` wherever raw collector output is
 * consumed. Nothing here redefines or shadows them.
 */

import type { BookSnapshot, QuoteTouch, TopOfBook } from '../shared/schema.js';

/** What *we* (the passive maker) did on a fill leg. */
export type OurSide = 'BUY' | 'SELL';

/** The three queue-position models, reported as a band. */
export type QueueModelName = 'pessimistic' | 'median' | 'optimistic';

/**
 * A candidate fill of one of our resting quotes.
 *
 * `ourSide` is our side of the trade, i.e. the mirror of the aggressor side
 * encoded in `QuoteTouch.side` (aggressor BUY -> we SELL; aggressor SELL -> we BUY).
 */
export interface Fill {
  /** Fill timestamp (as stored by the collector). */
  ts: string;
  /** Fill timestamp parsed to epoch milliseconds. */
  tsMs: number;
  conditionId: string;
  tokenId: string;
  ourSide: OurSide;
  /** Our limit price (the aggressor's touch price). */
  price: number;
  /** Shares of ours that filled. */
  size: number;
  /** Book snapshot ts used for queue math. */
  bookTs: string;
  /** Shares resting ahead of us at our price. */
  queueAhead: number;
  /** Aggressor size that caused the touch (QuoteTouch.size). */
  takerSize: number;
}

/** Result of applying one queue model to one touch. */
export interface QueueOutcome {
  fills: boolean;
  /** Fraction of our order filled, in [0, 1]. */
  fillFraction: number;
  /** Shares filled. */
  fillSize: number;
}

/** One markout sample: an adverseCents reading at a given horizon, with its weight. */
export interface MarkoutSample {
  horizonSeconds: number;
  adverseCents: number;
  /** Weight (fill fraction) this sample carries in the distribution. */
  weight: number;
}

/** A percentile summary of adverseCents (or any numeric metric). */
export interface Distribution {
  /** Number of (unweighted) samples. */
  n: number;
  /** Sum of weights (effective sample count). */
  nWeighted: number;
  mean: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/** A matched buy<->sell pair of our fills. */
export interface RoundTrip {
  /** Opening leg (earlier fill). */
  entry: Fill;
  /** Closing leg (later, opposing fill). */
  exit: Fill;
  matchedSize: number;
  holdingMs: number;
  /** Per-share gross PnL in cents. Positive = profit. */
  grossPnlCents: number;
}

/** Taker share measured within a single market (conditionId). */
export interface MarketTakerShare {
  conditionId: string;
  takerShare: number | null;
  takerVolume: number;
  makerVolume: number;
  samples: number;
  warnings: string[];
}

/** Measurement of taker share T/(M+T). */
export interface TakerShareResult {
  /** Volume-weighted T/(M+T) across all in-scope markets, or null if unmeasurable. */
  takerShare: number | null;
  takerVolume: number;
  makerVolume: number;
  /** Human-readable description of how this was measured. */
  method: string;
  samples: number;
  warnings: string[];
  /** Per-market breakdown, ordered by descending taker volume. */
  byMarket: MarketTakerShare[];
}

/** Lookup helper for book snapshots by their `ts`. */
export type BookLookup = (ts: string) => BookSnapshot | undefined;

/** A parsed run of raw collector data. */
export interface Dataset {
  books: BookSnapshot[];
  tops: TopOfBook[];
  touches: QuoteTouch[];
  quality: QualityManifest | null;
  gaps: GapRecord[];
}

export interface QualityManifest {
  expected: Record<string, number>;
  [key: string]: unknown;
}

export interface GapRecord {
  [key: string]: unknown;
}
