// Presence server (P10-S07). The spec is planning/reference/CONTRACTS.md §Presence + §Dashboard —
// this file implements it and nothing else. Node stdlib only: no framework, no database, no deps.
// TWO stores that never mix (D-047/D-048): LIVE presence is one in-memory Map that a restart
// forgets, and HISTORY ("was here") is a row-capped JSON file that survives one. Nothing may read
// history to decide who is live.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 900000;    // D-046: 3 missed idle beats (3 x 300s). Enforced on READ, no sweep timer.
const MAX_BODY = 64 * 1024;   // trust boundary: this port may be reachable, so bound the read.
const MAX_ROWS = 500;         // D-049: history never expires by age — it is ROW-capped, oldest lastSeen out.
const SAVE_MS = 500;          // heartbeats arrive in bursts; one debounced write per burst is plenty.
const DASHBOARD = path.join(__dirname, 'dashboard.html');

// History is best-effort: a missing, unreadable or corrupt file starts empty and NEVER stops the
// server booting. Presence is advisory; losing last-seen is not worth a dead server.
function loadSeen(file) {
  const seen = new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return seen; }
  if (!raw || typeof raw !== 'object') return seen;
  for (const [project, users] of Object.entries(raw)) {
    if (!users || typeof users !== 'object') continue;
    const rows = new Map();
    for (const [user, r] of Object.entries(users)) {
      if (!r || typeof r.lastSeen !== 'number') continue;
      rows.set(user, {
        lastSeen: r.lastSeen,
        lastRunning: typeof r.lastRunning === 'number' ? r.lastRunning : null,
        step: typeof r.step === 'string' ? r.step : null,
      });
    }
    if (rows.size) seen.set(project, rows);
  }
  return seen;
}

// Temp file + rename: a power cut mid-write leaves the old file intact, never a truncated one.
function saveSeen(file, seen) {
  const out = {};
  for (const [project, rows] of seen) out[project] = Object.fromEntries(rows);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(out));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* best-effort: an unwritable state path must not break presence */ }
}

function evict(seen, maxRows) {
  const rows = [];
  for (const [project, users] of seen) for (const [user, rec] of users) rows.push([project, user, rec.lastSeen]);
  if (rows.length <= maxRows) return;
  rows.sort((a, b) => a[2] - b[2]);
  for (const [project, user] of rows.slice(0, rows.length - maxRows)) {
    const users = seen.get(project);
    users.delete(user);
    if (!users.size) seen.delete(project);
  }
}

// ONE expiry rule shared by both read routes (D-046). Two copies of the 900s cutoff is how they
// drift apart. Expiry is enforced on READ: stale records are dropped as we pass them.
function livePeers(users, cutoff) {
  const peers = [];
  if (!users) return peers;
  for (const [user, rec] of users) {
    if (rec.ts < cutoff) users.delete(user); else peers.push(rec);
  }
  return peers;
}

// Constant-time bearer compare — one shared token per deployment (D-045), never logged.
function authed(req, token) {
  const a = Buffer.from(String(req.headers.authorization || ''));
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// §Presence POST body shape. Anything else is a 400 — we never store a half-formed record.
function valid(b) {
  return !!b && typeof b === 'object'
    && typeof b.project === 'string' && b.project !== ''
    && typeof b.user === 'string' && b.user !== ''
    && (b.step === null || b.step === undefined || typeof b.step === 'string')
    && (b.state === 'running' || b.state === 'idle');
}

function createServer({
  token,
  now = Date.now,
  statePath = process.env.PRESENCE_STATE || path.join(__dirname, 'presence-state.json'),
  maxRows = MAX_ROWS,
  saveMs = SAVE_MS,
} = {}) {
  const projects = new Map(); // LIVE  — project -> Map(user -> {user, step, state, ts}). Never persisted.
  const seen = loadSeen(statePath); // HISTORY — project -> Map(user -> {lastSeen, lastRunning, step}).
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveSeen(statePath, seen); }, saveMs);
    saveTimer.unref?.();          // a pending write must never hold the process open.
  };

  return http.createServer(async (req, res) => {
    // Writing to a socket we already tore down (the over-long-body path destroys it) throws, and
    // a throw inside an async handler is an unhandled rejection — which ends the process. One
    // guard here and one catch below mean a malformed request can never take the server down.
    const send = (code, body) => {
      if (res.writableEnded || res.destroyed) return;
      if (body === undefined) { res.writeHead(code).end(); return; }
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      const route = String(req.url || '/').split('?')[0];  // NB: never name this `path` — it shadows the module.

      // §Dashboard auth split: `GET /` is the ONE unauthenticated route, and it is routed AHEAD of
      // the check on purpose — a browser cannot attach a bearer header to its own document load.
      // Safe because the page ships zero data: it asks the viewer for the token and fetches
      // /projects itself. Its inline style+script are admitted by a per-response nonce, never by
      // 'unsafe-inline'; a nonce fixed at boot would be no better than none.
      if (req.method === 'GET' && route === '/') {
        let html;
        try { html = fs.readFileSync(DASHBOARD, 'utf8'); } catch { return send(500); }
        const nonce = crypto.randomBytes(16).toString('base64');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; base-uri 'none'; connect-src 'self'; `
            + `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
          'cache-control': 'no-store',
        }).end(html.split('%NONCE%').join(nonce));
        return;
      }

      if (!authed(req, token)) return send(401);          // 401 with no body, per §Presence.

      if (req.method === 'POST' && route === '/heartbeat') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(400); }
        if (!valid(body)) return send(400);
        let users = projects.get(body.project);
        if (!users) projects.set(body.project, (users = new Map()));
        // The server timestamps authoritatively; the client's advisory `ts` is discarded.
        const ts = now();
        users.set(body.user, { user: body.user, step: body.step ?? null, state: body.state, ts });

        // HISTORY: lastSeen tracks any beat; lastRunning and `step` only advance on a RUNNING one,
        // so a row reads "last working on P11-S02", not whatever idle beat happened to land last.
        let rows = seen.get(body.project);
        if (!rows) seen.set(body.project, (rows = new Map()));
        const prev = rows.get(body.user);
        const running = body.state === 'running';
        rows.set(body.user, {
          lastSeen: ts,
          lastRunning: running ? ts : (prev ? prev.lastRunning : null),
          step: running ? (body.step ?? null) : (prev ? prev.step : null),
        });
        evict(seen, maxRows);
        scheduleSave();
        return send(204);
      }

      if (req.method === 'GET' && route.startsWith('/presence/')) {
        let project;
        try { project = decodeURIComponent(route.slice('/presence/'.length)); } catch { return send(400); }
        // Unknown project is [], never 404 — absence is an empty array. We do not know who is asking,
        // so the caller filters itself out by `user`.
        return send(200, { peers: livePeers(projects.get(project), now() - MAX_AGE_MS) });
      }

      // §Dashboard GET /projects — every KNOWN project (history ∪ live), its live peers and its
      // history rows. Nobody is filtered out of `peers`: the dashboard has no caller identity.
      if (req.method === 'GET' && route === '/projects') {
        const cutoff = now() - MAX_AGE_MS;
        const out = [];
        for (const project of new Set([...seen.keys(), ...projects.keys()])) {
          const rows = seen.get(project);
          const people = rows
            ? [...rows].map(([user, r]) => ({ user, ...r })).sort((a, b) => b.lastSeen - a.lastSeen)
            : [];
          out.push({ project, reporters: people.length, peers: livePeers(projects.get(project), cutoff), people });
        }
        // D-050: multi-reporter projects first, then most recent activity (people[0] is the max) desc.
        out.sort((a, b) => (b.reporters > 1) - (a.reporters > 1)
          || (b.people[0]?.lastSeen ?? 0) - (a.people[0]?.lastSeen ?? 0));
        return send(200, { projects: out });
      }

      send(404);
    } catch { send(500); }
  });
}

if (require.main === module) {
  const token = process.env.PRESENCE_TOKEN;
  if (!token) {
    console.error('PRESENCE_TOKEN is not set — refusing to start. Set it to a shared secret; '
      + 'every Plan Runner client must send the same value.');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8787;
  createServer({ token }).listen(port, () => console.log(`presence server listening on :${port}`));
}

module.exports = { createServer, loadSeen, MAX_AGE_MS, MAX_ROWS };
