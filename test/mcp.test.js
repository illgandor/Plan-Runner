// P01-S09: MCP server list = ~/.claude.json mcpServers merged with last-init status.
// Stdlib-only (node:test); listServers is pure so no vscode/CLI is touched.
const test = require('node:test');
const assert = require('node:assert');
const { listServers } = require('../src/mcp');

test('merges config names with live status; unseen → unknown (Carryover)', () => {
  const cfg = JSON.stringify({ mcpServers: { railway: {}, github: {} } });
  const out = listServers(cfg, { railway: 'connected' });
  assert.deepStrictEqual(out, [
    { name: 'railway', status: 'connected' },
    { name: 'github', status: 'unknown' }, // configured but not yet seen in an init
  ]);
});

test('no config / bad JSON → empty list, never throws', () => {
  assert.deepStrictEqual(listServers(null), []);
  assert.deepStrictEqual(listServers('{ not json'), []);
  assert.deepStrictEqual(listServers('{}'), []);
});
