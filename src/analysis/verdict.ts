/**
 * Verdict: PASS / MARGINAL / FAIL / FAIL_TAKER_SHARE / INSUFFICIENT_DATA.
 *
 * These rules are PRE-REGISTERED (fixed before data collection) and implemented
 * literally. They are NOT tuned here, even where a threshold looks debatable —
 * that would be a finding for the operator, never a silent change.
 *
 * Every threshold and parameter comes from `../shared/config.js` (used as-is):
 *   PESSIMISTIC_FAIL_MARKOUT_CENTS = 1.3
 *   MEDIAN_FAIL_MARKOUT_CENTS      = 2.0
 *   TAKER_SHARE_FLOOR              = 0.5
 *   ADVERSE_SELECTION_BUDGET_CENTS = 1.3
 *   MARGINAL_LOWER_BOUND_CENTS     = 1.0
 *   MIN_FILLS_FOR_VERDICT          = 100
 *   CANONICAL_HORIZON_MS           = 30_000
 */

import {
  ADVERSE_SELECTION_BUDGET_CENTS,
  CANONICAL_HORIZON_MS,
  GROSS_EDGE_BPS,
  MARGINAL_LOWER_BOUND_CENTS,
  MEDIAN_FAIL_MARKOUT_CENTS,
  MIN_FILLS_FOR_VERDICT,
  PESSIMISTIC_FAIL_MARKOUT_CENTS,
  TAKER_SHARE_FLOOR,
} from '../shared/config.js';

/** Bump when the rule set changes so results stay diffable/reproducible. */
export const VERDICT_VERSION = '1.0.0';

/**
 * Canonical horizon used for the verdict, derived from the shared config so the
 * seconds figure in rule descriptions and the Verdict record cannot drift from
 * the millisecond value the markout code actually uses.
 */
const VERDICT_HORIZON_SECONDS = CANONICAL_HORIZON_MS / 1000;

// MARGINAL_LOWER_BOUND_CENTS and MIN_FILLS_FOR_VERDICT are imported from
// ../shared/config.js (promoted 2026-10-07) and used below as-is.

export type VerdictOutcome =
  | 'PASS'
  | 'MARGINAL'
  | 'FAIL'
  | 'FAIL_TAKER_SHARE'
  | 'INSUFFICIENT_DATA';

export interface RuleEvaluation {
  id: string;
  description: string;
  status: 'PASS' | 'FAIL';
  threshold: number;
  actual: number | null;
  detail: string;
}

export interface Verdict {
  verdictVersion: string;
  evaluatedAt: string;
  horizonSeconds: number;
  overall: VerdictOutcome;
  rules: RuleEvaluation[];
  reasons: string[];
}

export interface VerdictInput {
  /** Pessimistic-model median adverseCents at the verdict horizon. */
  pessimisticMedianAdverseCents: number | null;
  /** Median-model median adverseCents at the verdict horizon. */
  medianModelMedianAdverseCents: number | null;
  /** Measured T/(M+T), or null if unmeasurable. */
  takerShare: number | null;
  /** Pessimistic fill sample count (statistical-confidence gate). */
  pessimisticFillCount: number;
}

const fmt = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(4));

export function evaluateVerdict(input: VerdictInput, now: Date = new Date()): Verdict {
  const pess = input.pessimisticMedianAdverseCents;
  const med = input.medianModelMedianAdverseCents;
  const takerShare = input.takerShare;
  const n = input.pessimisticFillCount;

  const rules: RuleEvaluation[] = [];
  const reasons: string[] = [];

  // Rule 1 — pessimistic FAIL (strictly greater than 1.3).
  const pessFail = pess !== null && pess > PESSIMISTIC_FAIL_MARKOUT_CENTS;
  rules.push({
    id: 'pessimistic_median_markout_fail',
    description: `FAIL if pessimistic median adverseCents @${VERDICT_HORIZON_SECONDS}s > ${PESSIMISTIC_FAIL_MARKOUT_CENTS}c`,
    status: pessFail ? 'FAIL' : 'PASS',
    threshold: PESSIMISTIC_FAIL_MARKOUT_CENTS,
    actual: pess,
    detail: `pessimistic median = ${fmt(pess)}c (threshold > ${PESSIMISTIC_FAIL_MARKOUT_CENTS}c, strict)`,
  });
  if (pessFail) {
    reasons.push(
      `pessimistic median adverseCents ${fmt(pess)}c exceeds ${PESSIMISTIC_FAIL_MARKOUT_CENTS}c.`,
    );
  }

  // Rule 2 — median-model FAIL (strictly greater than 2.0), independent of the above.
  const medFail = med !== null && med > MEDIAN_FAIL_MARKOUT_CENTS;
  rules.push({
    id: 'median_model_median_markout_fail',
    description: `FAIL if median-model median adverseCents @${VERDICT_HORIZON_SECONDS}s > ${MEDIAN_FAIL_MARKOUT_CENTS}c`,
    status: medFail ? 'FAIL' : 'PASS',
    threshold: MEDIAN_FAIL_MARKOUT_CENTS,
    actual: med,
    detail: `median-model median = ${fmt(med)}c (threshold > ${MEDIAN_FAIL_MARKOUT_CENTS}c, strict)`,
  });
  if (medFail) {
    reasons.push(`median-model median adverseCents ${fmt(med)}c exceeds ${MEDIAN_FAIL_MARKOUT_CENTS}c.`);
  }

  // Rule 3 — MARGINAL band [1.0, 1.3] (inclusive upper bound).
  const marginal =
    pess !== null &&
    pess >= MARGINAL_LOWER_BOUND_CENTS &&
    pess <= PESSIMISTIC_FAIL_MARKOUT_CENTS;
  rules.push({
    id: 'pessimistic_marginal_band',
    description: `MARGINAL if pessimistic median adverseCents lands in [${MARGINAL_LOWER_BOUND_CENTS}, ${PESSIMISTIC_FAIL_MARKOUT_CENTS}]c`,
    status: marginal ? 'FAIL' : 'PASS',
    threshold: PESSIMISTIC_FAIL_MARKOUT_CENTS,
    actual: pess,
    detail: `pessimistic median ${fmt(pess)}c ${marginal ? 'is' : 'is not'} in the marginal band.`,
  });
  if (marginal) {
    reasons.push(
      `pessimistic median ${fmt(pess)}c is in the marginal band [${MARGINAL_LOWER_BOUND_CENTS}, ${PESSIMISTIC_FAIL_MARKOUT_CENTS}]c.`,
    );
  }

  // Rule 4 — PASS (strictly below 1.0).
  const pass = pess !== null && pess < MARGINAL_LOWER_BOUND_CENTS;
  rules.push({
    id: 'pessimistic_pass',
    description: `PASS if pessimistic median adverseCents < ${MARGINAL_LOWER_BOUND_CENTS}c`,
    status: pass ? 'PASS' : 'FAIL',
    threshold: MARGINAL_LOWER_BOUND_CENTS,
    actual: pess,
    detail: `pessimistic median ${fmt(pess)}c ${pass ? 'is' : 'is not'} below ${MARGINAL_LOWER_BOUND_CENTS}c.`,
  });
  if (pass) {
    reasons.push(`pessimistic median adverseCents ${fmt(pess)}c < ${MARGINAL_LOWER_BOUND_CENTS}c.`);
  }

  // Rule 5 — taker share floor.
  const takerShareFail = takerShare !== null && takerShare < TAKER_SHARE_FLOOR;
  rules.push({
    id: 'taker_share_floor',
    description: `FAIL_TAKER_SHARE if measured takerShare < ${TAKER_SHARE_FLOOR}`,
    status: takerShareFail ? 'FAIL' : 'PASS',
    threshold: TAKER_SHARE_FLOOR,
    actual: takerShare,
    detail:
      takerShare === null
        ? 'takerShare not measurable from data; cannot fail on this rule.'
        : `measured takerShare = ${fmt(takerShare)}.`,
  });
  if (takerShareFail) {
    reasons.push(
      `measured takerShare ${fmt(takerShare)} < ${TAKER_SHARE_FLOOR}: gross edge drops below ${GROSS_EDGE_BPS} bps and the effective adverse-selection budget tightens below ${ADVERSE_SELECTION_BUDGET_CENTS}c.`,
    );
  }

  // Statistical-confidence gate.
  const insufficient = pess === null || n < MIN_FILLS_FOR_VERDICT;
  if (insufficient) {
    if (pess !== null) {
      reasons.push(
        `insufficient data for a verdict: pessimistic fill sample size = ${n} (need >= ${MIN_FILLS_FOR_VERDICT}).`,
      );
    } else if (n >= MIN_FILLS_FOR_VERDICT) {
      // The count gate passed; the missing median is the sole reason here, so the
      // count must be reported as satisfied rather than as an unmet "(need >= N)".
      reasons.push(
        `insufficient data for a verdict: no pessimistic median was computable, although the pessimistic fill sample size = ${n} meets the >= ${MIN_FILLS_FOR_VERDICT} requirement.`,
      );
    } else {
      reasons.push(
        `insufficient data for a verdict: pessimistic fill sample size = ${n} (need >= ${MIN_FILLS_FOR_VERDICT}), and no median was computable.`,
      );
    }
  }

  // Combine into a single headline. Every rule is still reported above, so no
  // single rule masks another.
  let overall: VerdictOutcome;
  if (insufficient) {
    overall = 'INSUFFICIENT_DATA';
  } else if (takerShareFail) {
    overall = 'FAIL_TAKER_SHARE';
  } else if (pessFail || medFail) {
    overall = 'FAIL';
  } else if (marginal) {
    overall = 'MARGINAL';
  } else {
    overall = 'PASS';
  }

  return {
    verdictVersion: VERDICT_VERSION,
    evaluatedAt: now.toISOString(),
    horizonSeconds: VERDICT_HORIZON_SECONDS,
    overall,
    rules,
    reasons,
  };
}
