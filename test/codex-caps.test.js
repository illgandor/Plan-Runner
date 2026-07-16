// Codex capabilities + four-mode flag mapping (P02-S05 · reworked P03-S01). CODEX_CAPS feeds the
// dropdowns (via engine.capabilities('codex')); permissionArgs/buildArgs turn a mode into the real
// `--sandbox` flag + quoted `-c approval_policy=` (+ `approvals_reviewer` for auto-review) overrides.
// Exactly four Claude-symmetric modes, no full-auto/full-access (D-014); no bypass (D-002).
// Stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');
const { CODEX_CAPS, permissionArgs, buildArgs, supportsAutoReview, codexCaps,
  AUTO_REVIEW_UNAVAILABLE_MSG } = require('../src/codex');

test('reasoning efforts expose (default)+low..xhigh and DROP minimal (luna rejects it)', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh']) {
    assert.ok(CODEX_CAPS.efforts.includes(e), `missing effort ${e}`);
  }
  assert.ok(CODEX_CAPS.efforts.includes('(default)')); // "let Codex pick" sentinel like Claude
  assert.ok(!CODEX_CAPS.efforts.includes('minimal'), 'minimal must be dropped (luna would 400)');
});

test('models list carries the (default) fallback (volatile IDs degrade to it)', () => {
  assert.strictEqual(CODEX_CAPS.models[0], '(default)');
});

test('permissionModes are EXACTLY the four Claude-symmetric modes (no full-auto/full-access)', () => {
  const values = CODEX_CAPS.permissionModes.map((m) => m.value);
  assert.deepStrictEqual(values, ['plan', 'manual', 'acceptEdits', 'auto']);
  assert.ok(!values.includes('full-auto'), 'full-auto removed (D-014)');
  assert.ok(!values.includes('full-access'), 'full-access removed (D-002/D-014)');
  // Each entry is {value,label} so the webview can render it (§Engine dispatch shape).
  for (const m of CODEX_CAPS.permissionModes) {
    assert.strictEqual(typeof m.value, 'string');
    assert.strictEqual(typeof m.label, 'string');
  }
});

test('read-only modes emit a quoted approval_policy and NO reviewer', () => {
  assert.deepStrictEqual(permissionArgs('plan'),
    ['--sandbox', 'read-only', '-c', 'approval_policy="never"']);
  assert.deepStrictEqual(permissionArgs('manual'),
    ['--sandbox', 'read-only', '-c', 'approval_policy="on-request"']);
});

test('auto + acceptEdits self-commit via auto-review: on-request + approvals_reviewer', () => {
  const expected = ['--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"'];
  assert.deepStrictEqual(permissionArgs('acceptEdits'), expected);
  assert.deepStrictEqual(permissionArgs('auto'), expected);
});

test('every advertised permission mode maps to real flags (no dead dropdown entries)', () => {
  for (const m of CODEX_CAPS.permissionModes) {
    assert.ok(permissionArgs(m.value).length >= 4, `mode ${m.value} produced no flags`);
  }
});

test('the dead --add-dir .git hack is gone (auto-review handles the .git write now)', () => {
  assert.ok(!permissionArgs('auto').includes('--add-dir'), 'no --add-dir for auto');
  assert.ok(!permissionArgs('acceptEdits').includes('--add-dir'), 'no --add-dir for acceptEdits');
});

test('unknown/absent mode → no permission flags (Codex uses its own default)', () => {
  assert.deepStrictEqual(permissionArgs('nonsense'), []);
  assert.deepStrictEqual(permissionArgs(undefined), []);
});

test('buildArgs threads model, effort (incl xhigh) and the auto-review pair into one turn', () => {
  const a = buildArgs('do it', { model: 'gpt-5.6-luna', effort: 'xhigh', permissionMode: 'auto' });
  assert.deepStrictEqual(a, [
    'exec', '--json', '--skip-git-repo-check',
    '-m', 'gpt-5.6-luna',
    '-c', 'model_reasoning_effort=xhigh',
    '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"',
    'do it',
  ]);
});

test("buildArgs with (default) model/effort omits those flags but still sets the sandbox pair", () => {
  const a = buildArgs('go', { model: '(default)', effort: '(default)', permissionMode: 'plan' });
  assert.deepStrictEqual(a, [
    'exec', '--json', '--skip-git-repo-check',
    '--sandbox', 'read-only', '-c', 'approval_policy="never"',
    'go',
  ]);
});

// ── P03-S02: auto-review compatibility fail-safe ─────────────────────────────────
test('supportsAutoReview needs the >=0.144.0 floor; unparseable/absent → false (fail-safe)', () => {
  assert.ok(supportsAutoReview('codex-cli 0.144.0-alpha.4'), 'the verified known-good build');
  assert.ok(supportsAutoReview('0.144.0'), 'exactly the floor');
  assert.ok(supportsAutoReview('0.200.1'), 'newer major/minor');
  assert.ok(!supportsAutoReview('0.143.9'), 'older minor is too old');
  assert.ok(!supportsAutoReview(null), 'no version string → unsupported, never assume');
  assert.ok(!supportsAutoReview('garbage'), 'unparseable → unsupported');
});

test('codexCaps(true) leaves all four modes; codexCaps(false) drops the write modes + flags it', () => {
  assert.deepStrictEqual(codexCaps(true).permissionModes.map((m) => m.value),
    ['plan', 'manual', 'acceptEdits', 'auto'], 'supported CLI keeps every mode');
  assert.ok(!codexCaps(true).autoReviewUnavailable);

  const gated = codexCaps(false);
  assert.deepStrictEqual(gated.permissionModes.map((m) => m.value), ['plan', 'manual'],
    'unsupported CLI offers ONLY the read-only modes — no on-request write mode to stall');
  assert.ok(gated.autoReviewUnavailable, 'flagged so the panel can explain');
  assert.ok(!gated.permissionModes.some((m) => m.value === 'full-access'), 'never full-access (D-002)');
  assert.ok(gated.models === codexCaps(true).models, 'models/efforts untouched by the gate');
});

test('there is a clear message to show when auto-review is unavailable', () => {
  assert.match(AUTO_REVIEW_UNAVAILABLE_MSG, /auto/i);
  assert.match(AUTO_REVIEW_UNAVAILABLE_MSG, /update/i);
});
