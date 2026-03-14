import { execFile } from 'child_process';
import { promisify } from 'util';
import { FileLostLines, LineRange, LostLinesReport } from './interfaces';
import { roundPercentage } from './utils';

const execFileAsync = promisify(execFile);

/** A parsed diff hunk header. */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
}

/** Per-file diff information. */
export interface FileDiff {
  newPath: string;
  hunks: Hunk[];
  deleted: boolean;
}

/**
 * Validate that a git ref contains only safe characters.
 * Allows alphanumerics, dash, underscore, dot and forward-slash.
 */
export function validateGitRef(ref: string): boolean {
  return /^[a-zA-Z0-9_./-]+$/.test(ref);
}

/**
 * Run `git diff --diff-filter=AMRCD -M -U0 <baseRef>...HEAD` and return stdout.
 * Uses execFile to avoid shell injection.
 */
export async function getGitDiff(baseRef: string): Promise<string> {
  if (!validateGitRef(baseRef)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(baseRef)}`);
  }
  const { stdout } = await execFileAsync('git', [
    'diff',
    '--diff-filter=AMRCD',
    '-M',
    '-U0',
    `${baseRef}...HEAD`
  ]);
  return stdout;
}

/**
 * Parse a raw `git diff` output string into a map from old file path to FileDiff.
 * Handles renamed/moved files by recording both old and new paths.
 */
export function parseGitDiff(diffOutput: string): Map<string, FileDiff> {
  const result = new Map<string, FileDiff>();

  // Split on "diff --git " lines to get one section per file
  const sections = diffOutput.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) {
      continue;
    }

    const lines = section.split('\n');
    const headerMatch = lines[0].match(/^diff --git a\/(.*) b\/(.*)/);
    if (!headerMatch) {
      continue;
    }

    let oldPath = headerMatch[1];
    let newPath = headerMatch[2];
    let deleted = false;

    for (const line of lines) {
      const renameFrom = line.match(/^rename from (.*)/);
      const renameTo = line.match(/^rename to (.*)/);
      if (renameFrom) {
        oldPath = renameFrom[1];
      }
      if (renameTo) {
        newPath = renameTo[1];
      }
      if (line.startsWith('deleted file mode')) {
        deleted = true;
      }
    }

    const hunks = parseHunks(lines);
    result.set(oldPath, { newPath, hunks, deleted });
  }

  return result;
}

/** Extract all hunk headers from the lines of a file diff section. */
function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of lines) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      hunks.push({
        oldStart: parseInt(match[1], 10),
        oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1
      });
    }
  }
  return hunks;
}

/**
 * Build a function that maps an old (base) line number to a new (head) line number.
 * Returns `null` when the old line was deleted in the diff.
 * For files not in the diff (unchanged), call this with an empty `hunks` array —
 * the resolver becomes the identity function.
 */
export function buildLineResolver(
  hunks: Hunk[]
): (oldLine: number) => number | null {
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

  return function resolve(oldLine: number): number | null {
    let cumulativeOffset = 0;

    for (const hunk of sorted) {
      if (oldLine < hunk.oldStart) {
        return oldLine + cumulativeOffset;
      }

      if (hunk.oldCount > 0 && oldLine < hunk.oldStart + hunk.oldCount) {
        return null; // line was deleted
      }

      cumulativeOffset += hunk.newCount - hunk.oldCount;
    }

    return oldLine + cumulativeOffset;
  };
}

/**
 * Convert a sorted array of line numbers to an array of contiguous LineRanges.
 */
export function linesToRanges(lines: number[]): LineRange[] {
  if (lines.length === 0) {
    return [];
  }

  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push({ start, end });
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push({ start, end });

  return ranges;
}

/**
 * Determine which base-covered lines are no longer covered in the head.
 * Deleted lines (resolver returns null) are excluded — they are not "lost".
 *
 * @param baseCoveredLines  Covered line numbers in the base file.
 * @param lineResolver      Maps base line → head line (null = deleted).
 * @param headCoveredSet    Set of covered line numbers in the head file.
 * @returns                 Base line numbers that lost coverage.
 */
export function computeLostLines(
  baseCoveredLines: number[],
  lineResolver: (oldLine: number) => number | null,
  headCoveredSet: Set<number>
): number[] {
  const lost: number[] = [];

  for (const baseLine of baseCoveredLines) {
    const newLine = lineResolver(baseLine);
    if (newLine === null) {
      continue; // deleted — not lost
    }
    if (!headCoveredSet.has(newLine)) {
      lost.push(baseLine);
    }
  }

  return lost;
}

/**
 * Convert a number[] of covered lines into compact [[start,end]] range tuples
 * suitable for JSON serialisation.
 */
export function coveredLinesToRanges(lines: number[]): [number, number][] {
  return linesToRanges(lines).map(({ start, end }) => [start, end]);
}

/**
 * Convert compact [[start,end]] range tuples back into a flat sorted number[].
 */
export function rangesToLines(ranges: [number, number][]): number[] {
  const lines: number[] = [];
  for (const [start, end] of ranges) {
    for (let n = start; n <= end; n++) {
      lines.push(n);
    }
  }
  return lines;
}

/**
 * Build the full LostLinesReport by comparing base and head covered lines,
 * guided by the git diff.
 *
 * @param baseCoveredLinesMap   relative path → covered line numbers (from base artifact)
 * @param headCoveredLinesMap   relative path → covered line numbers (from head coverage)
 * @param gitDiffMap            Map returned by parseGitDiff()
 */
export function computeLostLinesReport(
  baseCoveredLinesMap: Record<string, number[]>,
  headCoveredLinesMap: Record<string, number[]>,
  gitDiffMap: Map<string, FileDiff>
): LostLinesReport {
  const files: FileLostLines[] = [];
  let overallBaseCoveredCount = 0;
  let overallLostCount = 0;

  for (const [filePath, baseCoveredLines] of Object.entries(
    baseCoveredLinesMap
  )) {
    if (baseCoveredLines.length === 0) {
      continue;
    }

    overallBaseCoveredCount += baseCoveredLines.length;

    const diffEntry = gitDiffMap.get(filePath);

    // Deleted files: all lines are gone — not counted as lost
    if (diffEntry?.deleted) {
      continue;
    }

    // Resolve the head path (may differ for renames/moves)
    const newPath = diffEntry?.newPath ?? filePath;

    const hunks = diffEntry?.hunks ?? [];
    const lineResolver = buildLineResolver(hunks);

    const headLines = headCoveredLinesMap[newPath] ?? [];
    const headCoveredSet = new Set<number>(headLines);

    const lost = computeLostLines(
      baseCoveredLines,
      lineResolver,
      headCoveredSet
    );

    overallLostCount += lost.length;

    if (lost.length > 0) {
      const lostRanges = linesToRanges(lost);
      const lostPercentage = roundPercentage(
        (lost.length / baseCoveredLines.length) * 100
      );
      files.push({
        file: newPath,
        lostRanges,
        baseCoveredCount: baseCoveredLines.length,
        lostCount: lost.length,
        lostPercentage
      });
    }
  }

  const overallLostPercentage =
    overallBaseCoveredCount > 0
      ? roundPercentage((overallLostCount / overallBaseCoveredCount) * 100)
      : 0;

  return {
    files,
    overallBaseCoveredCount,
    overallLostCount,
    overallLostPercentage
  };
}
