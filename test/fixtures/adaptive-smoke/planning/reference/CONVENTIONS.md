<!-- PLANDOC:CONVENTIONS v1 -->
# Planning conventions — adaptive-effort smoke fixture

- Steps: P<NN>-S<KK>. Sessions: S<NNNN>. Commits for step work are prefixed "P01-S01: ".
- Session log: newest first, the last 3 entries only. This fixture has two steps, so nothing
  ever rotates and planning/archive/ is never needed.
- Plan files are immutable once LOCKED; a deviation is an Amendment in PROGRESS.md.
- Plan close: the last step sets `NEXT: PLAN COMPLETE — run the master-plan skill`.
