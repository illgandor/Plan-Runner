// Smoke test: the runner's core contract loads and the PROGRESS pointer regex works.
// Stdlib-only (node:test) — spends no Claude usage. The `unit` gate anchor.
const test = require('node:test');
const assert = require('node:assert');
const { POINTER_RE, STEP_PROMPT, ALLOWED_TOOLS } = require('../src/constants');

test('constants module loads its exports', () => {
  assert.ok(POINTER_RE instanceof RegExp);
  assert.ok(typeof STEP_PROMPT === 'string' && STEP_PROMPT.length > 0);
  assert.ok(Array.isArray(ALLOWED_TOOLS) && ALLOWED_TOOLS.length > 0);
});

test('POINTER_RE extracts the NEXT step id', () => {
  const m = 'NEXT: P01-S01a — do the thing'.match(POINTER_RE);
  assert.ok(m);
  assert.equal(m[1].trim().split(/\s/)[0], 'P01-S01a');
});
