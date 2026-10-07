import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  ALLOWED_CATEGORIES,
  MAX_PROB,
  MIN_LIQUIDITY_USD,
  MIN_PROB,
  MIN_SPREAD_TICKS,
} from '../shared/config.js';
import type { PageDelay, RawJsonFetcher } from './categories.js';
import { classifyMarket, discoverUniverse } from './gamma.js';
import type { DiscoverResult, UniverseCandidate } from './gamma.js';

function candidate(overrides: Partial<UniverseCandidate> = {}): UniverseCandidate {
  return {
    conditionId: 'c1',
    tokenIds: ['tYes', 'tNo'],
    outcomes: ['Yes', 'No'],
    category: 'Politics',
    liquidityNum: 100_000,
    active: true,
    closed: false,
    outcomePrices: [0.5, 0.5],
    lastTradePrice: 0.5,
    bestBid: 0.49,
    bestAsk: 0.51,
    question: 'q',
    slug: 's',
    ...overrides,
  };
}

test('accepts a liquid, mid-range, politics market', () => {
  const result = classifyMarket(candidate());
  assert.equal(result.accept, true);
  if (result.accept) assert.equal(result.market.tokenId, 'tYes');
});

test('rejects a disallowed category', () => {
  assert.deepEqual(classifyMarket(candidate({ category: 'Sports' })), {
    accept: false,
    reason: 'category',
  });
});

test('rejects thin liquidity', () => {
  assert.deepEqual(classifyMarket(candidate({ liquidityNum: 100 })), {
    accept: false,
    reason: 'liquidity',
  });
});

test('rejects out-of-range low probability', () => {
  assert.deepEqual(classifyMarket(candidate({ outcomePrices: [0.2, 0.8] })), {
    accept: false,
    reason: 'probability',
  });
});

test('rejects out-of-range high probability', () => {
  assert.deepEqual(classifyMarket(candidate({ outcomePrices: [0.8, 0.2] })), {
    accept: false,
    reason: 'probability',
  });
});

// ── discoverUniverse over an injected raw body ──
//
// The fetcher returns the UNPARSED response body, so URL construction, parsing,
// tag-to-category resolution, every filter, de-duplication and the accept/reject
// accounting all execute for real below — the seam sits below the parsing, per the
// `RawBookFetcher` precedent in b7a7b2d. No network anywhere below.

const COND_A = '0x5f6a1c0e9b3d4a7c8e2f1b0d9a8c7e6f5d4c3b2a1e0f9d8c7b6a5f4e3d2c1b0a9';
const YES_TOKEN = '71321045679252212594626385532706912750332778571942532289631379312455583992563';
const NO_TOKEN = '52114355701245095910266531395298161156196860086392281634433540935860181887680';

// Real Gamma event tags carry {id, label, slug}.
const POLITICS_TAG = { id: '484', label: ALLOWED_CATEGORIES[0], slug: 'politics' };
const SPORTS_TAG = { id: '2032', label: 'Sports', slug: 'sports' };

// gamma.ts encodes "one tick" as MIN_SPREAD_TICKS x an assumed 0.01 tick, and that
// tick is module-private — so the rule is mirrored here from the public constant.
const ONE_TICK = MIN_SPREAD_TICKS * 0.01;

const noDelay: PageDelay = async () => {};

// A live Gamma `/markets` record, transcribed from a read-only probe of
// https://gamma-api.polymarket.com/markets on 2026-10-07. Four details are
// load-bearing, and each differs from a convenient idealisation:
//
//  1. `clobTokenIds`, `outcomes` and `outcomePrices` arrive as JSON-ENCODED
//     STRINGS, not arrays. Both forms parse, but the string form is what production
//     receives, so it is the form the accepted-market fixture uses.
//  2. `category` is `null`. That is precisely why the category is resolved from the
//     parent EVENT's `tags[]` — see the empty-universe tests below.
//  3. `bids`/`asks` are arrays of OBJECTS with string `price`/`size`. Nothing on this
//     path reads them, so they are inert here; they are kept because a fixture that
//     invents a shape is a fixture that stops resembling the API.
//  4. Real records carry many more fields than this path reads (`id`, `volumeNum`,
//     `orderMinSize`, timestamps). Including them keeps the fixture honest about the
//     input being an entire API record rather than a purpose-built object.
function liveMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '507019',
    question: 'Will the Fed cut the federal funds rate in December 2026?',
    slug: 'fed-december-2026-rate-decision',
    conditionId: COND_A,
    clobTokenIds: `["${YES_TOKEN}","${NO_TOKEN}"]`,
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.42","0.58"]',
    lastTradePrice: 0.42,
    bestBid: 0.41,
    bestAsk: 0.43,
    liquidityNum: 184_320.55,
    volumeNum: 2_451_180.1,
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    enableOrderBook: true,
    category: null,
    orderPriceMinTickSize: 0.01,
    orderMinSize: 5,
    createdAt: '2026-09-30T14:02:11.000Z',
    endDate: '2026-12-31T23:59:59.000Z',
    bids: [
      { price: '0.41', size: '2500' },
      { price: '0.40', size: '8100' },
    ],
    asks: [
      { price: '0.43', size: '1900' },
      { price: '0.44', size: '6400' },
    ],
    ...overrides,
  };
}

function gammaEvent(tags: readonly unknown[], conditionIds: readonly string[]): unknown {
  return {
    id: '184023',
    ticker: 'fed-december-2026',
    slug: 'fed-december-2026',
    title: 'Fed December 2026 rate decision',
    closed: false,
    active: true,
    tags,
    markets: conditionIds.map((conditionId, i) => ({ conditionId, id: String(507_019 + i) })),
  };
}

// `events` and `markets` are independent queues, each repeating its LAST entry once
// spent, so "every page is full" is a single push per side. URLs are recorded on
// both sides because `discoverUniverse` requests /events and /markets through the
// one injected fetcher, and the two are independently worth asserting.
function routed(events: readonly unknown[], markets: readonly unknown[]): {
  readonly fetch: RawJsonFetcher;
  readonly eventUrls: string[];
  readonly marketUrls: string[];
} {
  const eventUrls: string[] = [];
  const marketUrls: string[] = [];
  const eventQueue = [...events];
  const marketQueue = [...markets];
  const fetch: RawJsonFetcher = async (url) => {
    if (url.includes('/events')) {
      eventUrls.push(url);
      return eventQueue.length > 1 ? eventQueue.shift() : eventQueue[0];
    }
    marketUrls.push(url);
    return marketQueue.length > 1 ? marketQueue.shift() : marketQueue[0];
  };
  return { fetch, eventUrls, marketUrls };
}

function rejectedTotal(rejected: Readonly<Record<string, number>>): number {
  return Object.values(rejected).reduce((a, b) => a + b, 0);
}

function conditionIdsOf(rows: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const conditionId = (row as { conditionId?: unknown }).conditionId;
    if (typeof conditionId === 'string') out.push(conditionId);
  }
  return out;
}

// One market page against one parent event, then an empty page — which is how a
// real scan ends, so the scan stops after page 1 and `seen` equals the fixture size.
// Everything a test varies — the market rows, the event's tags, which conditions the
// event indexes, the universe cap — is an argument, so no fixture below has to
// restate the harness.
async function discover(opts: {
  readonly markets: readonly unknown[];
  readonly tags?: readonly unknown[];
  readonly indexed?: readonly string[];
  readonly maxMarkets?: number;
}): Promise<DiscoverResult> {
  const { fetch } = routed(
    [[gammaEvent(opts.tags ?? [POLITICS_TAG], opts.indexed ?? conditionIdsOf(opts.markets))]],
    [opts.markets, []],
  );
  return discoverUniverse({ maxMarkets: opts.maxMarkets ?? 30, fetch, pageDelay: noDelay });
}

describe('discoverUniverse over an injected body', () => {
  it('accepts a well-formed market and maps every tracked field', async () => {
    const result = await discover({ markets: [liveMarket()] });

    assert.deepEqual(result.markets, [
      {
        conditionId: COND_A,
        tokenId: YES_TOKEN,
        category: ALLOWED_CATEGORIES[0],
        question: 'Will the Fed cut the federal funds rate in December 2026?',
        slug: 'fed-december-2026-rate-decision',
      },
    ]);
    assert.equal(result.seen, 1);
    assert.equal(result.unparseable, 0);
  });

  it('resolves the category from the parent event tag, not from the market row', async () => {
    // The market row's `category` is null in this fixture, so the accepted category
    // can only have come from the event's `tags[]`. If that resolution broke, every
    // market would reject on `category` and the universe would come back empty.
    const result = await discover({ markets: [liveMarket()], indexed: [COND_A] });

    assert.equal(result.markets.length, 1);
    assert.equal(result.markets[0]?.category, ALLOWED_CATEGORIES[0]);
    assert.equal(result.rejected.category, 0);
  });

  it('prefers a category Gamma did put on the market row over the event index', async () => {
    // Documented precedence: the direct field wins if it is ever populated, which
    // makes this index a fallback rather than the only source.
    const result = await discover({ markets: [liveMarket({ category: ALLOWED_CATEGORIES[1] })] });

    assert.equal(result.markets[0]?.category, ALLOWED_CATEGORIES[1]);
    assert.notEqual(ALLOWED_CATEGORIES[1], POLITICS_TAG.label, 'the two sources must disagree');
  });

  it('rejects a market whose parent event carries no allowed category tag', async () => {
    const result = await discover({ markets: [liveMarket()], tags: [SPORTS_TAG] });

    assert.deepEqual(result.markets, []);
    assert.equal(result.rejected.category, 1);
    assert.equal(result.seen, 1);
  });

  it('rejects every market when the category index does not cover it', async () => {
    // The whole-universe-empty failure: an index gap rejects on `category`. It does
    // NOT fall back to another tag, or to the slug, or to an empty-string category.
    const result = await discover({ markets: [liveMarket()], indexed: [] });

    assert.deepEqual(result.markets, []);
    assert.equal(result.rejected.category, 1);
  });

  it('rejects a YES price outside the configured band', async () => {
    const low = await discover({ markets: [liveMarket({ outcomePrices: '["0.21","0.79"]' })] });
    const high = await discover({ markets: [liveMarket({ outcomePrices: '["0.79","0.21"]' })] });

    assert.deepEqual(low.markets, []);
    assert.equal(low.rejected.probability, 1);
    assert.deepEqual(high.markets, []);
    assert.equal(high.rejected.probability, 1);
  });

  it('treats MIN_PROB and MAX_PROB as inclusive bounds', async () => {
    const atMin = await discover({
      markets: [liveMarket({ outcomePrices: `["${MIN_PROB}","0.7"]` })],
    });
    const atMax = await discover({
      markets: [liveMarket({ outcomePrices: `["${MAX_PROB}","0.3"]` })],
    });

    assert.equal(atMin.markets.length, 1, 'MIN_PROB itself passes: the rule is `< MIN_PROB`');
    assert.equal(atMax.markets.length, 1, 'MAX_PROB itself passes: the rule is `> MAX_PROB`');
  });

  it('rejects liquidity below the floor and accepts it at the floor', async () => {
    const below = await discover({ markets: [liveMarket({ liquidityNum: MIN_LIQUIDITY_USD - 1 })] });
    const at = await discover({ markets: [liveMarket({ liquidityNum: MIN_LIQUIDITY_USD })] });

    assert.deepEqual(below.markets, []);
    assert.equal(below.rejected.liquidity, 1);
    assert.equal(at.markets.length, 1, 'the floor itself is liquid enough: the rule is `<`');
  });

  it('rejects a quoted spread narrower than one tick', async () => {
    const crossed = await discover({ markets: [liveMarket({ bestBid: 0.5, bestAsk: 0.5 })] });
    const oneTick = await discover({ markets: [liveMarket({ bestBid: 0.49, bestAsk: 0.5 })] });

    assert.deepEqual(crossed.markets, []);
    assert.equal(crossed.rejected.spread, 1, 'a zero-width book is not quotable');
    assert.equal(oneTick.markets.length, 1, 'one tick is the narrowest spread that passes');
    assert.ok(
      0.5 - 0.49 >= ONE_TICK,
      `fixture premise: a one-cent spread must satisfy MIN_SPREAD_TICKS x tick (${ONE_TICK})`,
    );
  });

  it('skips the spread rule when the market reports no two-sided quote', async () => {
    const result = await discover({ markets: [liveMarket({ bestBid: null, bestAsk: null })] });

    assert.equal(result.markets.length, 1, 'an unquoted market cannot fail a spread rule');
    assert.equal(result.rejected.spread, 0);
  });

  it('rejects a closed or an inactive market before any other filter', async () => {
    const closed = await discover({ markets: [liveMarket({ closed: true })] });
    const inactive = await discover({ markets: [liveMarket({ active: false })] });

    assert.deepEqual(closed.markets, []);
    assert.equal(closed.rejected.closed, 1);
    assert.deepEqual(inactive.markets, []);
    assert.equal(inactive.rejected.closed, 1);
  });

  it('rejects a market carrying no clob token ids', async () => {
    const result = await discover({ markets: [liveMarket({ clobTokenIds: '[]' })] });

    assert.deepEqual(result.markets, []);
    assert.equal(result.rejected.no_yes_token, 1);
  });

  it('picks the YES token by outcome label, not by array position', async () => {
    // Gamma orders [YES, NO] for binary markets, but the code resolves the index
    // from the label — so a reversed row must still yield the same token.
    const reversed = liveMarket({
      outcomes: '["No","Yes"]',
      clobTokenIds: `["${NO_TOKEN}","${YES_TOKEN}"]`,
      outcomePrices: '["0.58","0.42"]',
    });

    const result = await discover({ markets: [reversed] });

    assert.equal(result.markets.length, 1);
    assert.equal(result.markets[0]?.tokenId, YES_TOKEN);
  });

  it('accepts the array form of the token fields as well as the JSON-string form', async () => {
    const asArrays = liveMarket({
      clobTokenIds: [YES_TOKEN, NO_TOKEN],
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.42, 0.58],
    });

    const result = await discover({ markets: [asArrays] });

    assert.equal(result.markets.length, 1, 'the array form must not become `unparseable`');
  });

  // The load-bearing accounting claim: a record that a filter rejected is COUNTED as
  // a rejection, not quietly dropped. If any of these buckets stopped summing to
  // `seen`, the run would look smaller than it was and nobody would be able to tell.
  it('accounts for every record it saw, without dropping filter rejections', async () => {
    const markets = [
      liveMarket({ conditionId: '0xaccept' }),
      liveMarket({ conditionId: '0xlow', outcomePrices: '["0.21","0.79"]' }),
      liveMarket({ conditionId: '0xhigh', outcomePrices: '["0.79","0.21"]' }),
      liveMarket({ conditionId: '0xthin', liquidityNum: 10 }),
      liveMarket({ conditionId: '0xtokenless', clobTokenIds: '[]' }),
      liveMarket({ conditionId: '0xcrossed', bestBid: 0.5, bestAsk: 0.5 }),
      // Neither of these is a rejection: they are records the parser cannot read.
      liveMarket({ conditionId: '' }),
      'not an object at all',
    ];

    const result = await discover({
      markets,
      indexed: ['0xaccept', '0xlow', '0xhigh', '0xthin', '0xtokenless', '0xcrossed'],
    });

    assert.equal(result.seen, 8);
    assert.equal(result.markets.length, 1);
    assert.equal(result.markets[0]?.conditionId, '0xaccept');
    assert.equal(result.unparseable, 2);
    assert.deepEqual(result.rejected, {
      closed: 0,
      category: 0,
      liquidity: 1,
      probability: 2,
      spread: 1,
      no_yes_token: 1,
    });

    const rejectedTotal = Object.values(result.rejected).reduce((a, b) => a + b, 0);
    assert.equal(
      result.markets.length + rejectedTotal + result.unparseable,
      result.seen,
      'every record seen is tracked, rejected for a named reason, or unparseable',
    );
  });

  it('bounds the universe at maxMarkets and keeps the most liquid', async () => {
    const markets = [
      liveMarket({ conditionId: '0xa', liquidityNum: 100_000 }),
      liveMarket({ conditionId: '0xb', liquidityNum: 300_000 }),
      liveMarket({ conditionId: '0xc', liquidityNum: 200_000 }),
      liveMarket({ conditionId: '0xd', liquidityNum: 50_000 }),
    ];

    const result = await discover({ markets, maxMarkets: 2 });

    assert.deepEqual(result.markets.map((m) => m.conditionId), ['0xb', '0xc']);
    assert.equal(result.seen, 4, 'the cap bounds the universe, not the scan of this page');
  });

  it('stops scanning as soon as the universe is full', async () => {
    const { fetch, marketUrls, eventUrls } = routed(
      [[gammaEvent([POLITICS_TAG], ['0xa', '0xb', '0xc'])]],
      [
        [
          liveMarket({ conditionId: '0xa' }),
          liveMarket({ conditionId: '0xb' }),
          liveMarket({ conditionId: '0xc' }),
        ],
      ],
    );

    const result = await discoverUniverse({ maxMarkets: 2, fetch, pageDelay: noDelay });

    assert.equal(result.markets.length, 2);
    assert.equal(marketUrls.length, 1, 'page 1 filled the universe, so no second page is requested');
    assert.equal(eventUrls.length, 40, 'the category index is built once per run, before the scan');
  });

  it('stops at the production scan cap rather than paging forever', async () => {
    // Nothing is accepted here, so the scan can never fill and the hard cap is the
    // only thing that ends it: offsets 0..900, ten pages of 100, 1000 records. The
    // canned body always returns a full page, so an unbounded loop would run forever.
    const { fetch, marketUrls, eventUrls } = routed(
      [[gammaEvent([POLITICS_TAG], [])]],
      [[liveMarket({ conditionId: '0xnever' })]],
    );

    const result = await discoverUniverse({ maxMarkets: 30, fetch, pageDelay: noDelay });

    assert.equal(marketUrls.length, 10, 'ten pages, then the 1000-record cap ends the scan');
    assert.equal(eventUrls.length, 40, 'the category index walks its own 40-page cap');
    assert.equal(result.seen, 10);
    assert.deepEqual(result.markets, []);
    assert.equal(result.rejected.category, 10, 'every scanned record is accounted for');
    assert.equal(
      marketUrls[0],
      'https://gamma-api.polymarket.com/markets?closed=false&active=true' +
        `&liquidity_num_min=${MIN_LIQUIDITY_USD}&limit=100&offset=0`,
    );
    assert.ok(marketUrls[9]?.endsWith('&offset=900'), `unexpected last offset: ${marketUrls[9]}`);
  });

  it('ends the scan on an empty page and on a body that is not an array', async () => {
    const emptyPage = routed([[gammaEvent([POLITICS_TAG], [])]], [[], []]);
    const notAnArray = routed([[gammaEvent([POLITICS_TAG], [])]], [{ error: 'not a page' }]);

    const empty = await discoverUniverse({ maxMarkets: 30, ...emptyPage, pageDelay: noDelay });
    const bad = await discoverUniverse({ maxMarkets: 30, ...notAnArray, pageDelay: noDelay });

    assert.deepEqual(empty.markets, []);
    assert.equal(empty.seen, 0, 'an empty page contributes nothing to `seen`');
    assert.deepEqual(bad.markets, []);
    assert.equal(bad.seen, 0, 'a non-array body ends the scan without being counted');
  });

  it('pauses between pages in both layers, with the production delay value', async () => {
    // Asserts the constant handed to `pageDelay`, never elapsed time: the pause is
    // wall-clock, and a timing assertion would be flaky and would say nothing about
    // correctness. 49 = 40 event pages + 9 market pages; the market loop checks its
    // cap before pausing, so the 10th page contributes no pause.
    const delays: number[] = [];
    const pageDelay: PageDelay = async (ms) => void delays.push(ms);
    const { fetch } = routed(
      [[gammaEvent([POLITICS_TAG], [])]],
      [[liveMarket({ conditionId: '0xnever' })]],
    );

    await discoverUniverse({ maxMarkets: 30, fetch, pageDelay });

    assert.equal(delays.length, 49);
    assert.deepEqual([...new Set(delays)], [60], 'the 60 ms pause reaches both paging layers');
  });

  // ── de-duplication of accepted markets by conditionId ──
  //
  // The accepted collection is keyed by conditionId, so a repeated condition can
  // neither occupy two slots in the universe nor be counted twice in `seen`'s
  // reconciliation. What is pinned below: the survivor rule (highest liquidity,
  // first encountered on an exact tie), that the `maxMarkets` cap is spent on
  // DISTINCT conditions, that a scan with no duplicates is untouched, and that the
  // accounting still reconciles on a mixed input.
  describe('de-duplication by conditionId', () => {
    it('tracks a conditionId that appears twice exactly once', async () => {
      const result = await discover({
        markets: [liveMarket({ conditionId: '0xdup' }), liveMarket({ conditionId: '0xdup' })],
      });

      assert.deepEqual(result.markets.map((m) => m.conditionId), ['0xdup']);
      assert.equal(result.markets.length, 1);
      assert.equal(result.seen, 2, 'both records were read, and `seen` still counts both');
      assert.equal(result.duplicateMarkets, 1, 'the dropped occurrence is counted, not discarded');
    });

    it('keeps the higher-liquidity instance, whichever order the two arrive in', async () => {
      // A "first seen wins" rule would keep the thin instance whenever the feed
      // happened to page the thin copy first, so the surviving liquidity would
      // depend on feed order. Liquidity order is already the preference the
      // maxMarkets slice applies, so the de-dup applies it too.
      const thin = liveMarket({ conditionId: '0xdup', liquidityNum: 100_000, question: 'thin copy' });
      const thick = liveMarket({ conditionId: '0xdup', liquidityNum: 300_000, question: 'thick copy' });

      const thinFirst = await discover({ markets: [thin, thick] });
      const thickFirst = await discover({ markets: [thick, thin] });

      assert.equal(thinFirst.markets.length, 1, 'one entry for the condition either way');
      assert.equal(thinFirst.markets[0]?.question, 'thick copy');
      assert.equal(thickFirst.markets[0]?.question, 'thick copy', 'the survivor does not depend on page order');
      assert.equal(thinFirst.duplicateMarkets, 1);
      assert.equal(thickFirst.duplicateMarkets, 1);
    });

    it('resolves an exact liquidity tie to the first occurrence, not to Map order', async () => {
      // Equal liquidityNum means "no instance is better", so the choice must be made
      // by scan order rather than left to Map insertion/iteration behaviour. Running
      // the same pair both ways round shows which of the two copies wins: whichever
      // is read first, which is the only tie-break that is deterministic and
      // reproducible from the feed alone.
      const first = liveMarket({ conditionId: '0xtie', liquidityNum: 250_000, slug: 'first-seen' });
      const second = liveMarket({ conditionId: '0xtie', liquidityNum: 250_000, slug: 'second-seen' });

      const forward = await discover({ markets: [first, second] });
      const reversed = await discover({ markets: [second, first] });

      assert.equal(forward.markets.length, 1);
      assert.equal(forward.markets[0]?.slug, 'first-seen', 'equal liquidity keeps the first occurrence read');
      assert.equal(reversed.markets[0]?.slug, 'second-seen', '"first" means scan order, so the rule is stable');
      assert.equal(forward.duplicateMarkets, 1);
      assert.equal(reversed.duplicateMarkets, 1);
    });

    it('spends the maxMarkets cap on distinct conditions, never on duplicates', async () => {
      // Three occurrences of the MOST liquid condition plus one distinct condition
      // below it, capped at two. The correct expectation is one slot for 0xa and one
      // for 0xb: de-duplication happens before the sort and the slice, so a repeated
      // condition has already collapsed to one entry and cannot take a second slot.
      // Read off the implementation rather than assumed: before the fix the array
      // held four records and both slots went to 0xa, crowding 0xb out entirely.
      const result = await discover({
        markets: [
          liveMarket({ conditionId: '0xa', liquidityNum: 500_000 }),
          liveMarket({ conditionId: '0xa', liquidityNum: 500_000 }),
          liveMarket({ conditionId: '0xa', liquidityNum: 500_000 }),
          liveMarket({ conditionId: '0xb', liquidityNum: 300_000 }),
        ],
        maxMarkets: 2,
      });

      assert.deepEqual(result.markets.map((m) => m.conditionId), ['0xa', '0xb']);
      assert.equal(result.duplicateMarkets, 2, 'three occurrences of 0xa collapse to one, so two are dropped');
      assert.equal(result.seen, 4);
      assert.equal(result.markets.length + result.duplicateMarkets, result.seen);
    });

    it('is a no-op on a scan with no duplicates', async () => {
      // The property that makes this safe to land before collection starts: with no
      // repeated conditionId the Map values come back in first-seen order, the sort
      // is stable, and nothing is dropped — so the result is the one the pre-fix
      // array produced, plus a duplicate count of zero.
      const result = await discover({
        markets: [
          liveMarket({ conditionId: '0xa', liquidityNum: 300_000 }),
          liveMarket({ conditionId: '0xb', liquidityNum: 100_000 }),
          liveMarket({ conditionId: '0xc', liquidityNum: 200_000 }),
        ],
      });

      assert.deepEqual(result.markets.map((m) => m.conditionId), ['0xa', '0xc', '0xb'], 'liquidity-descending');
      assert.equal(result.duplicateMarkets, 0);
      assert.equal(result.seen, 3);
      assert.equal(result.unparseable, 0);
      assert.deepEqual(result.rejected, {
        closed: 0,
        category: 0,
        liquidity: 0,
        probability: 0,
        spread: 0,
        no_yes_token: 0,
      });
      assert.equal(
        result.markets.length + rejectedTotal(result.rejected) + result.unparseable + result.duplicateMarkets,
        result.seen,
      );
    });

    it('reconciles seen against accepted, rejected, unparseable and duplicates', async () => {
      // The load-bearing claim for a project whose purpose is unreconciled numbers.
      // One page mixing a plain accept, a duplicated accept, a duplicated pair with
      // differing liquidity, two named filter rejections and two unreadable records,
      // with the EXACT counts asserted per bucket so a regression in any single one
      // is visible rather than masked by the sum still working out.
      const markets = [
        liveMarket({ conditionId: '0xaccept' }),
        liveMarket({ conditionId: '0xaccept' }),
        liveMarket({ conditionId: '0xdup-lo', liquidityNum: 100_000 }),
        liveMarket({ conditionId: '0xdup-hi', liquidityNum: 300_000 }),
        // Repeat both, each an exact liquidity tie with the copy already accepted.
        liveMarket({ conditionId: '0xdup-lo', liquidityNum: 100_000 }),
        liveMarket({ conditionId: '0xdup-hi', liquidityNum: 300_000 }),
        liveMarket({ conditionId: '0xlow', outcomePrices: '["0.21","0.79"]' }),
        liveMarket({ conditionId: '0xthin', liquidityNum: 10 }),
        // Neither of these is a rejection: they are records the parser cannot read.
        liveMarket({ conditionId: '' }),
        'not an object at all',
      ];

      const result = await discover({ markets });

      assert.equal(result.seen, 10);
      assert.deepEqual(
        result.markets.map((m) => m.conditionId),
        ['0xdup-hi', '0xaccept', '0xdup-lo'],
        'three distinct conditions, ordered by liquidity',
      );
      assert.equal(result.unparseable, 2);
      assert.deepEqual(result.rejected, {
        closed: 0,
        category: 0,
        liquidity: 1,
        probability: 1,
        spread: 0,
        no_yes_token: 0,
      });
      assert.equal(result.duplicateMarkets, 3, 'three accepted records repeated a conditionId');

      assert.equal(
        result.markets.length + rejectedTotal(result.rejected) + result.unparseable + result.duplicateMarkets,
        result.seen,
        'acceptedUnique + rejected + unparseable + duplicates === seen',
      );
      // The pre-fix form stays TRUE whenever there are no duplicates, which is why
      // this generalises the old invariant instead of replacing it.
      assert.equal(
        result.markets.length + rejectedTotal(result.rejected) + result.unparseable,
        result.seen - result.duplicateMarkets,
      );
    });
  });
});
