// The host's pack storage refuses an `in` filter with no values or more than 100 ("in takes 1 to 100 values").
// The in-memory stores of the other tests accept both, so this one asks through a call as strict as the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap, inList, eq, IN_MAX } from '../tools/lib/store.mjs';

function strict(rows) {
  const asked = [];
  const call = async (table, op, body) => {
    for (const w of body.where ?? []) if (w.op === 'in' && (w.values.length < 1 || w.values.length > IN_MAX)) throw new Error('invalid request: in takes 1 to 100 values');
    asked.push(body);
    const ok = r => (body.where ?? []).every(w => (w.op === 'in' ? w.values.includes(r[w.column]) : w.op === 'eq' ? r[w.column] === w.value : true));
    const hit = rows.filter(ok);
    if (op === 'query') return { rows: hit.slice(0, body.limit ?? 500) };
    return { affected: hit.length };
  };
  return { store: wrap(call), asked };
}

test('an empty in-list matches nothing and asks the host nothing', async () => {
  const { store, asked } = strict([{ key: 'a' }]);
  assert.deepEqual(await store.query('bundles', [inList('key', [])], { limit: 200 }), []);
  assert.equal(await store.one('bundles', [inList('key', [])]), null);
  assert.equal(await store.update('bundles', [inList('key', [])], { x: 1 }), 0);
  assert.equal(await store.remove('bundles', [inList('key', [])]), 0);
  assert.equal(asked.length, 0);
});

test('more than 100 values are asked in slices and come back ordered and cut to the limit', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ key: `k${String(i).padStart(3, '0')}`, product: i % 2 ? 'lohi' : 'x', created_at: String(i).padStart(3, '0') }));
  const { store, asked } = strict(rows);
  const got = await store.query('bundles', [eq('product', 'lohi'), inList('key', rows.map(r => r.key))], { limit: 50 });
  assert.equal(asked.length, 3);
  assert.equal(got.length, 50);
  assert.ok(got.every(r => r.product === 'lohi'));
  assert.equal(got[0].key, 'k249');
  assert.ok(got.every((r, i) => i === 0 || got[i - 1].created_at > r.created_at));
});
