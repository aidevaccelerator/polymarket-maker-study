// Shared configuration: universe filters, pre-registered decision thresholds,
// and polling cadence. Values are VERBATIM from the project brief. The
// analysis agent imports these exact names; do not rename or re-type them.

// Universe discovery filters (Gamma metadata).
export const MIN_PROB = 0.3;
export const MAX_PROB = 0.7;
export const MIN_LIQUIDITY_USD = 25_000;
export const MIN_SPREAD_TICKS = 1;
export const ALLOWED_CATEGORIES = ['Politics', 'Finance', 'Economics'] as const;

// PRE-REGISTERED decision rules. Exported as individual constants (the
// analysis agent's `verdict.ts` imports them directly by name).
export const PESSIMISTIC_FAIL_MARKOUT_CENTS = 1.3;
export const MEDIAN_FAIL_MARKOUT_CENTS = 2.0;
export const TAKER_SHARE_FLOOR = 0.5;
// EXPLANATORY ONLY — this constant does not gate any verdict. No PASS, FAIL,
// MARGINAL, FAIL_TAKER_SHARE or INSUFFICIENT_DATA outcome depends on it. It
// appears only inside the reason string emitted when the taker-share rule fires
// (src/analysis/verdict.ts:167). See docs/THRESHOLDS.md "Constants that gate nothing".
export const GROSS_EDGE_BPS = 250; // 2.5%

// EXPLANATORY ONLY, same as GROSS_EDGE_BPS above — it does not gate any verdict
// and is compared against nothing. It appears only inside the reason string
// emitted when the taker-share rule fires (src/analysis/verdict.ts:167).
// See docs/THRESHOLDS.md "Constants that gate nothing".
export const ADVERSE_SELECTION_BUDGET_CENTS = 1.3;

// ---- Quantization parameters (promoted from src/analysis on 2026-10-07) ----
//
// These four were previously declared inside `src/analysis/**`, where they were
// invisible to the collector half and to any reviewer reading the contract
// first. They are not tunable thresholds -- they are the structural assumptions
// the experiment is parameterized by -- so they live here beside the
// pre-registered thresholds, where one place describes how the study is
// measured. Values are UNCHANGED from their previous analysis-side
// declarations; only the location moved.

// Size of the hypothetical resting order, in shares. Drives every queue-model
// result: fill fraction, fill size, total rebate accrued, and round-trip size
// (per-share markout is unaffected).
export const OUR_ORDER_SIZE = 100;

// Minimum pessimistic-model fill count before a verdict is statistically
// meaningful. Below this the headline is INSUFFICIENT_DATA, not PASS or FAIL.
export const MIN_FILLS_FOR_VERDICT = 100;

// Lower bound of the MARGINAL band, in cents of adverse mid movement per round
// trip. PASS when the pessimistic median is strictly below this; MARGINAL in
// [MARGINAL_LOWER_BOUND_CENTS, PESSIMISTIC_FAIL_MARKOUT_CENTS]; FAIL strictly
// above PESSIMISTIC_FAIL_MARKOUT_CENTS. From the pre-registered rule text.
export const MARGINAL_LOWER_BOUND_CENTS = 1.0;

// The horizon the verdict rules are applied at, in milliseconds (+30s). All
// four horizons (+1/+5/+30/+60s) are reported, but only this one is thresholded,
// so this is the single number to change if the canonical horizon moves.
export const CANONICAL_HORIZON_MS = 30_000;

// Polling intervals.
export const BOOK_POLL_MS = 5000;
export const TOB_POLL_MS = 1000;
