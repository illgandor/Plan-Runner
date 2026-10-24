// P24-S03: src/adaptive.js against CONTRACTS §Adaptive effort. Stdlib only, temp-dir plans.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/adaptive');
const { codexCaps } = require('../src/codex');

function repo(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-'));
  fs.mkdirSync(path.join(cwd, 'planning', 'plans'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, 'planning', 'plans', name), text);
  return cwd;
}
const H = '#### [P05-S03] Title  `[M]`  `[deps: —]`  `[owner-gate: no]`';
const plan = (...lines) => ['# PLAN-05', '', ...lines, '**Objective:** x'].join('\r\n');

test('default mode: an untagged heading (every plan before PLAN-24) is null', () => {
  assert.strictEqual(A.stepTags(repo({ 'PLAN-05-x.md': plan(H) }), 'P05-S03'), null);
});

test('a tagged heading parses; owner-gate is read from the same line', () => {
  const cwd = repo({ 'PLAN-05-x.md': plan(`${H}  \`[model: sonnet]\`  \`[effort: medium]\``,
    '#### [P05-S04] T  `[S]`  `[deps: —]`  `[owner-gate: yes]`  `[model: opus]`  `[effort: max]`') });
  assert.deepStrictEqual(A.stepTags(cwd, 'P05-S03'), { model: 'sonnet', effort: 'medium', ownerGate: false });
  assert.deepStrictEqual(A.stepTags(cwd, 'P05-S04'), { model: 'opus', effort: 'max', ownerGate: true });
});

test('half-tagged, unknown values, wrong case, missing plan/heading, two plans, bad id → null', () => {
  const one = (h) => A.stepTags(repo({ 'PLAN-05-x.md': plan(h) }), 'P05-S03');
  assert.strictEqual(one(`${H}  \`[model: sonnet]\``), null);
  assert.strictEqual(one(`${H}  \`[effort: low]\``), null);
  assert.strictEqual(one(`${H}  \`[model: gpt]\`  \`[effort: low]\``), null);
  assert.strictEqual(one(`${H}  \`[model: sonnet]\`  \`[effort: extreme]\``), null);
  assert.strictEqual(one(`${H}  \`[model: Sonnet]\`  \`[effort: low]\``), null);
  // tags on a body line are never read — only the heading
  assert.strictEqual(A.stepTags(repo({ 'PLAN-05-x.md': plan(H, '`[model: sonnet]` `[effort: low]`') }), 'P05-S03'), null);
  assert.strictEqual(A.stepTags(repo({}), 'P05-S03'), null);
  assert.strictEqual(A.stepTags(repo({ 'PLAN-05-x.md': plan('#### [P05-S01] other') }), 'P05-S03'), null);
  const tagged = plan(`${H}  \`[model: sonnet]\`  \`[effort: low]\``);
  assert.strictEqual(A.stepTags(repo({ 'PLAN-05-a.md': tagged, 'PLAN-05-b.md': tagged }), 'P05-S03'), null);
  assert.strictEqual(A.stepTags(repo({ 'PLAN-05-x.md': tagged }), 'nonsense'), null);
  assert.strictEqual(A.stepTags(path.join(os.tmpdir(), 'no-such-repo-xyz'), 'P05-S03'), null);
});

test('resolve: the frozen engine table; Codex max → xhigh, Claude keeps max', () => {
  const r = (model, effort, engine) => A.resolve({ model, effort }, engine);
  assert.deepStrictEqual(r('opus', 'max', 'claude'), { model: 'opus[1m]', effort: 'max' });
  assert.deepStrictEqual(r('haiku', 'low', 'claude'), { model: 'haiku', effort: 'low' });
  assert.deepStrictEqual(r('opus', 'max', 'codex'), { model: 'gpt-5.6-sol', effort: 'xhigh' });
  assert.deepStrictEqual(r('fable', 'high', 'codex'), { model: 'gpt-5.6-sol', effort: 'high' });
  assert.deepStrictEqual(r('sonnet', 'medium', 'codex'), { model: 'gpt-5.6-terra', effort: 'medium' });
  assert.deepStrictEqual(r('haiku', 'low', 'codex'), { model: 'gpt-5.6-luna', effort: 'low' });
});

test('the Codex column is a subset of the Codex model list', () => {
  for (const t of A.TIERS) assert.ok(codexCaps(true).models.includes(A.resolve({ model: t, effort: 'low' }, 'codex').model), t);
});

test('stepUp: one tier at a time, effort ≥ high, ownerGate carried; Codex tops out at opus', () => {
  const t = { model: 'haiku', effort: 'low', ownerGate: false };
  const s1 = A.stepUp(t, 'claude');
  assert.deepStrictEqual(s1, { model: 'sonnet', effort: 'high', ownerGate: false });
  assert.deepStrictEqual(A.stepUp({ ...s1, effort: 'max' }, 'claude'), { model: 'opus', effort: 'max', ownerGate: false });
  assert.deepStrictEqual(A.stepUp({ model: 'opus', effort: 'xhigh', ownerGate: true }, 'claude'),
    { model: 'fable', effort: 'xhigh', ownerGate: true });
  assert.strictEqual(A.stepUp({ model: 'fable', effort: 'high' }, 'claude'), null);
  assert.strictEqual(A.stepUp({ model: 'opus', effort: 'high' }, 'codex'), null);
  assert.strictEqual(A.stepUp({ model: 'fable', effort: 'high' }, 'codex'), null);
  assert.strictEqual(A.stepUp({ model: 'sonnet', effort: 'low' }, 'codex').model, 'opus');
});

test('escalationRecord + reachedTier', () => {
  assert.deepStrictEqual(A.escalationRecord('P05-S03', 'haiku', 'sonnet', 'errored', 't0'),
    { kind: 'escalation', stepId: 'P05-S03', from: 'haiku', to: 'sonnet', reason: 'errored', at: 't0' });
  assert.throws(() => A.escalationRecord('P05-S03', 'haiku', 'sonnet', 'bored', 't0'));
  const recs = [
    { kind: 'step', stepId: 'P05-S03', model: 'fable' },
    A.escalationRecord('P05-S03', 'sonnet', 'opus', 'unfinished', 't2'),
    A.escalationRecord('P05-S03', 'haiku', 'sonnet', 'stuck', 't1'),
    A.escalationRecord('P05-S04', 'opus', 'fable', 'errored', 't3'),
  ];
  assert.strictEqual(A.reachedTier(recs, 'P05-S03'), 'opus');
  assert.strictEqual(A.reachedTier(recs, 'P05-S09'), null);
  assert.strictEqual(A.reachedTier(undefined, 'P05-S03'), null);
});

test('ESCALATE_PROMPT is the frozen text', () => {
  assert.match(A.ESCALATE_PROMPT, /^A stronger model is taking over this step\./);
  assert.match(A.ESCALATE_PROMPT, /starts NEEDS OWNER: and the reason\.$/);
  assert.deepStrictEqual(A.TIERS, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepStrictEqual(A.EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});
