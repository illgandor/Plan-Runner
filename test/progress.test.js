// P09-S15: readPlanFraction pulls the "**All plans: X/Y steps complete.**" Dashboard line
// (CONTRACTS §PLAN-09). Stdlib-only; writes a fixture PROGRESS.md to a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPlanFraction, readPointer } = require('../src/progress');
const { POINTER_RE } = require('../src/constants');

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

// P17-S01: readPointer(dir, lane) — the bare and the lane-qualified pointer, one reader (D-077).
const BARE = '## ▶ NEXT STEP\nNEXT: P17-S01\nPlan: planning/plans/PLAN-17-x.md\n';
const LANED = '## ▶ NEXT STEP\nNEXT[tyler]: P17-S01\nNEXT[reno]: P17-S03\nPlan: planning/plans/PLAN-17-x.md\n';

test('bare file + no lane → the bare pointer (today\'s behaviour)', () => {
  assert.strictEqual(readPointer(fixtureDir(BARE)), 'P17-S01');
});

test('bare file + a lane → falls back to the bare pointer', () => {
  assert.strictEqual(readPointer(fixtureDir(BARE), 'tyler'), 'P17-S01');
});

test('laned file + matching lane → that lane\'s step', () => {
  const dir = fixtureDir(LANED);
  assert.strictEqual(readPointer(dir, 'tyler'), 'P17-S01');
  assert.strictEqual(readPointer(dir, 'reno'), 'P17-S03');
});

test('laned file + another lane → null, never a guess (D-080)', () => {
  assert.strictEqual(readPointer(fixtureDir(LANED), 'dave'), null);
});

test('laned file + no lane → null (a solo reader refuses a laned file)', () => {
  assert.strictEqual(readPointer(fixtureDir(LANED), ''), null);
  assert.strictEqual(readPointer(fixtureDir(LANED)), null);
});

test('a lane name with a regex metacharacter matches literally, not as a pattern', () => {
  const dir = fixtureDir('NEXT[abc]: P17-S99\nNEXT[a.c]: P17-S01\n');
  assert.strictEqual(readPointer(dir, 'a.c'), 'P17-S01');
  assert.strictEqual(readPointer(dir, 'a+c'), null);
});

test('missing PROGRESS.md → null pointer, no throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-frac-'));
  assert.strictEqual(readPointer(dir, 'tyler'), null);
});

test('POINTER_RE itself is unchanged: bare hits, laned does not', () => {
  assert.strictEqual('NEXT: P17-S01'.match(POINTER_RE)[1], 'P17-S01');
  assert.strictEqual('NEXT[tyler]: P17-S01'.match(POINTER_RE), null);
});
