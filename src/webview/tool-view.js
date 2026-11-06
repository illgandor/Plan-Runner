// Readable tool rows (P25-S04). A browser IIFE like presence-view.js — pure, no DOM, assigns its names
// to window so the unit test can require it. See planning/reference/CONTRACTS.md §Chat timeline.
(function () {
  // `mcp__<server>__<tool>` → `<server> · <tool>`; anything else unchanged.
  function toolLabel(name) {
    const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
    return m ? m[1] + ' · ' + m[2] : String(name || '');
  }

  const str = (v) => (v == null ? '' : String(v));
  // Lines in a string, ignoring one trailing newline: '' → 0, 'a\n' → 1, 'a\nb' → 2.
  const lines = (s) => (str(s) ? str(s).replace(/\n$/, '').split('\n').length : 0);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // The short trailing text of a row (§Chat timeline). Edit/Write/TodoWrite read the input, so they
  // can fill at tool-use; Read/Bash/Grep/Glob need the result and return '' until it arrives.
  function toolMeta(name, input, result, isError) {
    if (isError) return 'error';
    const i = input && typeof input === 'object' ? input : {};
    switch (name) {
      case 'Edit': return '+' + lines(i.new_string) + ' −' + lines(i.old_string);
      case 'MultiEdit': {
        let a = 0, d = 0;
        (Array.isArray(i.edits) ? i.edits : []).forEach((e) => {
          a += lines(e && e.new_string); d += lines(e && e.old_string);
        });
        return '+' + a + ' −' + d;
      }
      case 'Write': return '+' + lines(i.content);
      case 'TodoWrite': {
        const t = todoItems(i);
        return t.filter((x) => x.status === 'completed').length + '/' + t.length + ' done';
      }
    }
    if (result == null) return '';
    const r = str(result);
    switch (name) {
      case 'Read': return plural(lines(r), 'line');
      case 'Bash': return r.trim() ? plural(lines(r), 'line') : 'no output';
      case 'Grep': case 'Glob':
        // The tools' own empty answers are one non-empty line — they mean zero, not one.
        if (/^No (files|matches) found/.test(r.trim())) return '0 results';
        return plural(r.split('\n').filter((l) => l.trim()).length, 'result');
    }
    return '';
  }

  // TodoWrite's checklist rows: [{text, status}] from input.todos, status as given.
  function todoItems(input) {
    const todos = input && Array.isArray(input.todos) ? input.todos : [];
    return todos.map((t) => ({ text: str(t && t.content), status: t ? t.status : undefined }));
  }

  // Running agents (P25-S05, D-110). An Agent/Task tool-use runs until its tool-result — or, with
  // input.run_in_background, until the task `done` event whose toolUseId matches. onEvent takes a
  // mapped session message ({type}) or a panel message ({kind}); init/step-started/done reset it.
  const isAgent = (name) => name === 'Agent' || name === 'Task';
  function agentTracker() {
    const live = new Map();   // agent toolUseId → background?
    return {
      onEvent(e) {
        const t = e && (e.type || e.kind);
        if (t === 'init' || t === 'step-started' || t === 'done') live.clear();
        else if (t === 'tool-use' && isAgent(e.name)) live.set(e.toolUseId, !!(e.input && e.input.run_in_background === true));
        else if (t === 'tool-result' && live.get(e.toolUseId) === false) live.delete(e.toolUseId);
        else if (t === 'task' && e.phase === 'done' && live.get(e.toolUseId) === true) live.delete(e.toolUseId);
      },
      get running() { return live.size; },
      get background() { let n = 0; live.forEach((bg) => { if (bg) n++; }); return n; },
    };
  }

  window.toolLabel = toolLabel;
  window.toolMeta = toolMeta;
  window.todoItems = todoItems;
  window.agentTracker = agentTracker;
})();
