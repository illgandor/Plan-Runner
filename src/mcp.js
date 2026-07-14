// Engine-aware MCP server management. The webview renders an in-composer popover (P02-S07);
// this module just supplies the active engine's server list and runs the interactive CLI in
// a terminal for add/remove/auth (there is no SDK OAuth flow — auth is interactive).
//   Claude: ~/.claude.json mcpServers merged with last-init status (S09 logic, preserved).
//   Codex:  ~/.codex/config.toml [mcp_servers.<name>] tables — no live status (subprocess, no
//           SDK init), so Codex servers read 'unknown'. Reading the config mirrors the Claude
//           path and stays unit-testable, vs parsing `codex mcp list` table output (A-P02-02).
// vscode is required lazily so the pure list functions can be unit-tested under `node --test`.
const vscode = () => require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { findCodex } = require('./codex-path');

const claudeConfigPath = () => path.join(os.homedir(), '.claude.json');
const codexConfigPath = () => path.join(os.homedir(), '.codex', 'config.toml');

// Pure, testable: merge configured servers (~/.claude.json mcpServers) with last-init
// statuses. Status is fresh only after a session init — unseen servers read 'unknown',
// never 'failed', so a pre-run panel doesn't cry wolf (S09 Carryover).
function listServers(configText, statusByName = {}) {
  let servers = {};
  try { servers = (JSON.parse(configText || '{}').mcpServers) || {}; } catch { servers = {}; }
  return Object.keys(servers).map((name) => ({ name, status: statusByName[name] || 'unknown' }));
}

// Pure, testable: Codex servers are [mcp_servers.<name>] tables in ~/.codex/config.toml.
// No live init status for Codex → always 'unknown'. Handles bare and quoted table keys.
function listCodexServers(tomlText) {
  const re = /^\s*\[mcp_servers\.([^\]]+)\]/gm;
  const out = [];
  let m;
  while ((m = re.exec(tomlText || ''))) {
    let name = m[1].trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    out.push({ name, status: 'unknown' });
  }
  return out;
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// The active engine's server list for the popover.
function servers(engine, statusByName = {}) {
  if (engine === 'codex') return listCodexServers(readText(codexConfigPath()));
  return listServers(readText(claudeConfigPath()), statusByName);
}

// OAuth and confirmation prompts are interactive — a terminal is the only honest home.
// Codex isn't on PATH, so we invoke its resolved binary; Claude is on PATH.
function runCli(engine, args) {
  if (engine === 'codex') {
    const exe = findCodex();
    if (!exe) { vscode().window.showInformationMessage('Codex CLI not found — install it and run `codex login`, then try again.'); return; }
    const term = vscode().window.createTerminal('codex mcp');
    term.show(); term.sendText(`"${exe}" mcp ${args}`);
    return;
  }
  const term = vscode().window.createTerminal('claude mcp');
  term.show(); term.sendText('claude mcp ' + args);
}

// Open the active engine's MCP config file (or say it doesn't exist yet).
function openConfig(engine) {
  const p = engine === 'codex' ? codexConfigPath() : claudeConfigPath();
  if (readText(p) == null) vscode().window.showInformationMessage(`No ${path.basename(p)} yet — Add a server first.`);
  else vscode().window.showTextDocument(vscode().Uri.file(p));
}

module.exports = { listServers, listCodexServers, servers, runCli, openConfig };
