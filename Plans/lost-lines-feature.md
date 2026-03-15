# Plan: Report of Line Coverage Lost

## PR Summary

This PR adds an optional "lost covered lines" regression report to the action, surfacing
previously-covered source lines that are no longer covered after a PR's changes.

### Core feature
- **`action.yml`** — new `track_lost_lines` boolean input (default `false`); behaviour is
  unchanged when the flag is not set.
- **`src/lost-lines.ts`** — full implementation of `git diff` parsing, line-number mapping,
  and lost-lines computation; Node.js built-in imports use `node:` protocol
  (`node:child_process`, `node:util`); `validateGitRef` rejects leading `-` characters to
  prevent option injection; `computeLostLines` returns `LostLinePair[]` (both base and head
  line numbers); the lost-lines denominator excludes permanently deleted lines so only
  surviving lines count; `extractFileInfo` extracts rename/deletion detection from
  `parseGitDiff`; `buildPreviewRanges` extracts preview-range building from
  `computeLostLinesReport`; `Number.parseInt` used in place of global `parseInt`.
- **`src/utils.ts`** — `parseCoverage` accepts optional `trackLostLines` flag;
  `writeCoveredLinesFile` / `readCoveredLinesFile` helpers manage the `coverage-lines.json`
  artifact; `readCoveredLinesFile` wraps `JSON.parse` in try/catch and validates
  `version`/`files` schema before iterating; `filterCoveredLinesMap` applies `exclude_paths`
  before comparison.
- **`src/functions.ts`** — `getInputs()` called once before the event switch so
  `trackLostLines` and `excludePaths` are available to all paths without duplication;
  `trackLostLines` passed to all `parseCoverage` calls (head and base in PR path; head in
  push/schedule path); `formatLostCoverage` renders `🔴 <n> lines (<pct>%)`;
  `buildLostLinesByFile` and updated `buildCoverageRows` / `addOverallRow` inject lost-lines
  data into the template context.

### Interfaces
- **`src/interfaces.ts`** — `FileLostLines` gains `newLostRanges` (head line numbers for
  display alongside `lostRanges` for artifact audit); new `LostRangePreview` interface;
  `LostLinesReport` gains `previewRanges` (first 5 ranges, head line numbers, precomputed
  for template rendering).

### Parsers
- **`src/reports/clover/parser/index.ts`** — `trackLostLines` flag threaded through all
  internal helpers; `covered_lines` only collected when enabled; single `<line>` element
  normalised to array; `extractCloverCoveredLines` exported for direct unit testing;
  `Number.parseInt` used in place of global `parseInt`.
- **`src/reports/cobertura/parser/index.ts`** — same flag threading; `covered_lines`
  `undefined` when flag is off; non-null assertion replaced with `covered_lines !== undefined`
  guard; `Number.parseInt` used in place of global `parseInt`.

### Template
- **`templates/with-base-coverage.hbs`** — "Lost Lines" column added to per-file and top-dir
  tables; collapsible details block guarded by `{{#if lost_lines_report.overallLostCount}}`
  so it only renders when there are actual losses; details block iterates
  `lost_lines_report.previewRanges` (at most 5 entries) instead of nested loops over all
  files and all ranges.

### Artifact chaining
- On `pull_request` / `pull_request_target` events with `track_lost_lines=true`,
  `coverage-lines.json` is uploaded under the PR head-branch name so subsequent PRs targeting
  this branch can use it as their base (chained PR support).

### Exclude-paths and rename support
- `filterCoveredLinesMap()` applies the `exclude_paths` input to the base covered-lines map
  before the comparison, keeping exclusions consistent across all coverage calculations.
- Lost-lines report entries use `newPath` (the post-rename path) so they match the
  head-coverage file list for renamed/moved files.

### Tests and snapshots
- **`__tests__/number-array-serializer.js`** + **`jest.config.js`** — custom Jest snapshot
  serializer formats `number[]` arrays with 20 items per line; snapshot file shrank from
  2 218 → 523 lines (75% reduction).
- `toMatchSnapshot()` calls added to `parseCoverage` tests with `trackLostLines=true`,
  verifying `covered_lines` arrays are captured correctly in snapshots.
- New fixtures: `clover-package-no-files.xml`, `clover-file-no-lines.xml`,
  `clover-single-line.xml`, `clover-no-path.xml`, `clover-edge-cases.xml`,
  `cobertura-two-classes-same-file.xml` — cover all new parser paths and edge cases.
- `extractCloverCoveredLines` exported for direct unit testing; direct tests added for empty
  input, missing `num` attribute, and missing `count` attribute.
- `validateGitRef` tests cover leading `-`, `--option`, and single `-` rejection.
- `computeLostLines` tests updated for new `LostLinePair` return type; `computeLostLinesReport`
  tests cover new denominator behaviour (deleted lines excluded), `newLostRanges`,
  `previewRanges` capped at 5, and the exact 52-lines/50-deleted/50%-loss scenario.
- `readCoveredLinesFile` tests cover invalid JSON, unexpected version, and missing `files`.
- Imports in `__tests__/lost-lines.test.ts` consolidated at the top of the file; Node.js
  module imports in `__tests__/utils.test.ts` use `node:` protocol.
- Clover parser coverage: branch 86% → 93.22% (+7%), statements/lines 98% → 100%.
- Cobertura parser coverage: statements/lines/functions 81% → 100%.

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
| `validateGitRef(ref)` | Returns `true` if the ref contains only safe characters (rejects leading `-`). |
| `getGitDiff(baseRef)` | Runs git diff and returns stdout. |
| `parseGitDiff(output)` | Splits output into per-file `{ newPath, hunks, deleted }` entries. |
| `extractFileInfo(lines, ...)` | Extracts old/new paths and deleted flag from diff section lines. |
| `buildLineResolver(hunks)` | Returns a `(oldLine) => number \| null` function. |
| `linesToRanges(lines)` | Converts sorted line numbers to `LineRange[]`. |
| `computeLostLines(base, resolver, headSet)` | Core logic — returns `LostLinePair[]` (base + head line). |
| `computeLostLinesReport(base, head, diff)` | Assembles the full `LostLinesReport`. |
| `buildPreviewRanges(files)` | Returns first 5 head-line ranges across all files. |
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
