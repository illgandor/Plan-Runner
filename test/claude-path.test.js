// findClaude resolves the claude binary from PLANRUNNER_CLAUDE → PATH → the bundled
// fallback, and returns null only when all three are absent (post-S10 bundle drop → the
// caller shows an install notice, D-019). Stdlib-only, spends no usage: fake temp files. (P06-S09)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude, EXE } = require('../src/claude-path');

function fakeExe(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const exe = path.join(dir, EXE);
  fs.writeFileSync(exe, '');
  return { dir, exe };
}

test('PLANRUNNER_CLAUDE override wins over PATH and bundled', () => {
  const { exe } = fakeExe('claudeov-');
  const { dir: onPath } = fakeExe('claudepath-');
  const got = findClaude({ env: { PLANRUNNER_CLAUDE: exe, PATH: onPath }, bundled: exe });
  assert.strictEqual(got, exe);
});

test('PATH resolves when no override is set', () => {
  const { dir, exe } = fakeExe('claudepath-');
  const got = findClaude({ env: { PATH: dir }, bundled: null });
  assert.strictEqual(got, exe);
});

test('bundled binary is the last-resort fallback', () => {
  const { exe } = fakeExe('claudebundle-');
  const got = findClaude({ env: { PATH: '' }, bundled: exe });
  assert.strictEqual(got, exe);
});

test('returns null when env, PATH, and bundle are all gone', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claudenone-'));
  assert.strictEqual(findClaude({ env: { PATH: empty }, bundled: null }), null);
});
