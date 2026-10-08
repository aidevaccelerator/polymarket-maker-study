// Shared schema: the contract between the collector (this project) and the
// analysis agent. These interfaces are reproduced VERBATIM from the project
// brief — do not rename fields, change types, or add `readonly`, or the
// analysis code (built against these exact declarations) will not compile.
//
// Parquet encoding note (the analysis agent reads the partitioned Parquet
// files produced by `src/collector/writer.ts`; these interfaces describe the
// decoded record shape, not the on-disk layout):
//
//   kind=book  columns: ts(STRING) recvTs(STRING) conditionId(STRING)
//              tokenId(STRING) bids(JSON string of [price,size][])
//              asks(JSON string of [price,size][]) tickSize(DOUBLE)
//              minOrderSize(DOUBLE)
//   kind=tob   columns: ts(STRING) conditionId(STRING) tokenId(STRING)
//              bestBid(DOUBLE|null) bestAsk(DOUBLE|null) mid(DOUBLE|null)
//              spread(DOUBLE|null)
//   kind=touch columns: ts(STRING) conditionId(STRING) tokenId(STRING)
//              side(STRING "BUY"|"SELL") price(DOUBLE) size(DOUBLE)
//              bookTs(STRING) queueAhead(DOUBLE)
//   kind=change columns: ts(STRING) conditionId(STRING) tokenId(STRING)
//              side(STRING "BUY"|"SELL") price(DOUBLE) size(DOUBLE)
//              bestBid(DOUBLE|null) bestAsk(DOUBLE|null) hash(STRING)
//
// `bids`/`asks` are serialized as JSON strings (`JSON.stringify` of the
// `[number, number][]` tuple array); call `JSON.parse` to recover them.

// Full orderbook snapshot. Cadence is the duration of ONE batched sweep, not a
// flat interval: a sweep is a single `POST /books` covering every tracked
// market, so the effective cadence is max(BOOK_POLL_MS, one-batch latency). An
// expected row count must come from the OBSERVED sweep cost in manifest.json
// `bookSweep`, not from BOOK_POLL_MS. See src/collector/bookPoller.ts.
export interface BookSnapshot {
  ts: string;              // ISO8601 UTC, from exchange payload when available
  recvTs: string;          // local ISO8601 UTC receive time
  conditionId: string;
  tokenId: string;         // YES token id
  bids: [number, number][];  // [price, size], descending by price
  asks: [number, number][];  // [price, size], ascending by price
  tickSize: number;
  minOrderSize: number;
}

// Top-of-book, ~1s resolution
export interface TopOfBook {
  ts: string;
  conditionId: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;   // bestAsk - bestBid, null if either side empty
}

// A single level change off the CLOB market websocket channel.
//
// RECORDED, NOT INTERPRETED. This is the raw event, kept verbatim so that the
// question "what counts as a fill" is answered in ANALYSIS against real data
// rather than guessed at in the collector. It exists because the collector's
// other subscription (`price.polymarket` on ws-live-v2) carries neither `size`
// nor `side`, so it cannot observe a fill at all, while this channel carries
// both at ~16 events/min/token.
//
// It does NOT say a fill happened. A cancellation and an aggressive trade are
// the same observation here; separating them is the analysis layer's job and is
// deliberately not pre-decided.
export interface PriceChange {
  ts: string;                // ISO8601 UTC, from the exchange timestamp when available
  conditionId: string;
  tokenId: string;           // YES token id
  side: 'BUY' | 'SELL';      // side of the BOOK that changed, not the aggressor
  price: number;             // the price level that changed
  size: number;              // size at that level as reported by the exchange
  bestBid: number | null;
  bestAsk: number | null;
  hash: string;              // exchange book-state hash after the change
}

// A trade print at or beyond where a hypothetical quote would rest
export interface QuoteTouch {
  ts: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';    // AGGRESSOR side
  price: number;
  size: number;            // aggressive size at that price level
  bookTs: string;          // book snapshot ts used for queue math
  queueAhead: number;      // shares resting ahead of us at our price at bookTs
}
