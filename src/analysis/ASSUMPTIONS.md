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

**Note on scope:** `npm test` runs **only** the shared + collector tests (6 files,
27 tests). It does **not** touch this half. Only `npm run test:all` (15 files, 79
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

Current per-file counts: shared + collector 27 across 6 files; analysis 52 across
9 files; total 79 across 15 files.

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
