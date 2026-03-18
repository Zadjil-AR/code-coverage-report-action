import {
  validateGitRef,
  parseGitDiff,
  buildLineResolver,
  linesToRanges,
  computeLostLines,
  computeLostLinesReport,
  getGitDiff,
  fetchRef,
  logGitDebugInfo,
  hasMergeBase,
  fetchRefUntilMergeBase,
  ensureLocalRef,
  INITIAL_FETCH_DEPTH,
  MAX_FETCH_DEPTH,
  _gitExec,
  FileDiff,
  LostLinePair,
  ComputeLostLinesResult
} from '../src/lost-lines'
import { expect, test, describe, jest, afterEach, beforeEach } from '@jest/globals'
import * as core from '@actions/core'

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

  test('rejects ref starting with dash (option-injection prevention)', () => {
    expect(validateGitRef('-n')).toBe(false)
    expect(validateGitRef('--option')).toBe(false)
    expect(validateGitRef('-')).toBe(false)
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
    const result: ComputeLostLinesResult = computeLostLines([1, 2, 3], resolve, headSet)
    expect(result.lostPairs).toEqual([])
    expect(result.survivingCount).toBe(3)
  })

  test('returns pairs for lines no longer covered', () => {
    const resolve = buildLineResolver([])
    const headSet = new Set([1, 3]) // line 2 is no longer covered
    const result: ComputeLostLinesResult = computeLostLines([1, 2, 3], resolve, headSet)
    expect(result.lostPairs).toEqual([{ baseLine: 2, headLine: 2 }])
    expect(result.survivingCount).toBe(3)
  })

  test('does not count deleted lines as lost or surviving', () => {
    // Line 2 was deleted: resolver returns null for it
    const resolve = buildLineResolver([{ oldStart: 2, oldCount: 1, newCount: 0 }])
    const headSet = new Set([1, 2]) // line 3 became line 2 in new file
    // Old lines 1,2,3: line 2 deleted, line 1→1, line 3→2
    const result: ComputeLostLinesResult = computeLostLines([1, 2, 3], resolve, headSet)
    expect(result.lostPairs).toEqual([])
    expect(result.survivingCount).toBe(2) // lines 1 and 3 survive (line 2 deleted)
  })

  test('records both base and head line for a moved uncovered line', () => {
    // Line 3 moved to line 2 (one line deleted before), but is not in headSet
    const resolve = buildLineResolver([{ oldStart: 2, oldCount: 1, newCount: 0 }])
    const headSet = new Set([1]) // line 2 (was line 3) not covered
    // Old lines 1,2,3: line 2 deleted, line 3→2 (not in headSet)
    const result: ComputeLostLinesResult = computeLostLines([1, 2, 3], resolve, headSet)
    expect(result.lostPairs).toEqual([{ baseLine: 3, headLine: 2 }])
    expect(result.survivingCount).toBe(2) // lines 1 and 3 survive (line 2 deleted)
  })

  test('returns empty when no base covered lines', () => {
    const resolve = buildLineResolver([])
    const result: ComputeLostLinesResult = computeLostLines([], resolve, new Set())
    expect(result.lostPairs).toEqual([])
    expect(result.survivingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
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
    expect(report.previewRanges).toEqual([])
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
    // baseCoveredCount = surviving = 4 (no deletions in unmodified file)
    expect(report.files[0].baseCoveredCount).toBe(4)
    expect(report.files[0].lostRanges).toEqual([{ start: 3, end: 4 }])
    // head lines = same as base since no diff
    expect(report.files[0].newLostRanges).toEqual([{ start: 3, end: 4 }])
    // previewRanges should include this range
    expect(report.previewRanges).toEqual([
      { file: 'src/a.ts', start: 3, end: 4 }
    ])
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
    expect(report.overallBaseCoveredCount).toBe(0)
    expect(report.files).toHaveLength(0)
    expect(report.previewRanges).toEqual([])
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
    expect(report.files[0].newLostRanges).toEqual([{ start: 3, end: 4 }])
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
    // Surviving = 3 (lines 1,2,5), lost = 0
    expect(report.overallLostCount).toBe(0)
    expect(report.overallBaseCoveredCount).toBe(3)
  })

  test('denominator excludes permanently deleted lines within a modified file', () => {
    // 52 lines base: 50 are in deleted hunks, 1 loses coverage, 1 keeps coverage → 50%
    const baseLines = Array.from({ length: 52 }, (_, i) => i + 1)
    const base: Record<string, number[]> = { 'src/a.ts': baseLines }
    // Lines 1–50 deleted; line 51→1, line 52→2
    const head: Record<string, number[]> = { 'src/a.ts': [2] } // line 52→2 covered; 51→1 not
    const diff: Map<string, FileDiff> = new Map([
      [
        'src/a.ts',
        {
          newPath: 'src/a.ts',
          hunks: [{ oldStart: 1, oldCount: 50, newCount: 0 }],
          deleted: false
        }
      ]
    ])

    const report = computeLostLinesReport(base, head, diff)
    // Surviving = 2 (lines 51,52); lost = 1 (line 51→1 not in headSet)
    expect(report.overallBaseCoveredCount).toBe(2)
    expect(report.overallLostCount).toBe(1)
    expect(report.overallLostPercentage).toBe(50)
    expect(report.files[0].lostRanges).toEqual([{ start: 51, end: 51 }])
    expect(report.files[0].newLostRanges).toEqual([{ start: 1, end: 1 }])
    expect(report.files[0].baseCoveredCount).toBe(2)
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
    expect(report.previewRanges).toHaveLength(1)
    expect(report.previewRanges[0]).toEqual({ file: 'src/a.ts', start: 2, end: 2 })
  })

  test('returns 0% overall when base has no covered lines', () => {
    const report = computeLostLinesReport({}, {}, new Map())
    expect(report.overallLostPercentage).toBe(0)
    expect(report.overallBaseCoveredCount).toBe(0)
    expect(report.previewRanges).toEqual([])
  })

  test('previewRanges contains at most 5 ranges across all files', () => {
    // Create a report with 3 files, each with 3 lost ranges
    const base: Record<string, number[]> = {
      'src/a.ts': [1, 3, 5, 7, 9, 11],
      'src/b.ts': [1, 3, 5, 7, 9, 11],
      'src/c.ts': [1, 3, 5, 7, 9, 11]
    }
    const head: Record<string, number[]> = {}
    const diff: Map<string, FileDiff> = new Map()

    const report = computeLostLinesReport(base, head, diff)
    // Each file has 6 individual ranges; previewRanges should be capped at 5
    expect(report.previewRanges.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// getGitDiff (invalid ref validation)
// ---------------------------------------------------------------------------

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
    expect(report.previewRanges).toEqual([])
  })
})

test('getGitDiff with valid ref returns a string (integration)', async () => {
  // HEAD...HEAD diff is always empty but executes the git command
  const result = await getGitDiff('HEAD', 'HEAD')
  expect(typeof result).toBe('string')
})

// ---------------------------------------------------------------------------
// ensureLocalRef (unit)
// ---------------------------------------------------------------------------

describe('ensureLocalRef', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('calls git update-ref to create a local branch from the remote-tracking ref', async () => {
    const spy = jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValue({ stdout: '', stderr: '' } as any)

    await ensureLocalRef('main')

    expect(spy).toHaveBeenCalledWith('git', [
      'update-ref',
      'refs/heads/main',
      'refs/remotes/origin/main'
    ])
  })

  test('works for a slash-separated branch name (e.g. feature/xyz)', async () => {
    const spy = jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValue({ stdout: '', stderr: '' } as any)

    await ensureLocalRef('feature/xyz')

    expect(spy).toHaveBeenCalledWith('git', [
      'update-ref',
      'refs/heads/feature/xyz',
      'refs/remotes/origin/feature/xyz'
    ])
  })

  test('does not throw when git update-ref fails (remote-tracking ref may not exist)', async () => {
    jest
      .spyOn(_gitExec, 'run')
      .mockRejectedValue(new Error('no remote-tracking ref') as any)

    await expect(ensureLocalRef('main')).resolves.toBeUndefined()
  })

  test('throws when passed an invalid ref (injection prevention)', async () => {
    await expect(ensureLocalRef('-bad')).rejects.toThrow('Invalid git ref')
    await expect(ensureLocalRef('main;echo')).rejects.toThrow('Invalid git ref')
  })

  test('logs a debug message on success', async () => {
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {})
    jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValue({ stdout: '', stderr: '' } as any)

    await ensureLocalRef('main')

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Ensured local ref 'refs/heads/main'")
    )
  })

  test('logs a debug message when update-ref fails', async () => {
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {})
    jest
      .spyOn(_gitExec, 'run')
      .mockRejectedValue(new Error('not found') as any)

    await ensureLocalRef('main')

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not create/update local ref 'refs/heads/main'")
    )
  })
})

// ---------------------------------------------------------------------------
// fetchRef (unit — spy on _gitExec.run for determinism)
// ---------------------------------------------------------------------------

describe('fetchRef', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('calls git fetch with depth=1 and the given ref', async () => {
    const spy = jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValue({ stdout: '', stderr: '' } as any)
    await fetchRef('main')
    expect(spy).toHaveBeenCalledWith('git', [
      'fetch',
      '--depth=1',
      'origin',
      'main'
    ])
  })

  test('propagates errors from git fetch', async () => {
    jest
      .spyOn(_gitExec, 'run')
      .mockRejectedValue(new Error('remote not found') as any)
    await expect(fetchRef('main')).rejects.toThrow('remote not found')
  })
})

// ---------------------------------------------------------------------------
// hasMergeBase (unit)
// ---------------------------------------------------------------------------

describe('hasMergeBase', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('returns true when git merge-base exits 0', async () => {
    jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValue({ stdout: 'abc1234\n', stderr: '' } as any)
    const result = await hasMergeBase('main', 'feature/xyz')
    expect(result).toBe(true)
  })

  test('returns false when git merge-base exits non-zero', async () => {
    jest
      .spyOn(_gitExec, 'run')
      .mockRejectedValue(new Error('no common ancestor') as any)
    const result = await hasMergeBase('main', 'feature/xyz')
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fetchRefUntilMergeBase (unit)
// ---------------------------------------------------------------------------

describe('fetchRefUntilMergeBase', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('fetches once when merge base is found on the first attempt', async () => {
    const spy = jest
      .spyOn(_gitExec, 'run')
      // git fetch --depth=INITIAL_FETCH_DEPTH origin baseRef headRef
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(baseRef): git update-ref
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(headRef): git update-ref
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // hasMergeBase: git merge-base → success
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' } as any)

    await fetchRefUntilMergeBase('main', 'feature/xyz')

    expect(spy).toHaveBeenCalledWith('git', [
      'fetch',
      `--depth=${INITIAL_FETCH_DEPTH}`,
      'origin',
      'main',
      'feature/xyz'
    ])
    expect(spy).toHaveBeenCalledWith('git', [
      'update-ref',
      'refs/heads/main',
      'refs/remotes/origin/main'
    ])
    expect(spy).toHaveBeenCalledWith('git', [
      'update-ref',
      'refs/heads/feature/xyz',
      'refs/remotes/origin/feature/xyz'
    ])
    expect(spy).toHaveBeenCalledTimes(4)
  })

  test('deepens depth when merge base is not found on the first attempt', async () => {
    const spy = jest
      .spyOn(_gitExec, 'run')
      // iteration 1: fetch --depth=10 both refs
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(baseRef)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(headRef)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // hasMergeBase → not found
      .mockRejectedValueOnce(new Error('no common ancestor') as never)
      // iteration 2: fetch --deepen=10 both refs
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(baseRef)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // ensureLocalRef(headRef)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // hasMergeBase → found
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' } as any)

    await fetchRefUntilMergeBase('main', 'feature/xyz')

    expect(spy).toHaveBeenNthCalledWith(1, 'git', [
      'fetch',
      `--depth=${INITIAL_FETCH_DEPTH}`,
      'origin',
      'main',
      'feature/xyz'
    ])
    expect(spy).toHaveBeenNthCalledWith(5, 'git', [
      'fetch',
      `--deepen=${INITIAL_FETCH_DEPTH}`,
      'origin',
      'main',
      'feature/xyz'
    ])
    expect(spy).toHaveBeenCalledTimes(8)
  })

  test('stops and does not throw when MAX_FETCH_DEPTH is exceeded without finding merge base', async () => {
    // Build a spy that always returns "no merge base" so the loop exhausts.
    // With INITIAL=10, MAX=512 the iterations use depths 10,20,40,80,160,320 (all ≤ MAX),
    // then depth doubles to 640 > MAX and the loop exits — 6 fetch+check pairs total.
    // The first fetch uses --depth=, subsequent fetches use --deepen= (deepen by depth/2).
    const spy = jest.spyOn(_gitExec, 'run').mockImplementation(async (_cmd, args) => {
      const argList = args as string[]
      const isFetch = argList[0] === 'fetch'
      const isUpdateRef = argList[0] === 'update-ref'
      if (isFetch || isUpdateRef) return { stdout: '', stderr: '' } as any
      throw new Error('no common ancestor')
    })

    await expect(fetchRefUntilMergeBase('main', 'feature/xyz')).resolves.toBeUndefined()

    // Verify all fetch flag values are within bounds:
    // first uses --depth=INITIAL, rest use --deepen=(depth/2) which are all ≤ MAX/2
    const fetchCalls = spy.mock.calls.filter(
      ([_cmd, args]) => Array.isArray(args) && (args as string[])[0] === 'fetch'
    )
    for (const [_cmd, args] of fetchCalls) {
      const argList = args as string[]
      const flagArg = argList.find(a => a.startsWith('--depth=') || a.startsWith('--deepen='))!
      const value = Number.parseInt(flagArg.split('=')[1], 10)
      expect(value).toBeLessThanOrEqual(MAX_FETCH_DEPTH)
    }
  })
})

// ---------------------------------------------------------------------------
// getGitDiff — always fetches before diff (unit)
// ---------------------------------------------------------------------------

describe('getGitDiff with missing base ref', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('always calls fetchRefUntilMergeBase and then diffs', async () => {
    // Sequence of _gitExec.run calls:
    //   1. fetchRefUntilMergeBase: git fetch --depth=10 → success
    //   2. fetchRefUntilMergeBase: ensureLocalRef(main) update-ref → success
    //   3. fetchRefUntilMergeBase: ensureLocalRef(feature/xyz) update-ref → success
    //   4. fetchRefUntilMergeBase: hasMergeBase → found
    //   5. logGitDebugInfo: git log → success
    //   6. logGitDebugInfo: git branch -a → success
    //   7. logGitDebugInfo: git merge-base → success
    //   8. git diff → success
    const spy = jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // git fetch
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef main
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef feature/xyz
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)        // hasMergeBase (found)
      .mockResolvedValueOnce({ stdout: 'abc commit\n', stderr: '' } as any) // git log
      .mockResolvedValueOnce({ stdout: '* main\n', stderr: '' } as any)     // git branch -a
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)        // git merge-base (logGitDebugInfo)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // git diff

    const result = await getGitDiff('main', 'feature/xyz')

    expect(result).toBe('')
    // Verify fetch was invoked with both refs in a single call
    expect(spy).toHaveBeenCalledWith('git', [
      'fetch',
      `--depth=${INITIAL_FETCH_DEPTH}`,
      'origin',
      'main',
      'feature/xyz'
    ])
    // Verify diff used bare branch names
    expect(spy).toHaveBeenCalledWith('git', [
      'diff',
      '--diff-filter=AMRCD',
      '-M',
      '-U0',
      'main...feature/xyz',
      '--'
    ])
    expect(spy).toHaveBeenCalledTimes(8)
  })

  test('deepens fetch when merge base is not found on the first attempt', async () => {
    // Sequence:
    //   1.  fetch --depth=10 → success
    //   2.  ensureLocalRef main → success
    //   3.  ensureLocalRef feature/xyz → success
    //   4.  hasMergeBase → not found
    //   5.  fetch --deepen=10 → success
    //   6.  ensureLocalRef main → success
    //   7.  ensureLocalRef feature/xyz → success
    //   8.  hasMergeBase → found
    //   9.  logGitDebugInfo: git log → success
    //   10. logGitDebugInfo: git branch -a → success
    //   11. logGitDebugInfo: git merge-base → success
    //   12. git diff → success
    const spy = jest
      .spyOn(_gitExec, 'run')
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // fetch depth=10
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef main
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef feature/xyz
      .mockRejectedValueOnce(new Error('no merge base') as never)          // hasMergeBase (miss)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // fetch deepen=10
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef main
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // ensureLocalRef feature/xyz
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)        // hasMergeBase (found)
      .mockResolvedValueOnce({ stdout: 'abc commit\n', stderr: '' } as any) // git log
      .mockResolvedValueOnce({ stdout: '* main\n', stderr: '' } as any)     // git branch -a
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)        // git merge-base
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)             // git diff

    const result = await getGitDiff('main', 'feature/xyz')

    expect(result).toBe('')
    expect(spy).toHaveBeenCalledTimes(12)
  })

  test('throws when baseRef is invalid', async () => {
    await expect(getGitDiff('-bad', 'feature/xyz')).rejects.toThrow('Invalid git ref')
  })

  test('throws when headRef is invalid', async () => {
    await expect(getGitDiff('main', '-bad')).rejects.toThrow('Invalid git ref')
  })
})

// ---------------------------------------------------------------------------
// logGitDebugInfo (unit)
// ---------------------------------------------------------------------------

describe('logGitDebugInfo', () => {
  let debugSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    debugSpy = jest.spyOn(core, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('logs recent commits, all branches and merge-base when all commands succeed', async () => {
    jest
      .spyOn(_gitExec, 'run')
      // git log
      .mockResolvedValueOnce({ stdout: 'abc1234 first commit\ndef5678 second commit\n', stderr: '' } as any)
      // git branch -a
      .mockResolvedValueOnce({ stdout: '* main\n  remotes/origin/main\n', stderr: '' } as any)
      // git merge-base
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' } as any)

    await logGitDebugInfo('main', 'feature/xyz')

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Recent commits (last 20):')
    )
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('All branches:')
    )
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Merge base of main and feature/xyz: abc1234')
    )
  })

  test('logs "No merge base found" when merge-base command fails', async () => {
    jest
      .spyOn(_gitExec, 'run')
      // git log
      .mockResolvedValueOnce({ stdout: 'abc1234 commit\n', stderr: '' } as any)
      // git branch -a
      .mockResolvedValueOnce({ stdout: '* main\n', stderr: '' } as any)
      // git merge-base → throws (no common ancestor)
      .mockRejectedValueOnce(new Error('no merge base') as never)

    await logGitDebugInfo('feature/xyz', 'main')

    expect(debugSpy).toHaveBeenCalledWith(
      'No merge base found between feature/xyz and main'
    )
  })

  test('logs error message and continues when git log fails', async () => {
    jest
      .spyOn(_gitExec, 'run')
      // git log → fails
      .mockRejectedValueOnce(new Error('git log failed') as never)
      // git branch -a
      .mockResolvedValueOnce({ stdout: '* main\n', stderr: '' } as any)
      // git merge-base
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' } as any)

    await logGitDebugInfo('main', 'feature/xyz')

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list recent commits:')
    )
    // Continues and logs branches successfully
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('All branches:')
    )
  })

  test('is called by getGitDiff after fetchRefUntilMergeBase', async () => {
    const runSpy = jest
      .spyOn(_gitExec, 'run')
      // fetchRefUntilMergeBase: git fetch --depth=10
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // fetchRefUntilMergeBase: ensureLocalRef(main)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // fetchRefUntilMergeBase: ensureLocalRef(feature/xyz)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)
      // fetchRefUntilMergeBase: hasMergeBase → found
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)
      // logGitDebugInfo: git log
      .mockResolvedValueOnce({ stdout: 'abc commit\n', stderr: '' } as any)
      // logGitDebugInfo: git branch -a
      .mockResolvedValueOnce({ stdout: '* main\n', stderr: '' } as any)
      // logGitDebugInfo: git merge-base
      .mockResolvedValueOnce({ stdout: 'abc\n', stderr: '' } as any)
      // git diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as any)

    await getGitDiff('main', 'feature/xyz')

    // Confirm git log was called as part of logGitDebugInfo
    expect(runSpy).toHaveBeenCalledWith('git', [
      'log',
      '--oneline',
      '-n',
      '20'
    ])
    // Confirm git branch was called as part of logGitDebugInfo
    expect(runSpy).toHaveBeenCalledWith('git', ['branch', '-a'])
    // Confirm merge-base was attempted with headRef, not HEAD
    expect(runSpy).toHaveBeenCalledWith('git', [
      'merge-base',
      'main',
      'feature/xyz'
    ])
    expect(runSpy).toHaveBeenCalledTimes(8)
  })
})
