// Queue-position math shared by collector and analysis.
//
// A shadow trader has no queue position and does not consume one: a
// hypothetical resting order joins the BACK of the time-priority queue at its
// price level. `queueAhead` is therefore the number of shares already resting
// at exactly our price level, ahead of us in time priority. Shares resting at
// strictly better prices fill before us too, but those are recoverable
// separately from the full `BookSnapshot`; `queueAhead` records the same-price
// component that a top-of-book-only reader cannot reconstruct.

import type { BookSnapshot } from './schema.js';

export type RestingSide = 'BUY' | 'SELL';

// Shares resting ahead of a hypothetical order at `price` on the given side.
//   side 'BUY'  -> our order is a bid; inspect the bid side.
//   side 'SELL' -> our order is an ask; inspect the ask side.
export function queueAhead(book: BookSnapshot, side: RestingSide, price: number): number {
  const levels = side === 'BUY' ? book.bids : book.asks;
  let total = 0;
  for (const [levelPrice, levelSize] of levels) {
    if (levelPrice === price) total += levelSize;
  }
  return total;
}
