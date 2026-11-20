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

// P14-S05: behind AND unpushed is a DIVERGED branch — `git pull --ff-only` refuses on one, so the
// advice must name the divergence and the choice (rebase or merge) instead of handing over a
// command that cannot succeed. What the guard BLOCKS is unchanged; only what it says.
test('behind and diverged: names the divergence, never advises --ff-only, runs no step', () => {
  const project = tempProject('P01-S01');
  const f = fakeSession();
  try {
    const r = new Runner(project);
    r.gitCheck = () => ({ clean: true, pushed: false, behind: true });
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.strictEqual(f.calls.start, 0, 'a diverged checkout must still be blocked');
    const idle = seen.find((d) => d.state === 'idle');
    assert.ok(idle, `expected an idle finish, got ${JSON.stringify(seen)}`);
    assert.match(idle.detail, /diverged/, 'must name the divergence');
    assert.match(idle.detail, /rebase or merge/, 'must name what the owner has to decide');
    // It may NAME --ff-only to explain why it fails; it may not tell the owner to RUN it.
    assert.doesNotMatch(idle.detail, /Run `git pull/, 'must not advise a command that cannot succeed');
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

// P26-S02 (research 13 §4, D-118): a laned project gets two more run-start checks; solo gets none.
function lanedProject(step) {
  const p = tempProject(step);
  fs.writeFileSync(path.join(p.path, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT[tyler]: ${step}\n`);
  return { ...p, lane: 'tyler' };
}
const okClaims = { take: () => ({ verdict: 'taken' }), release: () => {}, holder: () => null };

test('laned + no upstream: refuses to start, naming git push -u origin <branch>', () => {
  const f = fakeSession();
  try {
    const r = new Runner(lanedProject('P01-S01'));
    r.claims = okClaims;
    const calls = [];
    r.gitCheck = (...a) => { calls.push(a); return { clean: true, pushed: true, behind: false,
      upstream: false, branch: 'lane-tyler', behindMain: 0 }; };
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.strictEqual(f.calls.start, 0, 'no step may start with no upstream on a laned project');
    assert.deepStrictEqual(calls[0][1], { laned: true });
    const idle = seen.find((d) => d.state === 'idle');
    assert.ok(idle, `expected an idle finish, got ${JSON.stringify(seen)}`);
    assert.match(idle.detail, /git push -u origin lane-tyler/);
  } finally { f.restore(); }
});

test('laned + behind origin/main: warns once per run and the step starts', () => {
  const f = fakeSession();
  try {
    const r = new Runner(lanedProject('P01-S01'));
    r.claims = okClaims;
    r.gitCheck = () => ({ clean: true, pushed: true, behind: false,
      upstream: true, branch: 'lane-tyler', behindMain: 3 });
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.strictEqual(f.calls.start, 1, 'behind main must never block');
    r._runNext(); // a second step boundary in the same run
    const warns = seen.filter((d) => /main has 3 commits this branch doesn't/.test(d.detail || ''));
    assert.strictEqual(warns.length, 1, 'the warning fires once per run');
    assert.match(warns[0].detail, /pull main if the plan or contracts changed/);
  } finally { f.restore(); }
});

test('solo: gitCheck called exactly as before, no laned checks, step runs', () => {
  const project = tempProject('P01-S01');
  const f = fakeSession();
  try {
    const r = new Runner(project);
    const calls = [];
    r.gitCheck = (...a) => { calls.push(a); return { clean: true, pushed: true, behind: false }; };
    const seen = [];
    r.on('status', (d) => seen.push(d));
    r.start();
    assert.deepStrictEqual(calls, [[project.path]], 'solo makes today\'s one call, no laned option');
    assert.strictEqual(f.calls.start, 1);
    assert.ok(!seen.some((d) => /push -u origin|main has/.test(d.detail || '')));
  } finally { f.restore(); }
});

test('gitState laned on real repos: no upstream, branch name, commits behind origin/main', () => {
  const { execFileSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-laned-'));
  const run = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  run(origin, 'init', '-q', '-b', 'main');
  run(origin, 'config', 'user.email', 't@example.com');
  run(origin, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'x');
  run(origin, 'add', '-A');
  run(origin, 'commit', '-qm', 'init');
  run(root, 'clone', '-q', origin, 'clone');
  const clone = path.join(root, 'clone');
  run(clone, 'checkout', '-qb', 'lane-tyler');
  for (const n of ['b', 'c']) {
    fs.writeFileSync(path.join(origin, `${n}.txt`), n);
    run(origin, 'add', '-A');
    run(origin, 'commit', '-qm', n);
  }
  const s = gitState(clone, { laned: true }); // the one fetch pulls origin/main forward
  assert.strictEqual(s.upstream, false);
  assert.strictEqual(s.branch, 'lane-tyler');
  assert.strictEqual(s.behindMain, 2);
  assert.strictEqual(s.behind, false, 'no upstream still never blocks the solo freshness guard');
});
