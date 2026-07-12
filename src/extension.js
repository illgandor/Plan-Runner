// Plan Runner extension entry — the VS Code shell that replaces Electron's main.js.
// Owns: the per-workspace on/off toggle (status bar), the chat webview, and the Runner.
// The heavy lifting (SDK session, step loop) lives in session.js / runner.js, untouched
// from their Electron origins except that they now talk to a webview, not a BrowserWindow.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const session = require('./session');
const { Runner } = require('./runner');
const { isMasterPlan, readPointer } = require('./progress');
const skills = require('./skills');
const updater = require('./updater');
const { UsageService } = require('./usage');

const MODELS = ['(default)', 'fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['(default)', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['auto', 'acceptEdits', 'plan', 'manual'];

let ctx = null;
let view = null;        // the live WebviewView (null until the panel is opened)
let runner = null;
let usage = null;       // account-wide UsageService (one poller for the extension)
let statusItem = null;
let state = { enabled: false, model: '(default)', effort: '(default)', mode: 'auto' };
let skillNote = null;   // one-line result of the on-activate skill install, shown in the panel

function workspaceDir() {
  const f = vscode.workspace.workspaceFolders;
  return f && f[0] ? f[0].uri.fsPath : null;
}
function project() {
  const dir = workspaceDir();
  if (!dir) return null;
  return { id: dir, path: dir, name: path.basename(dir), model: state.model, effort: state.effort, mode: state.mode };
}
function post(msg) { if (view) view.webview.postMessage(msg); }
// §Config keys — application-scoped, read the same in every window (D-004).
function usageConfig() {
  const c = vscode.workspace.getConfiguration('planRunner');
  return { threshold: c.get('pauseThresholdPct', 90), pollSec: c.get('usagePollSeconds', 60) };
}
// Frozen §Webview⇄host shape. `paused` reflects the Runner holding on the usage gate (S08).
function postUsage(s) { post({ kind: 'usage', session: s.session, week: s.week, max: s.max, threshold: s.threshold, paused: !!(runner && runner.paused), error: s.error }); }

function updateStatusBar() {
  statusItem.text = `$(${state.enabled ? 'play-circle' : 'circle-slash'}) Plan Runner: ${state.enabled ? 'On' : 'Off'}`;
  statusItem.tooltip = 'Toggle Plan Runner auto-run for this workspace';
  statusItem.show();
}

function setEnabled(v) {
  state.enabled = v;
  ctx.workspaceState.update('planRunner.enabled', v);
  updateStatusBar();
  post({ kind: 'enabled', value: v });
  if (!v && runner) runner.stop();
}

function ensureRunner() {
  if (runner) { runner.project = project(); return runner; } // pick up model/mode edits
  const p = project();
  if (!p) return null;
  runner = new Runner(p);
  runner.usageGate = usage; // S08: crossing the threshold pauses/resumes the loop
  runner.on('status', (s) => post({ kind: 'status', ...s }));
  runner.on('step-started', (s) => post({ kind: 'step-started', ...s }));
  runner.on('step-done', (d) => post({ kind: 'step-done', ...d }));
  runner.on('done', (d) => post({ kind: 'done', ...d }));
  runner.on('paused', (d) => { post({ kind: 'paused', reason: d.reason }); postUsage(usage.snapshot()); });
  runner.on('resumed', () => { post({ kind: 'resumed' }); postUsage(usage.snapshot()); });
  return runner;
}

// ---- Webview message handling ----
async function onMessage(m) {
  const p = project();
  switch (m.type) {
    case 'ready':
      post({ kind: 'config', enabled: state.enabled, model: state.model, effort: state.effort, mode: state.mode,
        models: MODELS, efforts: EFFORTS, modes: MODES });
      if (usage) postUsage(usage.snapshot()); // paint whatever's been read so far
      if (skillNote) post({ kind: 'info', text: skillNote });
      post({ kind: 'info', text: p ? `Workspace: ${p.name} — NEXT: ${readPointer(p.path) || '(none)'}` : 'Open a master-plan project folder to begin.' });
      break;
    case 'start': {
      if (!p) { const msg = 'Open a project folder first.'; post({ kind: 'info', text: msg }); vscode.window.showWarningMessage(msg); break; }
      if (!isMasterPlan(p.path)) {
        const msg = `No PROGRESS.md in ${p.name} — not a master-plan project. Run the master-plan skill here first.`;
        post({ kind: 'info', text: msg }); vscode.window.showWarningMessage(msg); break;
      }
      if (!state.enabled) {
        const pick = await vscode.window.showWarningMessage('Plan Runner is Off for this workspace.', 'Turn On & Start');
        if (pick !== 'Turn On & Start') { post({ kind: 'info', text: 'Toggle Plan Runner On (status bar, bottom-left) to start.' }); break; }
        setEnabled(true);
      }
      post({ kind: 'info', text: `Starting — NEXT: ${readPointer(p.path)}` });
      ensureRunner()?.start();
      break;
    }
    case 'stop':
      runner?.stop();
      break;
    case 'send':
      if (!p) return;
      if (runner && runner.running) runner.answer(m.text);        // continues the live step
      else session.chat({ id: p.id, cwd: p.path, prompt: m.text,   // plain chat when not auto-running
        options: { model: state.model, effort: state.effort, permissionMode: state.mode } });
      break;
    case 'interrupt':
      if (p) session.interrupt(p.id);
      break;
    case 'permission':
      session.resolvePermission({ requestId: m.requestId, decision: m.decision });
      break;
    case 'setModel':
      state.model = MODELS.includes(m.value) ? m.value : '(default)';
      ctx.workspaceState.update('planRunner.model', state.model);
      break;
    case 'setEffort':
      state.effort = EFFORTS.includes(m.value) ? m.value : '(default)';
      ctx.workspaceState.update('planRunner.effort', state.effort);
      break;
    case 'setMode':
      state.mode = MODES.includes(m.value) ? m.value : 'auto';
      ctx.workspaceState.update('planRunner.mode', state.mode);
      break;
    case 'setThreshold': {
      // Write global config; onDidChangeConfiguration re-applies it here and in every window.
      const v = Math.max(10, Math.min(100, Math.round(Number(m.value))));
      if (Number.isFinite(v))
        vscode.workspace.getConfiguration('planRunner').update('pauseThresholdPct', v, vscode.ConfigurationTarget.Global);
      break;
    }
    case 'attach': {
      // "Upload from computer": pick file(s); we hand Claude the path(s) as an @-reference
      // in the prompt — the agent Reads them with its filesystem tools (no upload needed
      // since the SDK runs locally with your files). Images work the same via Read.
      const picks = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach to prompt' });
      if (picks && picks.length) post({ kind: 'attached', paths: picks.map((u) => u.fsPath) });
      break;
    }
    case 'openMcpConfig': {
      // MCP servers are loaded from the user's ~/.claude config via settingSources (the
      // same ones the official CLI uses). Open that config so you can add/remove servers;
      // they connect on the next session start.
      const cfg = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(cfg)) vscode.window.showTextDocument(vscode.Uri.file(cfg));
      else vscode.window.showInformationMessage('Configure MCP servers with the `claude mcp` CLI (~/.claude.json not found yet).');
      break;
    }
  }
}

// ---- Webview view provider ----
class ChatViewProvider {
  resolveWebviewView(v) {
    view = v;
    v.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'src', 'webview')],
    };
    v.webview.html = html(v.webview);
    session.setSink((evt) => post(evt)); // SDK messages → panel
    v.webview.onDidReceiveMessage(onMessage);
  }
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'src', 'webview', f));
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!doctype html><html><head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="${uri('chat.css')}">
  </head><body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${uri('chat.js')}"></script>
  </body></html>`;
}

// Install the skills the loop depends on (master-plan + next-step) into ~/.claude/skills
// if they're missing — same as the standalone app did. Never clobbers a customized copy.
// Returns a one-line note only when something was actually installed (else stays quiet).
function installSkills(force) {
  try {
    const results = skills.install({ force });
    const changed = results.filter((r) => r.action === 'installed' || r.action === 'updated');
    return changed.length ? `Skills ${force ? 'updated' : 'installed'}: ${changed.map((r) => r.name).join(', ')}` : null;
  } catch (e) {
    return `Could not install skills: ${String((e && e.message) || e)}`;
  }
}

function activate(context) {
  ctx = context;
  state.enabled = !!context.workspaceState.get('planRunner.enabled');
  state.model = context.workspaceState.get('planRunner.model') || '(default)';
  state.effort = context.workspaceState.get('planRunner.effort') || '(default)';
  state.mode = context.workspaceState.get('planRunner.mode') || 'auto';
  skillNote = installSkills(false); // install-if-missing on every activation
  updater.start(context);           // poll GitHub Releases for a newer .vsix (D-003)

  // Account-wide usage poller, seeded from application-scoped §Config (D-004).
  usage = new UsageService(usageConfig());
  usage.on('update', (s) => { if (runner) runner.onUsageUpdate(); postUsage(s); }); // S08: gate the loop, then repaint
  usage.start();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'planRunner.toggle';
  updateStatusBar();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('planRunner.toggle', () => setEnabled(!state.enabled)),
    vscode.commands.registerCommand('planRunner.start', () => onMessage({ type: 'start' })),
    vscode.commands.registerCommand('planRunner.stop', () => onMessage({ type: 'stop' })),
    vscode.commands.registerCommand('planRunner.installSkills', () => {
      const note = installSkills(true) || 'Skills already up to date.';
      vscode.window.showInformationMessage(note); post({ kind: 'info', text: note });
    }),
    vscode.window.registerWebviewViewProvider('planRunner.chat', new ChatViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }),
    // Config is application-scoped: a write in ANY window fires this in EVERY window.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('planRunner.pauseThresholdPct') || e.affectsConfiguration('planRunner.usagePollSeconds'))
        usage.setConfig(usageConfig()); // re-applies + emits 'update' → postUsage repaints
    }),
  );
}

function deactivate() { runner?.stop(); usage?.stop(); }

module.exports = { activate, deactivate };
