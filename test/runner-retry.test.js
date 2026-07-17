// P05-S05: an error turn-end is NOT the same as a clean result. The errored SDK session is torn
// down, so instead of silently parking on a dead session, the runner retries the step in a FRESH
// session up to MAX_RETRIES (short backoff) before dropping to a needs-you flagged "errored".
// A clean result that just didn't advance the pointer is unchanged (Claude waiting on you).
// Stdlib-only; stubs the session provider like runner-advance.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner, MAX_RETRIES } = require('../src/runner');

function tempProject(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto' };
}

// Fake session: each start() runs script(callIndex) → { type:'error'|'result', to? }. `to`
// (optional) rewrites the pointer before the turn ends. Records start/stop counts.
function fakeScripted(dir, script) {
  const calls = { start: 0, stop: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => { calls.stop++; };
  session.start = (args, hooks) => {
    const i = calls.start++;
    const { type, to } = script(i);
    if (to != null) fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type } });
    return {};
  };
  return { calls, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('an error turn-end retries the step in a fresh session, then advances on success', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  // call0: S1 errors. call1 (retry): S1 succeeds, pointer → none → project finishes.
  const { calls, restore } = fakeScripted(p.path, (i) =>
    i === 0 ? { type: 'error' } : { type: 'result', to: 'none' });
  try {
    const r = new Runner(p);
    r.retryBackoffMs = 0;
    r.finalizeMs = 0;
    r.gitCheck = () => ({ clean: true, pushed: true });
    let done = null;
    r.on('done', (d) => { done = d; });

    r.start();
    t.mock.timers.tick(0); // fire the retry backoff timer, then drain the advance setImmediate

    assert.equal(calls.start, 2, 'started twice: initial + one retry');
    assert.equal(done && done.state, 'done', 'the retry advanced the step and finished the project');
  } finally { restore(); }
});

test('errors past the retry bound drop to a distinct "errored" needs-you', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const p = tempProject('S1');
  const { calls, restore } = fakeScripted(p.path, () => ({ type: 'error' })); // every attempt errors
  try {
    const r = new Runner(p);
    r.retryBackoffMs = 0;
    let status = null;
    r.on('status', (s) => { status = s; });

    r.start();
    t.mock.timers.runAll(); // fire every backoff timer, including ones scheduled while firing

    assert.equal(calls.start, 1 + MAX_RETRIES, 'initial start + MAX_RETRIES retries');
    assert.equal(r.needsYou, true, 'parked on needs-you once the bound is spent');
    assert.equal(status.state, 'needs-you');
    assert.match(status.detail, /errored/, 'flagged as an error, not a plain wait');
  } finally { restore(); }
});

test('a clean result that does not advance is an unchanged needs-you (no retry)', () => {
  const p = tempProject('S1');
  const { calls, restore } = fakeScripted(p.path, () => ({ type: 'result' })); // clean, no pointer move
  try {
    const r = new Runner(p);
    let status = null;
    r.on('status', (s) => { status = s; });

    r.start();

    assert.equal(calls.start, 1, 'a clean result never retries');
    assert.equal(r.needsYou, true, 'still waits on you');
    assert.doesNotMatch(status.detail, /errored/, 'plain wait, not flagged as an error');
  } finally { restore(); }
});
