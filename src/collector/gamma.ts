// Universe discovery via the Gamma metadata API (no auth) plus in-process
// filtering to a liquid, mid-range, allowed-category market set.

import { fetchJson } from './http.js';
import { asString, isRecord, numberOrNull } from '../shared/parse.js';
import { defaultPageDelay, fetchCategoryIndex } from './categories.js';
import type { PageDelay, RawJsonFetcher } from './categories.js';
import {
  ALLOWED_CATEGORIES,
  MAX_PROB,
  MIN_LIQUIDITY_USD,
  MIN_PROB,
  MIN_SPREAD_TICKS,
} from '../shared/config.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const PAGE_SIZE = 100;
// Gamma does not expose per-market tick size; binary markets trade at 0.01.
// MIN_SPREAD_TICKS = 1 therefore means "at least a one-cent spread".
const ASSUMED_TICK = 0.01;
const PAGE_DELAY_MS = 60;

export interface TrackedMarket {
  readonly conditionId: string;
  readonly tokenId: string; // YES token id
  readonly category: string;
  readonly question: string;
  readonly slug: string;
}

export type RejectReason =
  | 'closed'
  | 'category'
  | 'liquidity'
  | 'probability'
  | 'spread'
  | 'no_yes_token';

// A market with its Gamma fields resolved (JSON arrays already parsed) so the
// filter can be a pure, testable function of this shape.
export interface UniverseCandidate {
  readonly conditionId: string;
  readonly tokenIds: readonly string[];
  readonly outcomes: readonly string[];
  readonly category: string;
  readonly liquidityNum: number;
  readonly active: boolean;
  readonly closed: boolean;
  readonly outcomePrices: readonly number[] | null;
  readonly lastTradePrice: number | null;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly question: string;
  readonly slug: string;
}

export type ClassifyResult =
  | { readonly accept: true; readonly market: TrackedMarket; readonly liquidityNum: number }
  | { readonly accept: false; readonly reason: RejectReason };

// YES outcome is identified by matching "yes" (case-insensitive) in `outcomes`;
// fall back to index 0 when outcomes are absent or have no "yes" label
// (documented assumption: Gamma orders [YES, NO] for binary markets).
export function yesTokenIndex(outcomes: readonly string[]): number {
  const i = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
  return i >= 0 ? i : 0;
}

export function yesTokenId(tokenIds: readonly string[], outcomes: readonly string[]): string | null {
  if (tokenIds.length === 0) return null;
  const i = yesTokenIndex(outcomes);
  return tokenIds[i] ?? tokenIds[0] ?? null;
}

function yesProbability(c: UniverseCandidate): number | null {
  const i = yesTokenIndex(c.outcomes);
  const fromPrices = c.outcomePrices?.[i];
  if (fromPrices !== null && fromPrices !== undefined) return fromPrices;
  return c.lastTradePrice;
}

export function classifyMarket(c: UniverseCandidate): ClassifyResult {
  if (c.closed || !c.active) return { accept: false, reason: 'closed' };
  if (!(ALLOWED_CATEGORIES as readonly string[]).includes(c.category)) {
    return { accept: false, reason: 'category' };
  }
  if (c.liquidityNum < MIN_LIQUIDITY_USD) return { accept: false, reason: 'liquidity' };

  const tokenId = yesTokenId(c.tokenIds, c.outcomes);
  if (tokenId === null) return { accept: false, reason: 'no_yes_token' };

  const prob = yesProbability(c);
  if (prob === null) return { accept: false, reason: 'probability' };
  if (prob < MIN_PROB || prob > MAX_PROB) return { accept: false, reason: 'probability' };

  if (c.bestBid !== null && c.bestAsk !== null) {
    const spread = c.bestAsk - c.bestBid;
    if (spread < MIN_SPREAD_TICKS * ASSUMED_TICK) return { accept: false, reason: 'spread' };
  }

  return {
    accept: true,
    liquidityNum: c.liquidityNum,
    market: {
      conditionId: c.conditionId,
      tokenId,
      category: c.category,
      question: c.question,
      slug: c.slug,
    },
  };
}

// ── JSON parsing (parse, don't validate: narrow `unknown` to a typed value) ──

function asBoolean(v: unknown): boolean {
  return v === true;
}

function parseStringArray(v: unknown): readonly string[] | null {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = asString(item);
      if (s === null) return null;
      out.push(s);
    }
    return out;
  }
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parseStringArray(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

function parseNumberArray(v: unknown): readonly number[] | null {
  if (Array.isArray(v)) {
    const out: number[] = [];
    for (const item of v) {
      const n = numberOrNull(item);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  }
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parseNumberArray(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

// Parses one Gamma market JSON object into a UniverseCandidate, or null when a
// required field is missing/malformed (caller treats null as "unparseable").
export function parseCandidate(input: unknown): UniverseCandidate | null {
  if (!isRecord(input)) return null;
  const conditionId = asString(input['conditionId']);
  if (conditionId === null || conditionId === '') return null;

  const tokenIds = parseStringArray(input['clobTokenIds']);
  const outcomes = parseStringArray(input['outcomes']);
  if (tokenIds === null || outcomes === null) return null;

  const category = asString(input['category']) ?? '';
  const question = asString(input['question']) ?? '';
  const slug = asString(input['slug']) ?? '';

  const liquidityNum = numberOrNull(input['liquidityNum']) ?? 0;
  const active = asBoolean(input['active']);
  const closed = asBoolean(input['closed']);
  const outcomePrices = parseNumberArray(input['outcomePrices']);
  const lastTradePrice = numberOrNull(input['lastTradePrice']);
  const bestBid = numberOrNull(input['bestBid']);
  const bestAsk = numberOrNull(input['bestAsk']);

  return {
    conditionId,
    tokenIds,
    outcomes,
    category,
    liquidityNum,
    active,
    closed,
    outcomePrices,
    lastTradePrice,
    bestBid,
    bestAsk,
    question,
    slug,
  };
}

export interface DiscoverOptions {
  readonly maxMarkets: number;
  // Injection seams, both defaulting to the production values — see the comment on
  // `RawJsonFetcher` in categories.ts. The injected body is RAW, so URL
  // construction, parsing, classification, filtering and pagination all run for
  // real inside the test. `maxMarkets` is the only option production passes.
  readonly fetch?: RawJsonFetcher;
  readonly pageDelay?: PageDelay;
}

export interface DiscoverResult {
  readonly markets: readonly TrackedMarket[];
  readonly seen: number;
  readonly rejected: Readonly<Record<RejectReason, number>>;
  readonly unparseable: number;
  // Accepted records that repeated a conditionId already accepted in this scan.
  // Counted rather than silently dropped: `seen` is every record the scan read,
  // so `markets.length + rejected + unparseable + duplicateMarkets === seen`, and
  // the first three alone still sum to `seen` whenever this is 0.
  readonly duplicateMarkets: number;
}

function emptyRejected(): Record<RejectReason, number> {
  return {
    closed: 0,
    category: 0,
    liquidity: 0,
    probability: 0,
    spread: 0,
    no_yes_token: 0,
  };
}

export async function discoverUniverse(opts: DiscoverOptions): Promise<DiscoverResult> {
  const rejected = emptyRejected();
  const fetch = opts.fetch ?? fetchJson;
  const pageDelay = opts.pageDelay ?? defaultPageDelay;
  // Accepted markets keyed by conditionId. The keying IS the de-duplication: a
  // conditionId repeated within one scan must yield ONE tracked market, not one
  // per occurrence. The higher-liquidity instance wins, because the sort below
  // already prefers liquidity; an exact tie keeps the FIRST occurrence, so the
  // winner never depends on Map iteration order.
  const accepted = new Map<string, { market: TrackedMarket; liquidityNum: number }>();
  let duplicateMarkets = 0;
  let seen = 0;
  let unparseable = 0;
  let offset = 0;

  // Category comes from the parent EVENT's tags: `/markets` records carry a
  // null `category` and no `tags` key, so without this index every market is
  // rejected on category and the universe is always empty. Built once per run.
  const categoryIndex = await fetchCategoryIndex({ fetch, pageDelay });

  // Rate budget: /markets is limited to 300 req/10s. Discovery paginates with
  // a small inter-page delay and stops as soon as the accepted set is full;
  // it makes at most a handful of requests per run, far below the limit.
  for (;;) {
    const url =
      `${GAMMA_BASE}/markets?closed=false&active=true` +
      `&liquidity_num_min=${MIN_LIQUIDITY_USD}` +
      `&limit=${PAGE_SIZE}&offset=${offset}`;
    const body = await fetch(url);
    if (!Array.isArray(body)) break;

    if (body.length === 0) break;
    seen += body.length;

    for (const raw of body) {
      const candidate = parseCandidate(raw);
      if (candidate === null) {
        unparseable += 1;
        continue;
      }
      // Direct market field wins if Gamma ever populates it (currently null).
      const category =
        candidate.category !== ''
          ? candidate.category
          : (categoryIndex.byConditionId.get(candidate.conditionId) ?? '');
      const result = classifyMarket({ ...candidate, category });
      if (result.accept) {
        const incumbent = accepted.get(result.market.conditionId);
        if (incumbent === undefined) {
          accepted.set(result.market.conditionId, {
            market: result.market,
            liquidityNum: result.liquidityNum,
          });
        } else {
          duplicateMarkets += 1;
          if (result.liquidityNum > incumbent.liquidityNum) {
            accepted.set(result.market.conditionId, {
              market: result.market,
              liquidityNum: result.liquidityNum,
            });
          }
        }
      } else {
        rejected[result.reason] += 1;
      }
    }

    // `.size`, not a record count: the universe is full when it holds
    // `maxMarkets` DISTINCT conditions. Counting records would let repeated
    // conditionIds fill the cap and crowd distinct conditions out of the slice.
    if (accepted.size >= opts.maxMarkets) break;
    offset += PAGE_SIZE;
    if (offset >= 10 * PAGE_SIZE) break; // hard cap: 1000 scanned
    await pageDelay(PAGE_DELAY_MS);
  }

  // De-duplicated, then ordered by liquidity, then capped — in that order. With no
  // duplicates in the scan this is unchanged: Map values come back in first-seen
  // order and the sort is stable, so the result is identical to the previous array.
  const ordered = [...accepted.values()].sort((a, b) => b.liquidityNum - a.liquidityNum);
  const markets = ordered.slice(0, opts.maxMarkets).map((e) => e.market);
  return { markets, seen, rejected, unparseable, duplicateMarkets };
}
