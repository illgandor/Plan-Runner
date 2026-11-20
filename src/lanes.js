// P26-S05 (D-117): where the OTHER lanes stand, read from their pushed branches — CONTRACTS §Lane view.
// Read only: never writes a file, never checks out a ref, never fetches. It reads what the runner's
// own fetch already left in origin/*. Every git failure becomes that lane's quiet 'unreadable'
// state; nothing here throws into the runner or the panel.
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { progressPath } = require('./progress');
const { lanePointerRe } = require('./constants');

const GIT_TIMEOUT_MS = 10000;

// Every `NEXT[<lane>]:` name in a PROGRESS.md, in file order.
function laneNames(text) {
  return [...new Set([...String(text).matchAll(/^NEXT\[([^\]]+)\]:/gm)].map((m) => m[1].trim()))];
}

// The active plan from the Dashboard row `| PLAN-NN | slug | 🔵 ACTIVE | d/T |` → { nn, total }.
function activePlan(text) {
  const m = String(text).match(/^\|\s*PLAN-(\d+)\s*\|[^\n]*ACTIVE[^\n]*?\|\s*(\d+)\s*\/\s*(\d+)/m);
  return m ? { nn: m[1], total: +m[3] } : null;
}

// Board rows of plan NN whose status cell is ✅ (or owner-gated 👤✅), as step ids.
function doneSteps(text, nn) {
  const out = new Set();
  for (const m of String(text).matchAll(/^\|\s*(P(\d+)-S\w+)\s*\|([^\n]*)$/gm)) {
    if (+m[2] === +nn && m[3].split('|').some((c) => /^(👤)?✅$/.test(c.trim()))) out.add(m[1]);
  }
  return out;
}

// One lane's record. `git` resolves to stdout or throws; `{ skip: true }` on the error means a
// clean "no such path/ref" (exit code), anything else (no binary, timeout) is unreadable.
async function readLane(git, lane, nn, hereDone) {
  const l = lane.toLowerCase();
  const rec = { lane, state: 'no-branch', ref: null, updatedAt: null, next: null, doneThere: [] };
  try {
    const listed = (await git(['for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)%09%(committerdate:unix)', `refs/remotes/origin/${l}`]))
      .split(/\r?\n/).filter(Boolean).map((row) => {
        const [ref, t] = row.split('\t');
        return { ref, updatedAt: +t * 1000 };
      });
    const show = async (ref) => {
      try { return await git(['show', `${ref}:PROGRESS.md`]); } catch (e) {
        if (e && e.skip) return null; throw e;
      }
    };
    const exact = listed.find((r) => r.ref === `origin/${l}/PLAN-${nn}`);
    const candidates = exact ? [exact] : listed;
    for (const c of candidates) {
      const text = await show(c.ref);
      if (text == null) continue;
      const pointer = text.match(lanePointerRe(lane));
      const plan = activePlan(text);
      if (!exact && (!pointer || !plan || +plan.nn !== +nn)) continue;
      const there = doneSteps(text, nn);
      return Object.assign(rec, {
        state: 'found', ref: c.ref, updatedAt: c.updatedAt, next: pointer ? pointer[1].trim() : null,
        doneThere: [...there].filter((id) => !hereDone.has(id)), _done: there,
      });
    }
    return rec;
  } catch {
    return Object.assign(rec, { state: 'unreadable' });
  }
}

// → { lanes: [record…], combined: { plan, done, total } | null }. Unlaned → empty, zero git calls.
async function readLanes(dir, ownLane, { bin = 'git', exec = promisify(execFile) } = {}) {
  let text;
  try { text = fs.readFileSync(progressPath(dir), 'utf8'); } catch { return { lanes: [], combined: null }; }
  const mine = String(ownLane || '').trim().toLowerCase();
  const others = laneNames(text).filter((n) => n.toLowerCase() !== mine);
  if (!others.length) return { lanes: [], combined: null };
  const plan = activePlan(text);
  if (!plan) return { lanes: others.map((lane) => ({ lane, state: 'no-branch', ref: null, updatedAt: null,
    next: null, doneThere: [] })), combined: null };
  const git = async (args) => {
    try {
      return (await exec(bin, args, { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
    } catch (e) {
      // A plain non-zero exit (missing path / ref) is skippable; no binary or a timeout is not.
      throw Object.assign(new Error('git failed'), { skip: typeof (e && e.code) === 'number' && !e.killed });
    }
  };
  const hereDone = doneSteps(text, plan.nn);
  const lanes = await Promise.all(others.map((lane) => readLane(git, lane, plan.nn, hereDone)));
  const all = new Set(hereDone);
  for (const r of lanes) { for (const id of r._done || []) all.add(id); delete r._done; }
  return { lanes, combined: { plan: `PLAN-${plan.nn}`, done: all.size, total: plan.total } };
}

// P26-S06: the panel side. Refresh cadence while the panel is visible and no run is going.
const LANE_REFRESH_MS = 10 * 60 * 1000;

function ago(ts, now) {
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 48 * 60) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

// readLanes' result → §Lane view's panel text. Each line is `pre + steps.text + post` (== `text`);
// `steps` is split out so the panel can expand it to the ids. The two quiet states are `dim`.
function laneView({ lanes, combined }, now = Date.now()) {
  const lines = lanes.map((r) => {
    if (r.state !== 'found') {
      const text = `${r.lane} · ${r.state === 'unreadable' ? "couldn't read" : 'no branch found'}`;
      return { text, dim: true, pre: text, steps: null, post: '' };
    }
    const n = r.doneThere.length;
    const pre = `${r.lane} · NEXT ${r.next || '(none)'} · `;
    const steps = { text: `${n} step${n === 1 ? '' : 's'} done your board doesn't show`, ids: r.doneThere };
    const post = ` · updated ${ago(r.updatedAt, now)} (${r.ref})`;
    return { text: pre + steps.text + post, dim: false, pre, steps, post };
  });
  return { lines, combined: combined ? `${combined.plan}: ${combined.done}/${combined.total} across all lanes` : null };
}

// One refresh in flight at a time: a call while one is live gets that same promise, never a second
// read. Posts only when there are other lanes — an unlaned project never gets a message. Never
// rejects, and nothing awaits it on the run path, so a slow git can't delay a step.
function laneRefresher(post, read = readLanes) {
  let live = null;
  return (dir, ownLane) => live || (live = (async () => {
    try {
      const r = await read(dir, ownLane);
      if (r.lanes.length) post({ kind: 'lanes', ...laneView(r) });
    } catch { /* readLanes never throws; this keeps a panel refresh from ever rejecting */ } finally { live = null; }
  })());
}

module.exports = { readLanes, laneNames, activePlan, doneSteps, laneView, laneRefresher, GIT_TIMEOUT_MS,
  LANE_REFRESH_MS };
