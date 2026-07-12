// SDK session engine — ported from Plan Runner's src/claude-session.js, minus Electron.
// Runs the Claude Agent SDK query() per workspace and maps each raw SDK message to a
// thin UI event, forwarded to the webview through an injectable sink. One live session
// per project id; the autonomous Runner reuses this with a FRESH session per step, and
// answering a "needs you" prompt continues the SAME live session (streaming input mode).
const { ALLOWED_TOOLS } = require('./constants');

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
      contextTokens: ctx || null }];
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

// SDK query options. Unlike the Electron app we do NOT rewrite the CLI binary path: a
// .vsix ships node_modules unpacked, so the SDK self-resolves its bundled claude binary
// (the asar hack was Electron-only). settingSources loads the user's ~/.claude auth +
// MCP servers + project settings — this is what runs the SDK on the Claude subscription
// (no ANTHROPIC_API_KEY), and makes their configured MCP servers connect.
function sdkOptions(cwd, options = {}) {
  const o = { cwd, includePartialMessages: true, settingSources: ['project', 'user'],
    permissionMode: modeToPermission(options.permissionMode), allowedTools: ALLOWED_TOOLS };
  if (options.model && options.model !== '(default)') o.model = options.model;
  // Reasoning effort ('low'|'medium'|'high'|'xhigh'|'max'). Models that don't support it
  // (e.g. haiku) silently downgrade, so it's safe to always pass when set.
  if (options.effort && options.effort !== '(default)') o.effort = options.effort;
  // Resume a prior session by id (SDK options.resume) — how pause/resume re-enters the
  // SAME step turn after an interrupt. Omitted when absent so a fresh step starts clean.
  if (options.resume) o.resume = options.resume;
  return o;
}

// Permission callback: allowlisted tools auto-run; anything else ASKS the panel and
// awaits your allow/deny — that's the "needs you" prompt for a gated command. Your reply
// resolves it and the same session continues. (No autonomous auto-deny: the whole point
// of our panel is that you're one click away, unlike the old headless loop.)
let permSeq = 0;
const pendingPerms = new Map();
function makeCanUseTool(id) {
  return (toolName, input) => new Promise((resolve) => {
    const requestId = 'perm-' + (++permSeq);
    pendingPerms.set(requestId, { id, resolve: (reply) => {
      if (reply && reply.decision === 'allow') resolve({ behavior: 'allow', updatedInput: input });
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
    if (p.id === id) { pendingPerms.delete(rid); p.resolve({ decision: 'deny', message: 'Session stopped.' }); }
  }
}

const sessions = new Map(); // id -> { q, input, aborted }
// Last init.session_id seen per project id. Persists across teardown so the Runner can
// resume the SAME step after a fresh-context stop — captured BEFORE interrupt (Carryover).
const sessionIds = new Map();
function currentSessionId(id) { return sessionIds.get(id) || null; }

// start({id,cwd,prompt,options}) → run query(), map+forward every message. hooks.send
// overrides the sink (the Runner wraps it to watch for turn-end); hooks.onDone fires
// when the stream ends. Keeps the session live by id.
function start({ id, cwd, prompt, options }, hooks = {}) {
  if (sessions.has(id)) stop(id); // one live session per project id
  const send = hooks.send || defaultSend;
  const input = inputQueue(prompt);
  const opts = sdkOptions(cwd, options);
  opts.canUseTool = makeCanUseTool(id);
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
        for (const msg of mapMessage(m)) {
          if (msg.type === 'init' && msg.sessionId) sessionIds.set(id, msg.sessionId);
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
function chat({ id, cwd, prompt, options }) {
  if (sessions.has(id)) send(id, prompt);
  else start({ id, cwd, prompt, options });
}

// Interrupt the current turn without ending the session (the Stop button on a live turn).
function interrupt(id) { try { sessions.get(id)?.q?.interrupt?.(); } catch { /* already ended */ } }

// Abort + dispose the session for id (fresh-context teardown between steps).
function stop(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  entry.aborted = true;
  sessions.delete(id);
  denyPendingFor(id);
  entry.input.close();
  try { entry.q && entry.q.interrupt && entry.q.interrupt(); } catch { /* already ended */ }
  try { entry.q && entry.q.return && entry.q.return(); } catch { /* already ended */ }
}

module.exports = { start, send, chat, stop, interrupt, currentSessionId, mapMessage, setQuery,
  getQuery, sdkOptions, modeToPermission, resolvePermission, setSink, defaultSend, sessions };
