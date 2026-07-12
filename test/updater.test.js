// semverGt is the only real logic in the self-updater; the rest is best-effort I/O.
// Stdlib-only (node:test) — spends no Claude usage. updater.js requires vscode lazily,
// so importing it here (no vscode present) is safe.
const test = require('node:test');
const assert = require('node:assert');
const { semverGt } = require('../src/updater');

test('semverGt orders released versions correctly', () => {
  assert.ok(semverGt('0.1.1', '0.1.0'), '0.1.0 < 0.1.1');
  assert.ok(semverGt('0.2.0', '0.1.1'), '0.1.1 < 0.2.0');
  assert.ok(semverGt('1.0.0', '0.2.0'), '0.2.0 < 1.0.0');
  assert.ok(!semverGt('0.1.0', '0.1.0'), 'equal is not greater');
  assert.ok(!semverGt('0.1.0', '0.1.1'), 'older is not greater');
  assert.ok(!semverGt('0.9.0', '1.0.0'), 'major dominates');
});
