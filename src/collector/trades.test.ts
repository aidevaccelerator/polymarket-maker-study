import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BookSnapshot } from '../shared/schema.js';
import { detectTouches } from './trades.js';

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