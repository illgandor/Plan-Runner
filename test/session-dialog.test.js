// P06-S07: AskUserQuestion → multiple-choice buttons. The CLI surfaces the question as a
// `request_user_dialog` of kind 'permission_ask_user_question'; onUserDialog renders the options
// and answers with a PermissionResult carrying the picks. Stdlib-only, no Claude usage.
const test = require('node:test');
const assert = require('node:assert');
const session = require('../src/session');

test('sdkOptions declares the AskUserQuestion dialog kind', () => {
  assert.deepStrictEqual(session.sdkOptions('/cwd', {}).supportedDialogKinds, ['permission_ask_user_question']);
});

test('onUserDialog: answer → allow+answers; skip → cancelled; unknown kind → cancelled', async () => {
  const events = [];
  session.setSink((e) => events.push(e));
  let dialogFn;
  session.setQuery((args) => { dialogFn = args.options.onUserDialog; return (async function* () {})(); });
  await new Promise((done) => session.start({ id: 'd1', cwd: '/c', prompt: 'go', options: {} }, { onDone: done }));
  assert.ok(typeof dialogFn === 'function', 'onUserDialog wired into query options');

  // Unrecognized dialog kind must be cancelled (protocol requirement) — no panel prompt emitted.
  assert.deepStrictEqual(await dialogFn({ dialogKind: 'something_else', payload: {} }), { behavior: 'cancelled' });

  const input = { questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const req = { dialogKind: 'permission_ask_user_question',
    payload: { input, questions: input.questions } };

  // Answer path: the option label maps back as answers[question] and the tool is allowed.
  const pending = dialogFn(req);
  const evt = events.find((e) => e.channel === 'session:dialog-request');
  assert.ok(evt, 'a dialog-request reached the panel');
  assert.deepStrictEqual(evt.payload.questions, input.questions, 'questions forwarded verbatim');
  session.resolveDialog({ requestId: evt.payload.requestId, answers: { 'Pick one?': 'A' } });
  assert.deepStrictEqual(await pending, {
    behavior: 'completed',
    result: { behavior: 'allow', updatedInput: { questions: input.questions, answers: { 'Pick one?': 'A' } } },
  });

  // Skip path → cancelled (the CLI records it as skipped and moves on).
  const pending2 = dialogFn(req);
  const evt2 = events.filter((e) => e.channel === 'session:dialog-request').pop();
  session.resolveDialog({ requestId: evt2.payload.requestId, cancelled: true });
  assert.deepStrictEqual(await pending2, { behavior: 'cancelled' });

  session.setSink(null);
});
