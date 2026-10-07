import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import type { BookSnapshot } from '../shared/schema.js';
import { ParquetWriter } from './writer.js';

// `rec.ts` is fully controlled here, so `utcDateOf(ts).slice(0, 10)` — and
// therefore the `dt=` partition — is deterministic. Nothing in this file
// depends on the wall clock: the only clock-derived name is partPath's
// `HHMMSS`, and every assertion counts files rather than matching names, so a
// retry landing in the same second (`part-<HHMMSS>-2`) or the next
// (`part-<HHMMSS1>`) is the same observable outcome.
const DT = '2024-01-02';
const HEALTHY = '0xhealthy';
const BLOCKED = '0xblocked';

function book(conditionId: string, offsetSec: number): BookSnapshot {
  const ts = `2024-01-02T00:00:0${offsetSec}.000Z`;
  return {
    ts,
    recvTs: ts,
    conditionId,
    tokenId: `tk-${conditionId}`,
    bids: [[0.49, 100]],
    asks: [[0.51, 200]],
    tickSize: 0.01,
    minOrderSize: 5,
  };
}

function kindDir(dataDir: string, conditionId: string, kind: string): string {
  return join(dataDir, `dt=${DT}`, `condition=${conditionId}`, `kind=${kind}`);
}

function parquetFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.parquet'))
    .sort()
    .map((name) => join(dir, name));
}

function allParquetFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allParquetFiles(full));
    else if (entry.name.endsWith('.parquet')) found.push(full);
  }
  return found.sort();
}

async function readRows(files: readonly string[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const file of files) {
    const buffer = await asyncBufferFromFile(file);
    rows.push(...(await parquetReadObjects({ file: buffer, rowFormat: 'object' })));
  }
  return rows;
}

test('regression: a partition that throws mid-flush is not written a second time on retry', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'writer-partial-'));
  try {
    const writer = new ParquetWriter(dataDir);

    // Write the healthy condition FIRST so Map insertion order commits it
    // before the blocked one throws.
    writer.writeBook(book(HEALTHY, 1));
    writer.writeBook(book(HEALTHY, 2));
    writer.writeBook(book(BLOCKED, 1));
    writer.writeBook(book(BLOCKED, 2));

    // Obstruct only BLOCKED: its `condition=` segment is a regular file, so
    // mkdirSync(dir, { recursive: true }) inside preparePartition throws
    // ENOTDIR for that partition and nowhere else. HEALTHY is unaffected.
    mkdirSync(join(dataDir, `dt=${DT}`), { recursive: true });
    writeFileSync(join(dataDir, `dt=${DT}`, `condition=${BLOCKED}`), 'not a directory');

    assert.throws(
      () => writer.flush(),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOTDIR',
    );

    // The healthy partition was already renamed into place before the throw,
    // and exactly one file exists for it.
    assert.deepEqual(
      parquetFiles(kindDir(dataDir, HEALTHY, 'book')).length,
      1,
      'healthy partition should hold exactly one committed file after the failed flush',
    );

    // Clear the obstruction and retry, the way collector/index.ts's
    // setInterval retry does 5s later.
    rmSync(join(dataDir, `dt=${DT}`, `condition=${BLOCKED}`), { force: true });
    writer.flush();

    const healthyFiles = parquetFiles(kindDir(dataDir, HEALTHY, 'book'));
    assert.equal(
      healthyFiles.length,
      1,
      'retry must not re-write an already-committed partition',
    );

    // Stronger check, independent of file naming: no two part files anywhere
    // hold the same records.
    const files = allParquetFiles(dataDir);
    const rows = await readRows(files);
    assert.equal(rows.length, 4, 'every record written exactly once across all part files');
    const keys = rows.map((row) => JSON.stringify(row));
    assert.equal(new Set(keys).size, keys.length, 'a record appears in more than one part file');

    // The blocked partition is now writable and got exactly its own two rows.
    assert.deepEqual(
      (await readRows(parquetFiles(kindDir(dataDir, BLOCKED, 'book')))).length,
      2,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a fully successful flush leaves nothing to re-write', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'writer-clean-'));
  try {
    const writer = new ParquetWriter(dataDir);
    writer.writeBook(book(HEALTHY, 1));
    writer.writeBook(book(BLOCKED, 1));
    writer.flush();

    const before = allParquetFiles(dataDir);
    assert.equal(before.length, 2);

    // A no-op flush must not produce another part file for either partition.
    writer.flush();
    assert.deepEqual(allParquetFiles(dataDir), before);

    // counts() is process-lifetime and deliberately not reset by flush().
    assert.deepEqual(writer.counts(), { book: 2, tob: 0, touch: 0 });
    assert.ok(statSync(dataDir).isDirectory());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});