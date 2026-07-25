// Stable project identity for presence (P10-S02). See planning/reference/CONTRACTS.md §Presence
// "Project identity" — the id comes from the git remote, NEVER a local path, so two clones on two
// machines agree. No remote / not a git repo → null, and the caller stays dark.
'use strict';
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

// Never throws: a missing git, a missing origin, or a non-repo cwd all mean "no identity".
function projectId(cwd, { exec = execFileSync } = {}) {
  try {
    return normalizeRemote(exec('git', ['remote', 'get-url', 'origin'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true }));
  } catch { return null; }
}

module.exports = { projectId, normalizeRemote };
