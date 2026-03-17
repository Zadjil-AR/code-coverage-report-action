import * as core from '@actions/core';
import { Clover, File, FileMetrics, Package } from '../types';
import { Coverage, Files } from '../../../interfaces';
import {
  determineCommonBasePath,
  roundPercentage,
  createHash,
  escapeRegExp
} from '../../../utils';

export default async function parse(
  clover: Clover,
  trackLostLines = false
): Promise<Coverage> {
  core.debug(`parse: trackLostLines=${trackLostLines}`);
  const { metrics, '@_timestamp': timestamp } = clover.coverage.project;

  let files: Files = {};
  if (clover.coverage.project.package) {
    files = {
      ...files,
      ...(await parsePackages(clover.coverage.project.package, trackLostLines))
    };
  }
  if (clover.coverage.project.file) {
    files = {
      ...files,
      ...(await parseFiles(clover.coverage.project.file, trackLostLines))
    };
  }

  const fileList = Object.values(files).map((file) => file.absolute);
  const basePath = `${determineCommonBasePath(fileList)}`;
  const regExp = new RegExp(`^${escapeRegExp(`${basePath}/`)}`);

  return {
    files: Object.entries(files).reduce((previous, [, file]) => {
      file.relative = file.absolute.replace(regExp, '');
      return { ...previous, [createHash(file.relative)]: file };
    }, {}),
    coverage: processCoverageMetrics(metrics),
    timestamp: Number.parseInt(timestamp),
    basePath
  };
}

/**
 * Parse Packages
 *
 * @param {Package[]} packages
 * @returns {Promise<Files>}
 */
async function parsePackages(
  packages: Package[],
  trackLostLines = false
): Promise<Files> {
  let allFiles: Files = {};
  for await (const p of packages) {
    if (!p.file) {
      continue;
    }
    const files = await parseFiles(p.file, trackLostLines);
    allFiles = { ...allFiles, ...files };
  }
  return allFiles;
}

/**
 * Process into an object
 *
 * @param {File[]|undefined|null} files
 * @returns {Promise<Files>}
 */
async function parseFiles(
  files: File[] | undefined | null,
  trackLostLines = false
): Promise<Files> {
  return (
    files?.reduce(
      (
        previous,
        {
          '@_name': name,
          metrics: fileMetrics,
          '@_path': path,
          line: lineElements
        }: File
      ) => {
        const coveredSum =
          (Number.parseInt(fileMetrics['@_coveredconditionals'], 10) || 0) +
          (Number.parseInt(fileMetrics['@_coveredstatements'], 10) || 0) +
          (Number.parseInt(fileMetrics['@_coveredmethods'], 10) || 0);
        const codeSum =
          (Number.parseInt(fileMetrics['@_conditionals'], 10) || 0) +
          (Number.parseInt(fileMetrics['@_statements'], 10) || 0) +
          (Number.parseInt(fileMetrics['@_methods'], 10) || 0);

        const covered_lines = trackLostLines
          ? extractCloverCoveredLines(lineElements)
          : undefined;

        return {
          ...previous,
          [createHash(path ?? name)]: {
            relative: path ?? name,
            absolute: path ?? name,
            coverage: processCoverageMetrics(fileMetrics),
            lines_covered: coveredSum,
            lines_valid: codeSum,
            covered_lines
          }
        };
      },
      {}
    ) ?? {}
  );
}

/**
 * Extract covered line numbers from Clover line elements.
 * A line is covered when its `count` attribute is > 0.
 */
export function extractCloverCoveredLines(
  lineElements: File['line']
): number[] {
  if (!lineElements) {
    return [];
  }
  const arr = Array.isArray(lineElements) ? lineElements : [lineElements];
  if (arr.length === 0) {
    return [];
  }
  const covered: number[] = [];
  for (const line of arr) {
    const count = Number.parseInt(line['@_count'] ?? '0', 10);
    const num = Number.parseInt(line['@_num'] ?? '0', 10);
    if (count > 0 && num > 0) {
      covered.push(num);
    }
  }
  return covered.sort((a, b) => a - b);
}

/**
 * Process Coverage Metrics from Clover
 *
 * See: https://confluence.atlassian.com/clover/how-are-the-clover-coverage-percentages-calculated-79986990.html
 *
 * @param metrics
 * @returns
 */
function processCoverageMetrics(metrics: FileMetrics): number {
  const coveredConditionals =
    Number.parseInt(metrics['@_coveredconditionals'], 10) || 0;
  const coveredStatements = Number.parseInt(metrics['@_coveredstatements'], 10) || 0;
  const coveredMethods = Number.parseInt(metrics['@_coveredmethods'], 10) || 0;
  const conditionals = Number.parseInt(metrics['@_conditionals'], 10) || 0;
  const statements = Number.parseInt(metrics['@_statements'], 10) || 0;
  const methods = Number.parseInt(metrics['@_methods'], 10) || 0;

  const coveredSum = coveredConditionals + coveredStatements + coveredMethods;
  const codeSum = conditionals + statements + methods;

  const codeCoveragePercentage =
    codeSum > 0 ? (100.0 * coveredSum) / codeSum : 0;

  return roundPercentage(codeCoveragePercentage);
}
