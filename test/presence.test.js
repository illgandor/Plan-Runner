// The presence client cannot throw or hang into its caller (P10-S04, CONTRACTS §Presence, D-038/39).
// Every case here is a failure mode the run must survive: 401, a hung server, a refused port — all
// resolve to null, none reject. The unconfigured case must not open a socket at all.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { heartbeat, peers, displayName, TIMEOUT_MS } = require('../src/presence');

// projectId + `git config user.name` both go through exec; stub it so tests never depend on git.
const exec = (_cmd, args) =>
  (args[0] === 'config' ? 'Tyler\n' : 'git@github.com:illgandor/Plan-Runner.git\n');
const opts = (url, extra = {}) => ({
  settings: { url, token: 'sekret', name: '' }, cwd: '.', exec, timeoutMs: 200, ...extra,
});

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((res) =>
    server.listen(0, '127.0.0.1', () =>
      res({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('happy path: heartbeat posts the contract body and peers filters us out', async () => {
  let seen = null;
  const { server, url } = await serve((rq, rs) => {
    if (rq.url === '/heartbeat') {
      let body = '';
      rq.on('data', (c) => { body += c; });
      rq.on('end', () => { seen = { auth: rq.headers.authorization, body: JSON.parse(body) }; rs.writeHead(204).end(); });
      return;
    }
    rs.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ peers: [{ user: 'Tyler', state: 'idle' }, { user: 'Reno', step: 'P10-S05', state: 'running' }] }));
  });
  try {
    assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S04' }, opts(url)), true);
    assert.strictEqual(seen.auth, 'Bearer sekret');
    assert.strictEqual(seen.body.project, 'github.com/illgandor/plan-runner');
    assert.strictEqual(seen.body.user, 'Tyler', 'name falls back to git config user.name');
    assert.deepStrictEqual([seen.body.state, seen.body.step], ['running', 'P10-S04']);
    assert.strictEqual(typeof seen.body.ts, 'number');

    assert.deepStrictEqual(await peers(opts(url)), [{ user: 'Reno', step: 'P10-S05', state: 'running' }],
      'the caller filters ITSELF out by user');
  } finally { server.close(); }
});

test('401 resolves to null, never a rejection', async () => {
  const { server, url } = await serve((_rq, rs) => rs.writeHead(401).end());
  try {
    assert.strictEqual(await heartbeat({ state: 'idle' }, opts(url)), null);
    assert.strictEqual(await peers(opts(url)), null);
  } finally { server.close(); }
});

test('a server that never replies trips the timeout instead of hanging', async () => {
  const sockets = [];
  const { server, url } = await serve(() => { /* deliberately no response, ever */ });
  server.on('connection', (s) => sockets.push(s));
  try {
    const t0 = Date.now();
    assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S04' }, opts(url)), null);
    assert.strictEqual(await peers(opts(url)), null);
    assert.ok(Date.now() - t0 < 10000, 'both timed out well under 10s');
  } finally { sockets.forEach((s) => s.destroy()); server.close(); }
});

test('a refused port resolves to null', async () => {
  const { server, url } = await serve(() => {});
  await new Promise((res) => server.close(res)); // free the port, then aim at it
  assert.strictEqual(await heartbeat({ state: 'idle' }, opts(url)), null);
  assert.strictEqual(await peers(opts(url)), null);
});

// D-039: dark unless configured. If this regresses, presence starts talking to a server nobody set.
test('unconfigured opens no socket at all', async () => {
  const boom = () => { throw new Error('fetch must not be called when presence is unconfigured'); };
  for (const settings of [undefined, {}, { url: 'http://pi:8787' }, { token: 'abc' }]) {
    assert.strictEqual(await heartbeat({ state: 'idle' }, { settings, cwd: '.', exec, fetch: boom }), null);
    assert.strictEqual(await peers({ settings, cwd: '.', exec, fetch: boom }), null);
  }
});

test('configured but no git remote also stays dark', async () => {
  const boom = () => { throw new Error('fetch must not be called without a project identity'); };
  const noRemote = () => { throw new Error('fatal: No such remote'); };
  const cfg = { settings: { url: 'http://pi:8787', token: 'abc' }, cwd: '.', exec: noRemote, fetch: boom };
  assert.strictEqual(await heartbeat({ state: 'running', step: 'P10-S04' }, cfg), null);
  assert.strictEqual(await peers(cfg), null);
});

test('a 200 with garbage instead of {peers:[...]} is null, not a throw', async () => {
  const { server, url } = await serve((_rq, rs) =>
    rs.writeHead(200, { 'content-type': 'application/json' }).end('not json at all'));
  try { assert.strictEqual(await peers(opts(url)), null); } finally { server.close(); }
});

test('the display name follows the §Presence precedence and the timeout obeys the contract', () => {
  assert.strictEqual(displayName('Tyler', '.', exec), 'Tyler', 'the setting wins');
  assert.strictEqual(displayName('', '.', exec), 'Tyler', 'else git config user.name');
  assert.strictEqual(displayName('', '.', () => '  \n'), 'someone', 'else "someone"');
  assert.strictEqual(displayName('', '.', () => { throw new Error('no git'); }), 'someone');
  assert.ok(TIMEOUT_MS <= 5000, '§Presence caps every request at 5s');
});
