// P10-S06: the presence light. presence-view.js is a browser IIFE (like markdown.js), so we give it
// a window, require it, and drive the two exported functions. The element it writes into is faked as
// an object whose innerHTML setter THROWS — that is the D-015 proof: a peer name is remote input and
// may only ever reach the DOM as text. Stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

global.window = {};
require('../src/webview/presence-view.js');
const { presenceLabel, renderPresence } = global.window;

function fakeEl() {
  return {
    className: '', textContent: '',
    set innerHTML(v) { throw new Error('presence wrote HTML: ' + v); },
  };
}
const T0 = 1_800_000_000_000; // fixed "now" — these assertions must not depend on the wall clock

test('unreachable server -> the unknown state, no peer text', () => {
  const el = fakeEl();
  renderPresence(el, null, T0);
  assert.strictEqual(el.className, 'presence unknown');
  assert.match(el.textContent, /unavailable/);
});

test('nobody else -> the alone state ([] is presence, not a failure)', () => {
  const el = fakeEl();
  renderPresence(el, [], T0);
  assert.strictEqual(el.className, 'presence alone');
  assert.match(el.textContent, /only you/);
});

test('a peer renders as name · step · relative time', () => {
  const el = fakeEl();
  renderPresence(el, [{ user: 'Reno', step: 'P01-S07', state: 'running', ts: T0 - 120_000 }], T0);
  assert.strictEqual(el.className, 'presence peer');
  assert.match(el.textContent, /Reno · P01-S07 · 2m ago/);
});

test('relative time buckets: seconds, minutes, hours', () => {
  const at = (ms) => presenceLabel([{ user: 'a', ts: T0 - ms }], T0).text;
  assert.match(at(30_000), /30s ago/);
  assert.match(at(120_000), /2m ago/);
  assert.match(at(7_200_000), /2h ago/);
  assert.match(at(-5_000), /0s ago/, 'a clock-skewed future ts never renders negative');
});

test('two peers both show; a missing step or ts is dropped, not printed as undefined', () => {
  const { text } = presenceLabel([{ user: 'Reno', ts: T0 - 60_000 }, { step: 'P02-S01', ts: 0 }], T0);
  assert.match(text, /Reno · 1m ago, someone · P02-S01/);
  assert.doesNotMatch(text, /undefined|null|NaN/);
});

test('a peer name containing markup renders as literal text, never as HTML', () => {
  const el = fakeEl();
  const evil = '<img src=x onerror="alert(1)">';
  assert.doesNotThrow(() => renderPresence(el, [{ user: evil, step: 'P01-S01', ts: T0 }], T0));
  assert.ok(el.textContent.includes(evil), 'the markup survives verbatim as text');
});

// Criterion 1 of the step, locked at the source: with presence unconfigured the host sends no
// {kind:'presence'} message (D-039), and the element is created ONLY when one arrives — so an
// unconfigured panel has no presence element in the DOM at all.
test('chat.js has no presence element in its static layout; it is created on the first message', () => {
  const src = fs.readFileSync(require.resolve('../src/webview/chat.js'), 'utf8');
  const layout = src.slice(src.indexOf('app.innerHTML'), src.indexOf('const $ = (id)'));
  assert.doesNotMatch(layout, /presence/i, 'the presence element must not ship in the static layout');
  assert.match(src, /case 'presence': renderPresence\(presenceSlot\(\)/);
  assert.match(src, /if \(!presenceEl\) \{ presenceEl = document\.createElement/);
});
