// Codex engine — drives `codex exec --json` and maps its JSONL to the SAME thin UI events
// session.js emits, so the webview/Runner stay engine-agnostic (CONTRACTS §Engine dispatch).
// Unlike the Claude SDK's live streaming session, a codex turn is ONE-SHOT: the process runs
// the turn and exits. Multi-turn (answering "needs you", or resuming after a usage pause) =
// `codex exec resume <threadId>` — we persist the thread id from thread.started. `turn.completed`
// is the step-done signal the Runner keys on, exactly like Claude's `result` (D-007; S02 shapes).
const { spawn } = require('child_process');
const { findCodex } = require('./codex-path');
const session = require('./session'); // reuse the shared panel sink (extension sets it once)

// ── Pure mapper (the tested core) ───────────────────────────────────────────────
// mapCodexEvent(evt) → zero+ thin UI events. Same event vocabulary as session.mapMessage:
// init / assistant-text / thinking / tool-use / tool-result / result / error.

function mcpName(item) {
  if (item.tool) return `${item.server || 'mcp'}.${item.tool}`;
  return item.name || 'mcp_tool';
}
function asText(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// One thread item → events. `done` = item.completed (vs item.started). Text items land on
// completed; command/mcp items open on started (tool-use) and close on completed (tool-result).
function mapItem(item, done) {
  if (!item || !item.type) return [];
  const id = item.id;
  switch (item.type) {
    case 'agent_message':
      return done ? [{ type: 'assistant-text', text: item.text || '' }] : [];
    case 'reasoning':
      return done ? [{ type: 'thinking', text: item.text || '' }] : [];
    case 'command_execution':
      return done
        ? [{ type: 'tool-result', toolUseId: id, result: item.aggregated_output || '',
            isError: item.exit_code != null && item.exit_code !== 0 }]
        : [{ type: 'tool-use', toolUseId: id, name: 'shell', input: { command: item.command } }];
    case 'file_change':
      return done ? [{ type: 'tool-use', toolUseId: id, name: 'file_change',
        input: { changes: item.changes || [] } }] : [];
    case 'mcp_tool_call':
      return done
        ? [{ type: 'tool-result', toolUseId: id, result: asText(item.result), isError: item.status === 'failed' }]
        : [{ type: 'tool-use', toolUseId: id, name: mcpName(item), input: item.arguments || item.invocation || {} }];
    default:
      return []; // web_search / todo_list / anything new: ignore rather than mis-render
  }
}

function mapCodexEvent(evt) {
  if (!evt || !evt.type) return [];
  switch (evt.type) {
    case 'thread.started':
      return [{ type: 'init', sessionId: evt.thread_id || null, slashCommands: [], mcpServers: [] }];
    case 'item.started':
      return mapItem(evt.item, false);
    case 'item.completed':
      return mapItem(evt.item, true);
    case 'turn.completed': {
      // Context fill to watch grow = the turn's full prompt size. Codex's input_tokens already
      // INCLUDES cached tokens (unlike Claude's split fields), so it IS the number to show.
      const u = evt.usage || {};
      return [{ type: 'result', subtype: 'success', text: '', costUsd: null,
        contextTokens: u.input_tokens || null }];
    }
    case 'turn.failed':
    case 'error':
      return [{ type: 'error',
        message: String((evt.error && (evt.error.message || evt.error)) || evt.message || 'Codex error') }];
    default:
      return []; // turn.started etc. — nothing to render
  }
}

// ── Provider surface (mirrors session.js: start/send/chat/interrupt/stop/currentSessionId) ──

function defaultSend(channel, payload) { session.defaultSend(channel, payload); }

const live = new Map();      // id -> { child, aborted, gotResult } (the running turn; gone on exit)
const threadIds = new Map(); // id -> codex thread id (persists across turns; cleared by stop)
const ctx = new Map();       // id -> { cwd, options } (so send(id,text) can respawn a resume)

function currentSessionId(id) { return threadIds.get(id) || null; }
function mcpStatus() { return {}; } // codex reports no MCP status yet; keep the surface symmetric

// ── Capabilities (P02-S05) ──────────────────────────────────────────────────────
// FULL capability, no dumbing down (D-011): every reasoning effort incl. xhigh, and the
// permission matrix incl. Codex's own full-auto/full-access presets on top of the four
// Claude-named modes §Engine defines. Model IDs are volatile — '(default)' always works and
// lets Codex pick; the named ones are the current gpt-5.6 tier (sol>terra>luna; extend when they change).
const CODEX_MODELS = ['(default)', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const CODEX_EFFORTS = ['(default)', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// permissionMode → [sandbox_mode, approval_policy] (D-013: static policy, no live callback).
// First four are §Engine's contract mapping; full-auto/full-access preserve Codex-only reach.
const CODEX_PERMS = {
  plan:          ['read-only',           'never'],
  manual:        ['read-only',           'on-request'],
  acceptEdits:   ['workspace-write',     'on-request'],
  auto:          ['workspace-write',     'never'],
  'full-auto':   ['workspace-write',     'on-failure'],
  'full-access': ['danger-full-access',  'never'],
};

const CODEX_CAPS = {
  models: CODEX_MODELS,
  efforts: CODEX_EFFORTS,
  permissionModes: [
    { value: 'plan', label: 'plan (read-only)' },
    { value: 'manual', label: 'manual (read-only · ask)' },
    { value: 'acceptEdits', label: 'acceptEdits (workspace-write · ask)' },
    { value: 'auto', label: 'auto (workspace-write)' },
    { value: 'full-auto', label: 'full-auto (workspace-write · retry)' },
    { value: 'full-access', label: 'full-access ⚠ (no sandbox)' },
  ],
};

// mode → ['--sandbox', X, '--ask-for-approval', Y]; unknown/absent → [] (Codex uses its default).
function permissionArgs(mode) {
  const pair = CODEX_PERMS[mode];
  // `--sandbox` is valid on `codex exec`, but `-a/--ask-for-approval` is a TOP-LEVEL flag only
  // (codex-cli >=0.144 rejects it after `exec`). So pass approval as a `-c approval_policy=` config
  // override — same mechanism buildArgs already uses for model_reasoning_effort. (Fixes the
  // "unexpected argument '--ask-for-approval'" error on Start.)
  return pair ? ['--sandbox', pair[0], '-c', `approval_policy=${pair[1]}`] : [];
}

function buildArgs(prompt, options = {}, resumeId) {
  const a = ['exec'];
  if (resumeId) a.push('resume', resumeId);
  a.push('--json', '--skip-git-repo-check');
  if (options.model && options.model !== '(default)') a.push('-m', options.model);
  if (options.effort && options.effort !== '(default)') a.push('-c', `model_reasoning_effort=${options.effort}`);
  a.push(...permissionArgs(options.permissionMode));
  a.push(prompt);
  return a;
}

function parseLine(line) {
  const s = line.trim();
  if (!s || s[0] !== '{') return null; // skip the "Reading additional input from stdin..." banner etc.
  try { return JSON.parse(s); } catch { return null; }
}

function handleLine(id, entry, line, send) {
  const evt = parseLine(line);
  if (!evt) return;
  if (evt.type === 'thread.started' && evt.thread_id) threadIds.set(id, evt.thread_id);
  if (entry.aborted) return;
  for (const msg of mapCodexEvent(evt)) {
    if (msg.type === 'result' || msg.type === 'error') entry.gotResult = true;
    send('session:message', { id, msg });
  }
}

function killLive(id) {
  const e = live.get(id);
  if (!e) return;
  e.aborted = true;
  live.delete(id);
  try { e.child.kill('SIGINT'); } catch { /* already gone */ }
}

// Spawn ONE codex turn (fresh or a resume) and stream its JSONL through `send`.
function spawnTurn(id, cwd, prompt, options, resumeId, send, onDone) {
  ctx.set(id, { cwd, options });
  const bin = findCodex();
  if (!bin) {
    send('session:message', { id, msg: { type: 'error',
      message: 'Codex CLI not found — install the OpenAI Codex app or set PLANRUNNER_CODEX.' } });
    onDone && onDone();
    return;
  }
  let child;
  try { child = spawn(bin, buildArgs(prompt, options, resumeId), { cwd, windowsHide: true }); }
  catch (e) {
    send('session:message', { id, msg: { type: 'error', message: String((e && e.message) || e) } });
    onDone && onDone();
    return;
  }
  const entry = { child, aborted: false, gotResult: false };
  live.set(id, entry);
  let stderr = '';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { handleLine(id, entry, buf.slice(0, nl), send); buf = buf.slice(nl + 1); }
  });
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.on('error', (e) => {
    if (entry.aborted) return;
    entry.gotResult = true;
    send('session:message', { id, msg: { type: 'error', message: String((e && e.message) || e) } });
  });
  child.on('close', (code) => {
    if (buf) handleLine(id, entry, buf, send); // trailing partial line
    // No turn.completed/error seen (crash, auth failure) → surface one so the Runner isn't stranded.
    if (!entry.aborted && !entry.gotResult) {
      send('session:message', { id, msg: { type: 'error', message: stderr.trim() || `codex exited with code ${code}` } });
    }
    if (live.get(id) === entry) live.delete(id);
    onDone && onDone();
  });
}

// start({id,cwd,prompt,options}, hooks) — options.resume (a thread id) continues that thread.
function start({ id, cwd, prompt, options = {} }, hooks = {}) {
  killLive(id); // one turn at a time per project
  spawnTurn(id, cwd, prompt, options, options.resume || null, hooks.send || defaultSend, hooks.onDone);
}

// Follow-up on the SAME step: resume the persisted thread (no live process between turns).
function send(id, text) {
  const c = ctx.get(id);
  if (!c) return;
  spawnTurn(id, c.cwd, text, c.options, threadIds.get(id) || null, defaultSend, null);
}

// Send-or-start: resume the thread if we have one for this id, else begin a fresh one.
function chat({ id, cwd, prompt, options = {} }) {
  spawnTurn(id, cwd, prompt, options, threadIds.get(id) || null, defaultSend, null);
}

// Interrupt the live turn (usage-pause) — the thread id stays, so we can resume the same step.
function interrupt(id) {
  const e = live.get(id);
  if (e && e.child) { try { e.child.kill('SIGINT'); } catch { /* already ended */ } }
}

// Teardown between steps: kill the turn AND drop the thread id so the next step starts fresh.
function stop(id) {
  killLive(id);
  threadIds.delete(id);
  ctx.delete(id);
}

module.exports = { start, send, chat, interrupt, stop, currentSessionId, mcpStatus,
  mapCodexEvent, mapItem, buildArgs, permissionArgs, CODEX_CAPS, defaultSend };
