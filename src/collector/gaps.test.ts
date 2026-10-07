import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRecord } from '../shared/parse.js';
import { nowIso, utcDateOf } from '../shared/time.js';
import { GapLog } from './gaps.js';

test('gap log writes valid JSONL and accumulates gap seconds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaps-'));
  try {
    const log = new GapLog(dir);
    log.logGap('ws disconnected: code 1006', { durationSec: 2.5 });
    log.logError('book poll failed', { context: { conditionId: 'c1' } });
    log.logReconnect('ws reconnected', { durationSec: 3.0 });

    const file = join(dir, 'quality', `gaps-${utcDateOf(nowIso())}.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);

    for (const line of lines) {
      const obj: unknown = JSON.parse(line);
      assert.ok(isRecord(obj));
      assert.equal(typeof obj['ts'], 'string');
      assert.equal(typeof obj['kind'], 'string');
      assert.equal(typeof obj['message'], 'string');
    }

    const firstLine = lines[0];
    assert.ok(firstLine !== undefined);
    const first: unknown = JSON.parse(firstLine);
    assert.ok(isRecord(first));
    assert.equal(first['kind'], 'gap');
    assert.equal(first['durationSec'], 2.5);

    assert.equal(log.totalGapSeconds(), 5.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
