// P16-S05 — the SDK `rate_limit_event` as a SECOND usage source, OBSERVE ONLY.
// Covers the whole path: the raw SDK message → session.mapMessage → UsageService.recordEvent →
// one run-ledger line. The load-bearing claim is the negative one: the gate's decisions are
// unchanged by ANY event, which is asserted here rather than argued (CONTRACTS §Usage sources).
// Stdlib-only, no spawn, no webview.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../src/session');
const { UsageService, eventPct, eventResetAt } = require('../src/usage');
const { Runner } = require('../src/runner');

const never = () => new Promise(() => {}); // a fetch that never resolves — no poll, no timers

function sdkEvent(info) {
  return { type: 'rate_limit_event', uuid: 'u', session_id: 's', rate_limit_info: info };
}
// The runner tap consumes the MAPPED message, so go through mapMessage rather than hand-shaping it.
function mapped(info) {
  const out = session.mapMessage(sdkEvent(info));
  assert.equal(out.length, 1);
  return out[0];
}

test('mapMessage lifts rate_limit_info onto a thin rate-limit message', () => {
  assert.deepEqual(mapped({ status: 'allowed_warning', utilization: 0.62, resetsAt: 1754100000,
    rateLimitType: 'five_hour' }),
  { type: 'rate-limit', status: 'allowed_warning', utilization: 0.62, resetsAt: 1754100000,
    rateLimitType: 'five_hour' });
  // Every field of rate_limit_info is optional in the SDK, and the whole object can be absent.
  assert.deepEqual(session.mapMessage({ type: 'rate_limit_event' }),
    [{ type: 'rate-limit', status: null, utilization: null, resetsAt: null, rateLimitType: null }]);
});

test('utilization and resetsAt are normalised without being trusted', () => {
  assert.equal(eventPct(0.62), 62);      // fraction form
  assert.equal(eventPct(62), 62);        // percent form
  assert.equal(eventPct(1), 100);        // the <=1 rule's own boundary
  for (const bad of [null, undefined, NaN, Infinity, -1, '62']) assert.equal(eventPct(bad), null);
  assert.equal(eventResetAt(1754100000), 1754100000000);      // unix seconds → epoch ms
  assert.equal(eventResetAt(1754100000000), 1754100000000);   // already ms → untouched
  for (const bad of [null, undefined, 0, -5, NaN, '1754100000']) assert.equal(eventResetAt(bad), null);
});

test('events are ingested per meter and source-tagged', () => {
  const u = new UsageService({ fetch: never });
  u.session = 40; u.week = 20;
  const s = u.recordEvent(mapped({ status: 'allowed', utilization: 0.44, rateLimitType: 'five_hour' }), 1000);
  assert.equal(s.source, 'event');
  assert.equal(s.meter, 'session');
  assert.equal(s.pct, 44);
  assert.equal(s.pollPct, 40);          // the poll's number it is being measured against
  assert.equal(s.at, 1000);
  u.recordEvent(mapped({ status: 'allowed', utilization: 0.21, rateLimitType: 'seven_day' }));
  u.recordEvent(mapped({ status: 'allowed', utilization: 0.9, rateLimitType: 'seven_day_opus' }));
  assert.deepEqual(Object.keys(u.events).sort(), ['fable', 'session', 'week']);
  assert.equal(u.events.session.pct, 44);
  assert.equal(u.events.week.pct, 21);
  assert.equal(u.events.fable.pct, 90);
});

test('an unknown rateLimitType is recorded and ignored, never guessed into a meter', () => {
  const u = new UsageService({ fetch: never });
  u.session = 40; u.week = 20; u.fable = 10;
  // `overage` and `seven_day_overage_included` are real SDK values and are NOT per-model windows —
  // a `seven_day_*` prefix rule would have put the second one in the per-model bar.
  for (const type of ['overage', 'seven_day_overage_included', 'five_hour_beta', undefined]) {
    const rec = u.recordEvent(mapped({ status: 'allowed', utilization: 0.99, rateLimitType: type }));
    assert.equal(rec.meter, null, `${type} maps to no meter`);
    assert.equal(rec.pct, 99, 'still recorded, so the ledger shows it arrived');
  }
  assert.deepEqual(u.events, {}, 'no meter was touched');
  assert.deepEqual([u.session, u.week, u.fable], [40, 20, 10]);
  assert.equal(u.recordEvent(null), null);
});

test('divergence from the poll is flagged; agreement is not', () => {
  const u = new UsageService({ fetch: never });
  u.session = 40;
  assert.equal(u.recordEvent(mapped({ utilization: 0.45, rateLimitType: 'five_hour' })).diverged, false);
  assert.equal(u.recordEvent(mapped({ utilization: 0.5, rateLimitType: 'five_hour' })).diverged, true);
  assert.equal(u.recordEvent(mapped({ utilization: 0.05, rateLimitType: 'five_hour' })).diverged, true);
  u.session = null; // nothing to compare against yet — not a divergence, just unknown
  assert.equal(u.recordEvent(mapped({ utilization: 0.99, rateLimitType: 'five_hour' })).diverged, false);
});

test('NO event can change the gate — the poll alone still decides', () => {
  const u = new UsageService({ fetch: never, threshold: 90, weekThreshold: 90, fableThreshold: 90 });
  u.session = 10; u.week = 10; u.fable = 10; u.fableLabel = 'Fable';
  const before = u.describe('fable');
  // Everything the event could possibly say: over the limit, rejected outright, a reset clock,
  // for every meter. The gate reads the poll's 10% and stays under.
  for (const rateLimitType of ['five_hour', 'seven_day', 'seven_day_opus', 'overage']) {
    u.recordEvent(mapped({ status: 'rejected', utilization: 1, resetsAt: 1, rateLimitType }));
    assert.equal(u.isOverThreshold('fable'), false, `${rateLimitType} did not create a hold`);
  }
  assert.equal(u.describe('fable'), before, 'and the reasons are byte-identical');
  // The mirror case: a poll that IS over stays over, however calm the event is.
  u.session = 95;
  u.recordEvent(mapped({ status: 'allowed', utilization: 0, rateLimitType: 'five_hour' }));
  assert.equal(u.isOverThreshold('fable'), true, 'a quiet event did not release a real hold');
});

test('the runner writes one ledger line per event, and lets it change nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-runner-'));
  fs.writeFileSync(path.join(dir, 'PROGRESS.md'), '## ▶ NEXT STEP\nNEXT: S1\n');
  const u = new UsageService({ fetch: never });
  u.session = 40;
  const r = new Runner({ id: dir, path: dir, name: 'tmp', model: 'opus', effort: 'high', mode: 'auto' });
  r.usageGate = u;
  const rows = [];
  r.appendLedger = (cwd, rec) => rows.push({ cwd, rec });
  const orig = session.defaultSend;
  session.defaultSend = () => {};
  try {
    const send = r._wrapSend('S1', r._gen);
    send('session:message', { msg: mapped({ status: 'allowed', utilization: 0.9, rateLimitType: 'five_hour' }) });
    send('session:message', { msg: mapped({ status: 'allowed', utilization: 0.9, rateLimitType: 'overage' }) });
  } finally { session.defaultSend = orig; }
  assert.equal(rows.length, 2, 'one line per event, unknown type included');
  assert.equal(rows[0].cwd, dir);
  assert.equal(rows[0].rec.kind, 'usage-event');
  assert.equal(rows[0].rec.meter, 'session');
  assert.equal(rows[0].rec.diverged, true, '90 vs the poll 40 is material');
  assert.equal(rows[0].rec.utilization, 0.9, 'the RAW value is kept for S06 to confirm the unit');
  assert.ok(!Number.isNaN(Date.parse(rows[0].rec.at)), 'ISO timestamp, like every other record');
  assert.equal(rows[0].rec.startedAt, undefined, 'no startedAt → buildDigest skips it');
  assert.equal(u.isOverThreshold(), false, 'the gate is still reading the poll');
  // A runner with no usage gate wired (Codex, or before the extension sets it) must not throw.
  const bare = new Runner({ id: dir, path: dir, name: 'tmp' });
  bare.appendLedger = () => assert.fail('nothing to record without a usage service');
  bare._recordUsageEvent(mapped({ utilization: 0.5, rateLimitType: 'five_hour' }));
});
