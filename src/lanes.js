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

module.exports = { readLanes, laneNames, activePlan, doneSteps, GIT_TIMEOUT_MS };
