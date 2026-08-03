// Step claims over git refs — "is anyone mid-flight on this step?", answered by the project's own
// remote with no server. (P18-S01, D-082, CONTRACTS §Claims; research 03 §2.2–§2.6, §6, §7)
//
// The ref is refs/claims/<STEP-ID> and its value is a UNIQUE PARENTLESS COMMIT over the empty tree.
// Both halves are load-bearing:
//   - a commit, not a blob: GitHub answers `fatal error in commit_refs` for a blob-valued ref (§2.3).
//   - parentless and payload-unique: a ref valued by a commit from the project's own history is
//     stolen by fast-forward — whoever is furthest ahead wins, which is no exclusivity at all (§2.1).
// Pure and vscode-free (the src/presence-id.js shape, A-P10-02) and it reads nothing from presence:
// a claim is decided by git alone (INV-4). Nothing calls this until P18-S02.
'use strict';
const { execFileSync } = require('child_process');

// Identical in every git repo, so no object has to be created for the tree.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Mirrors runner.js's FETCH_TIMEOUT_MS. An unreachable host takes 21.1s to fail and
// http.connectTimeout does NOT bound it — the timeout must be imposed by the caller (§6, E13/E13b).
const CLAIM_TIMEOUT_MS = 20000;

// The ONLY reliable signal that a push lost the race. The parenthetical is not stable — four
// phrasings were observed for one single condition (§2.4, enumerated in test/claims.test.js) —
// so the verdict keys on exit ≠ 0 PLUS this marker, never on the reason.
// Exit ≠ 0 with no marker is infrastructure (offline, auth, no origin) → `unreachable`, not `held`.
const REJECTED = /!\s*\[(?:remote\s+)?rejected\]/i;

const claimRef = (step) => `refs/claims/${String(step || '').trim()}`;

function gitIn(cwd, exec, timeout) {
  return (args, input) => String(exec('git', args, {
    cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout, windowsHide: true,
    // Never prompt for credentials: an unattended run must not block on a password dialog.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }) || '');
}

// execFileSync throws on non-zero; git push reports the rejection on stderr.
const output = (e) => `${(e && e.stderr) || ''}${(e && e.stdout) || ''}` || String((e && e.message) || e);

// take → exactly one of 'taken' | 'held' | 'unreachable'. The CAS push IS the read: a clean exit
// means the step was free, so the happy path costs one round trip and never calls holder() (06 §2.2,
// which measured 422.4 ms saved per successful start).
function take(cwd, { step, driver, host, ts } = {},
  { exec = execFileSync, timeout = CLAIM_TIMEOUT_MS, now = () => new Date().toISOString() } = {}) {
  const ref = claimRef(step);
  const git = gitIn(cwd, exec, timeout);
  const payload = `claim ${step}\ndriver: ${driver || ''}\nhost: ${host || ''}\nts: ${ts || now()}\n`;
  let sha;
  try {
    sha = git(['commit-tree', EMPTY_TREE], payload).trim();
  } catch (e) {
    return { verdict: 'unreachable', ref, sha: null, detail: output(e) };
  }
  try {
    // `--force-with-lease=<ref>:` — an EMPTY expectation, i.e. "the ref must not exist". It refuses
    // even when the local ref is stale, and succeeds on a free step (E8b). Belt-and-braces over the
    // unique-value rule, never a substitute for it. An UNLEASED overwrite is banned outright (§4.4): the
    // remote does not protect a claim ref, so the mechanism's integrity rests on never issuing one.
    git(['push', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`]);
    return { verdict: 'taken', ref, sha, detail: '' };
  } catch (e) {
    const detail = output(e);
    return { verdict: REJECTED.test(detail) ? 'held' : 'unreachable', ref, sha, detail };
  }
}

// Release is a plain ref delete (§2.6). A failed delete is NOT fatal — it degrades to the stale
// claim of §4.3, which the holder reclaims automatically on its next run.
function release(cwd, step, { exec = execFileSync, timeout = CLAIM_TIMEOUT_MS } = {}) {
  const ref = claimRef(step);
  try {
    gitIn(cwd, exec, timeout)(['push', 'origin', `:${ref}`]);
    return { released: true, ref, detail: '' };
  } catch (e) {
    return { released: false, ref, detail: output(e) };
  }
}

function parsePayload(body) {
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(body || '');
    return m && m[1].trim() ? m[1].trim() : null;
  };
  return { driver: field('driver'), host: field('host'), ts: field('ts') };
}

// Who holds it, and since when. Called ONLY on a `held` verdict — never on the happy path.
// `ls-remote` needs no fetch, no working tree and no checkout (~0.25s, §2.5). Claim refs are outside
// the default refspec, so reading the PAYLOAD needs the explicit one; if that fetch fails we still
// name the sha rather than going silent — a refusal must say what it saw (INV-7).
function holder(cwd, step, { exec = execFileSync, timeout = CLAIM_TIMEOUT_MS } = {}) {
  const ref = claimRef(step);
  const git = gitIn(cwd, exec, timeout);
  let sha = '';
  try {
    sha = (git(['ls-remote', 'origin', ref]).split(/\s/)[0] || '').trim();
  } catch { return null; }
  if (!sha) return null; // the claim was released between the rejection and this read
  let body = '';
  try {
    git(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
    body = git(['cat-file', 'commit', sha]);
  } catch { /* the sha alone still identifies the claim */ }
  return { step, ref, sha, ...parsePayload(body) };
}

module.exports = { take, release, holder, claimRef, EMPTY_TREE, CLAIM_TIMEOUT_MS };
