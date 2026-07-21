// P09-S15: readPlanFraction pulls the "**All plans: X/Y steps complete.**" Dashboard line
// (CONTRACTS §PLAN-09). Stdlib-only; writes a fixture PROGRESS.md to a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPlanFraction } = require('../src/progress');

function fixtureDir(progressText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-frac-'));
  if (progressText != null) fs.writeFileSync(path.join(dir, 'PROGRESS.md'), progressText, 'utf8');
  return dir;
}

test('reads the fraction from the All-plans line', () => {
  const dir = fixtureDir('# PROGRESS\nstuff\n**All plans: 75/78 steps complete.**\nmore\n');
  assert.deepStrictEqual(readPlanFraction(dir), { done: 75, total: 78 });
});

test('handles a lone completed step (singular "step")', () => {
  const dir = fixtureDir('**All plans: 1/1 step complete.**\n');
  assert.deepStrictEqual(readPlanFraction(dir), { done: 1, total: 1 });
});

test('absent line → null, no throw', () => {
  const dir = fixtureDir('# PROGRESS\nno tally here\n');
  assert.strictEqual(readPlanFraction(dir), null);
});

test('missing PROGRESS.md → null, no throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-frac-'));
  assert.strictEqual(readPlanFraction(dir), null);
});
