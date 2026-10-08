import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePriceChanges, type ClobWsToken } from './clobWs.js';

const TOKENS: ReadonlyMap<string, ClobWsToken> = new Map([
  ['tk1', { conditionId: '0xc1', tokenId: 'tk1' }],
]);

const TS = '2026-10-08T12:00:00.000Z';

// Transcribed from a live read-only probe of
// wss://ws-subscriptions-clob.polymarket.com/ws/market on 2026-10-08.
const FRAME = {
  event_type: 'price_change',
  market: '0x16c63b7c',
  timestamp: '1791462965267',
  price_changes: [
    {
      asset_id: 'tk1',
      price: '0.54',
      size: '0',
      side: 'SELL',
      hash: 'abc123',
      best_bid: '0.41',
      best_ask: '0.42',
    },
  ],
};

describe('parsePriceChanges', () => {
  it('maps one entry onto a PriceChange with every field carried through', () => {
    const { changes, unparsed } = parsePriceChanges(FRAME, TOKENS, TS);

    assert.equal(unparsed, 0);
    assert.equal(changes.length, 1);
    const c = changes[0];
    assert.equal(c?.conditionId, '0xc1');
    assert.equal(c?.tokenId, 'tk1');
    assert.equal(c?.side, 'SELL');
    assert.equal(c?.price, 0.54);
    assert.equal(c?.size, 0, 'a size of 0 is a level REMOVAL, and must survive as 0');
    assert.equal(c?.bestBid, 0.41);
    assert.equal(c?.bestAsk, 0.42);
    assert.equal(c?.hash, 'abc123');
  });

  it('prefers the exchange timestamp over the fallback', () => {
    const { changes } = parsePriceChanges(FRAME, TOKENS, 'FALLBACK');
    assert.notEqual(changes[0]?.ts, 'FALLBACK');
  });

  it('falls back to the supplied ts when the frame has no usable timestamp', () => {
    const { changes } = parsePriceChanges({ ...FRAME, timestamp: 'nope' }, TOKENS, TS);
    assert.equal(changes[0]?.ts, TS);
  });

  it('skips an entry for an untracked token without counting it malformed', () => {
    const { changes, unparsed } = parsePriceChanges(
      { ...FRAME, price_changes: [{ ...FRAME.price_changes[0], asset_id: 'tk-nope' }] },
      TOKENS,
      TS,
    );
    assert.equal(changes.length, 0);
    assert.equal(unparsed, 0, 'a market we do not track is not a malformed feed');
  });

  it('counts an unusable entry as unparsed rather than dropping it silently', () => {
    const { changes, unparsed } = parsePriceChanges(
      {
        ...FRAME,
        price_changes: [
          { ...FRAME.price_changes[0], side: 'SIDEWAYS' },
          { ...FRAME.price_changes[0], price: 'not-a-number' },
          null,
          FRAME.price_changes[0],
        ],
      },
      TOKENS,
      TS,
    );
    assert.equal(unparsed, 3);
    assert.equal(changes.length, 1, 'the one usable entry still comes through');
  });

  it('returns nothing for a frame that is not a price-change frame', () => {
    for (const frame of [{}, { price_changes: 'nope' }, [], 'string']) {
      const { changes, unparsed } = parsePriceChanges(frame, TOKENS, TS);
      assert.equal(changes.length, 0, JSON.stringify(frame));
      assert.equal(unparsed, 0, JSON.stringify(frame));
    }
  });

  it('records a zero-size removal exactly, since that is what the feed sends', () => {
    // The 2026-10-08 live sample was 151 of 151 entries at size 0 — every event a
    // level removal. Rounding, defaulting or dropping those would destroy the
    // only thing the feed actually says.
    const { changes } = parsePriceChanges(
      { ...FRAME, price_changes: [{ ...FRAME.price_changes[0], size: '0' }] },
      TOKENS,
      TS,
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.size, 0);
  });
});