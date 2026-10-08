// Trade-print ingestion.
//
// NOTE ON THE FEED: the read-only public endpoints in scope expose NO dedicated
// trade-print feed. The `price.polymarket` WebSocket channel carries
// best_bid/best_ask only (no trade size), and `/book` carries resting depth.
// QuoteTouch is therefore inferred CONSERVATIVELY from consecutive `/book`
// snapshots: when the best ask moves UP, a BUY aggressor lifted the prior ask;
// when the best bid moves DOWN, a SELL aggressor hit the prior bid.
//
// Conservative by construction:
//   - `size` is the net reduction in depth at the touched level — a LOWER BOUND
//     (an add at that level between polls is indistinguishable from a fill).
//   - A partial fill that does not move the best level is NOT detected.
//   - A cancellation of the best level is indistinguishable from a fill.
//   - `queueAhead` is read from the PRIOR snapshot (the book state a shadow
//     quote would have rested in), via `queueAhead(...)`.

import type { BookSnapshot, QuoteTouch, SizeDrop } from '../shared/schema.js';
import { queueAhead } from '../shared/queue.js';

function bestPrice(levels: readonly [number, number][]): number | null {
  const first = levels[0];
  return first === undefined ? null : first[0];
}

function levelSize(levels: readonly [number, number][], price: number): number {
  for (const [p, s] of levels) {
    if (p === price) return s;
  }
  return 0;
}

export function detectTouches(prev: BookSnapshot, next: BookSnapshot): readonly QuoteTouch[] {
  const touches: QuoteTouch[] = [];

  const prevBestBid = bestPrice(prev.bids);
  const prevBestAsk = bestPrice(prev.asks);
  const nextBestBid = bestPrice(next.bids);
  const nextBestAsk = bestPrice(next.asks);

  // SELL aggressor hit our bid: best bid moved down (or bid side emptied).
  if (prevBestBid !== null && (nextBestBid === null || nextBestBid < prevBestBid)) {
    const size = Math.max(0, levelSize(prev.bids, prevBestBid) - levelSize(next.bids, prevBestBid));
    touches.push({
      ts: next.ts,
      conditionId: next.conditionId,
      tokenId: next.tokenId,
      side: 'SELL',
      price: prevBestBid,
      size,
      bookTs: prev.ts,
      queueAhead: queueAhead(prev, 'BUY', prevBestBid),
    });
  }

  // BUY aggressor lifted our ask: best ask moved up (or ask side emptied).
  if (prevBestAsk !== null && (nextBestAsk === null || nextBestAsk > prevBestAsk)) {
    const size = Math.max(0, levelSize(prev.asks, prevBestAsk) - levelSize(next.asks, prevBestAsk));
    touches.push({
      ts: next.ts,
      conditionId: next.conditionId,
      tokenId: next.tokenId,
      side: 'BUY',
      price: prevBestAsk,
      size,
      bookTs: prev.ts,
      queueAhead: queueAhead(prev, 'SELL', prevBestAsk),
    });
  }

  return touches;
}

// A net size DECREASE at a best level, recorded but NOT classified as a fill.
//
// Complement to `detectTouches`, not a replacement: `detectTouches` fires on a
// best-PRICE move and measured zero such events, while this fires on a best-level
// size DECREASE at a stationary price and measured ~47 per 260s. Both are
// necessary and neither subsumes the other.
//
// The classification is deliberately absent. `levelSize` returns 0 for a level
// that is gone entirely, so a removal and a partial fill are the same
// observation here, exactly as trades.ts's header says they are for `size`. A
// caller wanting fills must decide in analysis, on data, not here.
export function detectSizeDrops(prev: BookSnapshot, next: BookSnapshot): readonly SizeDrop[] {
  const drops: SizeDrop[] = [];
  const prevBid = bestPrice(prev.bids);
  if (prevBid !== null) {
    const prevSize = levelSize(prev.bids, prevBid);
    const nextSize = levelSize(next.bids, prevBid);
    if (nextSize < prevSize) {
      drops.push({
        ts: next.ts,
        prevTs: prev.ts,
        conditionId: next.conditionId,
        tokenId: next.tokenId,
        side: 'BUY',
        price: prevBid,
        prevSize,
        nextSize,
        bestBid: bestPrice(next.bids),
        bestAsk: bestPrice(next.asks),
      });
    }
  }
  const prevAsk = bestPrice(prev.asks);
  if (prevAsk !== null) {
    const prevSize = levelSize(prev.asks, prevAsk);
    const nextSize = levelSize(next.asks, prevAsk);
    if (nextSize < prevSize) {
      drops.push({
        ts: next.ts,
        prevTs: prev.ts,
        conditionId: next.conditionId,
        tokenId: next.tokenId,
        side: 'SELL',
        price: prevAsk,
        prevSize,
        nextSize,
        bestBid: bestPrice(next.bids),
        bestAsk: bestPrice(next.asks),
      });
    }
  }
  return drops;
}
