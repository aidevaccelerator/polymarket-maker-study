// CLOB market-channel websocket: the ONLY public feed in scope that carries the
// two fields a fill needs — a level `size` and which `side` of the book changed.
//
// The collector's other subscription (`price.polymarket` on ws-live-v2) carries
// `best_bid`/`best_ask` only, so it cannot observe a fill at all. Measured
// 2026-10-07 on the tracked universe: `price.polymarket` yields 0 best-price
// moves across 1,320 consecutive book pairs, while this channel delivers ~16
// events/min/token carrying an explicit size.
//
// WHAT THIS DOES NOT DECIDE. A level change is not a fill. A cancellation and an
// aggressive trade produce the same event here, and nothing in this file tries
// to tell them apart. The raw events are written to `kind=change` verbatim so the
// fill question is settled in ANALYSIS against real data, per `PriceChange` in
// src/shared/schema.ts. Adding a heuristic here would bake an unexamined
// assumption into the dataset before any fill has been observed.
//
// The connection lifecycle (chunked subscribe, ping, jittered backoff reset only
// after a stable window) mirrors `ws.ts` deliberately rather than sharing code:
// that module is exercised by its own tests against an injected socket, and
// coupling a second live socket to it would widen the blast radius of a change
// to a path that currently works.

import WebSocket from 'ws';
import type { RawData } from 'ws';
import { asPrice, asString, isRecord } from '../shared/parse.js';
import { normalizeTs, nowIso } from '../shared/time.js';
import type { PriceChange } from '../shared/schema.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const SUBSCRIBE_CHUNK = 64;
const CHUNK_DELAY_MS = 120;
const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const STABLE_CONNECTION_MS = 30_000;

export interface ClobWsToken {
  readonly conditionId: string;
  readonly tokenId: string;
}

export interface ClobWsDeps {
  readonly onChange: (c: PriceChange) => void;
  /** Counted, not just logged: a silent feed is indistinguishable from a quiet market. */
  readonly onUnparsed: () => void;
}

export function nextClobBackoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const cap = Math.min(exp, MAX_BACKOFF_MS);
  return cap / 2 + Math.random() * (cap / 2);
}

/**
 * Exported for the same reason `booksByCondition` is: the class opens a real
 * socket, so parsing cannot be tested through it, and a silent misread here
 * would alter the fill statistics with nothing reporting it.
 *
 * `unparsed` is returned rather than swallowed: returning only `changes` would
 * let a malformed feed record less than arrived, invisibly.
 */
export function parsePriceChanges(
  msg: unknown,
  tokenByAssetId: ReadonlyMap<string, ClobWsToken>,
  fallbackTs: string,
): { changes: PriceChange[]; unparsed: number } {
  const changes: PriceChange[] = [];
  let unparsed = 0;
  if (!isRecord(msg)) return { changes, unparsed: 0 };
  const raw = msg['price_changes'];
  if (!Array.isArray(raw)) return { changes, unparsed: 0 };

  const ts = normalizeTs(msg['timestamp']) ?? fallbackTs;
  for (const entry of raw) {
    if (!isRecord(entry)) {
      unparsed += 1;
      continue;
    }
    const assetId = asString(entry['asset_id']);
    const price = asPrice(entry['price']);
    const size = asPrice(entry['size']);
    const side = asString(entry['side']);
    if (
      assetId === null ||
      price === null ||
      size === null ||
      (side !== 'BUY' && side !== 'SELL')
    ) {
      unparsed += 1;
      continue;
    }
    const token = tokenByAssetId.get(assetId);
    if (token === undefined) continue;
    changes.push({
      ts,
      conditionId: token.conditionId,
      tokenId: token.tokenId,
      side,
      price,
      size,
      bestBid: asPrice(entry['best_bid']),
      bestAsk: asPrice(entry['best_ask']),
      hash: asString(entry['hash']) ?? '',
    });
  }
  return { changes, unparsed };
}

export class ClobPriceWs {
  private readonly tokenByAssetId = new Map<string, ClobWsToken>();
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;

  constructor(
    private readonly tokens: readonly ClobWsToken[],
    private readonly deps: ClobWsDeps,
  ) {
    for (const t of tokens) this.tokenByAssetId.set(t.tokenId, t);
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.clearStability();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws !== null) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.subscribe();
      this.attempt = 0;
      this.clearStability();
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = null;
      }, STABLE_CONNECTION_MS);
    });

    ws.on('message', (data: RawData) => {
      this.handleMessage(data);
    });

    ws.on('close', () => {
      if (this.closed) return;
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' always follows, and it owns reconnection. Swallowing here keeps
      // an expected socket error from becoming an unhandled 'error' event.
    });
  }

  private scheduleReconnect(): void {
    this.stopPing();
    this.clearStability();
    this.attempt += 1;
    const delay = nextClobBackoffMs(this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearStability(): void {
    if (this.stabilityTimer !== null) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private subscribe(): void {
    const chunks: ClobWsToken[][] = [];
    for (let i = 0; i < this.tokens.length; i += SUBSCRIBE_CHUNK) {
      chunks.push(this.tokens.slice(i, i + SUBSCRIBE_CHUNK));
    }
    chunks.forEach((chunk, idx) => {
      setTimeout(() => {
        if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(
          JSON.stringify({ assets_ids: chunk.map((t) => t.tokenId), type: 'market' }),
        );
      }, idx * CHUNK_DELAY_MS);
    });

    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping', rid: `ping-${Date.now()}` }));
      }
    }, PING_INTERVAL_MS);
  }

  private handleMessage(data: RawData): void {
    let text: string;
    if (Buffer.isBuffer(data)) text = data.toString();
    else if (Array.isArray(data)) text = Buffer.concat(data).toString();
    else text = Buffer.from(data).toString();

    let msg: unknown;
    try {
      msg = JSON.parse(text) as unknown;
    } catch {
      this.deps.onUnparsed();
      return;
    }
    if (Array.isArray(msg)) {
      // The connect-time full-book snapshot arrives as a bare array. It is not a
      // price change and is not recorded here; the book poller owns depth.
      return;
    }
    if (!isRecord(msg)) {
      this.deps.onUnparsed();
      return;
    }
    const { changes, unparsed } = parsePriceChanges(msg, this.tokenByAssetId, nowIso());
    for (let i = 0; i < unparsed; i += 1) this.deps.onUnparsed();
    for (const c of changes) this.deps.onChange(c);
  }
}