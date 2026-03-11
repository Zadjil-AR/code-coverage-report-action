import { execSync } from 'child_process';
import * as core from '@actions/core';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/**
 * Pattern for a valid git reference.
 * Allows the characters commonly found in branch names, tag names, SHAs,
 * and remote-tracking refs (e.g. "origin/main", "HEAD", "abc123def456").
 */
const SAFE_GIT_REF_PATTERN = /^[a-zA-Z0-9/._\-~^:@]+$/;

/**
 * Pattern for a file path that is safe to interpolate into a double-quoted
 * shell argument.  Rejects characters that can break out of the quotes or
 * trigger shell expansion: NUL, double-quote, backslash, backtick, $, and
 * newline characters (which could enable newline-based command chaining).
 */
const SAFE_FILE_PATH_PATTERN = /^[^\0"\\`$\n\r]+$/;

/**
 * Validate a git ref string, throwing if it contains unsafe characters.
 */
function validateGitRef(ref: string): void {
  if (!SAFE_GIT_REF_PATTERN.test(ref)) {
    throw new Error(
      `Invalid git ref "${ref}". Only alphanumeric characters and / . - _ ~ ^ : @ are allowed.`
    );
  }
}

/**
 * Validate a file path string, throwing if it contains characters that could
 * cause shell injection when the path is interpolated inside double quotes.
 */
function validateFilePath(filePath: string): void {
  if (!SAFE_FILE_PATH_PATTERN.test(filePath)) {
    throw new Error(
      `Invalid file path "${filePath}". File paths must not contain shell-sensitive characters (", $, \`, \\).`
    );
  }
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
 *
 * @param exec - Overridable executor; defaults to `execSync`. Pass a mock
 *               function in tests to avoid spawning a real git process.
 */
export function buildLineTranslationMap(
  baseRef: string,
  headRef: string,
  filePath: string,
  exec: typeof execSync = execSync
): DiffHunk[] {
  // Validate all parameters before use.  These values are interpolated
  // directly into a shell command string passed to execSync, so they MUST
  // be free of shell metacharacters.  Never relax these checks without
  // re-evaluating the injection risk — execSync passes the command to /bin/sh.
  validateGitRef(baseRef);
  validateGitRef(headRef);
  validateFilePath(filePath);

  try {
    // SAFETY: baseRef and headRef are validated to contain only safe
    // characters. filePath is validated and wrapped in double quotes.
    // Do not modify this command without re-evaluating injection risks.
    const diffOutput = exec(
      `git diff --follow --unified=0 ${baseRef}...${headRef} -- "${filePath}"`,
      { encoding: 'utf8' }
    ) as string;
    return parseHunks(diffOutput);
  } catch (err: any) {
    core.debug(`git diff failed for ${filePath}: ${err.message}`);
    return [];
  }
}
