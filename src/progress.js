// PROGRESS.md helpers — the tiny bit of Plan Runner's project-store.js the extension needs.
const fs = require('fs');
const path = require('path');
const { POINTER_RE } = require('./constants');

function progressPath(dir) { return path.join(dir, 'PROGRESS.md'); }

// A master-plan project is any folder with a PROGRESS.md at its root.
function isMasterPlan(dir) {
  try { return !!dir && fs.existsSync(progressPath(dir)); } catch { return false; }
}

// The current NEXT pointer, or null if unreadable / not a master-plan project.
function readPointer(dir) {
  try {
    const m = fs.readFileSync(progressPath(dir), 'utf8').match(POINTER_RE);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

module.exports = { progressPath, isMasterPlan, readPointer };
