# Plan: List of Lines Uncovered

## Overview

This plan describes the implementation needed to detect and report lines of code that were previously covered by tests (in the target branch) but are no longer covered in the pull request under review. The goal is to surface regressions at the line level — not just at the percentage level — so engineers can take targeted action.

---

## 1. High-Level Approach

1. **Guard with an opt-in flag** — the entire line loss feature is disabled unless the new `enable_line_loss_report` input is explicitly set to `true`. This preserves the original action behaviour for all existing users.
2. **Extend the artifact format** to include covered-line ranges per file, stored efficiently as a sorted list of `[start, end]` pairs.
3. **Run `git diff` with file-follow tracking** between the base branch and the PR head to produce a per-file line-number mapping (old line → new line or "deleted").
4. **Cross-reference** the mapped old covered ranges against the PR's new coverage data to find any lines that moved but are no longer covered.
5. **Exclude permanently deleted lines** — only report regressions for lines that still physically exist in the PR's code.
6. **Report results** per file and overall by extending the existing coverage table with new columns, and store all ranges in the artifact.

---

## 2. Optional Feature Flag

### 2a. New Action Input

A new boolean input `enable_line_loss_report` (default: `false`) is added to `action.yml`:

```yaml
enable_line_loss_report:
  description: >
    When true, calculates which previously covered lines are no longer covered
    in the PR, adds the loss columns to the coverage table, and stores all lost
    ranges in the artifact. Requires base coverage artifact to be present.
    Has no effect on push/schedule events (artifact upload only).
  default: 'false'
```

### 2b. Behaviour When Flag Is `false` (Default)

- No `git diff` is executed.
- No `coveredRanges` are computed or stored in the artifact.
- No line loss columns appear in the markdown output.
- The action behaves exactly as it does today.

### 2c. Behaviour When Flag Is `true`

- `coveredRanges` are computed from the coverage XML and included in every uploaded artifact (even on `push`/`schedule` events), so the data is ready for future PR comparisons.
- On pull-request events with a base artifact present, the full line loss analysis runs and the results are surfaced in the markdown and artifact.

### 2d. Flag Check Location

In `src/functions.ts`, the `run()` function checks the flag early:

```typescript
const inputs = getInputs();
if (inputs.enableLineLossReport) {
  // compute coveredRanges from the parsed coverage XML
  // on PR events: also run git diff and computeLostCoverage
  // pass lostCoverage into the Handlebars context
} else {
  // skip all line-loss processing; proceed with original flow
}
```

---


## 3. Data Storage Design

### 3a. What to Store

For each file tracked in coverage, store **covered line ranges** rather than individual line numbers. Ranges reduce the payload size dramatically for files with large contiguous covered blocks.

**Format (JSON, inside the existing coverage artifact):**
```json
{
  "coveredRanges": {
    "src/foo.ts": [[1, 10], [15, 20], [30, 35]],
    "src/bar.ts": [[5, 8]]
  }
}
```

`[start, end]` are **inclusive** 1-based line numbers, matching the convention used by Clover and Cobertura.

### 3b. How to Derive Ranges

At upload time (on `push`/`schedule` events), after parsing the coverage XML:

1. Collect all covered line numbers per file from the parser output.
2. Sort them and merge contiguous or adjacent numbers into ranges.
3. Attach the result to the uploaded artifact JSON.

Cobertura already exposes per-line data (`<line number="N" hits="H" />`); use `hits > 0` to identify covered lines.  
Clover exposes per-line data similarly (`<line num="N" count="C" />`); use `count > 0`.

### 3c. Minimal Data Principle

Using ranges instead of flat lists ensures:
- A file with 1,000 covered lines in a single function produces **one** range entry.
- Data size is bounded by the number of distinct covered *blocks*, not the total line count.

---

## 4. Git Diff Processing

### 4a. Command

```bash
git diff --follow --unified=0 <base_sha>...<head_sha> -- <file>
```

- `--follow` – tracks file renames and moves so that a renamed file's covered lines map correctly.
- `--unified=0` – zero context lines; only changed lines appear, keeping parsing simple.
- Run once per file that appears in the base coverage data.

### 4b. Parsing Unified Diff Hunks

Each hunk header has the form:
```
@@ -old_start[,old_count] +new_start[,new_count] @@
```

Build a **line-number translation table**:

```
oldLine → newLine   (for unchanged lines that shifted due to insertions/deletions above them)
oldLine → DELETED   (for lines present only in the `-` side)
```

Algorithm:

```
offset = 0
for each hunk @@ -os,oc +ns,nc @@:
    # lines [os .. os+oc-1] are affected in the old file
    # lines [ns .. ns+nc-1] are affected in the new file
    for line in unchanged_lines_before_hunk:
        translation[line] = line + offset
    for each removed line r in [os .. os+oc-1]:
        translation[r] = DELETED
    offset += nc - oc   # net insertion/deletion shifts subsequent lines
```

Unchanged lines outside all hunks map as `oldLine + running_offset`.

### 4c. Edge Cases

| Situation | Handling |
|-----------|----------|
| File renamed/moved | `--follow` resolves the new path; use the new path when looking up new coverage |
| File deleted in PR | All old covered lines → DELETED; **not counted as lost coverage** |
| File added in PR | No old covered data → not applicable |
| Binary file | Skip (no line data) |

---

## 5. Lost-Coverage Detection Algorithm

For each file present in **both** the base covered-ranges data and the base-to-PR diff:

```
lostLines = []
for each covered range [s, e] in base data for this file:
    for line in [s .. e]:
        newLine = translation[line]
        if newLine == DELETED:
            continue   # permanently deleted — not a regression
        if newLine NOT covered in PR coverage data:
            lostLines.append(newLine)

merge lostLines into sorted ranges → lostRanges
fileLossPercent = |lostLines| / |all covered lines in base for this file| × 100
```

**Overall loss percentage:**
```
totalLost    = Σ |lostLines| across all files
totalCovered = Σ |covered lines in base| across all files
overallLoss  = totalLost / totalCovered × 100
```

---

## 6. Reporting

### 6a. Markdown Output (PR comment / job summary)

When `enable_line_loss_report` is `true` and base coverage is available, the `with-base-coverage.hbs` template extends the **existing** per-file coverage table with three additional columns after the current ones (`Previously Covered`, `Lost Lines`, `Loss %`). The detailed line ranges are placed in a collapsible `<details>` block below the table.

The existing table currently renders as:

```
| Package | Base | New | Difference |
```

With the feature enabled it becomes:

```
| Package | Base | New | Difference | Previously Covered | Lost Lines | Loss % |
```

Full example:

```
| Package | Base | New | Difference | Previously Covered | Lost Lines | Loss % |
|---------|------|-----|------------|--------------------|------------|--------|
| src/foo.ts | 🟢 95.56% | 🟠 88.89% | -6.67% | 45 | 3 | 6.67% |
| src/bar.ts | 🟢 91.67% | 🟢 83.33% | -8.33% | 120 | 10 | 8.33% |
| **Overall** | **🟢 93.33%** | **🟠 85.45%** | **-7.88%** | **165** | **13** | **7.88%** |
```

When `enable_line_loss_report` is `false` (default) the table is unchanged from the current output.

The first 5 lost-line ranges (when any exist) are displayed in a collapsible block immediately below the table:

```
<details>
<summary>⚠️ First 5 lost-line ranges</summary>

- `src/foo.ts`: lines 18–20
- `src/bar.ts`: lines 34–37, 95–97, 112–113, 200–200

</details>
```

Rules:
- The three extra columns and the `<details>` block are **only rendered when `enable_line_loss_report` is `true`**.
- The `<details>` block is **only rendered when lost lines exist**.
- At most **5 ranges** (across all files, ordered by file then line number) are shown in the summary.
- All ranges are available in the artifact (see §6b).

### 6b. Artifact Contents

The uploaded coverage artifact for the PR run will include an additional `lostCoverageRanges` field:

```json
{
  "coveredRanges": { ... },
  "lostCoverageRanges": {
    "src/foo.ts": [[18, 20]],
    "src/bar.ts": [[34, 37], [95, 97], [112, 113], [200, 200]]
  }
}
```

This lets downstream steps or external tools inspect the full regression data.

---

## 7. Required Code Changes

### 7a. `src/interfaces.ts`

Add new types:
```typescript
export type LineRange = [number, number];   // [startInclusive, endInclusive]
export type CoveredRanges = Record<string, LineRange[]>;

export interface LostCoverageFile {
  fileName: string;
  previouslyCovered: number;
  lostLines: number;
  lossPercent: number;
  lostRanges: LineRange[];
}

export interface LostCoverageSummary {
  files: LostCoverageFile[];
  totalPreviouslyCovered: number;
  totalLost: number;
  overallLossPercent: number;
  first5Ranges: { file: string; range: LineRange }[];
}
```

Extend `HandlebarContext` with an optional `lostCoverage?: LostCoverageSummary` field.

### 7b. `src/reports/clover/parser/index.ts`

Extend the parser to extract per-line covered data and return `coveredRanges` alongside the existing percentage metrics.

### 7c. `src/reports/cobertura/parser/index.ts`

Same as above for Cobertura.

### 7d. New file: `src/diff.ts`

Responsible for:
- Running `git diff --follow --unified=0` via Node `child_process.execSync`.
- Parsing unified diff output into a `Map<number, number | 'DELETED'>` translation table per file.
- Exporting `buildLineTranslationMap(baseSha: string, headSha: string, filePath: string)`.

### 7e. `src/utils.ts`

- `buildCoveredRanges(lines: number[]): LineRange[]` — converts a sorted list of line numbers to ranges.
- `computeLostCoverage(baseRanges: CoveredRanges, newCoverage: Coverage, translationMaps: Map<string, Map<number, number | 'DELETED'>>): LostCoverageSummary` — core cross-referencing logic.
- Update `uploadArtifacts()` to include `coveredRanges` in the uploaded JSON.
- Update `downloadArtifacts()` to read `coveredRanges` from the downloaded JSON.

### 7f. `src/functions.ts`

On pull-request events where base coverage is available and `enable_line_loss_report` is `true`:
1. Call `buildLineTranslationMap` for each file in the base covered ranges.
2. Call `computeLostCoverage`.
3. Pass `lostCoverage` into the Handlebars context.

### 7g. `templates/with-base-coverage.hbs`

Add conditional columns and the `<details>` block described in §6a. The columns are only rendered when `enableLineLossReport` is truthy in the Handlebars context.

### 7h. `action.yml`

Add the `enable_line_loss_report` input described in §2a.

### 7i. Tests

- Unit tests for `buildCoveredRanges` (edge: empty, single line, contiguous, non-contiguous).
- Unit tests for the diff parser in `src/diff.ts` (rename, deletion, insertion, mixed hunks).
- Unit tests for `computeLostCoverage` (all deleted → 0 lost; some deleted some moved; none deleted all moved but not covered).
- Snapshot tests for the updated `with-base-coverage.hbs` template output with flag `true` and flag `false` (verifies original output is unchanged when disabled).

---

## 8. Assumptions and Constraints

| Item | Decision |
|------|----------|
| Feature flag | Defaults to `false`; all line loss logic is completely skipped when `false`. |
| Git availability | `git` binary is always available in GitHub Actions runners. |
| SHA access | `github.sha` (PR head) and `github.event.pull_request.base.sha` are available in the action context. |
| Coverage format | Only Clover and Cobertura are supported (matching existing parsers). |
| Line granularity | Line-level data must be present in the XML; files that only have percentage metrics are skipped. |
| Performance | `git diff` is called once per file in the base coverage; parallelism is not required at MVP. |
| Artifact size | When the flag is `true`, `coveredRanges` is always included in the uploaded artifact (on every event type). `lostCoverageRanges` is always written on PR events too — as an empty object when there are no lost lines, or populated with ranges when losses exist. |

---

## 9. Out of Scope

- Branch-level coverage (only line-level is addressed).
- Support for additional coverage formats beyond Clover and Cobertura.
- Historical trend analysis beyond a single base→PR comparison.
- UI changes to shields.io badges.
