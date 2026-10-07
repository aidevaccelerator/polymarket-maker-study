import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyParquetFile,
  mapBookSnapshot,
  mapQuoteTouch,
  mapTopOfBook,
  toLevels,
} from './parquetRead.js';

// The real layout, verbatim from src/collector/writer.ts:
//   data/dt=YYYY-MM-DD/condition=<conditionId>/kind=<book|tob|touch>/part-<HHMMSS>.parquet
const PART = 'part-120000.parquet';
const base = 'data/dt=2024-01-02/condition=0xabc';

test('classifyParquetFile reads the collector kind= segment for all three kinds', () => {
  assert.equal(classifyParquetFile(`${base}/kind=book/${PART}`), 'books');
  assert.equal(classifyParquetFile(`${base}/kind=tob/${PART}`), 'tops');
  assert.equal(classifyParquetFile(`${base}/kind=touch/${PART}`), 'touches');
});

test('regression: kind=tob must be tops, not unknown', () => {
  // A `/top/`-style keyword match does NOT catch "tob". Classifying it as
  // unknown silently drops every mid, which empties the markout distribution
  // rather than raising — the failure this test exists to prevent.
  assert.notEqual(classifyParquetFile(`${base}/kind=tob/${PART}`), 'unknown');
});

test('classifyParquetFile falls back to keywords when there is no kind= segment', () => {
  assert.equal(classifyParquetFile('data/books/part-0.parquet'), 'books');
  assert.equal(classifyParquetFile('data/tops/part-0.parquet'), 'tops');
  assert.equal(classifyParquetFile('data/quotes/part-0.parquet'), 'touches');
  assert.equal(classifyParquetFile('data/mystery/part-0.parquet'), 'unknown');
});

test('toLevels normalizes both tuple and struct level encodings', () => {
  assert.deepEqual(toLevels([[0.5, 100], [0.49, 50]]), [
    [0.5, 100],
    [0.49, 50],
  ]);
  assert.deepEqual(toLevels([{ price: 0.5, size: 100 }]), [[0.5, 100]]);
  assert.deepEqual(toLevels(undefined), []);
});

test('regression: toLevels parses the JSON-text encoding the collector writes', () => {
  // writer.ts emits JSON.stringify(bids) as a JSON column. If this returned [],
  // restingSizeAtPrice would be 0 everywhere and takerShare would compute as
  // exactly 1.0 -- a fabricated number, not a measurement.
  assert.deepEqual(toLevels('[[0.49,100],[0.48,50]]'), [
    [0.49, 100],
    [0.48, 50],
  ]);
  assert.deepEqual(toLevels(''), []);
  assert.deepEqual(toLevels('not json'), []);
});

test('row mappers read schema column names and coerce nulls', () => {
  const tob = mapTopOfBook({
    ts: '1700000000000',
    conditionId: 'c',
    tokenId: 't',
    bestBid: 0.49,
    bestAsk: null,
    mid: null,
    spread: null,
  });
  assert.equal(tob.ts, '1700000000000');
  assert.equal(tob.bestBid, 0.49);
  assert.equal(tob.bestAsk, null, 'a null DOUBLE must stay null, not become 0');
  assert.equal(tob.mid, null);

  const book = mapBookSnapshot({
    ts: '1',
    recvTs: '1',
    conditionId: 'c',
    tokenId: 't',
    bids: JSON.stringify([[0.49, 100]]),
    asks: JSON.stringify([[0.5, 100]]),
    tickSize: 0.01,
    minOrderSize: 5,
  });
  assert.deepEqual(book.bids, [[0.49, 100]]);
  assert.equal(book.minOrderSize, 5);

  const touch = mapQuoteTouch({
    ts: '1',
    conditionId: 'c',
    tokenId: 't',
    side: 'SELL',
    price: 0.49,
    size: 30,
    bookTs: '1',
    queueAhead: 12,
  });
  assert.equal(touch.side, 'SELL');
  assert.equal(touch.queueAhead, 12);
});