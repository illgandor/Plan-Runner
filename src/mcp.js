// Real MCP server management — replaces the old "just open the JSON" button. Lists the
// servers from ~/.claude.json merged with live connection status from the last session
// init, then runs the interactive `claude mcp` CLI in a terminal for add/remove/auth
// (there is no SDK OAuth flow — auth is interactive, so it belongs in a terminal).
// vscode is required lazily (inside the UI helpers) so the pure listServers() can be
// unit-tested under `node --test`, where the 'vscode' module doesn't resolve.
const vscode = () => require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const configPath = () => path.join(os.homedir(), '.claude.json');

// Pure, testable: merge configured servers (~/.claude.json mcpServers) with last-init
// statuses. Status is fresh only after a session init — unseen servers read 'unknown',
// never 'failed', so a pre-run panel doesn't cry wolf (S09 Carryover).
function listServers(configText, statusByName = {}) {
  let servers = {};
  try { servers = (JSON.parse(configText || '{}').mcpServers) || {}; } catch { servers = {}; }
  return Object.keys(servers).map((name) => ({ name, status: statusByName[name] || 'unknown' }));
}

function readConfigText() {
  try { return fs.readFileSync(configPath(), 'utf8'); } catch { return null; }
}

// OAuth and confirmation prompts are interactive — a terminal is the only honest home.
function runCli(args) {
  const term = vscode().window.createTerminal('claude mcp');
  term.show();
  term.sendText('claude mcp ' + args);
}

async function manageServer(name) {
  const pick = await vscode().window.showQuickPick([
    { label: '$(plug) Authenticate / show status', action: 'get' },
    { label: '$(trash) Remove', action: 'remove' },
  ], { placeHolder: `MCP server: ${name}` });
  if (!pick) return;
  runCli(`${pick.action} ${name}`);
}

// The MCP button entry point. statusByName = session.mcpStatus(projectId); reconnect
// restarts the live session so a re-auth/config change is picked up on the next init.
async function openMcp({ statusByName = {}, reconnect } = {}) {
  const text = readConfigText();
  const servers = listServers(text, statusByName);
  const items = servers.map((s) => ({ label: s.name, description: s.status, server: s.name }));
  const actions = [
    { label: '$(add) Add server…', action: 'add' },
    { label: '$(sync) Reconnect (restart session)', action: 'reconnect' },
    { label: '$(json) Open ~/.claude.json', action: 'open' },
  ];
  const pick = await vscode().window.showQuickPick([...items, ...actions], {
    placeHolder: servers.length ? 'MCP servers — pick one to manage, or an action' : 'No MCP servers yet — Add one',
  });
  if (!pick) return;
  if (pick.server) return manageServer(pick.server);
  if (pick.action === 'add') return runCli('add');
  if (pick.action === 'reconnect') return reconnect && reconnect();
  // open config
  if (text == null) vscode().window.showInformationMessage('No ~/.claude.json yet — Add a server first.');
  else vscode().window.showTextDocument(vscode().Uri.file(configPath()));
}

module.exports = { openMcp, listServers };
