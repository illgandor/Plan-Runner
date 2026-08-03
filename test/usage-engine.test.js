// P16-S08: Codex wired into the usage service. The engine difference is ONE function reference —
// everything downstream (bars, reset clock, pause gate, anti-flicker rule) is engine-agnostic, and
// these tests exist to hold that. Two claims are load-bearing:
//   1. Claude's path is UNCHANGED (D-072/D-074) — asserted by identity, not by inspection.
//   2. Switching engines DROPS the old account's readings, so Claude's numbers can never be
//      painted as Codex's and a machine that has never run Codex reads "unknown", never 0%.
// No spawn, no webview: the Codex half goes through a real rollout file in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageService, fetcherFor, defaultFetch } = require('../src/usage');
const { codexFetch } = require('../src/codex-usage');
const { Runner } = require('../src/runner');

const never = () => new Promise(() => {}); // a fetch that never resolves — no poll, no timers

// A real-shaped rollout on disk, so the service is exercised through the actual reader rather
// than a stand-in that would agree with whatever the service expects.
function tempRollout({ sessionPct = 40, weekPct = 71, sessionResets, weekResets } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-codex-'));
  const day = path.join(dir, '2026', '08', '03');
  fs.mkdirSync(day, { recursive: true });
  const rec = { timestamp: '2026-08-03T12:00:00.000Z', type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex',
      primary: { used_percent: sessionPct, window_minutes: 300, resets_at: sessionResets },
      secondary: { used_percent: weekPct, window_minutes: 10080, resets_at: weekResets } } } };
  fs.writeFileSync(path.join(day, 'rollout-2026-08-03T12-00-00.jsonl'), JSON.stringify(rec) + '\n');
  return dir;
}
// The service pointed at that dir — the production fetcher, only its test seam supplied.
function codexService(dir, opts = {}) {
  return new UsageService({ fetch: () => codexFetch({ sessionsDir: dir }), ...opts });
}
function tempProject(step, engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), `## ▶ NEXT STEP\nNEXT: ${step}\n`);
  return { id: dir, path: dir, name: 'tmp', engine, model: '(default)', effort: '(default)', mode: 'auto' };
}

test('the fetcher is selected by engine — and Claude still gets the identical one', () => {
  assert.strictEqual(fetcherFor('claude'), defaultFetch, 'Claude polls /usage exactly as before');
  assert.strictEqual(fetcherFor(undefined), defaultFetch, 'unset engine is Claude, never Codex');
  assert.strictEqual(fetcherFor('codex'), codexFetch, 'Codex reads its rollout file');
});

test('a Codex run gets real session and week bars plus a reset clock, from the rollout file', async () => {
  const at = Date.now() + 90 * 60 * 1000;                    // 90 minutes out
  const dir = tempRollout({ sessionPct: 40, weekPct: 71, sessionResets: Math.round(at / 1000) });
  const svc = codexService(dir);
  await svc._tick(); svc.stop();

  const s = svc.snapshot();
  assert.strictEqual(s.error, null, 'a rollout read is a good reading, not an error');
  assert.deepStrictEqual([s.session, s.week], [40, 71], 'both bars sourced from the rollout');
  assert.strictEqual(s.max, 71);
  assert.ok(Math.abs(s.sessionResetsAt - at) < 1000, 'the reset clock crossed over as epoch ms');
  assert.strictEqual(s.weekResetsAt, null, 'a window with no resets_at reports no clock, not a zero one');
  assert.strictEqual(s.fable, null, 'D-075: Codex has no per-model window at all');
});

test('a machine that has never run Codex reads unknown, never 0%', async () => {
  const svc = codexService(path.join(os.tmpdir(), 'plan-runner-no-such-codex-dir'));
  await svc._tick(); svc.stop();

  const s = svc.snapshot();
  assert.deepStrictEqual([s.session, s.week, s.max], [null, null, null], 'unknown — a zero would be a claim');
  assert.match(s.error, /rollout/, 'and it says why, rather than showing a silent dash');
  assert.strictEqual(svc.isOverThreshold(), false, 'no reading never pauses anything');
});

test('switching engine swaps the source and drops the other account s readings', async () => {
  const svc = new UsageService({ fetch: () => Promise.resolve({ session: 82, week: 77 }) });
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.snapshot().session, 82, 'a good Claude reading is on screen');

  svc.setEngine('codex');
  svc.stop();                                  // setEngine re-arms the poll; don't let it run here
  assert.strictEqual(svc.fetch, codexFetch, 'the source is now the Codex reader');
  const s = svc.snapshot();
  assert.deepStrictEqual([s.session, s.week, s.max, s.checked], [null, null, null, null],
    'Claude s 82% must never be painted as Codex s — the anti-flicker rule does not cross accounts');
});

test('switching to the engine already selected keeps the reading', async () => {
  const svc = new UsageService({ fetch: () => Promise.resolve({ session: 82, week: 77 }) });
  await svc._tick(); svc.stop();
  const fetch = svc.fetch;

  svc.setEngine('claude'); svc.stop();         // a repaint-driven no-op, not a real switch
  assert.strictEqual(svc.fetch, fetch, 'the installed fetcher is untouched');
  assert.strictEqual(svc.snapshot().session, 82, 'and a good reading survives it');
});

// The engine is tracked by NAME, not inferred from whichever function is installed — otherwise a
// no-op switch would silently overwrite an injected fetcher with the production one.
test('the constructor selects the source too, and `fetch` still overrides it', () => {
  assert.strictEqual(new UsageService({ engine: 'codex' }).fetch, codexFetch);
  assert.strictEqual(new UsageService().fetch, defaultFetch, 'no engine given is Claude');
  const stub = () => Promise.resolve({});
  const svc = new UsageService({ engine: 'codex', fetch: stub });
  assert.strictEqual(svc.fetch, stub, 'an explicit fetch wins — the test seam is intact');
  assert.strictEqual(svc.engine, 'codex', 'and the engine it belongs to is still recorded');
});

// The whole point of the step: before it, a Codex run could burn through its weekly limit into
// hard server rejections because _over() returned false on sight of the engine.
test('the pause gate now applies to a Codex run, and the reset clock releases it', async () => {
  const past = Math.round((Date.now() - 10 * 60 * 1000) / 1000);   // 10 min ago, well past the cadence
  const svc = codexService(tempRollout({ sessionPct: 95, weekPct: 12 }), { threshold: 90 });
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.isOverThreshold('gpt-5-codex'), true, 'a Codex session at 95% holds the run');
  assert.match(svc.describe('gpt-5-codex'), /session usage 95% ≥ 90%/);

  // Codex's ONLY release is the reset clock — there is no active query to fall back on (S04).
  const released = codexService(tempRollout({ sessionPct: 95, weekPct: 12, sessionResets: past }),
    { threshold: 90 });
  await released._tick(); released.stop();
  assert.strictEqual(released.isOverThreshold('gpt-5-codex'), false,
    'a window whose reset time has passed is not over, whatever the stale percentage says');
});

test('the Runner no longer excludes Codex from the usage gate', () => {
  const gate = { over: true, isOverThreshold() { return this.over; },
    describe() { return 'session usage 95% ≥ 90%'; } };
  for (const engine of ['codex', 'claude']) {
    const r = new Runner(tempProject('P16-S08', engine));
    r.usageGate = gate;
    assert.strictEqual(r._over(), true, `${engine} is held by the gate`);
    const paused = [];
    r.on('paused', (d) => paused.push(d.reason));
    r.running = true;
    r._runNext();                               // the proactive between-steps gate
    assert.strictEqual(r.paused, true, `${engine} waits instead of starting the step`);
    assert.match(paused[0], /session usage 95% ≥ 90%/, 'and the panel is told which limit');
    gate.over = false; r.onUsageUpdate();       // released → the step is free to start
    assert.strictEqual(r.gating, false, `${engine} releases when every limit is back under`);
    r.abort();
    gate.over = true;
  }
});
