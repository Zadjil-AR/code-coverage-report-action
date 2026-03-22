# feat: Track and report lines that lost test coverage across PRs

## What This Change Does

This change adds an optional feature to the code coverage report action that detects and
reports source lines that were previously covered by tests on the base branch but are no
longer covered after a pull request's changes. This helps developers catch unintentional
regressions in test coverage at a granular, line-by-line level, complementing the existing
percentage-based coverage reporting.

---

## How to Use It

Add `track_lost_lines: true` to your workflow step:

```yaml
- uses: Zadjil-AR/code-coverage-report-action@main
  with:
    filename: coverage.xml
    token: ${{ secrets.GITHUB_TOKEN }}
    track_lost_lines: true
```

Two optional inputs let you tune how far back git history is fetched to find the merge base:

| Input | Default | Description |
|-------|---------|-------------|
| `lost_lines_merge_base_search_steps` | `10` | Initial fetch depth when searching for the merge base |
| `lost_lines_merge_base_max_depth` | `512` | Maximum fetch depth before giving up |

When the feature is disabled (the default), the action behaves exactly as before — no extra
computation, no extra git calls, no extra output.

---

## What Users See

When `track_lost_lines=true` and a base coverage artifact is available for comparison, a
**Lost Lines** column appears in the existing coverage table:

```
| Package       | Base Coverage | New Coverage | Difference | Lost Lines      |
| ------------- | ------------- | ------------ | ---------- | --------------- |
| src/utils.ts  | 🟢 95%        | 🟢 90%       | 🔴 -5%     | 🔴 -8% (4 lines)|
| Overall Coverage | 🟢 93%     | 🟢 92%       | 🔴 -1%     | 🔴 -2% (4 lines)|
```

If any lines were lost, a collapsible details block is appended below the table showing
the first 5 lost-line ranges across all files:

```
<details>
<summary>Lost coverage details (4 lines lost across 1 file(s))</summary>

- `src/utils.ts`: lines 5–7
- `src/utils.ts`: lines 10–10

</details>
```

Files with no lost lines display a dash (`-`) in the Lost Lines column. The column only
appears when `track_lost_lines=true` and a base is available for comparison.

---

## How It Works

### 1. Parsing covered lines

Both the Cobertura and Clover parsers are extended to capture the actual line numbers of
covered lines (not just the count) when `track_lost_lines=true`:

- **Cobertura**: reads `<line number="N" hits="H"/>` — captures `N` when `H > 0` and only
  parses the `number` attribute when the feature is enabled (no overhead when disabled).
- **Clover**: reads `<line num="N" count="C"/>` — captures `N` when `C > 0`.

Covered line numbers are stored as a sorted `number[]` in `CoverageFile.covered_lines`.

### 2. Git diff and line mapping

When a PR comparison runs with `track_lost_lines=true`, the action calls:

```
git diff --diff-filter=AMRCD -M -U0 <baseRef>...<headRef>
```

Because CI runners often have shallow clones, the action incrementally deepens the fetch
(`--deepen`) until the merge base between base and head is reachable (up to
`lost_lines_merge_base_max_depth`). Debug information about git state is only logged when
the diff command fails and `ACTIONS_STEP_DEBUG` is enabled.

The diff output is parsed into per-file hunk maps. For each file a `lineResolver` function
is built that maps old (base) line numbers to new (head) line numbers, accounting for
insertions and deletions. Lines that were permanently deleted by the diff return `null` and
are excluded from both the numerator and denominator of the lost percentage.

### 3. Computing lost lines

For each file in the base coverage map:

1. Apply the `exclude_paths` filter (same exclusions as the rest of the report).
2. Skip files deleted entirely in the PR (not counted as losses).
3. For each base covered line, resolve its head line number.
4. If the resolved head line is not in the head coverage set → the line is lost.
5. Aggregate per-file and overall lost counts and percentages.

The lost percentage denominator counts only **surviving** base covered lines (i.e. those
not permanently deleted), so a file where half the lines were deleted does not inflate the
loss percentage.

The report also tracks all surviving base covered line counts (including files with zero
losses) so that directory-level percentage aggregations use the correct full denominator.

### 4. Rendering

The `LostLinesReport` is passed to the existing Handlebars templates. The "Lost Lines"
column is conditionally rendered only when the report is present. A pre-built list of the
first 5 lost-line ranges (using head file line numbers) is stored in `previewRanges` on
the report to avoid iterating over all files and all ranges inside the template.

---

## Key Implications

- **No impact when disabled**: all new code paths are guarded by `track_lost_lines=false`
  (the default). Existing users see no change.
- **Extra git calls on PR runs**: when the feature is enabled, additional `git fetch` and
  `git diff` calls are made to establish the diff between base and head. These calls are
  avoided on push/schedule events.
- **Ref validation**: `validateGitRef` rejects refs beginning with `-` to prevent
  option injection into git commands.
- **Denominator accuracy**: the lost percentage at both file and directory level uses only
  surviving covered lines as the denominator, giving an accurate signal even when lines
  are deleted by the PR.

---

## Key Files Changed vs Main Branch

| File | Change |
|------|--------|
| `action.yml` | Adds `track_lost_lines`, `lost_lines_merge_base_search_steps`, `lost_lines_merge_base_max_depth` inputs |
| `src/interfaces.ts` | Adds `FileLostLines`, `LostRangePreview`, `LostLinesReport`, `baseCoveredCountByFile` interfaces; extends `CoverageFile` and `Inputs` |
| `src/lost-lines.ts` | New module: git diff execution, parsing, line mapping, and lost-lines report computation |
| `src/utils.ts` | Extends `parseCoverage` to pass `trackLostLines`; adds `buildCoveredLinesMap`, `filterCoveredLinesMap`; robust default handling for numeric inputs |
| `src/functions.ts` | Wires the feature into action flow, markdown generation, and coverage row formatting; `getInputs()` called once before the event switch |
| `src/reports/cobertura/parser/index.ts` | Captures covered line numbers; `@_number` only parsed when feature is enabled and hits > 0 |
| `src/reports/clover/parser/index.ts` | Captures covered line numbers when feature is enabled |
| `templates/with-base-coverage.hbs` | Adds "Lost Lines" column to per-file and directory tables; collapsible details block |
| `__tests__/lost-lines.test.ts` | Full unit tests for new module |
| `__tests__/utils.test.ts` | Tests for new util functions and input parsing |
| `__tests__/functions.test.ts` | Tests for markdown generation and row formatting with lost lines |
| `__tests__/run.test.ts` | Integration-path tests for `track_lost_lines` flag |
| `jest.config.js` | Custom snapshot serializer for compact `number[]` output |

