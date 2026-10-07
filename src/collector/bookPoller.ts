import { BOOK_POLL_MS } from '../shared/config.js';
import { asPrice, asSize, isRecord, numberOrNull } from '../shared/parse.js';
import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';
import { normalizeTs, nowIso } from '../shared/time.js';
import { fetchJson } from './http.js';
import type { TrackedMarket } from './gamma.js';
import { detectTouches } from './trades.js';

const CLOB_BASE = 'https://clob.polymarket.com';

export interface BookPollerDeps {
  readonly onBook: (book: BookSnapshot) => void;
  readonly onTouch: (touch: QuoteTouch) => void;
  readonly onError: (market: TrackedMarket, err: unknown) => void;
}

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

// Parse a CLOB /book response into a BookSnapshot, or null when malformed.
function parseBook(body: unknown, market: TrackedMarket): BookSnapshot | null {
  if (!isRecord(body)) return null;
  const bids = parseLevels(body['bids']);
  const asks = parseLevels(body['asks']);
  if (bids === null || asks === null) return null;
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  return {
    ts: normalizeTs(body['timestamp']) ?? nowIso(),
    recvTs: nowIso(),
    conditionId: market.conditionId,
    tokenId: market.tokenId,
    bids,
    asks,
    tickSize: numberOrNull(body['tick_size']) ?? 0.01,
    minOrderSize: numberOrNull(body['min_order_size']) ?? 0,
  };
}

export class BookPoller {
  private readonly prev = new Map<string, BookSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly markets: readonly TrackedMarket[],
    private readonly deps: BookPollerDeps,
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

  private async pollAll(): Promise<void> {
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

  private async pollOne(market: TrackedMarket): Promise<void> {
    let book: BookSnapshot | null;
    try {
      book = await this.fetchBook(market);
    } catch (err) {
      this.deps.onError(market, err);
      return;
    }
    if (book === null) return; // empty/unsupported book; not an error

    const prev = this.prev.get(market.conditionId);
    this.prev.set(market.conditionId, book);
    this.deps.onBook(book);
    if (prev !== undefined) {
      for (const touch of detectTouches(prev, book)) this.deps.onTouch(touch);
    }
  }

  private async fetchBook(market: TrackedMarket): Promise<BookSnapshot | null> {
    const url = `${CLOB_BASE}/book?token_id=${market.tokenId}`;
    const body = await fetchJson(url);
    return parseBook(body, market);
  }
}
