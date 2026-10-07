import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyParquetFile,
  mapBookSnapshot,
  mapQuoteTouch,
  mapTopOfBook,
  readQualityFiles,
  toLevels,
} from './parquetRead.js';
import { renderMarkdown, type AnalysisResult, type CoverageReport } from './report.js';

// The real layout, verbatim from src/collector/writer.ts:
//   data/dt=YYYY-MM-DD/condition=<conditionId>/kind=<book|tob|touch>/part-<HHMMSS>.parquet
const PART = 'part-120000.parquet';
const base = 'data/dt=2024-01-02/condition=0xabc';

test('classifyParquetFile reads the collector kind= segment for all three kinds', () => {
  assert.equal(classifyParquetFile(`${base}/kind=book/${PART}`), 'books');
  assert.equal(classifyParquetFile(`${base}/kind=tob/${PART}`), 'tops');
  assert.equal(classifyParquetFile(`${base}/kind=touch/${PART}`), 'touches');
});

test('regression: kind=tob must be tops, not unknown', () => {
  // A `/top/`-style keyword match does NOT catch "tob". Classifying it as
  // unknown silently drops every mid, which empties the markout distribution
  // rather than raising — the failure this test exists to prevent.
  assert.notEqual(classifyParquetFile(`${base}/kind=tob/${PART}`), 'unknown');
});

test('classifyParquetFile falls back to keywords when there is no kind= segment', () => {
  assert.equal(classifyParquetFile('data/books/part-0.parquet'), 'books');
  assert.equal(classifyParquetFile('data/tops/part-0.parquet'), 'tops');
  assert.equal(classifyParquetFile('data/quotes/part-0.parquet'), 'touches');
  assert.equal(classifyParquetFile('data/mystery/part-0.parquet'), 'unknown');
});

test('toLevels normalizes both tuple and struct level encodings', () => {
  assert.deepEqual(toLevels([[0.5, 100], [0.49, 50]]), [
    [0.5, 100],
    [0.49, 50],
  ]);
  assert.deepEqual(toLevels([{ price: 0.5, size: 100 }]), [[0.5, 100]]);
  assert.deepEqual(toLevels(undefined), []);
});

test('regression: toLevels parses the JSON-text encoding the collector writes', () => {
  // writer.ts emits JSON.stringify(bids) as a JSON column. If this returned [],
  // restingSizeAtPrice would be 0 everywhere and takerShare would compute as
  // exactly 1.0 -- a fabricated number, not a measurement.
  assert.deepEqual(toLevels('[[0.49,100],[0.48,50]]'), [
    [0.49, 100],
    [0.48, 50],
  ]);
  assert.deepEqual(toLevels(''), []);
  assert.deepEqual(toLevels('not json'), []);
});

test('row mappers read schema column names and coerce nulls', () => {
  const tob = mapTopOfBook({
    ts: '1700000000000',
    conditionId: 'c',
    tokenId: 't',
    bestBid: 0.49,
    bestAsk: null,
    mid: null,
    spread: null,
  });
  assert.equal(tob.ts, '1700000000000');
  assert.equal(tob.bestBid, 0.49);
  assert.equal(tob.bestAsk, null, 'a null DOUBLE must stay null, not become 0');
  assert.equal(tob.mid, null);

  const book = mapBookSnapshot({
    ts: '1',
    recvTs: '1',
    conditionId: 'c',
    tokenId: 't',
    bids: JSON.stringify([[0.49, 100]]),
    asks: JSON.stringify([[0.5, 100]]),
    tickSize: 0.01,
    minOrderSize: 5,
  });
  assert.deepEqual(book.bids, [[0.49, 100]]);
  assert.equal(book.minOrderSize, 5);

  const touch = mapQuoteTouch({
    ts: '1',
    conditionId: 'c',
    tokenId: 't',
    side: 'SELL',
    price: 0.49,
    size: 30,
    bookTs: '1',
    queueAhead: 12,
  });
  assert.equal(touch.side, 'SELL');
  assert.equal(touch.queueAhead, 12);
});

// ---------------------------------------------------------------------------
// Coverage / missing-sample reporting.
//
// extractExpectedCount() and buildCoverage() in src/analysis/index.ts are
// module-private and are deliberately NOT exported for testing, so everything
// below is pinned at the two reachable surfaces instead:
//
//   1. readQualityFiles()  -- the read boundary. Proves a manifest written the
//      way the collector writes one carries no `expected` field, which is why
//      extractExpectedCount() can only ever return null.
//   2. renderMarkdown()    -- the only exported consumer of CoverageReport.
//      Proves what a reader is actually told.
// ---------------------------------------------------------------------------

/** Byte-for-byte the object writeManifest() in src/collector/index.ts builds. */
const COLLECTOR_MANIFEST = {
  startTime: '2026-10-07T00:00:00.000Z',
  endTime: '2026-10-07T01:00:00.000Z',
  marketCount: 1,
  marketsTracked: [
    { conditionId: '0xabc', tokenId: '0xtok', category: 'Other', question: 'q?', slug: 'q' },
  ],
  recordCounts: { books: 720, tops: 3600, touches: 41 },
  totalGapSeconds: 0,
};

function withTempDataDir(fn: (dataDir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'quality-'));
    try {
      await fn(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test(
  'a collector-written manifest is found and parsed, but carries no expected field',
  withTempDataDir(async (dataDir) => {
    mkdirSync(path.join(dataDir, 'quality'), { recursive: true });
    writeFileSync(
      path.join(dataDir, 'quality', 'manifest.json'),
      JSON.stringify(COLLECTOR_MANIFEST, null, 2),
    );

    const { manifest } = await readQualityFiles(dataDir);

    // The file WAS read. This is the fact the report used to deny.
    assert.notEqual(manifest, null, 'manifest.json must be found, not treated as absent');
    assert.equal(manifest?.['marketCount'], 1);
    assert.deepEqual(manifest?.['recordCounts'], COLLECTOR_MANIFEST.recordCounts);

    // QualityManifest declares `expected` as required, but the collector never
    // writes it and the parser casts without validating, so it is undefined.
    // extractExpectedCount() therefore returns null on every run, which is what
    // makes buildCoverage()'s missing-fraction warning unreachable.
    assert.equal(
      manifest?.expected,
      undefined,
      'writeManifest writes no `expected` key; this is what keeps the guard inert',
    );
  }),
);

test(
  'no manifest at all is reported as absent',
  withTempDataDir(async (dataDir) => {
    const { manifest } = await readQualityFiles(dataDir);
    assert.equal(manifest, null);
  }),
);

/** Minimal fully-typed AnalysisResult; only `coverage` varies per test. */
function makeResult(coverage: CoverageReport): AnalysisResult {
  return {
    meta: {
      verdictVersion: 'test',
      evaluatedAt: '2026-10-07T00:00:00.000Z',
      dataDir: 'data',
      from: null,
      to: null,
      verdictHorizonSeconds: 30,
      counts: { books: 720, tops: 3600, touches: 41, fillsPessimistic: 0 },
    },
    verdict: {
      verdictVersion: 'test',
      evaluatedAt: '2026-10-07T00:00:00.000Z',
      horizonSeconds: 30,
      overall: 'INSUFFICIENT_DATA',
      rules: [],
      reasons: [],
    },
    markouts: [],
    fillRates: [],
    takerShare: {
      takerShare: null,
      takerVolume: 0,
      makerVolume: 0,
      method: 'none',
      samples: 0,
      warnings: [],
      byMarket: [],
    },
    rebates: { totalRebate: 0, perShareAverage: 0, fills: 0, categories: {}, warnings: [] },
    roundTrips: {
      trips: 0,
      matchedShares: 0,
      avgHoldingSeconds: 0,
      grossPnlCentsSum: 0,
      grossEdgeBps: 0,
      perTripGrossPnlCents: null,
    },
    coverage,
  };
}

const NOT_FOUND = 'no data/quality/manifest.json found';
const NO_EXPECTED_COUNTS = 'manifest found and read, but it carries no expected-sample counts';

test('regression: a manifest that WAS read is never reported as not found', () => {
  // The state every real run lands in: the collector wrote manifest.json, it was
  // parsed, and it carries no expected counts. The old code printed NOT_FOUND
  // here, which was simply false.
  const md = renderMarkdown(
    makeResult({
      expectedSamples: null,
      observedSamples: 41,
      missingFraction: null,
      gapsCount: 2,
      manifestPresent: true,
      warnings: [],
    }),
  );

  assert.equal(md.includes(NOT_FOUND), false, `claimed an absent manifest:\n${md}`);
  assert.equal(md.includes(NO_EXPECTED_COUNTS), true, `no truthful line emitted:\n${md}`);
  // The trustworthy half of the section is still reported.
  assert.equal(md.includes('- gap records (JSONL): 2'), true);
});

test('regression: expectedSamples null can never emit the >= 30% missing warning', () => {
  const md = renderMarkdown(
    makeResult({
      expectedSamples: null,
      observedSamples: 41,
      missingFraction: null,
      gapsCount: 0,
      manifestPresent: true,
      warnings: [],
    }),
  );

  assert.equal(md.includes('of expected samples are missing'), false, `warning fired:\n${md}`);
  assert.equal(md.includes('- expected samples (manifest)'), false);
});

test('an absent manifest renders differently from a manifest with no expected counts', () => {
  const absent = renderMarkdown(
    makeResult({
      expectedSamples: null,
      observedSamples: 41,
      missingFraction: null,
      gapsCount: 0,
      manifestPresent: false,
      warnings: [],
    }),
  );
  const presentNoCounts = renderMarkdown(
    makeResult({
      expectedSamples: null,
      observedSamples: 41,
      missingFraction: null,
      gapsCount: 0,
      manifestPresent: true,
      warnings: [],
    }),
  );

  assert.equal(absent.includes(NOT_FOUND), true, `absent case lost its line:\n${absent}`);
  assert.equal(presentNoCounts.includes(NOT_FOUND), false);
  assert.equal(absent.includes(NO_EXPECTED_COUNTS), false);
  // The absent case states the reason exactly once. index.ts used to push the
  // same sentence into coverage.warnings as well, so it printed twice.
  assert.equal(absent.split(NOT_FOUND).length - 1, 1, `duplicated line:\n${absent}`);
});

test('the >= 30% warning path still works if a manifest ever does carry counts', () => {
  // Pins the shape of the check that has never run, and pins MISSING_THRESHOLD
  // at 0.3 without changing it. If someone later populates `expected`, this is
  // the behaviour they get.
  const overThreshold = renderMarkdown(
    makeResult({
      expectedSamples: 100,
      observedSamples: 50,
      missingFraction: 0.5,
      gapsCount: 0,
      manifestPresent: true,
      warnings: [],
    }),
  );
  const underThreshold = renderMarkdown(
    makeResult({
      expectedSamples: 100,
      observedSamples: 95,
      missingFraction: 0.05,
      gapsCount: 0,
      manifestPresent: true,
      warnings: [],
    }),
  );

  assert.equal(overThreshold.includes('>= 30.00% of expected samples are missing'), true);
  assert.equal(overThreshold.includes('- expected samples (manifest): 100'), true);
  assert.equal(underThreshold.includes('of expected samples are missing'), false);
  assert.equal(underThreshold.includes('(missing 5.00%)'), true);
});