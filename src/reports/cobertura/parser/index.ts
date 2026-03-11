import { Coverage, CoveredRanges, Files } from '../../../interfaces';
import {
  createHash,
  determineCommonBasePath,
  escapeRegExp,
  roundPercentage,
  buildCoveredRanges
} from '../../../utils';
import { Cobertura, Package, Class, Lines } from '../types';

export default async function parse(cobertura: Cobertura): Promise<Coverage> {
  const { files, coveredLines } = await parsePackages(
    cobertura.coverage.packages.package
  );

  const fileList = Object.values(files).map((file) => file.absolute);
  const basePath = `${determineCommonBasePath(fileList)}`;
  const regExp = new RegExp(`^${escapeRegExp(`${basePath}/`)}`);

  const coveredRanges: CoveredRanges = {};

  return {
    files: Object.entries(files).reduce((previous, [, file]) => {
      file.relative = file.absolute.replace(regExp, '');
      const lines = coveredLines[file.absolute];
      if (lines && lines.length > 0) {
        coveredRanges[file.relative] = buildCoveredRanges(lines);
      }
      return { ...previous, [createHash(file.relative)]: file };
    }, {}),
    coverage: roundPercentage(
      parseFloat(cobertura.coverage['@_line-rate']) * 100
    ),
    timestamp: parseInt(cobertura.coverage['@_timestamp']),
    basePath,
    coveredRanges
  };
}

/**
 * Parse Packages
 */
async function parsePackages(packages?: Package[]): Promise<{
  files: Files;
  coveredLines: Record<string, number[]>;
}> {
  let allFiles: Files = {};
  let allCoveredLines: Record<string, number[]> = {};
  for await (const p of packages || []) {
    if (!p.classes) {
      continue;
    }
    const result = await parseClasses(p.classes.class);
    allFiles = { ...allFiles, ...result.files };
    allCoveredLines = { ...allCoveredLines, ...result.coveredLines };
  }
  return { files: allFiles, coveredLines: allCoveredLines };
}

/**
 * Process into an object, collecting covered line numbers per class.
 */
async function parseClasses(classes?: Class[]): Promise<{
  files: Files;
  coveredLines: Record<string, number[]>;
}> {
  const resultFiles: Files = {};
  const coveredLines: Record<string, number[]> = {};

  for (const cls of classes ?? []) {
    const absPath = `${cls['@_filename']}`;
    resultFiles[createHash(absPath)] = {
      relative: cls['@_filename'],
      absolute: absPath,
      coverage: roundPercentage(parseFloat(cls['@_line-rate']) * 100)
    };
    coveredLines[absPath] = extractCoveredLines(cls.lines);
  }

  return { files: resultFiles, coveredLines };
}

/**
 * Extract covered line numbers from Cobertura <line> elements.
 * A line is covered when its `hits` attribute is > 0.
 */
function extractCoveredLines(lines: Lines | undefined): number[] {
  if (!lines?.line) return [];
  const lineArray = Array.isArray(lines.line) ? lines.line : [lines.line];
  return lineArray
    .filter((l) => parseInt(l['@_hits'], 10) > 0)
    .map((l) => parseInt(l['@_number'], 10));
}
