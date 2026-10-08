// Minimal typed JSON-over-HTTP fetch for the read-only public endpoints.
// No auth, no custom headers beyond accept. Node >= 20 global fetch.

import { HttpError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Separate from `fetchJson` on purpose: do not collapse the two behind a
 * `method` parameter. Which endpoint a sweep used is load-bearing for the cadence
 * claim in `BookPoller`, and a merged helper would hide it.
 */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new HttpError(url, 0, 'request timed out', { cause });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(url, 0, `network error: ${detail}`, { cause });
  }
  if (!res.ok) {
    throw new HttpError(url, res.status, `HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch (cause) {
    throw new HttpError(url, res.status, 'invalid JSON body', { cause });
  }
}

export async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new HttpError(url, 0, 'request timed out', { cause });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(url, 0, `network error: ${detail}`, { cause });
  }
  if (!res.ok) {
    throw new HttpError(url, res.status, `HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch (cause) {
    throw new HttpError(url, res.status, 'invalid JSON body', { cause });
  }
}
