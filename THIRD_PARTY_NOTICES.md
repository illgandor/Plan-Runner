# Third-party notices

Plan Runner Extension is licensed under the Apache License, Version 2.0 (see `LICENSE`
and `NOTICE`). This file lists third-party material that was adapted into this project,
with the notices its own licence requires (D-098).

Listing something here does not relicense this project. Apache-2.0 remains the licence
of the whole; the MIT terms below govern only the adapted material they name.

---

## mattpocock/skills — `diagnosing-bugs`

- **Source:** https://github.com/mattpocock/skills
- **Licence:** MIT
- **What was adapted:** the `diagnosing-bugs` skill's central method — that a debugging
  session may not proceed to hypotheses until a red-capable, deterministic, fast,
  agent-runnable reproduction command has actually been run, plus the artifact sections
  that method fills in. Adapted (not copied verbatim) into this project's `next-step`
  skill as the Phase-1 rule that governs the runner's `diagnosing` state (P22-S03,
  D-094), and shipped in the vendored copies under `resources/skills/next-step/` and
  `resources/skills-codex/next-step/`.

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
