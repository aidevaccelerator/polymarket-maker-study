import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMarket } from './gamma.js';
import type { UniverseCandidate } from './gamma.js';

function candidate(overrides: Partial<UniverseCandidate> = {}): UniverseCandidate {
  return {
    conditionId: 'c1',
    tokenIds: ['tYes', 'tNo'],
    outcomes: ['Yes', 'No'],
    category: 'Politics',
    liquidityNum: 100_000,
    active: true,
    closed: false,
    outcomePrices: [0.5, 0.5],
    lastTradePrice: 0.5,
    bestBid: 0.49,
    bestAsk: 0.51,
    question: 'q',
    slug: 's',
    ...overrides,
  };
}

test('accepts a liquid, mid-range, politics market', () => {
  const result = classifyMarket(candidate());
  assert.equal(result.accept, true);
  if (result.accept) assert.equal(result.market.tokenId, 'tYes');
});

test('rejects a disallowed category', () => {
  assert.deepEqual(classifyMarket(candidate({ category: 'Sports' })), {
    accept: false,
    reason: 'category',
  });
});

test('rejects thin liquidity', () => {
  assert.deepEqual(classifyMarket(candidate({ liquidityNum: 100 })), {
    accept: false,
    reason: 'liquidity',
  });
});

test('rejects out-of-range low probability', () => {
  assert.deepEqual(classifyMarket(candidate({ outcomePrices: [0.2, 0.8] })), {
    accept: false,
    reason: 'probability',
  });
});

test('rejects out-of-range high probability', () => {
  assert.deepEqual(classifyMarket(candidate({ outcomePrices: [0.8, 0.2] })), {
    accept: false,
    reason: 'probability',
  });
});
