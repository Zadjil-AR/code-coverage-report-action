import { run } from '../src/functions';
import * as utils from '../src/utils';
import * as diff from '../src/diff';
import {
  expect,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest
} from '@jest/globals';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const env: NodeJS.ProcessEnv = JSON.parse(JSON.stringify(process.env));
let tempSummaryFile: string;

const minimalCoverage = {
  files: {},
  coverage: 75,
  timestamp: 1715832361306,
  basePath: '/src'
};

beforeAll(async () => {
  tempSummaryFile = path.join(
    __dirname,
    `temp-run-${crypto.randomBytes(4).toString('hex')}.md`
  );
  await fs.promises.writeFile(tempSummaryFile, '');
  process.env.GITHUB_STEP_SUMMARY = tempSummaryFile;
  process.env.INPUT_GITHUB_TOKEN = 'token';
  process.env.INPUT_FILENAME = 'filename.xml';
  process.env.INPUT_ARTIFACT_NAME = 'coverage-%name%';
  process.env.GITHUB_OUTPUT = '';
});

afterAll(async () => {
  process.env = { ...env };
  await fs.promises.unlink(tempSummaryFile).catch(() => {});
  // Clean up sidecar files that run() may write to disk
  for (const f of [
    'code-coverage-results.md',
    'coverage-line-ranges.json',
    'coverage-lost-ranges.json'
  ]) {
    await fs.promises.unlink(f).catch(() => {});
  }
});

beforeEach(async () => {
  process.env = { ...env };
  process.env.GITHUB_STEP_SUMMARY = tempSummaryFile;
  process.env.INPUT_GITHUB_TOKEN = 'token';
  process.env.INPUT_FILENAME = 'filename.xml';
  process.env.INPUT_ARTIFACT_NAME = 'coverage-%name%';
  process.env.GITHUB_OUTPUT = '';
  await fs.promises.writeFile(tempSummaryFile, '');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.promises.writeFile(tempSummaryFile, '').catch(() => {});
  await fs.promises.unlink('code-coverage-results.md').catch(() => {});
});

test('run sets failed when coverage file does not exist', async () => {
  process.env.GITHUB_EVENT_NAME = 'push';
  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(false as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(null as any);

  await run();

  // parseCoverage should NOT be called when the file doesn't exist
  expect(utils.parseCoverage).not.toHaveBeenCalled();
});

test('run handles push event with no head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.GITHUB_WORKFLOW = 'CI';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(null as any);
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  expect(utils.uploadArtifacts).toHaveBeenCalledWith(
    ['filename.xml'],
    'main'
  );
  // generateMarkdown is not called when headCoverage is null
});

test('run handles push event with head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.GITHUB_WORKFLOW = 'CI';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(
    minimalCoverage as any
  );
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  expect(utils.uploadArtifacts).toHaveBeenCalledWith(
    ['filename.xml'],
    'main'
  );
});

test('run handles schedule event with head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'schedule';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.GITHUB_WORKFLOW = 'Nightly';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(
    minimalCoverage as any
  );
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  expect(utils.uploadArtifacts).toHaveBeenCalledWith(
    ['filename.xml'],
    'main'
  );
});

test('run handles pull_request event with no base artifact', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_BASE_REF = 'main';
  process.env.GITHUB_HEAD_REF = 'feature/new';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'downloadArtifacts').mockResolvedValue(null as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(
    minimalCoverage as any
  );

  await run();

  // parseCoverage should be called once (head only when no base artifact)
  expect(utils.parseCoverage).toHaveBeenCalledTimes(1);
});

test('run handles pull_request event with no head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_BASE_REF = 'main';
  process.env.GITHUB_HEAD_REF = 'feature/new';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'downloadArtifacts').mockResolvedValue(null as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(null as any);
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  // When head coverage is null, uploadArtifacts should NOT be called
  expect(utils.uploadArtifacts).not.toHaveBeenCalled();
});

test('run handles pull_request event with base and head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_BASE_REF = 'main';
  process.env.GITHUB_HEAD_REF = 'feature/new';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest
    .spyOn(utils, 'downloadArtifacts')
    .mockResolvedValue('/tmp/artifacts' as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(
    minimalCoverage as any
  );
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  // parseCoverage called twice: once for base, once for head
  expect(utils.parseCoverage).toHaveBeenCalledTimes(2);
});

test('run handles pull_request_target event', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request_target';
  process.env.GITHUB_BASE_REF = 'main';
  process.env.GITHUB_HEAD_REF = 'feature/new';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest.spyOn(utils, 'downloadArtifacts').mockResolvedValue(null as any);
  jest.spyOn(utils, 'parseCoverage').mockResolvedValue(
    minimalCoverage as any
  );

  await run();

  expect(utils.parseCoverage).toHaveBeenCalledTimes(1);
});

test('run handles push event with enableLineLossReport and coveredRanges', async () => {
  process.env.GITHUB_EVENT_NAME = 'push';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.GITHUB_WORKFLOW = 'CI';
  process.env.INPUT_ENABLE_LINE_LOSS_REPORT = 'true';

  const coverageWithRanges = {
    ...minimalCoverage,
    coveredRanges: { 'src/foo.ts': [[1, 10]] }
  };

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest
    .spyOn(utils, 'parseCoverage')
    .mockResolvedValue(coverageWithRanges as any);
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);

  await run();

  expect(utils.uploadArtifacts).toHaveBeenCalledWith(
    expect.arrayContaining(['filename.xml', 'coverage-line-ranges.json']),
    'main'
  );
});

test('run handles pull_request with enableLineLossReport and coveredRanges', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_BASE_REF = 'main';
  process.env.GITHUB_HEAD_REF = 'feature/new';
  process.env.INPUT_ENABLE_LINE_LOSS_REPORT = 'true';

  const coverageWithRanges = {
    ...minimalCoverage,
    coveredRanges: { 'src/foo.ts': [[1, 10]] }
  };

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);
  jest
    .spyOn(utils, 'downloadArtifacts')
    .mockResolvedValue('/tmp/artifacts' as any);
  jest
    .spyOn(utils, 'parseCoverage')
    .mockResolvedValue(coverageWithRanges as any);
  jest.spyOn(utils, 'uploadArtifacts').mockResolvedValue(undefined as any);
  jest
    .spyOn(diff, 'buildLineTranslationMap')
    .mockReturnValue([] as any);
  jest.spyOn(utils, 'computeLostCoverage').mockReturnValue({
    files: [],
    totalPreviouslyCovered: 0,
    totalLost: 0,
    overallLossPercent: 0,
    first5Ranges: []
  } as any);

  await run();

  expect(utils.parseCoverage).toHaveBeenCalledTimes(2);
  expect(utils.uploadArtifacts).toHaveBeenCalledWith(
    expect.arrayContaining(['filename.xml', 'coverage-line-ranges.json']),
    'feature/new'
  );
});

test('run handles unknown event type without errors', async () => {
  process.env.GITHUB_EVENT_NAME = 'workflow_run';

  jest.spyOn(utils, 'checkFileExists').mockResolvedValue(true as any);

  // Should not throw
  await expect(run()).resolves.toBeUndefined();
});
