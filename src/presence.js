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
function ready({ settings, cwd = process.cwd(), exec = execFileSync } = {}) {
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

module.exports = { heartbeat, peers, displayName, TIMEOUT_MS };
