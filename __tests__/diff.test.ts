import {
  parseHunks,
  translateLine,
  buildLineTranslationMap,
  DiffHunk
} from '../src/diff';
import { expect, test, describe, jest } from '@jest/globals';

describe('parseHunks', () => {
  test('returns empty array for empty diff', () => {
    expect(parseHunks('')).toEqual([]);
  });

  test('parses a simple deletion hunk', () => {
    const diff = `@@ -5,3 +5,0 @@\n-line1\n-line2\n-line3`;
    expect(parseHunks(diff)).toEqual([
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 0 }
    ]);
  });

  test('parses a simple insertion hunk', () => {
    const diff = `@@ -5,0 +5,3 @@\n+line1\n+line2\n+line3`;
    expect(parseHunks(diff)).toEqual([
      { oldStart: 5, oldCount: 0, newStart: 5, newCount: 3 }
    ]);
  });

  test('defaults count to 1 when omitted', () => {
    // Single-line change: @@ -5 +5 @@ (no ,count)
    const diff = `@@ -5 +6 @@`;
    expect(parseHunks(diff)).toEqual([
      { oldStart: 5, oldCount: 1, newStart: 6, newCount: 1 }
    ]);
  });

  test('parses multiple hunks', () => {
    const diff = [
      `@@ -1,2 +1,3 @@`,
      ` unchanged`,
      `-removed`,
      `+added1`,
      `+added2`,
      `@@ -10,4 +11,2 @@`
    ].join('\n');

    expect(parseHunks(diff)).toEqual([
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 },
      { oldStart: 10, oldCount: 4, newStart: 11, newCount: 2 }
    ]);
  });

  test('ignores non-hunk lines', () => {
    const diff = [
      `diff --git a/foo.ts b/foo.ts`,
      `index abc..def 100644`,
      `--- a/foo.ts`,
      `+++ b/foo.ts`,
      `@@ -3,2 +3,2 @@`
    ].join('\n');

    expect(parseHunks(diff)).toEqual([
      { oldStart: 3, oldCount: 2, newStart: 3, newCount: 2 }
    ]);
  });
});

describe('translateLine', () => {
  test('returns line unchanged when there are no hunks', () => {
    expect(translateLine(10, [])).toBe(10);
    expect(translateLine(1, [])).toBe(1);
  });

  test('returns DELETED for a line in the deleted range', () => {
    const hunks: DiffHunk[] = [
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 0 }
    ];
    expect(translateLine(5, hunks)).toBe('DELETED');
    expect(translateLine(6, hunks)).toBe('DELETED');
    expect(translateLine(7, hunks)).toBe('DELETED');
  });

  test('does not mark lines outside the deleted range as DELETED', () => {
    const hunks: DiffHunk[] = [
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 0 }
    ];
    expect(translateLine(4, hunks)).toBe(4); // before hunk — unchanged
    expect(translateLine(8, hunks)).toBe(5); // after hunk — shifted by -3
  });

  test('shifts lines after an insertion', () => {
    // 3 lines inserted at position 5 (nothing deleted)
    const hunks: DiffHunk[] = [
      { oldStart: 5, oldCount: 0, newStart: 5, newCount: 3 }
    ];
    expect(translateLine(4, hunks)).toBe(4); // before hunk — unchanged
    expect(translateLine(5, hunks)).toBe(8); // after hunk — shifted by +3
    expect(translateLine(10, hunks)).toBe(13);
  });

  test('applies cumulative offset across multiple hunks', () => {
    // First hunk: delete 2 lines starting at line 3 (offset -2 after)
    // Second hunk: insert 4 lines at old line 10 (offset +2 net after)
    const hunks: DiffHunk[] = [
      { oldStart: 3, oldCount: 2, newStart: 3, newCount: 0 }, // -2
      { oldStart: 10, oldCount: 1, newStart: 8, newCount: 5 } // +4
    ];

    expect(translateLine(1, hunks)).toBe(1);   // before first hunk
    expect(translateLine(3, hunks)).toBe('DELETED');
    expect(translateLine(4, hunks)).toBe('DELETED');
    expect(translateLine(5, hunks)).toBe(3);   // after first hunk, shifted -2
    expect(translateLine(10, hunks)).toBe('DELETED'); // in second hunk deletion
    expect(translateLine(11, hunks)).toBe(13); // after second hunk, offset = -2 + 4 = +2
  });

  test('handles line exactly at hunk boundary', () => {
    const hunks: DiffHunk[] = [
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 1 }
    ];
    // Line 4 is before the hunk → no shift
    expect(translateLine(4, hunks)).toBe(4);
    // Line 5, 6, 7 are deleted
    expect(translateLine(5, hunks)).toBe('DELETED');
    expect(translateLine(7, hunks)).toBe('DELETED');
    // Line 8 (first after deleted range) → offset = 1 - 3 = -2
    expect(translateLine(8, hunks)).toBe(6);
  });
});

describe('buildLineTranslationMap', () => {
  test('returns parsed hunks from git diff output', () => {
    const mockDiff = '@@ -5,3 +5,0 @@\n-line1\n-line2\n-line3';
    const mockExec = jest.fn(() => mockDiff) as any;

    const result = buildLineTranslationMap(
      'origin/main',
      'HEAD',
      'src/foo.ts',
      mockExec
    );
    expect(result).toEqual([
      { oldStart: 5, oldCount: 3, newStart: 5, newCount: 0 }
    ]);
  });

  test('returns empty array when file is unchanged (empty diff output)', () => {
    const mockExec = jest.fn(() => '') as any;

    const result = buildLineTranslationMap(
      'origin/main',
      'HEAD',
      'src/foo.ts',
      mockExec
    );
    expect(result).toEqual([]);
  });

  test('returns empty array when git diff throws', () => {
    const mockExec = jest.fn(() => {
      throw new Error('git: command not found');
    }) as any;

    const result = buildLineTranslationMap(
      'origin/main',
      'HEAD',
      'src/foo.ts',
      mockExec
    );
    expect(result).toEqual([]);
  });

  test('throws on baseRef containing shell metacharacters', () => {
    expect(() =>
      buildLineTranslationMap('origin/main; rm -rf /', 'HEAD', 'src/foo.ts')
    ).toThrow('Invalid git ref');
  });

  test('throws on headRef containing shell metacharacters', () => {
    expect(() =>
      buildLineTranslationMap('origin/main', 'HEAD$(echo bad)', 'src/foo.ts')
    ).toThrow('Invalid git ref');
  });

  test('throws on filePath containing a double-quote', () => {
    expect(() =>
      buildLineTranslationMap('origin/main', 'HEAD', 'src/foo.ts"; rm -rf /')
    ).toThrow('Invalid file path');
  });

  test('throws on filePath containing a dollar sign', () => {
    expect(() =>
      buildLineTranslationMap('origin/main', 'HEAD', 'src/$HOME/foo.ts')
    ).toThrow('Invalid file path');
  });

  test('throws on filePath containing a backtick', () => {
    expect(() =>
      buildLineTranslationMap('origin/main', 'HEAD', 'src/`whoami`.ts')
    ).toThrow('Invalid file path');
  });

  test('throws on baseRef containing subshell characters', () => {
    expect(() =>
      buildLineTranslationMap('origin/main()', 'HEAD', 'src/foo.ts')
    ).toThrow('Invalid git ref');
  });

  test('handles multi-hunk diff output correctly', () => {
    const mockDiff = [
      '@@ -1,2 +1,3 @@',
      ' unchanged',
      '-removed',
      '+added1',
      '+added2',
      '@@ -10,4 +11,2 @@'
    ].join('\n');
    const mockExec = jest.fn(() => mockDiff) as any;

    const result = buildLineTranslationMap(
      'origin/feature-branch',
      'HEAD',
      'src/utils.ts',
      mockExec
    );
    expect(result).toEqual([
      { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 },
      { oldStart: 10, oldCount: 4, newStart: 11, newCount: 2 }
    ]);
  });
});
