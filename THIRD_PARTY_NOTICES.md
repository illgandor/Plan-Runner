# Third-party notices

Plan Runner Extension is licensed under the Apache License, Version 2.0 (see `LICENSE`
and `NOTICE`). This file lists third-party material that was adapted into this project,
with the notices its own licence requires (D-098).

Listing something here does not relicense this project. Apache-2.0 remains the licence
of the whole; the MIT terms below govern only the adapted material they name.

---

## mattpocock/skills — `diagnosing-bugs`, `code-review`, `tdd`, `wayfinder`

- **Source:** https://github.com/mattpocock/skills
- **Licence:** MIT
- **What was adapted:** the `diagnosing-bugs` skill's central method — that a debugging
  session may not proceed to hypotheses until a red-capable, deterministic, fast,
  agent-runnable reproduction command has actually been run, plus the artifact sections
  that method fills in. Adapted (not copied verbatim) into this project's `next-step`
  skill as the Phase-1 rule that governs the runner's `diagnosing` state (P22-S03,
  D-094), and shipped in the vendored copies under `resources/skills/next-step/` and
  `resources/skills-codex/next-step/`.
- **What was adapted (second skill):** the `code-review` skill's Standards review axis —
  reviewing code against a repo's own documented standards as a separate axis from the
  spec review, never merged with it, with Fowler's first twelve code smells carried as
  the baseline for a repo that documents nothing, each smell a labelled judgement call
  rather than a hard violation. Adapted (not copied verbatim) into the same `next-step`
  skill as the close-out Standards axis, mandatory on risky step classes (P22-S04,
  D-095).
- **What was adapted (third skill):** the `tdd` skill's named-seam rule — that the public
  boundary a test attaches to is agreed BEFORE the code is written, that a seam is where
  behaviour is observed without reaching inside the unit, and that no test may be written
  at a seam nobody confirmed. Adapted (not copied verbatim) into this project's
  `master-plan` skill as the step template's optional `**Seam:**` field, which the checker
  never enforces (P22-S05, D-096), and shipped in the vendored copies under
  `resources/skills/master-plan/` and `resources/skills-codex/master-plan/`.
- **What was adapted (fourth skill):** the `wayfinder` skill's three-bucket scope model —
  a Destination named first as the line every other bucket is measured against, a
  "not yet specified" fog bucket that is never pre-sliced, an out-of-scope bucket that
  never graduates, and the sharpness test that sorts the first two (can the question be
  stated precisely now, not answered now). The CONCEPT only: none of wayfinder's
  issue-tracker machinery — labels, native blocking edges, assignee-as-claim — was taken,
  since this project deliberately has no tracker. Adapted (not copied verbatim) into this
  project's `master-plan` skill at `references/conversion-rules.md` §Discovery plan
  (P22-S06, D-098), and shipped in the vendored copies under
  `resources/skills/master-plan/` and `resources/skills-codex/master-plan/`.

```
MIT License

Copyright (c) Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
