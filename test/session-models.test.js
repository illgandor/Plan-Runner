// P10 model discovery: the session captures the EXACT resolved model from init.model and, once
// live, publishes the CLI's model catalog as a `session:models` sink event. Stdlib-only (node:test),
// no Claude usage — query() is faked (async-iterable + a supportedModels() method), nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const session = require('../src/session');

// A fake query: async-iterable that yields one init (carrying model), plus a supportedModels() method.
function fakeQuery(infos, model) {
  return () => {
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-m', model };
    })();
    gen.supportedModels = async () => infos;
    return gen; // native async-generator .return()/.interrupt handling is what fetchModels tears down with

  };
}
const OPUS5 = { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' };
const SONNET5 = { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' };
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget model fetch

test('init.model is captured as the resolved model, and supportedModels publishes session:models', async () => {
  const events = [];
  session.setSink((evt) => events.push(evt));
  session.setQuery(fakeQuery([OPUS5, SONNET5], 'claude-opus-5'));
  assert.strictEqual(session.resolvedModel('proj-m'), null, 'unknown id → null');

  await new Promise((done) => session.start({ id: 'proj-m', cwd: '/cwd', prompt: 'go', options: {} }, { onDone: done }));
  await tick();

  assert.strictEqual(session.resolvedModel('proj-m'), 'claude-opus-5', 'exact resolved id captured');
  // The init UI event carries the resolved model for the panel to display.
  const init = events.find((e) => e.channel === 'session:message' && e.payload.msg.type === 'init');
  assert.strictEqual(init.payload.msg.model, 'claude-opus-5');
  // The model catalog is published (value + resolvedModel + displayName) for the host to cache.
  const models = events.find((e) => e.channel === 'session:models');
  assert.ok(models, 'session:models emitted');
  assert.deepStrictEqual(models.payload.models, [OPUS5, SONNET5]);
  assert.deepStrictEqual(session.supportedModels('proj-m'), models.payload.models);
});

test('fetchModels returns the catalog rows from a throwaway query (proactive seed path)', async () => {
  session.setQuery(fakeQuery([OPUS5, SONNET5], 'claude-opus-5'));
  const rows = await session.fetchModels('/cwd', { claudePath: 'C:/fake/claude.exe' });
  assert.deepStrictEqual(rows, [OPUS5, SONNET5]);
});

test('fetchModels returns [] when no claude binary resolves (never throws)', async () => {
  assert.deepStrictEqual(await session.fetchModels('/cwd', { claudePath: null }), []);
});

test('an old CLI (query without supportedModels) still runs — no catalog, no throw (fail-safe)', async () => {
  const events = [];
  session.setSink((evt) => events.push(evt));
  session.setQuery(() => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sess-old' }; // no model, no supportedModels()
  })());

  await new Promise((done) => session.start({ id: 'proj-old', cwd: '/cwd', prompt: 'go', options: {} }, { onDone: done }));
  await tick();

  assert.strictEqual(session.resolvedModel('proj-old'), null, 'no model on init → nothing captured');
  assert.ok(!events.some((e) => e.channel === 'session:models'), 'no catalog event when the method is absent');
});
