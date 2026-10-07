import WebSocket from 'ws';
import type { RawData } from 'ws';
import { asPrice, asString, isRecord } from '../shared/parse.js';
import { normalizeTs, nowIso } from '../shared/time.js';
import type { TopOfBook } from '../shared/schema.js';

const WS_URL = 'wss://ws-live-v2.polymarket.com/ws';
const CHANNEL = 'price.polymarket';
// Limits (docs.polymarket.com): 64 subscriptions per connection, 20 subscribe/
// unsubscribe frames per second, 25s server ping, 64KB frame.
const SUBSCRIBE_CHUNK = 64;
const CHUNK_DELAY_MS = 120;
const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

// How long a connection must stay open before the reconnect backoff is reset.
// See `nextBackoffDelayMs` and the comment on the 'open' handler.
//
// Why the reset is not simply done on 'open': a completed handshake proves the
// endpoint accepted us, and nothing more. If an endpoint accepts and then
// promptly closes — server-side rate limiting, an aggressive idle timeout, or an
// intercepting middlebox / captive portal producing the same signature — then
// resetting on every open restarts the backoff at the 1s base on every cycle.
// That is roughly one reconnect per second, indefinitely, across a 30-day
// unattended run, and each cycle additionally writes a paired disconnect /
// reconnect entry into the durable gap log. Whether Polymarket's endpoint
// actually flaps this way is UNVERIFIED: the previous 30-day run never exercised
// this path against the live endpoint.
//
// Why the reset is not simply removed either: the reset is what lets a
// genuinely long-lived connection reconnect at the base delay after a real
// outage, instead of arriving at the outage already backed off to the 60s cap.
// Both behaviours are wanted, and the window is what separates them — a
// flapping endpoint never reaches the window and keeps escalating, a healthy
// one reaches it within seconds of connecting and recovers fast.
//
// 30s is chosen to exceed PING_INTERVAL_MS (20s), so "stable" means the
// connection has survived at least one full client ping round-trip and is
// demonstrably carrying traffic, rather than merely having completed a
// handshake. It is also orders of magnitude above CHUNK_DELAY_MS (120ms per
// 64-token chunk), so subscription has long since finished when the window
// elapses. The window is deliberately biased long because the two errors are not
// symmetric: too short reintroduces the reconnect storm, whereas too long costs
// at most one extra backoff step, and only for a connection that dies between
// 20s and 30s old.
const STABLE_CONNECTION_MS = 30_000;

export interface WsToken {
  readonly conditionId: string;
  readonly tokenId: string;
}

export interface TopOfBookUpdate {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly ts: string;
}

export interface PriceWsDeps {
  readonly onUpdate: (u: TopOfBookUpdate) => void;
  readonly onDisconnect: (reason: string) => void;
  readonly onReconnect: (downtimeSec: number) => void;
}

export function toTopOfBook(u: TopOfBookUpdate): TopOfBook {
  const both = u.bestBid !== null && u.bestAsk !== null;
  return {
    ts: u.ts,
    conditionId: u.conditionId,
    tokenId: u.tokenId,
    bestBid: u.bestBid,
    bestAsk: u.bestAsk,
    mid: both ? (u.bestBid + u.bestAsk) / 2 : null,
    spread: both ? u.bestAsk - u.bestBid : null,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }
}

/**
 * Reconnect delay in ms for the given 1-based `attempt`, jittered over the top
 * half of the window so a fleet of collectors does not resynchronise on retries.
 *
 * Exported purely so the schedule is directly testable. `PriceWs` constructs a
 * real `WebSocket` in connect(), so the class cannot be driven without opening a
 * network connection; this function is the whole of the delay computation and
 * touches no instance state.
 */
export function nextBackoffDelayMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const cap = Math.min(exp, MAX_BACKOFF_MS);
  return cap / 2 + Math.random() * (cap / 2);
}

export class PriceWs {
  private readonly tokenByAssetId = new Map<string, WsToken>();
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private ridCounter = 0;
  private closed = false;
  private disconnectedAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly tokens: readonly WsToken[],
    private readonly deps: PriceWsDeps,
  ) {
    for (const t of tokens) this.tokenByAssetId.set(t.tokenId, t);
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.clearStabilityTimer();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws !== null) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    this.closed = false;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      // NOT `this.attempt = 0`. The backoff is reset by the stability timer
      // below only once this connection has outlived STABLE_CONNECTION_MS, so a
      // connection that opens and closes promptly keeps the escalating backoff
      // it earned instead of handing itself the 1s base again. See the constant's
      // comment for why neither resetting here nor never resetting is correct.
      this.armStabilityTimer();
      if (this.disconnectedAt !== null) {
        const downtimeSec = (Date.now() - this.disconnectedAt) / 1000;
        this.disconnectedAt = null;
        this.deps.onReconnect(downtimeSec);
      }
      this.lastError = null;
      this.subscribe();
      this.startPing();
    });

    ws.on('message', (data: RawData) => {
      this.handleMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.lastError = err.message;
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.stopPing();
      this.clearStabilityTimer();
      this.ws = null;
      if (this.closed) return;
      const reasonText = reason.toString();
      const parts: string[] = [];
      if (code !== 0) parts.push(`code ${code}`);
      if (reasonText !== '') parts.push(reasonText);
      if (this.lastError !== null) parts.push(this.lastError);
      this.disconnectedAt = Date.now();
      this.deps.onDisconnect(parts.length > 0 ? parts.join('; ') : 'unknown');
      this.scheduleReconnect();
    });
  }

  private subscribe(): void {
    const ws = this.ws;
    if (ws === null) return;
    const chunks: WsToken[][] = [];
    for (let i = 0; i < this.tokens.length; i += SUBSCRIBE_CHUNK) {
      chunks.push(this.tokens.slice(i, i + SUBSCRIBE_CHUNK));
    }
    chunks.forEach((chunk, idx) => {
      setTimeout(() => {
        if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(
          JSON.stringify({
            op: 'subscribe',
            rid: `sub-${this.ridCounter++}`,
            subscriptions: chunk.map((t) => ({
              channel: CHANNEL,
              filter: { asset_id: t.tokenId },
            })),
          }),
        );
      }, idx * CHUNK_DELAY_MS);
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping', rid: `ping-${this.ridCounter++}` }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private armStabilityTimer(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.attempt = 0;
    }, STABLE_CONNECTION_MS);
  }

  // Called from BOTH the 'close' handler and close(). Without it a 30-day run
  // accumulates one live timer per reconnect, and a connection that closes would
  // still fire a reset afterwards — silently zeroing the backoff of the
  // connection that replaced it, which is the exact defect this file fixes.
  private clearStabilityTimer(): void {
    if (this.stabilityTimer !== null) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, nextBackoffDelayMs(this.attempt));
  }

  private handleMessage(data: RawData): void {
    let text: string;
    if (Buffer.isBuffer(data)) text = data.toString();
    else if (Array.isArray(data)) text = Buffer.concat(data).toString();
    else text = Buffer.from(data).toString();

    const msg = tryParseJson(text);
    if (msg === null || !isRecord(msg)) return;
    if (msg['channel'] !== CHANNEL) return;
    const payload = msg['payload'];
    if (!isRecord(payload)) return;

    const assetId = asString(payload['asset_id']);
    if (assetId === null) return;
    const token = this.tokenByAssetId.get(assetId);
    if (token === undefined) return;

    this.deps.onUpdate({
      conditionId: token.conditionId,
      tokenId: token.tokenId,
      bestBid: asPrice(payload['best_bid']),
      bestAsk: asPrice(payload['best_ask']),
      ts: normalizeTs(msg['ts']) ?? nowIso(),
    });
  }
}
