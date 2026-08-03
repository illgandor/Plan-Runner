// The Codex rollout usage reader (P16-S07, CONTRACTS §Usage sources). The two fixtures below are
// REAL `token_count` records recorded on this box on 2026-08-02, with the transcript half of the
// line dropped — they exist because §Usage sources' first trap is that `primary`/`secondary` swap
// roles between sessions, and a hand-written fixture would have quietly agreed with whichever
// layout the code assumed. Nothing here is wired to anything: S08 owns every consequence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codexFetch, parseRollout, newestRollout } = require('../src/codex-usage');

// Real, 2026-07-10 session: the 5-hour window in `primary`, the WEEKLY in `secondary`.
const WEEKLY_IN_SECONDARY = JSON.stringify({
  timestamp: '2026-07-11T01:56:03.266Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 13.0, window_minutes: 300, resets_at: 1783752172 },
    secondary: { used_percent: 2.0, window_minutes: 10080, resets_at: 1784338972 },
    credits: null, individual_limit: null, plan_type: 'plus', rate_limit_reached_type: null } },
});

// Real, 2026-08-02 session: the WEEKLY in `primary` and no 5-hour window at all. `rate_limits` is a
// SIBLING of `info`, not inside it — kept here so the nesting is fixed by a real record.
const WEEKLY_IN_PRIMARY = JSON.stringify({
  timestamp: '2026-08-02T21:48:29.175Z', type: 'event_msg',
  payload: { type: 'token_count',
    info: { total_token_usage: { total_tokens: 17971 }, model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex', limit_name: null,
      primary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1786312108 },
      secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null, plan_type: 'plus', rate_limit_reached_type: null } },
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-codex-'));
const write = (dir, name, text) => {
  const f = path.join(dir, '2026', '08', '02', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

test('both positional layouts parse to the same correct answer', () => {
  const real = parseRollout(WEEKLY_IN_SECONDARY);
  assert.deepStrictEqual(real, {
    session: 13, week: 2, fable: null,
    sessionResetsAt: 1783752172000, weekResetsAt: 1784338972000,
  });
  // The same reading with primary/secondary SWAPPED must land in the same meters — the window
  // decides, never the key position.
  const j = JSON.parse(WEEKLY_IN_SECONDARY);
  const r = j.payload.rate_limits;
  [r.primary, r.secondary] = [r.secondary, r.primary];
  assert.deepStrictEqual(parseRollout(JSON.stringify(j)), real);
});

test('the weekly-only real record reads a week and leaves the session unknown', () => {
  // 0% here is a real measured reading, not a fabricated zero; the absent 5-hour window is null.
  assert.deepStrictEqual(parseRollout(WEEKLY_IN_PRIMARY), {
    session: null, week: 0, fable: null, sessionResetsAt: null, weekResetsAt: 1786312108000,
  });
});

test('the LAST rate_limits record wins, not the first', () => {
  const older = WEEKLY_IN_SECONDARY.replace('"used_percent":13', '"used_percent":1');
  assert.strictEqual(parseRollout([older, WEEKLY_IN_SECONDARY].join('\n')).session, 13);
});

test('a torn final line costs nothing — the last PARSEABLE record still reads', () => {
  const torn = `${WEEKLY_IN_SECONDARY}\n{"payload":{"rate_limits":{"prim`;
  assert.strictEqual(parseRollout(torn).session, 13);
});

test('an unknown window_minutes is ignored and does not populate a meter', () => {
  const odd = WEEKLY_IN_SECONDARY.replace('"window_minutes":300', '"window_minutes":60');
  const r = parseRollout(odd);
  assert.strictEqual(r.session, null, 'a 60-minute window is not guessed into the session meter');
  assert.strictEqual(r.week, 2, 'the window it DOES recognise still reads');
  // Every window unknown = nothing recognised = a no-reading, not a row of zeros.
  const allOdd = odd.replace('"window_minutes":10080', '"window_minutes":60');
  assert.ok(parseRollout(allOdd).error, 'no recognised window is a no-reading');
});

test('a prototype key as window_minutes resolves to no meter', () => {
  const evil = WEEKLY_IN_SECONDARY.replace('"window_minutes":300', '"window_minutes":"constructor"');
  assert.strictEqual(parseRollout(evil).session, null);
});

test('fable is always null and no fableLabel is returned — Codex has no per-model window', () => {
  for (const text of [WEEKLY_IN_SECONDARY, WEEKLY_IN_PRIMARY]) {
    const r = parseRollout(text);
    assert.strictEqual(r.fable, null);
    assert.ok(!('fableLabel' in r), 'returning no label leaves UsageService.fableLabel untouched');
  }
});

test('every failure mode is a no-reading — never zero, never a throw', async () => {
  const dir = tmp();
  const cases = [
    ['no sessions directory at all', async () => codexFetch({ sessionsDir: path.join(dir, 'nope') })],
    ['a directory with no rollout files', async () => {
      const d = tmp(); fs.writeFileSync(path.join(d, 'notes.txt'), 'hi');
      return codexFetch({ sessionsDir: d });
    }],
    ['an unreadable rollout', async () => {
      const d = tmp(); fs.mkdirSync(path.join(d, 'rollout-x.jsonl'), { recursive: true });
      return codexFetch({ sessionsDir: d });
    }],
    ['an empty rollout', async () => {
      const d = tmp(); write(d, 'rollout-a.jsonl', ''); return codexFetch({ sessionsDir: d });
    }],
    ['malformed JSON', async () => {
      const d = tmp(); write(d, 'rollout-a.jsonl', '{"rate_limits": broken\nalso not json');
      return codexFetch({ sessionsDir: d });
    }],
    ['records carrying no rate_limits', async () => {
      const d = tmp(); write(d, 'rollout-a.jsonl', '{"type":"event_msg","payload":{"type":"agent_message"}}');
      return codexFetch({ sessionsDir: d });
    }],
    ['an unknown window', async () => {
      const d = tmp();
      write(d, 'rollout-a.jsonl', WEEKLY_IN_SECONDARY.replace(/"window_minutes":\d+/g, '"window_minutes":60'));
      return codexFetch({ sessionsDir: d });
    }],
  ];
  for (const [name, run] of cases) {
    const r = await run();           // must not throw
    assert.ok(r.error, `${name} → an error, got ${JSON.stringify(r)}`);
    assert.ok(r.error.startsWith('codex usage: '), name);
    for (const k of ['session', 'week', 'fable']) assert.ok(r[k] == null, `${name} → no ${k} number`);
  }
});

test('the NEWEST rollout by mtime wins, wherever the date folders put it', async () => {
  const dir = tmp();
  const old = write(dir, 'rollout-old.jsonl', WEEKLY_IN_PRIMARY);
  const now = write(dir, 'rollout-new.jsonl', WEEKLY_IN_SECONDARY);
  fs.utimesSync(old, new Date(1e9), new Date(1e9));   // a session from days ago
  fs.utimesSync(now, new Date(2e9), new Date(2e9));
  assert.strictEqual(await newestRollout(dir), now);
  assert.strictEqual((await codexFetch({ sessionsDir: dir })).session, 13);
});
