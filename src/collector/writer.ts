// Partitioned Parquet writer. Buffers records in memory and flushes them as
// timestamped part files under:
//   data/dt=YYYY-MM-DD/condition=<conditionId>/kind=<book|tob|touch>/part-<HHMMSS>.parquet
//
// Crash safety: each flush writes a fresh `<name>.tmp` file and atomically
// renames it to `<name>.parquet`. We never append to an existing file.
//
// What that DOES guarantee, for a crash of the collector PROCESS: a crash
// mid-flush leaves only an ignorable `.tmp` file, and every `.parquet` file
// that has been renamed into place is complete and valid. Atomic rename is
// atomic because the page cache outlives process death, so the bytes written
// before the rename are still there afterwards.
//
// What it does NOT guarantee, for a failure of the HOST: nothing here fsyncs,
// neither the file's data nor the containing directory. `renameSync` makes the
// directory entry atomic, but atomic is not durable — a power loss, kernel
// panic, or VPS suspend can discard data that never reached the platter,
// leaving a `.parquet` file whose name is committed and whose contents are
// zero-length or truncated. Host-level durability would require fsync on the
// data before the rename plus fsync on the directory after it; that is a real
// per-partition cost and is deliberately not paid here, so the guarantee is
// stated as process-crash-only and must not be read as "the dataset survives
// power loss".
//
// Note also that `.tmp` files left by a crash are never cleaned up: nothing in
// the collector scans for them. `partPath` ignores `.tmp` when picking a name,
// so they are inert for correctness — they only accumulate as disk garbage.
//
// Partial-failure safety: each flush loop deletes a partition's buffer entry
// as soon as that partition is committed, not after the loop. `partPath` never
// overwrites an existing name, so a committed partition still sitting in the
// buffer after a later partition throws would be written AGAIN on the next
// flush, into a new part file holding byte-identical rows. Duplicated
// QuoteTouch rows mean duplicated fills, so the pessimistic fill set and the
// weighted p50 markout would be computed over a sample containing repeats,
// with nothing reporting it. Deleting the current entry mid-iteration is safe:
// a Map iterator handles removal of the entry it is currently on, and the
// deletion happens only after that partition's rows are written and renamed.
//
// Column layout (see src/shared/schema.ts for the decoded record shape):
//   book  : ts recvTs conditionId tokenId bids(JSON) asks(JSON) tickSize minOrderSize
//   tob   : ts conditionId tokenId bestBid bestAsk mid spread   (DOUBLE, nullable)
//   touch : ts conditionId tokenId side price size bookTs queueAhead
//   change: ts conditionId tokenId side price size bestBid bestAsk hash

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parquetWriteFile } from 'hyparquet-writer';
import type { BookSnapshot, PriceChange, QuoteTouch, TopOfBook } from '../shared/schema.js';
import { utcDateOf } from '../shared/time.js';

export type Kind = 'book' | 'tob' | 'touch' | 'change';

export interface RecordCounts {
  readonly book: number;
  readonly tob: number;
  readonly touch: number;
  readonly change: number;
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
  private readonly changeBuf = new Map<string, PriceChange[]>();
  private bookCount = 0;
  private tobCount = 0;
  private touchCount = 0;
  private changeCount = 0;

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

  writeChange(rec: PriceChange): void {
    const key = `${utcDateOf(rec.ts)}${KEY_SEP}${rec.conditionId}`;
    const arr = this.changeBuf.get(key);
    if (arr === undefined) this.changeBuf.set(key, [rec]);
    else arr.push(rec);
    this.changeCount += 1;
  }

  counts(): RecordCounts {
    return {
      book: this.bookCount,
      tob: this.tobCount,
      touch: this.touchCount,
      change: this.changeCount,
    };
  }

  flush(): void {
    this.flushBook();
    this.flushTob();
    this.flushTouch();
    this.flushChange();
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
      this.bookBuf.delete(key);
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
      this.tobBuf.delete(key);
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
      this.touchBuf.delete(key);
    }
    this.touchBuf.clear();
  }

  private flushChange(): void {
    for (const [key, rows] of this.changeBuf) {
      if (rows.length === 0) continue;
      const { tmpPath, finalPath } = this.preparePartition(key, 'change');
      parquetWriteFile({
        filename: tmpPath,
        columnData: [
          { name: 'ts', data: rows.map((r) => r.ts), type: 'STRING' },
          { name: 'conditionId', data: rows.map((r) => r.conditionId), type: 'STRING' },
          { name: 'tokenId', data: rows.map((r) => r.tokenId), type: 'STRING' },
          { name: 'side', data: rows.map((r) => r.side), type: 'STRING' },
          { name: 'price', data: rows.map((r) => r.price), type: 'DOUBLE' },
          { name: 'size', data: rows.map((r) => r.size), type: 'DOUBLE' },
          { name: 'bestBid', data: rows.map((r) => r.bestBid), type: 'DOUBLE' },
          { name: 'bestAsk', data: rows.map((r) => r.bestAsk), type: 'DOUBLE' },
          { name: 'hash', data: rows.map((r) => r.hash), type: 'STRING' },
        ],
      });
      renameSync(tmpPath, finalPath);
      this.changeBuf.delete(key);
    }
    this.changeBuf.clear();
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
