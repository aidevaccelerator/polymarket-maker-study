import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueAhead } from './queue.js';
import type { BookSnapshot } from './schema.js';

function book(): BookSnapshot {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    recvTs: '2026-01-01T00:00:00.100Z',
    conditionId: 'c1',
    tokenId: 't1',
    bids: [
      [0.52, 100],
      [0.51, 50],
      [0.5, 200],
    ],
    asks: [
      [0.53, 80],
      [0.54, 90],
    ],
    tickSize: 0.01,
    minOrderSize: 5,
  };
}

test('queueAhead on bid side returns depth at exact price', () => {
  assert.equal(queueAhead(book(), 'BUY', 0.51), 50);
});

test('queueAhead on ask side returns depth at exact price', () => {
  assert.equal(queueAhead(book(), 'SELL', 0.54), 90);
});

test('queueAhead returns 0 when no level rests at the price', () => {
  assert.equal(queueAhead(book(), 'BUY', 0.53), 0);
});
