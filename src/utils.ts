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
  CoverageLineData,
  CoverageLineEntry,
  Inputs,
  RegressedBlock,
  RegressionResult
} from './interfaces';
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
        'coverage.project.file.line',
        'coverage.project.package.file.line',
        'coverage.packages.package',
        'coverage.packages.package.classes.class',
        'coverage.packages.package.classes.class.lines.line',
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

  switch (ext) {
    case '.xml':
      {
        const xml = await parseXML<Cobertura | Clover>(filename);

        if (instanceOfCobertura(xml)) {
          core.info(`Detected a Cobertura File at ${filename}`);
          return await parseCobertura(xml);
        } else if (instanceOfClover(xml)) {
          core.info(`Detected a Clover File at ${filename}`);
          return await parseClover(xml);
        }
      }
      break;
    default:
      core.warning(`Unable to parse ${filename}`);
  }

  return null;
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
    skipPackageCoverage
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
 * Build coverage line data from a Coverage object by reading source files.
 * Each covered/uncovered line is represented by a SHA-256 hash of its trimmed
 * content so the comparison is not sensitive to line-number shifts.
 *
 * @param {Coverage} coverage
 * @returns {Promise<CoverageLineData>}
 */
export async function buildCoverageLineData(
  coverage: Coverage
): Promise<CoverageLineData> {
  const result: CoverageLineData = {};

  for (const file of Object.values(coverage.files)) {
    if (!file.lines || Object.keys(file.lines).length === 0) {
      continue;
    }

    let sourceLines: string[];
    try {
      const content = await readFile(file.absolute, 'utf8');
      sourceLines = content.split('\n');
    } catch {
      core.debug(
        `Unable to read source file ${file.absolute} for line hashing`
      );
      continue;
    }

    const entries: CoverageLineEntry[] = [];
    for (const [lineNumStr, covered] of Object.entries(file.lines)) {
      const lineNum = parseInt(lineNumStr);
      const lineContent = sourceLines[lineNum - 1]; // lines are 1-indexed
      if (lineContent === undefined) {
        continue;
      }
      entries.push({
        lineNum,
        hash: createHash(lineContent.trim()),
        covered
      });
    }

    if (entries.length > 0) {
      result[file.relative] = entries;
    }
  }

  return result;
}

/**
 * Compute regression: find lines that were covered in the base but are no
 * longer covered in the head.  Matching is done by content hash so that
 * lines shifted by additions / deletions elsewhere in the file are still
 * recognised as the same code.
 *
 * @param {CoverageLineData} baseLineData  - content-hash line data from base artifact
 * @param {Coverage}         headCoverage  - parsed head coverage (must include `lines`)
 * @returns {Promise<RegressionResult>}
 */
export async function computeRegression(
  baseLineData: CoverageLineData,
  headCoverage: Coverage
): Promise<RegressionResult> {
  let previouslyCoveredLines = 0;
  let lostLines = 0;
  const blocks: RegressedBlock[] = [];

  // Build a map from relative path → multiset of covered content hashes in HEAD
  const headCoveredHashCounts = new Map<string, Map<string, number>>();

  for (const file of Object.values(headCoverage.files)) {
    if (!file.lines || Object.keys(file.lines).length === 0) {
      continue;
    }

    let sourceLines: string[];
    try {
      const content = await readFile(file.absolute, 'utf8');
      sourceLines = content.split('\n');
    } catch {
      core.debug(
        `Unable to read head source file ${file.absolute} for regression check`
      );
      continue;
    }

    const counts = new Map<string, number>();
    for (const [lineNumStr, covered] of Object.entries(file.lines)) {
      if (!covered) {
        continue;
      }
      const lineNum = parseInt(lineNumStr);
      const lineContent = sourceLines[lineNum - 1];
      if (lineContent === undefined) {
        continue;
      }
      const hash = createHash(lineContent.trim());
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }

    headCoveredHashCounts.set(file.relative, counts);
  }

  // Compare base covered lines against head covered hashes
  for (const [relPath, baseEntries] of Object.entries(baseLineData)) {
    const baseCovered = baseEntries.filter((e) => e.covered);
    previouslyCoveredLines += baseCovered.length;

    const headCounts =
      headCoveredHashCounts.get(relPath) ?? new Map<string, number>();
    // Work on a mutable copy so we can decrement as we match
    const workingCounts = new Map(headCounts);

    let fileLostLines = 0;
    for (const entry of baseCovered) {
      const remaining = workingCounts.get(entry.hash) ?? 0;
      if (remaining > 0) {
        workingCounts.set(entry.hash, remaining - 1);
      } else {
        fileLostLines++;
      }
    }

    if (fileLostLines > 0) {
      lostLines += fileLostLines;
      blocks.push({ file: relPath, lostLines: fileLostLines });
    }
  }

  // When there are no previously covered lines, there is nothing to regress.
  // Return 0% rather than null/undefined so that callers can always treat
  // the result as a number without extra null-checks.
  const percentage =
    previouslyCoveredLines > 0
      ? roundPercentage((lostLines / previouslyCoveredLines) * 100)
      : 0;

  return { previouslyCoveredLines, lostLines, percentage, blocks };
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
