# Line-Matching Approach: Hash-Based vs Diff-Based

This document analyses two strategies for determining which previously-covered
lines are **no longer covered** after a pull request lands, and evaluates each
against the two key constraints for this action:

1. **Accuracy** – correctly identify lines that lost coverage.
2. **Minimal stored data** – keep the artifact written to GitHub Actions as
   small as possible.

---

## Background

The action stores per-line coverage information from the *base* commit so that,
when a pull request is evaluated, it can report regression: lines that were
covered before but are no longer covered after the change.

Two approaches exist for matching a base line to its equivalent in the head:

| Approach | Core idea |
|---|---|
| **Hash-based** | Store a hash of each line's content; match by content fingerprint regardless of line number. |
| **Diff-based** | Parse the unified diff of the PR to build a line-number mapping from base → head; use that mapping to check whether the same numbered line is still covered. |

---

## Approach A – Content Hash per Line (current implementation)

### How it works

For every line reported by the coverage tool, the trimmed source text of that
line is hashed (SHA-256) and stored alongside its coverage status.  At
regression-check time the action reads the head source files, builds a
*multiset* of the content hashes of covered lines, and checks whether each
base-covered hash still appears in the head multiset.

### Pros

* **Line-shift resilient.** If lines are inserted or deleted above a covered
  line, its line number changes but its content (and therefore its hash) does
  not.  The match still succeeds without any additional information.
* **No diff required at runtime.** The action does not need to call the GitHub
  API for the PR diff, which avoids an extra network round-trip and keeps the
  workflow simpler.
* **Compact artifact.** The artifact stores only `(lineNumber, SHA-256 hash,
  covered)` triples — no source text is persisted.  A typical TypeScript
  project with ~2 000 instrumented lines produces an artifact in the order of
  ~100 KB of JSON.
* **Handles file-level renames/moves poorly (explicit limitation).** Because
  matching is keyed on the relative file path *plus* content hash, a renamed
  file is treated as a new file and its base coverage is ignored rather than
  misattributed.

### Cons

* **Duplicate-line ambiguity.** When multiple lines share the same trimmed
  content (e.g. `}`, blank lines, `return null;`), the multiset approach
  distributes coverage credit fairly but cannot pinpoint *which* duplicate line
  lost coverage.  The count of lost lines remains correct; only the specific
  line number reported may be approximate.
* **Deleted lines look like lost coverage.** A line that was covered on base
  but has been intentionally deleted in the PR will be reported as a regression
  because its hash no longer appears in the head covered set.  Callers must
  decide whether to treat deleted covered lines as regressions or exemptions.
* **Content-identical refactors cause false negatives.** If a covered line's
  text is changed (e.g. a variable is renamed) the old hash will not match
  the new hash, so the original line is reported as lost even if the new line
  is covered under its updated hash.  This is correct behaviour from a coverage
  standpoint but can produce noise during pure-rename refactors.
* **Requires source files at artifact-build time.** `buildCoverageLineData`
  must read the actual source files to produce hashes.  If the source is not
  present (e.g. coverage was generated in a different working directory), the
  file is silently skipped.

---

## Approach B – Diff-Based Line Mapping

### How it works

The PR unified diff lists every hunk of added and removed lines.  By walking
the diff, a function can construct a mapping `baseLineNumber → headLineNumber`
for every line that survived the change unchanged.  Lines present in the
mapping can be checked for coverage directly by line number; lines absent from
the mapping were deleted.

### Pros

* **Exact line-number identity.** Each surviving base line is mapped to a
  precise head line number, eliminating the duplicate-content ambiguity of the
  hash approach.
* **Deleted lines are distinguishable.** Lines absent from the mapping were
  explicitly removed; they can be excluded from the regression count rather
  than flagged as lost coverage.
* **No source files needed.** The diff itself contains the old and new content,
  so source files do not need to be present in the runner's workspace.

### Cons

* **Extra API call required.** The diff must be fetched from the GitHub API
  (`GET /repos/{owner}/{repo}/pulls/{pull_number}/files` or the raw diff
  endpoint) at regression-check time.  This adds latency, consumes API rate
  limit, and requires an additional permission (`pull-requests: read`).
* **Larger artifact.** To map a base line number to head, the artifact must
  store line numbers (and optionally line content for verification).  Storing
  only line numbers is slightly smaller than storing hashes, but in practice
  the sizes are comparable and the diff payload itself must also be fetched.
* **Diff size limits.** GitHub truncates diffs for very large PRs (>3 000
  changed files or >300 000 changed lines).  A truncated diff means some
  line-number mappings are missing, leading to false regressions for the
  affected files.
* **Context-line sensitivity.** Unified diffs use a fixed number of context
  lines.  If the diff is requested with `--unified=0` to save bandwidth, the
  mapping can still be constructed, but verification requires the full diff
  headers to be parsed correctly.  Any mistake in diff parsing produces
  incorrect line-number mappings and therefore incorrect regression results.
* **Only applicable to pull requests.** On `push` or `schedule` events there
  is no diff to fetch, so a fallback strategy (typically hash-based or
  line-number-only) is still needed for those triggers.

---

## Comparison Against the Key Constraints

### 1. Identifying lines no longer covered

| Criterion | Hash-based | Diff-based |
|---|---|---|
| Survives line-number shifts | ✅ Yes | ✅ Yes (via mapping) |
| Distinguishes deleted vs uncovered lines | ❌ No – both appear as lost | ✅ Yes |
| Handles duplicate-content lines | ⚠️ Count correct, position approximate | ✅ Exact |
| Works without PR diff | ✅ Yes | ❌ No |
| Works on `push`/`schedule` events | ✅ Yes | ❌ Needs fallback |

### 2. Minimal stored data

| Criterion | Hash-based | Diff-based |
|---|---|---|
| Artifact content | `(lineNum, SHA-256, covered)` per line | `(lineNum, covered)` per line |
| Source text stored | ❌ No (hashes only) | ❌ No |
| Extra runtime data fetched | None | PR diff (potentially large) |
| Estimated artifact size (2 000 lines) | ~100 KB JSON | ~70 KB JSON + diff fetch |

Both approaches avoid storing raw source text.  The hash-based artifact is
slightly larger per line (the 64-character hex hash vs a plain integer), but
it avoids fetching any additional data at runtime, keeping total I/O lower.

---

## Recommendation

For this action the **hash-based approach is the better fit**:

* It works uniformly across all event types (`push`, `pull_request`,
  `schedule`) without a fallback strategy.
* It requires no extra API calls or permissions beyond what the action already
  uses.
* Its artifact is self-contained and compact — only hashes and coverage
  status, never source text.
* The known limitation (deleted covered lines counted as lost) is acceptable
  because it errs on the side of caution: it over-reports rather than
  under-reports coverage loss, which is the safer default for a quality-gate
  action.

The diff-based approach would be worth revisiting if the requirement changes to
**exclude deleted lines from the regression count**, since the hash approach
cannot distinguish a deleted covered line from a line whose coverage was simply
dropped.  In that scenario a hybrid strategy — hash-based artifact with an
optional diff-based exclusion pass when a PR diff is available — would give the
best of both worlds at the cost of some additional complexity.
