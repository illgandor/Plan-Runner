// P10-S07 gate: `node --test presence-server/`. Runs the real server on an ephemeral port and
// talks to it over real HTTP — the only honest way to test a wire contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createServer, loadSeen, MAX_AGE_MS } = require('./server');

const TOKEN = 'test-token';
const PROJECT = 'github.com/illgandor/plan-runner';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-presence-'));
let n = 0;
const tmpState = () => path.join(TMP, `state-${n++}.json`);

// The state write is debounced, so the file appears a beat after the request returns.
async function waitFor(fn, ms = 2000) {
  const stop = Date.now() + ms;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* not written yet */ }
    if (Date.now() > stop) throw new Error('timed out waiting for the state file');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function start(opts = {}) {
  // Default every server to a throwaway state file — never the real one beside server.js.
  const srv = createServer({ token: TOKEN, statePath: tmpState(), saveMs: 10, ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base,
    close: () => new Promise((r) => srv.close(r)),
    beat: (body, token = TOKEN) => fetch(`${base}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    peers: (project = PROJECT, token = TOKEN) => fetch(
      `${base}/presence/${encodeURIComponent(project)}`, { headers: { authorization: `Bearer ${token}` } }),
    projects: (token = TOKEN) => fetch(`${base}/projects`, { headers: { authorization: `Bearer ${token}` } }),
  };
}

test('heartbeat is stored and read back with the SERVER timestamp', async () => {
  const s = await start({ now: () => 1000 });
  try {
    const post = await s.beat({ project: PROJECT, user: 'Reno', step: 'P10-S05', state: 'running', ts: 5 });
    assert.strictEqual(post.status, 204);
    assert.strictEqual(await post.text(), '');

    const res = await s.peers();
    assert.strictEqual(res.status, 200);
    // The server does not know who is asking, so the reporter is in its own peer list.
    assert.deepStrictEqual((await res.json()).peers,
      [{ user: 'Reno', step: 'P10-S05', state: 'running', ts: 1000 }]);
  } finally { await s.close(); }
});

test('a record older than 3 missed beats is dropped on read', async () => {
  let now = 0;
  const s = await start({ now: () => now });
  try {
    await s.beat({ project: PROJECT, user: 'Reno', step: null, state: 'idle', ts: 0 });

    now = MAX_AGE_MS;                       // exactly 900s old — still present
    assert.strictEqual((await (await s.peers()).json()).peers.length, 1);

    now = MAX_AGE_MS + 1;                   // older than 900s — gone
    assert.deepStrictEqual((await (await s.peers()).json()).peers, []);
  } finally { await s.close(); }
});

test('a bad or missing token is 401 on both routes and stores nothing', async () => {
  const s = await start();
  try {
    const bad = await s.beat({ project: PROJECT, user: 'Mallory', step: null, state: 'idle' }, 'wrong');
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(await bad.text(), '');
    assert.strictEqual((await s.peers(PROJECT, 'wrong')).status, 401);
    assert.strictEqual((await fetch(`${s.base}/presence/x`)).status, 401);

    // The rejected heartbeat left no trace.
    assert.deepStrictEqual((await (await s.peers()).json()).peers, []);
  } finally { await s.close(); }
});

test('an unknown project is 200 with an empty array, never a 404', async () => {
  const s = await start();
  try {
    const res = await s.peers('github.com/nobody/nothing');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { peers: [] });
  } finally { await s.close(); }
});

test('malformed bodies are 400, and an unknown route is 404', async () => {
  const s = await start();
  try {
    assert.strictEqual((await s.beat('{not json')).status, 400);
    assert.strictEqual((await s.beat({ user: 'Reno', state: 'idle' })).status, 400);        // no project
    assert.strictEqual((await s.beat({ project: PROJECT, user: 'Reno', state: 'x' })).status, 400);
    assert.strictEqual((await fetch(`${s.base}/nope`,
      { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  } finally { await s.close(); }
});

// S0108 audit: an over-long body destroys the request socket, and the 400 that followed used to
// throw INSIDE an async handler — an unhandled rejection, which ends the process. One authenticated
// 1MB POST could take the server down; systemd would restart it, but everyone's presence blinked.
test('an oversized body is rejected without killing the server', async () => {
  const s = await start();
  try {
    const huge = JSON.stringify({ project: PROJECT, user: 'X'.repeat(200000), step: null, state: 'idle' });
    await s.beat(huge).catch(() => {}); // the socket may die mid-send — that is the point
    // Still serving: the process survived, and normal traffic is unaffected.
    assert.strictEqual((await s.beat({ project: PROJECT, user: 'Reno', step: null, state: 'idle' })).status, 204);
    assert.strictEqual((await s.peers()).status, 200);
  } finally { await s.close(); }
});

// P11-S02 — HISTORY (D-048). Survives a restart; the LIVE map still does not (D-047).
test('last-seen survives a restart, and an idle beat never clears lastRunning/step', async () => {
  const statePath = tmpState();
  const s1 = await start({ statePath, now: () => 1000 });
  try {
    await s1.beat({ project: PROJECT, user: 'Reno', step: 'P11-S02', state: 'running', ts: 5 });
    await waitFor(() => fs.existsSync(statePath));
  } finally { await s1.close(); }

  // A FRESH server against the same file: the row is back, and a later idle beat only moves lastSeen.
  const s2 = await start({ statePath, now: () => 2000 });
  try {
    assert.deepStrictEqual((await (await s2.peers()).json()).peers, []); // LIVE is still forgotten (D-047)
    await s2.beat({ project: PROJECT, user: 'Reno', step: null, state: 'idle', ts: 9 });
    const row = await waitFor(() => {
      const r = loadSeen(statePath).get(PROJECT)?.get('Reno');
      return r && r.lastSeen === 2000 ? r : null;
    });
    assert.deepStrictEqual(row, { lastSeen: 2000, lastRunning: 1000, step: 'P11-S02' });
  } finally { await s2.close(); }
});

test('a corrupt state file yields an empty store and a server that still starts', async () => {
  const statePath = tmpState();
  fs.writeFileSync(statePath, '{"github.com/a/b": {"Reno": {"lastSeen"');   // truncated mid-write
  const s = await start({ statePath, now: () => 7000 });
  try {
    assert.strictEqual(loadSeen(statePath).size, 0);
    assert.strictEqual((await s.beat({ project: PROJECT, user: 'Reno', step: null, state: 'idle' })).status, 204);
    const state = await waitFor(() => loadSeen(statePath).get(PROJECT)?.get('Reno'));
    assert.strictEqual(state.lastSeen, 7000);
  } finally { await s.close(); }
});

test('past the row cap the oldest lastSeen is evicted and the newest survives', async () => {
  const statePath = tmpState();
  let now = 1000;
  const s = await start({ statePath, maxRows: 2, now: () => now });
  try {
    for (const user of ['Oldest', 'Middle', 'Newest']) {
      await s.beat({ project: PROJECT, user, step: null, state: 'idle' });
      now += 1000;
    }
    const rows = await waitFor(() => {
      const r = loadSeen(statePath).get(PROJECT);
      return r && r.size === 2 ? r : null;
    });
    assert.deepStrictEqual([...rows.keys()], ['Middle', 'Newest']);
  } finally { await s.close(); }
});

// P11-S03 — GET /projects (§Dashboard). Live and history joined, D-050 sort.
test('GET /projects sorts multi-reporter projects first, then by most recent activity', async () => {
  let now = 1000;
  const s = await start({ now: () => now });
  const SOLO = 'github.com/illgandor/solo';
  try {
    await s.beat({ project: PROJECT, user: 'Reno', step: 'P11-S03', state: 'running' });
    now += 1000;
    await s.beat({ project: PROJECT, user: 'Tyler', step: null, state: 'idle' });
    now += 1000;
    await s.beat({ project: SOLO, user: 'Tyler', step: null, state: 'idle' });  // newest, but 1 reporter

    const res = await s.projects();
    assert.strictEqual(res.status, 200);
    const { projects } = await res.json();
    assert.deepStrictEqual(projects.map((p) => p.project), [PROJECT, SOLO]);
    assert.strictEqual(projects[0].reporters, 2);
    assert.deepStrictEqual(projects[0].people.map((p) => p.user), ['Tyler', 'Reno']); // lastSeen desc
    assert.deepStrictEqual(projects[0].people[1],
      { user: 'Reno', lastSeen: 1000, lastRunning: 1000, step: 'P11-S03' });
    assert.deepStrictEqual(projects[0].peers.map((p) => p.user).sort(), ['Reno', 'Tyler']);
  } finally { await s.close(); }
});

test('an expired peer leaves /projects peers but stays in people; unknown = empty, no token = 401', async () => {
  let now = 0;
  const s = await start({ now: () => now });
  try {
    assert.deepStrictEqual(await (await s.projects()).json(), { projects: [] });  // nothing known yet
    assert.strictEqual((await s.projects('wrong')).status, 401);

    await s.beat({ project: PROJECT, user: 'Reno', step: 'P11-S03', state: 'running' });
    now = MAX_AGE_MS + 1;
    const [p] = (await (await s.projects()).json()).projects;
    assert.deepStrictEqual(p.peers, []);
    assert.deepStrictEqual(p.people, [{ user: 'Reno', lastSeen: 0, lastRunning: 0, step: 'P11-S03' }]);
    assert.strictEqual(p.reporters, 1);
  } finally { await s.close(); }
});

test('starting with no PRESENCE_TOKEN exits non-zero and names the reason', () => {
  const env = { ...process.env };
  delete env.PRESENCE_TOKEN;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'server.js')],
      { env, encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    assert.fail('server started without a token');
  } catch (e) {
    assert.ok(e.status > 0, `expected a non-zero exit, got ${e.status}`);
    assert.match(String(e.stderr), /PRESENCE_TOKEN/);
  }
});
