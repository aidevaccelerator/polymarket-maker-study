import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bestLevelInfo, computeFillRates } from './fillRate.js';
import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';

function book(ts: string, asks: [number, number][]): BookSnapshot {
  return {
    ts,
    recvTs: ts,
    conditionId: 'c',
    tokenId: 't',
    bids: [[0.49, 100]],
    asks,
    tickSize: 0.01,
    minOrderSize: 1,
  };
}

function touch(ts: string, side: 'BUY' | 'SELL', size: number, bookTs: string): QuoteTouch {
  return { ts, conditionId: 'c', tokenId: 't', side, price: 0.5, size, bookTs, queueAhead: 0 };
}

test('bestLevelInfo returns the best price and total size on the hit side', () => {
  const b = book('b1', [
    [0.5, 30],
    [0.5, 20],
    [0.51, 99],
  ]);
  const info = bestLevelInfo(b, 'BUY'); // BUY aggressor hits the ask side
  assert.equal(info?.bestPrice, 0.5);
  assert.equal(info?.bestLevelSize, 50);
});

test('fill rate: at the touch (queueAhead 0) pessimistic fills immediately, capped by taker size', () => {
  const books = new Map([['b1', book('b1', [[0.5, 80]])]]);
  const touches = [
    touch('1', 'BUY', 60, 'b1'), // 60 < 80 -> inside does NOT fill
    touch('2', 'BUY', 100, 'b1'), // 100 > 80 -> inside fills fractionally (20/100)
  ];
  const results = computeFillRates(touches, (ts) => books.get(ts));

  const touchPess = results.find((r) => r.placement === 'touch' && r.model === 'pessimistic');
  const insidePess = results.find((r) => r.placement === 'oneTickInside' && r.model === 'pessimistic');
  const insideOptim = results.find((r) => r.placement === 'oneTickInside' && r.model === 'optimistic');
  const touchOptim = results.find((r) => r.placement === 'touch' && r.model === 'optimistic');

  // At the touch we are first in line, so both touches fill us -- but only for
  // as many shares as the taker actually wanted: 60/100 and 100/100, mean 0.8.
  assert.equal(touchPess?.total, 2);
  assert.ok(Math.abs((touchPess?.fillRate ?? 0) - 0.8) < 1e-12);
  assert.ok(insidePess !== undefined);
  // touch 1: no fill; touch 2: fillFraction 0.2 -> fill rate 0.1
  assert.ok(Math.abs((insidePess?.fillRate ?? 1) - 0.1) < 1e-12);

  // Optimistic ignores the queue entirely, so placement cannot change its rate:
  // touch and 1-tick-inside must be identical, and both are still capped by the
  // taker's desired size (0.8), NOT 1.0.
  assert.equal(insideOptim?.fillRate, 0.8);
  assert.equal(insideOptim?.fillRate, touchOptim?.fillRate);
});
