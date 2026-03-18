import * as core from '@actions/core'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { run } from '../src/functions'
import * as utilsModule from '../src/utils'
import * as lostLinesModule from '../src/lost-lines'
import {
  expect,
  test,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  jest
} from '@jest/globals'

jest.mock('../src/utils', () => {
  const actual =
    jest.requireActual('../src/utils') as typeof import('../src/utils')
  return {
    ...actual,
    checkFileExists: jest.fn(),
    downloadArtifacts: jest.fn(),
    parseCoverage: jest.fn(),
    uploadArtifacts: jest.fn(),
    buildCoveredLinesMap: jest.fn()
  }
})

jest.mock('../src/lost-lines', () => {
  const actual =
    jest.requireActual('../src/lost-lines') as typeof import('../src/lost-lines')
  return {
    ...actual,
    getGitDiff: jest.fn(),
    parseGitDiff: jest.fn(),
    computeLostLinesReport: jest.fn()
  }
})

const mockCheckFileExists = jest.mocked(utilsModule.checkFileExists)
const mockDownloadArtifacts = jest.mocked(utilsModule.downloadArtifacts)
const mockParseCoverage = jest.mocked(utilsModule.parseCoverage)
const mockUploadArtifacts = jest.mocked(utilsModule.uploadArtifacts)
const mockBuildCoveredLinesMap = jest.mocked(utilsModule.buildCoveredLinesMap)
const mockGetGitDiff = jest.mocked(lostLinesModule.getGitDiff)
const mockParseGitDiff = jest.mocked(lostLinesModule.parseGitDiff)
const mockComputeLostLinesReport = jest.mocked(lostLinesModule.computeLostLinesReport)

const mockCoverage = {
  files: {
    abc123: {
      relative: 'src/foo.ts',
      absolute: '/repo/src/foo.ts',
      coverage: 80,
      lines_covered: 8,
      lines_valid: 10
    }
  },
  coverage: 80,
  timestamp: 0,
  basePath: '/repo/src'
}

let originalWriteFunction: (str: string) => boolean
const savedEnv: NodeJS.ProcessEnv = JSON.parse(JSON.stringify(process.env))
let tempSummaryFile: string
let tempOutputFile: string

beforeAll(async () => {
  originalWriteFunction = process.stdout.write
  process.stdout.write = jest.fn(() => true) as any

  tempSummaryFile = path.join(
    __dirname,
    `temp-run-summary-${crypto.randomBytes(4).toString('hex')}.md`
  )
  tempOutputFile = path.join(
    __dirname,
    `temp-run-output-${crypto.randomBytes(4).toString('hex')}.txt`
  )
  await fs.promises.writeFile(tempSummaryFile, '')
  await fs.promises.writeFile(tempOutputFile, '')
})

afterAll(async () => {
  process.stdout.write = originalWriteFunction as any
  try {
    await fs.promises.unlink(tempSummaryFile)
  } catch {}
  try {
    await fs.promises.unlink(tempOutputFile)
  } catch {}
  process.env = { ...savedEnv }
})

beforeEach(async () => {
  process.env = {
    ...JSON.parse(JSON.stringify(savedEnv)),
    GITHUB_STEP_SUMMARY: tempSummaryFile,
    GITHUB_OUTPUT: tempOutputFile,
    INPUT_GITHUB_TOKEN: 'token',
    INPUT_FILENAME: 'coverage.xml',
    INPUT_ARTIFACT_NAME: 'coverage-%name%',
    // Use a unique filename to avoid colliding with functions.test.ts parallel runs
    INPUT_MARKDOWN_FILENAME: 'run-test-coverage-results'
  }
  await fs.promises.writeFile(tempSummaryFile, '')
  await fs.promises.writeFile(tempOutputFile, '')

  mockCheckFileExists.mockReset().mockResolvedValue(true)
  mockDownloadArtifacts.mockReset().mockResolvedValue(null)
  mockParseCoverage.mockReset().mockResolvedValue(mockCoverage as any)
  mockUploadArtifacts
    .mockReset()
    .mockResolvedValue({ id: 1, size: 100, artifactItems: [] } as any)
  mockBuildCoveredLinesMap.mockReset().mockReturnValue({})
  mockGetGitDiff.mockReset().mockResolvedValue('')
  mockParseGitDiff.mockReset().mockReturnValue(new Map())
  mockComputeLostLinesReport.mockReset().mockReturnValue({
    files: [],
    overallBaseCoveredCount: 0,
    overallLostCount: 0,
    overallLostPercentage: 0
  })
})

afterEach(async () => {
  try {
    await fs.promises.unlink('run-test-coverage-results.md')
  } catch {}
})

test('run: missing file calls setFailed', async () => {
  mockCheckFileExists.mockResolvedValue(false)
  const setFailed = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((() => {}) as any)

  await run()

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('Unable to access')
  )
  setFailed.mockRestore()
})

test('run: pull_request with base artifact generates markdown with both coverages', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'

  mockDownloadArtifacts.mockResolvedValue('/tmp/test-artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)

  await run()

  expect(mockDownloadArtifacts).toHaveBeenCalledWith('main')
  expect(mockParseCoverage).toHaveBeenCalledTimes(2)
})

test('run: pull_request without base artifact warns and generates markdown with head only', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'

  mockDownloadArtifacts.mockResolvedValue(null)
  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  const warnSpy = jest
    .spyOn(core, 'warning')
    .mockImplementation((() => {}) as any)

  await run()

  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing'))
  expect(mockParseCoverage).toHaveBeenCalledTimes(1)
  warnSpy.mockRestore()
})

test('run: pull_request_target works like pull_request', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request_target'
  process.env.GITHUB_BASE_REF = 'develop'

  mockDownloadArtifacts.mockResolvedValue(null)
  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  await run()

  expect(mockDownloadArtifacts).toHaveBeenCalledWith('develop')
})

test('run: pull_request with null head coverage calls setFailed', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'

  mockDownloadArtifacts.mockResolvedValue(null)
  mockParseCoverage.mockResolvedValue(null)

  const setFailed = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((() => {}) as any)

  await run()

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('Unable to process')
  )
  setFailed.mockRestore()
})

test('run: pull_request with excludePaths filters both coverages', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'
  process.env.INPUT_EXCLUDE_PATHS = 'tests/'

  mockDownloadArtifacts.mockResolvedValue('/tmp/artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)

  await run()

  expect(mockParseCoverage).toHaveBeenCalledTimes(2)
})

test('run: push event uploads artifacts and generates markdown', async () => {
  process.env.GITHUB_EVENT_NAME = 'push'
  process.env.GITHUB_REF_NAME = 'main'
  process.env.GITHUB_WORKFLOW = 'CI'

  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  await run()

  expect(mockUploadArtifacts).toHaveBeenCalledWith(['coverage.xml'], 'main')
  expect(mockParseCoverage).toHaveBeenCalledTimes(1)
})

test('run: schedule event uploads and generates markdown', async () => {
  process.env.GITHUB_EVENT_NAME = 'schedule'
  process.env.GITHUB_REF_NAME = 'release/1.0'

  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  await run()

  expect(mockUploadArtifacts).toHaveBeenCalledWith(
    ['coverage.xml'],
    'release/1.0'
  )
})

test('run: workflow_dispatch event uploads and generates markdown', async () => {
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'
  process.env.GITHUB_REF_NAME = 'main'

  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  await run()

  expect(mockUploadArtifacts).toHaveBeenCalled()
})

test('run: push with null head coverage skips generateMarkdown', async () => {
  process.env.GITHUB_EVENT_NAME = 'push'
  process.env.GITHUB_REF_NAME = 'main'

  mockParseCoverage.mockResolvedValue(null)

  await run()

  expect(mockUploadArtifacts).toHaveBeenCalled()
  // Should complete without error
})

test('run: push with excludePaths filters head coverage', async () => {
  process.env.GITHUB_EVENT_NAME = 'push'
  process.env.GITHUB_REF_NAME = 'main'
  process.env.INPUT_EXCLUDE_PATHS = 'tests/, e2e/'

  mockParseCoverage.mockResolvedValue(mockCoverage as any)

  await run()

  expect(mockParseCoverage).toHaveBeenCalled()
  expect(mockUploadArtifacts).toHaveBeenCalled()
})

test('run: unknown event does nothing', async () => {
  process.env.GITHUB_EVENT_NAME = 'repository_dispatch'

  await run()

  expect(mockDownloadArtifacts).not.toHaveBeenCalled()
  expect(mockUploadArtifacts).not.toHaveBeenCalled()
  expect(mockParseCoverage).not.toHaveBeenCalled()
})

test('run: exception from uploadArtifacts calls setFailed', async () => {
  process.env.GITHUB_EVENT_NAME = 'push'
  process.env.GITHUB_REF_NAME = 'main'

  mockUploadArtifacts.mockRejectedValue(new Error('Network error'))

  const setFailed = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((() => {}) as any)

  await run()

  expect(setFailed).toHaveBeenCalledWith('Network error')
  setFailed.mockRestore()
})

test('run: exception from downloadArtifacts calls setFailed', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'

  mockDownloadArtifacts.mockRejectedValue(new Error('Download failed'))

  const setFailed = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((() => {}) as any)

  await run()

  expect(setFailed).toHaveBeenCalledWith('Download failed')
  setFailed.mockRestore()
})

// ---------------------------------------------------------------------------
// track_lost_lines tests
// ---------------------------------------------------------------------------

test('run: pull_request with track_lost_lines=true calls lost lines analysis', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'
  process.env.INPUT_TRACK_LOST_LINES = 'true'

  mockDownloadArtifacts.mockResolvedValue('/tmp/test-artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)
  mockBuildCoveredLinesMap.mockReturnValue({ 'src/foo.ts': [1, 2, 3] })
  mockGetGitDiff.mockResolvedValue('')

  await run()

  expect(mockBuildCoveredLinesMap).toHaveBeenCalled()
  expect(mockGetGitDiff).toHaveBeenCalledWith('main')
  expect(mockComputeLostLinesReport).toHaveBeenCalled()
  delete process.env.INPUT_TRACK_LOST_LINES
})

test('run: pull_request with track_lost_lines=true but no covered lines warns and skips', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'
  process.env.INPUT_TRACK_LOST_LINES = 'true'

  mockDownloadArtifacts.mockResolvedValue('/tmp/test-artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)
  mockBuildCoveredLinesMap.mockReturnValue({}) // no covered lines

  const warnSpy = jest.spyOn(core, 'warning').mockImplementation((() => {}) as any)

  await run()

  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No covered_lines'))
  expect(mockComputeLostLinesReport).not.toHaveBeenCalled()
  warnSpy.mockRestore()
  delete process.env.INPUT_TRACK_LOST_LINES
})

test('run: pull_request with track_lost_lines=true when git diff fails warns and skips', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'
  process.env.INPUT_TRACK_LOST_LINES = 'true'

  mockDownloadArtifacts.mockResolvedValue('/tmp/test-artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)
  mockBuildCoveredLinesMap.mockReturnValue({ 'src/foo.ts': [1, 2, 3] })
  mockGetGitDiff.mockRejectedValue(new Error('git not found'))

  const warnSpy = jest.spyOn(core, 'warning').mockImplementation((() => {}) as any)

  await run()

  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('git diff failed'))
  expect(mockComputeLostLinesReport).not.toHaveBeenCalled()
  warnSpy.mockRestore()
  delete process.env.INPUT_TRACK_LOST_LINES
})

test('run: pull_request with track_lost_lines=true and exclude paths filters base covered lines map', async () => {
  process.env.GITHUB_EVENT_NAME = 'pull_request'
  process.env.GITHUB_BASE_REF = 'main'
  process.env.GITHUB_HEAD_REF = 'feature/my-branch'
  process.env.INPUT_TRACK_LOST_LINES = 'true'
  process.env.INPUT_EXCLUDE_PATHS = 'tests/'

  mockDownloadArtifacts.mockResolvedValue('/tmp/test-artifacts')
  mockParseCoverage
    .mockResolvedValueOnce(mockCoverage as any)
    .mockResolvedValueOnce(mockCoverage as any)
  // Simulate base map with one excluded file
  mockBuildCoveredLinesMap.mockReturnValue({
    'src/foo.ts': [1, 2, 3],
    'tests/foo.test.ts': [4, 5]
  })
  mockGetGitDiff.mockResolvedValue('')

  await run()

  // computeLostLinesReport should have been called with the filtered map (no tests/ file)
  expect(mockComputeLostLinesReport).toHaveBeenCalledWith(
    { 'src/foo.ts': [1, 2, 3] }, // tests/ file excluded
    expect.anything(),
    expect.anything()
  )
  delete process.env.INPUT_TRACK_LOST_LINES
  delete process.env.INPUT_EXCLUDE_PATHS
  delete process.env.GITHUB_HEAD_REF
})
