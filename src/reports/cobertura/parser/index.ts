import { Coverage, CoverageFile, Files } from '../../../interfaces';
import {
  createHash,
  determineCommonBasePath,
  escapeRegExp,
  roundPercentage
} from '../../../utils';
import { Cobertura, Package, Class, Lines } from '../types';

export default async function parse(
  cobertura: Cobertura,
  trackLostLines = false
): Promise<Coverage> {
  const files: Files = await parsePackages(
    cobertura.coverage.packages.package,
    trackLostLines
  );

  const fileList = Object.values(files).map((file) => file.absolute);
  const basePath = `${determineCommonBasePath(fileList)}`;
  const regExp = new RegExp(`^${escapeRegExp(`${basePath}/`)}`);

  return {
    files: Object.entries(files).reduce((previous, [, file]) => {
      file.relative = file.absolute.replace(regExp, '');
      return { ...previous, [createHash(file.relative)]: file };
    }, {}),
    coverage: roundPercentage(
      parseFloat(cobertura.coverage['@_line-rate']) * 100
    ),
    timestamp: parseInt(cobertura.coverage['@_timestamp']),
    basePath
  };
}

/**
 * Merge two file entries for the same path (e.g. multiple classes per file or same file in multiple packages).
 * Sums lines_covered and lines_valid; recomputes coverage from aggregated lines when both have line counts.
 * Merges covered_lines by union (deduplicates and sorts).
 */
function mergeFileEntry(
  existing: CoverageFile,
  incoming: CoverageFile
): CoverageFile {
  const covered = (existing.lines_covered ?? 0) + (incoming.lines_covered ?? 0);
  const valid = (existing.lines_valid ?? 0) + (incoming.lines_valid ?? 0);
  const coverage =
    valid > 0 ? roundPercentage((covered / valid) * 100) : incoming.coverage;

  let covered_lines: number[] | undefined;
  if (
    existing.covered_lines !== undefined ||
    incoming.covered_lines !== undefined
  ) {
    const merged = new Set<number>([
      ...(existing.covered_lines ?? []),
      ...(incoming.covered_lines ?? [])
    ]);
    covered_lines = [...merged].sort((a, b) => a - b);
  }

  return {
    relative: existing.relative,
    absolute: existing.absolute,
    coverage,
    lines_covered: covered,
    lines_valid: valid,
    covered_lines
  };
}

async function parsePackages(
  packages?: Package[],
  trackLostLines = false
): Promise<Files> {
  const allFiles: Files = {};
  for await (const p of packages || []) {
    if (!p.classes) {
      continue;
    }
    const files = await parseClasses(p.classes.class, trackLostLines);

    for (const [hash, file] of Object.entries(files)) {
      if (allFiles[hash]) {
        allFiles[hash] = mergeFileEntry(allFiles[hash], file);
      } else {
        allFiles[hash] = file;
      }
    }
  }
  return allFiles;
}

/**
 * Count lines_covered and lines_valid from a class's lines array.
 * Also returns the sorted array of covered line numbers.
 */
function countLines(
  lines: Lines,
  trackLostLines: boolean
): {
  lines_covered: number;
  lines_valid: number;
  covered_lines: number[] | undefined;
} {
  const lineArray = lines?.line;
  if (!lineArray) {
    return {
      lines_covered: 0,
      lines_valid: 0,
      covered_lines: trackLostLines ? [] : undefined
    };
  }
  const arr = Array.isArray(lineArray) ? lineArray : [lineArray];
  let lines_covered = 0;
  const covered_lines: number[] | undefined = trackLostLines ? [] : undefined;
  for (const line of arr) {
    const hits = parseInt((line as { '@_hits'?: string })['@_hits'] ?? '0', 10);
    const num = parseInt(
      (line as { '@_number'?: string })['@_number'] ?? '0',
      10
    );
    if (hits > 0) {
      lines_covered += 1;
      if (covered_lines !== undefined && num > 0) {
        covered_lines.push(num);
      }
    }
  }
  if (covered_lines) {
    covered_lines.sort((a, b) => a - b);
  }
  return { lines_covered, lines_valid: arr.length, covered_lines };
}

/**
 * Process into an object. When multiple classes share the same filename (e.g. inner classes),
 * aggregate their lines_covered and lines_valid and compute coverage from the aggregated totals.
 *
 * @param {Class[]} classes
 * @returns {Promise<Files>}
 */
async function parseClasses(
  classes?: Class[],
  trackLostLines = false
): Promise<Files> {
  const byPath = new Map<
    string,
    {
      relative: string;
      absolute: string;
      lines_covered: number;
      lines_valid: number;
      covered_lines: number[] | undefined;
    }
  >();

  for (const cls of classes || []) {
    const path = cls['@_filename'];
    const { lines_covered, lines_valid, covered_lines } = countLines(
      cls.lines,
      trackLostLines
    );
    const key = path;

    if (byPath.has(key)) {
      const cur = byPath.get(key)!;
      cur.lines_covered += lines_covered;
      cur.lines_valid += lines_valid;
      if (trackLostLines) {
        const merged = new Set<number>([
          ...(cur.covered_lines ?? []),
          ...(covered_lines ?? [])
        ]);
        cur.covered_lines = [...merged].sort((a, b) => a - b);
      }
    } else {
      byPath.set(key, {
        relative: path,
        absolute: `${path}`,
        lines_covered,
        lines_valid,
        covered_lines
      });
    }
  }

  const result: Files = {};
  for (const [
    path,
    { relative, absolute, lines_covered, lines_valid, covered_lines }
  ] of byPath) {
    const coverage =
      lines_valid > 0
        ? roundPercentage((lines_covered / lines_valid) * 100)
        : 0;
    result[createHash(path)] = {
      relative,
      absolute,
      coverage,
      lines_covered,
      lines_valid,
      covered_lines
    };
  }
  return result;
}
