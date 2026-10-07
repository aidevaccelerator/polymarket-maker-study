// Durable, append-only gap/error/reconnect log. One JSON line per event,
// partitioned by UTC day under data/quality/gaps-YYYY-MM-DD.jsonl. Every gap,
// reconnect, and error is recorded here so data quality is auditable after a
// weeks-long unattended run.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, utcDateOf } from '../shared/time.js';

export type GapKind = 'gap' | 'error' | 'reconnect' | 'info';

export interface GapEntry {
  readonly ts: string;
  readonly kind: GapKind;
  readonly message: string;
  readonly durationSec?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface GapOptions {
  readonly durationSec?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class GapLog {
  private gapSeconds = 0;
  private readonly qualityDir: string;

  constructor(dataDir: string) {
    this.qualityDir = join(dataDir, 'quality');
    mkdirSync(this.qualityDir, { recursive: true });
  }

  log(kind: GapKind, message: string, opts?: GapOptions): void {
    const ts = nowIso();
    const entry: GapEntry = {
      ts,
      kind,
      message,
      ...(opts?.durationSec !== undefined ? { durationSec: opts.durationSec } : {}),
      ...(opts?.context !== undefined ? { context: opts.context } : {}),
    };
    const path = join(this.qualityDir, `gaps-${utcDateOf(ts)}.jsonl`);
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (entry.durationSec !== undefined) this.gapSeconds += entry.durationSec;
  }

  logGap(message: string, opts?: GapOptions): void {
    this.log('gap', message, opts);
  }

  logError(message: string, opts?: GapOptions): void {
    this.log('error', message, opts);
  }

  logReconnect(message: string, opts?: GapOptions): void {
    this.log('reconnect', message, opts);
  }

  totalGapSeconds(): number {
    return this.gapSeconds;
  }
}
