// UsageService's two invariants: parse real /usage text, and keep last-good on a null poll
// so the meter never blanks (CONTRACTS §Usage snapshot; D-001). Stdlib-only (node:test),
// spends no Claude usage — fetch is faked, nothing spawns.
const test = require('node:test');
const assert = require('node:assert');
const { UsageService, parseUsageText } = require('../src/usage');

const REAL = 'Current session: 42% used\nCurrent week (all models): 71% used';

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
