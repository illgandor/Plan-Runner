// AskUserQuestion → multiple-choice card. In this SDK it's a normal built-in tool delivered via
// canUseTool (there is NO `request_user_dialog` for it) — we answer by injecting the picks as
// updatedInput.answers and render the card through the panel's dialog path. The old onUserDialog /
// 'permission_ask_user_question' wiring targeted a dialog kind this SDK never emits, so the
// question fell through to a raw Allow/Deny card and returned "no answer" (P09-S18). Stdlib-only.
const test = require('node:test');
const assert = require('node:assert');
const session = require('../src/session');

test('the dead dialog wiring is gone (no supportedDialogKinds / onUserDialog)', () => {
  const o = session.sdkOptions('/cwd', {});
  assert.strictEqual(o.supportedDialogKinds, undefined, 'no dead dialog-kind declaration');
  assert.strictEqual(o.onUserDialog, undefined, 'no onUserDialog wired into query options');
});

test('canUseTool answers AskUserQuestion: choice card (not Allow/Deny); answer → allow+answers; skip → allow, no answers', async () => {
  const events = [];
  session.setSink((e) => events.push(e));
  let canUseTool;
  session.setQuery((args) => {
    canUseTool = args.options.canUseTool;
    return (async function* () { await new Promise(() => {}); })(); // stays live
  });
  session.start({ id: 'd1', cwd: '/c', prompt: 'go', options: {} });
  await new Promise((r) => setImmediate(r)); // let the async IIFE wire canUseTool
  assert.ok(typeof canUseTool === 'function', 'canUseTool wired');

  const input = { questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] };

  // Answer path: it renders a DIALOG card (not a permission card) and the picks come back as answers.
  const pending = canUseTool('AskUserQuestion', input);
  const evt = events.find((e) => e.channel === 'session:dialog-request');
  assert.ok(evt, 'AskUserQuestion reached the panel as a dialog card');
  assert.strictEqual(events.filter((e) => e.channel === 'session:permission-request').length, 0,
    'no raw Allow/Deny card for a question');
  assert.deepStrictEqual(evt.payload.questions, input.questions, 'questions forwarded verbatim');
  session.resolveDialog({ requestId: evt.payload.requestId, answers: { 'Pick one?': 'A' } });
  assert.deepStrictEqual(await pending,
    { behavior: 'allow', updatedInput: { ...input, answers: { 'Pick one?': 'A' } } });

  // Skip path → allow with NO answers (the model moves on; a question is never denied).
  const pending2 = canUseTool('AskUserQuestion', input);
  const evt2 = events.filter((e) => e.channel === 'session:dialog-request').pop();
  session.resolveDialog({ requestId: evt2.payload.requestId, cancelled: true });
  assert.deepStrictEqual(await pending2, { behavior: 'allow', updatedInput: input });

  session.stop('d1');
  session.setSink(null);
});

// P09-S02: teardown must deactivate any pending cards — denyPendingFor/cancelDialogsFor emit one
// `session:request-cancelled` per resolved entry so the panel can flip its matching card to history.
test('stop() emits one request-cancelled per pending permission + dialog', async () => {
  const events = [];
  session.setSink((e) => events.push(e));
  let canUseTool;
  session.setQuery((args) => {
    canUseTool = args.options.canUseTool;
    return (async function* () { await new Promise(() => {}); })(); // stays live until stop()
  });
  session.start({ id: 'c1', cwd: '/c', prompt: 'go', options: {} });
  await new Promise((r) => setImmediate(r)); // let the async IIFE reach query() and wire the callback
  assert.ok(typeof canUseTool === 'function', 'canUseTool wired');

  const permP = canUseTool('Bash', { command: 'gh pr view' });
  const q = { questions: [{ question: 'q?', options: [{ label: 'A' }] }] };
  const dlgP = canUseTool('AskUserQuestion', q);
  const permReq = events.find((e) => e.channel === 'session:permission-request');
  const dlgReq = events.find((e) => e.channel === 'session:dialog-request');
  assert.ok(permReq && dlgReq, 'both requests reached the panel');

  session.stop('c1');

  const cancelled = events.filter((e) => e.channel === 'session:request-cancelled').map((e) => e.payload.requestId);
  assert.deepStrictEqual(cancelled.sort(), [dlgReq.payload.requestId, permReq.payload.requestId].sort(),
    'exactly one cancelled event per pending card');
  assert.deepStrictEqual(await permP, { behavior: 'deny', message: 'Session stopped.' }); // resolved, no hang
  assert.deepStrictEqual(await dlgP, { behavior: 'allow', updatedInput: q }); // torn down → allow, no answers

  session.setSink(null);
});
