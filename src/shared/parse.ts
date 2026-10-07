// Boundary parsing helpers: narrow `unknown` into primitives without any
// untyped escape hatch. External JSON (Gamma, CLOB) crosses the trust boundary
// exactly once, here.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// A finite number, or a non-empty numeric string coerced to one. Returns null
// for anything else (including "" and whitespace-only strings).
export function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Polymarket prices are 0..1 decimal probabilities.
export function asPrice(v: unknown): number | null {
  const n = numberOrNull(v);
  if (n === null || n < 0 || n > 1) return null;
  return n;
}

export function asSize(v: unknown): number | null {
  const n = numberOrNull(v);
  if (n === null || n < 0) return null;
  return n;
}
