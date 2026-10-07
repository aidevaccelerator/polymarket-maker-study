import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoriesFromEvent, fetchCategoryIndex } from './categories.js';
import type { PageDelay, RawJsonFetcher } from './categories.js';

function event(tags: unknown, markets: unknown): unknown {
  return { slug: 'e', tags, markets };
}

function market(conditionId: string): unknown {
  return { conditionId };
}

describe('categoriesFromEvent', () => {
  it('maps child markets to an allowed category from event tags', () => {
    const result = categoriesFromEvent(
      event([{ id: '484', label: 'Politics' }], [market('0xabc'), market('0xdef')]),
    );
    assert.deepEqual(result, [
      { conditionId: '0xabc', category: 'Politics' },
      { conditionId: '0xdef', category: 'Politics' },
    ]);
  });

  it('returns empty when no tag is an allowed category', () => {
    assert.deepEqual(
      categoriesFromEvent(event([{ label: 'Crypto' }, { label: 'Sports' }], [market('0xabc')])),
      [],
    );
  });

  it('takes the first allowed label in tag order when several are present', () => {
    const result = categoriesFromEvent(
      event([{ label: 'Finance' }, { label: 'Crypto' }, { label: 'Politics' }], [market('0xabc')]),
    );
    assert.deepEqual(result, [{ conditionId: '0xabc', category: 'Finance' }]);
  });

  it('returns empty when tags are absent or null', () => {
    assert.deepEqual(categoriesFromEvent(event(null, [market('0xabc')])), []);
    assert.deepEqual(categoriesFromEvent({ slug: 'e', markets: [market('0xabc')] }), []);
  });

  it('skips malformed market entries and condition-less rows', () => {
    const result = categoriesFromEvent(
      event([{ label: 'Economics' }], [market('0xok'), 'nope', null, { conditionId: '' }, { x: 1 }]),
    );
    assert.deepEqual(result, [{ conditionId: '0xok', category: 'Economics' }]);
  });
});

// ── fetchCategoryIndex over an injected raw body ──
//
// The fetcher hands back the UNPARSED page body, so `categoriesFromEvent`, the
// offset arithmetic, the empty-page break and the page cap all execute for real
// below. No network. `noDelay` removes the wall-clock pause; the delay is asserted
// by the VALUE the loop passes to it, never by elapsed time.

// Real Gamma event tags carry {id, label, slug}.
const POLITICS_TAG = { id: '484', label: 'Politics', slug: 'politics' };
const FINANCE_TAG = { id: '197', label: 'Finance', slug: 'finance' };
const SPORTS_TAG = { id: '2032', label: 'Sports', slug: 'sports' };

const noDelay: PageDelay = async () => {};

function gammaEvent(tags: readonly unknown[], conditionIds: readonly string[]): unknown {
  return {
    id: '184023',
    ticker: 'fed-december-2026',
    slug: 'fed-december-2026',
    title: 'Fed December 2026 rate decision',
    closed: false,
    active: true,
    tags,
    markets: conditionIds.map((conditionId, i) => ({ conditionId, id: String(507019 + i) })),
  };
}

// `pages` is a queue whose LAST entry repeats once spent, so "every page is full"
// is a single push. Requested URLs are recorded so the offset arithmetic is
// assertable rather than assumed.
function cannedEvents(pages: readonly unknown[]): {
  readonly fetch: RawJsonFetcher;
  readonly urls: string[];
} {
  const queue = [...pages];
  const urls: string[] = [];
  const fetch: RawJsonFetcher = async (url) => {
    urls.push(url);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { fetch, urls };
}

describe('fetchCategoryIndex over an injected body', () => {
  it('requests the production /events URL with the real offset arithmetic', async () => {
    const { fetch, urls } = cannedEvents([
      [gammaEvent([POLITICS_TAG], ['0xa'])],
      [gammaEvent([FINANCE_TAG], ['0xb'])],
      [],
    ]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.deepEqual(urls, [
      'https://gamma-api.polymarket.com/events?closed=false&active=true&limit=50&offset=0',
      'https://gamma-api.polymarket.com/events?closed=false&active=true&limit=50&offset=50',
      'https://gamma-api.polymarket.com/events?closed=false&active=true&limit=50&offset=100',
    ]);
    assert.equal(index.byConditionId.get('0xa'), 'Politics');
    assert.equal(index.byConditionId.get('0xb'), 'Finance');
    assert.equal(index.eventsScanned, 2);
    assert.equal(index.marketsIndexed, 2);
  });

  // The de-duplication this path actually performs: a conditionId listed under more
  // than one event is indexed ONCE. Gamma can surface the same market under sibling
  // events, and without this the category a market resolves to would depend on page
  // order rather than on the market itself.
  it('indexes a condition listed under two events once, keeping the first category', async () => {
    const { fetch } = cannedEvents([
      [
        gammaEvent([POLITICS_TAG], ['0xshared']),
        gammaEvent([FINANCE_TAG], ['0xshared', '0xfinance-only']),
      ],
      [],
    ]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.equal(index.marketsIndexed, 2, '0xshared counts once, not once per event that lists it');
    assert.equal(index.byConditionId.size, 2);
    assert.equal(index.byConditionId.get('0xshared'), 'Politics', 'the first event to claim it wins');
    assert.equal(index.byConditionId.get('0xfinance-only'), 'Finance');
    assert.equal(index.eventsScanned, 2);
    assert.equal(index.eventsInAllowedCategory, 2, 'both events resolved to an allowed category');
  });

  it('leaves an event with no allowed tag uncounted but still scanned', async () => {
    const { fetch } = cannedEvents([[gammaEvent([SPORTS_TAG], ['0xa'])], []]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.equal(index.eventsScanned, 1, 'a rejected event was still seen');
    assert.equal(index.eventsInAllowedCategory, 0);
    assert.equal(index.marketsIndexed, 0);
    assert.equal(index.byConditionId.size, 0);
  });

  it('stops at the first empty page instead of walking the remaining cap', async () => {
    const { fetch, urls } = cannedEvents([
      [gammaEvent([POLITICS_TAG], ['0xa'])],
      [],
      [gammaEvent([POLITICS_TAG], ['0xnever'])],
    ]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.equal(urls.length, 2, 'the page after an empty one is never requested');
    assert.equal(index.eventsScanned, 1);
    assert.equal(index.byConditionId.has('0xnever'), false);
  });

  it('treats a body that is not an array as the end of the walk', async () => {
    const { fetch, urls } = cannedEvents([{ error: 'not a page' }]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.equal(urls.length, 1);
    assert.equal(index.eventsScanned, 0);
    assert.equal(index.marketsIndexed, 0);
  });

  it('stops at the page cap rather than looping forever on a permanently full page', async () => {
    // A live feed always answers with a full page while more pages exist, so the cap
    // is the only thing bounding this loop. With the pause neutralised, the walk is
    // instant and terminating is observable as an exact page count.
    const { fetch, urls } = cannedEvents([[gammaEvent([POLITICS_TAG], ['0xa'])]]);

    const index = await fetchCategoryIndex({ fetch, pageDelay: noDelay });

    assert.equal(urls.length, 40, 'the production ceiling is 40 event pages');
    assert.equal(index.eventsScanned, 40);
    assert.equal(index.marketsIndexed, 1, 'the same condition repeated 40 times indexes once');
  });

  it('honours an explicit maxPages instead of the production cap', async () => {
    const { fetch, urls } = cannedEvents([[gammaEvent([POLITICS_TAG], ['0xa'])]]);

    await fetchCategoryIndex({ maxPages: 2, fetch, pageDelay: noDelay });

    assert.equal(urls.length, 2);
  });

  it('pauses once per page with the production delay value', async () => {
    // Asserts the constant handed to `pageDelay`, not elapsed time — the pause is
    // wall-clock, and a timing assertion here would be both flaky and meaningless.
    const delays: number[] = [];
    const pageDelay: PageDelay = async (ms) => void delays.push(ms);
    const { fetch } = cannedEvents([[gammaEvent([POLITICS_TAG], ['0xa'])]]);

    await fetchCategoryIndex({ maxPages: 3, fetch, pageDelay });

    assert.deepEqual(delays, [60, 60, 60], '60 ms, once per page walked, including the last');
  });
});