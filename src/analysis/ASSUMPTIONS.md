# Analysis-side assumptions and decisions

This file records every assumption the analysis half (`src/analysis/`) makes
that the project brief did not fully settle, so the operator can audit and, if
needed, correct them. Nothing here silently changes a pre-registered threshold.

## 1. Sign convention (resolved discrepancy in the brief)

The brief gives a formula and a meaning that contradict each other:

- Formula text: `adverseCents = (mid_at(t+X) - our_fill_price) * 100 * our_direction`
  with `our_direction = -1` when we sold, `+1` when we bought.
- Meaning text: "POSITIVE `adverseCents` = the market moved AGAINST us. This is
  the loss metric."
- Required test: "a fill followed by a mid move in our favor must produce
  NEGATIVE `adverseCents`."

Under the formula's direction assignment (`sold -> -1`), a mid move **against**
us produces a NEGATIVE value (it is actually a profit metric), which contradicts
both the "loss metric" sentence and the required test. Two independent sources
(the semantics and the test) pin the LOSS convention; only the inline direction
sign conflicts. We therefore implement the LOSS convention:

- `ourDirection(SELL) = +1` (short; adverse = price rises)
- `ourDirection(BUY)  = -1` (long;  adverse = price falls)

so that `adverseCents > 0` means "against us" and `< 0` means "in our favor".
This is enforced by `markout.test.ts` and documented, not hidden.

Aggressor→our-side mapping: `QuoteTouch.side 'BUY'` (aggressor bought) hits our
resting ASK, so we SELL; `'SELL'` hits our resting BID, so we BUY.

## 2. Timestamps

Collector `ts`/`recvTs`/`bookTs` strings are assumed to be **epoch
milliseconds** (the collector uses `Date.now()`). Non-numeric strings fall back
to ISO-8601 via `Date.parse`. See `parseTs` in `markout.ts`.

## 3. Queue models

- `pessimistic`: we are last in line; fill only when `takerSize > queueAhead`.
  Headline model.
- `median`: expected fill probability `min(1, takerSize / queueAhead)`
  (equivalently, randomly positioned within the queue).
- `optimistic`: any positive touch fills us immediately (upper bound, never the
  headline).

`OUR_ORDER_SIZE = 100` shares is the assumed resting order size (affects fill
sizes, total rebate, and round-trip size — not per-share markout). **UPDATE
2026-10-07:** this is no longer an analysis-side constant. It now lives in
`src/shared/config.ts` as `OUR_ORDER_SIZE` (value unchanged, 100) and is
imported by `queueModels.ts`, `fillRate.ts`, and `index.ts`, so the collector
half and any reviewer reading the contract first can see it.

## 4. Verdict

- Canonical horizon for the verdict is **+30s**. All four horizons (+1/+5/+30/+60s)
  are reported; the verdict thresholds apply to the +30s pessimistic/median medians.
  **UPDATE 2026-10-07:** exported from `src/shared/config.ts` as
  `CANONICAL_HORIZON_MS = 30_000`; `verdict.ts` derives its seconds figure from
  it so the rule descriptions and the `Verdict` record cannot drift apart.
- MARGINAL band lower bound `1.0` comes from the pre-registered rules
  ("lands in [1.0, 1.3]"). **UPDATE 2026-10-07:** it is now
  `MARGINAL_LOWER_BOUND_CENTS = 1.0` in `src/shared/config.ts` (value
  unchanged) and is imported by `verdict.ts`. Note this was previously absent
  from config, which only exported 1.3/2.0/0.5.
- Boundary behavior: the FAIL rule is **strictly** `> 1.3`, so a median of
  exactly `1.3` is MARGINAL, not FAIL. Enforced and commented in
  `verdict.test.ts`.
- `MIN_FILLS_FOR_VERDICT = 100` pessimistic fills is a **sample-count floor**, not
  a statistical-confidence test; below it we emit `INSUFFICIENT_DATA` instead of
  a verdict. Sample sizes (`n` and weighted `n`) are reported alongside every
  distribution regardless. **UPDATE 2026-10-07:** promoted to
  `src/shared/config.ts` (value unchanged, 100) and imported by `verdict.ts`.
- Overall precedence when multiple rules fire: `INSUFFICIENT_DATA` >
  `FAIL_TAKER_SHARE` > `FAIL` > `MARGINAL` > `PASS`. Every rule's individual
  outcome is printed so no single rule masks another.

**UPDATE 2026-10-07 — the statistic is a weighted p50 median, and no confidence
interval is computed.** This is recorded because the pre-registration document
and the README previously described something the code does not do: a **95%
confidence interval on the mean** adverse mid movement. `verdict.ts` thresholds
the **weighted p50 median** of `adverseCents` (`Distribution.p50`, weighted by
fill fraction), and substitutes a raw fill count for any confidence notion.
Grep confirms there is no `confidence`, `stderr`, `bootstrap`, or
`standard error` anywhere in `src/analysis/`. `Distribution` carries a `mean`
field that the verdict never reads; the mean is still printed in the report
alongside the percentiles, for context only.

The two remaining documentation mentions of a 95% CI have been amended to match
the implementation — see the amendment log in `docs/THRESHOLDS.md`. No bootstrap
was added: on a sample of ~100 fills a bootstrap interval would be noise dressed
as precision, and a sample-count floor plus reported percentiles is the more
truthful representation of the same uncertainty.

The vocabulary is now single-sourced. The code's outcomes are
`PASS / MARGINAL / FAIL / FAIL_TAKER_SHARE / INSUFFICIENT_DATA`, and the docs
name those five rather than the previously-promised `VIABLE / NOT VIABLE /
INCONCLUSIVE`. `Distribution.mean` is reported but is not thresholded; the
thresholded statistic is `p50`.

## 5. Taker share T/(M+T)

The shared schema carries no maker/taker volume split, so `takerShare.ts`
measures it from the book:

- `T = Σ QuoteTouch.size` (aggressive volume that touched us).
- `M = Σ min(size, resting size at the touch price in the bookTs snapshot)`.
- `takerShare = T / (T + M)`.

In a matched book every filled share has one taker and one maker, so this is
structurally ≈ 0.5; values above 0.5 occur when takers over-consume thin
resting liquidity. This is a real measurement with a documented method, not an
assumption of 1.0. When there is no data it emits `takerShare: null` with a
warning (never a guess). If the operator can supply a direct maker/taker volume
field, this module is the single place to change.

**Pooled vs per-market.** The brief asks for taker share "per market", so
`takerShare.ts` returns both. The headline consumed by the verdict is the
**pooled** ratio `sum(T)/sum(T+M)`; the per-market table is reported alongside it,
sorted by descending taker volume. These are not interchangeable: a mean of
per-market ratios is a different (and volume-blind) number from the pooled ratio,
and the pre-registered `TAKER_SHARE_FLOOR` is compared against the pooled one.
Per-market dispersion is the useful signal here — a single market at 0.95 beside
several at 0.50 is a thin-liquidity artifact, not a property of the venue, and
averaging hides that.

**Upward-bias guard.** Both failure modes under-count `M` while still adding the
full size to `T`, so both bias `takerShare` UP toward 1.0 — the one value the
brief forbids assuming:

- the referenced book snapshot is missing entirely;
- the book exists but carries no resting level at the touch price (stale book,
  price already moved through the level).

The second case is easy to miss and was, until it was observed in a fixture,
unreported. Both are now counted and surfaced as warnings, including the share
of affected samples. Treat a `takerShare` printed alongside such a warning as an
upper bound, not a measurement. A run where this warning fires on a large
fraction of samples is telling you the book/touch join is unreliable — that is a
collector data-quality problem to fix upstream, not something to average over.

## 6. Fee category, and the RESOLVED shared fee table

The shared schema carries no market `category` field, so every fill in the
collected dataset resolves to `Other` — the documented general schedule
(taker fee 0.05, rebate fraction 0.25). Rebate figures are therefore
conservative for Finance/Politics/Mentions/Tech markets (0.04) and light for
Crypto (0.07) when the true category is known. Reported via
`RebateAccrual.categories`.

### RESOLVED 2026-10-07 — the Economics fee-rate disagreement is closed

This section previously recorded an **OPEN FINDING**: the project brief gave the
Economics taker fee rate as **0.05**, while `src/shared/fees.ts` carried **0.04**.
At `rebateFraction = 0.25`, `takerShare = 0.5`, and mid-market price, that
disagreement was worth 25% of the maker rebate on every Economics share — and
`Economics` is in `ALLOWED_CATEGORIES`, so real collected markets hit it.

**Authoritative value: `0.05`.** The fee schedule was re-read directly from
<https://docs.polymarket.com/trading/fees> (retrieved 2026-10-07). The full
documented table is transcribed at the top of `src/shared/fees.ts`, which is now
the single source of truth:

| Category | Taker fee | Maker fee | Maker rebate |
| --- | --- | --- | --- |
| Crypto | 0.07 | 0 | 20% |
| Sports | 0.05 | 0 | 15% |
| Finance | 0.04 | 0 | 25% |
| Politics | 0.04 | 0 | 25% |
| Economics | **0.05** | 0 | 25% |
| Culture | 0.05 | 0 | 25% |
| Weather | 0.05 | 0 | 25% |
| Other/General | 0.05 | 0 | 25% |
| Mentions | 0.04 | 0 | 25% |
| Tech | 0.04 | 0 | 25% |
| Geopolitics | 0 (fee-free, no pool) | 0 | 0% |

Three things changed, and no others:

1. **`src/shared/fees.ts`:** `FEE_RATE.Economics` corrected `0.04 → 0.05`. The
   table was also widened to the full documented category set, and both tables
   are now `satisfies Record<FeeCategory, number>` (total records, not
   `Partial`), so adding a category without a documented rate is a compile error
   rather than a silent `undefined` at runtime.
2. **`src/analysis/rebates.ts`:** its own `Category`, `CATEGORY_FEE_RATES` and
   `CATEGORY_REBATE_FRACTIONS` copies were deleted. It imports `FEE_RATE`,
   `REBATE_FRACTION` and the rebate formula from `../shared/fees.js` now, and
   `Category` is re-exported from the shared `FeeCategory`. `Other` was added to
   the shared table with its documented value, so the category that real
   collected fills resolve to is priced explicitly rather than defaulted. There
   is no untyped fallback anywhere in the path.
3. **Regression test added:** `src/analysis/feeConsistency.test.ts` asserts, for
   every category, that the analysis module's rebate and taker-fee functions
   return values matching **literal tables transcribed from the docs inside the
   test file itself** — not values recomputed from the shared table. It also pins
   the shared table to the same documented literal for all 11 categories. The
   shared table is pinned independently in `src/shared/fees.test.ts`.

   **UPDATE 2026-10-07 — this test was tautological and has been rewritten.** An
   earlier version compared `rebates.ts`'s exported `CATEGORY_FEE_RATES` /
   `CATEGORY_REBATE_FRACTIONS` against `shared/fees.ts`'s `FEE_RATE` /
   `REBATE_FRACTION`. Those exports are **aliases** (`export const
   CATEGORY_FEE_RATES: Record<Category, number> = FEE_RATE`), so the comparison
   was the shared table against itself and could not fail for any edit to either
   half. The old claim "if either half is edited without the other, the build
   fails" was therefore **false**.

   What the test now actually guarantees: if `FEE_RATE`, `REBATE_FRACTION`, or
   the wiring inside `rebates.ts` is changed without the in-test literal being
   changed to match, the computed rebate/taker-fee values diverge from the
   literal and `npm run test:all` fails. Verified by mutation, not by assertion:
   setting `FEE_RATE.Economics` back to `0.04`, changing
   `REBATE_FRACTION.Sports` to `0.25`, hardcoding a rate in `rebates.ts`, and
   double-applying `takerShare` in `accrueRebates` each make this file fail.

The rebate formula is unchanged and still lives in one place:
`feeRate * p * (1-p) * rebateFraction * takerShare`, with `takerShare` measured,
never assumed.

**No pre-registered threshold was touched by this correction.** The five
verdict thresholds in `src/shared/config.ts` are byte-identical to their values
before 2026-10-07; only the fee schedule and the four promoted analysis
constants moved location.

`Sports` remains absent from the collector's `ALLOWED_CATEGORIES`, so its 0.05 /
15% schedule is present for completeness but never applied to collected data.

## 7. Fill-rate "touch vs 1-tick-inside"

- `touch`: our quote sits AT the best bid/ask, front of queue (`queueAhead = 0`).
- `oneTickInside`: our quote is one tick BEHIND the best (less competitive),
  so `queueAhead = best-level total size`.

"Inside" here means "inside the book, behind the best level" (deeper in the
queue). This is the adverse-selection/queue story the experiment tests.

## 8. Parquet layout

The on-disk layout is owned by the collector agent. `parquetRead.ts` is
defensive:

- `*.parquet` files are classified by path keywords: `top` → TopOfBook,
  `quote`/`touch` → QuoteTouch, `book` → BookSnapshot.
- Column names are expected to match the shared schema character-for-character.
- `bids`/`asks` are normalized from either `[price, size][]` or
  `{price, size}[]` decoding.

If the real layout differs, only `parquetRead.ts` needs adjustment.

## 9. Shared config constants

`MIN_PROB`, `MAX_PROB`, `MIN_LIQUIDITY_USD` values are not specified in the
analysis brief; they are owned by the collector/config agent. `index.ts` imports
them from `../shared/config.js` and applies them as pre-registered market
filters (price bounds and a best-effort USD liquidity gate), counting excluded
touches so filtering is never silent.

## 10. Build/test scaffolding

`npm run build` and `npm test` are scoped to `src/shared` + `src/collector`, so
the recorder path stays fast and independent of the analysis half.
`build:all` / `test:all` cover the whole project. `tsconfig.analysis.json`
compiles `src/shared` + `src/analysis` at identical strictness so this half can
be verified in isolation:

```sh
npx tsc -b tsconfig.analysis.json
node scripts/run-tests.mjs dist/analysis
```

Output goes to the same `dist/` tree, so `npm run analyze` works unchanged.

**Note on scope:** `npm test` runs **only** the shared + collector tests (10 files,
129 tests). It does **not** touch this half. Only `npm run test:all` (19 files, 172
tests) executes `src/analysis`. Any statement implying `npm test` covers the
analysis half is wrong.

**UPDATE 2026-10-07 — build mode, and why `incremental` is off.** All three
programs are now built with `tsc -b` and `incremental` has been removed from
`tsconfig.json`. This is not a style change; it closes a silent-green bug:

- `tsc -b` only validates that expected outputs still exist on the
  non-incremental build-info path. With `incremental: true`, a surviving
  `.tsbuildinfo` makes `tsc -b` declare the project up to date, emit nothing,
  and skip that existence check entirely.
- Concretely, `npm run build:all && rm -rf dist/analysis && npm run test:all`
  reported **"tests 27" and exit 0** while `dist/analysis` did not exist. The
  milder single-file variant reported 68 instead of 78 and never regenerated the
  file.
- `scripts/run-tests.mjs` (new) now runs the suite and, before trusting any
  summary, asserts that every `src/**/*.test.ts` has a matching emitted
  `dist/**/*.test.js`, that at least one test file exists at all, and that the
  aggregate `# tests N` equals the sum of the per-file counts. A missing emitted
  file or a wholly missing directory is now a hard failure rather than a
  quietly smaller suite.
- `npm test` and `npm run test:all` gained `pretest` / `pretest:all` hooks that
  build first, so tests cannot run against a missing build. Previously
  `rm -rf dist && npm test` printed "tests 0 / pass 0 / fail 0" and exited 0.

Current per-file counts: shared + collector 129 across 11 files; analysis 62 across
9 files; total 191 across 20 files.

**UPDATE 2026-10-07 — universe discovery is now covered offline.** The collector's
universe-discovery path — market parsing, category resolution from parent-event
`tags[]`, the pre-registered price/spread/liquidity filters, the accept/reject
accounting, and pagination — reached the network directly and so had no offline
coverage; it was previously exercised only through `classifyMarket` and
`categoriesFromEvent`, which are pure helpers and cover only part of it.
`discoverUniverse` and `fetchCategoryIndex` now take an optional injectable fetcher
at the `fetchJson` boundary, following the `RawBookFetcher` pattern added for
`BookPoller` in b7a7b2d. The seam sits BELOW the parsing, so the URL construction,
pagination bounds, delay, parsing and filtering all execute for real in tests
rather than being stubbed around; the default delegates to the unchanged
`fetchJson`. That is why the counts above rise by 28 and the file counts do not
change at all: `src/collector/gamma.test.ts` and `src/collector/categories.test.ts`
were extended, not added. **Zero behaviour change** — `src/collector/index.ts` is
untouched, `collect:probe` still fetches live and still writes `data/quality/`,
and no threshold, URL, page cap, delay, verdict rule or `VERDICT_VERSION` moved.
See `docs/THRESHOLDS.md` for the thresholds themselves.

**UPDATE 2026-10-07 — CI now runs the full suite.** `.github/workflows/analyze.yml`
previously ran the collector-scoped `npm test`, which meant the analysis test
files never executed in CI at all: the only thing that would have compiled
`src/analysis` was `npm run analyze`, which sits *after* a dataset guard that
fails on an empty `data/`. The Test step in `analyze.yml` is now
`npm run test:all`, so a break in the analysis half fails the build.

**CORRECTION 2026-10-07 — `collect.yml` has no test step at all.** An earlier
version of this note said "`collect.yml` deliberately stays on the scoped
`npm test`". That was wrong: `collect.yml` runs `npm ci`, `npm run build`, the
recorder, and the artifact upload. It never runs any test, scoped or otherwise.
The recorder path is therefore not merely kept off the full suite — it is
untested by CI. `analyze.yml` is the only workflow that executes tests.

**UPDATE 2026-10-07 — ownership note.** The parallel-agent framing above is
historical. The collector half is no longer being edited in parallel, and this
half has now edited shared files under orchestrator instruction:
`src/shared/fees.ts` (Economics 0.04 → 0.05, full category set) and
`src/shared/config.ts` (four constants promoted from here). Those promotions
moved declarations without changing any value — `OUR_ORDER_SIZE` 100,
`MARGINAL_LOWER_BOUND_CENTS` 1.0, `MIN_FILLS_FOR_VERDICT` 100,
`CANONICAL_HORIZON_MS` 30_000 — and `src/shared/schema.ts` (the record contract)
is untouched.

## 11. Malformed input and sample-loss visibility

- `tryParseTs` (in `markout.ts`) is the non-throwing timestamp parse used on
  every dataset row. A single corrupt `ts` must not abort a whole run, but it
  must not vanish silently either: dropped touches are counted and surfaced as a
  coverage warning. `parseTs` still throws, and is used for `--from` / `--to`,
  where a bad CLI argument should fail loudly.
- The pre-registered market filters (`MIN_PROB`/`MAX_PROB`/`MIN_LIQUIDITY_USD`)
  count every excluded touch. If they remove more than half the in-window
  touches, `index.ts` emits an explicit warning, because a filter that guts the
  sample would otherwise bias the headline without being noticed.
- The liquidity gate is best-effort: it uses notional at the best level
  (`bestPrice * bestSize`) as a proxy for market liquidity, because the schema
  carries no aggregate depth. Touches with no book snapshot to measure are
  **kept**, not dropped, so the filter can only under-count exclusions.

**UPDATE 2026-10-07 — a malformed `/book` response is recorded; an empty book is
not.** `bookPoller.ts` parsed a CLOB `/book` body into a `BookSnapshot` or `null`,
and `pollOne` returned on that `null` under the comment "empty/unsupported book;
not an error". That comment was wrong in both halves, which is what made the defect
invisible. `null` never meant empty: `parseLevels([])` returns `[]`, so an empty
book was already a valid snapshot and was written like any other. `null` meant
**malformed** — `bids` or `asks` not an array, a level that is not a record, or a
single level whose `price` or `size` does not parse, any of which discards the
whole book because one bad side is not a partial book. Since `onError` was reached
only from the `catch` around the fetch, a `null` bypassed it entirely: no book was
written and no gap-log line was produced. If Polymarket renamed a field, changed a
type, or added a nesting level, every market would be discarded on every poll, the
dataset would be empty or partial, and the report would look clean with a
`gapsCount` that does not include it. Malformed responses now reach `onError` and
land in the append-only gap log, with the failing side named. Empty books are
unchanged: still valid, still written, still not an error. Pinned by
`src/collector/bookPoller.test.ts`, which includes the empty-book case as an
explicit regression guard.

**Rate limit on that report, and why it is edge-triggered.** The poller runs every
5s across ~30 markets, so a permanently malformed market would otherwise write
~17,280 gap lines/day (86,400/5) — enough to bury the durable audit log and the
uploaded `collector-artifacts` gap files under one repeating message, which is how
a real problem becomes invisible. Reporting is therefore tracked per conditionId
and fires on state transition: the first failure is always recorded, repeats are
suppressed, and a successfully parsed book clears the flag so a later failure is
recorded again as the distinct incident it is. That bounds the log to one entry per
contiguous failure episode — the unit an auditor wants — without ever collapsing
two episodes into one, and it needs no clock, so it is deterministic. A
time-window throttle was rejected: it needs a clock seam to test and still writes
thousands of lines over a 30-day run. Transport failures are deliberately NOT
suppressed; that path is unchanged from before.

**UPDATE 2026-10-07 — the websocket reconnect backoff resets only after a
connection proves stable.** Same visibility concern as the two entries above, one
layer down: they govern how many gap lines a *malformed payload* produces, this
governs how many a *transport* produces. `ws.ts` drove exponential backoff
(1s base, doubling, 60s cap, jittered) from a single `attempt` counter, and reset
that counter to 0 unconditionally in the `open` handler. A completed handshake
proves the endpoint accepted us and nothing more, so an endpoint that accepts and
then promptly closes — server-side rate limiting, an aggressive idle timeout, or
an intercepting middlebox producing the same signature — got the base delay on
every cycle: roughly one reconnect per second, indefinitely, across the 30-day
run, each cycle also appending a paired disconnect/reconnect entry to the gap log.
That is the same failure mode as the ~17,280 lines/day figure above, reached
without any malformed data at all. **Whether Polymarket's endpoint actually flaps
this way is UNVERIFIED** — the previous 30-day run never exercised this path
against the live endpoint, so this is a robustness fix, not an observed incident.

The reset is now deferred to a 30s stability window: a connection must outlive
`STABLE_CONNECTION_MS` before the backoff is zeroed, and the timer is cleared on
both `close` and `close()` so a 30-day run does not accumulate one live timer per
reconnect. Deleting the reset outright was rejected, because that reset is what
lets a genuinely long-lived connection reconnect at the base delay after a real
outage instead of arriving at the outage already backed off to the 60s cap — the
window is what keeps both properties, since a flapping endpoint never reaches it
and a healthy one reaches it within seconds of connecting. The delay computation
itself is unchanged (base, doubling, cap and jitter all identical); it moved into
an exported pure helper, `nextBackoffDelayMs`, so the schedule is directly
testable, and the subscription chunking, ping cadence, message parsing and the
disconnect/reconnect gap events are untouched. Note the coverage boundary recorded
at the top of `src/collector/ws.test.ts`: that file pins the delay schedule and
does **not** pin the reset-on-open wiring, which would require opening a real
socket or widening the class's injection surface. `gaps.ts` consumers are
unaffected — the gap events are byte-identical in shape.

**UPDATE 2026-10-07 — accepted markets are de-duplicated by `conditionId`, and
the duplicates are counted rather than dropped.** `discoverUniverse` collected
every market record that passed the filters into a plain array, so a
`conditionId` returned more than once in one scan became one `TrackedMarket`
per occurrence. The accepted collection is now keyed by `conditionId`. Two
consequences were worth fixing before any data is recorded rather than during a
run, both read off the code:

- `BookPoller` keys its prior-book map by `conditionId`, so N occurrences of
  one condition meant N sequential `/book` requests per sweep for an identical
  book — N times the request load against a public endpoint for no new
  information — and inflated the `bookSweep` mean in the manifest. Later batching
  (see §12) reduced a sweep to one request regardless, so the request-load half of
  this is now moot; the duplicate-work half is still why the de-duplication matters.
- `writeManifest`'s `marketsTracked` mapped the array, so the manifest's market
  list repeated the entry and `marketCount` was overstated.

The websocket side was **not** affected and this change does not help there:
`PriceWs`'s constructor collapses the tokens into `tokenByAssetId`, so a
repeated condition routed each update once already. **Whether Polymarket's
`/markets` pagination ever repeats a market is UNVERIFIED and not expected** —
this is a latent robustness gap, not an observed incident, on the same reasoning
as the reconnect-backoff entry above.

**The survivor is the highest-liquidity instance.** The scan already sorts by
`liquidityNum` descending and then slices to `maxMarkets`, so preferring the
higher-liquidity duplicate is consistent with what the universe already does; a
"first seen wins" rule would instead keep whichever copy the feed happened to
page first and silently discard the better-liquid one. An exact `liquidityNum`
tie resolves to the **first occurrence**, so the winner is decided by scan order
and never by `Map` iteration order. De-duplication happens *before* the sort and
the slice, and the early-stop test counts *distinct* conditions, so a repeated
condition can never consume a `maxMarkets` slot and crowd out a distinct one. A
scan containing no duplicates is unaffected: `Map` values come back in first-seen
order, the sort is stable, and the result is the one the previous array produced
— pinned by an explicit no-op test, and verified by mutation (disabling the
de-duplication fails 5 of the 6 tests).

**The accounting is explicit, and the invariant generalises rather than
changes.** `seen` is still every record the scan read; it was NOT redefined.
`DiscoverResult` gained `duplicateMarkets`, so

> acceptedUnique + rejected + unparseable + duplicates === seen

and with no duplicates the pre-existing `markets.length + rejected +
unparseable === seen` form still holds verbatim. That distinction is the
load-bearing part: silently discarding the repeated records would have left
`seen` not reconciling with the sum of its parts, which is the same class of
silent under-reporting as the dead coverage guard fixed in 6c5f6e0. The count
rides in the existing single per-scan gap-log line (one line per scan, never one
per duplicate) and is reported unconditionally, matching the neighbouring
`unparseable` figure rather than making the field's presence itself the signal.
Pinned on a mixed input — plain accept, duplicated accept, a duplicated pair with
differing liquidity, two named filter rejections and two unreadable records —
with the exact per-bucket counts asserted so a regression in any single bucket is
visible rather than masked by the sum still working out.

**PROBE 2026-10-07 — UNVERIFIED: no `conditionId` repeated across the live
offset pages sampled.** The "UNVERIFIED and not expected" claim above was closed
against the live endpoint, not left as reasoning. Probed the exact URL
`discoverUniverse` builds — `https://gamma-api.polymarket.com/markets?closed=false&active=true&liquidity_num_min=25000&limit=100&offset=N`,
unauthenticated, with `liquidity_num_min` taken from `MIN_LIQUIDITY_USD` — at
offsets 0, 100, 200, 300, 400, 500, 600 and 700: 8 pages, 800 records, every page
returning HTTP 200 with exactly 100 records. All 800 records carried a non-empty
`conditionId`, and the 800 were 800 **distinct** ids: zero repeats, within a page
or across pages. The category, probability and spread gates are applied
in-process after the fetch and cannot affect whether the endpoint repeats ids, so
they are out of scope for this probe.

This is a negative result on one sample and nothing more. It does **not** prove
that Gamma's offset pagination never repeats a `conditionId`: 8 offsets is a
fraction of the ~1000-record hard cap the scan uses, pagination order was not
captured across the probe (the ids were re-derived only from this single
2026-10-07 run), and a repeat driven by a concurrent write mid-pagination would
not be expected to reproduce on a re-probe. The de-dup in `discoverUniverse` is
therefore still a latent robustness guard against an unobserved condition, exactly
as the entry above describes it — the 20-duplicate-entry observation that
motivated the change came from a built `dist` against a different read path, not
from this endpoint, and this probe neither confirms nor refutes that path. What it
does establish is that the guard is not currently masking live traffic: on the
sampled pages `duplicateMarkets` would have been 0.

**KNOWN GAP 2026-10-07 — there is no automatic missing-sample check on the
verdict.** `CoverageReport.missingFraction` and its `>= 30%` warning are inert,
and a reader is therefore never told when the dataset is too degraded to trust.
The cause is a missing input, not a missing check:

- `writeManifest` in `src/collector/index.ts` writes `startTime`, `endTime`,
  `marketCount`, `marketsTracked`, `recordCounts` and `totalGapSeconds`. It writes
  no expected-sample counts, and no other code synthesizes them.
- `extractExpectedCount` (`src/analysis/index.ts`) reads `manifest.expected`,
  which `QualityManifest` declares as required but the collector never populates
  (`src/analysis/parquetRead.ts` parses the file with a bare cast). It therefore
  returns `null` on every run, so `expectedSamples` and `missingFraction` are
  always `null` and the `MISSING_THRESHOLD` branch in `report.ts` is unreachable.

What the report *does* show is still trustworthy: the observed counts
(book snapshots, top-of-book rows, quote touches, pessimistic fills) and
`gapsCount`, which is the number of records in the append-only JSONL gap files
and is therefore cumulative across runs. A reader must assess coverage from
those counts and the emitted warnings. `report.ts` now distinguishes an absent
manifest from a manifest that carries no expected counts; it no longer reports
"no `data/quality/manifest.json` found" for a file it read successfully.

This gap cannot be closed by adding one field. `observedSamples` counts in-scope
quote **touches**, which are event-driven (taker aggression) and have no knowable
expected count, while the scheduled cadences (top-of-book @1s; the full book only
at its achieved sweep cadence — see §12) do have computable expected counts.
Writing `expected` as a plain per-kind sum
would compare a sum of scheduled-sample expectations against observed touches —
a category mismatch. Enabling the check means deciding which record kinds are
compared against which, and on what basis; that is a design decision and is
deliberately left unsettled here. No expected-sample model has been invented.

Tests in `src/analysis/parquetRead.test.ts` pin this: a manifest written the way
the collector writes one has no `expected` field, and `renderMarkdown` neither
emits the missing-sample warning nor claims the manifest is absent when
`manifestPresent` is true.

## 12. The full-book cadence is a sweep duration, not `BOOK_POLL_MS`

> **UPDATE 2026-10-07 — the sweep is now BATCHED, so this section's central formula
> changed.** It previously read
> `max(BOOK_POLL_MS, markets × per-request latency)`, because `pollAll` fetched
> markets one at a time. `pollAll` now issues ONE `POST /books` per sweep, so a
> sweep costs one request regardless of market count and the formula becomes
> `max(BOOK_POLL_MS, one-batch latency)`. Measured over 260s / 30 markets:
> **45 sweeps, mean 446 ms, max 1268 ms**, versus 10-50 s before. The 167 ms
> crossover is gone with it. The original reasoning is kept below because the
> claim it corrected — "full order book @ 5s" was not what the collector
> delivered — is why this section exists at all; batching is what finally made
> the 5s figure true.

**The claim being corrected.** The README data layout, the `BookSnapshot` comment
in `src/shared/schema.ts` and the constant table in `docs/THRESHOLDS.md` all
described tier 1 as "full order book @ 5s" / "a full depth snapshot every 5
seconds". That is not what the collector delivered. This section states what it
delivers.

**The mechanism, read from the code.** `BookPoller.start(intervalMs =
BOOK_POLL_MS)` installs `setInterval(() => { void this.pollAll(); }, intervalMs)`
and fires one immediate sweep. `pollAll` requests every tracked market through
the multi-book endpoint in a single POST, then processes each response on its
own. The `polling` guard is unchanged: an interval tick arriving mid-sweep
returns immediately — dropped, not queued, never concurrent. `postJson` adds no
retry and no parallelism (one `await fetch`, a 10s `AbortSignal.timeout`).

A market omitted from the batch response — the endpoint drops tokens that have
never traded — is reported through `onError` for that market alone, so one
omitted token costs one market's snapshot and not the sweep. A failed request
reports every market, which is the same per-market surfacing the sequential
sweep produced.

> **effective cadence = `max(BOOK_POLL_MS, one-batch latency)`**

One sweep is one request, so market count no longer multiplies the sweep cost.
What remains is a single round trip.

**Measured, not assumed.** A 260-second live run over 30 tracked markets
recorded `bookSweep = { sweeps: 45, meanMs: 446, maxMs: 1268 }` in
`data/quality/manifest.json`, with 30 of 30 markets present in every sweep and
zero errors. Before batching, the same workload cost 0.54-1.76 s per `/book`
request, so 30 markets meant 15-50 s per sweep. The interval is now the binding
constraint rather than the sweep, which is the first time the documented 5s
cadence has actually been achieved.

**Why this matters beyond documentation.** The interval is load-bearing on the
headline statistic. `detectTouches` (`src/collector/trades.ts`) derives an
inferred touch's `size` as the net depth reduction at the touched level **between
consecutive** snapshots:

```ts
const size = Math.max(0, levelSize(prev.bids, prevBestBid) - levelSize(next.bids, prevBestBid));
```

A longer real interval means more intervening fills are folded into each inferred
touch, so inferred touch `size` runs **larger** than the documented 5s interval
implies. Those sizes are the `takerSize` argument to `applyQueueModel`
(`src/analysis/queueModels.ts`), whose `medianFill` computes
`p = min(1, takerSize / queueAhead)` and returns it as `fillFraction` — the
fill fractions behind the headline p50. A stated cadence the collector does not
deliver would therefore have made that p50 unreadable, in the conservative
direction: real inferred touches are coarser than "every 5 seconds" suggests.

**What is NOT invalidated.** The existing lower-bound caveat stands unchanged: an
add at the touched level between two polls is indistinguishable from a fill, so
`size` remains a lower bound regardless of the interval. The interval lengthens
that bound's window; it does not weaken the argument. Non-distinguishing of a
cancellation from a fill, and the non-detection of a partial fill that does not
move the best level, are likewise untouched.

**Made observable rather than inferred.** `BookPoller.sweepStats()` reports
`{ sweeps, meanMs, maxMs }` for the sweeps that actually completed, and
`writeManifest` writes it to `data/quality/manifest.json` as `bookSweep`. The
manifest is already uploaded by the recorder workflow and already rewritten on
every process exit, so this adds a field to an existing artifact rather than
creating a new one. Mean *and* max are reported, not last: a last value is one
noisy sample, and a mean alone hides the slow sweeps that stretch the cadence
furthest; `sweeps` lets a reader discount a statistic computed from few samples.
Paths where no sweep ever ran — universe-discovery failure, `--dry-run`, empty
universe — report `null`, never `0`, because a `0` ms sweep would read as a
healthy instantaneous sweep rather than as "never ran".

**Deliberately not done.** `BOOK_POLL_MS` is unchanged: altering it would change
collection behaviour and the storage-cost rationale that depends on it. The
reentrancy guard was not touched. And no per-sweep gap entry was added: at
roughly one sweep per 8s over 30 days that is ~324,000 log lines, which would
swamp the durable gap log and the uploaded gap files under one repeating entry —
the same failure mode §11's rate limiting exists to prevent.

**Superseded: "the sweep was not parallelised."** The original text here
declined to parallelise the sweep because that would raise request concurrency
against a public API. Batching is not an argument against that — it takes a
sweep from 30 requests to 1, so concurrency against the public API goes **down**.
The reason for avoiding a concurrent fan-out no longer applies, and the sweep is
now a single request rather than 30 sequential ones.

Tests in `src/collector/bookPoller.test.ts` pin the reporting: `null` before any
sweep, one sweep counted per completed pass, a multi-market pass counted once,
finite non-negative durations with `maxMs >= meanMs`, and a guard-dropped
reentrant call not counted as a sweep. They assert counts and shapes, never a
wall-clock duration, which would be flaky.

## 13. Neither public feed exposes fills; only a book-diff size drop carries fill evidence

**Measured 2026-10-08, after collection had started.** Three public read-only sources were
probed over the tracked 30-market universe. None of them reports a trade print:

| Source | Carries | Fill information |
|---|---|---|
| `GET /clob.polymarket.com/book` | full depth | only a net size DROP at a level between consecutive snapshots |
| `price.polymarket` on `ws-live-v2` | `best_bid`, `best_ask` | **none** — no `size`, no `side` |
| `price_changes` on `ws-subscriptions-clob` | `price`, `size`, `side`, `best_bid`, `best_ask` | **none in practice** — see below |

**`QuoteTouch` therefore stays empty.** `detectTouches` (`src/collector/trades.ts:33`)
fires only when the best ask moves up or the best bid moves down. Measured: **0** such
moves across 1,320 consecutive book pairs, and **0** across 151 `price_changes` events.
`npm run analyze` on real collected data fails with `no QuoteTouch records in window`, so
**the analysis half has never executed end to end on real data** — only against fixtures.
`MIN_FILLS_FOR_VERDICT = 100` is unreachable under the current fill rule.

**The `price_changes` negative result.** A 200s live capture recorded 151 entries across
19 conditions. **151 of 151 had `size == 0`** — a level *removal* — and **0** had
`size > 0`. None occurred at the touch (`price == bestBid` or `bestAsk`: 0), and none
implied a best-price move. So this channel reports cancellations, not fills, despite
carrying the fields a fill would need. It is recorded to `kind=change` verbatim
(`PriceChange`, `src/shared/schema.ts`) precisely because that negative result needed
evidence rather than inference — but it is not a fill source.

**What the only remaining signal is.** A net size DROP at the touched level between two
consecutive book snapshots: **47 such events per 260s** across 30 markets, extrapolating to
~15,600/day. These are currently **discarded** — `detectTouches` ignores them. They are the
only fill evidence any in-scope public source produces.

**The ambiguity is irreducible, not an implementation gap.** `src/collector/trades.ts:12-14`
already states it: an add at the touched level between polls is indistinguishable from a
fill, and a cancellation of the best level is indistinguishable from a fill. No sampling
cadence removes this, because the two produce identical observations. The recorded
per-market volume — $475,251 across the 30 tracked markets over 24h, with only 4 of 30
showing zero — confirms these markets do trade; the trade simply does not turn the touch
over within any interval this collector can sample.

**Deliberately undecided.** Whether a size drop is counted as a fill, a cancel, or
something in between is a pre-registration question and is **not** settled here. The two
live options pull in opposite directions: counting every drop as a fill makes the fill rate
and the markout both **optimistic**, contradicting the pessimistic stance
`trades.ts:10-16` takes deliberately; counting none yields no sample at all. What the data
supports is recording the drop as its own kind so the rule can be chosen in analysis and
tested, rather than assumed in the collector.

## 14. `kind=drop`: the size-drop signal, recorded and unclassified

**Added 2026-10-08.** `detectSizeDrops` (`src/collector/trades.ts`) compares consecutive book
snapshots and emits a `SizeDrop` whenever the size at a **best** level decreases. It is
written to `kind=drop` and deliberately **not** classified as a fill.

**Why this and not a change to `detectTouches`.** §13 established that no in-scope public
feed reports a trade print, and that the best-price move `detectTouches` keys on occurs ~0
times. The two detectors are complementary rather than competing: `detectTouches` fires on a
best-PRICE move, `detectSizeDrops` on a best-level size DECREASE at a stationary price. A
price move also removes the prior level, so it produces a drop with `nextSize = 0` — both
records then describe one event, and deciding whether that is one fill or two is a
caller's job, not the collector's.

**Only decreases are written.** Increases would add ~10,400 candidate rows/day and, because
the writer emits a part file per partition per flush, ~360 extra files/min on top of ~540 —
for data the fill question does not need. Measured cost of the decrease-only rule: **82 drop
files against 1,410 book files** over a 260s run, i.e. ~5.8%.

**Measured 2026-10-08, 260s, 30 markets.** `drop: 98` recorded, alongside `book: 1410`,
`tob: 7050`, `change: 119`, `touch: 0`. Sides roughly balanced (46 BUY / 52 SELL) across 26
distinct conditions, extrapolating to **~32,600/day** — comfortably above
`MIN_FILLS_FOR_VERDICT = 100`, which the price-move rule could never reach.

**The one substantive clue, stated as observation and not conclusion.** All 98 drops were
**partial** (level shrank but survived); **0** were a level removed outright. The samples
chain, e.g. bid 0.33 going 2505.31 → 2385.31 → 2293.51. Size being consumed at a stationary
price is a different signature from a cancellation, which ordinarily zeroes the level —
recall the CLOB `price_changes` feed in §13, which reported 151 of 151 entries at `size == 0`
and so *was* reporting removals. That the two populations differ is a reason to think these
drops are consumption rather than cancellation. It is **not** proof: a partial cancel looks
the same, and nothing in the data can separate them.

**Still undecided.** Whether a `SizeDrop` is a fill, and if so with what queue treatment,
remains a pre-registration question. `MIN_FILLS_FOR_VERDICT = 100` now looks reachable, but
reaching it by counting every drop as a fill makes the fill rate and the markout both
**optimistic**, against the deliberately pessimistic stance in `trades.ts:10-16`. The
analysis half must choose the rule and state its bias direction before any verdict is read.

## 15. The headline fill rule is not identifiable from book snapshots

**2026-10-08.** `MIN_FILLS_FOR_VERDICT` gates the study's headline rule, and the fill count it
requires is **0 or unknowable** for every event book data can present. See `docs/THRESHOLDS.md`
for the amendment-log entry. Summary:

- `detectTouches` can only fire when a level **vanishes** (ask up, bid down, side emptied), so
  its `size` is a **lower bound** equal to the prior level's size — which is exactly
  `queueAhead`. `trades.ts:12` already states `size` is a lower bound.
- Therefore for every touch, `size === queueAhead`, leftover `= size − queueAhead = 0`, and
  `pessimisticFill` correctly declines to claim a fill. **This is the model working.** A test
  pins it: `pessimisticFill(100, 100, 100)` → no fill.
- `kind=drop` records the other case. Measured: **52 of 52 were partial** (level survived),
  **0** were full removals. A surviving level proves `takerSize < queueAhead`, so a resting
  maker provably does not fill — a **proven zero**, not an absence of evidence.
- `kind=touch` and `kind=drop` are **disjoint populations**: touches are always full removals,
  drops are always partial reductions.

**Consequence.** Pessimistic fills are 0 wherever provable and unknown elsewhere, so the floor
cannot be met. `pessimisticFill` was NOT modified — an earlier attempt to change
`takerSize > queueAhead` to `>=` was reverted after `queueModels.test.ts` failed on
`pessimistic partial fill: leftover after the queue is consumed`, which asserts the intended
leftover semantics. The limit is in the observation, not the model.

**Median model is overstated by ~20x.** Case A sets `min(1, size/queueAhead) = 1.0` exactly, so
the `+0.50c` median p50 at +30s assumes certain fill on every touch. The drop-derived median
fill fraction is `p50 = 0.044` (`p10 0.002`, `p90 0.176`). The touch-weighted figure must not
be read as a maker-economics result.

**Retained.** Post-event markout after a touch or drop is computable and is reported as an
**event study** — a different question, labelled as such. Whether a resting maker fills is not
claimed. Answering that needs trade prints (on-chain or purchased), which is a scope decision
not taken here.
