/**
 * Reader for the collector's partitioned Parquet output.
 *
 * The exact on-disk layout is owned by the collector agent; this reader is
 * written defensively against that. Assumptions (documented in ASSUMPTIONS.md):
 *   - Parquet files live under `--data-dir`, partitioned Hive-style (e.g.
 *     data/books/..., data/tops/..., data/touches/...). Files are classified by
 *     path keywords: "top" -> TopOfBook, "quote"/"touch" -> QuoteTouch,
 *     "book" -> BookSnapshot.
 *   - Column names match the shared schema interfaces character-for-character.
 *   - `bids`/`asks` decode to either `[price, size][]` (list-of-list) or
 *     `{price, size}[]` (list-of-struct); both are normalized.
 *   - Timestamps are numeric strings (epoch ms) or ISO-8601 (handled by parseTs).
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import type { BookSnapshot, QuoteTouch, TopOfBook } from '../shared/schema.js';
import type { Dataset, GapRecord, QualityManifest } from './types.js';

export type ParquetKind = 'books' | 'tops' | 'touches' | 'unknown';

export const PARQUET_KINDS: readonly ParquetKind[] = ['books', 'tops', 'touches'] as const;

/** Recursively list *.parquet files under `dataDir`. */
export async function listParquetFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.parquet')) {
        files.push(full);
      }
    }
  }
  await walk(dataDir);
  files.sort();
  return files;
}

/**
 * Classify a parquet file into one of the three record kinds.
 *
 * The collector writes `.../kind=<book|tob|touch>/part-*.parquet`, so that
 * segment is authoritative and is read first; keyword matching is only a
 * fallback for other layouts. Keyword matching alone is unsafe here: `kind=tob`
 * is NOT matched by a `/top/` pattern, and dropping top-of-book rows removes
 * every mid, which empties the markout entirely — the core measurement of this
 * study would come back quietly empty instead of erroring.
 */
export function classifyParquetFile(filePath: string): ParquetKind {
  const norm = filePath.toLowerCase();

  const kindSegment = /(?:^|[\\/])kind=([^\\/]+)/.exec(norm);
  if (kindSegment?.[1] !== undefined) {
    switch (kindSegment[1]) {
      case 'book':
        return 'books';
      case 'tob':
      case 'top':
      case 'tops':
      case 'topofbook':
        return 'tops';
      case 'touch':
      case 'touches':
      case 'quote':
      case 'quotes':
        return 'touches';
      default:
        break;
    }
  }

  if (/(top[-_]?of[-_]?book|\btops?\b|\btop\b)/.test(norm)) return 'tops';
  if (/(quote|touch)/.test(norm)) return 'touches';
  if (/book/.test(norm)) return 'books';
  return 'unknown';
}

type RawRow = Record<string, unknown>;

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function asNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a raw parquet level list into [price, size][] tuples.
 *
 * `bids`/`asks` are written as `JSON.stringify(...)` columns, so depending on
 * how hyparquet decodes a JSON-annotated column the value arrives either already
 * parsed or as JSON text. Both are accepted; anything else yields [].
 *
 * Getting this wrong is not cosmetic. Empty levels make
 * `restingSizeAtPrice` return 0 for every touch, which zeroes maker volume and
 * drives `takerShare = T/(T+0)` to exactly 1.0 -- the fabricated value the whole
 * rebate model depends on measuring honestly.
 */
export function toLevels(raw: unknown): [number, number][] {
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: [number, number][] = [];
  for (const el of value) {
    if (Array.isArray(el)) {
      const price = Number(el[0]);
      const size = Number(el[1]);
      if (Number.isFinite(price) && Number.isFinite(size)) out.push([price, size]);
      continue;
    }
    if (el !== null && typeof el === 'object') {
      const rec = el as Record<string, unknown>;
      const price = Number(rec['price'] ?? rec['p'] ?? rec['0']);
      const size = Number(rec['size'] ?? rec['s'] ?? rec['1']);
      if (Number.isFinite(price) && Number.isFinite(size)) out.push([price, size]);
    }
  }
  return out;
}

// Bracket access (`row['ts']`) is mandatory here: RawRow is an index signature
// and this project compiles with `noPropertyAccessFromIndexSignature`. Column
// names are verbatim from ../shared/schema.ts.
export function mapBookSnapshot(row: RawRow): BookSnapshot {
  return {
    ts: asString(row['ts']),
    recvTs: asString(row['recvTs']),
    conditionId: asString(row['conditionId']),
    tokenId: asString(row['tokenId']),
    bids: toLevels(row['bids']),
    asks: toLevels(row['asks']),
    tickSize: asNumber(row['tickSize'], 0.01),
    minOrderSize: asNumber(row['minOrderSize'], 1),
  };
}

export function mapTopOfBook(row: RawRow): TopOfBook {
  return {
    ts: asString(row['ts']),
    conditionId: asString(row['conditionId']),
    tokenId: asString(row['tokenId']),
    bestBid: asNullableNumber(row['bestBid']),
    bestAsk: asNullableNumber(row['bestAsk']),
    mid: asNullableNumber(row['mid']),
    spread: asNullableNumber(row['spread']),
  };
}

export function mapQuoteTouch(row: RawRow): QuoteTouch {
  const side = asString(row['side']) === 'SELL' ? 'SELL' : 'BUY';
  return {
    ts: asString(row['ts']),
    conditionId: asString(row['conditionId']),
    tokenId: asString(row['tokenId']),
    side,
    price: asNumber(row['price'], 0),
    size: asNumber(row['size'], 0),
    bookTs: asString(row['bookTs']),
    queueAhead: asNumber(row['queueAhead'], 0),
  };
}

/** Read all rows of one parquet file as raw objects. */
async function readRawRows(filePath: string): Promise<RawRow[]> {
  const file = await asyncBufferFromFile(filePath);
  const rows = await parquetReadObjects({ file, rowFormat: 'object' });
  return rows as RawRow[];
}

/** Read the partitioned dataset into typed rows. */
export async function loadDataset(dataDir: string): Promise<Dataset> {
  const files = await listParquetFiles(dataDir);

  const books: BookSnapshot[] = [];
  const tops: TopOfBook[] = [];
  const touches: QuoteTouch[] = [];
  const warnings: string[] = [];

  for (const filePath of files) {
    const kind = classifyParquetFile(filePath);
    if (kind === 'unknown') {
      warnings.push(`unclassified parquet file ignored: ${filePath}`);
      continue;
    }
    const rows = await readRawRows(filePath);
    for (const row of rows) {
      if (kind === 'books') books.push(mapBookSnapshot(row));
      else if (kind === 'tops') tops.push(mapTopOfBook(row));
      else touches.push(mapQuoteTouch(row));
    }
  }

  const quality = await readQualityFiles(dataDir);

  return {
    books,
    tops,
    touches,
    quality: quality.manifest,
    gaps: quality.gaps,
  };
}

export interface QualityFiles {
  manifest: QualityManifest | null;
  gaps: GapRecord[];
}

/** Read `data/quality/manifest.json` and any `*.jsonl` gap files under data/quality/. */
export async function readQualityFiles(dataDir: string): Promise<QualityFiles> {
  const qualityDir = path.join(dataDir, 'quality');
  let manifest: QualityManifest | null = null;
  try {
    const text = await readFile(path.join(qualityDir, 'manifest.json'), 'utf8');
    manifest = JSON.parse(text) as QualityManifest;
  } catch {
    manifest = null;
  }

  const gaps: GapRecord[] = [];
  async function collect(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collect(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const text = await readFile(full, 'utf8');
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            gaps.push(JSON.parse(trimmed) as GapRecord);
          }
        } catch {
          // tolerate malformed gap lines
        }
      }
    }
  }
  await collect(qualityDir);

  return { manifest, gaps };
}

export { readRawRows };
