// Presence server (P10-S07). The spec is planning/reference/CONTRACTS.md §Presence — this file
// implements it and nothing else. Node stdlib `http` only: no framework, no database, no deps.
// State is one in-memory Map; a restart forgets everything, which is the contract (D-046).
'use strict';
const http = require('http');
const crypto = require('crypto');

const MAX_AGE_MS = 900000;    // D-046: 3 missed idle beats (3 x 300s). Enforced on READ, no sweep timer.
const MAX_BODY = 64 * 1024;   // trust boundary: this port may be reachable, so bound the read.

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

function createServer({ token, now = Date.now } = {}) {
  const projects = new Map(); // project -> Map(user -> {user, step, state, ts})

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
      if (!authed(req, token)) return send(401);          // 401 with no body, per §Presence.
      const path = String(req.url || '/').split('?')[0];

      if (req.method === 'POST' && path === '/heartbeat') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(400); }
        if (!valid(body)) return send(400);
        let users = projects.get(body.project);
        if (!users) projects.set(body.project, (users = new Map()));
        // The server timestamps authoritatively; the client's advisory `ts` is discarded.
        users.set(body.user, { user: body.user, step: body.step ?? null, state: body.state, ts: now() });
        return send(204);
      }

      if (req.method === 'GET' && path.startsWith('/presence/')) {
        let project;
        try { project = decodeURIComponent(path.slice('/presence/'.length)); } catch { return send(400); }
        const users = projects.get(project);
        const cutoff = now() - MAX_AGE_MS;
        const peers = [];
        // Expiry on read: stale records are dropped as we pass them, so the Map self-cleans.
        if (users) {
          for (const [user, rec] of users) {
            if (rec.ts < cutoff) users.delete(user); else peers.push(rec);
          }
        }
        // Unknown project is [], never 404 — absence is an empty array. We do not know who is asking,
        // so the caller filters itself out by `user`.
        return send(200, { peers });
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

module.exports = { createServer, MAX_AGE_MS };
