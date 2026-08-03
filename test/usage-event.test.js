// The SDK `rate_limit_event` as a SECOND usage source: ingested in P16-S05, promoted in P16-S06.
// Covers the whole path: the raw SDK message → session.mapMessage → UsageService.recordEvent →
// one run-ledger line → the precedence rule the gate and the panel both read. The load-bearing
// claims are that the rule has NO direction test (the event wins higher and lower), and that a
// wrong event expires on its own (CONTRACTS §Usage sources, D-073). No spawn, no webview.
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

test('an unknown rateLimitType still cannot move the gate — it belongs to no meter', () => {
  const u = new UsageService({ fetch: never, threshold: 90, weekThreshold: 90, fableThreshold: 90 });
  u.session = 10; u.week = 10; u.fable = 10; u.fableLabel = 'Fable'; u.checked = Date.now();
  const before = u.describe('fable');
  for (const rateLimitType of ['overage', 'seven_day_overage_included', 'five_hour_beta']) {
    u.recordEvent(mapped({ status: 'rejected', utilization: 1, resetsAt: 1, rateLimitType }));
    assert.equal(u.isOverThreshold('fable'), false, `${rateLimitType} did not create a hold`);
  }
  assert.equal(u.describe('fable'), before, 'and the reasons are byte-identical');
  assert.equal(u.snapshot().source, 'poll', 'nothing was promoted');
});

// ---- P16-S06 — the event is promoted where it is fresher (D-073, §Usage sources) -----------
// One rule, tested in both directions: the newest reading wins, and within one poll cadence the
// event wins. Nothing here is a "may only raise" or "may only lower" rule.
const CADENCE_MS = 60000;
function svc(sessionPct, checked) {
  const u = new UsageService({ fetch: never, threshold: 90, weekThreshold: 90, fableThreshold: 90, pollSec: 60 });
  u.session = sessionPct; u.week = 10; u.fable = 10; u.fableLabel = 'Fable'; u.checked = checked;
  return u;
}

test('the event wins in EITHER direction while it is the fresher reading', () => {
  const now = Date.now();
  // Mid-run: usage climbs and the poll lags up to a cadence, so the event reads HIGHER. This is
  // the case the event exists for — suppressing it is what makes the gate pause late.
  const climbing = svc(80, now - 40000);
  climbing.recordEvent(mapped({ status: 'allowed_warning', utilization: 0.95, rateLimitType: 'five_hour' }), now);
  assert.equal(climbing.snapshot().session, 95, 'the meter tracks the event, not the lagging poll');
  assert.equal(climbing.snapshot().source, 'event');
  assert.equal(climbing.isOverThreshold(), true, 'and it pauses on time, not a minute late');
  // After a reset the poll can serve a dead window (S0124: 99% for 3.5 h). The event reads LOWER
  // and wins by exactly the same rule — no direction test anywhere.
  const stale = svc(99, now - 40000);
  stale.recordEvent(mapped({ status: 'allowed', utilization: 0.03, rateLimitType: 'five_hour' }), now);
  assert.equal(stale.snapshot().session, 3);
  assert.equal(stale.isOverThreshold(), false, 'a stale-high poll no longer holds the run');
});

test('the poll takes the meter back once it overtakes the event by a full cadence', () => {
  const now = Date.now();
  const tie = svc(80, now);                       // poll newer, but only just — the event still wins
  tie.recordEvent(mapped({ utilization: 0.95, rateLimitType: 'five_hour' }), now - CADENCE_MS);
  assert.equal(tie.snapshot().session, 95, 'within one cadence the event wins (it is request-derived)');
  const overtaken = svc(80, now);
  overtaken.recordEvent(mapped({ utilization: 0.95, rateLimitType: 'five_hour' }), now - CADENCE_MS - 1);
  assert.equal(overtaken.snapshot().session, 80, 'a stale event yields to the poll');
  assert.equal(overtaken.snapshot().source, 'poll');
  assert.equal(overtaken.isOverThreshold(), false,
    'so a wrong event — utilization has no documented unit — expires by itself within ~2 polls');
});

test('a rejected status pauses whatever the percentage says; allowed_warning alone does not', () => {
  const now = Date.now();
  const warn = svc(10, now);
  warn.recordEvent(mapped({ status: 'allowed_warning', utilization: 0.11, rateLimitType: 'five_hour' }), now);
  assert.equal(warn.isOverThreshold(), false, 'a warning is not a verdict');
  const no = svc(10, now);
  no.recordEvent(mapped({ status: 'rejected', utilization: 0.11, rateLimitType: 'five_hour' }), now);
  assert.equal(no.isOverThreshold(), true, 'the server refused the request — 11% does not outrank that');
  assert.equal(no.describe(), 'session usage rejected by the server');
  assert.equal(no.snapshot().session, 11, 'and the meter still shows a real number');
  // Every hold can still end (P16-S04): the reset clock releases a rejection too.
  const past = svc(10, now);
  past.recordEvent(mapped({ status: 'rejected', resetsAt: Math.round((now - 2 * CADENCE_MS) / 1000),
    rateLimitType: 'five_hour' }), now);
  assert.equal(past.isOverThreshold(), false, 'a passed reset ends a rejected hold, or Codex deadlocks at S08');
});

test('last-good is per source — neither source can blank the other', async () => {
  const now = Date.now();
  const u = new UsageService({ fetch: async () => ({ error: 'boom' }), pollSec: 60, threshold: 90 });
  u.session = 40; u.checked = now;
  u.recordEvent(mapped({ status: 'allowed', utilization: 0.95, rateLimitType: 'five_hour' }), now);
  await u._tick(); u.stop();
  assert.equal(u.error, 'boom');
  assert.equal(u.snapshot().session, 95, 'a failed poll did not blank a good event reading');
  // The mirror: an event carrying no percentage at all never blanks the poll's number.
  const bare = svc(40, now);
  bare.recordEvent(mapped({ status: 'rejected', rateLimitType: 'five_hour' }), now);
  assert.equal(bare.snapshot().session, 40);
});

test('material disagreement is visible in the panel, and only while it lasts', () => {
  const now = Date.now();
  const u = svc(40, now);
  u.recordEvent(mapped({ utilization: 0.62, rateLimitType: 'five_hour' }), now);
  assert.equal(u.snapshot().divergence, 'Session 62% live vs 40% polled');
  u.recordEvent(mapped({ utilization: 0.45, rateLimitType: 'five_hour' }), now); // agreement is silence
  assert.equal(u.snapshot().divergence, null);
  // ...and it is gone once the poll has overtaken the event, whatever the two numbers were.
  const old = svc(40, now);
  old.recordEvent(mapped({ utilization: 0.62, rateLimitType: 'five_hour' }), now - CADENCE_MS - 1);
  assert.equal(old.snapshot().divergence, null, 'a superseded event is history, not a disagreement');
  // The per-model row is named by /usage, never hard-coded (the line read `(Opus)` before `(Fable)`).
  const f = svc(40, now); f.fableLabel = 'Opus';
  f.recordEvent(mapped({ utilization: 0.9, rateLimitType: 'seven_day_opus' }), now);
  assert.equal(f.snapshot().divergence, 'Opus 90% live vs 10% polled');
});

test('recordEvent emits an update so the panel repaints on the event, not one poll later', () => {
  const u = svc(40, Date.now());
  const seen = [];
  u.on('update', (s) => seen.push(s.session));
  u.recordEvent(mapped({ utilization: 0.62, rateLimitType: 'five_hour' }));
  u.recordEvent(mapped({ utilization: 0.99, rateLimitType: 'overage' })); // no meter → nothing changed
  assert.deepEqual(seen, [62]);
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
  assert.equal(u.isOverThreshold(), true, 'and the gate acted on it — 90% with no fresher poll (P16-S06)');
  // A runner with no usage gate wired (Codex, or before the extension sets it) must not throw.
  const bare = new Runner({ id: dir, path: dir, name: 'tmp' });
  bare.appendLedger = () => assert.fail('nothing to record without a usage service');
  bare._recordUsageEvent(mapped({ utilization: 0.5, rateLimitType: 'five_hour' }));
});
