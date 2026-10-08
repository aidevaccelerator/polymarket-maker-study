// Collector entrypoint. Discovers the filtered universe, starts the three-tier
// ingestion pipeline (full book swept every BOOK_POLL_MS, top-of-book @1s,
// inferred trade touches), buffers writes, and shuts down cleanly on
// signal/crash while keeping every committed Parquet file valid.
//
// "Swept every BOOK_POLL_MS", not "full book @5s": BOOK_POLL_MS is the interval
// between attempts, and the achieved cadence is the sequential sweep duration.
// Derivation and the crossover live in the BookPoller class comment; the observed
// sweep cost is recorded in manifest.json as `bookSweep`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOK_POLL_MS, TOB_POLL_MS } from '../shared/config.js';
import { nowIso } from '../shared/time.js';
import { BookPoller } from './bookPoller.js';
import type { BookSweepStats } from './bookPoller.js';
import { GapLog } from './gaps.js';
import { discoverUniverse } from './gamma.js';
import type { TrackedMarket } from './gamma.js';
import { ParquetWriter } from './writer.js';
import { PriceWs, toTopOfBook } from './ws.js';
import { ClobPriceWs } from './clobWs.js';
import type { TopOfBookUpdate } from './ws.js';

const FLUSH_INTERVAL_MS = 5000;

interface CliArgs {
  readonly markets: number;
  readonly durationSeconds: number;
  readonly dataDir: string;
  readonly dryRun: boolean;
}

const USAGE = `usage: node dist/collector/index.js [flags]
  --markets N            number of markets to track (default 30)
  --duration-seconds N   stop after N seconds (default 0 = run forever)
  --data-dir DIR         output root (default ./data)
  --dry-run              discover + print the filtered universe, then exit
`;

function parseCli(argv: readonly string[]): CliArgs {
  let markets = 30;
  let durationSeconds = 0;
  let dataDir = './data';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--markets' || flag === '--duration-seconds' || flag === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      i += 1;
      if (flag === '--markets') markets = Number.parseInt(value, 10);
      else if (flag === '--duration-seconds') durationSeconds = Number.parseInt(value, 10);
      else dataDir = value;
    } else if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!Number.isInteger(markets) || markets < 1) {
    throw new Error('--markets must be a positive integer');
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
    throw new Error('--duration-seconds must be a non-negative integer');
  }
  return { markets, durationSeconds, dataDir, dryRun };
}

function errToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const gapLog = new GapLog(args.dataDir);
  const writer = new ParquetWriter(args.dataDir);
  const startIso = nowIso();

  let markets: readonly TrackedMarket[];
  try {
    const result = await discoverUniverse({ maxMarkets: args.markets });
    markets = result.markets;
    gapLog.log(
      'info',
      `universe: ${markets.length} tracked / ${result.seen} seen / ${result.unparseable} unparseable` +
        ` / ${result.duplicateMarkets} duplicate`,
      {
        context: { rejected: result.rejected },
      },
    );
  } catch (err) {
    gapLog.logError('universe discovery failed', { context: { error: errToString(err) } });
    // No poller was constructed, so no sweep ran: null, not 0.
    writeManifest(args.dataDir, startIso, [], writer.counts(), gapLog.totalGapSeconds(), null);
    process.exit(1);
  }

  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        markets.map((m) => ({ conditionId: m.conditionId, tokenId: m.tokenId, category: m.category, slug: m.slug })),
        null,
        2,
      )}\n`,
    );
    // Dry run stops before any BookPoller exists: null, not 0.
    writeManifest(args.dataDir, startIso, markets, writer.counts(), gapLog.totalGapSeconds(), null);
    return;
  }

  if (markets.length === 0) {
    gapLog.log('info', 'no markets matched the universe filter; exiting');
    // Empty universe, so no poller was started: null, not 0.
    writeManifest(args.dataDir, startIso, [], writer.counts(), gapLog.totalGapSeconds(), null);
    return;
  }

  const latestTob = new Map<string, TopOfBookUpdate>();
  const ws = new PriceWs(
    markets.map((m) => ({ conditionId: m.conditionId, tokenId: m.tokenId })),
    {
      onUpdate: (u) => {
        latestTob.set(u.tokenId, u);
      },
      onDisconnect: (reason) => {
        gapLog.logGap(`ws disconnected: ${reason}`);
      },
      onReconnect: (downtimeSec) => {
        gapLog.logReconnect('ws reconnected', { durationSec: downtimeSec });
      },
    },
  );

  const clobWs = new ClobPriceWs(
    markets.map((m) => ({ conditionId: m.conditionId, tokenId: m.tokenId })),
    {
      onChange: (c) => writer.writeChange(c),
      onUnparsed: () => {
        gapLog.logError('clob ws: unparsed price_change entry');
      },
    },
  );
  clobWs.start();

  const bookPoller = new BookPoller(markets, {
    onBook: (book) => writer.writeBook(book),
    onTouch: (touch) => writer.writeTouch(touch),
    onError: (market, err) => {
      gapLog.logError(`book poll failed`, { context: { conditionId: market.conditionId, error: errToString(err) } });
    },
  });

  // Top-of-book @1s. Primary source is the price.polymarket WebSocket (near
  // real-time best bid/ask; no HTTP budget consumed). Rate budget for a
  // polling fallback: 30 markets x 1Hz = 30 req/s = 300 req/10s, well under
  // the 9,000 req/10s general CLOB limit — documented so a future polling
  // fallback can be added without re-deriving the math.
  const tobTimer = setInterval(() => {
    for (const m of markets) {
      const u = latestTob.get(m.tokenId);
      if (u !== undefined) writer.writeTob(toTopOfBook(u));
    }
  }, TOB_POLL_MS);

  const flushTimer = setInterval(() => {
    try {
      writer.flush();
    } catch (err) {
      gapLog.logError('flush failed', { context: { error: errToString(err) } });
    }
  }, FLUSH_INTERVAL_MS);

  let durationTimer: NodeJS.Timeout | null = null;
  if (args.durationSeconds > 0) {
    durationTimer = setTimeout(() => shutdown(0), args.durationSeconds * 1000);
  }

  let shuttingDown = false;
  function shutdown(exitCode: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(tobTimer);
    clearInterval(flushTimer);
    if (durationTimer !== null) clearTimeout(durationTimer);
    bookPoller.stop();
    ws.close();
    clobWs.close();
    try {
      writer.flush();
    } catch (err) {
      gapLog.logError('final flush failed', { context: { error: errToString(err) } });
    }
    writeManifest(
      args.dataDir,
      startIso,
      markets,
      writer.counts(),
      gapLog.totalGapSeconds(),
      bookPoller.sweepStats(),
    );
    process.exit(exitCode);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (err) => {
    gapLog.logError('uncaught exception', { context: { error: errToString(err) } });
    shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    gapLog.logError('unhandled rejection', { context: { error: errToString(reason) } });
    shutdown(1);
  });

  bookPoller.start(BOOK_POLL_MS);
  ws.start();
}

function writeManifest(
  dataDir: string,
  startIso: string,
  markets: readonly TrackedMarket[],
  counts: ReturnType<ParquetWriter['counts']>,
  totalGapSeconds: number,
  bookSweep: BookSweepStats | null,
): void {
  const qualityDir = join(dataDir, 'quality');
  mkdirSync(qualityDir, { recursive: true });
  const manifest = {
    startTime: startIso,
    endTime: nowIso(),
    marketCount: markets.length,
    marketsTracked: markets.map((m) => ({
      conditionId: m.conditionId,
      tokenId: m.tokenId,
      category: m.category,
      question: m.question,
      slug: m.slug,
    })),
    recordCounts: counts,
    totalGapSeconds,
    // MEASURED full-book sweep cost. `BOOK_POLL_MS` is only the interval between
    // attempts: the sweep is sequential, so the achieved cadence is
    // max(BOOK_POLL_MS, markets x per-request latency) and any tick landing
    // mid-sweep is dropped by the reentrancy guard. Recording the observed sweep
    // here makes the real cadence auditable from this already-uploaded artifact
    // instead of inferred. `null` where no poller ever ran (universe discovery
    // failed, dry-run, empty universe) — never 0, which would read as a healthy
    // instantaneous sweep.
    bookSweep,
  };
  writeFileSync(join(qualityDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

void main();
