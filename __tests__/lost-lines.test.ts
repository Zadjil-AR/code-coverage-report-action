import {
  validateGitRef,
  parseGitDiff,
  buildLineResolver,
  linesToRanges,
  computeLostLines,
  computeLostLinesReport,
  coveredLinesToRanges,
  rangesToLines,
  FileDiff
} from '../src/lost-lines'
import { expect, test, describe } from '@jest/globals'

// ---------------------------------------------------------------------------
// validateGitRef
// ---------------------------------------------------------------------------

describe('validateGitRef', () => {
  test('accepts simple branch name', () => {
    expect(validateGitRef('main')).toBe(true)
  })

  test('accepts branch with slash', () => {
    expect(validateGitRef('feature/my-branch')).toBe(true)
  })

  test('accepts branch with dots and underscore', () => {
    expect(validateGitRef('release_1.2.3')).toBe(true)
  })

  test('rejects branch with space', () => {
    expect(validateGitRef('my branch')).toBe(false)
  })

  test('rejects branch with semicolon', () => {
    expect(validateGitRef('main;echo')).toBe(false)
  })

  test('rejects branch with backtick', () => {
    expect(validateGitRef('`cmd`')).toBe(false)
  })

  test('rejects empty string', () => {
    expect(validateGitRef('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseGitDiff
// ---------------------------------------------------------------------------

describe('parseGitDiff', () => {
  test('returns empty map for empty diff', () => {
    expect(parseGitDiff('').size).toBe(0)
  })

  test('parses a simple modification with one hunk', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc123..def456 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -5,3 +5,2 @@ context',
      '-old line 5',
      '-old line 6',
      '-old line 7',
      '+new line 5',
      '+new line 6'
    ].join('\n')

    const result = parseGitDiff(diff)
    expect(result.size).toBe(1)
    const entry = result.get('src/foo.ts')!
    expect(entry).toBeDefined()
    expect(entry.newPath).toBe('src/foo.ts')
    expect(entry.deleted).toBe(false)
    expect(entry.hunks).toHaveLength(1)
    expect(entry.hunks[0]).toEqual({
      oldStart: 5,
      oldCount: 3,
      newCount: 2
    })
  })

  test('parses a renamed file', () => {
    const diff = [
      'diff --git a/old/path.ts b/new/path.ts',
      'similarity index 90%',
      'rename from old/path.ts',
      'rename to new/path.ts',
      '--- a/old/path.ts',
      '+++ b/new/path.ts',
      '@@ -1,2 +1,2 @@'
    ].join('\n')

    const result = parseGitDiff(diff)
    expect(result.size).toBe(1)
    const entry = result.get('old/path.ts')!
    expect(entry).toBeDefined()
    expect(entry.newPath).toBe('new/path.ts')
  })

  test('marks deleted files', () => {
    const diff = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index abc123..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '-line 1',
      '-line 2',
      '-line 3',
      '-line 4',
      '-line 5'
    ].join('\n')

    const result = parseGitDiff(diff)
    const entry = result.get('src/gone.ts')!
    expect(entry.deleted).toBe(true)
  })

  test('parses multiple files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      '',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -3,2 +3,1 @@'
    ].join('\n')

    const result = parseGitDiff(diff)
    expect(result.size).toBe(2)
    expect(result.has('src/a.ts')).toBe(true)
    expect(result.has('src/b.ts')).toBe(true)
  })

  test('handles hunk header with omitted count (defaults to 1)', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -5 +5 @@',
      '-old',
      '+new'
    ].join('\n')

    const result = parseGitDiff(diff)
    const entry = result.get('src/foo.ts')!
    expect(entry.hunks[0]).toEqual({ oldStart: 5, oldCount: 1, newCount: 1 })
  })
})

// ---------------------------------------------------------------------------
// buildLineResolver
// ---------------------------------------------------------------------------

describe('buildLineResolver', () => {
  test('identity mapping when no hunks (unchanged file)', () => {
    const resolve = buildLineResolver([])
    expect(resolve(1)).toBe(1)
    expect(resolve(100)).toBe(100)
  })

  test('maps unchanged lines before and after a deletion', () => {
    // Lines 3-4 deleted: @@ -3,2 +3,0 @@
    const resolve = buildLineResolver([
      { oldStart: 3, oldCount: 2, newCount: 0 }
    ])
    expect(resolve(1)).toBe(1) // before hunk
    expect(resolve(2)).toBe(2) // before hunk
    expect(resolve(3)).toBe(null) // deleted
    expect(resolve(4)).toBe(null) // deleted
    expect(resolve(5)).toBe(3) // after hunk, shifted by -2
    expect(resolve(10)).toBe(8) // shifted by -2
  })

  test('maps unchanged lines when lines are inserted', () => {
    // 2 lines inserted after line 4: @@ -5,0 +5,2 @@
    const resolve = buildLineResolver([
      { oldStart: 5, oldCount: 0, newCount: 2 }
    ])
    expect(resolve(4)).toBe(4) // before insertion point
    expect(resolve(5)).toBe(7) // shifted by +2
    expect(resolve(6)).toBe(8) // shifted by +2
  })

  test('handles replacement: some lines deleted some added', () => {
    // @@ -5,3 +5,1 @@: 3 old lines → 1 new line (net -2)
    const resolve = buildLineResolver([
      { oldStart: 5, oldCount: 3, newCount: 1 }
    ])
    expect(resolve(4)).toBe(4)
    expect(resolve(5)).toBe(null)
    expect(resolve(6)).toBe(null)
    expect(resolve(7)).toBe(null)
    expect(resolve(8)).toBe(6) // shifted by -2
  })

  test('handles multiple hunks', () => {
    // Hunk 1: @@ -3,1 +3,0 @@ → delete line 3 (offset: -1)
    // Hunk 2: @@ -8,1 +7,2 @@ → replace line 8 with 2 lines (net +1)
    const resolve = buildLineResolver([
      { oldStart: 3, oldCount: 1, newCount: 0 },
      { oldStart: 8, oldCount: 1, newCount: 2 }
    ])
    expect(resolve(2)).toBe(2) // before first hunk
    expect(resolve(3)).toBe(null) // deleted
    expect(resolve(4)).toBe(3) // after hunk1 (-1)
    expect(resolve(7)).toBe(6) // between hunks
    expect(resolve(8)).toBe(null) // in hunk2 (deleted)
    expect(resolve(9)).toBe(9) // after hunk2: -1 + (2-1) = 0
    expect(resolve(10)).toBe(10)
  })

  test('insertion at start of file', () => {
    // 2 lines inserted before line 1: @@ -1,0 +1,2 @@
    const resolve = buildLineResolver([
      { oldStart: 1, oldCount: 0, newCount: 2 }
    ])
    expect(resolve(1)).toBe(3) // shifted by +2
    expect(resolve(5)).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// linesToRanges
// ---------------------------------------------------------------------------

describe('linesToRanges', () => {
  test('returns empty array for empty input', () => {
    expect(linesToRanges([])).toEqual([])
  })

  test('single line becomes single-element range', () => {
    expect(linesToRanges([5])).toEqual([{ start: 5, end: 5 }])
  })

  test('consecutive lines form one range', () => {
    expect(linesToRanges([1, 2, 3])).toEqual([{ start: 1, end: 3 }])
  })

  test('non-consecutive lines form multiple ranges', () => {
    expect(linesToRanges([1, 2, 5, 6, 7, 10])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 },
      { start: 10, end: 10 }
    ])
  })

  test('sorts unsorted input', () => {
    expect(linesToRanges([10, 3, 4, 1])).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 4 },
      { start: 10, end: 10 }
    ])
  })
})

// ---------------------------------------------------------------------------
// computeLostLines
// ---------------------------------------------------------------------------

describe('computeLostLines', () => {
  test('returns empty when all base covered lines are still covered', () => {
    const resolve = buildLineResolver([])
    const headSet = new Set([1, 2, 3])
    expect(computeLostLines([1, 2, 3], resolve, headSet)).toEqual([])
  })

  test('returns lines no longer covered', () => {
    const resolve = buildLineResolver([])
    const headSet = new Set([1, 3]) // line 2 is no longer covered
    expect(computeLostLines([1, 2, 3], resolve, headSet)).toEqual([2])
  })

  test('does not count deleted lines as lost', () => {
    // Line 2 was deleted: resolver returns null for it
    const resolve = buildLineResolver([{ oldStart: 2, oldCount: 1, newCount: 0 }])
    const headSet = new Set([1, 2]) // line 3 became line 2 in new file
    // Old lines 1,2,3: line 2 deleted, line 1→1, line 3→2
    expect(computeLostLines([1, 2, 3], resolve, headSet)).toEqual([])
  })

  test('counts line that moved but is no longer covered', () => {
    // Line 3 moved to line 2, but not in headSet
    const resolve = buildLineResolver([{ oldStart: 2, oldCount: 1, newCount: 0 }])
    const headSet = new Set([1]) // line 2 (was line 3) not covered
    // Old lines 1,2,3: line 2 deleted, line 3→2 (not in headSet)
    expect(computeLostLines([1, 2, 3], resolve, headSet)).toEqual([3])
  })

  test('returns empty when no base covered lines', () => {
    const resolve = buildLineResolver([])
    expect(computeLostLines([], resolve, new Set())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// coveredLinesToRanges / rangesToLines
// ---------------------------------------------------------------------------

describe('coveredLinesToRanges and rangesToLines', () => {
  test('round-trip: lines → ranges → lines', () => {
    const lines = [1, 2, 3, 5, 6, 10]
    const ranges = coveredLinesToRanges(lines)
    expect(ranges).toEqual([
      [1, 3],
      [5, 6],
      [10, 10]
    ])
    const back = rangesToLines(ranges)
    expect(back).toEqual(lines)
  })

  test('single line round-trip', () => {
    const lines = [7]
    expect(rangesToLines(coveredLinesToRanges(lines))).toEqual(lines)
  })

  test('empty input', () => {
    expect(coveredLinesToRanges([])).toEqual([])
    expect(rangesToLines([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// computeLostLinesReport
// ---------------------------------------------------------------------------

describe('computeLostLinesReport', () => {
  test('returns zero counts when nothing is lost', () => {
    const base: Record<string, number[]> = { 'src/a.ts': [1, 2, 3] }
    const head: Record<string, number[]> = { 'src/a.ts': [1, 2, 3] }
    const diff: Map<string, FileDiff> = new Map()

    const report = computeLostLinesReport(base, head, diff)
    expect(report.overallLostCount).toBe(0)
    expect(report.overallLostPercentage).toBe(0)
    expect(report.files).toHaveLength(0)
  })

  test('detects lost lines in an unmodified file', () => {
    // File was not modified (no diff entry), but coverage dropped
    const base: Record<string, number[]> = { 'src/a.ts': [1, 2, 3, 4] }
    const head: Record<string, number[]> = { 'src/a.ts': [1, 2] } // lines 3,4 lost
    const diff: Map<string, FileDiff> = new Map()

    const report = computeLostLinesReport(base, head, diff)
    expect(report.overallLostCount).toBe(2)
    expect(report.overallLostPercentage).toBe(50)
    expect(report.files).toHaveLength(1)
    expect(report.files[0].file).toBe('src/a.ts')
    expect(report.files[0].lostCount).toBe(2)
    expect(report.files[0].baseCoveredCount).toBe(4)
    expect(report.files[0].lostRanges).toEqual([{ start: 3, end: 4 }])
  })

  test('skips deleted files', () => {
    const base: Record<string, number[]> = { 'src/gone.ts': [1, 2, 3] }
    const head: Record<string, number[]> = {}
    const diff: Map<string, FileDiff> = new Map([
      [
        'src/gone.ts',
        {
          newPath: 'src/gone.ts',
          hunks: [{ oldStart: 1, oldCount: 3, newCount: 0 }],
          deleted: true
        }
      ]
    ])

    const report = computeLostLinesReport(base, head, diff)
    expect(report.overallLostCount).toBe(0)
    expect(report.files).toHaveLength(0)
  })

  test('handles renamed files by looking up head lines via newPath', () => {
    const base: Record<string, number[]> = { 'old/foo.ts': [1, 2, 3, 4] }
    // File renamed to new/foo.ts; lines are the same (no structural change)
    const head: Record<string, number[]> = { 'new/foo.ts': [1, 2] } // lines 3,4 lost
    const diff: Map<string, FileDiff> = new Map([
      [
        'old/foo.ts',
        {
          newPath: 'new/foo.ts',
          hunks: [],
          deleted: false
        }
      ]
    ])

    const report = computeLostLinesReport(base, head, diff)
    expect(report.overallLostCount).toBe(2)
    expect(report.files[0].file).toBe('new/foo.ts')
  })

  test('does not count deleted lines from a modified file as lost', () => {
    // Lines 3-4 were deleted from src/a.ts; line 5 moved to 3
    const base: Record<string, number[]> = { 'src/a.ts': [1, 2, 3, 4, 5] }
    const head: Record<string, number[]> = { 'src/a.ts': [1, 2, 3] } // new line 3 is old line 5
    const diff: Map<string, FileDiff> = new Map([
      [
        'src/a.ts',
        {
          newPath: 'src/a.ts',
          hunks: [{ oldStart: 3, oldCount: 2, newCount: 0 }],
          deleted: false
        }
      ]
    ])

    const report = computeLostLinesReport(base, head, diff)
    // Old lines 3 and 4 were deleted (not lost). Old line 5 → new line 3 (covered).
    expect(report.overallLostCount).toBe(0)
  })

  test('accounts for overallBaseCoveredCount across multiple files', () => {
    const base: Record<string, number[]> = {
      'src/a.ts': [1, 2],
      'src/b.ts': [10, 11, 12]
    }
    const head: Record<string, number[]> = {
      'src/a.ts': [1], // line 2 lost
      'src/b.ts': [10, 11, 12] // nothing lost
    }
    const diff: Map<string, FileDiff> = new Map()

    const report = computeLostLinesReport(base, head, diff)
    expect(report.overallBaseCoveredCount).toBe(5)
    expect(report.overallLostCount).toBe(1)
    expect(report.overallLostPercentage).toBe(20)
  })

  test('returns 0% overall when base has no covered lines', () => {
    const report = computeLostLinesReport({}, {}, new Map())
    expect(report.overallLostPercentage).toBe(0)
    expect(report.overallBaseCoveredCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getGitDiff (invalid ref validation)
// ---------------------------------------------------------------------------

import { getGitDiff } from '../src/lost-lines'

describe('getGitDiff', () => {
  test('throws on invalid ref', async () => {
    await expect(getGitDiff('main; rm -rf /')).rejects.toThrow(
      /Invalid git ref/
    )
  })
})

// ---------------------------------------------------------------------------
// parseGitDiff edge cases
// ---------------------------------------------------------------------------

describe('parseGitDiff edge cases', () => {
  test('skips section without valid diff header', () => {
    const diff = 'this is not a valid diff header\nsome content\n'
    const result = parseGitDiff(diff)
    expect(result.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeLostLinesReport - empty baseCoveredLines entry skipped
// ---------------------------------------------------------------------------

describe('computeLostLinesReport with empty entries', () => {
  test('skips files with empty baseCoveredLines array', () => {
    const base: Record<string, number[]> = {
      'src/a.ts': [], // empty — should be skipped
      'src/b.ts': [1, 2]
    }
    const head: Record<string, number[]> = { 'src/b.ts': [1, 2] }
    const diff: Map<string, FileDiff> = new Map()

    const report = computeLostLinesReport(base, head, diff)
    // Only src/b.ts contributes to overallBaseCoveredCount
    expect(report.overallBaseCoveredCount).toBe(2)
    expect(report.overallLostCount).toBe(0)
  })
})

test('getGitDiff with valid ref returns a string (integration)', async () => {
  // HEAD...HEAD diff is always empty but executes the git command
  const result = await getGitDiff('HEAD')
  expect(typeof result).toBe('string')
})
