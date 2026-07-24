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

test("capabilities('claude') with no dynamic models returns the existing lists (fail-safe fallback)", () => {
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

// P10 model discovery: supportedModels() rows → {value,label} items with the resolved VERSION in
// the label (real CLI shape: value is the id to pass, resolvedModel is the exact version).
test('claudeModels builds versioned {value,label} items, (default) first, CLI default row dropped', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    { value: 'opus', resolvedModel: 'x', displayName: 'dupe' }, // dup value → dropped
    { resolvedModel: 'orphan' }, // no value → dropped
  ];
  assert.deepStrictEqual(engine.claudeModels(rows), [
    { value: '(default)', label: '(default)' },
    { value: 'opus', label: 'Opus · claude-opus-5' },   // <- exact version shown in the picker
    { value: 'sonnet', label: 'Sonnet · claude-sonnet-5' },
  ]);
});

test('claudeModels falls back to the stable alias strings when there are no rows (never empty)', () => {
  assert.deepStrictEqual(engine.claudeModels([]), ['(default)', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.deepStrictEqual(engine.claudeModels(undefined), ['(default)', 'fable', 'opus', 'sonnet', 'haiku']);
});

test('modelValues extracts value strings from mixed alias-string / {value} lists', () => {
  assert.deepStrictEqual(engine.modelValues(['(default)', 'opus']), ['(default)', 'opus']);
  assert.deepStrictEqual(engine.modelValues([{ value: '(default)' }, { value: 'opus' }]), ['(default)', 'opus']);
});

test("capabilities('claude', rows) builds the versioned model list; efforts/modes unchanged", () => {
  const c = engine.capabilities('claude', [{ value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' }]);
  assert.deepStrictEqual(engine.modelValues(c.models), ['(default)', 'opus']);
  assert.ok(c.models.some((m) => m.label === 'Opus · claude-opus-5'), 'label carries the version');
  assert.deepStrictEqual(c.efforts, ['(default)', 'low', 'medium', 'high', 'xhigh', 'max']);
});
