// Partitioned Parquet writer. Buffers records in memory and flushes them as
// timestamped part files under:
//   data/dt=YYYY-MM-DD/condition=<conditionId>/kind=<book|tob|touch>/part-<HHMMSS>.parquet
//
// Crash safety: each flush writes a fresh `<name>.tmp` file and atomically
// renames it to `<name>.parquet`. We never append to an existing file, so a
// crash mid-flush leaves only an ignorable `.tmp` file and every committed
// `.parquet` file is complete and valid.
//
// Column layout (see src/shared/schema.ts for the decoded record shape):
//   book  : ts recvTs conditionId tokenId bids(JSON) asks(JSON) tickSize minOrderSize
//   tob   : ts conditionId tokenId bestBid bestAsk mid spread   (DOUBLE, nullable)
//   touch : ts conditionId tokenId side price size bookTs queueAhead

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parquetWriteFile } from 'hyparquet-writer';
import type { BookSnapshot, QuoteTouch, TopOfBook } from '../shared/schema.js';
import { utcDateOf } from '../shared/time.js';

export type Kind = 'book' | 'tob' | 'touch';

export interface RecordCounts {
  readonly book: number;
  readonly tob: number;
  readonly touch: number;
}

const KEY_SEP = '\u0000';

function partSuffix(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}`;
}

function partPath(dir: string, d: Date): string {
  const base = join(dir, `part-${partSuffix(d)}.parquet`);
  if (!existsSync(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = join(dir, `part-${partSuffix(d)}-${i}.parquet`);
    if (!existsSync(candidate)) return candidate;
  }
}

export class ParquetWriter {
  private readonly bookBuf = new Map<string, BookSnapshot[]>();
  private readonly tobBuf = new Map<string, TopOfBook[]>();
  private readonly touchBuf = new Map<string, QuoteTouch[]>();
  private bookCount = 0;
  private tobCount = 0;
  private touchCount = 0;

  constructor(private readonly dataDir: string) {}

  writeBook(rec: BookSnapshot): void {
    const key = `${utcDateOf(rec.ts)}${KEY_SEP}${rec.conditionId}`;
    const arr = this.bookBuf.get(key);
    if (arr === undefined) this.bookBuf.set(key, [rec]);
    else arr.push(rec);
    this.bookCount += 1;
  }

  writeTob(rec: TopOfBook): void {
    const key = `${utcDateOf(rec.ts)}${KEY_SEP}${rec.conditionId}`;
    const arr = this.tobBuf.get(key);
    if (arr === undefined) this.tobBuf.set(key, [rec]);
    else arr.push(rec);
    this.tobCount += 1;
  }

  writeTouch(rec: QuoteTouch): void {
    const key = `${utcDateOf(rec.ts)}${KEY_SEP}${rec.conditionId}`;
    const arr = this.touchBuf.get(key);
    if (arr === undefined) this.touchBuf.set(key, [rec]);
    else arr.push(rec);
    this.touchCount += 1;
  }

  counts(): RecordCounts {
    return { book: this.bookCount, tob: this.tobCount, touch: this.touchCount };
  }

  flush(): void {
    this.flushBook();
    this.flushTob();
    this.flushTouch();
  }

  private flushBook(): void {
    for (const [key, rows] of this.bookBuf) {
      if (rows.length === 0) continue;
      const { tmpPath, finalPath } = this.preparePartition(key, 'book');
      parquetWriteFile({
        filename: tmpPath,
        columnData: [
          { name: 'ts', data: rows.map((r) => r.ts), type: 'STRING' },
          { name: 'recvTs', data: rows.map((r) => r.recvTs), type: 'STRING' },
          { name: 'conditionId', data: rows.map((r) => r.conditionId), type: 'STRING' },
          { name: 'tokenId', data: rows.map((r) => r.tokenId), type: 'STRING' },
          { name: 'bids', data: rows.map((r) => JSON.stringify(r.bids)), type: 'JSON' },
          { name: 'asks', data: rows.map((r) => JSON.stringify(r.asks)), type: 'JSON' },
          { name: 'tickSize', data: rows.map((r) => r.tickSize), type: 'DOUBLE' },
          { name: 'minOrderSize', data: rows.map((r) => r.minOrderSize), type: 'DOUBLE' },
        ],
      });
      renameSync(tmpPath, finalPath);
    }
    this.bookBuf.clear();
  }

  private flushTob(): void {
    for (const [key, rows] of this.tobBuf) {
      if (rows.length === 0) continue;
      const { tmpPath, finalPath } = this.preparePartition(key, 'tob');
      parquetWriteFile({
        filename: tmpPath,
        columnData: [
          { name: 'ts', data: rows.map((r) => r.ts), type: 'STRING' },
          { name: 'conditionId', data: rows.map((r) => r.conditionId), type: 'STRING' },
          { name: 'tokenId', data: rows.map((r) => r.tokenId), type: 'STRING' },
          { name: 'bestBid', data: rows.map((r) => r.bestBid), type: 'DOUBLE' },
          { name: 'bestAsk', data: rows.map((r) => r.bestAsk), type: 'DOUBLE' },
          { name: 'mid', data: rows.map((r) => r.mid), type: 'DOUBLE' },
          { name: 'spread', data: rows.map((r) => r.spread), type: 'DOUBLE' },
        ],
      });
      renameSync(tmpPath, finalPath);
    }
    this.tobBuf.clear();
  }

  private flushTouch(): void {
    for (const [key, rows] of this.touchBuf) {
      if (rows.length === 0) continue;
      const { tmpPath, finalPath } = this.preparePartition(key, 'touch');
      parquetWriteFile({
        filename: tmpPath,
        columnData: [
          { name: 'ts', data: rows.map((r) => r.ts), type: 'STRING' },
          { name: 'conditionId', data: rows.map((r) => r.conditionId), type: 'STRING' },
          { name: 'tokenId', data: rows.map((r) => r.tokenId), type: 'STRING' },
          { name: 'side', data: rows.map((r) => r.side), type: 'STRING' },
          { name: 'price', data: rows.map((r) => r.price), type: 'DOUBLE' },
          { name: 'size', data: rows.map((r) => r.size), type: 'DOUBLE' },
          { name: 'bookTs', data: rows.map((r) => r.bookTs), type: 'STRING' },
          { name: 'queueAhead', data: rows.map((r) => r.queueAhead), type: 'DOUBLE' },
        ],
      });
      renameSync(tmpPath, finalPath);
    }
    this.touchBuf.clear();
  }

  private preparePartition(
    key: string,
    kind: Kind,
  ): { tmpPath: string; finalPath: string } {
    const sep = key.indexOf(KEY_SEP);
    const dt = key.slice(0, sep);
    const conditionId = key.slice(sep + 1);
    const dir = join(this.dataDir, `dt=${dt}`, `condition=${conditionId}`, `kind=${kind}`);
    mkdirSync(dir, { recursive: true });
    const finalPath = partPath(dir, new Date());
    return { finalPath, tmpPath: `${finalPath}.tmp` };
  }
}
