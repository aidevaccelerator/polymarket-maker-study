// Time helpers. All timestamps written to disk are ISO8601 UTC strings.

export function nowIso(): string {
  return new Date().toISOString();
}

export function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}

// Normalize an exchange-supplied timestamp into ISO8601 UTC. Accepts a
// millisecond epoch number, a numeric string (ms), or an ISO/parseable string.
// Returns null when it cannot be interpreted.
export function normalizeTs(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return epochMsToIso(v);
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return epochMsToIso(Number(v));
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// UTC date partition key `YYYY-MM-DD` from an ISO8601 timestamp.
export function utcDateOf(iso: string): string {
  return iso.slice(0, 10);
}
