# Pre-registered Thresholds

**Status: PRE-REGISTERED — the threshold values in "The pre-registered thresholds"
below were fixed before any data was collected, and none of them has been changed.**

**Date fixed: 2026-10-07.**

> These thresholds are the credibility backbone of this project. A negative result
> ("market-making is not viable") is only meaningful if the pass/fail line was drawn
> *before* anyone saw the data. Changing these numbers after seeing results — even to a
> "more reasonable" value — destroys the finding. They are therefore also hard-coded in
> `src/shared/config.ts` so that the code and this document must be reconciled together
> before any result is reported.

> **On tamper-evidence.** This repository has version history: exactly one commit,
> `9d76b611f13280b8e857a929bdaa1e9ba6bd815c`, the pre-registration commit that froze the
> values below. It is public at <https://github.com/aidevaccelerator/polymarket-maker-study>,
> so any third party can check these threshold values against `src/shared/config.ts` as of
> that commit instead of taking this document's word for it.
>
> The limit is worth stating plainly. One commit means there is no history of *prior*
> versions, so what is covered is "these values have not changed since the pre-registration
> commit" — not "these values were reached by a visible sequence of revisions". A commit
> is not immutable and this repository is not append-only; an amended commit would change
> the hash. The defensible claim is the narrower one: any change after the pre-registration
> commit changes that hash, the hash is recorded here, and it is publicly observable.

## The pre-registered thresholds

All five gating constants live in `src/shared/config.ts`. Their values are unchanged
from the original pre-registration; none was tuned after seeing data.

| Constant | Value | Role | Gates a verdict? |
|---|---|---|---|
| `PESSIMISTIC_FAIL_MARKOUT_CENTS` | **1.3** (1.3¢) | Primary bar. Pessimistic p50 adverse movement strictly above this ⇒ `FAIL`. | **Yes** — Rule 1 |
| `MEDIAN_FAIL_MARKOUT_CENTS` | **2.0** (2.0¢) | Second, independent bar on the median-model p50. Stricter than 1.3 because the median queue model is the more charitable fill assumption. | **Yes** — Rule 2 |
| `TAKER_SHARE_FLOOR` | **0.5** | Minimum measured T/(M+T). Below it ⇒ `FAIL_TAKER_SHARE`, reported separately so it is never confused with a markout failure. | **Yes** — Rule 5 |
| `MARGINAL_LOWER_BOUND_CENTS` | **1.0** (1.0¢) | Lower edge of the `MARGINAL` band `[1.0, 1.3]`. Below 1.0 ⇒ `PASS`. | **Yes** — Rules 3 and 4 |
| `MIN_FILLS_FOR_VERDICT` | **100** fills | Sample-count floor. Fewer pessimistic fills ⇒ `INSUFFICIENT_DATA` instead of any verdict. | **Yes** — gates the headline |

### Constants that gate nothing — read this before citing them

Two pre-registered constants appear in **no** `PASS`/`FAIL` condition. They are used
only inside an explanation string emitted when the taker-share rule fires
(`src/analysis/verdict.ts:167`):

| Constant | Value | Actual use |
|---|---|---|
| `GROSS_EDGE_BPS` | 250 (2.5%) | Appears in the `FAIL_TAKER_SHARE` reason text only. Not compared against anything. |
| `ADVERSE_SELECTION_BUDGET_CENTS` | 1.3 (1.3¢) | Appears in the same reason text only. Not compared against anything. |

They are **explanatory-only**. They state what a taker-share failure *means*
economics-wise; deleting either would change one sentence of prose and no verdict.
Listing them here as if they gated a decision would misrepresent the pre-registration,
so their non-gating status is stated explicitly. Both remain pre-registered and
unchanged.

## Primary threshold: adverse mid movement per round trip

- **Value:** **$0.013** (1.3¢) per round trip — `PESSIMISTIC_FAIL_MARKOUT_CENTS`.
- **Direction:** a hypothetical two-sided quote **passes** when the pessimistic p50
  adverse mid movement per round trip is **< 1.0¢**, is **MARGINAL** in
  **[1.0¢, 1.3¢]**, and **fails** when it is **> 1.3¢**.

### Reasoning

A market maker quoting both sides earns the spread as its edge. On Polymarket, the
smallest meaningful price increment is a cent ($0.01), and the operator's provisional
edge for a completed round trip — buy at the bid, sell at the ask, net of the cost of
unwinding the position — is **1.3¢**.

If the mid moves *against* the quote by more than that 1.3¢ edge before the maker can
unwind, the maker loses money to informed flow on every round trip, and the strategy
fails no matter how often it fills. The experiment therefore measures exactly this —
the realized mid drift between the quote and the markout — and compares it to 1.3¢.

## The statistic: weighted p50 median, with a sample-count floor

- **Statistic:** the **weighted p50 median** of `adverseCents` (the 50th percentile,
  weighted by fill fraction), at the canonical +30s horizon, under the pessimistic queue
  model.
- **Gate:** a **raw fill count** — `MIN_FILLS_FOR_VERDICT = 100` pessimistic fills.
  Below that the outcome is `INSUFFICIENT_DATA`, not a pass and not a fail.
- **No confidence interval is computed.** This project computes no confidence interval,
  no standard error, and no bootstrap interval, on the mean or on the median.

Reasoning for the p50 rather than the mean: adverse movement is heavy-tailed — a handful
of fills during a genuine move dominate an arithmetic mean, so a mean reports the tail
rather than the typical round trip. The median answers "what happens on a typical round
trip", which is the question the 1.3¢ edge bar is about.

Reasoning for a sample-count floor rather than an interval: on a sample of ~100 fills, a
bootstrap confidence interval is noise dressed as precision. A count floor plus the
reported distribution (`n`, weighted `n`, p10/p25/p50/p75/p90) states the sample's actual
extent honestly, without implying a level of inferential precision the data cannot
support.

**The mean is reported but not thresholded.** Every distribution in the report prints
`mean`, `p10`, `p25`, `p50`, `p75`, `p90`, `n`, and weighted `n`. The verdict reads `p50`
only; every other figure is context.

### The gate counts fills; `n` counts samples that produced a markout

These are two different counts, and the report prints both. Conflating them overstates the
evidence behind the headline.

- The **gate** (`MIN_FILLS_FOR_VERDICT = 100`) counts **pessimistic fills**. A fill is
  counted purely on the queue model: the touch cleared `queueAhead` and left a positive
  fill fraction. It requires no mid observation.
- The **`n`** printed beside each distribution counts **samples that produced a markout at
  that horizon** — a fill that additionally had a mid observation at or before the horizon,
  and a parseable timestamp.

They are equal only when every pessimistic fill has a mid at or before the horizon. They
differ whenever a fill has no mid at that horizon, and the gap grows with the horizon: a
fill with no mid within +30s can still have one within +60s, so `n` at +60s is the further
from the fill count of the two. The verdict's p50 is read at +30s, so in general **the p50
the verdict acts on may rest on fewer samples than the fill count that authorised it** —
the count gate can be satisfied while the median behind it rests on a smaller set.

**So judge the +30s p50 by the `n` printed beside it, not by the fill count.** This is the
same instruction the amendment log gives ("a result near the 1.3¢ line must be read with the
reported `n` and percentiles beside it") and the one `README.md` "Honesty" repeats; it is
stated here because the fill count appears in the report too, under Data coverage as
"pessimistic fills", and it is the one that is easier to mistake for the sample size.
`nWeighted`, printed as `w=`, is a further quantity still: a sum of fill fractions, so it
can be smaller than `n` whenever fills are partial.

## Verdict vocabulary

The outcome names below are exactly the five the code emits
(`src/analysis/verdict.ts`, `VerdictOutcome`). Precedence when several rules fire is
`INSUFFICIENT_DATA` > `FAIL_TAKER_SHARE` > `FAIL` > `MARGINAL` > `PASS`. Every individual
rule's result is reported alongside the headline, so no single rule masks another.

| Outcome | Meaning |
|---|---|
| `PASS` | Pessimistic p50 < 1.0¢, median-model p50 ≤ 2.0¢, taker share ≥ 0.5, and ≥ 100 pessimistic fills. |
| `MARGINAL` | Pessimistic p50 lands in [1.0¢, 1.3¢] inclusive. Neither a clear pass nor a clear fail. |
| `FAIL` | Pessimistic p50 > 1.3¢, or median-model p50 > 2.0¢. |
| `FAIL_TAKER_SHARE` | Measured taker share < 0.5. Its own outcome because it is a venue-structure failure, not a markout failure. |
| `INSUFFICIENT_DATA` | Fewer than 100 pessimistic fills, or no median computable. No verdict is claimed. |

### Verdict driver: pessimistic model first

- **Value:** the **pessimistic model** is the only model that drives the markout verdict.
- The **median** model drives its own independent rule (`MEDIAN_FAIL_MARKOUT_CENTS`); the
  **optimistic** model is computed and reported for context only and never flips a
  verdict.

Reasoning: the motivating viral claim (an AI bot turning $200 into $14,300) is the
optimistic story. To be credible, this project reports the worst-case reading first. If
the pessimistic model passes, that is a real result; if only the optimistic model passes,
that is not evidence. See README "Honesty".

### How to read per-rule status

Each entry in a report's `rules` array carries `status: 'PASS' | 'FAIL'` and nothing else;
there is no rule-level `MARGINAL` or any other outcome name. `status: 'FAIL'` means only
that the adverse condition the rule tests for is present, i.e. the rule did not clear; it is
not a claim about `overall`. Rules are evaluated independently against the bounds above.
A `MARGINAL` headline therefore always reports exactly two `FAIL`s: `pessimistic_marginal_band`
fires because the median is inside [1.0¢, 1.3¢], and `pessimistic_pass` fails because that
median is not strictly below 1.0¢ (it fails too when no median is computable). The
precedence chain above still resolves `overall` to `MARGINAL`; `overall` is the only place
the headline is decided.
Worked example, checkable against any report: pess 1.2¢, med 1.2¢, taker share 0.6, 150
fills reports `pessimistic_median_markout_fail` PASS, `median_model_median_markout_fail`
PASS, `pessimistic_marginal_band` FAIL, `pessimistic_pass` FAIL, `taker_share_floor` PASS,
`overall` `MARGINAL`. Every rule is always reported, so none masks another.

### The taker-share measurement is biased upward, so it can mask a genuine failure

`taker_share_floor` (`FAIL_TAKER_SHARE` when measured taker share `< 0.5`) is the one rule
whose measurement can be biased **toward the value that would make it pass**. The ratio is
measured as `T = sum(QuoteTouch.size)` and `M = sum over touches of min(size, resting size
at the touch price in the referenced book)`, and M is undercounted in two ways the code
already detects and warns about:

- the touch references a **missing book snapshot**, so no resting size can be read at all;
- the referenced book has **no resting size at the touch price**, so `resting` is 0.

In both cases the touch's full size is still added to T while nothing is added to M. That
pushes `T/(T+M)` **upward, toward 1.0** — away from the rule's own failure condition, not
toward it. A genuinely low taker share that happens to coincide with missing or unmatched
book depth can therefore be reported above 0.5, and the rule will read `PASS` when the
underlying economics would have failed. This is a limitation of the measurement rather than
a choice: the book depth this study collects is not sufficient to make M exact, and the
floor is not being adjusted to compensate.

**Treat this rule as the least reliable of the five whenever its bias warnings are present.**
The analysis emits a warning for exactly these two conditions, one per affected touch count,
under "Taker share T/(M+T)" in the report, and the per-market table flags affected markets
with a `bias warning(s)` note. That warning text sits in that section, several headings below
the `Overall verdict` and the rules table, and the per-market detail is reduced to a count —
so a report showing `overall: PASS` will **not** visually flag that the `taker_share_floor`
row was reached by a measurement with a known upward bias. This does not automatically
overturn the other four rules, which are thresholded against directly measured per-share
markout; it does mean a `PASS` on this rule is weaker evidence than a `PASS` on rules 1–4.
The measurement is not changed here: altering it would change a reported statistic, and
moving `TAKER_SHARE_FLOOR` would amend a pre-registered value.

## Model parameters fixed in code

The following are not decision thresholds, but they are treated as pre-registered
constants. Their authoritative values live in `src/shared/config.ts` and are listed here
for the record. Any change to them must be a dated code change made *before* data
collection resumes — never a silent tune after seeing results. No value changed when they
were moved into `src/shared/` on 2026-10-07.

| Constant | Value | Role |
|---|---|---|
| `OUR_ORDER_SIZE` | `100` shares | Size of the hypothetical resting order; drives fill fraction, fill size, rebate accrual, and round-trip size. Per-share markout is unaffected. |
| `CANONICAL_HORIZON_MS` | `30_000` ms (+30s) | The single horizon the verdict thresholds are applied at. All four horizons (+1/+5/+30/+60s) are reported; only this one is thresholded. |
| `MIN_PROB` / `MAX_PROB` | `0.3` / `0.7` | Universe filter on Gamma-metadata probability. |
| `MIN_LIQUIDITY_USD` | `25_000` | Best-effort USD liquidity gate (notional at the best level). |
| `MIN_SPREAD_TICKS` | `1` | Universe filter on quoted spread. |
| `ALLOWED_CATEGORIES` | Politics, Finance, Economics | Categories the collector records. |
| `BOOK_POLL_MS` / `TOB_POLL_MS` | `5_000` / `1_000` | Full-book and top-of-book polling cadence. |
| Fee / rebate schedule | `src/shared/fees.ts` | Per-trade costs and maker rebates, transcribed from <https://docs.polymarket.com/trading/fees> (retrieved 2026-10-07). |

This table and `src/shared/config.ts` were reconciled line by line on 2026-10-07. Both
entrypoints (`src/collector/index.ts`, `src/analysis/index.ts`) exist and build.

## Amendment log

- **2026-10-07** — Initial pre-registration. Primary threshold $0.013 fixed. No data has
  been collected or viewed. Any future amendment must be dated here and must occur before
  (not after) data collection, with the reason stated.

- **2026-10-07 — Four constants added after the initial pre-registration.**
  `OUR_ORDER_SIZE = 100`, `MIN_FILLS_FOR_VERDICT = 100`,
  `MARGINAL_LOWER_BOUND_CENTS = 1.0`, and `CANONICAL_HORIZON_MS = 30_000` were declared
  inside `src/analysis/**` and were **not** in the original pre-registration. They are
  now in `src/shared/config.ts` so that the collector half and any reviewer reading the
  contract first can see them. **No value changed** — only the location. This is recorded
  anyway because two of them (`MIN_FILLS_FOR_VERDICT` and `MARGINAL_LOWER_BOUND_CENTS`)
  do gate the verdict, so their existence after the fact is disclosed rather than
  presented as original. `OUR_ORDER_SIZE` and `CANONICAL_HORIZON_MS` do not gate an
  outcome but set the measurement.

- **2026-10-07 — Economics taker fee corrected `0.04` → `0.05`.** The project brief gave
  Economics a taker fee of 0.05 while `src/shared/fees.ts` carried 0.04. The fee schedule
  was re-read from <https://docs.polymarket.com/trading/fees>, **retrieved 2026-10-07**,
  which confirms 0.05. At `rebateFraction = 0.25`, `takerShare = 0.5`, and mid-market
  price the disagreement was worth 25% of the maker rebate on every Economics share, and
  Economics is in `ALLOWED_CATEGORIES`. The shared table was also widened to the full
  documented 11-category set. **No pre-registered threshold was touched** by this
  correction. See `src/analysis/ASSUMPTIONS.md` §6.

- **2026-10-07 — Statistic amended: p50 median + sample-count floor, no confidence
  interval.** This document and `README.md` previously stated that the decision rule was a
  **95% confidence interval on the mean** adverse movement, with outcomes `VIABLE` /
  `NOT VIABLE` / `INCONCLUSIVE`. **The code never computed that.**
  `src/analysis/verdict.ts` thresholds the **weighted p50 median** and substitutes the raw
  fill count `MIN_FILLS_FOR_VERDICT` for any confidence notion; there is no `confidence`,
  `stderr`, `bootstrap`, or `standard error` anywhere in `src/analysis/`. The outcomes it
  emits are `PASS` / `MARGINAL` / `FAIL` / `FAIL_TAKER_SHARE` / `INSUFFICIENT_DATA`.

  **This amends the document, not the code.** The implementation was deliberately kept
  as-is, because on a sample of ~100 fills a bootstrap confidence interval is noise
  dressed as precision; the `MIN_FILLS_FOR_VERDICT` floor plus reported percentiles is the
  more truthful representation of the same uncertainty. The consequence for a reader: a
  result near the 1.3¢ line must be read with the reported `n` and percentiles beside it,
  and this project makes no claim of a significance level. The amendment was made **before
  any data was collected**, so it is not post-hoc threshold movement.

- **2026-10-07 — Documentation reconciled to code.** All five gating thresholds are now
  documented with values and roles; `GROSS_EDGE_BPS` and `ADVERSE_SELECTION_BUDGET_CENTS`
  are documented explicitly as explanatory-only; the stale "the source layer may not exist
  yet" caveat and the value-free placeholder table were removed; and `README.md`'s analysis
  output paths (`reports/analysis.md`, `reports/summary.json`), the analysis test-file count
  (9), and the claim that `collect.yml` runs tests (it runs none) were corrected. No
  threshold value changed.

- **2026-10-07 — Repository placed under version control and published; the "no git
  history" claim corrected as factually stale.** The "On tamper-evidence" note above stated
  that this repository intentionally had no git history and that the guarantee it offered
  was documentary rather than tamper-evident. That was accurate when the document was
  drafted and became false once the repository was published: the pre-registration commit
  is `9d76b611f13280b8e857a929bdaa1e9ba6bd815c` and it is public at
  <https://github.com/aidevaccelerator/polymarket-maker-study>, so any third party can
  verify the threshold values above against `src/shared/config.ts` as of that commit. The
  note is corrected accordingly and now claims only what is true — that any change after
  the pre-registration commit alters the hash, and that the hash is recorded here and
  publicly observable — **not** that the history is immutable or append-only. **No threshold
  value changed**, and no constant, verdict rule, or precedence ordering was touched; this
  is a correction to a claim about the repository's own provenance. Recorded rather than
  quietly applied, on the same footing as the entries above: made after the document was
  drafted but before any data existed. No data has been collected or viewed.