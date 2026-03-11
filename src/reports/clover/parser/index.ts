import { Clover, File, FileMetrics, Line, Package } from '../types';
import { Coverage, CoveredRanges, Files } from '../../../interfaces';
import {
  determineCommonBasePath,
  roundPercentage,
  createHash,
  escapeRegExp,
  buildCoveredRanges
} from '../../../utils';

export default async function parse(clover: Clover): Promise<Coverage> {
  const { metrics, '@_timestamp': timestamp } = clover.coverage.project;

  let files: Files = {};
  let rawCoveredLines: Record<string, number[]> = {};

  if (clover.coverage.project.package) {
    const result = await parsePackages(clover.coverage.project.package);
    files = { ...files, ...result.files };
    rawCoveredLines = { ...rawCoveredLines, ...result.coveredLines };
  }
  if (clover.coverage.project.file) {
    const result = await parseFiles(clover.coverage.project.file);
    files = { ...files, ...result.files };
    rawCoveredLines = { ...rawCoveredLines, ...result.coveredLines };
  }

  const fileList = Object.values(files).map((file) => file.absolute);
  const basePath = `${determineCommonBasePath(fileList)}`;
  const regExp = new RegExp(`^${escapeRegExp(`${basePath}/`)}`);

  const coveredRanges: CoveredRanges = {};

  return {
    files: Object.entries(files).reduce((previous, [, file]) => {
      file.relative = file.absolute.replace(regExp, '');
      const lines = rawCoveredLines[file.absolute];
      if (lines && lines.length > 0) {
        coveredRanges[file.relative] = buildCoveredRanges(lines);
      }
      return { ...previous, [createHash(file.relative)]: file };
    }, {}),
    coverage: processCoverageMetrics(metrics),
    timestamp: parseInt(timestamp),
    basePath,
    coveredRanges
  };
}

/**
 * Parse Packages
 */
async function parsePackages(
  packages: Package[]
): Promise<{ files: Files; coveredLines: Record<string, number[]> }> {
  let allFiles: Files = {};
  let allCoveredLines: Record<string, number[]> = {};
  for await (const p of packages) {
    if (!p.file) {
      continue;
    }
    const result = await parseFiles(p.file);
    allFiles = { ...allFiles, ...result.files };
    allCoveredLines = { ...allCoveredLines, ...result.coveredLines };
  }
  return { files: allFiles, coveredLines: allCoveredLines };
}

/**
 * Process into an object, collecting covered line numbers per file.
 */
async function parseFiles(
  files: File[] | undefined | null
): Promise<{ files: Files; coveredLines: Record<string, number[]> }> {
  const resultFiles: Files = {};
  const coveredLines: Record<string, number[]> = {};

  for (const file of files ?? []) {
    const {
      '@_name': name,
      metrics: fileMetrics,
      '@_path': filePath,
      line
    } = file;
    const absPath = filePath ?? name;
    resultFiles[createHash(absPath)] = {
      relative: absPath,
      absolute: absPath,
      coverage: processCoverageMetrics(fileMetrics)
    };
    coveredLines[absPath] = extractCoveredLines(line);
  }

  return { files: resultFiles, coveredLines };
}

/**
 * Extract covered line numbers from Clover <line> elements.
 * A line is covered when its `count` attribute is > 0.
 */
function extractCoveredLines(lines: Line[] | Line | undefined): number[] {
  if (!lines) return [];
  const lineArray = Array.isArray(lines) ? lines : [lines];
  return lineArray
    .filter((l) => parseInt(l['@_count'], 10) > 0)
    .map((l) => parseInt(l['@_num'], 10));
}

/**
 * Process Coverage Metrics from Clover
 *
 * See: https://confluence.atlassian.com/clover/how-are-the-clover-coverage-percentages-calculated-79986990.html
 */
function processCoverageMetrics(metrics: FileMetrics): number {
  const coveredConditionals = parseInt(metrics['@_coveredconditionals']);
  const coveredStatements = parseInt(metrics['@_coveredstatements']);
  const coveredMethods = parseInt(metrics['@_coveredmethods']);
  const conditionals = parseInt(metrics['@_conditionals']);
  const statements = parseInt(metrics['@_statements']);
  const methods = parseInt(metrics['@_methods']);

  const coveredSum = coveredConditionals + coveredStatements + coveredMethods;
  const codeSum = conditionals + statements + methods;

  const codeCoveragePercentage =
    codeSum > 0 ? (100.0 * coveredSum) / codeSum : 0;

  return roundPercentage(codeCoveragePercentage);
}
