// Freshness guard: a checkout that is BEHIND its remote must never start a step. On a shared
// project the missing commits include the other person's PROGRESS.md close-out, so the NEXT
// pointer is stale too — starting would redo a finished step or collide with it. Solo/offline
// projects must be unaffected (gitState reports behind:false when there's no upstream).
// Stdlib only; stubs gitCheck + the session provider, spends no usage and touches no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { Runner, gitState } = require('../src/runner');

function tempProject(step) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-fresh-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', model: '(default)', effort: '(default)', mode: 'auto' };
}

function fakeSession() {
  const calls = { start: 0 };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => {};
  session.start = (args, hooks) => { calls.start++; hooks.send('session:message', { msg: { type: 'result' } }); return {}; };
  return { calls, restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('behind the remote: refuses to start, names the fix, runs no step', () => {
  const project = tempProject('P01-S01');
  const f = fakeSession();
  try {
    const r = new Runner(project);
    r.gitCheck = () => ({ clean: true, pushed: true, behind: true });
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.strictEqual(f.calls.start, 0, 'no step may start on a stale checkout');
    const idle = seen.find((d) => d.state === 'idle');
    assert.ok(idle, `expected an idle finish, got ${JSON.stringify(seen)}`);
    assert.match(idle.detail, /pull --ff-only/, 'must tell the owner how to fix it');
  } finally { f.restore(); }
});

test('up to date: the step runs normally', () => {
  const project = tempProject('P01-S01');
  const f = fakeSession();
  try {
    const r = new Runner(project);
    r.gitCheck = () => ({ clean: true, pushed: true, behind: false });
    r.start();
    assert.strictEqual(f.calls.start, 1, 'a fresh checkout must not be blocked');
  } finally { f.restore(); }
});

test('the guard is checked BEFORE the pointer is read (a stale clone has a stale NEXT)', () => {
  const project = tempProject('P01-S01');
  fs.rmSync(path.join(project.path, 'PROGRESS.md')); // would be an "error" finish if read first
  const f = fakeSession();
  try {
    const r = new Runner(project);
    r.gitCheck = () => ({ clean: true, pushed: true, behind: true });
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.ok(seen.some((d) => d.state === 'idle' && /Behind the remote/.test(d.detail)),
      'behind must win over the missing-pointer error');
  } finally { f.restore(); }
});

test('gitState on a non-git dir never blocks (behind:false, no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-nogit-'));
  const s = gitState(dir, { fetch: false });
  assert.deepStrictEqual(s, { clean: true, pushed: true, behind: false });
});

test('gitState on a real repo with no upstream reports behind:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-solo-'));
  const { execFileSync } = require('child_process');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const s = gitState(dir, { fetch: false }); // no remote → the solo case must be free
  assert.strictEqual(s.behind, false);
  assert.strictEqual(s.clean, true);
  assert.strictEqual(s.pushed, true);
});
