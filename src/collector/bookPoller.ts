import { BOOK_POLL_MS } from '../shared/config.js';
import { asPrice, asSize, isRecord, numberOrNull } from '../shared/parse.js';
import type { BookSnapshot, QuoteTouch, SizeDrop } from '../shared/schema.js';
import { normalizeTs, nowIso } from '../shared/time.js';
import { MalformedBookError } from './errors.js';
import { postJson } from './http.js';
import type { TrackedMarket } from './gamma.js';
import { detectSizeDrops, detectTouches } from './trades.js';

const CLOB_BASE = 'https://clob.polymarket.com';

export interface BookPollerDeps {
  readonly onBook: (book: BookSnapshot) => void;
  readonly onTouch: (touch: QuoteTouch) => void;
  readonly onDrop: (drop: SizeDrop) => void;
  readonly onError: (market: TrackedMarket, err: unknown) => void;
}

/**
 * Measured cost of the completed sweeps. Carried into
 * `data/quality/manifest.json` so the achieved cadence is auditable from an
 * artifact already collected and uploaded, rather than inferred from the
 * configured interval. See `BookPoller.sweepStats`.
 */
export interface BookSweepStats {
  /** Completed full passes over `markets`. A tick dropped by the reentrancy guard is not a sweep. */
  readonly sweeps: number;
  readonly meanMs: number;
  /** Slowest sweep — the one that stretches the cadence furthest past the interval. */
  readonly maxMs: number;
}

// Raw, unparsed `/book` bodies for ONE sweep, keyed by `conditionId`. Injecting
// the BODIES rather than a pre-parsed `BookSnapshot` keeps `parseBook` inside the
// test: a stub returning an already parsed book would bypass the very parsing
// whose failure this file reports.
//
// A MISSING key is meaningful and is not an error condition of this type: the
// multi-book endpoint omits tokens that have never traded, so absence is how a
// market that produced no book is represented. `pollAll` turns each absent
// market into an `onError` for that market alone.
export type RawBooksByCondition = ReadonlyMap<string, unknown>;

export type RawBookBatchFetcher = (
  markets: readonly TrackedMarket[],
) => Promise<RawBooksByCondition>;

function parseLevels(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const out: [number, number][] = [];
  for (const item of v) {
    if (!isRecord(item)) return null;
    const price = asPrice(item['price']);
    const size = asSize(item['size']);
    if (price === null || size === null) return null;
    out.push([price, size]);
  }
  return out;
}

// Two outcomes, and the difference is load-bearing:
//   ok: true  — a valid snapshot. An EMPTY book lands here: `bids: []` parses to
//               zero levels, not to a failure, so a genuinely empty book is
//               written like any other and is not an error.
//   ok: false — the response did not match the shape the dataset depends on.
//               Nothing is written, and the caller MUST report it.
type ParsedBook =
  | { readonly ok: true; readonly book: BookSnapshot }
  | { readonly ok: false; readonly reason: string };

function parseBook(body: unknown, market: TrackedMarket): ParsedBook {
  if (!isRecord(body)) return { ok: false, reason: 'body is not a JSON object' };
  const bids = parseLevels(body['bids']);
  const asks = parseLevels(body['asks']);
  // Checked separately, not as `bids === null || asks === null`: the combined
  // form cannot say WHICH side broke, and a shape change is diagnosed from this
  // line. Both still discard the whole book — one bad side is not a partial book.
  if (bids === null) return { ok: false, reason: 'bids is not an array of {price, size} levels' };
  if (asks === null) return { ok: false, reason: 'asks is not an array of {price, size} levels' };
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  return {
    ok: true,
    book: {
      ts: normalizeTs(body['timestamp']) ?? nowIso(),
      recvTs: nowIso(),
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      bids,
      asks,
      tickSize: numberOrNull(body['tick_size']) ?? 0.01,
      minOrderSize: numberOrNull(body['min_order_size']) ?? 0,
    },
  };
}

/**
 * Fetch every tracked market's book in ONE request.
 *
 * Responses are matched by `asset_id`, never by array position: the endpoint
 * returns them in whatever order it fetched them, and the observed timestamps
 * come back out of request order. A positional match would silently attribute a
 * book to the wrong market, which would corrupt `prev` and fabricate touches.
 */
/**
 * Translate a multi-book response into a `conditionId`-keyed map.
 *
 * Matching is by `asset_id`, never by array position: the endpoint returns
 * entries in whatever order it fetched them, and observed timestamps come back
 * out of request order. A positional match would attribute a book to the wrong
 * market, which would poison `prev` for that condition and fabricate touches.
 *
 * An `asset_id` no tracked market claims is dropped rather than guessed at.
 */
export function booksByCondition(
  body: unknown,
  markets: readonly TrackedMarket[],
): RawBooksByCondition {
  if (!Array.isArray(body)) return new Map();
  const conditionIdByToken = new Map<string, string>();
  for (const m of markets) conditionIdByToken.set(m.tokenId, m.conditionId);
  const out = new Map<string, unknown>();
  for (const entry of body) {
    if (!isRecord(entry)) continue;
    const assetId = entry['asset_id'];
    if (typeof assetId !== 'string') continue;
    const conditionId = conditionIdByToken.get(assetId);
    if (conditionId === undefined) continue;
    out.set(conditionId, entry);
  }
  return out;
}

async function fetchBooksOverHttp(markets: readonly TrackedMarket[]): Promise<RawBooksByCondition> {
  return booksByCondition(
    await postJson(
      `${CLOB_BASE}/books`,
      markets.map((m) => ({ token_id: m.tokenId })),
    ),
    markets,
  );
}

/**
 * Full-book poller.
 *
 * ONE REQUEST PER SWEEP. `pollAll` fetches every tracked market through the
 * multi-book endpoint in a single POST, then processes each response on its own.
 *
 * This replaced a sequential per-market sweep that cost `markets.length x
 * per-request latency` — measured at 0.54-1.76 s per `/book`, so 15-50 s for 30
 * markets against a nominal `BOOK_POLL_MS = 5000`. Batching the same 30 tokens
 * measured 0.68 s. That gap was not cosmetic: `detectTouches` infers a fill only
 * from a best-level price MOVE between consecutive snapshots, so at a 15-50 s
 * effective cadence a lift-and-refill between polls is invisible and the touch
 * stream stays empty.
 *
 * The earlier comment here justified the sequential sweep as avoiding raised
 * request concurrency. Batching is the opposite of that argument: it takes a
 * sweep from 30 requests to 1, so concurrency against the public API goes DOWN.
 *
 * `BOOK_POLL_MS` remains the delay between ATTEMPTS and the `polling` guard still
 * DROPS a tick landing mid-sweep rather than queueing it, so the achieved cadence
 * is `max(BOOK_POLL_MS, sweep duration)` — but the sweep term is now ~0.7 s rather
 * than ~50 s, so the interval is finally the binding constraint and the documented
 * cadence is achieved. `sweepStats()` still records the achieved number rather
 * than assuming it.
 */
export class BookPoller {
  private readonly prev = new Map<string, BookSnapshot>();
  // conditionIds whose malformed-response report has already been emitted and is
  // awaiting a successful parse to clear. See reportMalformed.
  private readonly reportedMalformed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private sweepCount = 0;
  private sweepTotalMs = 0;
  private sweepMaxMs = 0;

  constructor(
    private readonly markets: readonly TrackedMarket[],
    private readonly deps: BookPollerDeps,
    private readonly fetchBatch: RawBookBatchFetcher = fetchBooksOverHttp,
  ) {}

  start(intervalMs = BOOK_POLL_MS): void {
    this.timer = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
    void this.pollAll();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One full pass over every tracked market, awaited.
   *
   * A single batched request supplies every market, then each market is processed
   * on its own. A market absent from the response is reported through `onError`
   * for that market alone, so one omitted token costs one market's snapshot and
   * not the whole sweep. If the request itself fails, every market is reported —
   * which is the same per-market surfacing a sequential sweep produced, minus the
   * 30 requests that used to be needed to discover it.
   */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const startedAt = Date.now();
    try {
      let bodies: RawBooksByCondition;
      try {
        bodies = await this.fetchBatch(this.markets);
      } catch (err) {
        for (const market of this.markets) this.deps.onError(market, err);
        return;
      }
      for (const market of this.markets) {
        const body = bodies.get(market.conditionId);
        if (body === undefined) {
          this.deps.onError(market, new MalformedBookError('omitted from the multi-book response'));
          continue;
        }
        this.ingest(market, body);
      }
    } finally {
      this.polling = false;
      const elapsedMs = Date.now() - startedAt;
      this.sweepCount += 1;
      this.sweepTotalMs += elapsedMs;
      if (elapsedMs > this.sweepMaxMs) this.sweepMaxMs = elapsedMs;
    }
  }

  /**
   * Observed sweep cost, or null when no sweep has completed. `null` is
   * deliberately not `0`: the discovery-failure, dry-run and empty-universe paths
   * never start a poller, and a `0` ms sweep would read as a healthy
   * instantaneous sweep rather than as "never ran". Recorded in the `finally` so
   * a sweep that ends in thrown work is still measured — it consumed real time.
   *
   * Mean AND max rather than last: a last value is one sample and is noisy
   * enough to be worth reading as an accident, while the mean alone hides the
   * slow sweeps that are the ones stretching the cadence. Count is included so a
   * mean or max computed from a handful of sweeps can be discounted.
   */
  sweepStats(): BookSweepStats | null {
    if (this.sweepCount === 0) return null;
    return {
      sweeps: this.sweepCount,
      meanMs: this.sweepTotalMs / this.sweepCount,
      maxMs: this.sweepMaxMs,
    };
  }

  private reportMalformed(market: TrackedMarket, reason: string): void {
    // RATE LIMIT, and why it is edge-triggered rather than time-windowed. The
    // poller runs every 5s across ~30 markets, so a permanently malformed market
    // would otherwise write ~17,280 lines/day — enough to bury the durable audit
    // log and the uploaded `collector-artifacts` gap files under one repeating
    // message, which is how a real problem becomes invisible.
    //
    // So: report the FIRST failure for a condition, suppress repeats, and let a
    // successfully parsed book clear the flag so a later failure is reported
    // again as the distinct incident it is. That bounds the log to one entry per
    // contiguous failure episode — the unit an auditor wants — while never
    // collapsing two separate episodes into one. It also needs no clock, so the
    // behaviour is deterministic rather than dependent on wall time.
    //
    // Scope: this covers MALFORMED RESPONSES only. A transport failure still
    // reaches onError on every occurrence, exactly as before.
    if (this.reportedMalformed.has(market.conditionId)) return;
    this.reportedMalformed.add(market.conditionId);
    this.deps.onError(market, new MalformedBookError(reason));
  }

  /** Parse, report and diff ONE already-fetched body. Synchronous by design: nothing here awaits. */
  private ingest(market: TrackedMarket, body: unknown): void {
    const parsed = parseBook(body, market);
    if (!parsed.ok) {
      this.reportMalformed(market, parsed.reason);
      return;
    }
    const snap = parsed.book;
    // A book parsed, so any earlier failure for this condition is over. Clearing
    // here — and only here — is what makes a later failure reportable again.
    this.reportedMalformed.delete(market.conditionId);

    const prev = this.prev.get(market.conditionId);
    this.prev.set(market.conditionId, snap);
    this.deps.onBook(snap);
    if (prev !== undefined) {
      for (const touch of detectTouches(prev, snap)) this.deps.onTouch(touch);
      for (const drop of detectSizeDrops(prev, snap)) this.deps.onDrop(drop);
    }
  }
}
