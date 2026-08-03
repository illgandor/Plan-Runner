// P17-S02: the runner passes its lane (project.lane = planRunner.presenceName, D-079) to every
// readPointer call, so a laned PROGRESS.md resolves to THIS driver's pointer — and an unlaned one
// (every project that exists today) is completely unaffected whether a name is configured or not.
// The static assertion at the bottom covers all five call sites incl. extension.js, which cannot be
// required here (it needs the vscode host); it is the "none was missed" criterion in executable form.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner } = require('../src/runner');
const { STEP_PROMPT } = require('../src/constants');

function tempProject(body, lane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-lane-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\n${body}\n`);
  return { id: dir, path: dir, name: 'tmp', lane, model: '(default)', effort: '(default)', mode: 'auto' };
}

// Same fake provider as runner-advance: records prompts, never rewrites the pointer.
function fakeSession() {
  const calls = { prompts: [], start: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => {};
  session.start = (args, hooks) => {
    calls.start++;
    calls.prompts.push(args.prompt);
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  return { calls, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

function run(p, t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const { calls, restore } = fakeSession();
  try {
    const r = new Runner(p);
    r.finalizeMs = 0;
    r.gitCheck = () => ({ clean: true, pushed: true, behind: false });
    let done = null;
    r.on('done', (d) => { done = d; });
    r.start();
    t.mock.timers.tick(0);
    return { calls, done };
  } finally { restore(); }
}

// The case every existing project is in: an unlaned PROGRESS.md read by someone who has a
// presence name set. The lane must be inert here, or P17-S02 breaks every solo user.
test('bare pointer + a configured lane → today\'s answer, unchanged', (t) => {
  const { calls, done } = run(tempProject('NEXT: none', 'tyler'), t);
  assert.equal(done && done.state, 'done', 'terminal "none" still finishes');
  assert.equal(calls.start, 0, 'no session started');
});

test('laned pointer + my lane → runs MY lane\'s step, not the other lane\'s', (t) => {
  const { calls } = run(tempProject('NEXT[tyler]: none\nNEXT[reno]: S9', 'reno'), t);
  assert.equal(calls.start, 1, 'started reno\'s step');
  assert.deepEqual(calls.prompts, [STEP_PROMPT]);
});

test('laned pointer + my lane is the terminal one → finishes without touching the other lane', (t) => {
  const { calls, done } = run(tempProject('NEXT[tyler]: none\nNEXT[reno]: S9', 'tyler'), t);
  assert.equal(done && done.state, 'done', 'tyler is done even though reno has work');
  assert.equal(calls.start, 0, 'never ran reno\'s step');
});

test('laned pointer + a lane that is not in the file → refuses, never guesses (D-080)', (t) => {
  const { calls, done } = run(tempProject('NEXT[tyler]: S1\nNEXT[reno]: S9', 'dana'), t);
  assert.equal(done && done.state, 'error', 'no pointer for me = stop, not someone else\'s step');
  assert.equal(calls.start, 0);
});

test('all five readPointer call sites pass a lane', () => {
  const calls = [];
  for (const f of ['runner.js', 'extension.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    for (const m of src.matchAll(/(?<!function )readPointer\(([^)]*)\)/g)) calls.push([f, m[1]]);
  }
  assert.equal(calls.length, 5, `expected 5 call sites, found ${calls.length}: ${JSON.stringify(calls)}`);
  for (const [f, args] of calls) assert.ok(args.includes(','), `${f}: readPointer(${args}) passes no lane`);
});
