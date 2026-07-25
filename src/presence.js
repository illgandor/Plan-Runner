// Presence client (P10-S04). See planning/reference/CONTRACTS.md §Presence for the wire format.
// The whole contract of this module is that it CANNOT throw or hang into its caller: every request
// carries a 5s AbortSignal.timeout and every failure — timeout, non-2xx, DNS, bad JSON — is
// swallowed to null (D-038). Unconfigured (no url/token, or no git remote) opens no socket at all
// (D-039): both functions return null before `fetch` is ever touched.
'use strict';
const { execFileSync } = require('child_process');
const { projectId, presenceConfig } = require('./presence-id');

const TIMEOUT_MS = 5000; // §Presence: hard per-request timeout, <=5s

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

// Fire-and-forget: POST /heartbeat -> 204. Returns true on success, null on anything else.
async function heartbeat({ state, step } = {}, opts = {}) {
  const ctx = ready(opts);
  if (!ctx) return null;
  const doFetch = opts.fetch || globalThis.fetch;
  try {
    const res = await doFetch(`${ctx.cfg.url}/heartbeat`, {
      ...req(ctx.cfg, opts),
      method: 'POST',
      body: JSON.stringify({
        project: ctx.project, user: ctx.user, step: step || null,
        state: state === 'running' ? 'running' : 'idle', ts: Date.now(),
      }),
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
  const client = opts.client || { heartbeat, peers };
  let timer = null, last = null, ok = null, cur = { state: 'idle', step: null };
  let opt = opts; // opts + the resolved identity, so a tick spawns no git at all

  const tick = () => {
    Promise.resolve(client.heartbeat(cur, opt)).catch(() => {});
    Promise.resolve(client.peers(opt)).then(onPeers, () => {});
  };
  function stop() { if (timer) clearTimer(timer); timer = null; last = null; }
  // Hidden panel, no config or no git remote → no timer and no request at all (D-039). ready() is
  // two git execs, so it is resolved once per loop; a settings edit disposes the loop instead.
  function update({ visible, state, step } = {}) {
    if (ok === null) {
      const ctx = ready(opts);
      ok = !!ctx;
      if (ctx) opt = { ...opts, ctx };
    }
    if (!ok) return;
    const st = state === 'running' ? 'running' : 'idle';
    const ms = visible ? (st === 'running' ? RUNNING_MS : IDLE_MS) : 0;
    const key = `${ms}|${st}|${step || ''}`;
    if (key === last) return; // same cadence AND same step → let the running timer be
    last = key;
    if (timer) clearTimer(timer);
    timer = null;
    if (!ms) return;
    cur = { state: st, step: step || null };
    timer = setTimer(tick, ms);
    tick(); // report the transition now, not one interval late
  }
  return { update, stop };
}

module.exports = { heartbeat, peers, displayName, startPresence, TIMEOUT_MS, RUNNING_MS, IDLE_MS };
