import { BOOK_POLL_MS } from '../shared/config.js';
import { asPrice, asSize, isRecord, numberOrNull } from '../shared/parse.js';
import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';
import { normalizeTs, nowIso } from '../shared/time.js';
import { MalformedBookError } from './errors.js';
import { fetchJson } from './http.js';
import type { TrackedMarket } from './gamma.js';
import { detectTouches } from './trades.js';

const CLOB_BASE = 'https://clob.polymarket.com';

export interface BookPollerDeps {
  readonly onBook: (book: BookSnapshot) => void;
  readonly onTouch: (touch: QuoteTouch) => void;
  readonly onError: (market: TrackedMarket, err: unknown) => void;
}

// The raw, unparsed /book body. Injecting the BODY rather than a pre-parsed
// BookSnapshot keeps `parseBook` inside the test: a stub returning an already
// parsed book would bypass the very parsing whose failure this file reports.
export type RawBookFetcher = (market: TrackedMarket) => Promise<unknown>;

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

async function fetchBookOverHttp(market: TrackedMarket): Promise<unknown> {
  return fetchJson(`${CLOB_BASE}/book?token_id=${market.tokenId}`);
}

export class BookPoller {
  private readonly prev = new Map<string, BookSnapshot>();
  // conditionIds whose malformed-response report has already been emitted and is
  // awaiting a successful parse to clear. See reportMalformed.
  private readonly reportedMalformed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly markets: readonly TrackedMarket[],
    private readonly deps: BookPollerDeps,
    private readonly fetch: RawBookFetcher = fetchBookOverHttp,
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

  /** One full pass over every tracked market, awaited. */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const market of this.markets) {
        await this.pollOne(market);
      }
    } finally {
      this.polling = false;
    }
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

  private async pollOne(market: TrackedMarket): Promise<void> {
    let parsed: ParsedBook;
    try {
      parsed = await this.fetchBook(market);
    } catch (err) {
      this.deps.onError(market, err);
      return;
    }
    if (!parsed.ok) {
      this.reportMalformed(market, parsed.reason);
      return;
    }
    const book = parsed.book;
    // A book parsed, so any earlier failure for this condition is over. Clearing
    // here — and only here — is what makes a later failure reportable again.
    this.reportedMalformed.delete(market.conditionId);

    const prev = this.prev.get(market.conditionId);
    this.prev.set(market.conditionId, book);
    this.deps.onBook(book);
    if (prev !== undefined) {
      for (const touch of detectTouches(prev, book)) this.deps.onTouch(touch);
    }
  }

  private async fetchBook(market: TrackedMarket): Promise<ParsedBook> {
    return parseBook(await this.fetch(market), market);
  }
}
