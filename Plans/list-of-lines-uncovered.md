# Plan: List of Lines Uncovered

## Overview

This plan describes the implementation needed to detect and report lines of code that were previously covered by tests (in the target branch) but are no longer covered in the pull request under review. The goal is to surface regressions at the line level — not just at the percentage level — so engineers can take targeted action.

---

## 1. High-Level Approach

1. **Extend the artifact format** to include covered-line ranges per file, stored efficiently as a sorted list of `[start, end]` pairs.
2. **Run `git diff` with file-follow tracking** between the base branch and the PR head to produce a per-file line-number mapping (old line → new line or "deleted").
3. **Cross-reference** the mapped old covered ranges against the PR's new coverage data to find any lines that moved but are no longer covered.
4. **Exclude permanently deleted lines** — only report regressions for lines that still physically exist in the PR's code.
5. **Report results** per file and overall, display the first 5 loss ranges in the markdown, and store all ranges in the artifact.

---

## 2. Data Storage Design

### 2a. What to Store

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

### 2b. How to Derive Ranges

At upload time (on `push`/`schedule` events), after parsing the coverage XML:

1. Collect all covered line numbers per file from the parser output.
2. Sort them and merge contiguous or adjacent numbers into ranges.
3. Attach the result to the uploaded artifact JSON.

Cobertura already exposes per-line data (`<line number="N" hits="H" />`); use `hits > 0` to identify covered lines.  
Clover exposes per-line data similarly (`<line num="N" count="C" />`); use `count > 0`.

### 2c. Minimal Data Principle

Using ranges instead of flat lists ensures:
- A file with 1,000 covered lines in a single function produces **one** range entry.
- Data size is bounded by the number of distinct covered *blocks*, not the total line count.

---

## 3. Git Diff Processing

### 3a. Command

```bash
git diff --follow --unified=0 <base_sha>...<head_sha> -- <file>
```

- `--follow` – tracks file renames and moves so that a renamed file's covered lines map correctly.
- `--unified=0` – zero context lines; only changed lines appear, keeping parsing simple.
- Run once per file that appears in the base coverage data.

### 3b. Parsing Unified Diff Hunks

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

### 3c. Edge Cases

| Situation | Handling |
|-----------|----------|
| File renamed/moved | `--follow` resolves the new path; use the new path when looking up new coverage |
| File deleted in PR | All old covered lines → DELETED; **not counted as lost coverage** |
| File added in PR | No old covered data → not applicable |
| Binary file | Skip (no line data) |

---

## 4. Lost-Coverage Detection Algorithm

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

## 5. Reporting

### 5a. Markdown Output (PR comment / job summary)

The `with-base-coverage.hbs` template gains a new section beneath the per-file table:

```
### ⚠️ Lines No Longer Covered

| File | Previously Covered | Lost Lines | Loss % |
|------|--------------------|------------|--------|
| src/foo.ts | 45 | 3 | 6.67% |
| src/bar.ts | 120 | 10 | 8.33% |
| **Overall** | **165** | **13** | **7.88%** |

<details>
<summary>First 5 lost-line ranges</summary>

- `src/foo.ts`: lines 18–20
- `src/bar.ts`: lines 34–37, 95–97, 112–113, 200–200

</details>
```

Rules:
- The section is **only rendered when lost lines exist**.
- At most **5 ranges** (across all files, ordered by file then line number) are shown in the summary.
- All ranges are available in the artifact (see §5b).

### 5b. Artifact Contents

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

## 6. Required Code Changes

### 6a. `src/interfaces.ts`

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

### 6b. `src/reports/clover/parser/index.ts`

Extend the parser to extract per-line covered data and return `coveredRanges` alongside the existing percentage metrics.

### 6c. `src/reports/cobertura/parser/index.ts`

Same as above for Cobertura.

### 6d. New file: `src/diff.ts`

Responsible for:
- Running `git diff --follow --unified=0` via Node `child_process.execSync`.
- Parsing unified diff output into a `Map<number, number | 'DELETED'>` translation table per file.
- Exporting `buildLineTranslationMap(baseSha: string, headSha: string, filePath: string)`.

### 6e. `src/utils.ts`

- `buildCoveredRanges(lines: number[]): LineRange[]` — converts a sorted list of line numbers to ranges.
- `computeLostCoverage(baseRanges: CoveredRanges, newCoverage: Coverage, translationMaps: Map<string, Map<number, number | 'DELETED'>>): LostCoverageSummary` — core cross-referencing logic.
- Update `uploadArtifacts()` to include `coveredRanges` in the uploaded JSON.
- Update `downloadArtifacts()` to read `coveredRanges` from the downloaded JSON.

### 6f. `src/functions.ts`

On pull-request events where base coverage is available:
1. Call `buildLineTranslationMap` for each file in the base covered ranges.
2. Call `computeLostCoverage`.
3. Pass `lostCoverage` into the Handlebars context.

### 6g. `templates/with-base-coverage.hbs`

Add the conditional "Lines No Longer Covered" section described in §5a.

### 6h. Tests

- Unit tests for `buildCoveredRanges` (edge: empty, single line, contiguous, non-contiguous).
- Unit tests for the diff parser in `src/diff.ts` (rename, deletion, insertion, mixed hunks).
- Unit tests for `computeLostCoverage` (all deleted → 0 lost; some deleted some moved; none deleted all moved but not covered).
- Snapshot tests for the updated `with-base-coverage.hbs` template output.

---

## 7. Assumptions and Constraints

| Item | Decision |
|------|----------|
| Git availability | `git` binary is always available in GitHub Actions runners. |
| SHA access | `github.sha` (PR head) and `github.event.pull_request.base.sha` are available in the action context. |
| Coverage format | Only Clover and Cobertura are supported (matching existing parsers). |
| Line granularity | Line-level data must be present in the XML; files that only have percentage metrics are skipped. |
| Performance | `git diff` is called once per file in the base coverage; parallelism is not required at MVP. |
| Artifact size | Covered ranges are always written; if there are no lost lines, `lostCoverageRanges` is an empty object. |

---

## 8. Out of Scope

- Branch-level coverage (only line-level is addressed).
- Support for additional coverage formats beyond Clover and Cobertura.
- Historical trend analysis beyond a single base→PR comparison.
- UI changes to shields.io badges.
