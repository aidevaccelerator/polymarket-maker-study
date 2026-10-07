import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measureTakerShare, restingSizeAtPrice } from './takerShare.js';
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

function touch(ts: string, side: 'BUY' | 'SELL', price: number, size: number, bookTs: string): QuoteTouch {
  return { ts, conditionId: 'c', tokenId: 't', side, price, size, bookTs, queueAhead: 0 };
}

test('taker share is T/(M+T) with matched volume (symmetry => 0.5)', () => {
  const books = new Map([['b1', book('b1', [[0.5, 200]])]]);
  const touches = [touch('1', 'BUY', 0.5, 100, 'b1'), touch('2', 'BUY', 0.5, 100, 'b1')];
  const r = measureTakerShare(touches, (ts) => books.get(ts));
  assert.ok(r.takerShare !== null);
  if (r.takerShare === null) return;
  assert.ok(Math.abs(r.takerShare - 0.5) < 1e-12, `expected 0.5, got ${r.takerShare}`);
  assert.equal(r.takerVolume, 200);
  assert.equal(r.makerVolume, 200);
});

test('taker share rises when takers over-consume thin resting liquidity', () => {
  const books = new Map([['b1', book('b1', [[0.5, 40]])]]);
  const touches = [touch('1', 'BUY', 0.5, 100, 'b1')];
  const r = measureTakerShare(touches, (ts) => books.get(ts));
  assert.ok(r.takerShare !== null);
  if (r.takerShare === null) return;
  // T = 100, M = min(100, 40) = 40 -> 100/140
  assert.ok(Math.abs(r.takerShare - 100 / 140) < 1e-12);
});

test('emits null (never a guess) when there are no touches', () => {
  const r = measureTakerShare([], () => undefined);
  assert.equal(r.takerShare, null);
  assert.ok(r.warnings.length > 0);
});

test('warns when referenced book snapshots are missing', () => {
  const touches = [touch('1', 'BUY', 0.5, 100, 'b-missing')];
  const r = measureTakerShare(touches, () => undefined);
  assert.ok(r.warnings.some((w) => w.includes('missing')));
});

test('bias guard: a touch price absent from an available book warns, and pushes takerShare toward 1.0', () => {
  // The book exists but has no level at the touch price, so M gets 0 while T
  // still gets the full size -> the ratio becomes exactly 1.0. That is the one
  // value the brief forbids assuming, so it must be reported, not absorbed.
  const books = new Map([['b1', book('b1', [[0.5, 200]])]]);
  const touches = [touch('1', 'BUY', 0.77, 100, 'b1')];
  const r = measureTakerShare(touches, (ts) => books.get(ts));
  assert.equal(r.takerShare, 1);
  assert.equal(r.makerVolume, 0);
  assert.ok(
    r.warnings.some((w) => w.includes('biased UPWARD toward 1.0')),
    `expected an upward-bias warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test('restingSizeAtPrice sums only the level at the touch price', () => {
  const b = book('b1', [
    [0.5, 30],
    [0.5, 20],
    [0.51, 99],
  ]);
  assert.equal(restingSizeAtPrice(b, 'BUY', 0.5), 50);
  assert.equal(restingSizeAtPrice(b, 'BUY', 0.51), 99);
});

test('per-market split is correct and the headline is pooled, not a mean of ratios', () => {
  // Two markets with deliberately different taker shares AND different volumes,
  // so a pooled ratio is distinguishable from an unweighted mean of ratios.
  //   market A: T=100, M=100  -> 0.5000
  //   market B: T=90,  M=10   -> 0.9000
  //   mean of ratios = 0.7 ; pooled = 190/300 = 0.6333...
  const books = new Map([
    ['bA', book('bA', [[0.5, 100]])],
    ['bB', book('bB', [[0.5, 10]])],
  ]);
  const touchA: QuoteTouch = { ...touch('1', 'BUY', 0.5, 100, 'bA'), conditionId: 'A' };
  const touchB: QuoteTouch = { ...touch('2', 'BUY', 0.5, 90, 'bB'), conditionId: 'B' };
  const r = measureTakerShare([touchA, touchB], (ts) => books.get(ts));

  assert.equal(r.byMarket.length, 2);
  const a = r.byMarket.find((m) => m.conditionId === 'A');
  const b = r.byMarket.find((m) => m.conditionId === 'B');
  assert.ok(Math.abs((a?.takerShare ?? 0) - 0.5) < 1e-12);
  assert.ok(Math.abs((b?.takerShare ?? 0) - 0.9) < 1e-12);

  // Sorted by taker VOLUME, not by share: A has T=100 vs B's T=90, so A leads
  // even though B has the higher ratio.
  assert.equal(r.byMarket[0]?.conditionId, 'A');

  assert.ok(Math.abs((r.takerShare ?? 0) - 190 / 300) < 1e-12, 'headline must be the pooled ratio');
  assert.ok(Math.abs((r.takerShare ?? 0) - 0.7) > 1e-6, 'and must NOT be the mean of ratios');
});
