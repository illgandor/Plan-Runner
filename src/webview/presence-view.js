// The presence light (P10-S06). A browser IIFE like markdown.js — no exports, so the unit test
// requires it and reads window.*. Peer data is REMOTE input: it is only ever written with
// textContent, never innerHTML, so a peer name containing markup stays literal (D-015).
// See planning/reference/CONTRACTS.md §Webview⇄host for the {kind:'presence', peers} message.
(function () {
  function ago(ts, now) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }

  // Three of the four states; the fourth (unconfigured) never reaches here — the host sends no
  // presence message at all, so chat.js never creates the element (D-039).
  // peers: null = server unreachable (unknown) · [] = nobody else (alone) · [{user, step, state, ts}]
  // Entries may also carry `lane`/`claim` (P20-S02). Both are OPTIONAL for good: an older server
  // strips them and an unlaned driver never sends them, so ABSENT is printed as nothing at all —
  // never as "no claim" (D-090). Silence is unknown here, the same discipline `peers` itself keeps.
  function presenceLabel(peers, now) {
    if (peers == null) return { state: 'unknown', text: '◌ presence unavailable' };
    if (!peers.length) return { state: 'alone', text: '○ only you on this project' };
    const t = now || Date.now();
    return {
      state: 'peer',
      // The state is shown only when it is NOT a live run: "Reno · P03-S10 · waiting · 2m ago".
      // Printing "running" on every peer would be noise, and its absence is what running means here.
      // The lane is only printed when it is NOT the name already shown: D-079 makes them the same
      // string for our own client, so printing both would read "Reno · lane Reno". The claim IS
      // worth its own field even next to the step — a step can run unclaimed (the unreachable
      // fail-open), and a claim outlives the beat's step while the loop is between steps.
      text: '● ' + peers.map((p) => [p.user || 'someone',
        p.lane && p.lane !== p.user ? 'lane ' + p.lane : null, p.step,
        p.state && p.state !== 'running' ? p.state : null,
        p.claim ? 'holds ' + p.claim : null, p.ts ? ago(p.ts, t) : null]
        .filter(Boolean).join(' · ')).join(', '),
    };
  }

  function renderPresence(el, peers, now) {
    const r = presenceLabel(peers, now);
    el.className = 'presence ' + r.state;
    el.textContent = r.text;
  }

  window.presenceLabel = presenceLabel;
  window.renderPresence = renderPresence;
})();
