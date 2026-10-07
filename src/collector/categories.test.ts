import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoriesFromEvent } from './categories.js';

function event(tags: unknown, markets: unknown): unknown {
  return { slug: 'e', tags, markets };
}

function market(conditionId: string): unknown {
  return { conditionId };
}

describe('categoriesFromEvent', () => {
  it('maps child markets to an allowed category from event tags', () => {
    const result = categoriesFromEvent(
      event([{ id: '484', label: 'Politics' }], [market('0xabc'), market('0xdef')]),
    );
    assert.deepEqual(result, [
      { conditionId: '0xabc', category: 'Politics' },
      { conditionId: '0xdef', category: 'Politics' },
    ]);
  });

  it('returns empty when no tag is an allowed category', () => {
    assert.deepEqual(
      categoriesFromEvent(event([{ label: 'Crypto' }, { label: 'Sports' }], [market('0xabc')])),
      [],
    );
  });

  it('takes the first allowed label in tag order when several are present', () => {
    const result = categoriesFromEvent(
      event([{ label: 'Finance' }, { label: 'Crypto' }, { label: 'Politics' }], [market('0xabc')]),
    );
    assert.deepEqual(result, [{ conditionId: '0xabc', category: 'Finance' }]);
  });

  it('returns empty when tags are absent or null', () => {
    assert.deepEqual(categoriesFromEvent(event(null, [market('0xabc')])), []);
    assert.deepEqual(categoriesFromEvent({ slug: 'e', markets: [market('0xabc')] }), []);
  });

  it('skips malformed market entries and condition-less rows', () => {
    const result = categoriesFromEvent(
      event([{ label: 'Economics' }], [market('0xok'), 'nope', null, { conditionId: '' }, { x: 1 }]),
    );
    assert.deepEqual(result, [{ conditionId: '0xok', category: 'Economics' }]);
  });
});