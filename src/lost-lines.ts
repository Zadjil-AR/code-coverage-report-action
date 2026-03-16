import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FileLostLines,
  LineRange,
  LostLinesReport,
  LostRangePreview
} from './interfaces';
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
 * Explicitly rejects refs that start with '-' to prevent option injection.
 */
export function validateGitRef(ref: string): boolean {
  if (ref.startsWith('-')) return false;
  return /^[a-zA-Z0-9_./-]+$/.test(ref);
}

/**
 * Run `git diff --diff-filter=AMRCD -M -U0 <baseRef>...HEAD --` and return stdout.
 * Uses execFile to avoid shell injection.
 * The trailing `--` explicitly ends the revision/option list so that no
 * subsequent argument can be misinterpreted as a git option or path filter.
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
    `${baseRef}...HEAD`,
    '--'
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

    const fileInfo = extractFileInfo(lines, oldPath, newPath);
    oldPath = fileInfo.oldPath;
    newPath = fileInfo.newPath;
    const deleted = fileInfo.deleted;

    const hunks = parseHunks(lines);
    result.set(oldPath, { newPath, hunks, deleted });
  }

  return result;
}

/** Extract old/new paths and deleted flag from the lines of a diff section. */
function extractFileInfo(
  lines: string[],
  defaultOldPath: string,
  defaultNewPath: string
): { oldPath: string; newPath: string; deleted: boolean } {
  let oldPath = defaultOldPath;
  let newPath = defaultNewPath;
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

  return { oldPath, newPath, deleted };
}

/** Extract all hunk headers from the lines of a file diff section. */
function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of lines) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      hunks.push({
        oldStart: Number.parseInt(match[1], 10),
        oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
        newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10)
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

/** A pair of base and head line numbers for a single lost line. */
export interface LostLinePair {
  baseLine: number;
  headLine: number;
}

/** Result returned by computeLostLines. */
export interface ComputeLostLinesResult {
  /** Lines that survived in the head but are no longer covered. */
  lostPairs: LostLinePair[];
  /** Count of base covered lines that still exist in the head (denominator). */
  survivingCount: number;
}

/**
 * Determine which base-covered lines are no longer covered in the head.
 * Deleted lines (resolver returns null) are excluded — they are not "lost"
 * and do not count towards the surviving denominator.
 * Returns both the lost pairs and the surviving count in a single pass to
 * avoid calling the line resolver twice.
 *
 * @param baseCoveredLines  Covered line numbers in the base file.
 * @param lineResolver      Maps base line → head line (null = deleted).
 * @param headCoveredSet    Set of covered line numbers in the head file.
 * @returns                 { lostPairs, survivingCount }
 */
export function computeLostLines(
  baseCoveredLines: number[],
  lineResolver: (oldLine: number) => number | null,
  headCoveredSet: Set<number>
): ComputeLostLinesResult {
  const lostPairs: LostLinePair[] = [];
  let survivingCount = 0;

  for (const baseLine of baseCoveredLines) {
    const headLine = lineResolver(baseLine);
    if (headLine === null) {
      continue; // deleted — not lost, not counted in denominator
    }
    survivingCount++;
    if (!headCoveredSet.has(headLine)) {
      lostPairs.push({ baseLine, headLine });
    }
  }

  return { lostPairs, survivingCount };
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
 * The denominator for each file and overall is the count of base covered lines
 * that were NOT permanently deleted (i.e., resolver returns non-null).
 * Permanently deleted lines are excluded from both numerator and denominator.
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

    const diffEntry = gitDiffMap.get(filePath);

    // Deleted files: all lines are gone — not counted in denominator or numerator
    if (diffEntry?.deleted) {
      continue;
    }

    // Resolve the head path (may differ for renames/moves)
    const newPath = diffEntry?.newPath ?? filePath;

    const hunks = diffEntry?.hunks ?? [];
    const lineResolver = buildLineResolver(hunks);

    const headLines = headCoveredLinesMap[newPath] ?? [];
    const headCoveredSet = new Set<number>(headLines);

    // Single pass: compute lost pairs and surviving count together.
    // Permanently deleted lines are excluded from both numerator and denominator.
    const { lostPairs, survivingCount } = computeLostLines(
      baseCoveredLines,
      lineResolver,
      headCoveredSet
    );

    overallBaseCoveredCount += survivingCount;
    overallLostCount += lostPairs.length;

    if (lostPairs.length > 0) {
      const lostRanges = linesToRanges(lostPairs.map((p) => p.baseLine));
      const newLostRanges = linesToRanges(lostPairs.map((p) => p.headLine));
      const lostPercentage = roundPercentage(
        (lostPairs.length / survivingCount) * 100
      );
      files.push({
        file: newPath,
        lostRanges,
        newLostRanges,
        baseCoveredCount: survivingCount,
        lostCount: lostPairs.length,
        lostPercentage
      });
    }
  }

  const overallLostPercentage =
    overallBaseCoveredCount > 0
      ? roundPercentage((overallLostCount / overallBaseCoveredCount) * 100)
      : 0;

  const previewRanges = buildPreviewRanges(files);

  return {
    files,
    overallBaseCoveredCount,
    overallLostCount,
    overallLostPercentage,
    previewRanges
  };
}

/** Build at most 5 preview ranges (head line numbers) across all files for template rendering. */
function buildPreviewRanges(files: FileLostLines[]): LostRangePreview[] {
  const previewRanges: LostRangePreview[] = [];
  for (const file of files) {
    for (const range of file.newLostRanges) {
      if (previewRanges.length >= 5) break;
      previewRanges.push({
        file: file.file,
        start: range.start,
        end: range.end
      });
    }
    if (previewRanges.length >= 5) break;
  }
  return previewRanges;
}
