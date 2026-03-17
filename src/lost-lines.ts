import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as core from '@actions/core';
import {
  FileLostLines,
  LineRange,
  LostLinesReport,
  LostRangePreview
} from './interfaces';
import { roundPercentage } from './utils';

/**
 * Thin wrapper around `promisify(execFile)` exported so that tests can spy
 * on it without needing to mock the `node:child_process` module globally.
 * @internal
 */
export const _gitExec = { run: promisify(execFile) };

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
 * Run `git diff --diff-filter=AMRCD -M -U0 <baseRef>...<headRef> --` and return stdout.
 * Uses execFile to avoid shell injection.
 * The trailing `--` explicitly ends the revision/option list so that no
 * subsequent argument can be misinterpreted as a git option or path filter.
 *
 * `headRef` must be the explicit head branch ref (not HEAD, which is a
 * detached merge commit in the GitHub Actions pull_request context).
 *
 * If the merge base between baseRef and headRef is not reachable in the local
 * history (e.g. in a shallow clone), baseRef is fetched from origin until the
 * merge base is available.
 */
export async function getGitDiff(
  baseRef: string,
  headRef: string
): Promise<string> {
  if (!validateGitRef(baseRef)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(baseRef)}`);
  }
  if (!validateGitRef(headRef)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(headRef)}`);
  }
  core.debug(`Checking for merge base between ${baseRef} and ${headRef}...`);
  const mergeBaseExists = await hasMergeBase(baseRef, headRef);
  if (!mergeBaseExists) {
    core.debug(
      `No merge base found between ${baseRef} and ${headRef} — fetching from origin...`
    );
    await logGitDebugInfo(baseRef, headRef);
    await fetchRefUntilMergeBase(baseRef, headRef);
    core.debug(`Fetched ${baseRef} and ${headRef} from origin successfully.`);
    await logGitDebugInfo(baseRef, headRef);
  }
  const { stdout } = await _gitExec.run('git', [
    'diff',
    '--diff-filter=AMRCD',
    '-M',
    '-U0',
    `${baseRef}...${headRef}`,
    '--'
  ]);
  return stdout;
}

/**
 * Return true when `ref` resolves to a commit in the local repository.
 * Uses `git rev-parse --verify <ref>^{commit}` which exits 0 on success and
 * non-zero when the ref is unknown — without writing to stderr.
 * Expects a pre-validated ref (see validateGitRef).
 */
export async function isRefInHistory(ref: string): Promise<boolean> {
  try {
    await _gitExec.run('git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Emit debug information about the current git state to help diagnose why a
 * merge base could not be found.
 *
 * Logs:
 *  - the 20 most-recent commits (git log --oneline -n 20)
 *  - all local and remote-tracking branches (git branch -a)
 *  - the merge-base of `baseRef` and `headRef`, or a message when none exists
 *
 * Every sub-command is wrapped in its own try/catch so that a failure in one
 * does not prevent the others from running.
 */
export async function logGitDebugInfo(
  baseRef: string,
  headRef: string
): Promise<void> {
  try {
    const { stdout: logOut } = await _gitExec.run('git', [
      'log',
      '--oneline',
      '-n',
      '20'
    ]);
    core.debug(`Recent commits (last 20):\n${logOut}`);
  } catch (e) {
    core.debug(`Failed to list recent commits: ${e}`);
  }

  try {
    const { stdout: branchOut } = await _gitExec.run('git', ['branch', '-a']);
    core.debug(`All branches:\n${branchOut}`);
  } catch (e) {
    core.debug(`Failed to list branches: ${e}`);
  }

  try {
    const { stdout: mergeBaseOut } = await _gitExec.run('git', [
      'merge-base',
      baseRef,
      headRef
    ]);
    core.debug(
      `Merge base of ${baseRef} and ${headRef}: ${mergeBaseOut.trim()}`
    );
  } catch {
    core.debug(`No merge base found between ${baseRef} and ${headRef}`);
  }
}

/**
 * Fetch a single ref from the `origin` remote with a shallow depth of 1.
 * Uses execFile to avoid shell injection.
 * Expects a pre-validated ref (see validateGitRef).
 */
export async function fetchRef(ref: string): Promise<void> {
  // prettier-ignore
  await _gitExec.run('git', [
    'fetch',
    '--depth=1',
    'origin',
    ref
  ]);
}

/** Initial fetch depth for incremental deepening. */
export const INITIAL_FETCH_DEPTH = 10;

/** Maximum fetch depth before giving up on finding the merge base. */
export const MAX_FETCH_DEPTH = 512;

/**
 * Return true when `git merge-base <baseRef> <headRef>` exits 0, meaning a
 * common ancestor between `baseRef` and `headRef` exists in the locally
 * available history.
 * Expects pre-validated refs (see validateGitRef).
 */
export async function hasMergeBase(
  baseRef: string,
  headRef: string
): Promise<boolean> {
  try {
    await _gitExec.run('git', ['merge-base', baseRef, headRef]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch both `baseRef` and `headRef` from origin using incremental depth
 * doubling until the merge base between them is reachable in the local
 * history, or until `MAX_FETCH_DEPTH` is reached.
 *
 * Both refs are fetched in a single `git fetch` invocation per iteration so
 * that history for both branches is available when `git merge-base` is run.
 * Fetching them together also allows git to resolve the merge base in a single
 * network round-trip, which is equivalent to deepening both in parallel.
 *
 * Sequence: depth = INITIAL_FETCH_DEPTH, then doubles each iteration.
 * Expects pre-validated refs (see validateGitRef).
 */
export async function fetchRefUntilMergeBase(
  baseRef: string,
  headRef: string
): Promise<void> {
  let depth = INITIAL_FETCH_DEPTH;
  let isFirst = true;
  while (depth <= MAX_FETCH_DEPTH) {
    const flag = isFirst ? `--depth=${depth}` : `--deepen=${depth / 2}`;
    core.debug(
      `Fetching ${baseRef} and ${headRef} from origin with ${flag}...`
    );
    await _gitExec.run('git', ['fetch', flag, 'origin', baseRef, headRef]);
    if (await hasMergeBase(baseRef, headRef)) {
      core.debug(
        `Merge base found for ${baseRef}...${headRef} at depth ${depth}.`
      );
      return;
    }
    core.debug(
      `Merge base not yet found for ${baseRef}...${headRef} at depth ${depth}, deepening...`
    );
    isFirst = false;
    depth *= 2;
  }
  core.debug(
    `Reached max fetch depth (${MAX_FETCH_DEPTH}) without finding merge base for ${baseRef}...${headRef}.`
  );
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
