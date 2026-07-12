// P01-S07: session-id capture + resume plumbing (CONTRACTS §Session API; D-005).
// Stdlib-only (node:test), no Claude usage — query() is faked, nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const session = require('../src/session');

test('sdkOptions includes resume iff passed', () => {
  assert.strictEqual(session.sdkOptions('/cwd', { resume: 'abc' }).resume, 'abc');
  assert.ok(!('resume' in session.sdkOptions('/cwd', {})), 'default omits resume');
});

test('currentSessionId returns the id captured from a fake init', async () => {
  // Fake query yields one init message carrying session_id, then ends.
  session.setQuery(() => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sess-xyz' };
  })());
  assert.strictEqual(session.currentSessionId('proj-1'), null, 'unknown id → null');
  await new Promise((done) => session.start(
    { id: 'proj-1', cwd: '/cwd', prompt: 'go', options: {} },
    { onDone: done },
  ));
  assert.strictEqual(session.currentSessionId('proj-1'), 'sess-xyz');
});
