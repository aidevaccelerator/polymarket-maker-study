import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BookSnapshot } from '../shared/schema.js';
import { detectSizeDrops, detectTouches } from './trades.js';

function book(ts: string, bids: [number, number][], asks: [number, number][]): BookSnapshot {
  return {
    ts,
    recvTs: ts,
    conditionId: '0xc',
    tokenId: 'tk',
    bids,
    asks,
    tickSize: 0.01,
    minOrderSize: 5,
  };
}

describe('detectTouches', () => {
  it('emits a BUY touch when the best ask is lifted, sized by net depth reduction', () => {
    const prev = book('t1', [[0.6, 100]], [[0.65, 200]]);
    const next = book('t2', [[0.6, 100]], [[0.66, 300]]);
    assert.deepEqual(detectTouches(prev, next), [
      { ts: 't2', conditionId: '0xc', tokenId: 'tk', side: 'BUY', price: 0.65, size: 200, bookTs: 't1', queueAhead: 200 },
    ]);
  });

  it('emits a SELL touch when the best bid is hit', () => {
    const prev = book('t1', [[0.62, 500]], [[0.66, 100]]);
    const next = book('t2', [[0.61, 400]], [[0.66, 100]]);
    assert.deepEqual(detectTouches(prev, next), [
      { ts: 't2', conditionId: '0xc', tokenId: 'tk', side: 'SELL', price: 0.62, size: 500, bookTs: 't1', queueAhead: 500 },
    ]);
  });

  it('emits a touch when a side empties entirely', () => {
    const prev = book('t1', [[0.62, 40]], [[0.66, 10]]);
    const next = book('t2', [], [[0.66, 10]]);
    assert.equal(detectTouches(prev, next).length, 1);
    assert.equal(detectTouches(prev, next)[0]?.side, 'SELL');
  });

  it('reports the full prior depth when the touched level vanishes entirely', () => {
    const prev = book('t1', [[0.6, 100]], [[0.65, 200]]);
    const next = book('t2', [[0.6, 100]], [[0.67, 200]]);
    assert.equal(detectTouches(prev, next)[0]?.size, 200);
  });

  it('returns nothing when best levels only improve in our favour', () => {
    const prev = book('t1', [[0.6, 100]], [[0.65, 200]]);
    const next = book('t2', [[0.61, 100]], [[0.64, 200]]);
    assert.deepEqual(detectTouches(prev, next), []);
  });

  it('returns nothing for an unchanged book', () => {
    const prev = book('t1', [[0.6, 100]], [[0.65, 200]]);
    const next = book('t2', [[0.6, 100]], [[0.65, 200]]);
    assert.deepEqual(detectTouches(prev, next), []);
  });

  it('reads queueAhead from the prior book at the resting level', () => {
    const prev = book('t1', [[0.6, 100]], [[0.65, 200]]);
    const next = book('t2', [[0.6, 100]], [[0.66, 50]]);
    assert.equal(detectTouches(prev, next)[0]?.bookTs, 't1');
    assert.equal(detectTouches(prev, next)[0]?.queueAhead, 200);
  });
});
describe('detectSizeDrops', () => {
  const base = {
    ts: '2026-10-08T00:00:00.000Z',
    recvTs: '2026-10-08T00:00:00.000Z',
    conditionId: '0xc1',
    tokenId: 'tk1',
    tickSize: 0.01,
    minOrderSize: 0,
  };
  const book = (bids: [number, number][], asks: [number, number][], ts = base.ts) => ({
    ...base,
    ts,
    bids,
    asks,
  });

  it('records a bid-side drop at a stationary price', () => {
    const prev = book([[0.33, 100]], [[0.34, 200]]);
    const next = book([[0.33, 60]], [[0.34, 200]], '2026-10-08T00:00:05.000Z');

    const drops = detectSizeDrops(prev, next);

    assert.equal(drops.length, 1);
    assert.equal(drops[0]?.side, 'BUY');
    assert.equal(drops[0]?.price, 0.33);
    assert.equal(drops[0]?.prevSize, 100);
    assert.equal(drops[0]?.nextSize, 60);
    assert.equal(drops[0]?.prevTs, base.ts);
    assert.equal(drops[0]?.ts, '2026-10-08T00:00:05.000Z');
    assert.equal(drops[0]?.bestBid, 0.33);
  });

  it('records an ask-side drop', () => {
    const drops = detectSizeDrops(
      book([[0.33, 100]], [[0.34, 200]]),
      book([[0.33, 100]], [[0.34, 20]]),
    );
    assert.equal(drops.length, 1);
    assert.equal(drops[0]?.side, 'SELL');
    assert.equal(drops[0]?.price, 0.34);
  });

  it('records both sides when both shrink in one interval', () => {
    const drops = detectSizeDrops(
      book([[0.33, 100]], [[0.34, 200]]),
      book([[0.33, 10]], [[0.34, 20]]),
    );
    assert.deepEqual(drops.map((d) => d.side), ['BUY', 'SELL']);
  });

  it('records nothing when sizes are unchanged', () => {
    assert.deepEqual(detectSizeDrops(book([[0.33, 100]], [[0.34, 200]]), book([[0.33, 100]], [[0.34, 200]])), []);
  });

  it('records nothing when sizes GROW, since only decreases are written', () => {
    // Documented in SizeDrop: recording increases would add ~360 part files/min
    // to a layout already writing ~540, for data the fill question does not need.
    assert.deepEqual(detectSizeDrops(book([[0.33, 10]], [[0.34, 20]]), book([[0.33, 100]], [[0.34, 200]])), []);
  });

  it('treats a level that disappeared entirely as a drop to zero', () => {
    // This is the irreducible ambiguity, not a bug: a removal and a fill are the
    // same observation. It is recorded rather than classified, on purpose.
    const drops = detectSizeDrops(
      book([[0.33, 100]], [[0.34, 200]]),
      book([], [[0.34, 200]]),
    );
    assert.equal(drops.length, 1);
    assert.equal(drops[0]?.nextSize, 0);
    assert.equal(drops[0]?.side, 'BUY');
  });

  it('ignores depth changes away from the best level', () => {
    // Only the touch can produce a fill, so interior changes are not candidates.
    const drops = detectSizeDrops(
      book([[0.33, 100], [0.32, 500]], [[0.34, 200], [0.35, 500]]),
      book([[0.33, 100], [0.32, 1]], [[0.34, 200], [0.35, 1]]),
    );
    assert.deepEqual(drops, []);
  });

  it('yields no drop for a side that was empty, while still reporting the other', () => {
    // The bid side has no best level in EITHER snapshot, so there is nothing to
    // shrink and nothing to report -- an empty side is not a drop to zero.
    const drops = detectSizeDrops(book([], [[0.34, 200]]), book([], [[0.34, 100]]));
    assert.deepEqual(drops.map((d) => d.side), ['SELL']);
  });

  it('records the old best level as dropped to zero when the best price moves', () => {
    // A best-price move REMOVES the prior best level, so this fires with nextSize
    // 0 on both sides. That is factually right rather than a double count: the
    // level genuinely no longer exists, and a removal alongside a price move is
    // the strongest fill evidence this feed produces. It is recorded, not
    // classified -- `detectTouches` and this detector are complementary and a
    // caller decides whether the two together mean one fill or two.
    const drops = detectSizeDrops(
      book([[0.33, 100]], [[0.34, 200]]),
      book([[0.31, 50]], [[0.36, 200]]),
    );
    assert.deepEqual(drops.map((d) => [d.side, d.price, d.prevSize, d.nextSize]), [
      ['BUY', 0.33, 100, 0],
      ['SELL', 0.34, 200, 0],
    ]);
  });
});
