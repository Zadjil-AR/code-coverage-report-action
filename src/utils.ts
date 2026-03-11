import { promises as fs, constants as fsConstants } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import {
  DefaultArtifactClient,
  UploadArtifactResponse
} from '@actions/artifact';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { Clover, parse as parseClover } from './reports/clover';
import { Cobertura, parse as parseCobertura } from './reports/cobertura';
import path from 'path';

import {
  Coverage,
  Inputs,
  LineRange,
  CoveredRanges,
  LostCoverageSummary,
  LostCoverageFile
} from './interfaces';
import { DiffHunk, translateLine } from './diff';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

const { access, readFile, mkdir } = fs;

/**
 * Check if a file exists
 * @param {string} filename
 * @returns {Promise<boolean>}
 */
export async function checkFileExists(filename: string): Promise<boolean> {
  try {
    await access(filename, fsConstants.F_OK);
    return true;
  } catch (_e) {
    //
  }
  return false;
}

/**
 * Parse XML
 * @param {string} filename
 * @returns {Promise<T | null>}
 */
export async function parseXML<T>(filename: string): Promise<T | null> {
  if (!(await checkFileExists(filename))) {
    return null;
  }

  const contents = await readFile(filename, 'binary');

  return new XMLParser({
    ignoreAttributes: false,
    isArray: (name, jpath, isLeafNode, isAttribute) => {
      if (isAttribute) {
        return false;
      }
      return inArray(jpath, [
        'coverage.project.file',
        'coverage.project.package',
        'coverage.project.package.file',
        'coverage.packages.package',
        'coverage.packages.package.classes.class',
        'coverage.sources.source'
      ]);
    }
  }).parse(contents);
}

/**
 * Download Artifacts
 *
 * @param {string} name
 * @param {string} base
 * @returns {Promise<string|null>}
 */
export async function downloadArtifacts(
  name: string,
  base = 'artifacts'
): Promise<string | null> {
  const { token, artifactDownloadWorkflowNames } = getInputs();
  const client = github.getOctokit(token);
  const artifactWorkflowNames =
    artifactDownloadWorkflowNames !== null
      ? artifactDownloadWorkflowNames
      : [github.context.job];
  const artifactName = formatArtifactName(name);

  const { GITHUB_BASE_REF = '', GITHUB_REPOSITORY = '' } = process.env;

  const [owner, repo] = GITHUB_REPOSITORY.split('/');

  core.info(
    `Looking for artifact "${artifactName}" in the following workflows: ${artifactWorkflowNames.join(
      ','
    )}`
  );
  for await (const runs of client.paginate.iterator(
    client.rest.actions.listWorkflowRunsForRepo,
    {
      owner,
      repo,
      branch: GITHUB_BASE_REF,
      status: 'success'
    }
  )) {
    for await (const run of runs.data) {
      if (!run.name) {
        core.debug(`${run.id} had no workflow name, skipping`);
        continue;
      }

      if (!inArray(run.name, artifactWorkflowNames)) {
        core.debug(
          `Workflow name '${
            run.name
          }' did not match the following required workflows names: ${artifactWorkflowNames.join(
            ','
          )}`
        );
        continue;
      }

      const artifacts = await client.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: run.id
      });
      if (artifacts.data.artifacts.length === 0) {
        core.debug(`No Artifacts in workflow ${run.id}`);
        continue;
      }
      for await (const art of artifacts.data.artifacts) {
        if (art.expired) {
          continue;
        }

        if (art.name !== artifactName) {
          continue;
        }

        core.info(
          `Downloading the artifact "${art.name}" from workflow ${run.name}:${run.id}`
        );
        const zip = await client.rest.actions.downloadArtifact({
          owner,
          repo,
          artifact_id: art.id,
          archive_format: 'zip'
        });

        const dir = path.join(__dirname, base);

        core.debug(`Making dir ${dir}`);
        await mkdir(dir, { recursive: true });

        core.debug(`Extracting Artifact to ${dir}`);
        const adm = new AdmZip(Buffer.from(zip.data as string));
        adm.extractAllTo(dir, true);
        return dir;
      }
    }
  }

  core.warning(
    `No artifacts found for the following workspaces: ${artifactWorkflowNames.join(
      ','
    )}`
  );
  return null;
}

/**
 * Upload Artifacts
 * @param {string[]} files
 * @param {string} name
 * @returns {Promise<UploadArtifactResponse>}
 */
export async function uploadArtifacts(
  files: string[],
  name: string
): Promise<UploadArtifactResponse> {
  const artifactClient = new DefaultArtifactClient();
  const artifactName = formatArtifactName(name);
  const { retention } = getInputs();

  const rootDirectory = '.';

  const result = await artifactClient.uploadArtifact(
    artifactName,
    files,
    rootDirectory,
    {
      retentionDays: retention
    }
  );

  core.info(`Artifact Metadata:\n${JSON.stringify(result, null, 4)}`);

  return result;
}

/**
 * Parse Coverage file
 * @param {string} filename
 * @returns {Promise<Coverage | null>}
 */
export async function parseCoverage(
  filename: string
): Promise<Coverage | null> {
  if (!(await checkFileExists(filename))) {
    core.warning(`Unable to access ${filename} for parsing`);
    return null;
  }

  const ext = path.extname(filename);

  let coverage: Coverage | null = null;

  switch (ext) {
    case '.xml':
      {
        const xml = await parseXML<Cobertura | Clover>(filename);

        if (instanceOfCobertura(xml)) {
          core.info(`Detected a Cobertura File at ${filename}`);
          coverage = await parseCobertura(xml);
        } else if (instanceOfClover(xml)) {
          core.info(`Detected a Clover File at ${filename}`);
          coverage = await parseClover(xml);
        }
      }
      break;
    default:
      core.warning(`Unable to parse ${filename}`);
  }

  if (coverage !== null) {
    const enableLineLossReport =
      core.getInput('enable_line_loss_report') === 'true';
    if (!enableLineLossReport) {
      delete coverage.coveredRanges;
    }
  }

  return coverage;
}

/**
 * Convert a list of line numbers into a sorted list of [start, end] ranges.
 * Adjacent or contiguous line numbers are merged into a single range.
 * @param {number[]} lines
 * @returns {LineRange[]}
 */
export function buildCoveredRanges(lines: number[]): LineRange[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= end + 1) {
      end = sorted[i];
    } else {
      ranges.push([start, end]);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push([start, end]);
  return ranges;
}

/**
 * Check whether a line number falls within any of the given ranges.
 */
function isLineInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some(([s, e]) => line >= s && line <= e);
}

/**
 * Compute lost coverage given base covered ranges, new covered ranges, and
 * per-file line translation maps (produced by buildLineTranslationMap).
 *
 * Lines that were permanently deleted are excluded from loss accounting.
 */
export function computeLostCoverage(
  baseCoveredRanges: CoveredRanges,
  newCoveredRanges: CoveredRanges,
  translationMaps: Map<string, DiffHunk[]>
): LostCoverageSummary {
  const files: LostCoverageFile[] = [];
  let totalPreviouslyCovered = 0;
  let totalLost = 0;
  const allLostRangeEntries: { file: string; range: LineRange }[] = [];

  for (const [filePath, baseRanges] of Object.entries(baseCoveredRanges)) {
    const hunks = translationMaps.get(filePath) ?? [];
    const newRanges = newCoveredRanges[filePath] ?? [];

    // Expand base ranges into individual covered line numbers.
    const coveredInBase: number[] = [];
    for (const [start, end] of baseRanges) {
      for (let line = start; line <= end; line++) {
        coveredInBase.push(line);
      }
    }

    const previouslyCovered = coveredInBase.length;
    totalPreviouslyCovered += previouslyCovered;

    const lostLineNumbers: number[] = [];
    for (const oldLine of coveredInBase) {
      const newLine = translateLine(oldLine, hunks);
      if (newLine === 'DELETED') {
        continue; // Permanently deleted — not a regression.
      }
      if (!isLineInRanges(newLine, newRanges)) {
        lostLineNumbers.push(newLine);
      }
    }

    const lostLinesCount = lostLineNumbers.length;
    totalLost += lostLinesCount;

    if (lostLinesCount > 0) {
      const lostRanges = buildCoveredRanges(lostLineNumbers);
      const lossPercent =
        previouslyCovered > 0
          ? roundPercentage((lostLinesCount / previouslyCovered) * 100)
          : 0;

      files.push({
        fileName: filePath,
        previouslyCovered,
        lostLines: lostLinesCount,
        lossPercent,
        lostRanges
      });

      for (const range of lostRanges) {
        allLostRangeEntries.push({ file: filePath, range });
      }
    }
  }

  const overallLossPercent =
    totalPreviouslyCovered > 0
      ? roundPercentage((totalLost / totalPreviouslyCovered) * 100)
      : 0;

  return {
    files,
    totalPreviouslyCovered,
    totalLost,
    overallLossPercent,
    first5Ranges: allLostRangeEntries.slice(0, 5)
  };
}

export function createHash(data: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Round a percentage
 * @param {number} percentage
 * @returns {number}
 */
export function roundPercentage(percentage: number): number {
  return Math.round((percentage + Number.EPSILON) * 100) / 100;
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

/**
 * Colorize Percentage By Threshold
 * @param percentage
 * @param thresholdMax
 * @param thresholdMin
 * @returns
 */
export function colorizePercentageByThreshold(
  percentage: number | null,
  thresholdMax = 0,
  thresholdMin: number | null = null
): string {
  if (percentage === null) {
    return '⚪ 0%';
  }
  if (thresholdMin === null) {
    if (percentage > thresholdMax) {
      return `🟢 ${percentage.toString()}%`;
    } else if (percentage < thresholdMax) {
      return `🔴 ${percentage.toString()}%`;
    }
  } else {
    if (percentage < thresholdMin) {
      return `🔴 ${percentage.toString()}%`;
    } else if (percentage >= thresholdMin && percentage <= thresholdMax) {
      return `🟠 ${percentage.toString()}%`;
    } else if (percentage > thresholdMax) {
      return `🟢 ${percentage.toString()}%`;
    }
  }

  return `⚪ ${percentage.toString()}%`;
}

/**
 * Determine a common base path
 *
 * @param {string[]} files
 * @param {string} separator
 * @returns {string}
 */
export function determineCommonBasePath(
  files: string[],
  separator = '/'
): string {
  if (files.length === 0) {
    return '';
  }
  /**
   * Given an index number, return a function that takes an array and returns the
   * element at the given index
   * @param {number} i
   * @return {function(!Array<*>): *}
   */
  const elAt = (i: number) => (a: string[]) => a[i];

  /**
   * Given an array of strings, return an array of arrays, containing the
   * strings split at the given separator
   */
  const splitStrings = files.map((i) => i.split(separator));
  /**
   * Transpose an array of arrays:
   * Example:
   * [['a', 'b', 'c'], ['A', 'B', 'C'], [1, 2, 3]] ->
   * [['a', 'A', 1], ['b', 'B', 2], ['c', 'C', 3]]
   */
  const rotated = splitStrings[0].map((e, i) => splitStrings.map(elAt(i)));

  return (
    rotated
      //Checks of all the elements in the array are the same.
      .filter((arr) => arr.every((e) => e === arr[0]))
      .map(elAt(0))
      .join(separator)
  );
}

/**
 * Get Formatted Inputs
 *
 * @returns {Inputs}
 */
export function getInputs(): Inputs {
  const token = core.getInput('github_token', { required: true });
  const filename = core.getInput('filename', { required: true });
  const markdownFilename =
    core.getInput('markdown_filename') || 'code-coverage-results';
  const badge = core.getInput('badge') === 'true';
  const skipPackageCoverage = core.getInput('skip_package_coverage') === 'true';
  const overallCoverageFailThreshold = Math.abs(
    parseInt(core.getInput('overall_coverage_fail_threshold') || '0')
  );
  const fileCoverageErrorMin = Math.abs(
    parseInt(core.getInput('file_coverage_error_min') || '50')
  );

  const fileCoverageWarningMax = Math.abs(
    parseInt(core.getInput('file_coverage_warning_max') || '75')
  );

  const negativeDifferenceThreshold =
    Math.abs(
      parseFloat(core.getInput('negative_difference_threshold') || '0')
    ) * -1;

  const failOnNegativeDifference =
    core.getInput('fail_on_negative_difference') === 'true' ? true : false;

  const onlyListChangedFiles =
    core.getInput('only_list_changed_files') === 'true' ? true : false;

  const negativeDifferenceBy =
    core.getInput('negative_difference_by') === 'overall'
      ? 'overall'
      : 'package';

  const retentionString = core.getInput('retention_days') || undefined;
  const retentionDays =
    retentionString === undefined
      ? undefined
      : Math.abs(parseInt(retentionString));

  const artifactName = core.getInput('artifact_name') || 'coverage-%name%';
  if (!artifactName.includes('%name%')) {
    throw new Error('artifact_name is missing %name% variable');
  }

  const tempArtifactDownloadWorkflowNames = core.getInput(
    'artifact_download_workflow_names'
  );
  const artifactDownloadWorkflowNames =
    tempArtifactDownloadWorkflowNames !== ''
      ? tempArtifactDownloadWorkflowNames.split(',').map((n) => n.trim())
      : null;

  const withoutBaseCoverageTemplate =
    core.getInput('without_base_coverage_template') ||
    `${__dirname}/../templates/without-base-coverage.hbs`;
  const withBaseCoverageTemplate =
    core.getInput('with_base_coverage_template') ||
    `${__dirname}/../templates/with-base-coverage.hbs`;

  const enableLineLossReport =
    core.getInput('enable_line_loss_report') === 'true';

  return {
    token,
    filename,
    badge,
    overallCoverageFailThreshold,
    fileCoverageErrorMin,
    fileCoverageWarningMax,
    failOnNegativeDifference,
    markdownFilename,
    artifactDownloadWorkflowNames,
    artifactName,
    negativeDifferenceBy,
    retention: retentionDays,
    withoutBaseCoverageTemplate,
    withBaseCoverageTemplate,
    negativeDifferenceThreshold,
    onlyListChangedFiles,
    skipPackageCoverage,
    enableLineLossReport
  };
}

function instanceOfCobertura(object: any): object is Cobertura {
  return 'coverage' in object && 'packages' in object.coverage;
}

function instanceOfClover(object: any): object is Clover {
  return 'coverage' in object && 'project' in object.coverage;
}

/**
 * Format Artifact Name
 * @param {string} name
 * @returns {string}
 */
export function formatArtifactName(name: string): string {
  const { artifactName } = getInputs();
  return `${artifactName}`.replace('%name%', name).replace(/\//g, '-');
}

/**
 * In Array functionality
 *
 * @param {string} needle
 * @param {string[]} haystack
 * @returns {boolean}
 */
function inArray(needle: string, haystack: string[]): boolean {
  const length = haystack.length;
  for (let i = 0; i < length; i++) {
    if (haystack[i] === needle) return true;
  }
  return false;
}
