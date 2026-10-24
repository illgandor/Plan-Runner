---
plan: PLAN-01
slug: adaptive-smoke
status: LOCKED
created: 2026-10-24
locked: 2026-10-24
completed: null
predecessor: null
steps: 2
milestones: 1
---
<!-- PLANDOC:PLAN v1 — IMMUTABLE once status: LOCKED (hash recorded by plan_check.py). -->
# PLAN-01 — Adaptive-effort smoke

## 1. Mission
Prove that Plan Runner steps a failing tagged step up one tier, then runs the next step on its
own tag. Adaptive effort is ON for this plan: every step heading carries both tags.

## 4. Locked decisions
- D-001: adaptive effort is on — the tags below are the declaration.

## 7. Steps
### M1 — Smoke
#### [P01-S01] Name the tier that finished  `[S]`  `[deps: —]`  `[owner-gate: no]`  `[model: haiku]`  `[effort: low]`
**Objective:** `tier.txt` holds the exact id of the model that finished this step.
**Context:** none — this step is deliberately trivial; its only job is to fail on the bottom tier.
**Files:** tier.txt
**Approach:**
- FIRST, before anything else: find the exact model id you are running as (your system prompt or
  session header states it). If that id contains `haiku` or `luna`, STOP NOW: write no file, make
  no commit, do not touch PROGRESS.md, and end your turn with the single sentence "I could not
  finish this step on this model." Do NOT write a line starting `NEEDS OWNER:` — this stop is
  the test, and Plan Runner is meant to retry the step one tier up.
- Otherwise: write `tier.txt` containing that model id on one line, then close out as usual.
**Completion criteria:**
- [ ] `tier.txt` exists and names a model id that contains neither `haiku` nor `luna`.
- [ ] Gate `plan-docs` green.
**Verify:** `python planning/tools/plan_check.py` → `0 failure(s)`.
**Carryover:** none.

#### [P01-S02] Mark the plan done  `[S]`  `[deps: P01-S01]`  `[owner-gate: no]`  `[model: sonnet]`  `[effort: medium]`
**Objective:** `done.txt` exists, and the plan is complete.
**Context:** none.
**Files:** done.txt
**Approach:**
- Write `done.txt` containing the exact model id you are running as, on one line.
- This is the plan's last step: close out with `NEXT: PLAN COMPLETE — run the master-plan skill`.
**Completion criteria:**
- [ ] `done.txt` exists and names the running model id.
- [ ] Gate `plan-docs` green.
**Verify:** `python planning/tools/plan_check.py` → `0 failure(s)`.
**Carryover:** none — this is the last step.
