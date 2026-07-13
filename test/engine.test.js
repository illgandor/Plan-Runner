// The dispatcher selects a provider by engine id and exposes each engine's capabilities.
// 'claude' must resolve to today's session.js (behavior preserved, D-012) and report the
// existing model/effort/mode lists verbatim; unknown/absent ids default to Claude. Stdlib
// only, spends no usage (pure lookups). (P02-S03)
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/engine');
const session = require('../src/session');

test("provider('claude') is the session.js module", () => {
  assert.strictEqual(engine.provider('claude'), session);
});

test('unknown / absent engine id defaults to Claude', () => {
  assert.strictEqual(engine.provider(undefined), session);
  assert.strictEqual(engine.provider('nope'), session);
});

test('the Claude provider exposes the full session surface (mirror target for codex.js)', () => {
  for (const fn of ['start', 'send', 'chat', 'interrupt', 'stop', 'currentSessionId']) {
    assert.strictEqual(typeof session[fn], 'function', `session.${fn} must exist`);
  }
});

test("capabilities('claude') returns the existing model/effort/mode lists", () => {
  assert.deepStrictEqual(engine.capabilities('claude'), {
    models: ['(default)', 'fable', 'opus', 'sonnet', 'haiku'],
    efforts: ['(default)', 'low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: [
      { value: 'auto', label: 'auto' },
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'plan', label: 'plan' },
      { value: 'manual', label: 'manual' },
    ],
  });
});
