# Polymarket Maker-Economics Study

**What this is.** A read-only, paper-trading measurement experiment. It records Polymarket's public market-data feed (order-book snapshots and trade prints), then replays a hypothetical two-sided market maker over that data to measure whether the maker's edge survives adverse selection. By design it observes and measures only: it never authenticates, never signs, never holds a wallet, and never places an order — now or planned. Its whole purpose is to turn "is market-making on Polymarket actually viable?" from a viral anecdote into a defensible, pre-registered measurement.

**Why it exists (short version).** The operator encountered a viral post claiming an AI bot turned $200 into $14,300 on Polymarket with a Sharpe of 2.47, "run entirely on Claude Code." The post's author later admitted to prompting with "use fictional Anthropic engineer." Independent research then found that 68.8% of Polymarket accounts lose money, that the profitable accounts post passive limit orders while losers cross the spread, and that copy-trading popular wallets measurably underperforms. This project exists to produce a defensible answer instead of another anecdote.

## The explicit non-goal

**This project never places a trade.** There is no authentication, no API keys for trading, no signing, no wallet, and no order-placement code of any kind — not in this repo, and not planned. The collector consumes the *public* feed, which anyone can read anonymously. If you are looking for trading software, this is the opposite. Stating this precisely matters: overstating what this repo does would misrepresent the entire project.

## The single question

**Does the mid move against a hypothetical quote by more than ~1.3¢ per round trip?**

Everything else — the collector, the three-tier data layout, the analysis — exists to answer that one question with a number and its sample size, and nothing more.

## Pre-registered verdict thresholds (fixed BEFORE any data)

The credibility of a negative result depends entirely on these being fixed before anyone sees data. They are hard-coded in `src/shared/config.ts` and recorded in `docs/THRESHOLDS.md`. They must not be tuned after seeing results.

The headline statistic is the **weighted p50 median** of adverse mid movement per round trip, at the +30s horizon, under the pessimistic queue model. **No confidence interval is computed** — the gate on the headline is a raw fill count of 100 pessimistic fills, below which the outcome is `INSUFFICIENT_DATA`.

| Condition | Value | Outcome |
|---|---|---|
| Pessimistic p50 adverse movement | < 1.0¢ | **PASS** |
| Pessimistic p50 adverse movement | 1.0¢ – 1.3¢ inclusive | **MARGINAL** |
| Pessimistic p50 adverse movement | > 1.3¢ (`PESSIMISTIC_FAIL_MARKOUT_CENTS`) | **FAIL** |
| Median-model p50 adverse movement | > 2.0¢ (`MEDIAN_FAIL_MARKOUT_CENTS`) | **FAIL** |
| Measured taker share T/(M+T) | < 0.5 (`TAKER_SHARE_FLOOR`) | **FAIL_TAKER_SHARE** |
| Pessimistic fills | < 100 (`MIN_FILLS_FOR_VERDICT`) | **INSUFFICIENT_DATA** |

Precedence when several rules fire: `INSUFFICIENT_DATA` > `FAIL_TAKER_SHARE` > `FAIL` > `MARGINAL` > `PASS`. Every rule's individual result is reported alongside the headline.

Markout verdicts are reported **pessimistic-model-first**; optimistic-model numbers are context only (see "Honesty" below). `docs/THRESHOLDS.md` also documents two pre-registered constants — `GROSS_EDGE_BPS` (250) and `ADVERSE_SELECTION_BUDGET_CENTS` (1.3) — that are explanatory-only and gate no outcome.

## Quickstart

Prerequisites: Node.js ≥ 20, npm ≥ 9, and enough free disk (the dataset grows over time — see Data layout).

```sh
git clone https://github.com/aidevaccelerator/polymarket-maker-study.git
cd polymarket-maker-study
npm ci                      # or npm install
npm run collect:probe       # connect to the feed, validate schema; writes data/quality/ only
npm run collect             # start recording (long-lived)
npm run analyze             # after data has accumulated: emit report + verdict
```

`collect:probe` connects to the feed and validates the output schema without writing to the dataset: it opens no websocket and writes no parquet, but it does append to `data/quality/gaps-YYYY-MM-DD.jsonl` and overwrite `data/quality/manifest.json` — run it first to confirm the environment works. `collect` records continuously. `analyze` reads whatever has been recorded and emits `reports/analysis.md` (Markdown) and `reports/summary.json` (JSON); it exits 1 if the dataset is empty or unusable. Both paths are overridable with `--data-dir` / `--out-dir`, and `--from` / `--to` bound the time window.

`build` and `test` cover the shared contract and the collector (`src/shared`, `src/collector`) at full strictness — 6 test files, 27 tests. Use `build:all` / `test:all` to include `src/analysis` as well — 15 test files, 83 tests. They are separate so that a half-finished change in the analysis code cannot turn the collector's own build and tests red. `test:all` is the only script that covers the analysis half.

Tests run against compiled output in `dist/`, so a build must precede them. `npm test` and `npm run test:all` each have a `pretest` hook that builds first, so neither can run against a stale or missing `dist/`. Both go through `scripts/run-tests.mjs`, which refuses to report a green when a test source has no emitted test file, when no test files exist at all, or when the aggregate test count disagrees with the sum of the per-file counts.

## Data layout (three tiers)

The dataset lives in `./data/` (gitignored; see `.gitignore`). Three tiers, each sized to the job it does:

1. **Full order book @ 5s** — a full depth snapshot every 5 seconds. The context tier: where the spread and edge actually sit.
2. **Top-of-book @ 1s** — best bid/ask and mid every 1 second. Near-fill mid precision at ~1Hz, but only two levels, so cheap.
3. **Trade prints (events)** — every matched trade with its exact timestamp. The fills themselves.

The rationale: storing full 1 Hz order books across ~20 markets for 30+ days is ~52 million snapshots — most of which is depth that never matters for the verdict. What *does* matter is the mid at the moment of a fill (markout precision), and that is captured by the event stream plus 1s top-of-book. The 5s full book supplies spread/edge context at a fraction of the storage. That is the trade this design makes: precision where it counts, cheap context everywhere else.

The dataset is synced out-of-band — the operator copies `./data` to object storage with `rsync`/`rclone`; it is never committed and never uploaded through Actions.

## Deployment

Two halves, deliberately split across two kinds of runner:

- **Recording** → a self-hosted runner (`.github/workflows/collect.yml`). Recording needs 24/7 uptime; GitHub-hosted runners carry a per-minute quota and a 6-hour job cap, which is fatal for a continuous recorder. A self-hosted runner has no minute quota and may run jobs up to 5 days.
- **Analysis** → a GitHub-hosted runner (`.github/workflows/analyze.yml`). Analysis is short, stateless, and free on hosted runners.

For the self-hosted recorder, the two practical options and their tradeoff:

- **A laptop** — free, but gaps whenever the lid closes and whenever you travel.
- **A cheap always-on box** (~$5–12/mo) — gap-free.

The operator splits time between two countries, which is the deciding factor: a laptop that crosses borders is offline too often to trust, so a gap-free box (or a VPS running `npm run collect` directly) is the practical choice. Before running a self-hosted runner on a **public** repo, read `docs/SECURITY.md` — the trust model is real and the mitigations are not free.

## Honesty

- **A clean FAIL is a valid and valuable outcome.** This repo exists to produce a defensible answer, not to confirm the anecdote that motivated it. "Market-making is not viable on Polymarket" is a useful, publishable result — if the thresholds were fixed in advance (see `docs/THRESHOLDS.md`).
- **Results are reported pessimistic-model-first.** The pessimistic model assumes every fill is adverse (the informed-flow interpretation); the optimistic model gives the benefit of the doubt. The pessimistic model drives the markout verdict; the median model drives an independent rule of its own. Optimistic numbers are context, not evidence.
- **No confidence interval is claimed.** The verdict thresholds a weighted p50 median and is gated by a 100-fill count, and the report prints the full distribution (`n`, weighted `n`, mean, p10–p90) beside the headline. A result close to the 1.3¢ line must be read with that sample size attached; this project makes no claim of a significance level. See `docs/THRESHOLDS.md` for why, and for the dated amendment that replaced an earlier promise of a 95% CI on the mean.
- **There is no data yet.** Everything in this repo is setup, rationale, and pre-registration. Any example output in the docs is labeled ILLUSTRATIVE.

## Repository layout

```
.github/workflows/collect.yml   # 24/7 recorder (self-hosted; builds, then records — runs no tests)
.github/workflows/analyze.yml   # nightly batch (hosted; builds and runs the full 83-test suite)
docs/SECURITY.md                # self-hosted runner trust model (read before running)
docs/THRESHOLDS.md              # pre-registration record (the credibility backbone)
src/shared/                     # shared constants + threshold values
src/collector/                  # feed collector → Parquet
src/analysis/                   # batch analysis → report + verdict
scripts/run-tests.mjs           # test runner + under-reporting guard
data/                           # dataset (gitignored, synced out-of-band)
reports/                        # analysis output (gitignored): analysis.md + summary.json
```

Both entrypoints exist and build: `dist/collector/index.js` and `dist/analysis/index.js`, compiled from `src/collector/index.ts` and `src/analysis/index.ts`.
