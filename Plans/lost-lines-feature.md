# Plan: Report of Line Coverage Lost

## PR Summary

This feature adds a `track_lost_lines` input flag that, when enabled, tracks which
previously-covered source lines are no longer covered after a PR's changes. The full
feature includes:

- **`track_lost_lines` input flag** — boolean, default `false`; gates the entire feature
  so there is zero overhead when disabled.
- **`covered_lines` capture** — Cobertura and Clover parsers are updated to populate an
  optional `covered_lines: number[]` field per file only when the flag is on.
- **`coverage-lines.json` artifact** — covered-line arrays are serialized and uploaded as
  an artifact from the base-branch run for later comparison.
- **`git diff` parsing** — line movements across the PR are resolved via hunk parsing so
  base line numbers are mapped to their new positions in the PR head.
- **Per-file and overall lost-lines report** — `computeLostLinesReport` produces a
  `LostLinesReport` with per-file `FileLostLines` entries and aggregate counts/percentages.
- **Template changes** — the `with-base-coverage.hbs` template renders a "Lost Lines"
  column in existing coverage tables and a collapsible details block (shown only when
  `overallLostCount > 0`).
- **PR-head artifact upload** — covered-line data is also uploaded from the PR head run
  to support chained PR comparisons.
- **Exclude-paths filtering** — `excludePaths` input is applied to the lost-lines
  calculation so ignored files are excluded from the report.
- **Renamed-file support** — lost-lines report uses `newPath` (the post-rename path) so
  file entries match the head-coverage file list correctly.

---

## Goal

When a PR's code coverage is compared against the base branch, identify and report any
source lines that were previously covered by tests but are no longer covered. This helps
developers detect unintentional regressions in test coverage at the line level.

---

## Feature Flag

A new action input `track_lost_lines` (boolean, default `false`) gates the entire feature.
When `false` the action behaves exactly as before — no extra computation, no extra artifact
content. Both the base-branch upload and the PR comparison code paths check this flag.

---

## Data Model

### New interface additions (`src/interfaces.ts`)

| Interface | Purpose |
|-----------|---------|
| `LineRange { start, end }` | A contiguous range of line numbers (both ends inclusive). |
| `FileLostLines` | Per-file summary: `file`, `lostRanges`, `baseCoveredCount`, `lostCount`, `lostPercentage`. |
| `LostLinesReport` | Aggregate: `files[]`, `overallBaseCoveredCount`, `overallLostCount`, `overallLostPercentage`. |

`CoverageFile` gains an optional `covered_lines?: number[]` field populated by the parsers
when `track_lost_lines` is enabled.

`Inputs` gains `trackLostLines: boolean`.

`HandlebarContext` gains an optional `lostLinesReport?: LostLinesReport` passed to
templates.

---

## Coverage XML Parsers

Both parsers are updated to extract the actual covered line numbers when the input flag is set.

| Parser | Source attribute | Condition |
|--------|-----------------|-----------|
| Cobertura (`src/reports/cobertura/parser/index.ts`) | `<line number="N" hits="H"/>` | `H > 0` |
| Clover (`src/reports/clover/parser/index.ts`) | `<line num="N" count="C"/>` | `C > 0` |

Line numbers are stored as a sorted `number[]` in `CoverageFile.covered_lines`.

---

## Covered Lines Artifact File

A new JSON file `coverage-lines.json` is written and uploaded alongside the existing
coverage XML when `track_lost_lines=true`.

- **push / schedule / workflow_dispatch**: Uploaded as part of the branch artifact named
  after `GITHUB_REF_NAME`.
- **pull_request / pull_request_target**: Also uploaded using `GITHUB_HEAD_REF` as the
  artifact name. This enables the PR branch to serve as the base for a subsequent PR in a
  chain (i.e. chained PRs can each compare lost lines against their immediate parent).

### Format (compact — uses ranges)

```json
{
  "version": 1,
  "files": {
    "src/main.ts":  [[1,3],[5,7],[10,10]],
    "src/utils.ts": [[1,50],[60,80]]
  }
}
```

Each value is an array of `[start, end]` tuples (inclusive) representing covered line
ranges. Using ranges instead of a flat list of line numbers keeps the file small for large
codebases.

On the PR side, the action looks for `coverage-lines.json` inside the downloaded artifact
directory. If it is absent (artifact was created before this feature was added), the action
logs a warning and skips the lost lines analysis.

---

## Git Diff and Line Mapping

### Command

```
git diff --diff-filter=AMRCD -M -U0 <baseRef>...HEAD
```

| Flag | Purpose |
|------|---------|
| `--diff-filter=AMRCD` | Only show Added, Modified, Renamed, Copied, Deleted files |
| `-M` | Detect renames / moves |
| `-U0` | No context lines — minimises output |
| `<baseRef>...HEAD` | Three-dot diff gives changes on the PR branch since diverging from base |

`execFile` is used instead of `exec` / `execSync` to avoid shell injection. The base ref
is also validated against `/^[a-zA-Z0-9_.\/\-]+$/` before being passed to the command.

### Line Mapping Algorithm

For each file in the diff the hunk headers `@@ -oldStart,oldCount +newStart,newCount @@`
are parsed into a sorted list of `Hunk` objects.

A `lineResolver(oldLine: number): number | null` function is built per file:

1. Walk hunks in order, tracking `cumulativeOffset`.
2. If `oldLine < hunk.oldStart` → return `oldLine + cumulativeOffset` (line unchanged
   relative to this hunk).
3. If `oldLine` falls within `[hunk.oldStart, hunk.oldStart + hunk.oldCount - 1]` →
   return `null` (line was deleted).
4. After each hunk: `cumulativeOffset += newCount - oldCount`.
5. If `oldLine` is after all hunks → return `oldLine + cumulativeOffset`.

Files **not** present in the diff are treated as unchanged; the resolver is the identity
function (`oldLine → oldLine`).

Renamed files: the diff contains `rename from / rename to` headers; the old path is used
as the lookup key and the new path determines which head covered-lines entry to compare
against.

Deleted files (filter `D`): the resolver returns `null` for every line, so no line is
counted as lost.

---

## Computing Lost Lines

```
for each file in baseCoveredLinesMap (after applying excludePaths filter):
    lostLines = []
    resolver = buildLineResolver(gitDiff[file].hunks ?? [])
    headSet  = Set(headCoveredLinesMap[newPath] ?? [])
    for each baseLine in baseCoveredLines[file]:
        newLine = resolver(baseLine)
        if newLine is null:       skip   (line was deleted)
        if newLine not in headSet: record baseLine as lost
    if lostLines non-empty:
        compute lostPercentage = (lost.length / baseCoveredLines.length) * 100
        convert lostLines to ranges
        append FileLostLines entry
```

Note: the `excludePaths` input is applied to the `baseCoveredLinesMap` read from the base
artifact before the comparison begins, so that files explicitly excluded from coverage
reporting are also excluded from lost-lines calculations.

---

## Reporting

### Existing table — new column

When `trackLostLines=true` and a base is available, a **Lost Lines** column is added to
the existing comparison table:

```
| Package | Base Coverage | New Coverage | Difference | Lost Lines |
```

Each row shows the lost-coverage percentage for that file (e.g. `🔴 5% lost (3 lines)`)
or is blank if no lines were lost.

The Overall Coverage row also shows the aggregate lost lines percentage.

### First-5 ranges summary

If any lines were lost, a collapsible `<details>` block is appended **below** the table
(not a new table), listing the **first 5 loss ranges** across all files in a concise
format:

```
<details>
<summary>Lost coverage details (5 of N ranges)</summary>

- `src/foo.ts` lines 10–15, 20–22
- `src/bar.ts` lines 5–7

</details>
```

### Artifact storage of all ranges

A `lost-lines-report.json` file is written locally when there are lost lines on a PR run
so that it can be inspected, and it is included in the markdown output file for auditability.

---

## Code Organisation

All new functions are in `src/lost-lines.ts` with single responsibilities:

| Function | Purpose |
|----------|---------|
| `validateGitRef(ref)` | Returns `true` if the ref contains only safe characters. |
| `getGitDiff(baseRef)` | Runs git diff and returns stdout. |
| `parseGitDiff(output)` | Splits output into per-file `{ newPath, hunks }` entries. |
| `buildLineResolver(hunks)` | Returns a `(oldLine) => number \| null` function. |
| `linesToRanges(lines)` | Converts sorted line numbers to `LineRange[]`. |
| `computeLostLines(base, resolver, headSet)` | Core logic — returns lost line numbers. |
| `computeLostLinesReport(base, head, diff)` | Assembles the full `LostLinesReport`. |
| `coveredLinesToRanges(lines)` | Converts `number[]` to `[number, number][]` for storage. |
| `rangesToLines(ranges)` | Inverse of the above. |

---

## Testing

All new functions have dedicated unit tests in `__tests__/lost-lines.test.ts`.

Coverage for new code targets 100%. Existing tests must continue to pass unchanged.

---

## Backward Compatibility

- When `track_lost_lines=false` (the default), the action is byte-for-byte identical in
  behaviour to the previous version.
- Old artifacts (without `coverage-lines.json`) are handled gracefully: the action warns
  and proceeds without lost-lines analysis.
