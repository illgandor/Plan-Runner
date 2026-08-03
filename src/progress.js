// PROGRESS.md helpers — the tiny bit of Plan Runner's project-store.js the extension needs.
const fs = require('fs');
const path = require('path');
const { POINTER_RE, LANE_POINTER_RE, lanePointerRe } = require('./constants');

function progressPath(dir) { return path.join(dir, 'PROGRESS.md'); }

// A master-plan project is any folder with a PROGRESS.md at its root.
function isMasterPlan(dir) {
  try { return !!dir && fs.existsSync(progressPath(dir)); } catch { return false; }
}

// The current NEXT pointer, or null if unreadable / not a master-plan project.
// `lane` (the driver's planRunner.presenceName, D-079) reads that lane's `NEXT[<lane>]:` line.
// With no lane — or on a file with no laned pointer at all — this is byte-for-byte today's reader.
function readPointer(dir, lane) {
  try {
    const text = fs.readFileSync(progressPath(dir), 'utf8');
    const mine = String(lane || '').trim();
    if (mine) {
      const m = text.match(lanePointerRe(mine));
      if (m) return m[1].trim();
      // The file belongs to lanes and none of them is mine: refuse, never guess (D-080).
      if (LANE_POINTER_RE.test(text)) return null;
    }
    const m = text.match(POINTER_RE);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Does this project's PROGRESS.md use lane-qualified pointers? The pointer form IS the mode
// (D-085) — there is no mode setting to read — so this is the one honest answer to "is this
// project non-solo". Unreadable / not a master-plan project reads as solo, exactly as
// readPointer's null does: the caller's existing "no pointer" path already covers that.
function isLaned(dir) {
  try { return LANE_POINTER_RE.test(fs.readFileSync(progressPath(dir), 'utf8')); } catch { return false; }
}

// Overall plan progress from the Dashboard "**All plans: X/Y steps complete.**"
// line, or null if unreadable / line absent (CONTRACTS §PLAN-09).
function readPlanFraction(dir) {
  try {
    const m = fs.readFileSync(progressPath(dir), 'utf8')
      .match(/\*\*All plans:\s*(\d+)\s*\/\s*(\d+)\s+steps? complete/i);
    return m ? { done: +m[1], total: +m[2] } : null;
  } catch { return null; }
}

module.exports = { progressPath, isMasterPlan, readPointer, isLaned, readPlanFraction };
