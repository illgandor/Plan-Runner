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
// the label. Real CLI shape (post-2.1.219): value is the id to pass, resolvedModel the exact version.
// The standard-context Opus is dropped so ONLY the 1M variant is offered (owner ruling S0092).
test('claudeModels: versioned labels, (default) first, CLI default row dropped, only 1M Opus offered', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
    { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' }, // standard-context → dropped
  ];
  assert.deepStrictEqual(engine.claudeModels(rows), [
    { value: '(default)', label: '(default)' },
    { value: 'opus[1m]', label: 'Opus (1M context) · claude-opus-5[1m]' }, // the ONLY Opus offered
    { value: 'claude-fable-5[1m]', label: 'Fable · claude-fable-5' },
    { value: 'sonnet', label: 'Sonnet · claude-sonnet-5' },
    { value: 'haiku', label: 'Haiku · claude-haiku-4-5-20251001' },
  ]);
  assert.ok(!engine.modelValues(engine.claudeModels(rows)).includes('opus'), 'standard-context opus is gone');
});

test('claudeModels dedups repeated values and skips rows with no id', () => {
  const rows = [
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    { value: 'sonnet', resolvedModel: 'x', displayName: 'dupe' }, // dup value → dropped
    { resolvedModel: 'orphan' }, // no value → dropped
  ];
  assert.deepStrictEqual(engine.claudeModels(rows), [
    { value: '(default)', label: '(default)' },
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

test('validModelRows accepts row objects, rejects a stale value-string cache / empty / junk', () => {
  assert.ok(engine.validModelRows([{ value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' }]));
  assert.ok(!engine.validModelRows(['opus', 'sonnet']), 'pre-v0.2.6 string cache is invalid → re-seed');
  assert.ok(!engine.validModelRows([]), 'empty → invalid');
  assert.ok(!engine.validModelRows(null) && !engine.validModelRows(undefined));
});

test("capabilities('claude', rows) builds the versioned model list; efforts/modes unchanged", () => {
  const c = engine.capabilities('claude', [{ value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' }]);
  assert.deepStrictEqual(engine.modelValues(c.models), ['(default)', 'opus']);
  assert.ok(c.models.some((m) => m.label === 'Opus · claude-opus-5'), 'label carries the version');
  assert.deepStrictEqual(c.efforts, ['(default)', 'low', 'medium', 'high', 'xhigh', 'max']);
});
