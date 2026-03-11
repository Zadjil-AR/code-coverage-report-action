import { execSync } from 'child_process';
import * as core from '@actions/core';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/**
 * Parse unified diff hunk headers from git diff --unified=0 output.
 * Each header has the form: @@ -oldStart[,oldCount] +newStart[,newCount] @@
 * When the count is omitted, it defaults to 1.
 */
export function parseHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const line of diffOutput.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunks.push({
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1
      });
    }
  }
  return hunks;
}

/**
 * Translate an old (base) line number to its new (head) line number using
 * parsed diff hunks.  Returns 'DELETED' when the line was removed entirely.
 *
 * Lines that fall before the first hunk, between hunks, or after the last
 * hunk are "unchanged" and are shifted by the accumulated offset of all
 * preceding hunks.
 */
export function translateLine(
  oldLine: number,
  hunks: DiffHunk[]
): number | 'DELETED' {
  let offset = 0;
  for (const hunk of hunks) {
    if (oldLine < hunk.oldStart) {
      // Unchanged line before this hunk — apply accumulated offset and stop.
      break;
    }
    if (oldLine < hunk.oldStart + hunk.oldCount) {
      // Line falls within the deleted range of this hunk.
      return 'DELETED';
    }
    // Line is after this hunk — accumulate net line-count change.
    offset += hunk.newCount - hunk.oldCount;
  }
  return oldLine + offset;
}

/**
 * Run `git diff --follow --unified=0 <baseRef>...<headRef> -- <filePath>`
 * and return the parsed hunk list.
 *
 * `--follow` handles file renames and moves.
 * `--unified=0` keeps the output minimal (no context lines).
 *
 * Returns an empty array if git diff fails or produces no output (e.g., the
 * file is unchanged or the refs are not available).
 */
export function buildLineTranslationMap(
  baseRef: string,
  headRef: string,
  filePath: string
): DiffHunk[] {
  try {
    const diffOutput = execSync(
      `git diff --follow --unified=0 ${baseRef}...${headRef} -- "${filePath}"`,
      { encoding: 'utf8' }
    );
    return parseHunks(diffOutput);
  } catch (err: any) {
    core.debug(`git diff failed for ${filePath}: ${err.message}`);
    return [];
  }
}
