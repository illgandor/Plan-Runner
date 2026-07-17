// Minimal markdown -> DOM renderer for the chat panel (P04-S01, D-015).
// Self-authored instead of vendoring marked+a sanitizer: it builds a whitelisted DOM
// directly (createElement + textContent only), so model output is XSS-safe by construction
// — never assigned to innerHTML, and only ever these tags: p pre code ul ol li em strong h1-4 a br.
// Supports: fenced code, #..#### headings, -/*/1. lists, **bold**/__bold__, *em*/_em_, `code`, [t](url).
(function () {
  // Append inline-formatted nodes for a single line of text into `parent`.
  const INLINE = [
    { re: /`([^`]+)`/, tag: 'code' },       // inline code first: its content is literal, no nesting
    { re: /\*\*([^*]+)\*\*/, tag: 'strong' },
    { re: /__([^_]+)__/, tag: 'strong' },
    { re: /\*([^*]+)\*/, tag: 'em' },
    { re: /_([^_]+)_/, tag: 'em' },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, tag: 'a' },
  ];
  function inline(parent, text) {
    let rest = text;
    while (rest) {
      let best = null;
      for (const p of INLINE) {
        const m = p.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { p, m };
      }
      if (!best) { parent.appendChild(document.createTextNode(rest)); return; }
      const { p, m } = best;
      if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
      if (p.tag === 'code') {
        const c = document.createElement('code'); c.textContent = m[1]; parent.appendChild(c);
      } else if (p.tag === 'a') {
        const a = document.createElement('a'); a.textContent = m[1];
        if (/^(https?:|mailto:)/i.test(m[2])) a.href = m[2];  // whitelist safe schemes only
        parent.appendChild(a);
      } else {
        const e = document.createElement(p.tag); inline(e, m[1]); parent.appendChild(e);
      }
      rest = rest.slice(m.index + m[0].length);
    }
  }

  const isList = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
  const isHead = (l) => /^(#{1,4})\s+/.test(l);
  const isFence = (l) => /^```/.test(l);

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isFence(line)) {                         // fenced code block
        const buf = []; i++;
        while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
        i++;                                        // skip closing fence
        const pre = document.createElement('pre'), code = document.createElement('code');
        code.textContent = buf.join('\n'); pre.appendChild(code); frag.appendChild(pre);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const el = document.createElement('h' + h[1].length);
        inline(el, h[2].trim()); frag.appendChild(el); i++; continue;
      }
      if (isList(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && isList(lines[i])) {
          const li = document.createElement('li');
          inline(li, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); list.appendChild(li); i++;
        }
        frag.appendChild(list); continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }   // blank
      const para = [];                              // paragraph: until blank / block start
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !isFence(lines[i]) && !isHead(lines[i]) && !isList(lines[i])) para.push(lines[i++]);
      const p = document.createElement('p');
      para.forEach((t, idx) => { if (idx) p.appendChild(document.createElement('br')); inline(p, t); });
      frag.appendChild(p);
    }
    return frag;
  }

  window.renderMarkdown = renderMarkdown;
})();
