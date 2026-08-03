// Presence client (P10-S04). See planning/reference/CONTRACTS.md §Presence for the wire format.
// The whole contract of this module is that it CANNOT throw or hang into its caller: every request
// carries a 5s AbortSignal.timeout and every failure — timeout, non-2xx, DNS, bad JSON — is
// swallowed to null (D-038). Unconfigured (no url/token, or no git remote) opens no socket at all
// (D-039): both functions return null before `fetch` is ever touched.
'use strict';
const { execFileSync } = require('child_process');
const { projectId, presenceConfig } = require('./presence-id');

const TIMEOUT_MS = 5000; // §Presence: hard per-request timeout, <=5s

// §Presence D-044, amended A-P10-09. `running` used to be everything that wasn't `idle`, and the
// caller derived it from "does this panel have a step id" — so a step waiting on an answer, or held
// on the usage gate, beat `running` for as long as the window stayed open. Two people then read a
// dashboard that could not tell a live run from one stalled two days ago. Anything outside this set
// beats as `idle`: a garbled value must never reach the server, which 400s it and drops the beat.
const STATES = new Set(['running', 'waiting', 'paused', 'idle']);

// One beat's state, taken from the runner's OWN flags rather than from the presence of a step id.
// No step = idle, whatever the runner thinks. A hold outranks a question: a paused window is not
// about to answer one. Pure + exported so the mapping is a unit test, not a claim in extension.js
// (which no test can load — it requires the vscode module).
function runState({ step, paused, needsYou } = {}) {
  if (!step) return 'idle';
  if (paused) return 'paused';
  if (needsYou) return 'waiting';
  return 'running';
}

// §Presence display name (D-042): the setting, else `git config user.name`, else "someone".
// Never an email, never the OS username.
function displayName(name, cwd, exec) {
  if (name) return name;
  try {
    return String(exec('git', ['config', 'user.name'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true })
    ).trim() || 'someone';
  } catch { return 'someone'; }
}

// The single gate both calls run through: null here means "stay dark" and no request happens.
// `opts.ctx` short-circuits it: resolving identity costs two SYNCHRONOUS git spawns, and this
// runs on the extension host's only thread — the cadence loop resolves it once and hands it back
// here so a tick costs zero git calls instead of four. A settings edit disposes the loop, so the
// cached value can never outlive the config it was built from.
function ready({ settings, cwd = process.cwd(), exec = execFileSync, ctx } = {}) {
  if (ctx) return ctx;
  const cfg = presenceConfig(settings);
  if (!cfg) return null;
  const project = projectId(cwd, { exec });
  if (!project) return null;
  return { cfg, project, user: displayName(cfg.name, cwd, exec) };
}

function req(cfg, opts) {
  return {
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS),
  };
}

// The step this window actually HOLDS the claim ref for (P20-S02). Only `taken` counts: a `held`
// step is the OTHER driver's, and an `unreachable` one is being run unclaimed on purpose (INV-7).
// Beating either as ours would paint a lock on the dashboard that `git ls-remote` says isn't there.
// Pure + exported so the mapping is a unit test rather than a claim inside extension.js.
function claimStep(claim) {
  return claim && claim.verdict === 'taken' ? claim.step : null;
}

// Fire-and-forget: POST /heartbeat -> 204. Returns true on success, null on anything else.
async function heartbeat({ state, step, lane, claim } = {}, opts = {}) {
  const ctx = ready(opts);
  if (!ctx) return null;
  const doFetch = opts.fetch || globalThis.fetch;
  const body = {
    project: ctx.project, user: ctx.user, step: step || null,
    state: STATES.has(state) ? state : 'idle', ts: Date.now(),
  };
  // §Presence P20-S01: both fields are OPTIONAL, and absent means absent (D-090) — a `lane: null`
  // key asserts "no lane" where the truth is "this client never said". No lane ⇒ no claim either:
  // claims are inert without one (D-084), so an unlaned project beats exactly today's body.
  if (lane) { body.lane = lane; if (claim) body.claim = claim; }
  try {
    const res = await doFetch(`${ctx.cfg.url}/heartbeat`, {
      ...req(ctx.cfg, opts), method: 'POST', body: JSON.stringify(body),
    });
    return res.ok ? true : null;
  } catch { return null; }
}

// GET /presence/:project -> {peers:[...]}, minus ourselves (the server doesn't know who asks).
// Returns the peer array (possibly []) on success, null on any failure — S06 renders what it gets.
async function peers(opts = {}) {
  const ctx = ready(opts);
  if (!ctx) return null;
  const doFetch = opts.fetch || globalThis.fetch;
  try {
    const res = await doFetch(
      `${ctx.cfg.url}/presence/${encodeURIComponent(ctx.project)}`, req(ctx.cfg, opts));
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.peers)) return null;
    return body.peers.filter((p) => p && p.user !== ctx.user);
  } catch { return null; }
}

// POST /usage -> 204 (§Account usage). Same gate, same swallow-everything rule as the two above.
// Both percentages null means the meter has never read anything: return WITHOUT opening a socket,
// so a window that has never had a reading never creates a row (an empty row renders as a person
// with no headroom left). `checkedAgeMs` is ELAPSED ms, not a timestamp — the server owns the clock.
async function reportUsage(snap, opts = {}) {
  if (!snap || (snap.session == null && snap.week == null)) return null;
  const ctx = ready(opts);
  if (!ctx) return null;
  const doFetch = opts.fetch || globalThis.fetch;
  try {
    const res = await doFetch(`${ctx.cfg.url}/usage`, {
      ...req(ctx.cfg, opts),
      method: 'POST',
      body: JSON.stringify({
        user: ctx.user,
        session: snap.session ?? null,
        week: snap.week ?? null,
        threshold: snap.threshold ?? null,
        checkedAgeMs: snap.checked ? Math.max(0, Date.now() - snap.checked) : null,
      }),
    });
    return res.ok ? true : null;
  } catch { return null; }
}

// ---- The cadence loop (P10-S05, D-043) ----
// One interval; each tick fires a heartbeat AND a peers poll, both fire-and-forget. Nothing here is
// ever awaited by a runner path, so a dead or slow server can never block, delay or fail a step
// (D-038). extension.js drives update() off runner EVENTS — runner.js gains no presence call at all.
const RUNNING_MS = 60000; // a step is live in this panel
const IDLE_MS = 300000;   // panel visible, no live run

function startPresence(opts = {}) {
  const setTimer = opts.setTimer || setInterval;
  const clearTimer = opts.clearTimer || clearInterval;
  const onPeers = opts.onPeers || (() => {});
  const client = opts.client || { heartbeat, peers, reportUsage };
  let timer = null, last = null, ok = null, cur = { state: 'idle', step: null, lane: null, claim: null };
  let usage = null;   // the latest §Usage snapshot; see setUsage below
  let opt = opts; // opts + the resolved identity, so a tick spawns no git at all

  const tick = () => {
    Promise.resolve(client.heartbeat(cur, opt)).catch(() => {});
    Promise.resolve(client.peers(opt)).then(onPeers, () => {});
    if (usage) Promise.resolve(client.reportUsage(usage, opt)).catch(() => {});
  };
  // D-053: usage rides this tick and is deliberately NOT part of the cadence key below. It changes
  // every poll, so keying on it would clear and re-arm the interval every minute and the cadence
  // would thrash — the meter would be either permanently stale or on a timer that never settles.
  // Assigning here lets the NEXT already-scheduled tick carry the fresh value, which is the point.
  function setUsage(s) { usage = s || null; }
  function stop() { if (timer) clearTimer(timer); timer = null; last = null; }
  // Hidden panel, no config or no git remote → no timer and no request at all (D-039). ready() is
  // two git execs, so it is resolved once per loop; a settings edit disposes the loop instead.
  function update({ visible, state, step, lane, claim } = {}) {
    if (ok === null) {
      const ctx = ready(opts);
      ok = !!ctx;
      if (ctx) opt = { ...opts, ctx };
    }
    if (!ok) return;
    // Only a LIVE run earns the 60s cadence; waiting and paused burn nothing, so they beat at the
    // idle 300s — still 3 beats inside the 900s expiry. A transition re-keys and ticks immediately
    // (below), so nobody waits five minutes to see that a step started asking.
    const st = STATES.has(state) ? state : 'idle';
    const ms = visible ? (st === 'running' ? RUNNING_MS : IDLE_MS) : 0;
    // P20-S02: the claim joins the key — taking or releasing one is a real transition, and the
    // other driver learning it five minutes late is the whole thing this plan is fixing. The LANE
    // deliberately stays out: it is a settings fact, and a presenceName edit disposes the whole
    // loop (extension.js), so it can never change under a live key.
    const key = `${ms}|${st}|${step || ''}|${claim || ''}`;
    if (key === last) return; // same cadence AND same step → let the running timer be
    last = key;
    if (timer) clearTimer(timer);
    timer = null;
    if (!ms) return;
    cur = { state: st, step: step || null, lane: lane || null, claim: claim || null };
    timer = setTimer(tick, ms);
    tick(); // report the transition now, not one interval late
  }
  return { update, setUsage, stop };
}

module.exports = {
  heartbeat, peers, reportUsage, displayName, startPresence, runState, claimStep,
  TIMEOUT_MS, RUNNING_MS, IDLE_MS, STATES,
};
