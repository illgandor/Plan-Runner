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

// P10 model discovery: ModelInfo[] → flat id list (alias value + explicit resolvedModel).
test('claudeModelValues flattens each row to value + resolvedModel (deduped per row)', () => {
  assert.deepStrictEqual(engine.claudeModelValues([
    { value: 'opus', resolvedModel: 'claude-opus-5-20260514' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
    { value: 'claude-haiku-4-5', resolvedModel: 'claude-haiku-4-5' }, // same → no dupe
    { resolvedModel: 'orphan' }, // no value → skipped
    null,
  ]), ['opus', 'claude-opus-5-20260514', 'sonnet', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.deepStrictEqual(engine.claudeModelValues(undefined), []); // no session yet → empty
});

test('mergeClaudeModels keeps aliases first, dedups, and appends new ids (opus 5 available, no app update)', () => {
  const merged = engine.mergeClaudeModels(['opus', 'claude-opus-5-20260514', 'sonnet']);
  // aliases stay in place; the explicit new id is appended; the alias dupes drop
  assert.deepStrictEqual(merged,
    ['(default)', 'fable', 'opus', 'sonnet', 'haiku', 'claude-opus-5-20260514']);
  // empty / absent dynamic list → exactly the stable aliases (never an empty dropdown)
  assert.deepStrictEqual(engine.mergeClaudeModels([]), ['(default)', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.deepStrictEqual(engine.mergeClaudeModels(), ['(default)', 'fable', 'opus', 'sonnet', 'haiku']);
});

test("capabilities('claude', dynamic) enriches only the model list; efforts/modes unchanged", () => {
  const c = engine.capabilities('claude', ['claude-opus-5-20260514']);
  assert.ok(c.models.includes('claude-opus-5-20260514'), 'new id is selectable');
  assert.ok(c.models.includes('opus'), 'alias still present');
  assert.deepStrictEqual(c.efforts, ['(default)', 'low', 'medium', 'high', 'xhigh', 'max']);
});
