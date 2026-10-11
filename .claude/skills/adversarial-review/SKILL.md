---
name: adversarial-review
description: Run an adversarial multi-reviewer review of reelscript, or of a change to it, before it ships. Independent reviewers in fixed roles (designer, architecture and modularity, correctness, API and docs, determinism and performance, tests) each try to break it and must bring evidence; a skeptic then tries to refute every finding; what survives is triaged into blockers, fixes and nits. Use before a release, after a large feature, when the user says something "looks off" or "isn't good enough", or when asked for a review, a teardown, a red team or a second opinion. Pass the target as the argument: a commit range ("ec4e99d..HEAD"), a feature ("the keyboard window"), a path, or nothing for the whole repo.
---

# Adversarial review

A review that tries to prove the work is wrong, not that it's fine. Each reviewer is
told the work has defects and their job is to find them; nobody is graded on
agreement. Then a skeptic tries to knock each finding down, so what reaches the user
is real.

This complements `/coherent-state`, which asks "is the product whole and
consistent?". This asks "where is it bad?": ugly, fragile, wrongly built, slow,
untested, or lying.

## 1. Scope

Settle what's under review before anyone starts, and write it in one paragraph that
every reviewer gets verbatim:

- **The target**: a commit range (`git log --oneline A..B`, `git diff --stat A..B`), a
  feature and the files that hold it, or the whole repo.
- **What it claims**: the CHANGELOG entry, README section and commit messages for the
  target. Claims are what reviewers test against.
- **Known complaints**: anything the user has already said about it ("the left hand
  looks backwards", "the font looks tacky"). Reviewers must confirm or refute each and
  find the cause; they're the first findings, not background.
- **How to run it**: build (`npm run build`), the example that exercises it, a
  `preview --at` command for a frame, the test files that cover it.

## 2. Reviewers

Launch the reviewers in parallel, one Agent each, with the brief from
[reviewers.md](reviewers.md) plus the scope paragraph. Pick the roles the target
needs; a visual feature needs the designer, a refactor may not. Default for a feature:
**designer, architecture, correctness, API and docs, determinism and performance,
tests**. Never more than eight agents in all, skeptic included.

Every reviewer works under the same rules, which go into each brief:

- **Adversarial stance.** Assume there are defects. "Looks fine" is not a finding and
  not a result; if a role truly finds nothing, it says what it tried.
- **Evidence or it didn't happen.** Each finding carries at least one of: `file:line`
  with the code quoted, a command and its output, a rendered frame (path, and what's
  wrong in it), or a measured number. No finding rests on taste alone, the designer's
  included: name the reference it falls short of.
- **Severity, honestly.** `blocker` (wrong output, broken promise, data loss, a user
  would notice at once), `fix` (real defect, worth doing before the release), `nit`
  (true but small). Inflating severity is a failure of the review.
- **A concrete fix**, in a sentence or two, for every blocker and fix.
- **Read-only on the repo.** Work in a copy (`git worktree add /tmp/rs-review-<role>
  <ref>`, with `node_modules` symlinked) or in `/tmp`; never edit, commit, push or
  publish. Remove the worktree at the end.
- **Leave the machine as it was.** Don't kill processes you didn't start, don't touch
  caches or browsers outside `/tmp` (no `cache clear`, no Playwright installs, no
  `REELSCRIPT_MODELS` changes), don't use screen or desktop control, don't start
  servers on fixed ports. Clean up what you made.
- **Report format**: a list of findings, each `{ id, role, severity, title, evidence,
  why it matters, fix }`, then a short "tried and found nothing" list.

## 3. Skeptic

When the reviewers are done, give every blocker and fix (not the nits) to one
skeptic agent, with the scope paragraph and the [skeptic brief](reviewers.md#skeptic).
Its job is to refute: reproduce each finding, check whether the evidence shows what's
claimed, whether it's already handled elsewhere, documented as deliberate, or below
the bar. It returns, per finding: `confirmed`, `downgraded` (to what, why),
`refuted` (with the evidence), or `can't tell`.

Drop refuted findings. Keep `can't tell` ones, marked as unverified.

## 4. Triage and report

Merge duplicates across roles (the same defect seen by two reviewers is one finding
with two angles; that's a strong signal). Then write the report:

1. **Verdict** in one line: ship / ship after fixes / don't ship.
2. **Blockers**, then **fixes**, each: what's wrong, the evidence (file:line, frame
   path, command), the fix, and who found it.
3. **Nits**, in one compact list. Most can be ignored; say which, if any, are worth it.
4. **Known complaints**: for each thing the user raised, the cause and the fix.
5. **Refuted**: one line each, so the user sees what was checked and dropped.

Show frames the designer flagged (Read the image) rather than describing them.

## 5. Fixing

Don't fix during the review. After the report, if the user asks (or the request was
"review and fix"), fix blockers and fixes in order, each with a test or a frame that
shows it fixed, and re-run only the roles whose findings changed. A designer finding
is fixed when a new frame shows it fixed, and that frame is looked at.
