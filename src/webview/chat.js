// Plan Runner chat webview. Renders the live SDK session and the autonomous controls.
// Talks to the extension host only via postMessage: it holds no Claude logic itself.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  // ---- Layout ----
  app.innerHTML = `
    <div class="bar">
      <button id="run" class="primary">▶ Start</button>
      <select id="model" title="Model"></select>
      <select id="effort" title="Reasoning effort"></select>
      <select id="mode" title="Permission mode"></select>
      <button id="mcp" title="Configure MCP servers">MCP</button>
      <span class="spacer"></span>
      <span class="chip" id="ctx" hidden>ctx —</span>
    </div>
    <div class="meter" id="meter" hidden>
      <div class="gauge"><span class="glabel">Session</span><progress id="sbar" max="100" value="0"></progress><span class="gpct" id="spct">—</span></div>
      <div class="gauge"><span class="glabel">Week</span><progress id="wbar" max="100" value="0"></progress><span class="gpct" id="wpct">—</span></div>
    </div>
    <div class="status" id="status">Idle</div>
    <div id="log"></div>
    <div class="composer">
      <textarea id="input" placeholder="Message Claude, or answer a step's question…"></textarea>
      <div class="row">
        <button id="attach" title="Attach a file (its path is handed to Claude to read)">📎 Attach</button>
        <button id="stop" title="Interrupt the current turn">■ Stop turn</button>
        <button id="send" class="send">Send</button>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  let enabled = false, running = false;
  let cur = null;                 // current assistant message element being streamed into
  const toolEls = new Map();      // toolUseId -> tool <details> element

  // ---- Rendering helpers ----
  function scroll() { log.scrollTop = log.scrollHeight; }
  function bubble(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    if (text != null) el.textContent = text;
    log.appendChild(el); scroll();
    return el;
  }
  function system(text) { bubble('system', text); }

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
    d.innerHTML = `<summary>🔧 <span class="tool-name"></span></summary><div class="tool-body"></div>`;
    d.querySelector('.tool-name').textContent = msg.name;
    d.querySelector('.tool-body').textContent = JSON.stringify(msg.input || {}, null, 2);
    el.appendChild(d);
    toolEls.set(msg.toolUseId, d);
    scroll();
  }
  function toolResult(msg) {
    const d = toolEls.get(msg.toolUseId);
    if (!d) return;
    const body = document.createElement('div');
    body.className = 'tool-body';
    body.textContent = (msg.isError ? '⛔ ' : '') + String(msg.result || '').slice(0, 4000);
    d.appendChild(body); scroll();
  }

  // ---- SDK message handling (mirrors mapMessage output) ----
  function onSession(channel, payload) {
    if (channel === 'session:permission-request') return permission(payload);
    if (channel !== 'session:message') return;
    const m = payload.msg;
    switch (m.type) {
      case 'init':
        if (m.mcpServers && m.mcpServers.length)
          system('MCP: ' + m.mcpServers.map((s) => `${s.name} (${s.status})`).join(', '));
        break;
      case 'text-delta': appendText(m.text); break;
      case 'assistant-text': if (cur && !cur.dataset.streamed) appendText(m.text); break; // streamed already? skip dupe
      case 'thinking': appendThinking(m.text); break;
      case 'tool-use': toolUse(m); break;
      case 'tool-result': toolResult(m); break;
      case 'result':
        if (m.contextTokens) { const c = $('ctx'); c.hidden = false; c.textContent = 'ctx ' + fmt(m.contextTokens); }
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
        fill($('model'), d.models, d.model); fill($('effort'), d.efforts, d.effort); fill($('mode'), d.modes, d.mode);
        enabled = d.enabled; reflect(); break;
      case 'enabled': enabled = d.value; reflect(); break;
      case 'status':
        setStatus(d); running = d.state === 'running' || d.state === 'needs-you'; reflect();
        if (d.state === 'needs-you') { const el = ensureAssistant(); } // keep group open for the answer
        break;
      case 'step-started': system('▶ ' + (d.step || 'step')); cur = null; break;
      case 'step-done': system(`✔ ${d.from} → ${d.to}`); cur = null; break;
      case 'done': system('■ ' + (d.detail || d.state)); running = false; reflect(); break;
      case 'usage': usage(d); break;
      case 'info': system(d.text); break;
      case 'attached': insertAtCursor($('input'), d.paths.map((p) => '@' + p).join(' ') + ' '); break;
    }
  });
  // Usage meter. Snapshot already keeps last-good, so a null value = "no reading yet";
  // never zero a painted bar (that's the anti-flicker rule from §Usage snapshot).
  function usage(d) {
    $('meter').hidden = false;
    paintBar($('sbar'), $('spct'), d.session);
    paintBar($('wbar'), $('wpct'), d.week);
    const m = $('meter');
    const over = d.max != null && d.max >= d.threshold;
    const warn = d.max != null && d.max >= d.threshold - 10;
    m.classList.toggle('over', over);
    m.classList.toggle('warn', warn && !over);
    m.classList.toggle('paused', !!d.paused); // hook painted by S08
  }
  function paintBar(bar, txt, v) {
    if (v == null) return;            // keep last-good; never blank
    bar.value = v; txt.textContent = v + '%';
  }

  function fill(sel, items, chosen) {
    sel.innerHTML = '';
    (items || []).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (v === chosen) o.selected = true; sel.appendChild(o); });
  }
  function setStatus(d) {
    const s = $('status'); s.textContent = d.detail || d.state;
    s.className = 'status' + (d.state === 'needs-you' ? ' needs-you' : '');
  }
  function reflect() {
    // Never disable Start — a dead button reads as "broken". If the workspace is Off or
    // not a master-plan project, the click still fires and the host explains why.
    $('run').textContent = running ? '■ Stop' : '▶ Start';
    $('run').classList.toggle('primary', !running);
  }
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length;
  }

  // ---- Composer wiring ----
  $('run').onclick = () => vscode.postMessage({ type: running ? 'stop' : 'start' });
  $('stop').onclick = () => vscode.postMessage({ type: 'interrupt' });
  $('attach').onclick = () => vscode.postMessage({ type: 'attach' });
  $('mcp').onclick = () => vscode.postMessage({ type: 'openMcpConfig' });
  $('model').onchange = (e) => vscode.postMessage({ type: 'setModel', value: e.target.value });
  $('effort').onchange = (e) => vscode.postMessage({ type: 'setEffort', value: e.target.value });
  $('mode').onchange = (e) => vscode.postMessage({ type: 'setMode', value: e.target.value });
  function send() {
    const ta = $('input'); const text = ta.value.trim();
    if (!text) return;
    bubble('user', text); ta.value = ''; cur = null;
    vscode.postMessage({ type: 'send', text });
  }
  $('send').onclick = send;
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
