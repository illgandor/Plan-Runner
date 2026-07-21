// SDK session engine — ported from Plan Runner's src/claude-session.js, minus Electron.
// Runs the Claude Agent SDK query() per workspace and maps each raw SDK message to a
// thin UI event, forwarded to the webview through an injectable sink. One live session
// per project id; the autonomous Runner reuses this with a FRESH session per step, and
// answering a "needs you" prompt continues the SAME live session (streaming input mode).
const { ALLOWED_TOOLS } = require('./constants');
const { findClaude } = require('./claude-path');

// Shown once when no claude binary resolves (env/PATH/bundle all absent) — never start a
// session we can't run (D-019). Flag makes it one-time so a missing install doesn't spam every step.
const CLAUDE_MISSING_NOTICE = 'Claude Code was not found. Install it and ensure `claude` is on your ' +
  'PATH (or set PLANRUNNER_CLAUDE), then start the step again.';
let claudeMissingNotified = false;

// The SDK is ESM-only — load via dynamic import(); require() throws ERR_REQUIRE_ESM.
// Lazy so a fake can be injected (setQuery) for tests and a load error surfaces as a
// chat error instead of crashing activate().
let queryFn = null;
async function getQuery() {
  if (!queryFn) queryFn = (await import('@anthropic-ai/claude-agent-sdk')).query;
  return queryFn;
}
function setQuery(fn) { queryFn = fn; } // test seam

// Sink: where mapped messages go. The panel sets it to postMessage into the webview.
let sink = () => {};
function setSink(fn) { sink = fn || (() => {}); }
function defaultSend(channel, payload) { sink({ channel, payload }); }

// A tool_result's content is a string or an array of content blocks — flatten to text.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('');
  return content == null ? '' : String(content);
}

// Map ONE raw SDK message → zero+ thin UI events (one message can carry several blocks).
// Ported verbatim from claude-session.js so the webview renders exactly like v2 did.
function mapMessage(m) {
  if (m.type === 'system' && m.subtype === 'init') {
    return [{ type: 'init', sessionId: m.session_id, slashCommands: m.slash_commands || [],
      mcpServers: (m.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })) }];
  }
  if (m.type === 'stream_event') {
    const d = m.event && m.event.delta;
    if (d && d.type === 'text_delta' && d.text) return [{ type: 'text-delta', text: d.text }];
    if (d && d.type === 'thinking_delta' && d.thinking) return [{ type: 'thinking', text: d.thinking }];
    return [];
  }
  if (m.type === 'assistant') {
    return ((m.message && m.message.content) || []).map((b) => {
      if (b.type === 'text') return { type: 'assistant-text', text: b.text };
      if (b.type === 'thinking') return { type: 'thinking', text: b.thinking };
      if (b.type === 'tool_use') return { type: 'tool-use', toolUseId: b.id, name: b.name, input: b.input };
      return null;
    }).filter(Boolean);
  }
  if (m.type === 'user') {
    return ((m.message && m.message.content) || []).map((b) => {
      if (b && b.type === 'tool_result') {
        return { type: 'tool-result', toolUseId: b.tool_use_id, result: toolResultText(b.content), isError: !!b.is_error };
      }
      return null;
    }).filter(Boolean);
  }
  if (m.type === 'result') {
    // Context fill = the turn's full prompt size (fresh input + cached context). The
    // number to watch grow, like the context meter when you chat with Claude.
    const u = m.usage || {};
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return [{ type: 'result', subtype: m.subtype, text: m.result || '', costUsd: m.total_cost_usd,
      contextTokens: ctx || null, numTurns: m.num_turns != null ? m.num_turns : null,
      durationMs: m.duration_ms != null ? m.duration_ms : null }];
  }
  return [];
}

// A push-driven async iterable of SDKUserMessages: seeds the first prompt, then yields
// whatever send() pushes, until close(). Streaming-input mode keeps the session alive
// for multi-turn — this is what lets your answer continue the SAME step. (verbatim)
function inputQueue(firstText) {
  const pending = [];
  const waiters = [];
  let closed = false;
  const wrap = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  function push(text) {
    if (closed) return;
    if (waiters.length) waiters.shift()(wrap(text)); else pending.push(wrap(text));
  }
  function close() { closed = true; while (waiters.length) waiters.shift()(null); }
  const iterable = { async *[Symbol.asyncIterator]() {
    push(firstText);
    while (true) {
      if (pending.length) { yield pending.shift(); continue; }
      if (closed) return;
      const v = await new Promise((r) => waiters.push(r));
      if (v === null) return;
      yield v;
    }
  } };
  return { iterable, push, close };
}

// App mode → SDK permissionMode. 'auto' → the SDK's classifier ('auto'): safe commands
// auto-approved, only risky ones routed to canUseTool → our panel. 'manual' → 'default'
// (prompts for dangerous ops). No bypassPermissions ever (D-013). Unknown clamps to default.
const MODE_TO_PERMISSION = { auto: 'auto', manual: 'default', acceptEdits: 'acceptEdits', plan: 'plan', default: 'default' };
function modeToPermission(mode) { return MODE_TO_PERMISSION[mode] || 'default'; }

// SDK query options. We resolve the claude binary ourselves (findClaude: env → PATH →
// bundled fallback) and pass it as pathToClaudeCodeExecutable, symmetric with Codex (D-019);
// when null (bundle dropped + none installed) start() bails with a notice before we get here.
// settingSources loads the user's ~/.claude auth + MCP servers + project settings — this is
// what runs the SDK on the Claude subscription (no ANTHROPIC_API_KEY) and connects their MCP.
function sdkOptions(cwd, options = {}) {
  const o = { cwd, includePartialMessages: true, settingSources: ['project', 'user'],
    permissionMode: modeToPermission(options.permissionMode), allowedTools: ALLOWED_TOOLS };
  const claudePath = options.claudePath !== undefined ? options.claudePath : findClaude();
  if (claudePath) o.pathToClaudeCodeExecutable = claudePath;
  if (options.model && options.model !== '(default)') o.model = options.model;
  // Reasoning effort ('low'|'medium'|'high'|'xhigh'|'max'). Models that don't support it
  // (e.g. haiku) silently downgrade, so it's safe to always pass when set.
  if (options.effort && options.effort !== '(default)') o.effort = options.effort;
  // Resume a prior session by id (SDK options.resume) — how pause/resume re-enters the
  // SAME step turn after an interrupt. Omitted when absent so a fresh step starts clean.
  if (options.resume) o.resume = options.resume;
  // Optional per-step turn ceiling (planRunner.maxTurns). Off by default (0); passed only
  // when >0 so an unset cap never constrains the SDK. At the cap the query ends → existing
  // _onTurnEnd routes to needs-you rather than the step looping tools unbounded. (D-016)
  if (options.maxTurns > 0) o.maxTurns = options.maxTurns;
  // File checkpointing (P06-S06): snapshot files before edits so a bad step's changes can be
  // rolled back to step start (the step-start user message) via Query.rewindFiles(). (D-020)
  o.enableFileCheckpointing = true;
  return o;
}

// AskUserQuestion is a normal built-in tool in this SDK (there is no `request_user_dialog` for it):
// the CLI routes it through canUseTool, and we answer by injecting the picks as
// updatedInput.answers. makeCanUseTool renders it as the choice card via this same panel path.
let dialogSeq = 0;
const pendingDialogs = new Map();
function resolveDialog(reply) {
  const p = reply && pendingDialogs.get(reply.requestId);
  if (p) { pendingDialogs.delete(reply.requestId); p.resolve(reply); }
}
function cancelDialogsFor(id) {
  for (const [rid, p] of pendingDialogs) {
    if (p.id === id) {
      pendingDialogs.delete(rid); p.resolve({ cancelled: true });
      defaultSend('session:request-cancelled', { requestId: rid }); // deactivate its panel card (PLAN-09)
    }
  }
}

// Permission callback: allowlisted tools auto-run; anything else ASKS the panel and
// awaits your allow/deny — that's the "needs you" prompt for a gated command. Your reply
// resolves it and the same session continues. (No autonomous auto-deny: the whole point
// of our panel is that you're one click away, unlike the old headless loop.)
let permSeq = 0;
const pendingPerms = new Map();
// "Allow always" (D-029): session-scoped, in-memory ONLY — never written to disk. Per project id
// a Set of remember-keys; a remembered tool auto-allows with no card. Cleared on host restart
// (module reload) since REMEMBER lives only here. (P09-S10)
const REMEMBER = new Map(); // id -> Set<remember-key>
// Remember-key: non-Bash → the toolName; Bash → Bash(<first command word>) so `gh pr view` and
// `gh issue list` share one key but a different command word still asks.
function rememberKey(toolName, input) {
  if (toolName === 'Bash' && input && typeof input.command === 'string') {
    return `Bash(${input.command.trim().split(/\s+/)[0] || ''})`;
  }
  return toolName;
}
function isRemembered(id, toolName, input) {
  const s = REMEMBER.get(id);
  return !!(s && s.has(rememberKey(toolName, input)));
}
function makeCanUseTool(id) {
  return (toolName, input) => new Promise((resolve) => {
    // AskUserQuestion isn't a permission to allow/deny — it's a question to answer. Render the
    // multiple-choice card (the panel's dialog path) and answer by injecting the picks as
    // updatedInput.answers (the shape the CLI reads back). Skip/cancel → allow with NO answers so
    // the model just moves on; never deny (that would error the tool). Kept out of the
    // remember/allow-always path below — a question is always shown, never auto-allowed. (A-P09-02)
    if (toolName === 'AskUserQuestion') {
      const requestId = 'dlg-' + (++dialogSeq);
      pendingDialogs.set(requestId, { id, resolve: (reply) => {
        const answers = reply && reply.answers && !reply.cancelled ? reply.answers : null;
        resolve({ behavior: 'allow', updatedInput: answers ? { ...input, answers } : input });
      } });
      return defaultSend('session:dialog-request', { requestId, id, questions: (input && input.questions) || [] });
    }
    if (isRemembered(id, toolName, input)) return resolve({ behavior: 'allow', updatedInput: input });
    const requestId = 'perm-' + (++permSeq);
    pendingPerms.set(requestId, { id, resolve: (reply) => {
      const decision = reply && reply.decision;
      if (decision === 'allow-always') { // record the key, then allow like a normal allow
        let s = REMEMBER.get(id); if (!s) { s = new Set(); REMEMBER.set(id, s); }
        s.add(rememberKey(toolName, input));
      }
      if (decision === 'allow' || decision === 'allow-always') resolve({ behavior: 'allow', updatedInput: input });
      else resolve({ behavior: 'deny', message: (reply && reply.message) || 'Denied by the user.' });
    } });
    defaultSend('session:permission-request', { requestId, id, toolName, input });
  });
}
function resolvePermission(reply) {
  const p = reply && pendingPerms.get(reply.requestId);
  if (p) { pendingPerms.delete(reply.requestId); p.resolve(reply); }
}
function denyPendingFor(id) {
  for (const [rid, p] of pendingPerms) {
    if (p.id === id) {
      pendingPerms.delete(rid); p.resolve({ decision: 'deny', message: 'Session stopped.' });
      defaultSend('session:request-cancelled', { requestId: rid }); // deactivate its panel card (PLAN-09)
    }
  }
}

const sessions = new Map(); // id -> { q, input, aborted }
// Last init.session_id seen per project id. Persists across teardown so the Runner can
// resume the SAME step after a fresh-context stop — captured BEFORE interrupt (Carryover).
const sessionIds = new Map();
function currentSessionId(id) { return sessionIds.get(id) || null; }
// Last-init MCP connection status per project id: { serverName: status }. Only fresh after
// an init message; the MCP panel shows 'unknown' for anything not seen yet (S09 Carryover).
const mcpStatusByProject = new Map();
function mcpStatus(id) { return mcpStatusByProject.get(id) || {}; }
// First user-message uuid of the CURRENT live session per project — the SDK file-checkpoint
// anchor ("step start"). rewindFiles(id, thisUuid) rolls the step's edits back to before its
// prompt ran. Reset when a fresh session starts (see start()). (P06-S06)
const stepStartMsg = new Map();
function stepStartMessageId(id) { return stepStartMsg.get(id) || null; }
// Roll the live session's checkpointed files back to userMessageId (enableFileCheckpointing).
// Returns the SDK RewindFilesResult, or null when there's no live session / no id / an SDK too
// old to rewind — the caller then falls back to `git checkout`. (P06-S06)
async function rewindFiles(id, userMessageId) {
  const q = sessions.get(id) && sessions.get(id).q;
  if (!q || typeof q.rewindFiles !== 'function' || !userMessageId) return null;
  return q.rewindFiles(userMessageId);
}

// start({id,cwd,prompt,options}) → run query(), map+forward every message. hooks.send
// overrides the sink (the Runner wraps it to watch for turn-end); hooks.onDone fires
// when the stream ends. Keeps the session live by id.
function start({ id, cwd, prompt, options }, hooks = {}) {
  if (sessions.has(id)) stop(id); // one live session per project id
  const send = hooks.send || defaultSend;
  // Never start an unrunnable session: no claude on PATH AND no bundle → notice, don't spawn (D-019).
  const claudePath = findClaude();
  if (!claudePath) {
    if (!claudeMissingNotified) { claudeMissingNotified = true;
      send('session:message', { id, msg: { type: 'error', message: CLAUDE_MISSING_NOTICE } }); }
    hooks.onDone && hooks.onDone();
    return null;
  }
  stepStartMsg.delete(id); // fresh session → capture this step's step-start message anew (P06-S06)
  const input = inputQueue(prompt);
  const opts = sdkOptions(cwd, { ...options, claudePath });
  opts.canUseTool = makeCanUseTool(id); // also answers AskUserQuestion (renders the choice card)
  const entry = { q: null, input, aborted: false };
  sessions.set(id, entry);
  (async () => {
    try {
      const query = await getQuery();
      if (entry.aborted) return;
      const q = query({ prompt: input.iterable, options: opts });
      entry.q = q;
      for await (const m of q) {
        if (entry.aborted) break;
        // First user (replay) message = the step's prompt → its uuid is the rewind anchor (P06-S06).
        if (m.type === 'user' && m.uuid && !stepStartMsg.has(id)) stepStartMsg.set(id, m.uuid);
        for (const msg of mapMessage(m)) {
          if (msg.type === 'init' && msg.sessionId) sessionIds.set(id, msg.sessionId);
          if (msg.type === 'init' && msg.mcpServers)
            mcpStatusByProject.set(id, Object.fromEntries(msg.mcpServers.map((s) => [s.name, s.status])));
          send('session:message', { id, msg });
        }
      }
    } catch (e) {
      if (!entry.aborted) send('session:message', { id, msg: { type: 'error', message: String((e && e.message) || e) } });
    } finally {
      if (sessions.get(id) === entry) sessions.delete(id);
      hooks.onDone && hooks.onDone();
    }
  })();
  return entry;
}

// Multi-turn: push a follow-up into the live session.
function send(id, text) { sessions.get(id)?.input.push(text); }

// Send-or-start: a live session (incl. a running step's) takes the text as a new turn;
// only when none is live do we start fresh. This is how answering "needs you" continues
// the SAME session instead of spawning a new one.
function chat({ id, cwd, prompt, options }, hooks = {}) {
  if (sessions.has(id)) send(id, prompt);
  else start({ id, cwd, prompt, options }, hooks); // no live session (e.g. after an error) → fresh, turn-end-wrapped
}

// q.interrupt()/q.return() are async — a sync try/catch misses their teardown rejections
// ("Query closed before response received"), which then surface as an unhandled rejection
// (crashes a plain-node driver; noisy in the extension host). Swallow sync throw + async reject.
function settle(p) { try { p && typeof p.catch === 'function' && p.catch(() => {}); } catch { /* ignore */ } }

// Interrupt the current turn without ending the session (the Stop button on a live turn).
function interrupt(id) { try { settle(sessions.get(id)?.q?.interrupt?.()); } catch { /* already ended */ } }

// Abort + dispose the session for id (fresh-context teardown between steps).
function stop(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.aborted = true;
  sessions.delete(id);
  denyPendingFor(id);
  cancelDialogsFor(id); // a stopped session can't answer a parked question
  entry.input.close();
  try { settle(entry.q && entry.q.interrupt && entry.q.interrupt()); } catch { /* already ended */ }
  try { settle(entry.q && entry.q.return && entry.q.return()); } catch { /* already ended */ }
}

module.exports = { start, send, chat, stop, interrupt, currentSessionId, mcpStatus, mapMessage,
  setQuery, getQuery, sdkOptions, modeToPermission, resolvePermission, resolveDialog, setSink, defaultSend, sessions,
  stepStartMessageId, rewindFiles };
