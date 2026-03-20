import * as core from '@actions/core';
import {
  buildCoveredLinesMap,
  checkFileExists,
  colorizePercentageByThreshold,
  downloadArtifacts,
  filterCoverageByExcludePaths,
  filterCoverageZeroLineFiles,
  getInputs,
  getParentDirFromFile,
  getPathAtDepth,
  getTopDirFromFile,
  isPathExcluded,
  parseCoverage,
  roundPercentage,
  uploadArtifacts
} from './utils';
import {
  Coverage,
  CoverageFile,
  HandlebarContext,
  HandlebarContextCoverage,
  LostLinesReport
} from './interfaces';
import { writeFile } from 'fs/promises';
import path from 'path';
import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { computeLostLinesReport, getGitDiff, parseGitDiff } from './lost-lines';

export async function run(): Promise<void> {
  try {
    const filename = core.getInput('filename');

    if (!(await checkFileExists(filename))) {
      core.setFailed(`Unable to access ${filename}`);
      return;
    }

    core.debug(`filename: ${filename}`);

    const { excludePaths, trackLostLines } = getInputs();
    core.debug(`excludePaths: ${excludePaths.join(', ')}`);
    core.debug(`trackLostLines: ${trackLostLines}`);

    core.debug(`GITHUB_EVENT_NAME: ${process.env.GITHUB_EVENT_NAME}`);
    switch (process.env.GITHUB_EVENT_NAME) {
      case 'pull_request':
      case 'pull_request_target': {
        const { GITHUB_BASE_REF = '', GITHUB_HEAD_REF = '' } = process.env;
        core.debug(`GITHUB_BASE_REF: ${GITHUB_BASE_REF}`);
        core.debug(`GITHUB_HEAD_REF: ${GITHUB_HEAD_REF}`);
        const artifactPath = await downloadArtifacts(GITHUB_BASE_REF);
        core.debug(`artifactPath: ${artifactPath}`);
        let baseCoverage =
          artifactPath !== null
            ? await parseCoverage(
                path.join(artifactPath, filename),
                trackLostLines
              )
            : null;

        core.info(`Parsing coverage file: ${filename}...`);
        let headCoverage = await parseCoverage(filename, trackLostLines);

        if (headCoverage === null) {
          core.setFailed(`Unable to process ${filename}`);
          return;
        }

        if (excludePaths.length > 0) {
          headCoverage = filterCoverageByExcludePaths(
            headCoverage,
            excludePaths
          );
          if (baseCoverage !== null) {
            baseCoverage = filterCoverageByExcludePaths(
              baseCoverage,
              excludePaths
            );
          }
        }
        headCoverage = filterCoverageZeroLineFiles(headCoverage);
        if (baseCoverage !== null) {
          baseCoverage = filterCoverageZeroLineFiles(baseCoverage);
        }

        core.info(`Complete`);

        // Upload the head coverage file when track_lost_lines is enabled so that
        // this PR can serve as the base for a subsequent PR in a chain.
        if (trackLostLines && GITHUB_HEAD_REF) {
          core.info(`Uploading ${filename} for ${GITHUB_HEAD_REF}...`);
          await uploadArtifacts([filename], GITHUB_HEAD_REF);
          core.info(`Complete`);
        }

        //Base doesn't have an artifact
        if (baseCoverage === null) {
          core.warning(
            `${GITHUB_BASE_REF} is missing ${filename}. See documentation on how to add this`
          );

          core.info(`Generating markdown from ${headCoverage.basePath}...`);
          await generateMarkdown(headCoverage);
          core.info(`Complete`);

          return;
        }

        // Compute lost lines when the feature is enabled and base coverage is available
        let lostLinesReport: LostLinesReport | undefined;
        if (trackLostLines && baseCoverage !== null) {
          lostLinesReport = await computePrLostLinesReport(
            baseCoverage,
            GITHUB_BASE_REF,
            GITHUB_HEAD_REF,
            headCoverage,
            excludePaths
          );
        }

        core.info(
          `Generating markdown between ${headCoverage.basePath} and ${baseCoverage.basePath}...`
        );
        await generateMarkdown(headCoverage, baseCoverage, lostLinesReport);
        core.info(`Complete`);
        break;
      }
      case 'push':
      case 'schedule':
      case 'workflow_dispatch':
        {
          const { GITHUB_REF_NAME = '', GITHUB_WORKFLOW = '' } = process.env;
          core.info(`Uploading ${filename}...`);
          await uploadArtifacts([filename], GITHUB_REF_NAME);
          core.debug(
            `GITHUB_REF_NAME: ${GITHUB_REF_NAME}, filename: ${filename}`
          );
          core.info(`Complete`);

          core.info(`Parsing coverage file: ${filename}...`);
          let headCoverage = await parseCoverage(filename, trackLostLines);
          core.info(`Complete`);

          if (headCoverage != null && excludePaths.length > 0) {
            headCoverage = filterCoverageByExcludePaths(
              headCoverage,
              excludePaths
            );
          }
          if (headCoverage != null) {
            headCoverage = filterCoverageZeroLineFiles(headCoverage);
          }

          core.info(`Workflow Name: ${GITHUB_WORKFLOW}`);

          if (headCoverage != null) {
            core.info(`Generating markdown from ${headCoverage.basePath}...`);
            await generateMarkdown(headCoverage);
            core.info(`Complete`);
          }
        }
        break;
      default:
      //TODO: return something here
    }
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

/**
 * Compute the lost lines report for a PR by:
 * 1. Extracting covered lines from the base Coverage object.
 * 2. Filtering out files matching excludePaths (consistent with coverage filtering).
 * 3. Running git diff to map old → new line numbers.
 * 4. Comparing base covered lines against head covered lines.
 *
 * Returns undefined when the base coverage doesn't include covered_lines data
 * (e.g. track_lost_lines was not enabled).
 */
async function computePrLostLinesReport(
  baseCoverage: Coverage,
  baseRef: string,
  headRef: string,
  headCoverage: Coverage,
  excludePaths: string[]
): Promise<LostLinesReport | undefined> {
  core.debug(
    `computePrLostLinesReport: baseRef=${baseRef}, headRef=${headRef}, excludePaths=${excludePaths.join(', ')}`
  );

  // Extract covered lines directly from base coverage object
  const rawBaseCoveredLinesMap = buildCoveredLinesMap(baseCoverage);

  if (Object.keys(rawBaseCoveredLinesMap).length === 0) {
    core.warning(
      `No covered_lines data found in base coverage. ` +
        `Lost lines analysis skipped. ` +
        `Ensure track_lost_lines=true was set when the base branch artifact was created.`
    );
    return undefined;
  }

  // Apply the same exclude paths filter to the base covered-lines map so that
  // excluded files are not considered in the lost-lines calculation.
  const baseCoveredLinesMap = filterCoveredLinesMap(
    rawBaseCoveredLinesMap,
    excludePaths
  );

  const headCoveredLinesMap = buildCoveredLinesMap(headCoverage);

  core.info(`Running git diff for lost lines analysis...`);
  let diffOutput: string;
  const { lostLinesMergeBaseSearchSteps, lostLinesMergeBaseMaxDepth } =
    getInputs();
  try {
    diffOutput = await getGitDiff(
      baseRef,
      headRef,
      lostLinesMergeBaseSearchSteps,
      lostLinesMergeBaseMaxDepth
    );
  } catch (err: any) {
    core.warning(
      `git diff failed: ${err.message}. Lost lines analysis skipped.`
    );
    return undefined;
  }

  const gitDiffMap = parseGitDiff(diffOutput);
  return computeLostLinesReport(
    baseCoveredLinesMap,
    headCoveredLinesMap,
    gitDiffMap
  );
}

/**
 * Filter a covered-lines map by exclude paths, returning a new map without
 * entries whose relative path matches any of the given exclude prefixes.
 */
export function filterCoveredLinesMap(
  map: Record<string, number[]>,
  excludePaths: string[]
): Record<string, number[]> {
  if (excludePaths.length === 0) {
    return map;
  }
  const result: Record<string, number[]> = {};
  for (const [filePath, lines] of Object.entries(map)) {
    if (!isPathExcluded(filePath, excludePaths)) {
      result[filePath] = lines;
    }
  }
  return result;
}

type CoverageGroupBy = 'file' | 'top_dir' | 'depth' | 'parent_dir';

/**
 * Build a Map from relative file path → FileLostLines entry for O(1) lookup.
 */
function buildLostLinesByFile(
  lostLinesReport?: LostLinesReport
): Map<
  string,
  { lostCount: number; lostPercentage: number; baseCoveredCount: number }
> {
  if (!lostLinesReport) {
    return new Map();
  }
  const map = new Map<
    string,
    { lostCount: number; lostPercentage: number; baseCoveredCount: number }
  >();
  for (const entry of lostLinesReport.files) {
    map.set(entry.file, {
      lostCount: entry.lostCount,
      lostPercentage: entry.lostPercentage,
      baseCoveredCount: entry.baseCoveredCount
    });
  }
  return map;
}

/**
 * Format a lost-coverage value for display in the table.
 * Example: "🔴 -5% (3 lines)"
 */
export function formatLostCoverage(
  lostCount: number,
  lostPercentage: number
): string {
  return `🔴 -${lostPercentage}% (${lostCount} line${lostCount === 1 ? '' : 's'})`;
}

/**
 * Build coverage rows for the template: per-file, or aggregated by top_dir, depth, or parent_dir.
 * Priority: top_dir > coverage_depth > parent_dir > file (per-file).
 */
function buildCoverageRows(
  headCoverage: Coverage,
  baseCoverage: Coverage | null,
  showCoverageByTopDir: boolean,
  coverageDepth: number | undefined,
  showCoverageByParentDir: boolean,
  fileCoverageErrorMin: number,
  fileCoverageWarningMax: number,
  onlyListChangedFiles: boolean,
  failOnNegativeDifference: boolean,
  negativeDifferenceBy: string,
  negativeDifferenceThreshold: number,
  lostLinesReport?: LostLinesReport
): HandlebarContextCoverage[] {
  const fileEntries = Object.entries(headCoverage.files).filter(
    ([hash, file]) => {
      if (baseCoverage === null) {
        return !onlyListChangedFiles;
      }
      const baseCoveragePercentage = baseCoverage.files[hash]
        ? baseCoverage.files[hash].coverage
        : 0;
      const differencePercentage = baseCoveragePercentage
        ? roundPercentage(file.coverage - baseCoveragePercentage)
        : roundPercentage(file.coverage);
      if (onlyListChangedFiles && differencePercentage === 0) {
        return false;
      }
      return true;
    }
  );

  const groupBy: CoverageGroupBy = showCoverageByTopDir
    ? 'top_dir'
    : coverageDepth !== undefined && coverageDepth >= 1
      ? 'depth'
      : showCoverageByParentDir
        ? 'parent_dir'
        : 'file';

  if (groupBy === 'file') {
    // Build a lookup for lost lines per file for O(1) access
    const lostByFile = buildLostLinesByFile(lostLinesReport);

    return fileEntries
      .map(([hash, file]) => {
        if (baseCoverage === null) {
          return {
            package: file.relative,
            base_coverage: `${colorizePercentageByThreshold(
              file.coverage,
              fileCoverageWarningMax,
              fileCoverageErrorMin
            )}`
          };
        }
        const baseCoveragePercentage = baseCoverage.files[hash]
          ? baseCoverage.files[hash].coverage
          : 0;
        const differencePercentage = baseCoveragePercentage
          ? roundPercentage(file.coverage - baseCoveragePercentage)
          : roundPercentage(file.coverage);
        if (
          failOnNegativeDifference &&
          negativeDifferenceBy === 'package' &&
          differencePercentage !== null &&
          differencePercentage < 0 &&
          differencePercentage < negativeDifferenceThreshold
        ) {
          core.setFailed(
            `${file.relative} coverage difference was ${differencePercentage}% which is below threshold of ${negativeDifferenceThreshold}%`
          );
        }
        const lostEntry = lostByFile.get(file.relative);
        return {
          package: file.relative,
          base_coverage: `${colorizePercentageByThreshold(
            baseCoveragePercentage,
            fileCoverageWarningMax,
            fileCoverageErrorMin
          )}`,
          new_coverage: `${colorizePercentageByThreshold(
            file.coverage,
            fileCoverageWarningMax,
            fileCoverageErrorMin
          )}`,
          difference: colorizePercentageByThreshold(differencePercentage),
          lost_coverage: lostEntry
            ? formatLostCoverage(lostEntry.lostCount, lostEntry.lostPercentage)
            : undefined
        };
      })
      .sort((a, b) =>
        a.package < b.package ? -1 : a.package > b.package ? 1 : 0
      );
  }

  const getGroupKey =
    groupBy === 'top_dir'
      ? getTopDirFromFile
      : groupBy === 'depth' && coverageDepth !== undefined
        ? (relativePath: string) => getPathAtDepth(relativePath, coverageDepth)
        : getParentDirFromFile;
  const lostByFile = buildLostLinesByFile(lostLinesReport);
  const byDir: Record<
    string,
    {
      headSum: number;
      baseSum: number;
      count: number;
      baseCount: number;
      lostCount: number;
      lostBaseCoveredCount: number;
    }
  > = {};
  for (const [hash, file] of fileEntries) {
    const key = getGroupKey(file.relative);
    if (!byDir[key]) {
      byDir[key] = {
        headSum: 0,
        baseSum: 0,
        count: 0,
        baseCount: 0,
        lostCount: 0,
        lostBaseCoveredCount: 0
      };
    }
    byDir[key].headSum += file.coverage;
    byDir[key].count += 1;
    if (baseCoverage?.files[hash]) {
      byDir[key].baseSum += baseCoverage.files[hash].coverage;
      byDir[key].baseCount += 1;
    }
    const lostEntry = lostByFile.get(file.relative);
    if (lostEntry) {
      byDir[key].lostCount += lostEntry.lostCount;
      byDir[key].lostBaseCoveredCount += lostEntry.baseCoveredCount;
    }
  }

  return Object.entries(byDir)
    .map(
      ([
        pkg,
        { headSum, baseSum, count, baseCount, lostCount, lostBaseCoveredCount }
      ]) => {
        const headAvg = roundPercentage(headSum / count);
        const baseAvg =
          baseCount > 0 ? roundPercentage(baseSum / baseCount) : 0;
        const differencePercentage =
          baseCoverage !== null ? roundPercentage(headAvg - baseAvg) : null;
        if (
          baseCoverage !== null &&
          failOnNegativeDifference &&
          negativeDifferenceBy === 'package' &&
          differencePercentage !== null &&
          differencePercentage < 0 &&
          differencePercentage < negativeDifferenceThreshold
        ) {
          core.setFailed(
            `${pkg} coverage difference was ${differencePercentage}% which is below threshold of ${negativeDifferenceThreshold}%`
          );
        }
        if (baseCoverage === null) {
          return {
            package: pkg,
            base_coverage: `${colorizePercentageByThreshold(
              headAvg,
              fileCoverageWarningMax,
              fileCoverageErrorMin
            )}`
          };
        }
        const lostPercentage =
          lostBaseCoveredCount > 0
            ? roundPercentage((lostCount / lostBaseCoveredCount) * 100)
            : 0;
        return {
          package: pkg,
          base_coverage: `${colorizePercentageByThreshold(
            baseAvg,
            fileCoverageWarningMax,
            fileCoverageErrorMin
          )}`,
          new_coverage: `${colorizePercentageByThreshold(
            headAvg,
            fileCoverageWarningMax,
            fileCoverageErrorMin
          )}`,
          difference: colorizePercentageByThreshold(differencePercentage),
          lost_coverage:
            lostCount > 0
              ? formatLostCoverage(lostCount, lostPercentage)
              : undefined
        };
      }
    )
    .sort((a, b) =>
      a.package < b.package ? -1 : a.package > b.package ? 1 : 0
    );
}

export async function generateMarkdown(
  headCoverage: Coverage,
  baseCoverage: Coverage | null = null,
  lostLinesReport?: LostLinesReport
): Promise<void> {
  const inputs = getInputs();
  const {
    overallCoverageFailThreshold,
    failOnNegativeDifference,
    fileCoverageErrorMin,
    fileCoverageWarningMax,
    badge,
    markdownFilename,
    negativeDifferenceBy,
    withBaseCoverageTemplate,
    withoutBaseCoverageTemplate,
    negativeDifferenceThreshold,
    onlyListChangedFiles,
    skipPackageCoverage,
    showCoverageByTopDir,
    coverageDepth,
    showCoverageByParentDir
  } = inputs;
  const overallDifferencePercentage = baseCoverage
    ? roundPercentage(headCoverage.coverage - baseCoverage.coverage)
    : null;

  core.debug(`headCoverage: ${headCoverage.coverage}`);
  core.debug(`baseCoverage: ${baseCoverage?.coverage}`);
  core.debug(`overallDifferencePercentage: ${overallDifferencePercentage}`);
  core.debug(`negativeDifferenceThreshold: ${negativeDifferenceThreshold}`);

  if (
    failOnNegativeDifference &&
    negativeDifferenceBy === 'overall' &&
    overallDifferencePercentage !== null &&
    overallDifferencePercentage < 0 &&
    overallDifferencePercentage < negativeDifferenceThreshold &&
    baseCoverage
  ) {
    core.setFailed(
      `FAIL: Overall coverage of dropped ${overallDifferencePercentage}%, from ${baseCoverage.coverage}% to ${headCoverage.coverage}% which is below minimum threshold of ${negativeDifferenceThreshold}%`
    );
  }

  if (overallCoverageFailThreshold > headCoverage.coverage) {
    core.setFailed(
      `FAIL: Overall coverage of ${headCoverage.coverage.toString()}% below minimum threshold of ${overallCoverageFailThreshold.toString()}%.`
    );
  }

  let color = 'grey';
  if (headCoverage.coverage < fileCoverageErrorMin) {
    color = 'red';
  } else if (
    headCoverage.coverage > fileCoverageErrorMin &&
    headCoverage.coverage < fileCoverageWarningMax
  ) {
    color = 'orange';
  } else if (headCoverage.coverage > fileCoverageWarningMax) {
    color = 'green';
  }

  const templatePath =
    baseCoverage === null
      ? withoutBaseCoverageTemplate
      : withBaseCoverageTemplate;

  if (!(await checkFileExists(templatePath))) {
    core.setFailed(`Unable to access template ${templatePath}`);
    return;
  }

  const contents = await readFile(templatePath, {
    encoding: 'utf8'
  });
  const compiledTemplate = Handlebars.compile(contents);

  const context: HandlebarContext = {
    minimum_allowed_coverage: `${overallCoverageFailThreshold}%`,
    new_coverage: `${headCoverage.coverage}%`,
    negative_difference_threshold:
      negativeDifferenceThreshold !== 0
        ? `${negativeDifferenceThreshold}%`
        : null,
    coverage: skipPackageCoverage
      ? []
      : buildCoverageRows(
          headCoverage,
          baseCoverage,
          showCoverageByTopDir,
          coverageDepth,
          showCoverageByParentDir,
          fileCoverageErrorMin,
          fileCoverageWarningMax,
          onlyListChangedFiles,
          failOnNegativeDifference,
          negativeDifferenceBy,
          negativeDifferenceThreshold,
          lostLinesReport
        ),
    overall_coverage: addOverallRow(
      headCoverage,
      baseCoverage,
      lostLinesReport
    ),
    coverage_by_top_dir: showCoverageByTopDir
      ? aggregateCoverageByTopDir(
          headCoverage,
          baseCoverage,
          fileCoverageWarningMax,
          fileCoverageErrorMin,
          lostLinesReport
        )
      : [],
    inputs,
    lost_lines_report: lostLinesReport
  };

  context.show_package_coverage = !skipPackageCoverage;

  if (badge) {
    context.coverage_badge = `https://img.shields.io/badge/${encodeURIComponent(
      `Code Coverage-${headCoverage.coverage}%-${color}`
    )}?style=for-the-badge`;
  }

  const markdown = compiledTemplate(context);

  const summary = core.summary.addRaw(markdown);

  //If this is run after write the buffer is empty
  core.info(`Writing results to ${markdownFilename}.md`);
  await writeFile(`${markdownFilename}.md`, summary.stringify());
  core.setOutput('file', `${markdownFilename}.md`);
  core.setOutput('coverage', headCoverage.coverage);

  core.info(`Writing job summary`);
  await summary.write();
}

/**
 * Aggregate coverage by top-level directory. Uses line-weighted when lines_covered/lines_valid
 * are present (Cobertura), otherwise average of file percentages (Clover).
 */
export function aggregateCoverageByTopDir(
  headCoverage: Coverage,
  baseCoverage: Coverage | null,
  fileCoverageWarningMax: number,
  fileCoverageErrorMin: number,
  lostLinesReport?: LostLinesReport
): HandlebarContextCoverage[] {
  const byDir = new Map<
    string,
    { head: CoverageFile[]; base: CoverageFile[] }
  >();
  for (const [hash, file] of Object.entries(headCoverage.files)) {
    const dir = getTopDirFromFile(file.relative);
    if (!byDir.has(dir)) {
      byDir.set(dir, { head: [], base: [] });
    }
    byDir.get(dir)!.head.push(file);
    if (baseCoverage?.files[hash]) {
      byDir.get(dir)!.base.push(baseCoverage.files[hash]);
    }
  }

  // Build per-file lost lines lookup for aggregation by top-dir.
  const lostByFile = buildLostLinesByFile(lostLinesReport);

  const result: HandlebarContextCoverage[] = [];
  for (const [dir, { head, base }] of byDir.entries()) {
    const hasHeadLines = head.every(
      (f: CoverageFile) =>
        f.lines_covered !== undefined &&
        f.lines_valid !== undefined &&
        f.lines_valid > 0
    );
    const headCovered = head.reduce(
      (s: number, f: CoverageFile) => s + (f.lines_covered ?? 0),
      0
    );
    const headValid = head.reduce(
      (s: number, f: CoverageFile) => s + (f.lines_valid ?? 0),
      0
    );
    const headPct =
      hasHeadLines && headValid > 0
        ? roundPercentage((headCovered / headValid) * 100)
        : head.length > 0
          ? roundPercentage(
              head.reduce((s: number, f: CoverageFile) => s + f.coverage, 0) /
                head.length
            )
          : 0;

    if (baseCoverage === null) {
      result.push({
        package: dir,
        base_coverage: `${colorizePercentageByThreshold(
          headPct,
          fileCoverageWarningMax,
          fileCoverageErrorMin
        )}`
      });
      continue;
    }

    const hasBaseLines =
      base.length > 0 &&
      base.every(
        (f: CoverageFile) =>
          f.lines_covered !== undefined &&
          f.lines_valid !== undefined &&
          f.lines_valid > 0
      );
    const baseCovered = base.reduce(
      (s: number, f: CoverageFile) => s + (f.lines_covered ?? 0),
      0
    );
    const baseValid = base.reduce(
      (s: number, f: CoverageFile) => s + (f.lines_valid ?? 0),
      0
    );
    const basePct =
      hasBaseLines && baseValid > 0
        ? roundPercentage((baseCovered / baseValid) * 100)
        : base.length > 0
          ? roundPercentage(
              base.reduce((s: number, f: CoverageFile) => s + f.coverage, 0) /
                base.length
            )
          : 0;
    const diffPct = roundPercentage(headPct - basePct);

    // Aggregate lost lines for all files in this top-level directory.
    let dirLostCount = 0;
    let dirLostBaseCoveredCount = 0;
    for (const f of head) {
      const lostEntry = lostByFile.get(f.relative);
      if (lostEntry) {
        dirLostCount += lostEntry.lostCount;
        dirLostBaseCoveredCount += lostEntry.baseCoveredCount;
      }
    }
    const dirLostPercentage =
      dirLostBaseCoveredCount > 0
        ? roundPercentage((dirLostCount / dirLostBaseCoveredCount) * 100)
        : 0;

    result.push({
      package: dir,
      base_coverage: `${colorizePercentageByThreshold(
        basePct,
        fileCoverageWarningMax,
        fileCoverageErrorMin
      )}`,
      new_coverage: `${colorizePercentageByThreshold(
        headPct,
        fileCoverageWarningMax,
        fileCoverageErrorMin
      )}`,
      difference: colorizePercentageByThreshold(diffPct),
      lost_coverage:
        dirLostCount > 0
          ? formatLostCoverage(dirLostCount, dirLostPercentage)
          : undefined
    });
  }
  return result.sort(
    (a: HandlebarContextCoverage, b: HandlebarContextCoverage) =>
      a.package < b.package ? -1 : a.package > b.package ? 1 : 0
  );
}

/**
 * Generate overall coverage row
 */
export function addOverallRow(
  headCoverage: Coverage,
  baseCoverage: Coverage | null = null,
  lostLinesReport?: LostLinesReport
): HandlebarContextCoverage {
  const { overallCoverageFailThreshold } = getInputs();

  const overallDifferencePercentage = baseCoverage
    ? roundPercentage(headCoverage.coverage - baseCoverage.coverage)
    : null;

  if (baseCoverage === null) {
    return {
      package: 'Overall Coverage',
      base_coverage: `${colorizePercentageByThreshold(
        headCoverage.coverage,
        0,
        overallCoverageFailThreshold
      )}`
    };
  }

  const lost_coverage =
    lostLinesReport && lostLinesReport.overallLostCount > 0
      ? formatLostCoverage(
          lostLinesReport.overallLostCount,
          lostLinesReport.overallLostPercentage
        )
      : undefined;

  const result: HandlebarContextCoverage = {
    package: 'Overall Coverage',
    base_coverage: `${colorizePercentageByThreshold(
      baseCoverage.coverage,
      0,
      overallCoverageFailThreshold
    )}`,
    new_coverage: `${colorizePercentageByThreshold(
      headCoverage.coverage,
      0,
      overallCoverageFailThreshold
    )}`,
    difference: `${colorizePercentageByThreshold(overallDifferencePercentage)}`,
    difference_plain:
      overallDifferencePercentage != null
        ? `${String(overallDifferencePercentage)}%`
        : undefined
  };

  if (lost_coverage !== undefined) {
    result.lost_coverage = lost_coverage;
  }

  return result;
}
