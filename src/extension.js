// Plan Runner extension entry — the VS Code shell that replaces Electron's main.js.
// Owns: the per-workspace on/off toggle (status bar), the chat webview, and the Runner.
// The heavy lifting (SDK session, step loop) lives in session.js / runner.js, untouched
// from their Electron origins except that they now talk to a webview, not a BrowserWindow.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const session = require('./session');
const engine = require('./engine');
const mcp = require('./mcp');
const { Runner } = require('./runner');
const { isMasterPlan, readPointer, readPlanFraction } = require('./progress');
const skills = require('./skills');
const updater = require('./updater');
const { UsageService } = require('./usage');

// Capability lists live in engine.js (single source of truth). caps() gives the SELECTED
// engine's models/efforts/permissionModes so the dropdowns and validation re-skin per engine.
const ENGINES = ['claude', 'codex'];
function caps() { return engine.capabilities(state.engine); }

// Snap model/effort/mode to what the CURRENT engine actually offers, and persist. Guards the
// P03-S02 stall: a persisted `auto` on a Codex CLI too old for auto-review must fall back to a
// real mode (plan), never spawn an on-request turn that hangs with no reviewer.
function clampSelections() {
  const c = caps();
  if (!c.models.includes(state.model)) { state.model = c.models[0]; ctx.workspaceState.update('planRunner.model', state.model); }
  if (!c.efforts.includes(state.effort)) { state.effort = c.efforts[0]; ctx.workspaceState.update('planRunner.effort', state.effort); }
  if (!c.permissionModes.some((pm) => pm.value === state.mode)) { state.mode = c.permissionModes[0].value; ctx.workspaceState.update('planRunner.mode', state.mode); }
}
// Tell the user why auto/acceptEdits vanished when the Codex CLI can't do auto-review (P03-S02).
function notifyIfAutoReviewGated() {
  if (state.engine === 'codex' && caps().autoReviewUnavailable)
    post({ kind: 'info', text: require('./codex').AUTO_REVIEW_UNAVAILABLE_MSG });
}

let ctx = null;
let view = null;        // the live WebviewView (null until the panel is opened)
let runner = null;
let usage = null;       // account-wide UsageService (one poller for the extension)
let statusItem = null;
let runningStep = null; // id shown in the status bar while a step is in flight (null = none)
let lastNotify = null;  // dedupe key so a repeated transition doesn't re-fire an OS notification
let state = { enabled: false, engine: 'claude', model: '(default)', effort: '(default)', mode: 'auto' };
let skillNote = null;   // one-line result of the on-activate skill install, shown in the panel

// One OS notification per transition (needs-you/paused warn, done info). Dedupe on `key` so a
// repeated status doesn't spam; going active again (running/finalizing/resumed) clears the key.
function notify(key, level, message) {
  if (key === lastNotify) return;
  lastNotify = key;
  (level === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(message);
}

function workspaceDir() {
  const f = vscode.workspace.workspaceFolders;
  return f && f[0] ? f[0].uri.fsPath : null;
}
function project() {
  const dir = workspaceDir();
  if (!dir) return null;
  return { id: dir, path: dir, name: path.basename(dir), engine: state.engine, model: state.model, effort: state.effort, mode: state.mode,
    maxTurns: vscode.workspace.getConfiguration('planRunner').get('maxTurns', 0),
    maxStepsPerRun: vscode.workspace.getConfiguration('planRunner').get('maxStepsPerRun', 0),
    stopAtTime: vscode.workspace.getConfiguration('planRunner').get('stopAtTime', '') };
}
function post(msg) { if (view) view.webview.postMessage(msg); }
// Repopulate the webview's engine + model/effort/permission dropdowns for the current engine.
function sendConfig() {
  const c = caps();
  post({ kind: 'config', enabled: state.enabled, engine: state.engine,
    model: state.model, effort: state.effort, mode: state.mode, version: require('../package.json').version,
    engines: ENGINES, models: c.models, efforts: c.efforts, modes: c.permissionModes,
    autoSkipQuestionSeconds: vscode.workspace.getConfiguration('planRunner').get('autoSkipQuestionSeconds', 0) });
}
// §Config keys — application-scoped, read the same in every window (D-004).
function usageConfig() {
  const c = vscode.workspace.getConfiguration('planRunner');
  return { threshold: c.get('pauseThresholdPct', 90), pollSec: c.get('usagePollSeconds', 60), finalizeSec: c.get('finalizeQuietSeconds', 120) };
}
// §In-extension UI — the six planRunner.* keys the ⚙ popover reads/writes, with the
// package.json contribution bounds (host clamps writes to these). stopAtTime = "HH:MM"|"".
const SETTING_SPEC = {
  pauseThresholdPct: { min: 10, max: 100, def: 90 },
  usagePollSeconds: { min: 10, max: 3600, def: 60 },
  finalizeQuietSeconds: { min: 0, max: 600, def: 120 },
  maxTurns: { min: 0, max: 1000, def: 0 },
  maxStepsPerRun: { min: 0, max: 1000, def: 0 },
  stopAtTime: { time: true, def: '' },
  stallNotifySeconds: { min: 0, max: 3600, def: 0 },
  autoSkipQuestionSeconds: { min: 0, max: 3600, def: 0 },
};
function postSettings() {
  const c = vscode.workspace.getConfiguration('planRunner');
  const values = {};
  for (const [key, spec] of Object.entries(SETTING_SPEC)) values[key] = c.get(key, spec.def);
  post({ kind: 'settings', values });
}
// Frozen §Webview⇄host shape. `paused` reflects the Runner holding on the usage gate (S08).
function postUsage(s) { post({ kind: 'usage', engine: state.engine, session: s.session, week: s.week, max: s.max, threshold: s.threshold, paused: !!(runner && runner.paused), error: s.error }); }

// " · done/total" from PROGRESS.md, or "" when unreadable/not a master-plan project (P09-S15).
function planFrac(dir) { const f = readPlanFraction(dir); return f ? ` · ${f.done}/${f.total}` : ''; }

function updateStatusBar() {
  const base = `$(${state.enabled ? 'play-circle' : 'circle-slash'}) Plan Runner: ${state.enabled ? 'On' : 'Off'}`;
  const p = project();
  statusItem.text = (runningStep ? `${base} — ${runningStep}` : base) + (p ? planFrac(p.path) : '');
  statusItem.tooltip = runningStep ? `Running ${runningStep}` : 'Toggle Plan Runner auto-run for this workspace';
  statusItem.show();
}

function setEnabled(v) {
  state.enabled = v;
  ctx.workspaceState.update('planRunner.enabled', v);
  updateStatusBar();
  post({ kind: 'enabled', value: v });
  if (!v && runner) runner.abort(); // disabling the workspace tears down now, not gracefully
}

function ensureRunner() {
  const stallMs = vscode.workspace.getConfiguration('planRunner').get('stallNotifySeconds', 0) * 1000;
  if (runner) { runner.project = project(); runner.finalizeMs = usageConfig().finalizeSec * 1000; runner.stallMs = stallMs; return runner; } // pick up edits
  const p = project();
  if (!p) return null;
  runner = new Runner(p);
  runner.finalizeMs = usageConfig().finalizeSec * 1000; // settle window between steps (S: finalizeQuietSeconds)
  runner.stallMs = stallMs; // mid-turn stall watchdog (S: stallNotifySeconds; 0 = off) — P09-S05
  runner.usageGate = usage; // S08: crossing the threshold pauses/resumes the loop
  runner.on('status', (s) => {
    post({ kind: 'status', ...s });
    if (s.step) runningStep = s.step;                                    // running/finalizing/needs-you carry the step
    if (s.state === 'running' || s.state === 'finalizing') lastNotify = null; // active again → re-arm notifications
    else if (s.state === 'needs-you') notify('needs-you:' + s.step, 'warn', `Plan Runner: ${s.detail || s.step + ' needs you'}`);
    updateStatusBar();
  });
  runner.on('step-started', (s) => post({ kind: 'step-started', ...s }));
  runner.on('step-done', (d) => { post({ kind: 'step-done', ...d }); updateStatusBar(); }); // PROGRESS.md advanced → refresh fraction
  runner.on('done', (d) => {
    post({ kind: 'done', ...d });
    runningStep = null; updateStatusBar();
    if (d.state === 'done') notify('done', 'info', `Plan Runner: ${d.detail || 'run complete'}`);
    else if (d.state === 'error') notify('error', 'warn', `Plan Runner: ${d.detail || 'run errored'}`);
  });
  // Mid-turn stall watchdog (P09-S05, D-030): one OS warning + panel line per silent window; the
  // turn is untouched. Dedupe via lastNotify so a re-armed stall on the same step won't spam.
  runner.on('stall', (s) => {
    const key = 'stall:' + s.step;
    if (key === lastNotify) return;
    notify(key, 'warn', `Plan Runner: ${s.step} — no output for ${s.seconds}s (still running).`);
    post({ kind: 'info', text: `⚠ No output from ${s.step} for ${s.seconds}s — the turn may be stalled.` });
  });
  runner.on('paused', (d) => { post({ kind: 'paused', reason: d.reason }); postUsage(usage.snapshot()); notify('paused', 'warn', `Plan Runner paused — ${d.reason}`); });
  runner.on('resumed', () => { post({ kind: 'resumed' }); postUsage(usage.snapshot()); lastNotify = null; });
  return runner;
}

// ---- Webview message handling ----
async function onMessage(m) {
  const p = project();
  switch (m.type) {
    case 'ready':
      sendConfig();
      notifyIfAutoReviewGated(); // panel opened already on an auto-review-incapable Codex
      if (usage) postUsage(usage.snapshot()); // paint whatever's been read so far
      if (skillNote) post({ kind: 'info', text: skillNote });
      post({ kind: 'splash', text: p ? `Workspace: ${p.name}${planFrac(p.path)} — NEXT: ${readPointer(p.path) || '(none)'}` : 'Open a master-plan project folder to begin.' });
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
    case 'stop':   // graceful: finish the current step, then halt (D-022)
      runner?.stop();
      break;
    case 'abort':  // hard: tear the session down now, mid-step
      runner?.abort();
      break;
    case 'pause':  // owner hold the live Claude turn (D-023); runner refuses on Codex
      runner?.pauseManual();
      break;
    case 'resume': // continue the same step after a manual pause
      runner?.resumeManual();
      break;
    case 'send':
      if (!p) return;
      if (runner && runner.running) runner.answer(m.text);        // continues the live step
      else engine.provider(p.engine).chat({ id: p.id, cwd: p.path, prompt: m.text, // plain chat when not auto-running
        options: { model: state.model, effort: state.effort, permissionMode: state.mode } });
      break;
    case 'interrupt':
      if (p) engine.provider(p.engine).interrupt(p.id);
      break;
    case 'discard': {
      // P06-S06: roll this step's file edits back to step start. Confirm modally (webview
      // confirm() is a no-op), then rewind via the runner (SDK checkpoint → git-checkout fallback).
      const r = ensureRunner();
      if (!r) { const msg = 'Open a project folder first.'; post({ kind: 'info', text: msg }); break; }
      const pick = await vscode.window.showWarningMessage(
        "Discard this step's file changes? This reverts edits made since the step started.",
        { modal: true }, 'Discard');
      if (pick !== 'Discard') break;
      try {
        const res = await r.discardStepChanges();
        const n = res.filesChanged ? ` (${res.filesChanged.length} files)` : '';
        post({ kind: 'info', text: `Discarded this step's changes${n} via ${res.method}.` });
      } catch (e) {
        post({ kind: 'info', text: `Could not discard changes: ${String((e && e.message) || e)}` });
      }
      break;
    }
    case 'openFile': {   // P09-S12: clickable tool-row / diff paths open in the editor
      const raw = String(m.path || '');
      if (!raw) break;
      const abs = path.isAbsolute(raw) ? raw : (p ? path.join(p.path, raw) : raw);
      try { await vscode.window.showTextDocument(vscode.Uri.file(abs)); }   // rejects if missing → quiet info
      catch { post({ kind: 'info', text: `Could not open ${raw}.` }); }
      break;
    }
    case 'permission':
      session.resolvePermission({ requestId: m.requestId, decision: m.decision });
      break;
    case 'dialog': // AskUserQuestion answer/skip (P06-S07)
      session.resolveDialog({ requestId: m.requestId, answers: m.answers, cancelled: m.cancelled });
      break;
    case 'setEngine': {
      if (runner && runner.running) {
        // Engine is run-scoped: switching mid-run would desync the poller/session. Refuse and
        // snap the dropdown back (the webview greys it too, this is the host-side backstop).
        post({ kind: 'info', text: 'Stop the run to switch engine.' });
        sendConfig();
        break;
      }
      const next = ENGINES.includes(m.value) ? m.value : 'claude';
      if (next === 'codex' && !require('./codex-path').findCodex()) {
        // Codex not installed: don't switch — tell the user and snap the dropdown back to Claude.
        post({ kind: 'info', text: 'Codex CLI not found. Install it and run `codex login`, then pick Codex again.' });
        sendConfig();
        break;
      }
      state.engine = next;
      ctx.workspaceState.update('planRunner.engine', state.engine);
      // Drop selections the new engine can't offer back to its default (first item).
      clampSelections();
      sendConfig(); // repopulate all four dropdowns for the new engine
      notifyIfAutoReviewGated(); // explain the missing auto/acceptEdits on an old Codex CLI
      // Codex exposes no account usage — stop the Claude poller (this window only) and repaint
      // the meter as N/A; Claude resumes it. Per-window: never touches another window's poller.
      if (state.engine === 'codex') usage.stop(); else usage.start();
      postUsage(usage.snapshot());
      break;
    }
    case 'setModel': {
      const models = caps().models;
      state.model = models.includes(m.value) ? m.value : models[0];
      ctx.workspaceState.update('planRunner.model', state.model);
      break;
    }
    case 'setEffort': {
      const efforts = caps().efforts;
      state.effort = efforts.includes(m.value) ? m.value : efforts[0];
      ctx.workspaceState.update('planRunner.effort', state.effort);
      break;
    }
    case 'setMode': {
      const modes = caps().permissionModes.map((pm) => pm.value);
      state.mode = modes.includes(m.value) ? m.value : modes[0];
      ctx.workspaceState.update('planRunner.mode', state.mode);
      break;
    }
    case 'setThreshold': {
      // Write global config; onDidChangeConfiguration re-applies it here and in every window.
      const v = Math.max(10, Math.min(100, Math.round(Number(m.value))));
      if (Number.isFinite(v))
        vscode.workspace.getConfiguration('planRunner').update('pauseThresholdPct', v, vscode.ConfigurationTarget.Global);
      break;
    }
    case 'getSettings':   // ⚙ popover opened — send current planRunner.* values (P08-S01)
      postSettings();
      break;
    case 'setSetting': {
      // Write one planRunner.* key to global config (same path as setThreshold). Validate/clamp
      // to the package.json contribution bounds, then echo the persisted values back to the popover.
      const spec = SETTING_SPEC[m.key];
      if (!spec) break;                       // ignore unknown keys
      let v;
      if (spec.time) {
        v = String(m.value || '');
        if (v && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) break;   // invalid HH:MM — ignore
      } else {
        v = Math.round(Number(m.value));
        if (!Number.isFinite(v)) break;
        v = Math.max(spec.min, Math.min(spec.max, v));
      }
      await vscode.workspace.getConfiguration('planRunner').update(m.key, v, vscode.ConfigurationTarget.Global);
      postSettings();                         // reflect the clamped/persisted value in the open popover
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
    case 'mcpList': {
      // In-panel MCP popover (P02-S07): the active engine's servers + statuses. No modal —
      // the webview renders the list and posts mcpAction for the buttons.
      post({ kind: 'mcp', engine: state.engine, servers: mcp.servers(state.engine, p ? session.mcpStatus(p.id) : {}) });
      break;
    }
    case 'mcpAction': {
      // Actions from the popover, routed to the active engine's CLI/terminal. reconnect tears
      // down the live session so the next turn/step re-inits and picks up config/auth changes.
      const eng = state.engine;
      if (m.action === 'reconnect') {
        if (p) { engine.provider(eng).stop(p.id); post({ kind: 'info', text: 'MCP: session reset — reconnects on the next run.' }); }
      } else if (m.action === 'open') mcp.openConfig(eng);
      else if (m.action === 'add') mcp.runCli(eng, 'add');
      else if (m.action === 'remove' && m.server) mcp.runCli(eng, 'remove', m.server);
      else if (m.action === 'get' && m.server) mcp.runCli(eng, 'get', m.server);
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
    v.onDidDispose(() => { view = null; }); // don't post() into a torn-down webview
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
    <div id="app" data-logo="${uri('logo.png')}"></div>
    <script nonce="${nonce}" src="${uri('markdown.js')}"></script>
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
    const names = [...new Set(changed.map((r) => r.name))]; // per-engine results → one line per skill name
    return names.length ? `Skills ${force ? 'updated' : 'installed'}: ${names.join(', ')}` : null;
  } catch (e) {
    return `Could not install skills: ${String((e && e.message) || e)}`;
  }
}

function activate(context) {
  ctx = context;
  state.enabled = !!context.workspaceState.get('planRunner.enabled');
  state.engine = ENGINES.includes(context.workspaceState.get('planRunner.engine')) ? context.workspaceState.get('planRunner.engine') : 'claude';
  state.model = context.workspaceState.get('planRunner.model') || '(default)';
  state.effort = context.workspaceState.get('planRunner.effort') || '(default)';
  state.mode = context.workspaceState.get('planRunner.mode') || 'auto';
  clampSelections(); // drop a persisted mode the current engine can't honor (e.g. codex sans auto-review)
  skillNote = installSkills(false); // install-if-missing on every activation
  updater.start(context);           // poll GitHub Releases for a newer .vsix (D-003)

  // Account-wide usage poller, seeded from application-scoped §Config (D-004).
  usage = new UsageService(usageConfig());
  usage.on('update', (s) => { if (runner) runner.onUsageUpdate(); postUsage(s); }); // S08: gate the loop, then repaint
  if (state.engine !== 'codex') usage.start(); // Codex has no usage source — don't poll Claude for it

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
      if (e.affectsConfiguration('planRunner.finalizeQuietSeconds') && runner)
        runner.finalizeMs = usageConfig().finalizeSec * 1000; // live-apply the settle window
      if (e.affectsConfiguration('planRunner.stallNotifySeconds') && runner)
        runner.stallMs = vscode.workspace.getConfiguration('planRunner').get('stallNotifySeconds', 0) * 1000;
      if (e.affectsConfiguration('planRunner.autoSkipQuestionSeconds')) sendConfig(); // re-post so the webview picks up the new value
    }),
  );
}

function deactivate() { runner?.abort(); usage?.stop(); } // shutdown = immediate teardown

module.exports = { activate, deactivate };
