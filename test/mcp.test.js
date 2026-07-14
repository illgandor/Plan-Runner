// P01-S09: MCP server list = ~/.claude.json mcpServers merged with last-init status.
// Stdlib-only (node:test); listServers is pure so no vscode/CLI is touched.
const test = require('node:test');
const assert = require('node:assert');
const { listServers, listCodexServers } = require('../src/mcp');

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

// P02-S07: Codex servers are [mcp_servers.<name>] tables in ~/.codex/config.toml; no live
// init status (subprocess, no SDK) → always 'unknown'. Bare and quoted table keys both parse.
test('listCodexServers parses [mcp_servers.<name>] tables (bare + quoted)', () => {
  const toml = [
    'model = "gpt-5"',
    '[mcp_servers.railway]',
    'command = "railway-mcp"',
    '[mcp_servers."with.dots"]',
    'command = "x"',
  ].join('\n');
  assert.deepStrictEqual(listCodexServers(toml), [
    { name: 'railway', status: 'unknown' },
    { name: 'with.dots', status: 'unknown' },
  ]);
});

test('listCodexServers: no config / no servers → empty list, never throws', () => {
  assert.deepStrictEqual(listCodexServers(null), []);
  assert.deepStrictEqual(listCodexServers('model = "gpt-5"'), []);
});
