// P09-S10: "Allow always" (D-029) — session-scoped, in-memory only. After allow-always, the same
// tool (Bash: same first command word) auto-allows with no card; a different tool/word still asks.
// Stdlib-only, no Claude usage; drives the real makeCanUseTool wired through start()/setQuery.
const test = require('node:test');
const assert = require('node:assert');
const session = require('../src/session');

test('allow-always auto-allows the same tool/command-word; others still prompt', async () => {
  const events = [];
  session.setSink((e) => events.push(e));
  let canUseTool;
  session.setQuery((args) => {
    canUseTool = args.options.canUseTool;
    return (async function* () { await new Promise(() => {}); })(); // stays live
  });
  session.start({ id: 'p1', cwd: '/c', prompt: 'go', options: {} });
  await new Promise((r) => setImmediate(r)); // let the async IIFE wire canUseTool
  assert.ok(typeof canUseTool === 'function', 'canUseTool wired');

  const reqCount = () => events.filter((e) => e.channel === 'session:permission-request').length;

  // First `gh pr view` prompts; answer allow-always.
  const p1 = canUseTool('Bash', { command: 'gh pr view 12' });
  assert.strictEqual(reqCount(), 1, 'first gh command reaches the panel');
  const req1 = events.filter((e) => e.channel === 'session:permission-request').pop();
  session.resolvePermission({ requestId: req1.payload.requestId, decision: 'allow-always' });
  assert.deepStrictEqual(await p1, { behavior: 'allow', updatedInput: { command: 'gh pr view 12' } });

  // A different `gh` invocation now auto-allows — never reaches the sink.
  const p2 = canUseTool('Bash', { command: 'gh issue list' });
  assert.strictEqual(reqCount(), 1, 'remembered gh word does not post a new card');
  assert.deepStrictEqual(await p2, { behavior: 'allow', updatedInput: { command: 'gh issue list' } });

  // A different command word still asks.
  const p3 = canUseTool('Bash', { command: 'rm -rf /' });
  assert.strictEqual(reqCount(), 2, 'a different command word still prompts');
  const req3 = events.filter((e) => e.channel === 'session:permission-request').pop();
  session.resolvePermission({ requestId: req3.payload.requestId, decision: 'deny' });
  assert.deepStrictEqual(await p3, { behavior: 'deny', message: 'Denied by the user.' });

  // A different tool still asks.
  const p4 = canUseTool('WebFetch', { url: 'https://x' });
  assert.strictEqual(reqCount(), 3, 'a different tool still prompts');
  const req4 = events.filter((e) => e.channel === 'session:permission-request').pop();
  session.resolvePermission({ requestId: req4.payload.requestId, decision: 'allow' });
  assert.deepStrictEqual(await p4, { behavior: 'allow', updatedInput: { url: 'https://x' } });

  session.stop('p1');
  session.setSink(null);
});
