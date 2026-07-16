// Codex engine — drives `codex exec --json` and maps its JSONL to the SAME thin UI events
// session.js emits, so the webview/Runner stay engine-agnostic (CONTRACTS §Engine dispatch).
// Unlike the Claude SDK's live streaming session, a codex turn is ONE-SHOT: the process runs
// the turn and exits. Multi-turn (answering "needs you", or resuming after a usage pause) =
// `codex exec resume <threadId>` — we persist the thread id from thread.started. `turn.completed`
// is the step-done signal the Runner keys on, exactly like Claude's `result` (D-007; S02 shapes).
const { spawn, execFileSync } = require('child_process');
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
      // turnTokens = total tokens processed this turn (input incl. cached + output). The panel
      // accumulates it into a Codex "tokens this run" readout, since Codex exposes no account
      // usage % (no `claude /usage` equivalent) — the meter shows N/A % + this counter instead.
      return [{ type: 'result', subtype: 'success', text: '', costUsd: null,
        contextTokens: u.input_tokens || null,
        turnTokens: ((u.input_tokens || 0) + (u.output_tokens || 0)) || null }];
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

// ── Capabilities (P02-S05 · reworked P03-S01) ────────────────────────────────────
// FULL capability, no dumbing down (D-011): every reasoning effort the models accept, and
// EXACTLY the four Claude-symmetric modes §Engine defines — no Codex-only full-auto/full-access
// (D-014 dropped both: full-access violates D-002's no-bypass rule, full-auto isn't symmetric).
// Model IDs are volatile — '(default)' always works and lets Codex pick; the named ones are the
// current gpt-5.6 tier (sol>terra>luna; extend when they change). luna rejects `minimal` effort
// (only none/low/medium/high/xhigh) → drop it so a luna turn can't 400 on the effort override.
const CODEX_MODELS = ['(default)', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const CODEX_EFFORTS = ['(default)', 'low', 'medium', 'high', 'xhigh'];

// permissionMode → [sandbox_mode, approval_policy, reviewer?] (D-013: static policy, no live
// callback). The four Claude-symmetric modes. auto + acceptEdits self-commit their own git via
// Codex auto-review: workspace-write protects `.git` read-only, so on-request + auto_review
// escalates the `.git` write and the reviewer auto-approves it inside the sandbox (D-014,
// test-verified). No bypass/full-access mode ever (D-002).
const CODEX_PERMS = {
  plan:        ['read-only',       'never'],
  manual:      ['read-only',       'on-request'],
  acceptEdits: ['workspace-write', 'on-request', 'auto_review'],
  auto:        ['workspace-write', 'on-request', 'auto_review'],
};

const CODEX_CAPS = {
  models: CODEX_MODELS,
  efforts: CODEX_EFFORTS,
  permissionModes: [
    { value: 'plan', label: 'plan (read-only)' },
    { value: 'manual', label: 'manual (read-only · ask)' },
    { value: 'acceptEdits', label: 'acceptEdits (workspace-write · auto-review)' },
    { value: 'auto', label: 'auto (workspace-write · auto-review)' },
  ],
};

// ── Auto-review compatibility fail-safe (P03-S02) ────────────────────────────────
// auto + acceptEdits ride on `approvals_reviewer="auto_review"` to escalate the sandbox-denied
// `.git` write. An OLDER Codex CLI silently IGNORES that unknown config key, so `on-request`
// then STALLS forever with no reviewer to answer it. So gate the two write modes on CLI support:
// unsupported → offer only the read-only modes (plan/manual) + a clear "update Codex" note.
// NEVER emit on-request without a reviewer, and NEVER fall back to full-access (D-002).
const MIN_AUTO_REVIEW = [0, 144, 0]; // known-good floor (verified on 0.144.0-alpha.4); conservative
const AUTO_REVIEW_UNAVAILABLE_MSG =
  'This Codex CLI is too old for auto-review — auto and acceptEdits are disabled. ' +
  'Update Codex (>= 0.144.0) for autonomous commits; plan and manual still work.';

function parseCodexVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
// version string → does its CLI honor approvals_reviewer? Unparseable/absent → false (fail-safe:
// never assume reviewer support we can't confirm, since guessing wrong is a headless stall).
function supportsAutoReview(version) {
  const v = parseCodexVersion(version);
  if (!v) return false;
  for (let i = 0; i < 3; i++) { if (v[i] !== MIN_AUTO_REVIEW[i]) return v[i] > MIN_AUTO_REVIEW[i]; }
  return true; // exactly the floor
}

let _autoReview = null; // cached: `codex --version` is stable for a process, probe once
function probeCodexVersion() {
  const bin = findCodex();
  if (!bin) return null;
  try { return String(execFileSync(bin, ['--version'], { timeout: 5000, windowsHide: true })); }
  catch { return null; } // not runnable → treat as unsupported (fail-safe)
}
function autoReviewSupported() {
  if (_autoReview === null) _autoReview = supportsAutoReview(probeCodexVersion());
  return _autoReview;
}

// codexCaps(supported?) — CODEX_CAPS gated to the CLI's real capability. Unsupported → drop the
// reviewer-dependent write modes and flag it (autoReviewUnavailable) so the panel can explain
// (extension.js surfaces AUTO_REVIEW_UNAVAILABLE_MSG). `supported` is injectable for tests.
function codexCaps(supported = autoReviewSupported()) {
  if (supported) return CODEX_CAPS;
  return { ...CODEX_CAPS,
    permissionModes: CODEX_CAPS.permissionModes.filter((m) => !CODEX_PERMS[m.value][2]),
    autoReviewUnavailable: true };
}

// mode → ['--sandbox', X, '-c', 'approval_policy="Y"', ...]; unknown/absent → [] (Codex default).
function permissionArgs(mode) {
  const p = CODEX_PERMS[mode];
  if (!p) return []; // unknown/absent → [] (Codex uses its own default)
  // `--sandbox` is valid on `codex exec`, but `-a/--ask-for-approval` is a TOP-LEVEL flag only
  // (codex-cli >=0.144 rejects it after `exec`). So pass approval as a `-c approval_policy=` config
  // override — same mechanism buildArgs uses for model_reasoning_effort. QUOTE the value: the TOML
  // override parser only accepts `on-request` (hyphen) as a quoted string; bare `never` also works
  // but we quote uniformly.
  const args = ['--sandbox', p[0], '-c', `approval_policy="${p[1]}"`];
  // Reviewer (auto_review) escalates + auto-approves the sandbox-denied `.git` write so auto/
  // acceptEdits commit their own git — no `--add-dir` hack, no manual approval (D-014).
  if (p[2]) args.push('-c', `approvals_reviewer="${p[2]}"`);
  return args;
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

// SIGINT doesn't reliably kill codex.exe or its child tree on Windows (hung turns pile up),
// so terminate the whole tree with `taskkill /T /F` on win32; POSIX falls back to SIGKILL.
function killChild(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); return; } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function killLive(id) {
  const e = live.get(id);
  if (!e) return;
  e.aborted = true;
  live.delete(id);
  killChild(e.child);
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
  // stdio stdin='ignore' (closed): `codex exec` with a prompt arg AND a piped-open stdin reads
  // stdin as an extra `<stdin>` block and BLOCKS on EOF forever (cli >=0.144) — the turn hangs
  // with no output. Closing stdin makes it run the argv prompt and stream normally. Same fix
  // usage.js uses for `claude -p`. (Fixes: Start on Codex shows the step then nothing streams.)
  // env: override ONLY core.excludesFile (empty) so git inside the workspace-write sandbox
  // doesn't warn it "can't access ~/.config/git/ignore" — harmless, but it distracts the model
  // into stopping. GIT_CONFIG_* injection leaves identity/config untouched (commits still work).
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '' };
  try { child = spawn(bin, buildArgs(prompt, options, resumeId), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }); }
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
  if (e && e.child) killChild(e.child); // tree-kill; the thread id persists for resume
}

// Teardown between steps: kill the turn AND drop the thread id so the next step starts fresh.
function stop(id) {
  killLive(id);
  threadIds.delete(id);
  ctx.delete(id);
}

module.exports = { start, send, chat, interrupt, stop, currentSessionId, mcpStatus,
  mapCodexEvent, mapItem, buildArgs, permissionArgs, CODEX_CAPS, defaultSend,
  supportsAutoReview, codexCaps, AUTO_REVIEW_UNAVAILABLE_MSG };
