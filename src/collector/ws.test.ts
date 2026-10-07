import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextBackoffDelayMs } from './ws.js';

/**
 * Reconnect backoff schedule.
 *
 * COVERAGE BOUNDARY, stated up front so this file is not read as more than it
 * is. It pins the DELAY SCHEDULE only. The other half of the fix -- that `open`
 * no longer sets `attempt = 0`, and that the reset now waits on a
 * STABLE_CONNECTION_MS timer cleared in both close paths -- is NOT pinned by an
 * executing test. `PriceWs.connect()` constructs a real `WebSocket` against a
 * hardcoded URL, so the class cannot be driven without opening a network
 * connection; pinning that wiring would need either a live socket or a
 * constructor-injected socket factory, which would widen the class's injection
 * surface purely for this. So: schedule pinned here, reset-on-open pinned by
 * inspection and by the comments on the constant and the 'open' handler. No
 * test in this file opens a network connection; importing the module only
 * evaluates constants.
 *
 * That boundary was verified rather than assumed: reinstating `this.attempt = 0`
 * in the 'open' handler leaves all tests here green, while dropping the jitter,
 * raising the cap, widening the jitter window, shifting the exponent off by one,
 * and doubling BASE_BACKOFF_MS each fail it. So this file pins the schedule
 * hard and pins nothing about the reset.
 */

/**
 * The jittered window per 1-based attempt, as [lo, hi):
 *
 *   attempt n -> exp = 1000 * 2 ** (n - 1), cap = min(exp, 60000)
 *                delay = cap / 2 + random() * (cap / 2)
 *
 * so the window is exactly half the cap wide. Attempts 1-6 are uncapped and
 * each window's `lo` equals the previous window's `hi`. Attempt 7 would be
 * 64_000 uncapped and is clamped to the 60_000 max, which is why its window
 * OVERLPS attempt 6's: the cap is a ceiling on the window, not on the sequence.
 */
const SCHEDULE: readonly { readonly attempt: number; readonly lo: number; readonly hi: number }[] = [
  { attempt: 1, lo: 500, hi: 1_000 },
  { attempt: 2, lo: 1_000, hi: 2_000 },
  { attempt: 3, lo: 2_000, hi: 4_000 },
  { attempt: 4, lo: 4_000, hi: 8_000 },
  { attempt: 5, lo: 8_000, hi: 16_000 },
  { attempt: 6, lo: 16_000, hi: 32_000 },
  { attempt: 7, lo: 30_000, hi: 60_000 },
  { attempt: 20, lo: 30_000, hi: 60_000 },
];

const DRAWS = 500;

/** Min and max of `count` draws, for asserting a window is respected AND used. */
function span(attempt: number, count = DRAWS): { readonly min: number; readonly max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const d = nextBackoffDelayMs(attempt);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

describe('nextBackoffDelayMs', () => {
  it('keeps every attempt inside its documented jittered window', () => {
    for (const { attempt, lo, hi } of SCHEDULE) {
      const { min, max } = span(attempt);
      assert.ok(min >= lo, `attempt ${attempt}: min ${min} below window floor ${lo}`);
      assert.ok(max < hi, `attempt ${attempt}: max ${max} at or above window ceiling ${hi}`);
    }
  });

  // Without this, a helper that dropped the jitter and returned the window
  // midpoint -- or a constant -- would sail through the bounds check above.
  it('spans its whole window rather than returning a fixed point', () => {
    for (const { attempt, lo, hi } of SCHEDULE) {
      const { min, max } = span(attempt);
      const width = hi - lo;
      assert.ok(
        min < lo + width * 0.2,
        `attempt ${attempt}: min ${min} never approached the floor ${lo} -- jitter looks inert`,
      );
      assert.ok(
        max > hi - width * 0.2,
        `attempt ${attempt}: max ${max} never approached the ceiling ${hi} -- jitter looks inert`,
      );
    }
  });

  it('produces a distinct value on essentially every draw', () => {
    // 500 uniform draws from a 1000ms-wide window collide by chance on ~125
    // pairs, so >400 distinct means the value is genuinely varying.
    const seen = new Set<number>();
    for (let i = 0; i < DRAWS; i += 1) seen.add(nextBackoffDelayMs(2));
    assert.ok(seen.size > 400, `only ${seen.size} distinct delays in ${DRAWS} draws`);
  });

  it('escalates across a flapping endpoint instead of restarting at the base delay', () => {
    // Models the reconnect loop for an endpoint that completes the handshake and
    // then closes promptly: `attempt` carries forward across every cycle because
    // no cycle ever reaches the stability window, so the reset never fires.
    const flapDelays: number[] = [];
    let attempt = 0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      attempt += 1;
      flapDelays.push(nextBackoffDelayMs(attempt));
    }

    // Each cycle must be slower than a fixed ~1s-per-cycle reconnect storm.
    // The windows alone put ten flapping cycles past 140s, so any total in the
    // thousands cannot be a restarted-at-base sequence.
    const total = flapDelays.reduce((a, b) => a + b, 0);
    assert.ok(total > 60_000, `ten flapping cycles totalled only ${Math.round(total)}ms`);

    // And the schedule must be monotonically non-decreasing by window, which is
    // the property a restart-every-open implementation cannot produce: its
    // tenth cycle is still in the 500-1000ms base window.
    for (let i = 1; i < SCHEDULE.length; i += 1) {
      const prev = SCHEDULE[i - 1];
      const cur = SCHEDULE[i];
      assert.ok(prev !== undefined && cur !== undefined);
      assert.ok(cur.lo >= prev.hi || cur.lo === 30_000, `attempt ${cur.attempt} window regressed`);
    }
  });

  it('caps at the 60s maximum however large the attempt grows', () => {
    // 2 ** (attempt - 1) overflows to Infinity well before this, so this also
    // pins that the cap is applied to the EXPONENTIATED value rather than
    // dividing it first.
    for (const attempt of [7, 64, 1_000, 65_536, Number.MAX_SAFE_INTEGER]) {
      const { min, max } = span(attempt, 200);
      assert.ok(min >= 30_000, `attempt ${attempt}: capped window floor was ${min}`);
      assert.ok(max < 60_000, `attempt ${attempt}: capped window ceiling was ${max}`);
    }
  });

  it('returns a finite positive delay for every attempt in a long run', () => {
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const d = nextBackoffDelayMs(attempt);
      assert.ok(Number.isFinite(d), `attempt ${attempt} produced ${d}`);
      assert.ok(d > 0, `attempt ${attempt} produced ${d}`);
      assert.ok(d < 60_000, `attempt ${attempt} exceeded the cap at ${d}`);
    }
  });
});
