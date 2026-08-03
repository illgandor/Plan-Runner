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

// A-P10-09: a peer stopped on a question used to read exactly like one mid-turn. Only the states
// that are NOT a live run are printed — "running" is the absence of a word here.
test('a peer that is waiting or paused says so; a running one does not', () => {
  const el = fakeEl();
  renderPresence(el, [{ user: 'Reno', step: 'P03-S10', state: 'waiting', ts: T0 - 120_000 }], T0);
  assert.match(el.textContent, /Reno · P03-S10 · waiting · 2m ago/);
  renderPresence(el, [{ user: 'Reno', step: 'P03-S10', state: 'paused', ts: T0 }], T0);
  assert.match(el.textContent, /Reno · P03-S10 · paused · 0s ago/);
});

// P20-S02 / D-090. An older server strips the two fields (doc 05 A1) and an unlaned driver never
// sends them, so ABSENT must read as unknown: the panel says nothing rather than asserting a claim
// nobody made. This is §3's three-valued discipline applied one level down.
test('a peer with no lane or claim renders exactly as before, asserting nothing about either', () => {
  const el = fakeEl();
  renderPresence(el, [{ user: 'Reno', step: 'P20-S02', state: 'running', ts: T0 - 120_000 }], T0);
  assert.strictEqual(el.textContent, '● Reno · P20-S02 · 2m ago');
  assert.doesNotMatch(el.textContent, /claim|holds|lane|unclaimed/i, 'silence, not "no claim"');
});

test('a claim prints when present; the lane prints only when it is not the name already shown', () => {
  const el = fakeEl();
  renderPresence(el, [{ user: 'Reno', lane: 'Reno', claim: 'P20-S03', step: 'P20-S03',
    state: 'running', ts: T0 }], T0);
  assert.strictEqual(el.textContent, '● Reno · P20-S03 · holds P20-S03 · 0s ago',
    'D-079 makes lane === user for our own client, so printing both would read "Reno · lane Reno"');
  renderPresence(el, [{ user: 'someone', lane: 'reno', claim: 'P20-S03', ts: T0 }], T0);
  assert.match(el.textContent, /someone · lane reno · holds P20-S03 · 0s ago/);
  // A claim held while nothing is running is exactly the state worth seeing — a step can also run
  // UNCLAIMED (the unreachable fail-open), so the two fields are never each other's proxy.
  renderPresence(el, [{ user: 'Reno', claim: 'P20-S04', state: 'idle', ts: T0 }], T0);
  assert.match(el.textContent, /Reno · idle · holds P20-S04 · 0s ago/);
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
