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
      <div id="settingsmenu" class="mcpmenu" hidden></div>
      <textarea id="input" placeholder="Message Claude, or answer a step's question…"></textarea>
      <div class="row">
        <button id="attach" title="Attach a file (its path is handed to Claude to read)">📎 Attach</button>
        <button id="mcp" title="MCP servers for the active engine">🔌 MCP</button>
        <button id="settings" title="Plan Runner settings">⚙ Settings</button>
        <button id="help" title="Help — the loop and every control">? Help</button>
        <button id="discard" title="Roll this step's file edits back to how they were at step start" hidden>↺ Discard step changes</button>
        <button id="pause" title="Pause the current turn (Claude only) — Resume continues the same step" hidden>⏸ Pause</button>
        <button id="abort" title="Abort the run now — tear the session down immediately, without finishing the current step" hidden>⏹ Abort run</button>
        <button id="stop" title="Abort the current turn (the step stays)">■ Abort turn</button>
        <button id="send" class="send">Send</button>
      </div>
    </div>
    <div id="helpview" class="helpview" hidden></div>`;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const logoUri = app.dataset.logo || '';   // webview URI of src/webview/logo.png (from html())
  let enabled = false, running = false, engine = 'claude', paused = false;
  let autoSkipSec = 0;   // >0 → question cards auto-Skip after this many seconds (D-028; never permissions)
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
  // Add a copy button to every fenced code block under `root` (P09-S13). Idempotent.
  function addCopyButtons(root) {
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.copy) return;
      pre.dataset.copy = '1';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'code-copy'; btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(() => {
          btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
        }, () => {});
      });
      pre.appendChild(btn);
    });
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
    addCopyButtons(el);
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
    // path/command in the collapsed summary (P04-S03); an absolute-looking path is clickable (P09-S12)
    setTarget(d.querySelector('.tool-target'), msg.input);
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
  // Absolute-looking path: drive-letter (C:\ or C:/), UNC (\\host), or POSIX root (/). (P09-S12)
  function looksLikePath(v) { return typeof v === 'string' && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v); }
  // A span that opens the file in the editor on click; plain text display, full path in the message.
  function pathLink(fullPath, display) {
    const s = document.createElement('span');
    s.className = 'path-link'; s.textContent = display; s.title = fullPath;
    s.onclick = () => vscode.postMessage({ type: 'openFile', path: fullPath });
    return s;
  }
  // Fill a tool-target element: clickable link when its path field is absolute-looking, else plain text.
  function setTarget(elm, input) {
    const full = input && (input.file_path || input.path);   // toolTarget shows these first, so display matches
    if (looksLikePath(full)) elm.appendChild(pathLink(full, toolTarget(input)));
    else elm.textContent = toolTarget(input);
  }
  // Render a file-edit tool's input as a line-based red/green diff — no diff library (P04-S02).
  // Edit → old red / new green; Write → all green; MultiEdit → each edit in sequence.
  function editDiff(name, input) {
    const wrap = document.createElement('div');
    wrap.className = 'diff';
    if (input.file_path) {
      const p = document.createElement('div'); p.className = 'diff-path';
      if (looksLikePath(input.file_path)) p.appendChild(pathLink(input.file_path, input.file_path));
      else p.textContent = input.file_path;   // relative/unusual paths stay plain (P09-S12)
      wrap.appendChild(p);
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
    if (channel === 'session:dialog-request') return askDialog(payload);
    if (channel === 'session:request-cancelled') return deactivateCard(payload.requestId);
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

  // Teardown (Stop/Abort) resolves a card's pending request host-side; the matching card here
  // stops being interactive and becomes read-only history (its request can never be answered now).
  function deactivateCard(requestId) {
    const el = log.querySelector('.perm[data-request-id="' + CSS.escape(String(requestId)) + '"]');
    if (!el || el.classList.contains('ended')) return;
    el.classList.add('ended');
    el.querySelectorAll('button, input, textarea').forEach((b) => { b.disabled = true; });
    const note = document.createElement('div'); note.className = 'perm-ended'; note.textContent = 'session ended';
    const row = el.querySelector('.row');
    if (row) row.replaceWith(note); else el.appendChild(note);
  }

  // Mirror session.js rememberKey (D-029): non-Bash → toolName; Bash → Bash(<first command word>).
  function rememberKey(toolName, input) {
    if (toolName === 'Bash' && input && typeof input.command === 'string') {
      return 'Bash(' + (input.command.trim().split(/\s+/)[0] || '') + ')';
    }
    return toolName;
  }
  function permission(p) {
    const el = document.createElement('div');
    el.className = 'perm';
    el.dataset.requestId = p.requestId;
    const summary = toolTarget(p.input);   // path/command instead of raw JSON (readability, P09-S10)
    el.innerHTML = `<div>Claude wants to use a tool that isn't auto-allowed:</div>
      <div class="tool">${escapeHtml(p.toolName)}${summary ? ' ' + escapeHtml(summary) : ''}</div>
      <div class="row"><button class="allow">Allow</button>` +
      `<button class="allow-always">Allow always</button><button class="deny">Deny</button></div>`;
    el.querySelector('.allow').onclick = () => { vscode.postMessage({ type: 'permission', requestId: p.requestId, decision: 'allow' }); el.remove(); };
    el.querySelector('.deny').onclick = () => { vscode.postMessage({ type: 'permission', requestId: p.requestId, decision: 'deny' }); el.remove(); };
    el.querySelector('.allow-always').onclick = () => {
      vscode.postMessage({ type: 'permission', requestId: p.requestId, decision: 'allow-always' });
      const note = document.createElement('div'); note.className = 'perm-ended';
      note.textContent = 'always allowed this session: ' + rememberKey(p.toolName, p.input);
      el.querySelector('.row').replaceWith(note);
    };
    log.appendChild(el); scroll();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // AskUserQuestion (P06-S07): render each question's options as clickable buttons instead of
  // making you type the answer. Single-select radios (one pick), multiSelect toggles; Submit is
  // enabled once every question has an answer. Skip cancels (the CLI records it as skipped).
  function askDialog(p) {
    const questions = p.questions || [];
    const el = document.createElement('div');
    el.className = 'perm';
    el.dataset.requestId = p.requestId;
    const head = document.createElement('div'); head.textContent = 'Claude needs your input:';
    el.appendChild(head);
    const answers = {};   // question text -> chosen label (string) or labels (array, multiSelect)
    const submit = document.createElement('button');
    const answered = (q) => { const a = answers[q.question]; return Array.isArray(a) ? a.length > 0 : a != null; };
    const refresh = () => { submit.disabled = questions.some((q) => !answered(q)); };
    questions.forEach((q) => {
      const qEl = document.createElement('div'); qEl.className = 'perm-q';
      if (q.header) { const chip = document.createElement('span'); chip.className = 'perm-qchip'; chip.textContent = q.header; qEl.appendChild(chip); }
      const label = document.createElement('div'); label.className = 'perm-qlabel'; label.textContent = q.question;
      qEl.appendChild(label);
      const opts = document.createElement('div'); opts.className = 'perm-opts';
      const picks = new Set(); let otherText = '';   // per-question selection state
      const compute = () => {
        if (q.multiSelect) { const arr = [...picks]; if (otherText) arr.push(otherText); answers[q.question] = arr; }
        else if (otherText) answers[q.question] = otherText;
        else if (picks.size) answers[q.question] = [...picks][0];
        else delete answers[q.question];
        refresh();
      };
      const clearOther = () => { otherText = ''; other.value = ''; other.classList.remove('sel'); };
      (q.options || []).forEach((o) => {
        const wrap = document.createElement('div'); wrap.className = 'perm-opt';
        const b = document.createElement('button');
        b.textContent = o.label;
        if (o.description) b.title = o.description;
        b.onclick = () => {
          if (q.multiSelect) {
            if (picks.has(o.label)) { picks.delete(o.label); b.classList.remove('sel'); }
            else { picks.add(o.label); b.classList.add('sel'); }
          } else {
            picks.clear(); picks.add(o.label); clearOther();
            opts.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
            b.classList.add('sel');
          }
          compute();
        };
        wrap.appendChild(b);
        if (o.description) { const d = document.createElement('div'); d.className = 'perm-odesc'; d.textContent = o.description; wrap.appendChild(d); }
        opts.appendChild(wrap);
      });
      const other = document.createElement('input'); other.className = 'perm-other'; other.placeholder = 'Other…';
      other.oninput = () => {
        otherText = other.value.trim();
        if (!q.multiSelect && otherText) { picks.clear(); opts.querySelectorAll('button').forEach((x) => x.classList.remove('sel')); }
        other.classList.toggle('sel', !!otherText);
        compute();
      };
      other.onkeydown = (e) => { if (e.key === 'Enter' && !submit.disabled) submit.click(); };
      opts.appendChild(other);
      qEl.appendChild(opts); el.appendChild(qEl);
    });
    const row = document.createElement('div'); row.className = 'row';
    submit.className = 'allow'; submit.textContent = 'Submit';
    const doSkip = (auto) => {
      stopCountdown();
      vscode.postMessage({ type: 'dialog', requestId: p.requestId, cancelled: true });
      if (auto) system('■ question auto-skipped (' + autoSkipSec + 's)');
      el.remove();
    };
    submit.onclick = () => { stopCountdown(); vscode.postMessage({ type: 'dialog', requestId: p.requestId, answers }); el.remove(); };
    const skip = document.createElement('button'); skip.textContent = 'Skip';
    skip.onclick = () => doSkip(false);
    row.append(submit, skip);
    // Auto-skip countdown (D-028): unattended question cards Skip at zero; any interaction cancels.
    let timer = null;
    const stopCountdown = () => { if (timer) { clearInterval(timer); timer = null; count.remove(); } };
    const count = document.createElement('span'); count.className = 'perm-count';
    if (autoSkipSec > 0) {
      let left = autoSkipSec;
      count.textContent = 'Auto-skip in ' + left + 's';
      row.appendChild(count);
      timer = setInterval(() => {
        if (--left <= 0) return doSkip(true);
        count.textContent = 'Auto-skip in ' + left + 's';
      }, 1000);
      // Any interaction inside the card cancels the countdown (click any button, type Other).
      ['click', 'input', 'keydown'].forEach((ev) => el.addEventListener(ev, stopCountdown, true));
    }
    el.appendChild(row);
    refresh();
    log.appendChild(el); scroll();
  }

  // ---- Control messages from the extension ----
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.channel) return onSession(d.channel, d.payload);
    switch (d.kind) {
      case 'config':
        fill($('engine'), d.engines, d.engine);
        fill($('model'), d.models, d.model); fill($('effort'), d.efforts, d.effort); fill($('mode'), d.modes, d.mode);
        if (d.version) $('ver').textContent = 'v' + d.version;
        autoSkipSec = d.autoSkipQuestionSeconds || 0;
        engine = d.engine; enabled = d.enabled; reflect(); break;
      case 'enabled': enabled = d.value; reflect(); break;
      case 'status':
        setStatus(d); running = d.state === 'running' || d.state === 'needs-you' || d.state === 'finalizing'; reflect();
        if (d.state === 'needs-you') { const el = ensureAssistant(); } // keep group open for the answer
        break;
      case 'step-started': stepChip('▶ ' + (d.step || 'step')); cur = null; break;
      case 'step-done': stepChip(`✔ ${d.from} → ${d.to}`); cur = null; break;
      case 'done': system('■ ' + (d.detail || d.state)); running = false; paused = false; resetTokens(); reflect(); break;
      case 'usage': usage(d); break;
      case 'paused': paused = true; reflect(); setStatus({ state: 'paused', detail: d.reason }); break;   // still running; badge on the meter
      case 'resumed': paused = false; reflect(); setStatus({ state: 'running', detail: 'Resumed' }); break;
      case 'info': system(d.text); break;
      case 'splash': splash(d.text); break;
      case 'attached': insertAtCursor($('input'), d.paths.map((p) => '@' + p).join(' ') + ' '); break;
      case 'mcp': renderMcp(d.engine, d.servers || []); break;
      case 'settings': renderSettings(d.values || {}); break;
    }
  });

  // ---- In-composer settings popover (P08-S01): edit planRunner.* without leaving the panel ----
  // Reuses the .mcpmenu float. Host owns the values (getSettings/setSetting) + global-config write.
  const SETTINGS = [
    { key: 'pauseThresholdPct', label: 'Pause @ usage %', min: 10, max: 100 },
    { key: 'usagePollSeconds', label: 'Usage poll (seconds)', min: 10, max: 3600 },
    { key: 'finalizeQuietSeconds', label: 'Finalize quiet (seconds)', min: 0, max: 600 },
    { key: 'maxTurns', label: 'Max turns / step (0 = off)', min: 0, max: 1000 },
    { key: 'maxStepsPerRun', label: 'Max steps / run (0 = off)', min: 0, max: 1000 },
    { key: 'stopAtTime', label: 'Stop at time (blank = off)', type: 'time' },
    { key: 'stallNotifySeconds', label: 'Stall notify (seconds, 0 = off)', min: 0, max: 3600 },
    { key: 'autoSkipQuestionSeconds', label: 'Auto-skip question (seconds, 0 = off)', min: 0, max: 3600 },
  ];
  function closeSettings() { $('settingsmenu').hidden = true; }
  function renderSettings(values) {
    const menu = $('settingsmenu');
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'mcp-head'; head.textContent = 'Settings — planRunner';
    menu.appendChild(head);
    SETTINGS.forEach((s) => {
      const row = document.createElement('label'); row.className = 'set-row';
      const name = document.createElement('span'); name.className = 'set-label'; name.textContent = s.label;
      const inp = document.createElement('input');
      inp.type = s.type || 'number';
      if (!s.type) { inp.min = s.min; inp.max = s.max; inp.step = 1; }
      const v = values[s.key];
      inp.value = v == null ? '' : v;
      inp.onchange = () => vscode.postMessage({ type: 'setSetting', key: s.key, value: inp.value });
      row.append(name, inp); menu.appendChild(row);
    });
    menu.hidden = false;
  }

  // ---- In-panel help view (P08-S02): self-contained guide, no host round-trip (D-025) ----
  // Authored as markdown + rendered by the vendored renderer; the logo sits on top.
  const HELP_MD = [
    '# Plan Runner',
    '',
    'Plan Runner autonomously drives a **master-plan** project: it runs your plan one step',
    'at a time, each in a fresh Claude (or Codex) context window. When a step\'s work is',
    'committed and `PROGRESS.md`\'s `NEXT:` pointer advances, it tears the session down and',
    'starts the next step — until the plan is complete.',
    '',
    '## The loop',
    '',
    '- **Start** begins the autonomous run at `PROGRESS.md`\'s next step.',
    '- Each step runs in its own fresh session; a commit + pointer-advance ends it.',
    '- When a step needs you, the status turns to **needs-you** — answer in the composer and the loop continues.',
    '- At a plan boundary, the close-out session first *audits* the finished plan — spot-checking each step against the repo and filing a gap step for anything marked done but unmet — before closing it.',
    '',
    '## Controls',
    '',
    '- **Start / Stop** — Stop is *graceful*: it finishes the current step, then halts.',
    '- **Abort run** — hard abort: tears the session down immediately, mid-step.',
    '- **Abort turn** — interrupts just the current turn (the step stays; you can keep going).',
    '- **Pause / Resume** — hold and resume the same step. *Claude only* (hidden on Codex).',
    '- **Discard step changes** — roll this step\'s file edits back to how they were at step start.',
    '- **Engine / Model / Effort / Mode** — pick the engine (Claude or Codex), its model, reasoning effort, and permission mode.',
    '- **Attach** — hand a file\'s path to Claude to read.',
    '- **MCP** — view, add, and reconnect MCP servers for the active engine.',
    '- **Settings (gear)** — edit every Plan Runner setting in-panel (see below).',
    '- **Send** — send a message, or answer a step\'s question.',
    '',
    '## Usage meter & caps',
    '',
    '- The meter shows **Session** and **Week** account-usage %. **Pause @ N%** holds the loop when usage crosses your threshold, then resumes once it drops back.',
    '- *Claude only*: Codex reports no account usage %, so it shows **N/A** plus a token counter instead.',
    '- **Settings** covers the usage-poll cadence, the finalize-quiet window, and optional run caps (max turns per step, max steps per run, stop-at-time) — all off by default.',
    '',
    '## Where it docks',
    '',
    'Plan Runner lives in a panel. **Drag its tab to the secondary side bar** (the right edge)',
    'to keep it open beside your editor — it stays put across sessions.',
    '',
    '## Self-update',
    '',
    'Side-loaded builds poll GitHub Releases and offer to install a newer `.vsix`, then reload.',
  ].join('\n');
  function closeHelp() { $('helpview').hidden = true; }
  function toggleHelp() {
    const v = $('helpview');
    if (!v.hidden) return closeHelp();          // toggle closed
    closeMcp(); closeSettings();
    if (!v.dataset.built) {                      // build once, lazily
      const bar = document.createElement('div'); bar.className = 'help-bar';
      const close = document.createElement('button'); close.className = 'help-close';
      close.textContent = '✕ Close'; close.onclick = closeHelp;
      bar.appendChild(close); v.appendChild(bar);
      if (logoUri) {
        const img = document.createElement('img');
        img.className = 'help-logo'; img.src = logoUri; img.alt = 'Plan Runner';
        img.onerror = () => img.remove();         // asset missing → hide gracefully
        v.appendChild(img);
      }
      if (window.renderMarkdown) { v.appendChild(window.renderMarkdown(HELP_MD)); addCopyButtons(v); }
      v.dataset.built = '1';
    }
    v.hidden = false; v.scrollTop = 0;
  }

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
    $('abort').hidden = !running;   // hard "Abort run" only while running; ■ Stop (the run toggle) is graceful (P07-S01)
    $('pause').hidden = !running || engine === 'codex'; // Claude-only manual hold (P07-S02, D-023)
    $('pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
    $('run').title = running ? 'Graceful stop — finish the current step, then halt' : 'Start the autonomous loop';
    // Engine is run-scoped (poller + session bind to it) — lock it while running (P09-S04).
    $('engine').disabled = running;
    $('engine').title = running ? 'Stop the run to switch engine' : 'Engine';
  }
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length;
  }

  // ---- Composer wiring ----
  // Codex token counter is per-run: zero it at each run start (and on 'done') so a second run
  // never shows the first run's total (P09-S04).
  function resetTokens() { sessionTokens = 0; $('tokval').textContent = '—'; }
  $('run').onclick = () => { if (!running) resetTokens(); vscode.postMessage({ type: running ? 'stop' : 'start' }); };
  $('abort').onclick = () => vscode.postMessage({ type: 'abort' }); // hard teardown now (P07-S01)
  $('pause').onclick = () => vscode.postMessage({ type: paused ? 'resume' : 'pause' }); // manual hold (P07-S02)
  $('stop').onclick = () => vscode.postMessage({ type: 'interrupt' });
  $('discard').onclick = () => vscode.postMessage({ type: 'discard' }); // host confirms modally

  $('attach').onclick = () => vscode.postMessage({ type: 'attach' });
  $('mcp').onclick = () => {
    if (!$('mcpmenu').hidden) return closeMcp();        // toggle closed
    closeSettings(); closeHelp();
    vscode.postMessage({ type: 'mcpList' });            // host replies with {kind:'mcp'} → renderMcp opens it
  };
  $('settings').onclick = () => {
    if (!$('settingsmenu').hidden) return closeSettings();   // toggle closed
    closeMcp(); closeHelp();
    vscode.postMessage({ type: 'getSettings' });        // host replies with {kind:'settings'} → renderSettings opens it
  };
  $('help').onclick = toggleHelp;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMcp(); closeSettings(); closeHelp(); } });
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
