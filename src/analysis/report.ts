/**
 * Report emitters: Markdown (human) + JSON (machine-readable summary).
 *
 * Honesty rules enforced here:
 *   - The PESSIMISTIC model is the headline everywhere. Optimistic is context.
 *   - Sample sizes are reported alongside every distribution.
 *   - Data-coverage warnings (manifest gaps, missing samples) surface in the
 *     report. If >= 30% of expected samples are missing, it is called out.
 */

import type { RebateAccrual } from './rebates.js';
import type { FillRateResult } from './fillRate.js';
import type { RoundTripSummary } from './roundTrip.js';
import type { Distribution, QueueModelName, TakerShareResult } from './types.js';
import type { Verdict } from './verdict.js';

export interface MarkoutCell {
  model: QueueModelName;
  horizonSeconds: number;
  dist: Distribution | null;
}

export interface CoverageReport {
  expectedSamples: number | null;
  observedSamples: number;
  missingFraction: number | null;
  gapsCount: number;
  warnings: string[];
}

export interface AnalysisResult {
  meta: {
    verdictVersion: string;
    evaluatedAt: string;
    dataDir: string;
    from: string | null;
    to: string | null;
    verdictHorizonSeconds: number;
    counts: {
      books: number;
      tops: number;
      touches: number;
      fillsPessimistic: number;
    };
  };
  verdict: Verdict;
  markouts: MarkoutCell[];
  fillRates: FillRateResult[];
  takerShare: TakerShareResult;
  rebates: RebateAccrual;
  roundTrips: RoundTripSummary;
  coverage: CoverageReport;
}

const MISSING_THRESHOLD = 0.3;

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function distCells(cell: MarkoutCell): string {
  if (cell.dist === null) return 'n=0 — no samples';
  const d = cell.dist;
  return (
    `n=${d.n} (w=${d.nWeighted.toFixed(1)}) mean=${d.mean.toFixed(3)}c ` +
    `p10=${d.p10.toFixed(3)} p25=${d.p25.toFixed(3)} p50=${d.p50.toFixed(3)} p75=${d.p75.toFixed(3)} p90=${d.p90.toFixed(3)}`
  );
}

export function renderMarkdown(r: AnalysisResult): string {
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push('# Polymarket Maker Economics — Analysis Report');
  push('');
  push(`- verdictVersion: \`${r.meta.verdictVersion}\``);
  push(`- evaluatedAt: \`${r.meta.evaluatedAt}\``);
  push(`- data-dir: \`${r.meta.dataDir}\``);
  push(`- window: ${r.meta.from ?? '(unbounded)'} .. ${r.meta.to ?? '(unbounded)'}`);
  push(`- verdict horizon: ${r.meta.verdictHorizonSeconds}s`);
  push('');

  push('## Overall verdict');
  push('');
  push(`**${r.verdict.overall}**`);
  push('');
  for (const reason of r.verdict.reasons) {
    push(`- ${reason}`);
  }
  push('');

  push('## Pre-registered rules (every rule, pass or fail)');
  push('');
  push('| rule | status | threshold | actual | detail |');
  push('| --- | --- | --- | --- | --- |');
  for (const rule of r.verdict.rules) {
    const actual = rule.actual === null ? 'n/a' : rule.actual.toFixed(4);
    push(`| ${rule.id} | ${rule.status} | ${rule.threshold} | ${actual} | ${rule.detail} |`);
  }
  push('');

  push('## Data coverage');
  push('');
  push(`- book snapshots: ${r.meta.counts.books}`);
  push(`- top-of-book rows: ${r.meta.counts.tops}`);
  push(`- quote touches: ${r.meta.counts.touches}`);
  push(`- pessimistic fills: ${r.meta.counts.fillsPessimistic}`);
  if (r.coverage.expectedSamples !== null) {
    push(
      `- expected samples (manifest): ${r.coverage.expectedSamples} — observed ${r.coverage.observedSamples} ` +
        `(missing ${r.coverage.missingFraction === null ? 'n/a' : fmtPct(r.coverage.missingFraction)})`,
    );
    if (r.coverage.missingFraction !== null && r.coverage.missingFraction >= MISSING_THRESHOLD) {
      push(
        `- ⚠️ WARNING: >= ${fmtPct(MISSING_THRESHOLD)} of expected samples are missing. Results may be unrepresentative.`,
      );
    }
  } else {
    push('- no data/quality/manifest.json found; expected sample count unknown.');
  }
  push(`- gap records (JSONL): ${r.coverage.gapsCount}`);
  for (const w of r.coverage.warnings) {
    push(`- warning: ${w}`);
  }
  push('');

  push('## Markout (adverseCents; positive = against us)');
  push('');
  push('Headline is the **pessimistic** model. Optimistic is an upper bound, shown for context only.');
  push('');
  for (const horizon of [1, 5, 30, 60]) {
    push(`### +${horizon}s`);
    push('');
    for (const model of ['pessimistic', 'median', 'optimistic'] as QueueModelName[]) {
      const cell = r.markouts.find((c) => c.model === model && c.horizonSeconds === horizon);
      const prefix = model === 'pessimistic' ? '**pessimistic**' : model;
      push(`- ${prefix}: ${cell === undefined ? 'n/a' : distCells(cell)}`);
    }
    push('');
  }

  push('## Fill rates');
  push('');
  push('| placement | model | touches | fill rate | skipped |');
  push('| --- | --- | --- | --- | --- |');
  for (const fr of r.fillRates) {
    push(
      `| ${fr.placement} | ${fr.model} | ${fr.total} | ${fmtPct(fr.fillRate)} | ${fr.skipped} |`,
    );
  }
  push('');

  push('## Taker share T/(M+T)');
  push('');
  if (r.takerShare.takerShare === null) {
    push('- takerShare: **null** (could not be measured from the data)');
  } else {
    push(`- takerShare: ${r.takerShare.takerShare.toFixed(4)}`);
  }
  push(`- taker volume (T): ${r.takerShare.takerVolume}`);
  push(`- maker volume (M): ${r.takerShare.makerVolume}`);
  push(`- method: ${r.takerShare.method}`);
  push(`- samples: ${r.takerShare.samples}`);
  for (const w of r.takerShare.warnings) {
    push(`- warning: ${w}`);
  }
  push('');

  push('### Taker share per market');
  push('');
  push(
    'The headline above is the pooled ratio sum(T)/sum(T+M), NOT the mean of the per-market ratios. Sorted by taker volume.',
  );
  push('');
  if (r.takerShare.byMarket.length === 0) {
    push('- no markets');
  } else {
    push('| conditionId | takerShare | taker vol (T) | maker vol (M) | samples | notes |');
    push('| --- | --- | --- | --- | --- | --- |');
    for (const m of r.takerShare.byMarket) {
      const share = m.takerShare === null ? 'null' : m.takerShare.toFixed(4);
      const notes = m.warnings.length > 0 ? `⚠️ ${m.warnings.length} bias warning(s)` : '';
      push(`| ${m.conditionId} | ${share} | ${m.takerVolume} | ${m.makerVolume} | ${m.samples} | ${notes} |`);
    }
  }
  push('');

  push('## Rebate accrual');
  push('');
  push(`- total rebate: ${r.rebates.totalRebate.toFixed(6)} (shares·$)`);
  push(`- per-fill average: ${r.rebates.perShareAverage.toFixed(6)}`);
  push(`- fills: ${r.rebates.fills}`);
  push(`- categories applied: ${JSON.stringify(r.rebates.categories)}`);
  for (const w of r.rebates.warnings) {
    push(`- warning: ${w}`);
  }
  push('');

  push('## Round trips (FIFO, pessimistic fills)');
  push('');
  push(`- trips: ${r.roundTrips.trips}`);
  push(`- matched shares: ${r.roundTrips.matchedShares}`);
  push(`- avg holding: ${r.roundTrips.avgHoldingSeconds.toFixed(2)}s`);
  push(`- gross PnL: ${r.roundTrips.grossPnlCentsSum.toFixed(2)}c`);
  push(`- gross edge: ${r.roundTrips.grossEdgeBps.toFixed(1)} bps`);
  if (r.roundTrips.perTripGrossPnlCents !== null) {
    const d = r.roundTrips.perTripGrossPnlCents;
    push(`- per-trip gross PnL: n=${d.n} mean=${d.mean.toFixed(3)}c p50=${d.p50.toFixed(3)}c`);
  }
  push('');

  return lines.join('\n');
}

export function renderJson(r: AnalysisResult): string {
  return JSON.stringify(r, null, 2);
}
