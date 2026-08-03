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

// P19-S04 / D-087: the same refusal as above, but for the driver who has NOT set a name — the
// state every project is in on the day it goes non-solo. Stopping is right; "not a master-plan
// project" is not, and it names nothing the owner can act on (INV-7).
test('laned pointer + no lane at all → ends naming planRunner.presenceName', (t) => {
  const { calls, done } = run(tempProject('NEXT[tyler]: S1\nNEXT[reno]: S9'), t);
  assert.equal(done && done.state, 'error');
  assert.match(done.detail, /planRunner\.presenceName/, 'names the setting, not a symptom');
  assert.equal(calls.start, 0, 'runs no step — it does not know whose step it would be');
});

test('an unlaned project with no pointer keeps today\'s reason, unchanged', (t) => {
  const { done } = run(tempProject('(nothing here)'), t);
  assert.match(done.detail, /not a master-plan project/);
  assert.doesNotMatch(done.detail, /presenceName/, 'solo never hears about lanes');
});

// P17-S04: a lane told to WAIT rests visibly — an idle finish naming the step and the lane, not a
// hang, not an error, and not a poll loop (research 06 §5.1–5.4).
test('WAIT <step> → idles, naming the step and the lane', (t) => {
  const { calls, done } = run(tempProject('NEXT[tyler]: WAIT P17-S01\nNEXT[reno]: P17-S01', 'tyler'), t);
  assert.equal(done && done.state, 'idle', 'a wait is a rest, not an error and not "done"');
  assert.match(done.detail, /P17-S01/, 'says WHAT it waits on');
  assert.match(done.detail, /lane tyler/, 'says WHICH lane is waiting');
  assert.equal(calls.start, 0, 'started nothing — never runs the other lane\'s step');
});

test('WAIT on an unlaned pointer → idles, with no empty lane clause', (t) => {
  const { done } = run(tempProject('NEXT: WAIT P17-S01'), t);
  assert.equal(done && done.state, 'idle');
  assert.match(done.detail, /Waiting on P17-S01 —/, 'no "(lane )" when no lane is configured');
});

test('none is unchanged by the WAIT branch', (t) => {
  assert.equal(run(tempProject('NEXT: none'), t).done.state, 'done');
});

test('PLAN COMPLETE is unchanged by the WAIT branch', (t) => {
  const plan = run(tempProject('NEXT: PLAN COMPLETE'), t);
  assert.equal(plan.calls.start, 1, 'still runs the master-plan session (once)');
  assert.equal(plan.done.state, 'done', 'and the unchanged pointer still finishes "done", not idle');
});

// ---- P18-S02: taken after the gate, released after the handoff guard (D-083/D-084) ----
// Its own harness: these need the pointer to actually ADVANCE (so the run reaches _advance) and a
// single log ordered across claims and the session. `to: null` leaves the pointer alone.
// P18-S03 extends it with the holder read and the reclaim, both logged in the same order.
function claimHarness(p, t, { verdict = 'taken', git = { clean: true, pushed: true, behind: false },
  to = 'none', holder = null, reclaimVerdict = 'taken' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const log = [], takes = [], releases = [], reclaims = [], statuses = [];
  const out = { done: null };
  const orig = {};
  for (const k of ['start', 'stop', 'interrupt', 'currentSessionId', 'defaultSend']) orig[k] = session[k];
  session.defaultSend = () => {};
  session.interrupt = () => {};
  session.currentSessionId = () => 'sess';
  session.stop = () => {};
  session.start = (args, hooks) => {
    log.push('session');
    if (to != null) fs.writeFileSync(path.join(p.path, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${to}\n`);
    hooks.send('session:message', { msg: { type: 'result' } });
    return {};
  };
  const r = new Runner(p);
  r.finalizeMs = 0;
  r.retryBackoffMs = 1;
  r.gitCheck = () => git;
  r.claims = {
    take: (cwd, payload) => { log.push('take'); takes.push(payload); return { verdict, ref: 'r', sha: 's', detail: '' }; },
    release: (cwd, step) => { log.push('release'); releases.push(step); return { released: true, ref: 'r' }; },
    holder: () => { log.push('holder'); return holder; },
    reclaim: (cwd, payload, sha) => {
      log.push('reclaim'); reclaims.push({ ...payload, sha });
      return { verdict: reclaimVerdict, ref: 'r', sha: 's2', detail: '' };
    },
  };
  r.on('done', (d) => { out.done = d; });
  r.on('status', (s) => statuses.push(s));
  return { r, log, takes, releases, reclaims, statuses, out,
    restore: () => { for (const k of Object.keys(orig)) session[k] = orig[k]; } };
}

test('a laned step is claimed AFTER the gate and BEFORE the session starts', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t);
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, ['take', 'session', 'release'], 'claim → work → give it back, in that order');
    assert.equal(h.takes.length, 1);
    assert.equal(h.takes[0].step, 'P18-S02');
    assert.equal(h.takes[0].driver, 'tyler', 'the lane is the driver');
    assert.ok(h.takes[0].host, 'names the machine, so a refusal can say which one');
  } finally { h.restore(); }
});

test('a step held on the usage gate claims nothing — a hold can last days', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t);
  try {
    h.r.usageGate = { isOverThreshold: () => true };
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, [], 'no claim and no session while the gate holds it');
  } finally { h.restore(); }
});

test('release fires in _advance only once the handoff guard is green', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { git: { clean: false, pushed: true, behind: false } });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.releases, [], 'uncommitted work keeps the claim — nobody else may start on it');
  } finally { h.restore(); }
});

test('a claim this run did NOT take is never released', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { verdict: 'held' });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.releases, [], 'releasing on `held` would hand the other driver\'s step away');
  } finally { h.restore(); }
});

test('no lane configured → not one claim call (D-084)', (t) => {
  const p = tempProject('NEXT: P18-S02');
  const h = claimHarness(p, t);
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, ['session'], 'a solo run pays no extra git call and no extra packet');
  } finally { h.restore(); }
});

test('Stop is claim-neutral', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { to: null });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    h.r.stop();
    assert.deepEqual(h.releases, [], 'a stopped step\'s local work may be uncommitted — keep the claim');
  } finally { h.restore(); }
});

test('abort is claim-neutral', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { to: null });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    h.r.abort();
    assert.deepEqual(h.releases, [], 'a hard abort mid-step releases nothing');
  } finally { h.restore(); }
});

test('a retry does not re-claim', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { to: null });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    h.r._retryStep('P18-S02');
    t.mock.timers.tick(10);
    assert.equal(h.takes.length, 1, 'the retry re-enters _startSession, not _runNext');
    assert.equal(h.log.filter((x) => x === 'session').length, 2, 'it did re-run the step');
  } finally { h.restore(); }
});

test('a resume does not re-claim', (t) => {
  const p = tempProject('NEXT: P18-S02', 'tyler');
  const h = claimHarness(p, t, { to: null });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    h.r._resume();
    assert.equal(h.takes.length, 1, 'resume re-enters the SAME step\'s session — the claim is still ours');
  } finally { h.restore(); }
});

// ---- P18-S03: the three refusals (research 03 §4.3/§4.4/§6, 06 §2.3) ----
const OTHER = { step: 'P18-S03', ref: 'r', sha: 'abc1234', driver: 'reno', host: 'renobox',
  ts: '2026-08-03T09:00:00Z' };
const MINE = (ts) => ({ ...OTHER, driver: 'tyler', host: os.hostname(), sha: 'dead5ee', ts });

test('a claim held by the OTHER driver ends idle, naming holder, host and ts', (t) => {
  const p = tempProject('NEXT: P18-S03', 'tyler');
  const h = claimHarness(p, t, { verdict: 'held', holder: OTHER });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.equal(h.out.done && h.out.done.state, 'idle', 'a taken step is a rest, not an error');
    assert.match(h.out.done.detail, /reno/, 'names the holder');
    assert.match(h.out.done.detail, /renobox/, 'names the host');
    assert.match(h.out.done.detail, /2026-08-03T09:00:00Z/, 'names when — for the human, not for a branch');
    assert.deepEqual(h.log, ['take', 'holder'], 'never retried, never waited, never broke it, never ran');
  } finally { h.restore(); }
});

test('my own dead run\'s claim is reclaimed silently, leased on the sha just observed', (t) => {
  const p = tempProject('NEXT: P18-S03', 'tyler');
  const h = claimHarness(p, t, { verdict: 'held', holder: MINE('2026-08-03T09:00:00Z') });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, ['take', 'holder', 'reclaim', 'session', 'release'],
      'same driver + same host = no ambiguity to resolve, so no human and no refusal');
    assert.equal(h.reclaims[0].sha, 'dead5ee', 'the lease is the sha THIS read saw, so a racer still wins');
    assert.equal(h.reclaims[0].driver, 'tyler');
    assert.ok(h.statuses.every((s) => !/unclaimed/.test(s.detail || '')), 'silent beyond the run log');
  } finally { h.restore(); }
});

test('an ancient claim of my own is still reclaimed — no TTL, and no branch reads ts', (t) => {
  const p = tempProject('NEXT: P18-S03', 'tyler');
  const h = claimHarness(p, t, { verdict: 'held', holder: MINE('1970-01-01T00:00:00Z') });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, ['take', 'holder', 'reclaim', 'session', 'release'],
      'a 56-year-old claim and a 5-second-old one take the same path (§4.2)');
  } finally { h.restore(); }
});

test('a reclaim that loses its lease refuses, naming whoever holds it NOW', (t) => {
  const p = tempProject('NEXT: P18-S03', 'tyler');
  const h = claimHarness(p, t, { verdict: 'held', reclaimVerdict: 'held' });
  try {
    // Mine on the first read, theirs on the second — the race the lease exists to lose safely.
    h.r.claims.holder = (() => { let n = 0; return () => (n++ ? OTHER : MINE('2026-08-03T09:00:00Z')); })();
    h.r.start();
    t.mock.timers.tick(0);
    assert.equal(h.out.done.state, 'idle');
    assert.match(h.out.done.detail, /reno/, 'it changed hands between the read and the push — never stolen');
  } finally { h.restore(); }
});

test('a markerless failure runs the step UNCLAIMED and says so', (t) => {
  const p = tempProject('NEXT: P18-S03', 'tyler');
  const h = claimHarness(p, t, { verdict: 'unreachable' });
  try {
    h.r.start();
    t.mock.timers.tick(0);
    assert.deepEqual(h.log, ['take', 'session'], 'infrastructure is not contention — it proceeds');
    assert.ok(h.statuses.some((s) => /unclaimed/.test(s.detail || '')),
      'silence is the one unacceptable answer (INV-7)');
    assert.deepEqual(h.releases, [], 'it never held one, so it has nothing to give back');
  } finally { h.restore(); }
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
