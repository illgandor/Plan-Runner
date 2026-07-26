// Stable project identity for presence (P10-S02). See planning/reference/CONTRACTS.md §Presence
// "Project identity" — the id comes from the git remote so two clones on two machines agree.
// A repo with NO remote falls back to `local/<repo-root-name>` (A-P10-08): it can never be a
// SHARED id, but going dark meant a solo project silently never reached the dashboard at all.
// Not a git repo (or no git) → null, and the caller stays dark.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

// git@github.com:u/r.git · https://github.com/u/r/ · ssh://git@github.com:22/u/r → github.com/u/r
function normalizeRemote(url) {
  let s = String(url || '').trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^/@]+@/, '');                 // git@ / credentials
  s = s.replace(/^([^/:]+):(\d+\/)?/, '$1/');    // SCP form host:owner/repo, and host:port/
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s ? s.toLowerCase() : null;
}

// Never throws: a missing git, a missing origin, or a non-repo cwd are all handled here.
// The `rev-parse` costs a second spawn, so it only runs on the no-remote path — a repo WITH an
// origin still pays exactly one git call, which is what the once-per-loop budget in presence.js
// was sized for.
function projectId(cwd, { exec = execFileSync } = {}) {
  const git = (...args) => {
    try {
      return String(exec('git', args,
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true }));
    } catch { return ''; }
  };
  const remote = normalizeRemote(git('remote', 'get-url', 'origin'));
  if (remote) return remote;
  // `local/` namespaces it so it can never be confused with (or collide with) a real remote id.
  // Two unrelated remote-less repos that share a folder name DO collide — advisory data, and the
  // prefix makes it obvious on the dashboard. Give one of them a remote if that ever matters.
  const root = git('rev-parse', '--show-toplevel').trim();
  return root ? `local/${path.basename(root).toLowerCase()}` : null;
}

// The single on/off switch every later presence step gates on (P10-S03, D-039): dark unless BOTH
// url and token are configured. Pure — the caller reads the three planRunner.presence* settings
// (extension.js from vscode config) and passes them in, so this module stays vscode-free.
function presenceConfig(settings = {}) {
  const url = String(settings.url || '').trim().replace(/\/+$/, '');
  const token = String(settings.token || '').trim();
  if (!url || !token) return null;
  return { url, token, name: String(settings.name || '').trim() };
}

module.exports = { projectId, normalizeRemote, presenceConfig };
