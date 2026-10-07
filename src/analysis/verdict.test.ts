import { test } from 'node:test';
import assert from 'node:assert/strict';

// MIN_FILLS_FOR_VERDICT now lives in the shared contract alongside the other
// pre-registered thresholds, so the test reads it from there.
import { MIN_FILLS_FOR_VERDICT } from '../shared/config.js';
import { evaluateVerdict } from './verdict.js';
import type { VerdictInput } from './verdict.js';

function make(overrides: Partial<VerdictInput>): VerdictInput {
  return {
    pessimisticMedianAdverseCents: 0.5,
    medianModelMedianAdverseCents: 0.6,
    takerShare: 0.5,
    pessimisticFillCount: MIN_FILLS_FOR_VERDICT,
    ...overrides,
  };
}

test('PASS when pessimistic median < 1.0', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 0.99 }));
  assert.equal(v.overall, 'PASS');
});

test('MARGINAL band lower edge: exactly 1.0 is MARGINAL', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 1.0 }));
  assert.equal(v.overall, 'MARGINAL');
});

test('boundary: exactly 1.3 is NOT FAIL (the rule is strictly "> 1.3"), it is MARGINAL', () => {
  // The pre-registered FAIL rule is "pessimistic median > 1.3" (strict).
  // 1.3 is NOT strictly greater than 1.3, so the FAIL rule does not fire.
  // Instead 1.3 lands in the MARGINAL band [1.0, 1.3] (inclusive upper bound).
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 1.3 }));
  assert.equal(v.overall, 'MARGINAL');

  // Every rule is still printed; the strict-threshold rule reports PASS.
  const failRule = v.rules.find((r) => r.id === 'pessimistic_median_markout_fail');
  assert.equal(failRule?.status, 'PASS');
});

test('just above the boundary: 1.3000001 is FAIL (strictly greater than 1.3)', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 1.3000001 }));
  assert.equal(v.overall, 'FAIL');
});

test('median-model median > 2.0 is FAIL even when pessimistic passes', () => {
  const v = evaluateVerdict(
    make({ pessimisticMedianAdverseCents: 0.5, medianModelMedianAdverseCents: 2.1 }),
  );
  assert.equal(v.overall, 'FAIL');
});

test('takerShare < 0.5 is a distinct FAIL_TAKER_SHARE outcome', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 0.5, takerShare: 0.42 }));
  assert.equal(v.overall, 'FAIL_TAKER_SHARE');
  assert.ok(v.reasons.some((r) => r.includes('FAIL_TAKER_SHARE') === false && r.includes('takerShare')));
});

test('INSUFFICIENT_DATA when sample size is below the confidence floor', () => {
  const v = evaluateVerdict(make({ pessimisticFillCount: MIN_FILLS_FOR_VERDICT - 1 }));
  assert.equal(v.overall, 'INSUFFICIENT_DATA');
});

test('INSUFFICIENT_DATA when the pessimistic median is unavailable', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: null }));
  assert.equal(v.overall, 'INSUFFICIENT_DATA');
});

test('all rules are reported regardless of the overall verdict', () => {
  const v = evaluateVerdict(make({ pessimisticMedianAdverseCents: 1.5, takerShare: 0.4 }));
  const ids = v.rules.map((r) => r.id);
  assert.ok(ids.includes('pessimistic_median_markout_fail'));
  assert.ok(ids.includes('median_model_median_markout_fail'));
  assert.ok(ids.includes('pessimistic_marginal_band'));
  assert.ok(ids.includes('pessimistic_pass'));
  assert.ok(ids.includes('taker_share_floor'));
});

test('verdict carries a version and an evaluatedAt timestamp for reproducibility', () => {
  const v = evaluateVerdict(make({}));
  assert.ok(v.verdictVersion.length > 0);
  assert.ok(!Number.isNaN(Date.parse(v.evaluatedAt)));
});
