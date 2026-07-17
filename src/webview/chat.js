// Plan Runner chat webview. Renders the live SDK session and the autonomous controls.
// Talks to the extension host only via postMessage: it holds no Claude logic itself.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  // ---- Layout ----
  app.innerHTML = `
    <div class="bar">
      <button id="run" class="primary">▶ Start</button>
      <select id="engine" title="Engine"></select>
      <select id="model" title="Model"></select>
      <select id="effort" title="Reasoning effort"></select>
      <select id="mode" title="Permission mode"></select>
      <span class="spacer"></span>
      <span class="chip" id="ctx" hidden>ctx —</span>
      <span class="ver" id="ver" title="Plan Runner version"></span>
    </div>
    <div class="meter" id="meter" hidden>
      <div class="gauge"><span class="glabel">Session</span><progress id="sbar" max="100" value="0"></progress><span class="gpct" id="spct">—</span></div>
      <div class="gauge"><span class="glabel">Week</span><progress id="wbar" max="100" value="0"></progress><span class="gpct" id="wpct">—</span></div>
      <div class="gauge tokrow" id="tokrow" style="display:none" title="Total tokens processed this run (input incl. cached + output). Codex reports no account usage %."><span class="glabel">Tokens</span><span style="flex:1"></span><span class="gpct" id="tokval">—</span></div>
      <label class="thresh" title="Pause the loop at this account-usage % (applies to all windows)">Pause @ <input id="thresh" type="number" min="10" max="100" step="1">%</label>
    </div>
    <div class="status" id="status" aria-live="polite">Idle</div>
    <div id="log"></div>
    <div class="composer">
      <button id="jump" class="jump" hidden>↓ New</button>
      <div id="mcpmenu" class="mcpmenu" hidden></div>
      <textarea id="input" placeholder="Message Claude, or answer a step's question…"></textarea>
      <div class="row">
        <button id="attach" title="Attach a file (its path is handed to Claude to read)">📎 Attach</button>
        <button id="mcp" title="MCP servers for the active engine">🔌 MCP</button>
        <button id="discard" title="Roll this step's file edits back to how they were at step start" hidden>↺ Discard step changes</button>
        <button id="stop" title="Interrupt the current turn">■ Stop turn</button>
        <button id="send" class="send">Send</button>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const logoUri = app.dataset.logo || '';   // webview URI of src/webview/logo.png (from html())
  let enabled = false, running = false;
  let sessionTokens = 0;          // Codex: running total of tokens processed this run (no usage % source)
  let cur = null;                 // current assistant message element being streamed into
  const toolEls = new Map();      // toolUseId -> tool <details> element

  // ---- Rendering helpers ----
  const CAP = 4000;               // chars shown before a "show more" reveals the rest
  // Sticky-to-bottom (P04-S05): only autoscroll while the view is pinned near the bottom, so
  // scrolling up mid-turn isn't yanked back. `stuck` tracks intent via the scroll event.
  let stuck = true;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.addEventListener('scroll', () => { stuck = nearBottom(); if (stuck) $('jump').hidden = true; });
  function scroll(force) {
    if (force || stuck) { log.scrollTop = log.scrollHeight; $('jump').hidden = true; }
    else $('jump').hidden = false;   // detached + new content → offer the jump-to-latest button
  }
  // Fill el with text, but cap huge tool output behind a "show more" instead of silently truncating.
  function setCapped(el, text) {
    if (text.length <= CAP) { el.textContent = text; return; }
    el.textContent = text.slice(0, CAP);
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = `… show ${text.length - CAP} more`;
    more.onclick = () => { el.textContent = text; };   // reveal full output (button replaced)
    el.appendChild(more);
  }
  function bubble(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    if (text != null) el.textContent = text;
    log.appendChild(el); scroll();
    return el;
  }
  function system(text) { bubble('system', text); }
  function stepChip(text) {   // step-started/step-done timeline divider: badged label + flanking rules (P04-S06)
    const el = bubble('step', null);
    const label = document.createElement('span');
    label.className = 'step-label'; label.textContent = text;
    el.appendChild(label); scroll();
  }
  // First block in the log: Workspace/NEXT line + logo, in normal flow so chat pushes it off-screen.
  function splash(text) {
    let s = $('splash');
    if (!s) {
      s = document.createElement('div'); s.id = 'splash'; s.className = 'splash';
      s.appendChild(document.createElement('div')).className = 'splash-line';
      if (logoUri) {
        const img = document.createElement('img');
        img.className = 'splash-logo'; img.src = logoUri; img.alt = 'Plan Runner';
        img.onerror = () => img.remove();          // asset missing → hide gracefully
        s.appendChild(img);
      }
      log.insertBefore(s, log.firstChild);         // stays first even if messages arrived first
    }
    s.querySelector('.splash-line').textContent = text;
    scroll();
  }

  function ensureAssistant() {
    if (!cur) { cur = bubble('assistant', ''); cur.dataset.streamed = ''; }
    return cur;
  }
  function appendText(t) {
    const el = ensureAssistant();
    el.dataset.streamed = '1';
    el.appendChild(document.createTextNode(t));
    scroll();
  }
  // Re-render a finished assistant bubble's streamed plain text as sanitized markdown (D-015).
  // Replaces each run of adjacent text nodes in place; leaves think/tool/note children untouched.
  function finalizeMd(el) {
    if (!el || el.dataset.md || !window.renderMarkdown) return;
    el.dataset.md = '1';
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const text = group.map((n) => n.textContent).join('');
      if (text.trim()) el.insertBefore(window.renderMarkdown(text), group[0]);
      group.forEach((n) => n.remove());
      group = [];
    };
    Array.from(el.childNodes).forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) group.push(n); else flush();
    });
    flush();
  }
  function appendThinking(t) {
    const el = ensureAssistant();
    let d = el.querySelector('details.think');
    if (!d) {
      d = document.createElement('details'); d.className = 'think';
      d.innerHTML = '<summary>thinking…</summary><div class="think-body"></div>';
      el.appendChild(d);
    }
    d.querySelector('.think-body').appendChild(document.createTextNode(t));
    scroll();
  }
  function toolUse(msg) {
    const el = ensureAssistant();
    const d = document.createElement('details'); d.className = 'tool';
    d.innerHTML = `<summary><span class="tool-status">⏳</span> <span class="tool-name"></span> <span class="tool-target"></span></summary>`;
    d.querySelector('.tool-name').textContent = msg.name;
    d.querySelector('.tool-target').textContent = toolTarget(msg.input);   // path/command in the collapsed summary (P04-S03)
    const input = msg.input || {};
    if (input && (msg.name === 'Edit' || msg.name === 'Write' || msg.name === 'MultiEdit')) {
      d.appendChild(editDiff(msg.name, input));   // red/green line diff, not raw JSON (P04-S02)
    } else {
      const body = document.createElement('div'); body.className = 'tool-body';
      setCapped(body, JSON.stringify(input, null, 2));
      d.appendChild(body);
    }
    el.appendChild(d);
    toolEls.set(msg.toolUseId, d);
    scroll();
  }
  // The first meaningful input value for a collapsed tool row: file path or command, else first string (P04-S03).
  function toolTarget(input) {
    if (!input || typeof input !== 'object') return '';
    const v = input.file_path || input.path || input.command || input.pattern ||
      Object.values(input).find((x) => typeof x === 'string' && x);
    return typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : '';
  }
  // Render a file-edit tool's input as a line-based red/green diff — no diff library (P04-S02).
  // Edit → old red / new green; Write → all green; MultiEdit → each edit in sequence.
  function editDiff(name, input) {
    const wrap = document.createElement('div');
    wrap.className = 'diff';
    if (input.file_path) {
      const p = document.createElement('div'); p.className = 'diff-path';
      p.textContent = input.file_path; wrap.appendChild(p);
    }
    const rows = [];
    const add = (text, cls) => String(text == null ? '' : text).split('\n').forEach((l) => rows.push([cls, l]));
    if (name === 'Write') add(input.content, 'add');
    else if (name === 'MultiEdit') (input.edits || []).forEach((e) => { add(e.old_string, 'del'); add(e.new_string, 'add'); });
    else { add(input.old_string, 'del'); add(input.new_string, 'add'); }
    const CAPL = 300;   // ponytail: line cap so a whole-file Write can't bloat the DOM; the JSON path caps too
    rows.slice(0, CAPL).forEach(([cls, l]) => {
      const row = document.createElement('div'); row.className = 'diff-line ' + cls;
      row.textContent = (cls === 'del' ? '- ' : '+ ') + l; wrap.appendChild(row);
    });
    if (rows.length > CAPL) {
      const more = document.createElement('div'); more.className = 'diff-more';
      more.textContent = `… ${rows.length - CAPL} more lines`; wrap.appendChild(more);
    }
    return wrap;
  }
  // Inline auto-review note (Codex escalate→retry): a small line inside the assistant group so a
  // silent retry reads as "🔍 reviewed permission: … → approved" instead of an unexplained gap.
  function reviewNote(text) {
    const el = ensureAssistant();
    const n = document.createElement('div');
    n.className = 'review-note';
    n.textContent = text;
    el.appendChild(n); scroll();
  }
  function toolResult(msg) {
    const d = toolEls.get(msg.toolUseId);
    if (!d) return;
    const status = d.querySelector('.tool-status');
    if (status) status.textContent = msg.isError ? '⛔' : '✔';   // ⏳ → ✔/⛔ in the collapsed summary (P04-S03)
    if (msg.isError) d.open = true;                              // failures self-expand
    const body = document.createElement('div');
    body.className = 'tool-body';
    setCapped(body, (msg.isError ? '⛔ ' : '') + String(msg.result || ''));
    d.appendChild(body); scroll();
  }

  // ---- SDK message handling (mirrors mapMessage output) ----
  function onSession(channel, payload) {
    if (channel === 'session:permission-request') return permission(payload);
    if (channel !== 'session:message') return;
    const m = payload.msg;
    switch (m.type) {
      case 'init': break; // MCP status lives in the 🔌 button now — no per-session/reply banner
      case 'text-delta': appendText(m.text); if (cur) cur.dataset.delta = '1'; break; // mark: streamed live
      case 'assistant-text':
        if (cur && cur.dataset.delta) { finalizeMd(cur); cur = null; break; }  // streamed via text-delta — render, skip the dupe text
        cur = null; appendText(m.text); finalizeMd(cur);       // Codex (no deltas) / non-streamed reply — own bubble, render now
        break;
      case 'thinking': appendThinking(m.text); break;
      case 'tool-use': toolUse(m); break;
      case 'tool-result': toolResult(m); break;
      case 'review-note': reviewNote(m.text); break;
      case 'result':
        if (m.contextTokens) { const c = $('ctx'); c.hidden = false; c.textContent = 'ctx ' + fmt(m.contextTokens); }
        if (m.turnTokens) { sessionTokens += m.turnTokens; $('tokval').textContent = fmt(sessionTokens); } // Codex counter
        finalizeMd(cur);                           // backstop: render any bubble that streamed without a trailing assistant-text
        cur = null; toolEls.clear();               // finalize this turn's group
        break;
      case 'error': bubble('error', m.message || 'Error'); cur = null; break;
    }
  }
  function fmt(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }

  function permission(p) {
    const el = document.createElement('div');
    el.className = 'perm';
    el.innerHTML = `<div>Claude wants to use a tool that isn't auto-allowed:</div>
      <div class="tool">${escapeHtml(p.toolName)} ${escapeHtml(JSON.stringify(p.input || {}).slice(0, 300))}</div>
      <div class="row"><button class="allow">Allow</button><button class="deny">Deny</button></div>`;
    el.querySelector('.allow').onclick = () => { vscode.postMessage({ type: 'permission', requestId: p.requestId, decision: 'allow' }); el.remove(); };
    el.querySelector('.deny').onclick = () => { vscode.postMessage({ type: 'permission', requestId: p.requestId, decision: 'deny' }); el.remove(); };
    log.appendChild(el); scroll();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- Control messages from the extension ----
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.channel) return onSession(d.channel, d.payload);
    switch (d.kind) {
      case 'config':
        fill($('engine'), d.engines, d.engine);
        fill($('model'), d.models, d.model); fill($('effort'), d.efforts, d.effort); fill($('mode'), d.modes, d.mode);
        if (d.version) $('ver').textContent = 'v' + d.version;
        enabled = d.enabled; reflect(); break;
      case 'enabled': enabled = d.value; reflect(); break;
      case 'status':
        setStatus(d); running = d.state === 'running' || d.state === 'needs-you' || d.state === 'finalizing'; reflect();
        if (d.state === 'needs-you') { const el = ensureAssistant(); } // keep group open for the answer
        break;
      case 'step-started': stepChip('▶ ' + (d.step || 'step')); cur = null; break;
      case 'step-done': stepChip(`✔ ${d.from} → ${d.to}`); cur = null; break;
      case 'done': system('■ ' + (d.detail || d.state)); running = false; reflect(); break;
      case 'usage': usage(d); break;
      case 'paused': setStatus({ state: 'paused', detail: d.reason }); break;   // still running; badge on the meter
      case 'resumed': setStatus({ state: 'running', detail: 'Resumed — usage dropped' }); break;
      case 'info': system(d.text); break;
      case 'splash': splash(d.text); break;
      case 'attached': insertAtCursor($('input'), d.paths.map((p) => '@' + p).join(' ') + ' '); break;
      case 'mcp': renderMcp(d.engine, d.servers || []); break;
    }
  });

  // ---- In-composer MCP popover (P02-S07): no modal; the active engine's servers + actions ----
  function mcpAction(action, server) { vscode.postMessage({ type: 'mcpAction', action, server }); closeMcp(); }
  function closeMcp() { $('mcpmenu').hidden = true; }
  function renderMcp(eng, servers) {
    const menu = $('mcpmenu');
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'mcp-head'; head.textContent = `MCP servers — ${eng}`;
    menu.appendChild(head);
    if (!servers.length) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty'; empty.textContent = 'No MCP servers configured yet.';
      menu.appendChild(empty);
    }
    servers.forEach((s) => {
      const row = document.createElement('div'); row.className = 'mcp-row';
      const name = document.createElement('span'); name.className = 'mcp-name'; name.textContent = s.name;
      const stat = document.createElement('span'); stat.className = 'mcp-status'; stat.textContent = s.status || 'unknown';
      const auth = document.createElement('button'); auth.textContent = 'Auth/status'; auth.onclick = () => mcpAction('get', s.name);
      const rm = document.createElement('button'); rm.textContent = 'Remove'; rm.onclick = () => mcpAction('remove', s.name);
      row.append(name, stat, auth, rm);
      menu.appendChild(row);
    });
    const actions = document.createElement('div'); actions.className = 'mcp-actions';
    [['Add server…', 'add'], ['Reconnect', 'reconnect'], ['Open config', 'open']].forEach(([label, action]) => {
      const b = document.createElement('button'); b.textContent = label; b.onclick = () => mcpAction(action); actions.appendChild(b);
    });
    menu.appendChild(actions);
    menu.hidden = false;
  }
  // Usage meter. Snapshot already keeps last-good, so a null value = "no reading yet";
  // never zero a painted bar (that's the anti-flicker rule from §Usage snapshot).
  function usage(d) {
    $('meter').hidden = false;
    const codex = d.engine === 'codex';
    $('tokrow').style.display = codex ? 'flex' : 'none'; // inline display beats the .gauge{display:flex} rule
    const m = $('meter');
    if (codex) {
      // Codex has no account usage % — show N/A instead of the stale Claude reading, and
      // surface the token counter. The pause-gate is inert on Codex, so no over/warn/paused.
      naBar($('sbar'), $('spct')); naBar($('wbar'), $('wpct'));
      $('tokval').textContent = sessionTokens ? fmt(sessionTokens) : '—';
      m.classList.remove('over', 'warn', 'paused');
      m.classList.add('codex');
    } else {
      m.classList.remove('codex');
      paintBar($('sbar'), $('spct'), d.session);
      paintBar($('wbar'), $('wpct'), d.week);
      m.classList.toggle('over', d.max != null && d.max >= d.threshold);
      m.classList.toggle('warn', d.max != null && d.max >= d.threshold - 10 && d.max < d.threshold);
      m.classList.toggle('paused', !!d.paused); // hook painted by S08
    }
    const t = $('thresh');
    if (d.threshold != null && document.activeElement !== t) t.value = d.threshold; // don't fight the editor
  }
  function paintBar(bar, txt, v) {
    if (v == null) return;            // keep last-good; never blank
    bar.value = v; txt.textContent = v + '%';
  }
  function naBar(bar, txt) { bar.value = 0; txt.textContent = 'N/A'; } // Codex: no % source

  // items are plain strings (model/effort/engine) OR {value,label} objects (permission modes).
  function fill(sel, items, chosen) {
    sel.innerHTML = '';
    (items || []).forEach((it) => {
      const val = typeof it === 'string' ? it : it.value;
      const o = document.createElement('option');
      o.value = val; o.textContent = typeof it === 'string' ? it : it.label;
      if (val === chosen) o.selected = true;
      sel.appendChild(o);
    });
  }
  let lastState;
  function setStatus(d) {
    const s = $('status'); s.textContent = d.detail || d.state;
    s.className = 'status' + (d.state === 'needs-you' ? ' needs-you' : '');
    // On ENTERING needs-you, pull attention to the banner and put the cursor in the
    // composer. Guard on the transition so a repeated needs-you doesn't steal focus mid-answer.
    if (d.state === 'needs-you' && lastState !== 'needs-you') { s.scrollIntoView(); $('input').focus(); }
    lastState = d.state;
  }
  function reflect() {
    // Never disable Start — a dead button reads as "broken". If the workspace is Off or
    // not a master-plan project, the click still fires and the host explains why.
    $('run').textContent = running ? '■ Stop' : '▶ Start';
    $('run').classList.toggle('primary', !running);
    $('discard').hidden = !running; // only offer step-discard while a step is in flight (P06-S06)
  }
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length;
  }

  // ---- Composer wiring ----
  $('run').onclick = () => vscode.postMessage({ type: running ? 'stop' : 'start' });
  $('stop').onclick = () => vscode.postMessage({ type: 'interrupt' });
  $('discard').onclick = () => vscode.postMessage({ type: 'discard' }); // host confirms modally

  $('attach').onclick = () => vscode.postMessage({ type: 'attach' });
  $('mcp').onclick = () => {
    if (!$('mcpmenu').hidden) return closeMcp();        // toggle closed
    vscode.postMessage({ type: 'mcpList' });            // host replies with {kind:'mcp'} → renderMcp opens it
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMcp(); });
  $('engine').onchange = (e) => vscode.postMessage({ type: 'setEngine', value: e.target.value });
  $('model').onchange = (e) => vscode.postMessage({ type: 'setModel', value: e.target.value });
  $('effort').onchange = (e) => vscode.postMessage({ type: 'setEffort', value: e.target.value });
  $('mode').onchange = (e) => vscode.postMessage({ type: 'setMode', value: e.target.value });
  $('thresh').onchange = (e) => vscode.postMessage({ type: 'setThreshold', value: e.target.value });
  function send() {
    const ta = $('input'); const text = ta.value.trim();
    if (!text) return;
    stuck = true;   // sending your own message always pins back to the latest
    bubble('user', text); ta.value = ''; cur = null;
    vscode.postMessage({ type: 'send', text });
  }
  $('jump').onclick = () => scroll(true);   // jump back to latest and re-stick
  $('send').onclick = send;
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
