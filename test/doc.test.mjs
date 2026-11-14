import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunDoc, persistLocalNow } from '../web/lib/doc.mjs';

const mk = (by) => { const d = new RunDoc('test'); d.by = by; d._persistSoon = () => {}; return d; };

test('LWW map converges regardless of merge order and duplicates', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:route-29:p1', { species: 16 });
  b.set('enc:route-29:p2', { species: 161 });
  b.set('pair:route-29', { state: 'dead' });
  a.set('rules', { typeClause: 'off' });
  b.set('rules', { typeClause: 'party' }); // later write wins
  const snapA = structuredClone(a.entries);
  const snapB = structuredClone(b.entries);
  a.merge(snapB); a.merge(snapB);
  b.merge(snapA);
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.get('rules').typeClause, 'party');
  assert.equal(a.get('pair:route-29').state, 'dead');
});

test('deletes are tombstones that win over older values', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:x:p1', { species: 1 });
  b.merge(structuredClone(a.entries));
  b.del('enc:x:p1');
  a.merge(structuredClone(b.entries));
  assert.equal(a.get('enc:x:p1'), undefined);
  assert.deepEqual(a.scan('enc:'), {});
});

test('a failed server save is retried with growing pauses until it succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error('server restarting');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  try {
    const d = new RunDoc('retry');
    d.by = 'a';
    d.set('enc:x:p1', { species: 1 });
    t.mock.timers.tick(600); // debounce → first try
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 1); // not before the first pause is over
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(calls, 3); // succeeded – no more tries
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the browser copy is written once the changes settle, not on every change – and when the page goes (#44)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) });
  const store = new Map();
  let writes = 0;
  const ls = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { if (k.startsWith('sl-doc-')) writes++; store.set(k, String(v)); } } });
  try {
    const d = new RunDoc('ls');
    d.by = 'a';
    for (let hp = 20; hp > 10; hp--) d.set('live:p1', { party: [{ hp, maxHp: 20 }] }); // a battle's HP ticks
    assert.equal(writes, 0);
    t.mock.timers.tick(599);
    assert.equal(writes, 0);
    t.mock.timers.tick(1);
    assert.equal(writes, 1, 'one write for the whole burst');
    assert.equal(JSON.parse(store.get('sl-doc-ls'))['live:p1'].v.party[0].hp, 11);
    // a change right before the page goes isn't lost
    d.set('enc:x:p1', { species: 1 });
    persistLocalNow(); // pagehide
    assert.equal(writes, 2);
    assert.ok(JSON.parse(store.get('sl-doc-ls'))['enc:x:p1']);
    t.mock.timers.tick(600);
    assert.equal(writes, 3, '(the timer writes again – harmless)');
  } finally {
    globalThis.fetch = savedFetch;
    if (ls) Object.defineProperty(globalThis, 'localStorage', ls);
    else delete globalThis.localStorage;
  }
});
