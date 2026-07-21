// UsageService's two invariants: parse real /usage text, and keep last-good on a null poll
// so the meter never blanks (CONTRACTS §Usage snapshot; D-001). Stdlib-only (node:test),
// spends no Claude usage — fetch is faked, nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const { UsageService, parseUsageText, spawnArgs } = require('../src/usage');

const REAL = 'Current session: 42% used\nCurrent week (all models): 71% used';

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
