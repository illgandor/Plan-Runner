// P10-S09: the integration proof. The REAL server (presence-server/server.js) on an ephemeral port,
// the REAL client (src/presence.js) over real HTTP, and the REAL renderer — two simulated users on
// one machine, no mocks in between. Only git is faked, because a test may not assume anything about
// this checkout's remote or the machine's `git config user.name`.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createServer, MAX_AGE_MS } = require('../presence-server/server');
const { heartbeat, peers, startPresence } = require('../src/presence');

global.window = {};
require('../src/webview/presence-view.js');
const { presenceLabel } = global.window;

const TOKEN = 'e2e-token';
const REMOTE = 'git@github.com:illgandor/Plan-Runner.git'; // → github.com/illgandor/plan-runner

// The only fake: `git remote get-url origin` and `git config user.name`.
const fakeGit = (userName) => (_cmd, args) => (args[0] === 'remote' ? REMOTE : userName);

// Two identities, two "machines", one project. Reno names himself in settings; Tyler leaves the
// setting empty and falls back to git config (D-042) — so both identity paths run end-to-end.
const reno = (url) => ({ settings: { url, token: TOKEN, name: 'Reno' }, exec: fakeGit('ignored') });
const tyler = (url) => ({ settings: { url, token: TOKEN, name: '' }, exec: fakeGit('Tyler') });

async function listen(port = 0, now = Date.now) {
  const srv = createServer({ token: TOKEN, now });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return srv;
}
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
const close = (srv) => new Promise((r) => srv.close(r));

test('two users on one machine see each other, and neither sees themselves', async () => {
  const srv = await listen();
  const [a, b] = [reno(urlOf(srv)), tyler(urlOf(srv))];
  try {
    assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S09' }, a), true);
    assert.strictEqual(await heartbeat({ state: 'idle' }, b), true);

    const byReno = await peers(a);
    assert.deepStrictEqual(byReno.map((p) => [p.user, p.step, p.state]), [['Tyler', null, 'idle']]);
    const byTyler = await peers(b);
    assert.deepStrictEqual(byTyler.map((p) => [p.user, p.step, p.state]),
      [['Reno', 'P10-S09', 'running']]);

    // ...and that is what the light actually says.
    assert.deepStrictEqual(presenceLabel(byTyler, byTyler[0].ts),
      { state: 'peer', text: '● Reno · P10-S09 · 0s ago' });
  } finally { await close(srv); }
});

test('a peer that stops beating disappears after the expiry window', async () => {
  let now = 1_000_000;
  const srv = await listen(0, () => now);
  const [a, b] = [reno(urlOf(srv)), tyler(urlOf(srv))];
  try {
    await heartbeat({ state: 'running', step: 'P10-S09' }, a);
    await heartbeat({ state: 'idle' }, b);

    now += MAX_AGE_MS;                      // exactly 3 missed idle beats — Reno is still there
    assert.strictEqual((await peers(b)).length, 1);

    now += 1;                               // one ms past the window — Reno is gone, quietly
    assert.deepStrictEqual(await peers(b), []);
    assert.strictEqual(presenceLabel(await peers(b)).state, 'alone');
  } finally { await close(srv); }
});

test('the server dying mid-run goes unknown, never throws, and recovers when it returns', async () => {
  let srv = await listen();
  const port = srv.address().port;
  const [a, b] = [reno(urlOf(srv)), tyler(urlOf(srv))];
  await heartbeat({ state: 'running', step: 'P10-S09' }, a);
  assert.strictEqual((await peers(b)).length, 1);

  await close(srv);                         // the Pi goes away mid-run
  assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S09' }, a), null);
  const dark = await peers(b);
  assert.strictEqual(dark, null);
  assert.strictEqual(presenceLabel(dark).state, 'unknown');

  srv = await listen(port);                 // ...and comes back at the same address
  try {
    // A restart forgets everyone (D-046); the next beat re-populates without any client restart.
    assert.deepStrictEqual(await peers(b), []);
    assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S09' }, a), true);
    assert.deepStrictEqual((await peers(b)).map((p) => p.user), ['Reno']);
  } finally { await close(srv); }
});

test('the cadence loop makes the same round trip (the path extension.js actually drives)', async () => {
  const srv = await listen();
  const url = urlOf(srv);
  await heartbeat({ state: 'running', step: 'P10-S09' }, reno(url));
  let resolve;
  const seen = new Promise((r) => { resolve = r; });
  // Fake timers: update() ticks immediately (D-043), so nothing here waits on a real 60s interval.
  const loop = startPresence({
    ...tyler(url), setTimer: () => 1, clearTimer: () => {}, onPeers: resolve,
  });
  try {
    loop.update({ visible: true, state: 'idle' });
    assert.deepStrictEqual((await seen).map((p) => p.user), ['Reno']);
  } finally { loop.stop(); await close(srv); }
});
