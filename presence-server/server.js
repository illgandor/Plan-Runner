// Presence server (P10-S07). The spec is planning/reference/CONTRACTS.md §Presence + §Dashboard +
// §Account usage — this file implements it and nothing else. Node stdlib only: no framework, no
// database, no deps. THREE stores that never mix: LIVE presence is one in-memory Map that a restart
// forgets; HISTORY ("was here") is a row-capped JSON file that survives one (D-047/D-048); USAGE is
// keyed by USER, not project, because /usage is account-wide (D-052). Nothing may read history or
// usage to decide who is live.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 900000;    // D-046: 3 missed idle beats (3 x 300s). Enforced on READ, no sweep timer.
const MAX_BODY = 64 * 1024;   // trust boundary: this port may be reachable, so bound the read.
const MAX_FIELD = 256;        // …and bound each FIELD: MAX_BODY alone let one 64KB name reach disk.
const MAX_ROWS = 500;         // D-049: history never expires by age — it is ROW-capped, oldest lastSeen out.
const MAX_USERS = 50;         // D-054: same idea for usage. Two people need two; 50 is a bound, not a limit.
const SAVE_MS = 500;          // heartbeats arrive in bursts; one debounced write per burst is plenty.
const DASHBOARD = path.join(__dirname, 'dashboard.html');

// The state file is `{projects:{…}, users:{…}}`. A document with NO `projects` key is the
// pre-PLAN-12 format — the bare projects map — and loads with an empty usage store. A project id
// always contains a `/` (§Presence D-040), so neither envelope key can ever collide with one.
function loadState(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  return raw.projects && typeof raw.projects === 'object' ? raw : { projects: raw };
}

// History is best-effort: a missing, unreadable or corrupt file starts empty and NEVER stops the
// server booting. Presence is advisory; losing last-seen is not worth a dead server.
function loadSeen(file) {
  const seen = new Map();
  const raw = loadState(file).projects;
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

// §Account usage store: keyed by USER, flat, never by project (D-052). Same best-effort rule.
function loadUsers(file) {
  const users = new Map();
  const raw = loadState(file).users;
  if (!raw || typeof raw !== 'object') return users;
  for (const [user, r] of Object.entries(raw)) {
    if (!r || typeof r.ts !== 'number') continue;
    const pct = (v) => (typeof v === 'number' ? v : null);
    users.set(user, {
      session: pct(r.session), week: pct(r.week), threshold: pct(r.threshold),
      ts: r.ts, checkedAt: typeof r.checkedAt === 'number' ? r.checkedAt : null,
    });
  }
  return users;
}

// Temp file + rename: a power cut mid-write leaves the old file intact, never a truncated one.
function saveState(file, seen, users) {
  const projects = {};
  for (const [project, rows] of seen) projects[project] = Object.fromEntries(rows);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ projects, users: Object.fromEntries(users) }));
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

// D-054: the usage store is bounded the same way history is — by ROWS, never by age. A row that
// is gone was evicted by the cap; nothing here ever expires (D-055 keeps stale readings visible).
function evictUsers(users, maxUsers) {
  if (users.size <= maxUsers) return;
  const rows = [...users].sort((a, b) => a[1].ts - b[1].ts);
  for (const [user] of rows.slice(0, users.size - maxUsers)) users.delete(user);
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

// MAX_ROWS bounds HISTORY; nothing bounded the LIVE map, and read-time expiry only ever cleaned
// projects somebody happened to GET. So a project nobody reads — or a token holder POSTing junk
// project names — grew memory forever. Same 900s rule, still no timer.
// ponytail: O(live rows) per beat. Fine at hundreds; bucket by expiry if it ever reaches millions.
function sweepLive(projects, cutoff) {
  for (const [project, users] of projects) {
    livePeers(users, cutoff);
    if (!users.size) projects.delete(project);
  }
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
// Every string is length-bounded: a real id is `host/owner/repo` and a real step is a short label,
// so MAX_FIELD is orders of magnitude of headroom, and without it MAX_BODY allowed a 64KB name
// straight into the state file and onto the dashboard.
const str = (v, min = 1) => typeof v === 'string' && v.length >= min && v.length <= MAX_FIELD;
function valid(b) {
  return !!b && typeof b === 'object'
    && str(b.project) && str(b.user)
    && (b.step === null || b.step === undefined || str(b.step, 0))
    && (b.state === 'running' || b.state === 'idle');
}

// §Account usage POST body. A percentage is 0–100 or null — null means "not known", and it stays
// null all the way to the page, because a zero bar reads as headroom that does not exist.
const pct = (v) => v === null || v === undefined
  || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
function validUsage(b) {
  return !!b && typeof b === 'object' && str(b.user)
    && pct(b.session) && pct(b.week) && pct(b.threshold)
    // Elapsed ms since the reading, NOT a timestamp — the server owns the clock (§Account usage).
    && (b.checkedAgeMs === null || b.checkedAgeMs === undefined
      || (typeof b.checkedAgeMs === 'number' && Number.isFinite(b.checkedAgeMs) && b.checkedAgeMs >= 0))
    // Both null is nothing to record; storing it would render as a person with no headroom.
    && !(b.session == null && b.week == null);
}

function createServer({
  token,
  now = Date.now,
  statePath = process.env.PRESENCE_STATE || path.join(__dirname, 'presence-state.json'),
  maxRows = MAX_ROWS,
  maxUsers = MAX_USERS,
  saveMs = SAVE_MS,
} = {}) {
  const projects = new Map(); // LIVE  — project -> Map(user -> {user, step, state, ts}). Never persisted.
  const seen = loadSeen(statePath); // HISTORY — project -> Map(user -> {lastSeen, lastRunning, step}).
  const users = loadUsers(statePath); // USAGE — user -> {session, week, threshold, ts, checkedAt}.
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveState(statePath, seen, users); }, saveMs);
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
          // frame-ancestors is NOT covered by default-src — without it this page can be framed.
          'content-security-policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; `
            + `connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
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
        sweepLive(projects, ts - MAX_AGE_MS);   // bound the live map too, not just history
        scheduleSave();
        return send(204);
      }

      // §Account usage POST /usage — account-scoped, so its own route rather than a wider
      // heartbeat (D-052): §Presence's two endpoints stay frozen byte for byte.
      if (req.method === 'POST' && route === '/usage') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(400); }
        if (!validUsage(body)) return send(400);
        const ts = now();
        users.set(body.user, {
          session: body.session ?? null,
          week: body.week ?? null,
          threshold: body.threshold ?? null,
          ts,
          // The client sends ELAPSED ms, so the reading lands in the SERVER's frame and no client
          // wall clock is ever compared against ours (same reason the heartbeat's `ts` is discarded).
          checkedAt: body.checkedAgeMs == null ? null : ts - body.checkedAgeMs,
        });
        evictUsers(users, maxUsers);
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
        // §Account usage: TOP-LEVEL, not nested under a project — /usage is account-wide, and a
        // copy per project is two copies of one fact. `stale` is the READING's age, not the
        // report's: a live window whose meter has been erroring for an hour is stale too (D-055).
        // Nothing is dropped here — a stale row keeps its last good numbers and says so.
        const usage = [...users].map(([user, r]) => ({
          user, ...r, stale: r.checkedAt == null || r.checkedAt < cutoff,
        })).sort((a, b) => b.ts - a.ts);
        return send(200, { projects: out, users: usage });
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

module.exports = { createServer, loadSeen, loadUsers, MAX_AGE_MS, MAX_ROWS, MAX_USERS };
