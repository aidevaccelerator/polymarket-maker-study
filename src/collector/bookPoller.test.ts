import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BookSnapshot, QuoteTouch } from '../shared/schema.js';
import { BookPoller, booksByCondition } from './bookPoller.js';
import type { BookPollerDeps, RawBookBatchFetcher } from './bookPoller.js';
import type { TrackedMarket } from './gamma.js';

const MARKET: TrackedMarket = {
  conditionId: '0xc1',
  tokenId: 'tk1',
  category: 'Politics',
  question: 'Will it happen?',
  slug: 'will-it-happen',
};

const SECOND_MARKET: TrackedMarket = { ...MARKET, conditionId: '0xc2', tokenId: 'tk2' };
const THIRD_MARKET: TrackedMarket = { ...MARKET, conditionId: '0xc3', tokenId: 'tk3' };

// Shaped like the live CLOB response, transcribed from a read-only probe of
// https://clob.polymarket.com/book on 2026-10-07. Two details matter and both
// differ from what this fixture used to assert:
//
//  1. `timestamp` is a 13-digit millisecond STRING ("1791401045758"), not an
//     ISO string. That is the real format, and it routes through the
//     `/^\d+$/` branch of `normalizeTs` rather than `new Date()`. The old ISO
//     fixture covered the branch production does not use.
//  2. `bids` arrive ASCENDING and `asks` DESCENDING — the reverse of what
//     `parseBook` wants. `parseBook` re-sorts, so this now genuinely exercises
//     that re-sort instead of sorting already-sorted input.
//
// `market`, `neg_risk` and the other real keys are included because they are
// simply present upstream; `parseBook` ignores them, so they cost nothing and
// keep the fixture faithful. The timestamp is a fixed literal, never derived
// from the clock, so expectations stay deterministic.
const GOOD_BODY = {
  market: '0xc1',
  asset_id: 'tk1',
  timestamp: '1791401045758',
  hash: '0xbookhash',
  bids: [
    { price: '0.47', size: '40' },
    { price: '0.48', size: '30' },
    { price: '0.49', size: '100' },
  ],
  // Descending, as the live endpoint sends them.
  asks: [
    { price: '0.53', size: '300' },
    { price: '0.52', size: '150' },
    { price: '0.51', size: '200' },
  ],
  tick_size: '0.01',
  min_order_size: '5',
  neg_risk: false,
  last_trade_price: '0.50',
};

const EMPTY_BODY = { ...GOOD_BODY, bids: [], asks: [] };

// One entry per `parseBook` failure path. Each is a plausible upstream shape
// change (renamed key, changed type, added nesting) rather than random garbage,
// because that is the case this file exists to cover.
const BODY_NOT_OBJECT = ['bids', 'asks'];
const BIDS_NOT_ARRAY = { bids: { '0': { price: '0.49', size: '100' } }, asks: [] };
const ASKS_NOT_ARRAY = { bids: [], asks: null };
// A single bad level poisons the whole side, even alongside good levels.
const ONE_BAD_PRICE = { bids: [{ price: '0.49', size: '100' }, { price: 'n/a', size: '5' }], asks: [] };
const ONE_BAD_SIZE = { bids: [], asks: [{ price: '0.51', size: '' }] };

interface RecordedError {
  readonly conditionId: string;
  readonly message: string;
}

interface Recorded {
  readonly books: BookSnapshot[];
  readonly touches: QuoteTouch[];
  readonly errors: RecordedError[];
}

function recorder(): { readonly deps: BookPollerDeps; readonly recorded: Recorded } {
  const recorded: Recorded = { books: [], touches: [], errors: [] };
  const deps: BookPollerDeps = {
    onBook: (book) => void recorded.books.push(book),
    onTouch: (touch) => void recorded.touches.push(touch),
    onError: (market, err) => {
      recorded.errors.push({
        conditionId: market.conditionId,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  };
  return { deps, recorded };
}

// `bodies` is a queue: each poll takes the next entry, and the LAST entry repeats
// once the queue is spent, so "the same response on every poll" is a single push.
// No network is involved — the injected `RawBookFetcher` returns raw bodies, so
// `parseBook` still runs for real inside the poller.
function harness(markets: readonly TrackedMarket[] = [MARKET]): {
  readonly poller: BookPoller;
  readonly recorded: Recorded;
  readonly bodies: unknown[];
} {
  const { deps, recorded } = recorder();
  const bodies: unknown[] = [];
  const fetch: RawBookBatchFetcher = async (requested) => {
    const out = new Map<string, unknown>();
    for (const market of requested) {
      const body = bodies.length > 1 ? bodies.shift() : bodies[0];
      if (body !== undefined) out.set(market.conditionId, body);
    }
    return out;
  };
  return { poller: new BookPoller(markets, deps, fetch), recorded, bodies };
}

describe('BookPoller /book parsing', () => {
  it('reports a response body that is not a JSON object and writes no book', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(BODY_NOT_OBJECT);

    await poller.pollAll();

    assert.deepEqual(recorded.books, [], 'a malformed book must never be written');
    assert.equal(recorded.errors.length, 1);
    assert.equal(recorded.errors[0]?.conditionId, MARKET.conditionId);
    assert.equal(
      recorded.errors[0]?.message,
      'malformed /book response: body is not a JSON object',
    );
  });

  it('reports a response whose bids is not an array, and names that side', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(BIDS_NOT_ARRAY);

    await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.equal(recorded.errors.length, 1);
    assert.equal(
      recorded.errors[0]?.message,
      'malformed /book response: bids is not an array of {price, size} levels',
    );
  });

  it('reports a response whose asks is not an array, and names that side', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(ASKS_NOT_ARRAY);

    await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.equal(recorded.errors.length, 1);
    assert.equal(
      recorded.errors[0]?.message,
      'malformed /book response: asks is not an array of {price, size} levels',
    );
  });

  it('reports a book where one level has a non-numeric price, discarding the good levels too', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(ONE_BAD_PRICE);

    await poller.pollAll();

    assert.deepEqual(recorded.books, [], 'one bad level must not yield a partial book');
    assert.equal(recorded.errors.length, 1);
  });

  it('reports a book where one level has a non-numeric size', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(ONE_BAD_SIZE);

    await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.equal(recorded.errors.length, 1);
  });

  // Regression guard for the distinction the fix introduces: EMPTY is not
  // MALFORMED. `bids: []` has zero levels, not a broken level, so it is a valid
  // snapshot, is written, and is not an error.
  it('writes an empty-but-valid book and reports nothing', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(EMPTY_BODY);

    await poller.pollAll();

    assert.deepEqual(recorded.errors, [], 'an empty book is not an error');
    assert.equal(recorded.books.length, 1, 'an empty book is still written');
    assert.deepEqual(recorded.books[0]?.bids, []);
    assert.deepEqual(recorded.books[0]?.asks, []);
  });

  it('treats an empty book as a snapshot, so a later non-empty book still yields a touch', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(EMPTY_BODY, GOOD_BODY, { ...GOOD_BODY, asks: [{ price: '0.53', size: '400' }] });

    await poller.pollAll(); // empty: written, becomes the prior book
    await poller.pollAll();
    await poller.pollAll(); // best ask lifted 0.51 -> 0.53

    assert.deepEqual(recorded.errors, []);
    assert.equal(recorded.books.length, 3);
    assert.equal(recorded.touches.length, 1);
    assert.equal(recorded.touches[0]?.side, 'BUY');
    assert.equal(recorded.touches[0]?.price, 0.51);
  });

  // The live endpoint sends bids ASCENDING and asks DESCENDING, so GOOD_BODY now
  // arrives in exactly that order and this asserts the emitted snapshot is
  // re-sorted: bids descending, asks ascending. Sorting already-sorted input was
  // a no-op, so the re-sort was never actually exercised.
  it('re-sorts the reversed level order the live endpoint sends, best levels first', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(GOOD_BODY);

    await poller.pollAll();

    assert.deepEqual(recorded.errors, []);
    assert.equal(recorded.books.length, 1);
    const book = recorded.books[0];
    // levels[0] is what the liquidity filter reads, so ordering is load-bearing.
    assert.deepEqual(book?.bids[0], [0.49, 100]);
    assert.deepEqual(book?.asks[0], [0.51, 200]);
    // The whole side, not just the head, so a partial sort cannot pass.
    assert.deepEqual(book?.bids, [
      [0.49, 100],
      [0.48, 30],
      [0.47, 40],
    ]);
    assert.deepEqual(book?.asks, [
      [0.51, 200],
      [0.52, 150],
      [0.53, 300],
    ]);
    assert.equal(book?.tickSize, 0.01);
    assert.equal(book?.minOrderSize, 5);
    // The millisecond-string timestamp is what production reads.
    assert.equal(book?.ts, '2026-10-07T19:24:05.758Z');
  });

  it('reports a transport failure on every poll, unsuppressed', async () => {
    // Deliberate scope boundary: rate limiting covers malformed RESPONSES only.
    // A thrown fetch is unchanged pre-existing behaviour.
    const { deps, recorded } = recorder();
    let calls = 0;
    const fetch: RawBookBatchFetcher = async () => {
      calls += 1;
      throw new Error(`network error ${calls}`);
    };
    const poller = new BookPoller([MARKET], deps, fetch);

    await poller.pollAll();
    await poller.pollAll();
    await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.equal(recorded.errors.length, 3);
    assert.equal(recorded.errors[2]?.message, 'network error 3');
  });
});

describe('BookPoller malformed-response rate limit', () => {
  it('reports a persistently malformed condition once, not once per poll', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(BIDS_NOT_ARRAY);

    for (let poll = 0; poll < 4; poll += 1) await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.equal(recorded.errors.length, 1, 'repeats must be suppressed, not logged every 5s');
  });

  it('suppresses the first failure only after recording it', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(ONE_BAD_PRICE);

    await poller.pollAll();

    assert.equal(recorded.errors.length, 1, 'the FIRST occurrence must always be recorded');
    assert.match(recorded.errors[0]?.message ?? '', /^malformed \/book response/);
  });

  it('reports a failure again once a book has parsed successfully in between', async () => {
    const { poller, recorded, bodies } = harness();
    bodies.push(BIDS_NOT_ARRAY, BIDS_NOT_ARRAY, GOOD_BODY, BIDS_NOT_ARRAY);

    await poller.pollAll(); // 1st failure: reported
    await poller.pollAll(); // still failing: suppressed
    assert.equal(recorded.errors.length, 1);

    await poller.pollAll(); // recovers: book written, suppression cleared
    assert.equal(recorded.books.length, 1);
    assert.equal(recorded.errors.length, 1);

    await poller.pollAll(); // breaks again: a NEW incident, so reported
    assert.equal(recorded.errors.length, 2, 'a fresh failure after recovery must be reported');
    assert.equal(recorded.books.length, 1);
  });

  it('does not let one failing condition suppress another', async () => {
    const { deps, recorded } = recorder();
    const fetch: RawBookBatchFetcher = async (requested) =>
      new Map(
        requested.map((m) => [
          m.conditionId,
          m.conditionId === MARKET.conditionId ? BIDS_NOT_ARRAY : ASKS_NOT_ARRAY,
        ]),
      );
    const poller = new BookPoller([MARKET, SECOND_MARKET], deps, fetch);

    await poller.pollAll();
    await poller.pollAll();

    // A single global suppression flag would report only the first of these.
    assert.deepEqual(
      recorded.errors.map((e) => e.conditionId).sort(),
      ['0xc1', '0xc2'],
      'each failing condition is reported once, independently',
    );
    assert.deepEqual(recorded.books, []);
  });

  it('keeps every snapshot that a touch references already written', async () => {
    // The referential link src/analysis/takerShare.ts depends on: a touch names
    // the bookTs it was measured against, and that snapshot must be in the dataset.
    const { poller, recorded, bodies } = harness();
    bodies.push(GOOD_BODY, { ...GOOD_BODY, asks: [{ price: '0.53', size: '400' }] });

    await poller.pollAll();
    await poller.pollAll();

    const writtenTs = recorded.books.map((b) => b.ts);
    assert.equal(recorded.touches.length, 1);
    const bookTs = recorded.touches[0]?.bookTs;
    assert.ok(bookTs !== undefined);
    assert.equal(writtenTs.includes(bookTs), true, `bookTs ${bookTs} was never written`);
  });
});

// The measured sweep cost. These pin the SHAPE and the COUNTING, never a
// wall-clock value: duration is inherently timing-dependent, so asserting a
// number here would be flaky. The injected-fetcher seam above keeps this
// hermetic — no network, no timers.
describe('BookPoller observed sweep cost', () => {
  it('reports null before any sweep has run, never 0', () => {
    const { poller } = harness();

    // The dry-run / empty-universe / discovery-failure paths construct no poller
    // and report null. A 0 would read as a healthy instantaneous sweep.
    assert.equal(poller.sweepStats(), null, 'no sweep yet must be null, not a zero-length sweep');
  });

  it('counts exactly one completed sweep per pollAll', async () => {
    const { poller, bodies } = harness();
    bodies.push(GOOD_BODY);

    assert.equal(poller.sweepStats(), null);
    await poller.pollAll();
    assert.equal(poller.sweepStats()?.sweeps, 1);
    await poller.pollAll();
    await poller.pollAll();
    assert.equal(poller.sweepStats()?.sweeps, 3, 'one sweep per completed pass, not per market');
  });

  it('reports finite, non-negative durations with max >= mean', async () => {
    const { poller, bodies } = harness();
    bodies.push(GOOD_BODY, { ...GOOD_BODY, asks: [{ price: '0.53', size: '400' }] });

    await poller.pollAll();
    await poller.pollAll();

    const stats = poller.sweepStats();
    assert.ok(stats !== null);
    assert.ok(Number.isFinite(stats.meanMs), `meanMs must be finite, got ${stats.meanMs}`);
    assert.ok(Number.isFinite(stats.maxMs), `maxMs must be finite, got ${stats.maxMs}`);
    assert.ok(stats.meanMs >= 0, `meanMs must be non-negative, got ${stats.meanMs}`);
    assert.ok(stats.maxMs >= 0, `maxMs must be non-negative, got ${stats.maxMs}`);
    assert.ok(
      stats.maxMs >= stats.meanMs,
      `the slowest sweep cannot be below the mean (max ${stats.maxMs} < mean ${stats.meanMs})`,
    );
  });

  it('counts a multi-market pass as one sweep that fetched every market', async () => {
    // The measurement only means something because one sweep covers every market
    // in a single request: a sweep over two markets must be counted once while
    // fetching both. Only COUNT is asserted — durations are timing-dependent and
    // are never compared to a fixed figure.
    const { deps, recorded } = recorder();
    const fetch: RawBookBatchFetcher = async (requested) =>
      new Map(requested.map((m) => [m.conditionId, GOOD_BODY]));
    const poller = new BookPoller([MARKET, SECOND_MARKET], deps, fetch);

    await poller.pollAll();

    assert.equal(poller.sweepStats()?.sweeps, 1, 'two markets are one sweep, not two');
    assert.equal(recorded.books.length, 2, 'both markets are fetched inside that one sweep');
  });

  it('does not count a guard-dropped reentrant call as a sweep', async () => {
    // `pollAll` returns immediately while a sweep is in flight, so the dropped
    // call must not be measured — counting it would inflate `sweeps` and drag
    // the mean down with zero-length samples.
    const { deps } = recorder();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: RawBookBatchFetcher = async () => {
      await gate;
      return new Map([[MARKET.conditionId, GOOD_BODY]]);
    };
    const poller = new BookPoller([MARKET], deps, fetch);

    const inFlight = poller.pollAll();
    await poller.pollAll(); // reentrant: returns at once, `polling` is still held
    assert.equal(poller.sweepStats(), null, 'the dropped call must not register as a sweep');

    release();
    await inFlight;

    assert.equal(poller.sweepStats()?.sweeps, 1, 'only the real sweep is counted');
  });
});

describe('BookPoller multi-book batching', () => {
  it('fetches every market in ONE request per sweep', async () => {
    const { deps, recorded } = recorder();
    let calls = 0;
    const fetch: RawBookBatchFetcher = async (requested) => {
      calls += 1;
      return new Map(requested.map((m) => [m.conditionId, GOOD_BODY]));
    };
    const poller = new BookPoller([MARKET, SECOND_MARKET, THIRD_MARKET], deps, fetch);

    await poller.pollAll();

    assert.equal(calls, 1, 'a sweep is one batched request, not one per market');
    assert.equal(recorded.books.length, 3, 'all three markets are still written');
  });

  it('reports only the omitted market, and still writes the ones present', async () => {
    // The endpoint omits tokens that have never traded. That must cost ONE
    // market's snapshot, not the whole sweep — the property the old sequential
    // sweep had for free and a naive batch port would silently lose.
    const { deps, recorded } = recorder();
    const fetch: RawBookBatchFetcher = async () =>
      new Map([
        [MARKET.conditionId, GOOD_BODY],
        [THIRD_MARKET.conditionId, GOOD_BODY],
      ]);
    const poller = new BookPoller([MARKET, SECOND_MARKET, THIRD_MARKET], deps, fetch);

    await poller.pollAll();

    assert.equal(recorded.books.length, 2, 'a present market is unaffected by a missing sibling');
    assert.equal(recorded.errors.length, 1);
    assert.equal(recorded.errors[0]?.conditionId, SECOND_MARKET.conditionId);
    assert.match(recorded.errors[0]?.message ?? '', /omitted from the multi-book response/);
  });

  it('reports EVERY market when the batch request itself fails', async () => {
    const { deps, recorded } = recorder();
    const fetch: RawBookBatchFetcher = async () => {
      throw new Error('batch request failed');
    };
    const poller = new BookPoller([MARKET, SECOND_MARKET], deps, fetch);

    await poller.pollAll();

    assert.deepEqual(recorded.books, []);
    assert.deepEqual(
      recorded.errors.map((e) => e.conditionId).sort(),
      ['0xc1', '0xc2'],
      'a failed request loses every market, and says so for each',
    );
  });
});

describe('booksByCondition response matching', () => {
  const MARKETS = [MARKET, SECOND_MARKET];

  it('matches by asset_id even when the response order is reversed', () => {
    const body = [
      { ...GOOD_BODY, asset_id: 'tk2', market: '0xc2' },
      { ...GOOD_BODY, asset_id: 'tk1', market: '0xc1' },
    ];
    const out = booksByCondition(body, MARKETS);
    assert.equal((out.get('0xc1') as { market: string }).market, '0xc1');
    assert.equal((out.get('0xc2') as { market: string }).market, '0xc2');
  });

  it('omits a market the response leaves out, rather than shifting the rest', () => {
    const out = booksByCondition([{ ...GOOD_BODY, asset_id: 'tk2' }], MARKETS);
    assert.equal(out.has('0xc2'), true);
    assert.equal(out.has('0xc1'), false);
  });

  it('drops an entry whose asset_id no tracked market claims', () => {
    const out = booksByCondition([{ ...GOOD_BODY, asset_id: 'tk-unknown' }], MARKETS);
    assert.equal(out.size, 0, 'an unclaimed token must not be attributed to any market');
  });

  it('skips entries that are not objects and entries with no string asset_id', () => {
    const out = booksByCondition(
      [null, 42, { ...GOOD_BODY, asset_id: 7 }, { ...GOOD_BODY, asset_id: 'tk1' }],
      MARKETS,
    );
    assert.equal(out.size, 1);
    assert.equal(out.has('0xc1'), true);
  });

  it('returns an empty map when the response is not an array', () => {
    assert.equal(booksByCondition({ books: [] }, MARKETS).size, 0);
  });
});
