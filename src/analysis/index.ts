/**
 * Entrypoint + orchestration for the analysis pipeline.
 *
 * CLI: node dist/analysis/index.js --data-dir <dir> --out-dir <dir> [--from <iso>] [--to <iso>]
 *
 * Reads the collector's Parquet output and emits a machine-readable verdict
 * (Markdown + JSON). Read-only: no order placement, no network calls.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_PROB, MIN_LIQUIDITY_USD, MIN_PROB, OUR_ORDER_SIZE } from '../shared/config.js';
import { computeFillRates } from './fillRate.js';
import {
  buildMidSeries,
  markoutAtHorizon,
  parseTs,
  tryParseTs,
  weightedDistribution,
  type MidPoint,
} from './markout.js';
import { loadDataset } from './parquetRead.js';
import { applyQueueModel, QUEUE_MODELS } from './queueModels.js';
import { accrueRebates, type Category } from './rebates.js';
import { renderJson, renderMarkdown, type AnalysisResult, type CoverageReport, type MarkoutCell } from './report.js';
import { pairRoundTrips, summarizeRoundTrips } from './roundTrip.js';
import { measureTakerShare } from './takerShare.js';
import { evaluateVerdict, VERDICT_VERSION } from './verdict.js';
import type {
  BookLookup,
  Dataset,
  Distribution,
  Fill,
  QueueModelName,
} from './types.js';

interface CliArgs {
  dataDir: string;
  outDir: string;
  from: string | null;
  to: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token !== undefined && token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = '';
      }
    }
  }
  return {
    dataDir: args['data-dir'] ?? 'data',
    outDir: args['out-dir'] ?? 'reports',
    from: args['from'] ?? null,
    to: args['to'] ?? null,
  };
}

/** Aggressor side -> our side (we are the passive maker). */
function ourSideOf(touchSide: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  return touchSide === 'BUY' ? 'SELL' : 'BUY';
}

/** Convert touches into pessimistic fills (headline fill set). */
function touchesToFills(touches: Dataset['touches'], model: QueueModelName): Fill[] {
  const fills: Fill[] = [];
  for (const touch of touches) {
    const outcome = applyQueueModel(model, touch.queueAhead, touch.size, OUR_ORDER_SIZE);
    if (outcome.fillFraction <= 0) continue;
    const tsMs = tryParseTs(touch.ts);
    if (tsMs === null) continue;
    fills.push({
      ts: touch.ts,
      tsMs,
      conditionId: touch.conditionId,
      tokenId: touch.tokenId,
      ourSide: ourSideOf(touch.side),
      price: touch.price,
      size: outcome.fillSize,
      bookTs: touch.bookTs,
      queueAhead: touch.queueAhead,
      takerSize: touch.size,
    });
  }
  return fills;
}

/** Compute markout distributions per model per horizon (fill-fraction weighted). */
function computeMarkouts(
  touches: Dataset['touches'],
  midSeries: MidPoint[],
  horizons: number[],
): { cells: MarkoutCell[]; distributions: Map<QueueModelName, Map<number, Distribution | null>> } {
  const cells: MarkoutCell[] = [];
  const distributions = new Map<QueueModelName, Map<number, Distribution | null>>();

  for (const model of QUEUE_MODELS) {
    const perHorizon = new Map<number, { values: number[]; weights: number[] }>();
    for (const h of horizons) perHorizon.set(h, { values: [], weights: [] });

    for (const touch of touches) {
      const outcome = applyQueueModel(model, touch.queueAhead, touch.size, OUR_ORDER_SIZE);
      if (outcome.fillFraction <= 0) continue;
      const tsMs = tryParseTs(touch.ts);
      if (tsMs === null) continue;
      const ourSide = ourSideOf(touch.side);
      for (const h of horizons) {
        const adv = markoutAtHorizon(midSeries, tsMs, touch.price, ourSide, h);
        if (adv === null) continue;
        const acc = perHorizon.get(h);
        if (acc !== undefined) {
          acc.values.push(adv);
          acc.weights.push(outcome.fillFraction);
        }
      }
    }

    const modelDist = new Map<number, Distribution | null>();
    for (const h of horizons) {
      const acc = perHorizon.get(h);
      const dist = acc === undefined ? null : weightedDistribution(acc.values, acc.weights);
      modelDist.set(h, dist);
      cells.push({ model, horizonSeconds: h, dist });
    }
    distributions.set(model, modelDist);
  }

  return { cells, distributions };
}

function countPessimisticFills(touches: Dataset['touches']): number {
  let n = 0;
  for (const touch of touches) {
    const outcome = applyQueueModel('pessimistic', touch.queueAhead, touch.size, OUR_ORDER_SIZE);
    if (outcome.fillFraction > 0) n += 1;
  }
  return n;
}

/**
 * Sum the manifest's per-kind expected-sample counts, or null when it carries none.
 *
 * ALWAYS RETURNS NULL TODAY. `writeManifest` in src/collector/index.ts writes
 * startTime, endTime, marketCount, marketsTracked, recordCounts and
 * totalGapSeconds — and no `expected` field — so there is nothing to sum. The
 * field is declared on `QualityManifest` (src/analysis/types.ts) and
 * src/analysis/parquetRead.ts parses the file with a bare cast, so a parsed
 * manifest has `expected === undefined` despite the type calling it required.
 *
 * The consequence is that buildCoverage's missing-fraction warning below cannot
 * fire, so no reader is ever told the dataset is too degraded to trust.
 */
function extractExpectedCount(manifest: Dataset['quality']): number | null {
  if (manifest === null) return null;
  const expected = manifest.expected;
  if (typeof expected !== 'object' || expected === null) return null;
  let total = 0;
  let any = false;
  for (const value of Object.values(expected)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Summarize how complete the dataset is. `gapsCount` is the count of records in
 * the append-only JSONL gap files, so it IS cumulative across runs and correct.
 *
 * The missing-fraction half is inert: because extractExpectedCount always
 * returns null, `expectedSamples` and `missingFraction` are always null and the
 * >= 30% branch is unreachable. Adding an `expected` field would not by itself
 * fix it, because `observedSamples` counts in-scope quote TOUCHES, which are
 * event-driven (taker aggression) and have no knowable expected count, while the
 * scheduled cadences (full book @5s, top-of-book @1s) do. Writing `expected` as
 * a plain per-kind sum would compare scheduled-sample expectations against
 * observed touches — a category mismatch. Enabling this guard means deciding
 * which record kinds are compared, which is a design decision, not a missing
 * field. Documented in src/analysis/ASSUMPTIONS.md; the state is pinned by tests
 * in src/analysis/parquetRead.test.ts.
 */
function buildCoverage(dataset: Dataset, observedSamples: number): CoverageReport {
  const expectedSamples = extractExpectedCount(dataset.quality);
  const missingFraction =
    expectedSamples !== null && expectedSamples > 0
      ? Math.max(0, (expectedSamples - observedSamples) / expectedSamples)
      : null;
  const warnings: string[] = [];
  if (missingFraction !== null && missingFraction >= 0.3) {
    warnings.push(
      `${(missingFraction * 100).toFixed(1)}% of expected samples are missing (>= 30%); results may be unrepresentative.`,
    );
  }
  return {
    expectedSamples,
    observedSamples,
    missingFraction,
    gapsCount: dataset.gaps.length,
    manifestPresent: dataset.quality !== null,
    warnings,
  };
}

/** Resolve a market's fee category. Defaults to 'Other' when metadata is absent. */
function defaultCategory(_fill: Fill): Category {
  // The shared schema carries no category field; without a market-metadata
  // source we fall back to the 'Other' schedule. Documented in ASSUMPTIONS.md.
  return 'Other';
}

async function main(): Promise<void> {
  const { dataDir, outDir, from, to } = parseArgs(process.argv.slice(2));

  let dataset: Dataset;
  try {
    dataset = await loadDataset(dataDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: could not read data from "${dataDir}": ${message}`);
    process.exitCode = 1;
    return;
  }

  const hasAnyData =
    dataset.books.length > 0 || dataset.tops.length > 0 || dataset.touches.length > 0;
  if (!hasAnyData) {
    console.error(
      `FATAL: no parquet data found under "${dataDir}". The tool cannot produce a verdict from nothing.`,
    );
    process.exitCode = 1;
    return;
  }

  const fromMs = from !== null ? parseTs(from) : -Infinity;
  const toMs = to !== null ? parseTs(to) : Infinity;

  const bookMap = new Map(dataset.books.map((b) => [b.ts, b] as const));
  const bookLookup: BookLookup = (ts) => bookMap.get(ts);

  let unparseableTouchTs = 0;
  const touches = dataset.touches.filter((t) => {
    const tsMs = tryParseTs(t.ts);
    if (tsMs === null) {
      unparseableTouchTs += 1;
      return false;
    }
    return tsMs >= fromMs && tsMs <= toMs;
  });

  // Pre-registered market filters (constants from config, used as-is):
  //   - price must lie in [MIN_PROB, MAX_PROB]
  //   - best-effort USD liquidity at the touch level must be >= MIN_LIQUIDITY_USD
  // Counted and reported so filtering is never silent.
  const marketFilterExcluded = { price: 0, liquidity: 0, liquidityUnmeasured: 0 };
  const touchesInScope = touches.filter((t) => {
    if (t.price < MIN_PROB || t.price > MAX_PROB) {
      marketFilterExcluded.price += 1;
      return false;
    }
    const book = bookLookup(t.bookTs);
    if (book === undefined) {
      marketFilterExcluded.liquidityUnmeasured += 1; // keep: cannot measure, do not over-filter
      return true;
    }
    const levels = t.side === 'BUY' ? book.asks : book.bids;
    const best = levels[0];
    const bestPrice = best?.[0] ?? 0;
    const bestSize = best?.[1] ?? 0;
    const liquidityUsd = bestPrice * bestSize;
    if (liquidityUsd < MIN_LIQUIDITY_USD) {
      marketFilterExcluded.liquidity += 1;
      return false;
    }
    return true;
  });

  if (touchesInScope.length === 0) {
    console.error(
      `FATAL: no QuoteTouch records in window [${from ?? '-∞'}, ${to ?? '+∞'}] after market filters. Cannot run the analysis.`,
    );
    process.exitCode = 1;
    return;
  }

  const midSeries = buildMidSeries(dataset.tops);

  const horizons = [1, 5, 30, 60];

  // Markout (the core measurement).
  const { cells: markoutCells, distributions } = computeMarkouts(touchesInScope, midSeries, horizons);

  // Fills (pessimistic headline set) for rebates + round trips.
  const pessimisticFills = touchesToFills(touchesInScope, 'pessimistic');
  const pessimisticFillCount = countPessimisticFills(touchesInScope);

  // Taker share, fill rates, rebates, round trips.
  const takerShare = measureTakerShare(touchesInScope, bookLookup);
  const fillRates = computeFillRates(touchesInScope, bookLookup);

  const categoryFor = defaultCategory;
  const rebates = accrueRebates(pessimisticFills, takerShare.takerShare, categoryFor);
  if (pessimisticFills.length === 0) {
    rebates.warnings.push('no pessimistic fills; rebate accrual is zero.');
  }

  const trips = pairRoundTrips(pessimisticFills);
  const avgEntryPrice =
    pessimisticFills.length > 0
      ? pessimisticFills.reduce((s, f) => s + f.price, 0) / pessimisticFills.length
      : 0.5;
  const roundTrips = summarizeRoundTrips(trips, avgEntryPrice);

  // Verdict.
  const pessimistic30 = distributions.get('pessimistic')?.get(30) ?? null;
  const median30 = distributions.get('median')?.get(30) ?? null;
  const verdict = evaluateVerdict({
    pessimisticMedianAdverseCents: pessimistic30?.p50 ?? null,
    medianModelMedianAdverseCents: median30?.p50 ?? null,
    takerShare: takerShare.takerShare,
    pessimisticFillCount,
  });

  const coverage = buildCoverage(dataset, touchesInScope.length);
  // The "no manifest" case is reported once, by renderMarkdown's Data-coverage
  // section, which reads coverage.manifestPresent. It used to be pushed here as
  // a warning too, so a genuinely absent manifest printed the identical sentence
  // twice — once as a coverage line and once as `- warning: ...`.
  if (pessimisticFills.length === 0) {
    coverage.warnings.push('zero pessimistic fills in window — every distribution will be empty.');
  }
  if (marketFilterExcluded.price > 0) {
    coverage.warnings.push(
      `${marketFilterExcluded.price} touches excluded by the price filter [${MIN_PROB}, ${MAX_PROB}].`,
    );
  }
  if (marketFilterExcluded.liquidity > 0) {
    coverage.warnings.push(
      `${marketFilterExcluded.liquidity} touches excluded by the liquidity filter (< ${MIN_LIQUIDITY_USD} USD).`,
    );
  }
  if (marketFilterExcluded.liquidityUnmeasured > 0) {
    coverage.warnings.push(
      `${marketFilterExcluded.liquidityUnmeasured} touches had no book snapshot to measure liquidity; kept (never over-filter).`,
    );
  }
  if (unparseableTouchTs > 0) {
    coverage.warnings.push(
      `${unparseableTouchTs} touches had an unparseable timestamp and were dropped.`,
    );
  }
  const excludedTotal =
    marketFilterExcluded.price + marketFilterExcluded.liquidity;
  if (touches.length > 0 && excludedTotal > touches.length * 0.5) {
    coverage.warnings.push(
      `market filters removed ${excludedTotal} of ${touches.length + excludedTotal} in-window touches (>50%); the surviving sample may not represent the pre-registered universe.`,
    );
  }

  const result: AnalysisResult = {
    meta: {
      verdictVersion: VERDICT_VERSION,
      evaluatedAt: verdict.evaluatedAt,
      dataDir,
      from,
      to,
      verdictHorizonSeconds: verdict.horizonSeconds,
      counts: {
        books: dataset.books.length,
        tops: dataset.tops.length,
        touches: touchesInScope.length,
        fillsPessimistic: pessimisticFillCount,
      },
    },
    verdict,
    markouts: markoutCells,
    fillRates,
    takerShare,
    rebates,
    roundTrips,
    coverage,
  };

  const markdown = renderMarkdown(result);
  const json = renderJson(result);

  await mkdir(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'analysis.md');
  const jsonPath = path.join(outDir, 'summary.json');
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(jsonPath, json, 'utf8');

  console.log(`Verdict: ${verdict.overall}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

void main();
