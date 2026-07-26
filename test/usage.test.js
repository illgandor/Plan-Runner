// UsageService's two invariants: parse real /usage text, and keep last-good on a null poll
// so the meter never blanks (CONTRACTS §Usage snapshot; D-001). Stdlib-only (node:test),
// spends no Claude usage — fetch is faked, nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const { UsageService, parseUsageText, spawnArgs, defaultFetch, pollEnv } = require('../src/usage');

const REAL = 'Current session: 42% used\nCurrent week (all models): 71% used';

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
  assert.deepStrictEqual(parseUsageText(REAL), { session: 42, week: 71 });
});

test('parseUsageText returns {null,null} for conversational text', () => {
  assert.deepStrictEqual(parseUsageText('I can help you with that!'), { session: null, week: null });
  assert.deepStrictEqual(parseUsageText(''), { session: null, week: null });
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
