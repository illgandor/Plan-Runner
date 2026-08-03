// UsageService's two invariants: parse real /usage text, and keep last-good on a null poll
// so the meter never blanks (CONTRACTS §Usage snapshot; D-001). Stdlib-only (node:test),
// spends no Claude usage — fetch is faked, nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const { UsageService, parseUsageText, parseResets, parseResetAt, resetText, spawnArgs, defaultFetch,
  pollEnv } = require('../src/usage');

// Verbatim shape of a real `/usage` answer, including the per-model weekly line.
const REAL = 'Current session: 42% used · resets Jul 27, 11pm (America/New_York)\n'
  + 'Current week (all models): 71% used · resets Aug 1, 2pm (America/New_York)\n'
  + 'Current week (Fable): 12% used';

// The poll asks about the ACCOUNT, so it runs in a known environment — an allowlist, because the
// culprit in the host's env was never identified, and a denylist can only strip what you can name.
test('pollEnv passes only what a /usage lookup needs', () => {
  const env = pollEnv({
    PATH: '/usr/bin',
    Path: 'C:\\Windows',                       // Windows spelling — case-insensitive match
    USERPROFILE: 'C:\\Users\\x',
    HTTPS_PROXY: 'http://proxy:8080',          // kept: dropping it breaks corporate networks
    CLAUDE_CONFIG_DIR: 'D:\\claude',           // kept: the account's own credentials
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session-scoped',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
    ELECTRON_RUN_AS_NODE: '1',
    SOME_RANDOM_HOST_VAR: 'nope',
  });
  assert.deepStrictEqual(Object.keys(env).sort(),
    ['CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'PATH', 'Path', 'USERPROFILE'].sort());
  assert.strictEqual(env.Path, 'C:\\Windows', 'the original spelling is preserved');
  assert.deepStrictEqual(pollEnv({}), {}, 'an empty env is fine');
});

test('the real poll spawns with the allowlisted env, not process.env', () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'leaked-into-the-host';
  try {
    let seen = null;
    const spawnFn = (_c, _a, opts) => { seen = opts; throw new Error('no real spawn in a test'); };
    defaultFetch({ spawnFn, claudePath: 'C:\\fake\\claude.exe' });
    assert.ok(seen, 'spawn was reached');
    assert.ok(!('CLAUDE_CODE_SESSION_ACCESS_TOKEN' in seen.env), 'the child never sees the token');
    assert.ok(seen.env.PATH || seen.env.Path, 'but it can still find the binary it needs');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
    else process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = saved;
  }
});

test('spawnArgs routes a .cmd shim through the shell with a quoted path', () => {
  const s = spawnArgs('C:\\Program Files\\nodejs\\claude.cmd');
  assert.strictEqual(s.options.shell, true);
  assert.strictEqual(s.command, '"C:\\Program Files\\nodejs\\claude.cmd"'); // quoted for spaces
  assert.deepStrictEqual(s.args, ['-p', '/usage', '--output-format', 'json']);
});

test('spawnArgs spawns a real .exe directly (no shell)', () => {
  const s = spawnArgs('C:\\bin\\claude.exe');
  assert.strictEqual(s.command, 'C:\\bin\\claude.exe');
  assert.notStrictEqual(s.options.shell, true);
});

test('parseUsageText reads % from a real /usage sample', () => {
  assert.deepStrictEqual(parseUsageText(REAL), { session: 42, week: 71, fable: 12, fableLabel: 'Fable' });
});

// The per-model line is matched by SHAPE, not by the name "Fable" — it read "(Opus)" before and
// a name-pinned regex would blank that bar silently the day it changes again.
test('parseUsageText reads the per-model week whatever the model is called', () => {
  const p = parseUsageText('Current session: 5% used\nCurrent week (all models): 9% used\nCurrent week (Opus): 3% used');
  assert.deepStrictEqual(p, { session: 5, week: 9, fable: 3, fableLabel: 'Opus' });
  // …and an account whose answer has no per-model line is a perfectly good reading.
  const none = parseUsageText('Current session: 5% used\nCurrent week (all models): 9% used');
  assert.deepStrictEqual(none, { session: 5, week: 9, fable: null, fableLabel: null });
});

test('parseUsageText returns nulls for conversational text', () => {
  const empty = { session: null, week: null, fable: null, fableLabel: null };
  assert.deepStrictEqual(parseUsageText('I can help you with that!'), empty);
  assert.deepStrictEqual(parseUsageText(''), empty);
});

// ---- P16-S02: the reset clock the poll already receives ---------------------------------
// A fixed "now" so every expectation below is a real local-time instant, not today's clock.
const NOW = new Date(2026, 7, 2, 10, 0).getTime(); // Aug 2 2026, 10:00 local
const at = (mon, day, h, m = 0) => new Date(2026, mon, day, h, m).getTime();

test('parseResets reads both clocks off the real /usage sample', () => {
  assert.deepStrictEqual(parseResets(REAL, NOW), {
    sessionResetsAt: at(6, 27, 23),  // "Jul 27, 11pm (America/New_York)"
    weekResetsAt: at(7, 1, 14),      // "Aug 1, 2pm (America/New_York)"
  });
  // …and the percentages are untouched by any of it — the two halves parse independently.
  assert.deepStrictEqual(parseUsageText(REAL), { session: 42, week: 71, fable: 12, fableLabel: 'Fable' });
});

// The S0124 line verbatim: 99% was ~3.5 h stale while THIS half of the same line was correct
// and already past. A reset in the past is returned as-is — it is the signal, not an error.
test('parseResets keeps a reset time that has already passed', () => {
  const r = parseResets('Current session: 99% used · resets Aug 2, 4:30am', NOW);
  assert.strictEqual(r.sessionResetsAt, at(7, 2, 4, 30));
  assert.ok(r.sessionResetsAt < NOW, 'the clock the stale percentage was contradicting');
  assert.strictEqual(r.weekResetsAt, null, 'no weekly line in this sample');
});

// P16-S03: what the panel actually paints. The empty string is the "render nothing" contract —
// no "unknown", no zero clock — and the panel hides the element on it.
test('resetText says the clock the way the panel shows it', () => {
  const m = (n) => NOW + n * 60000;
  assert.strictEqual(resetText(null, NOW), '', 'no clock renders nothing at all');
  assert.strictEqual(resetText(undefined, NOW), '');
  assert.strictEqual(resetText(m(42), NOW), 'resets in 42m');
  assert.strictEqual(resetText(m(0.4), NOW), 'resets in <1m', 'never rounded down to a zero clock');
  assert.strictEqual(resetText(m(180), NOW), 'resets in 3h');
  assert.strictEqual(resetText(m(60 * 72), NOW), 'resets in 3d', 'a weekly window is days out');
  // The S0124 case: the reset already passed while the percentage still said 99%.
  assert.strictEqual(resetText(m(-29), NOW), 'reset due');
  assert.strictEqual(resetText(NOW, NOW), 'reset due', 'the boundary itself is not a countdown');
});

test('a /usage line with no reset clause parses its percentage and reports no clock', () => {
  const text = 'Current session: 5% used\nCurrent week (all models): 9% used';
  assert.deepStrictEqual(parseResets(text, NOW), { sessionResetsAt: null, weekResetsAt: null });
  assert.deepStrictEqual(parseUsageText(text), { session: 5, week: 9, fable: null, fableLabel: null });
});

// A wrong timestamp is worse than none (§Usage sources) — anything unrecognised is null, and
// the percentage on the same line survives it intact.
test('an unparseable reset clause is null, never a guess', () => {
  for (const bad of ['soon', 'Feb 31, 4:30am', 'Aug 2, 25:99pm', 'Aug 2', '']) {
    const text = `Current session: 42% used · resets ${bad}`;
    assert.strictEqual(parseResets(text, NOW).sessionResetsAt, null, `"${bad}" must not parse`);
    assert.strictEqual(parseUsageText(text).session, 42, `"${bad}" must not cost the percentage`);
  }
});

// No year is printed, so a Dec reset read on Jan 1 must not land 11 months in the future.
test('the year is inferred as the one nearest now, across a rollover', () => {
  const jan = new Date(2027, 0, 1, 0, 30).getTime();
  assert.strictEqual(parseResetAt('Dec 31, 11pm', jan), new Date(2026, 11, 31, 23).getTime());
  assert.strictEqual(parseResetAt('Jan 1, 4am', jan), new Date(2027, 0, 1, 4).getTime());
});

test('snapshot carries both reset clocks, bound to the reading that supplied them', async () => {
  const readings = [
    { session: 42, week: 71, sessionResetsAt: at(7, 2, 16), weekResetsAt: at(7, 5, 9) },
    { session: 44, week: 71 },                                   // next window, no clause
  ];
  const svc = new UsageService({ fetch: () => Promise.resolve(readings.shift()) });
  await svc._tick(); svc.stop();
  const s = svc.snapshot();
  assert.strictEqual(s.sessionResetsAt, at(7, 2, 16));
  assert.strictEqual(s.weekResetsAt, at(7, 5, 9));

  await svc._tick(); svc.stop();
  assert.strictEqual(svc.session, 44, 'the percentage still updates');
  assert.strictEqual(svc.snapshot().sessionResetsAt, null, 'a stale clock is dropped, not carried');
});

test('a null poll leaves the reset clocks alone, like the percentages', async () => {
  const readings = [{ session: 42, week: 71, sessionResetsAt: at(7, 2, 16) }, { session: null, week: null }];
  const svc = new UsageService({ fetch: () => Promise.resolve(readings.shift()) });
  await svc._tick(); svc.stop();
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.snapshot().sessionResetsAt, at(7, 2, 16), 'last-good, same as session %');
});

test('a null poll keeps the prior snapshot and sets error', async () => {
  // Queue a good reading then an empty one; drive _tick manually (no timer, no spawn).
  const readings = [{ session: 42, week: 71 }, { session: null, week: null }];
  const svc = new UsageService({ threshold: 90, pollSec: 60, fetch: () => Promise.resolve(readings.shift()) });

  await svc._tick();
  svc.stop();
  assert.deepStrictEqual(
    { session: svc.session, week: svc.week, max: svc.max, error: svc.error },
    { session: 42, week: 71, max: 71, error: null },
  );

  await svc._tick();
  svc.stop();
  assert.strictEqual(svc.session, 42, 'session kept last-good');
  assert.strictEqual(svc.week, 71, 'week kept last-good');
  assert.strictEqual(svc.max, 71, 'max unchanged');
  assert.ok(svc.error, 'error set on the empty poll');
});

// A poll can succeed, parse, and still carry no percentages — `/usage` has been seen answering
// with `/cost` output. A bare "unavailable this check" hides that; the panel must name it.
test('an empty poll reports WHAT /usage answered, when it answered something', async () => {
  const svc = new UsageService({ threshold: 90, pollSec: 60,
    fetch: () => Promise.resolve({ session: null, week: null, raw: 'Total cost:  $0.0000' }) });
  await svc._tick();
  svc.stop();
  assert.match(svc.error, /Total cost:\s+\$0\.0000/, 'the actual answer reaches the meter');
  assert.match(svc.error, /usage unavailable this check/, 'and still says what it means');

  // No raw text to show (a fake fetch, or a genuinely empty result) keeps the old bare message.
  const bare = new UsageService({ threshold: 90, pollSec: 60,
    fetch: () => Promise.resolve({ session: null, week: null }) });
  await bare._tick();
  bare.stop();
  assert.strictEqual(bare.error, 'usage unavailable this check');
});

test('a spawn/parse error also keeps last-good', async () => {
  const readings = [{ session: 42, week: 71 }, { error: 'boom' }];
  const svc = new UsageService({ fetch: () => Promise.resolve(readings.shift()) });
  await svc._tick(); svc.stop();
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.session, 42);
  assert.strictEqual(svc.error, 'boom');
  assert.strictEqual(svc.isOverThreshold(), false, '71 < 90 threshold');
});

// P05-S02: stop() during an in-flight poll must not re-arm the timer (was leaking a poller
// on engine-switch — the fetch resolved after stop() and armed a fresh setTimeout).
test('stop() during an in-flight poll does not re-arm the timer', async () => {
  let resolveFetch;
  const svc = new UsageService({ fetch: () => new Promise((r) => { resolveFetch = r; }) });
  svc.start();                              // _tick now awaiting fetch (in flight)
  svc.stop();                               // stop mid-flight
  resolveFetch({ session: 42, week: 71 });
  await new Promise((r) => setImmediate(r)); // let _tick's continuation run
  assert.strictEqual(svc._timer, null, 'no timer re-armed after stop()');
});

// S0108 audit: the two ways the meter used to die permanently and silently.
test('a fetch that REJECTS is an error poll, not a dead poller', async () => {
  const svc = new UsageService({ fetch: () => Promise.reject(new Error('spawn exploded')) });
  await svc._tick();
  svc.stop();
  assert.match(svc.error, /spawn exploded/);
  assert.strictEqual(svc._inFlight, false, '_inFlight cleared — start() can re-arm');
});

test('defaultFetch kills a child that never exits instead of hanging forever', async () => {
  // The wedge this reproduces: a child that never emits 'close' (an unread stderr pipe blocking
  // it mid-write does exactly this). Before the timeout, the promise never settled — and a poll
  // that never settles leaves _inFlight true, so the meter is dead until the window reloads.
  let killed = false;
  const fakeChild = { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() { killed = true; } };
  const r = await defaultFetch({ timeoutMs: 30, claudePath: 'C:\\fake\\claude.exe', spawnFn: () => fakeChild });
  assert.match(r.error, /no answer/, 'names the timeout instead of showing a bare dash');
  assert.ok(killed, 'the wedged child is killed, not leaked');
});

test('defaultFetch reads stderr — an unread pipe is what wedges the child', () => {
  // Guard the fix itself: if stderr is ever left undrained again, this fails.
  const src = require('fs').readFileSync(require.resolve('../src/usage.js'), 'utf8');
  assert.match(src, /p\.stderr\.on\('data'/, 'stderr must be drained');
});

test('the poll cadence re-arms on a settings change', async () => {
  const svc = new UsageService({ pollSec: 3600, fetch: () => Promise.resolve({ session: 1, week: 1 }) });
  await svc._tick();
  const first = svc._timer;
  svc.setConfig({ pollSec: 10 });
  assert.notStrictEqual(svc._timer, first, 'the pending hour-long timer was replaced');
  svc.stop();
});

// ---- Per-meter pause limits (session / weekly / per-model weekly) ----
// One helper: a service seeded with one reading, no timer, no spawn.
async function seeded(reading, cfg = {}) {
  const svc = new UsageService({ ...cfg, fetch: () => Promise.resolve(reading) });
  await svc._tick();
  svc.stop();
  return svc;
}

test('each limit pauses on its own — whichever is crossed first', async () => {
  const cfg = { threshold: 90, weekThreshold: 85, fableThreshold: 80 };
  const under = await seeded({ session: 50, week: 50, fable: 50, fableLabel: 'Fable' }, cfg);
  assert.strictEqual(under.isOverThreshold('opus[1m]'), false, 'everything under → running');

  const sess = await seeded({ session: 91, week: 10, fable: 0, fableLabel: 'Fable' }, cfg);
  assert.strictEqual(sess.isOverThreshold('opus[1m]'), true, 'session alone pauses');
  assert.match(sess.describe('opus[1m]'), /session usage 91% ≥ 90%/);

  const wk = await seeded({ session: 10, week: 86, fable: 0, fableLabel: 'Fable' }, cfg);
  assert.strictEqual(wk.isOverThreshold('opus[1m]'), true, 'weekly alone pauses, exactly the same way');
  assert.match(wk.describe('opus[1m]'), /weekly usage 86% ≥ 85%/);
});

// The whole point of the ask: a weekly hold must survive a session reset.
test('a session reset does NOT release a weekly hold', async () => {
  const cfg = { threshold: 90, weekThreshold: 85 };
  const svc = new UsageService({ ...cfg, fetch: () => Promise.resolve({ session: 95, week: 86 }) });
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.isOverThreshold('opus[1m]'), true, 'both over → paused');

  svc.fetch = () => Promise.resolve({ session: 0, week: 86 }); // the 5-hour window reset; the week did not
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.isOverThreshold('opus[1m]'), true, 'still held on the weekly');

  svc.fetch = () => Promise.resolve({ session: 0, week: 2 });  // the week finally reset too
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.isOverThreshold('opus[1m]'), false, 'released only when EVERY limit is under');
});

// A Fable week at its limit is no reason to hold a run on a different model.
test('the per-model weekly limit binds only a run using that model', async () => {
  const svc = await seeded({ session: 10, week: 10, fable: 99, fableLabel: 'Fable' },
    { threshold: 90, weekThreshold: 90, fableThreshold: 80 });
  assert.strictEqual(svc.isOverThreshold('opus[1m]'), false, 'an Opus run is untouched by a full Fable week');
  assert.strictEqual(svc.isOverThreshold('claude-fable-5[1m]'), true, 'the Fable run pauses');
  assert.strictEqual(svc.isOverThreshold('fable'), true, 'the bare alias counts too');
  assert.strictEqual(svc.isOverThreshold(), false, 'no model given → the model-scoped limit does not apply');
  assert.match(svc.describe('fable'), /weekly Fable usage 99% ≥ 80%/);
});

test('the per-model week keeps last-good and never makes a reading look empty', async () => {
  const svc = new UsageService({ fetch: () => Promise.resolve({ session: 5, week: 9, fable: 3, fableLabel: 'Fable' }) });
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.fable, 3);

  svc.fetch = () => Promise.resolve({ session: 6, week: 9, fable: null, fableLabel: null }); // no per-model line this poll
  await svc._tick(); svc.stop();
  assert.strictEqual(svc.error, null, 'a missing per-model line is NOT an empty poll');
  assert.strictEqual(svc.fable, 3, 'and the bar keeps its last-good value');
  assert.strictEqual(svc.snapshot().fableLabel, 'Fable');
});

test('setConfig applies all three limits', async () => {
  const svc = await seeded({ session: 88, week: 88, fable: 88, fableLabel: 'Fable' });
  assert.strictEqual(svc.isOverThreshold('fable'), false, '88 < the 90 defaults');
  svc.setConfig({ weekThreshold: 85 });
  assert.strictEqual(svc.isOverThreshold('fable'), true, 'the new weekly limit takes effect immediately');
  assert.deepStrictEqual(
    [svc.snapshot().threshold, svc.snapshot().weekThreshold, svc.snapshot().fableThreshold], [90, 85, 90]);
});

// P05-S02: start() while a poll is already in flight must not spawn a second loop.
test('start() twice does not spawn a second poll loop', async () => {
  let calls = 0; let resolveFetch;
  const svc = new UsageService({ fetch: () => { calls++; return new Promise((r) => { resolveFetch = r; }); } });
  svc.start();
  svc.start();                              // second start while the first poll is in flight
  assert.strictEqual(calls, 1, 'only one fetch in flight — no second loop');
  svc.stop();
  resolveFetch({ session: 1, week: 1 });
  await new Promise((r) => setImmediate(r));
});
