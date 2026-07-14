// Codex capabilities + full-capability flag mapping (P02-S05). CODEX_CAPS feeds the dropdowns
// (via engine.capabilities('codex')); permissionArgs/buildArgs turn a mode into the real
// `--sandbox`/`--ask-for-approval` pair. Full capability, no dumbing down (D-011/D-013).
// Stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');
const { CODEX_CAPS, permissionArgs, buildArgs } = require('../src/codex');

test('every reasoning effort is exposed, including xhigh', () => {
  for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.ok(CODEX_CAPS.efforts.includes(e), `missing effort ${e}`);
  }
  assert.ok(CODEX_CAPS.efforts.includes('(default)')); // "let Codex pick" sentinel like Claude
});

test('models list carries the (default) fallback (volatile IDs degrade to it)', () => {
  assert.strictEqual(CODEX_CAPS.models[0], '(default)');
});

test('permissionModes cover the four contract modes PLUS full-auto/full-access (D-011)', () => {
  const values = CODEX_CAPS.permissionModes.map((m) => m.value);
  for (const v of ['plan', 'manual', 'acceptEdits', 'auto', 'full-auto', 'full-access']) {
    assert.ok(values.includes(v), `missing mode ${v}`);
  }
  // Each entry is {value,label} so the webview can render it (§Engine dispatch shape).
  for (const m of CODEX_CAPS.permissionModes) {
    assert.strictEqual(typeof m.value, 'string');
    assert.strictEqual(typeof m.label, 'string');
  }
});

test('each mode yields the correct (sandbox, approval) flag pair', () => {
  assert.deepStrictEqual(permissionArgs('plan'), ['--sandbox', 'read-only', '--ask-for-approval', 'never']);
  assert.deepStrictEqual(permissionArgs('manual'), ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
  assert.deepStrictEqual(permissionArgs('acceptEdits'), ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']);
  assert.deepStrictEqual(permissionArgs('auto'), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.deepStrictEqual(permissionArgs('full-auto'), ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-failure']);
  assert.deepStrictEqual(permissionArgs('full-access'), ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
});

test('every advertised permission mode maps to a real flag pair (no dead dropdown entries)', () => {
  for (const m of CODEX_CAPS.permissionModes) {
    assert.strictEqual(permissionArgs(m.value).length, 4, `mode ${m.value} produced no flags`);
  }
});

test('unknown/absent mode → no permission flags (Codex uses its own default)', () => {
  assert.deepStrictEqual(permissionArgs('nonsense'), []);
  assert.deepStrictEqual(permissionArgs(undefined), []);
});

test('buildArgs threads model, effort (incl xhigh) and the permission pair into one turn', () => {
  const a = buildArgs('do it', { model: 'gpt-5-codex', effort: 'xhigh', permissionMode: 'full-auto' });
  assert.deepStrictEqual(a, [
    'exec', '--json', '--skip-git-repo-check',
    '-m', 'gpt-5-codex',
    '-c', 'model_reasoning_effort=xhigh',
    '--sandbox', 'workspace-write', '--ask-for-approval', 'on-failure',
    'do it',
  ]);
});

test("buildArgs with (default) model/effort omits those flags but still sets the sandbox pair", () => {
  const a = buildArgs('go', { model: '(default)', effort: '(default)', permissionMode: 'plan' });
  assert.deepStrictEqual(a, [
    'exec', '--json', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    'go',
  ]);
});
