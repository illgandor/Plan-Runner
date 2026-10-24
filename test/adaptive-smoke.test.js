// P24-S08a — the smoke fixture stays a valid, fully tagged project as the checker and tags evolve.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('../scripts/adaptive-smoke');
const { stepTags } = require('../src/adaptive');

test('adaptive-smoke: a committed, plan_check-green, tagged project', () => {
  const dir = make(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-smoke-')), 'fixture'));
  try {
    const out = execFileSync('python', ['planning/tools/plan_check.py'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /0 failure\(s\)/);
    assert.strictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
    // Read through the runner's own reader, so the fixture and stepTags() cannot drift apart.
    assert.deepStrictEqual(stepTags(dir, 'P01-S01'), { model: 'haiku', effort: 'low', ownerGate: false });
    assert.deepStrictEqual(stepTags(dir, 'P01-S02'), { model: 'sonnet', effort: 'medium', ownerGate: false });
    const plan = fs.readFileSync(path.join(dir, 'planning/plans/PLAN-01-adaptive-smoke.md'), 'utf8');
    const s01 = plan.slice(plan.indexOf('#### [P01-S01]'), plan.indexOf('#### [P01-S02]'));
    assert.match(s01, /contains `haiku` or `luna`, STOP NOW/);
    assert.throws(() => make(path.join(__dirname, 'nope')), /inside this repo/);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
