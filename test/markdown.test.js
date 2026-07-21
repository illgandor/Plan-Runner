// Unit check for the webview markdown->DOM renderer (P04-S01, D-015). markdown.js is a browser
// IIFE (no exports), so we stub a tiny DOM, require it (runs the IIFE → window.renderMarkdown),
// and serialize the built tree. Proves the parser (fenced code, headings, lists, bold/em/code/links)
// AND that output is whitelist-safe by construction. Stdlib only, spends no usage.
const test = require('node:test');
const assert = require('node:assert');

// --- minimal DOM the renderer uses: createDocumentFragment/createElement/createTextNode ---
function el(tag) {
  return {
    tag, nodeType: 1, childNodes: [], _text: null,
    appendChild(c) { this.childNodes.push(c); return c; },
    insertBefore(c, ref) { const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); },
    set textContent(v) { this._text = v; this.childNodes = []; },
    get textContent() { return this._text != null ? this._text : this.childNodes.map((c) => c.textContent).join(''); },
  };
}
global.window = {};
global.document = {
  createDocumentFragment: () => el('#frag'),
  createElement: (t) => el(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
};
require('../src/webview/markdown.js');
const render = global.window.renderMarkdown;

// Serialize a node tree to compact HTML-ish text for assertions.
function ser(n) {
  if (n.nodeType === 3) return n.textContent;
  const inner = n._text != null ? n._text : n.childNodes.map(ser).join('');
  return n.tag === '#frag' ? inner : `<${n.tag}${n.href ? ` href=${n.href}` : ''}>${inner}</${n.tag}>`;
}
const md = (s) => ser(render(s));

test('inline: bold, em, inline code render as markup, not literal chars', () => {
  assert.strictEqual(md('**bold** and `code` and *it*'),
    '<p><strong>bold</strong> and <code>code</code> and <em>it</em></p>');
});

test('fenced code renders <pre><code> with content verbatim', () => {
  assert.strictEqual(md('```\nx = 1\ny = 2\n```'), '<pre><code>x = 1\ny = 2</code></pre>');
});

test('headings #..#### map to h1..h4', () => {
  assert.strictEqual(md('# H1'), '<h1>H1</h1>');
  assert.strictEqual(md('#### H4'), '<h4>H4</h4>');
});

test('unordered and ordered lists group into ul/ol with li', () => {
  assert.strictEqual(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('links keep safe schemes and drop javascript: (whitelist)', () => {
  assert.strictEqual(md('[ok](https://x.com)'), '<p><a href=https://x.com>ok</a></p>');
  assert.strictEqual(md('[no](javascript:alert)'), '<p><a>no</a></p>'); // href dropped, text kept
});

test('inside inline code, ** stays literal (code wins precedence)', () => {
  assert.strictEqual(md('`**x**`'), '<p><code>**x**</code></p>');
});

test('GFM table renders thead/tbody with cells; inline markup works in cells', () => {
  assert.strictEqual(md('| A | B |\n| --- | --- |\n| 1 | `x` |'),
    '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td>1</td><td><code>x</code></td></tr></tbody></table>');
});

test('a lone pipe line with no --- separator stays a paragraph', () => {
  assert.strictEqual(md('a | b'), '<p>a | b</p>');
});

test('a header row over a plain --- rule (no pipe) is not a table', () => {
  assert.ok(!md('| h |\n---').includes('<table>'));
});
