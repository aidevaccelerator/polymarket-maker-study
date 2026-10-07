// Category index built from Gamma EVENTS.
//
// WHY THIS EXISTS: Gamma's `/markets` records do NOT carry a `category` field
// (verified against the live API 2026-10-07: `category` is `null` and there is
// no `tags` key). The brief's "segment by category, tags[]" resolves through
// the parent EVENT instead: `/events` returns `tags: [{id, label, slug}]` whose
// `label` is the top-level category ("Politics", "Finance", "Economics",
// "Crypto", ...). So we page events, read their tags, and index every child
// market's `conditionId` to that category.
//
// Deliberately NOT done here:
//   - No category is inferred from slug/title heuristics. If Gamma ever starts
//     populating `/markets.category`, `discoverUniverse` prefers that field
//     first and this index becomes a fallback.
//   - No tag_id is hardcoded. The category labels are matched against
//     ALLOWED_CATEGORIES from the shared config, so adding an allowed category
//     needs no change here.
//
// Rate budget: Gamma `/markets` is documented at 300 req/10s. `/events` is not
// given its own documented figure, so this walks it at the same conservative
// pacing (PAGE_DELAY_MS between pages) and caps the total pages scanned. Index
// build is once per collector run, not per poll.

import { fetchJson } from './http.js';
import { isRecord } from '../shared/parse.js';
import { ALLOWED_CATEGORIES } from '../shared/config.js';

// The raw, unparsed event body — the same seam `RawBookFetcher` introduced for
// BookPoller in b7a7b2d, for the same reason: injecting a pre-built
// `CategoryIndex` would bypass URL construction, the offset arithmetic, the page
// cap and the tag rule, which is the logic worth testing. The seam sits BELOW the
// parsing. `PageDelay` neutralises the inter-page pause so a test can walk the
// real page cap without paying wall-clock time; it asserts the ms VALUE handed to
// it against the constant, never an elapsed measurement.
export type RawJsonFetcher = (url: string) => Promise<unknown>;

export type PageDelay = (ms: number) => Promise<void>;

// Both defaults below are the production values, so a caller that passes neither
// performs exactly the work it always did.
export const defaultPageDelay: PageDelay = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const EVENTS_PAGE_SIZE = 50;
const EVENTS_PAGE_DELAY_MS = 60;
// Hard cap on events scanned. ~5 events per Politics/Finance/Economics event, so
// 40 pages x 50 = 2000 events is a generous ceiling for a universe target of 30.
const MAX_EVENT_PAGES = 40;

const ALLOWED: ReadonlySet<string> = new Set<string>(ALLOWED_CATEGORIES);

// The first tag, in the event's own tag order, whose label is an allowed
// category. Deterministic: a given event always resolves to the same label.
function allowedCategoryOf(event: Record<string, unknown>): string | null {
  const tags = event['tags'];
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (!isRecord(tag)) continue;
    const label = tag['label'];
    if (typeof label === 'string' && ALLOWED.has(label)) return label;
  }
  return null;
}

export interface CategoryIndex {
  /** conditionId (Gamma primary key) -> category label. */
  readonly byConditionId: ReadonlyMap<string, string>;
  readonly eventsScanned: number;
  readonly eventsInAllowedCategory: number;
  readonly marketsIndexed: number;
}

export interface CategoryIndexOptions {
  readonly maxPages?: number;
  readonly fetch?: RawJsonFetcher;
  readonly pageDelay?: PageDelay;
}

export interface EventCategory {
  readonly conditionId: string;
  readonly category: string;
}

// Pure: maps one raw Gamma event to the categories of its child markets, or an
// empty list when the event carries no allowed category. Extracted from the
// paging loop so the tag-resolution rule is unit-testable without network.
export function categoriesFromEvent(event: unknown): readonly EventCategory[] {
  if (!isRecord(event)) return [];
  const category = allowedCategoryOf(event);
  if (category === null) return [];

  const markets = event['markets'];
  if (!Array.isArray(markets)) return [];

  const out: EventCategory[] = [];
  for (const rawMarket of markets) {
    if (!isRecord(rawMarket)) continue;
    const conditionId = rawMarket['conditionId'];
    if (typeof conditionId !== 'string' || conditionId === '') continue;
    out.push({ conditionId, category });
  }
  return out;
}

export async function fetchCategoryIndex(
  opts: CategoryIndexOptions = {},
): Promise<CategoryIndex> {
  const maxPages = opts.maxPages ?? MAX_EVENT_PAGES;
  const fetch = opts.fetch ?? fetchJson;
  const pageDelay = opts.pageDelay ?? defaultPageDelay;
  const byConditionId = new Map<string, string>();
  let eventsScanned = 0;
  let eventsInAllowedCategory = 0;
  let marketsIndexed = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * EVENTS_PAGE_SIZE;
    const url =
      `${GAMMA_BASE}/events?closed=false&active=true` +
      `&limit=${EVENTS_PAGE_SIZE}&offset=${offset}`;
    const body = await fetch(url);
    if (!Array.isArray(body) || body.length === 0) break;
    eventsScanned += body.length;

    for (const rawEvent of body) {
      const mapped = categoriesFromEvent(rawEvent);
      if (mapped.length > 0) eventsInAllowedCategory += 1;
      for (const { conditionId, category } of mapped) {
        // First writer wins: keeps the category stable for a market that
        // appears under more than one event.
        if (!byConditionId.has(conditionId)) {
          byConditionId.set(conditionId, category);
          marketsIndexed += 1;
        }
      }
    }

    await pageDelay(EVENTS_PAGE_DELAY_MS);
  }

  return { byConditionId, eventsScanned, eventsInAllowedCategory, marketsIndexed };
}