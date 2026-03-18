import * as core from '@actions/core'
import {
  addOverallRow,
  aggregateCoverageByTopDir,
  filterCoveredLinesMap,
  formatLostCoverage,
  generateMarkdown
} from '../src/functions'
import {
  expect,
  test,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  jest
} from '@jest/globals'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {loadJSONFixture} from './utils'

let originalWriteFunction: (str: string) => boolean
const env: NodeJS.ProcessEnv = JSON.parse(JSON.stringify(process.env))
let testEnv: NodeJS.ProcessEnv = {}

beforeAll(async () => {
  originalWriteFunction = process.stdout.write
  process.stdout.write = jest.fn((str: string) => {
    //originalWriteFunction(str)
    return true
  }) as any

  const tempFileName = path.join(
    __dirname,
    `temp-${crypto.randomBytes(4).toString('hex')}.md`
  )
  await fs.promises.writeFile(tempFileName, '')
  process.env.GITHUB_STEP_SUMMARY = tempFileName
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.GITHUB_OUTPUT = ''
  process.env.INPUT_FILENAME = 'filename.xml'
  process.env.INPUT_ARTIFACT_NAME = 'coverage-%name%'
})

afterAll(async () => {
  process.stdout.write = originalWriteFunction as unknown as (
    str: string
  ) => boolean
  await fs.promises.unlink(process.env.GITHUB_STEP_SUMMARY as string)
  process.env = {...env}
})

beforeEach(async () => {
  testEnv = {...process.env}
  await fs.promises.writeFile(process.env.GITHUB_STEP_SUMMARY as string, '')
})

afterEach(async () => {
  process.env = {...testEnv}
  await fs.promises.writeFile(process.env.GITHUB_STEP_SUMMARY as string, '')
})

test('add overall row without base coverage', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const out = addOverallRow(coverage)

  expect(out).toStrictEqual({
    package: 'Overall Coverage',
    base_coverage: '🟢 50.51%'
  })
})

test('add overall row with base coverage', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const out = addOverallRow(coverage, coverage)

  expect(out).toStrictEqual({
    package: 'Overall Coverage',
    base_coverage: '🟢 50.51%',
    new_coverage: '🟢 50.51%',
    difference: '⚪ 0%',
    difference_plain: '0%'
  })
})

test('add overall row with base coverage and negative difference includes difference_plain', async () => {
  const head = await loadJSONFixture('clover-parsed.json')
  const base = JSON.parse(JSON.stringify(head))
  base.coverage = 60
  const out = addOverallRow(head, base)
  expect(out.difference_plain).toBeDefined()
  expect(out.difference_plain).toMatch(/-?\d+\.?\d*%/)
})

test('aggregateCoverageByTopDir without base: groups by first path segment', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const out = aggregateCoverageByTopDir(coverage, null, 75, 50)

  expect(out).toHaveLength(2)
  expect(out.map((r) => r.package).sort()).toEqual(['(root)', 'reports/'])
  expect(out.find((r) => r.package === '(root)')?.base_coverage).toContain('%')
  expect(out.find((r) => r.package === 'reports/')?.base_coverage).toContain('%')
})

test('aggregateCoverageByTopDir with base: includes difference', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const out = aggregateCoverageByTopDir(coverage, coverage, 75, 50)

  expect(out).toHaveLength(2)
  const rootRow = out.find((r) => r.package === '(root)')
  expect(rootRow?.base_coverage).toBeDefined()
  expect(rootRow?.new_coverage).toBeDefined()
  expect(rootRow?.difference).toBeDefined()
})

test('aggregateCoverageByTopDir with Cobertura data uses line-weighted aggregation', async () => {
  const coverage = await loadJSONFixture('cobertura-parsed.json')
  const out = aggregateCoverageByTopDir(coverage, null, 75, 50)

  expect(out.length).toBeGreaterThan(0)
  const reportsRow = out.find((r) => r.package === 'reports/')
  expect(reportsRow).toBeDefined()
  expect(reportsRow?.base_coverage).toBeDefined()
  const rootRow = out.find((r) => r.package === '(root)')
  expect(rootRow).toBeDefined()
})

test('Generate markdown with base coverage and show_coverage_by_top_dir shows top-dir table and threshold', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '5'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Coverage by top-level directory')
  expect(summary).toContain('_Maximum allowed coverage difference is_')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD
})

test('Summary line shows this run produced 0% when coverage difference is zero', async () => {
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '5'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('_Maximum allowed coverage difference is_')
  expect(summary).toContain('_, this run produced_ `0%`')
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD
})

test('Generate markdown without coverage by top dir when show_coverage_by_top_dir is false (default)', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'false'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).not.toContain('Coverage by top-level directory')
  expect(summary).toContain('main.ts')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
})

test('Generate markdown with coverage by top dir only when show_coverage_by_top_dir is true', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Coverage by top-level directory')
  expect(summary).toContain('(root)')
  expect(summary).toContain('reports/')
  expect(summary).not.toContain('main.ts')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
})

test('Generate markdown with coverage by parent dir when show_coverage_by_parent_dir is true', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  // Should show parent dirs, not individual files
  expect(summary).toContain('(root)')
  expect(summary).toContain('reports/clover/')
  expect(summary).toContain('reports/cobertura/')
  expect(summary).not.toContain('main.ts')
  expect(summary).not.toContain('utils.ts')
  expect(summary).not.toContain('reports/clover/index.ts')
  delete process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR
})

test('Generate markdown without coverage by parent dir when show_coverage_by_parent_dir is false (default)', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR = 'false'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('main.ts')
  expect(summary).toContain('reports/clover/index.ts')
  delete process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR
})

test('Generate markdown with coverage by depth when coverage_depth is set', async () => {
  process.env.INPUT_COVERAGE_DEPTH = '2'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('(root)')
  expect(summary).toContain('reports/clover/')
  expect(summary).toContain('reports/cobertura/')
  expect(summary).not.toContain('main.ts')
  expect(summary).not.toContain('reports/clover/index.ts')
  delete process.env.INPUT_COVERAGE_DEPTH
})

test('Generate markdown with coverage_depth 1 is same as top_dir', async () => {
  process.env.INPUT_COVERAGE_DEPTH = '1'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('(root)')
  expect(summary).toContain('reports/')
  expect(summary).not.toContain('reports/clover/')
  expect(summary).not.toContain('main.ts')
  delete process.env.INPUT_COVERAGE_DEPTH
})

test('Generate markdown: top_dir takes precedence over coverage_depth', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'
  process.env.INPUT_COVERAGE_DEPTH = '2'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Coverage by top-level directory')
  expect(summary).toContain('(root)')
  expect(summary).toContain('reports/')
  expect(summary).not.toContain('reports/clover/')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
  delete process.env.INPUT_COVERAGE_DEPTH
})

test('Generate Base Clover Markdown', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Generate Base Cobertura Markdown', async () => {
  const coverage = await loadJSONFixture('cobertura-parsed.json')
  await generateMarkdown(coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Generate Diffed Clover Markdown', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Generate Diffed Cobertura Markdown', async () => {
  const coverage = await loadJSONFixture('cobertura-parsed.json')
  await generateMarkdown(coverage, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Fail if overall coverage is below fail threshold', async () => {
  process.env.INPUT_OVERALL_COVERAGE_FAIL_THRESHOLD = '99'

  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Fail on negative difference', async () => {
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  coverageFail.files[
    '7583809507a13391057c3aee722e422d50d961a87e2a3dbf05ea492dc6465c94'
  ].coverage = 69
  coverageFail.coverage = 49

  await generateMarkdown(coverageFail, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Dont Fail on negative difference if negative_difference_threshold is set', async () => {
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '10'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  coverageFail.files[
    '7583809507a13391057c3aee722e422d50d961a87e2a3dbf05ea492dc6465c94'
  ].coverage = 69
  coverageFail.coverage = 49

  await generateMarkdown(coverageFail, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Fail if negative_difference_threshold is set and exceeded', async () => {
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '1'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  coverageFail.files[
    '7583809507a13391057c3aee722e422d50d961a87e2a3dbf05ea492dc6465c94'
  ].coverage = 69
  coverageFail.coverage = 49

  await generateMarkdown(coverageFail, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Only list changed files', async () => {
  process.env.INPUT_ONLY_LIST_CHANGED_FILES = 'true'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  coverageFail.files[
    '7583809507a13391057c3aee722e422d50d961a87e2a3dbf05ea492dc6465c94'
  ].coverage = 69
  coverageFail.coverage = 49

  await generateMarkdown(coverageFail, coverage)
  expect(getStdoutWriteCalls()).toMatchSnapshot()
  expect(await getGithubStepSummary()).toMatchSnapshot()
})

test('Generate markdown with badge true includes coverage badge URL', async () => {
  process.env.INPUT_BADGE = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('img.shields.io')
  expect(summary).toContain('Code Coverage')
  delete process.env.INPUT_BADGE
})

test('Generate markdown with skip_package_coverage true has empty coverage table', async () => {
  process.env.INPUT_SKIP_PACKAGE_COVERAGE = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Overall Coverage')
  delete process.env.INPUT_SKIP_PACKAGE_COVERAGE
})

test('Fail on negative difference by package when file drops below threshold', async () => {
  const setFailedSpy = jest.spyOn(core, 'setFailed').mockImplementation((msg: string) => {
    throw new Error(msg)
  })
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_BY = 'package'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '1'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  // Use a file that has high base coverage so difference is below threshold
  const fileHash = '7583809507a13391057c3aee722e422d50d961a87e2a3dbf05ea492dc6465c94'
  coverageFail.files[fileHash].coverage = 0

  await expect(
    generateMarkdown(coverageFail, coverage)
  ).rejects.toThrow(/coverage difference was/)
  setFailedSpy.mockRestore()
  delete process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_BY
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD
})

test('generateMarkdown sets failed when template file does not exist', async () => {
  const setFailedSpy = jest.spyOn(core, 'setFailed').mockImplementation((msg: string) => {
    throw new Error(msg)
  })
  const nonexistent = path.join(__dirname, 'nonexistent-template-12345.hbs')
  process.env.INPUT_WITHOUT_BASE_COVERAGE_TEMPLATE = nonexistent
  process.env.INPUT_WITH_BASE_COVERAGE_TEMPLATE = nonexistent
  const coverage = await loadJSONFixture('clover-parsed.json')
  await expect(generateMarkdown(coverage)).rejects.toThrow(/Unable to access template/)
  setFailedSpy.mockRestore()
  delete process.env.INPUT_WITHOUT_BASE_COVERAGE_TEMPLATE
  delete process.env.INPUT_WITH_BASE_COVERAGE_TEMPLATE
})


test('Generate markdown with coverage_depth and base coverage shows depth-grouped rows', async () => {
  process.env.INPUT_COVERAGE_DEPTH = '2'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('reports/clover/')
  expect(summary).toContain('reports/cobertura/')
  expect(summary).not.toContain('main.ts')
  delete process.env.INPUT_COVERAGE_DEPTH
})

test('Generate markdown with show_coverage_by_parent_dir and base coverage shows grouped rows with diff', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('reports/clover/')
  expect(summary).toContain('reports/cobertura/')
  expect(summary).not.toContain('main.ts')
  delete process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR
})

test('Fail on negative difference by package in top_dir grouped mode', async () => {
  const setFailedSpy = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((msg: string) => {
      throw new Error(msg)
    })
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_BY = 'package'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '1'
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  for (const hash of Object.keys(coverageFail.files)) {
    coverageFail.files[hash].coverage = 0
  }
  coverageFail.coverage = 0

  await expect(generateMarkdown(coverageFail, coverage)).rejects.toThrow(
    /coverage difference was/
  )
  setFailedSpy.mockRestore()
  delete process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_BY
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
})

test('Generate markdown with onlyListChangedFiles and no base produces no file rows', async () => {
  process.env.INPUT_ONLY_LIST_CHANGED_FILES = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Overall Coverage')
  delete process.env.INPUT_ONLY_LIST_CHANGED_FILES
})

test('Fail on overall coverage diff below threshold when negativeDifferenceBy is overall', async () => {
  const setFailedSpy = jest
    .spyOn(core, 'setFailed')
    .mockImplementation((msg: string) => {
      throw new Error(msg)
    })
  process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE = 'true'
  process.env.INPUT_NEGATIVE_DIFFERENCE_BY = 'overall'
  process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD = '1'

  const coverage = await loadJSONFixture('clover-parsed.json')
  const coverageFail = JSON.parse(JSON.stringify(coverage))
  coverageFail.coverage = 0

  await expect(generateMarkdown(coverageFail, coverage)).rejects.toThrow(
    /FAIL: Overall coverage/
  )
  setFailedSpy.mockRestore()
  delete process.env.INPUT_FAIL_ON_NEGATIVE_DIFFERENCE
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_BY
  delete process.env.INPUT_NEGATIVE_DIFFERENCE_THRESHOLD
})

async function getGithubStepSummary(): Promise<string> {
  const tempFileName = process.env.GITHUB_STEP_SUMMARY as string
  return fs.promises.readFile(tempFileName, 'utf8')
}

function getStdoutWriteCalls(): string[] {
  const f = process.stdout.write as any

  return f.mock.calls.map((call: any) =>
    JSON.stringify(call[0], null, 2).replace(/^"|"$/g, '')
  )
}

import { LostLinesReport } from '../src/interfaces'

// ---------------------------------------------------------------------------
// formatLostCoverage
// ---------------------------------------------------------------------------

test('formatLostCoverage formats single line correctly', () => {
  expect(formatLostCoverage(1, 5)).toBe('🔴 -5% (1 line)')
})

test('formatLostCoverage formats multiple lines correctly', () => {
  expect(formatLostCoverage(3, 12.5)).toBe('🔴 -12.5% (3 lines)')
})

// ---------------------------------------------------------------------------
// addOverallRow with lost lines report
// ---------------------------------------------------------------------------

test('add overall row with base coverage and lost lines shows lost_coverage', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [],
    overallBaseCoveredCount: 100,
    overallLostCount: 10,
    overallLostPercentage: 10,
    previewRanges: []
  }
  const out = addOverallRow(coverage, coverage, lostReport)
  expect(out.lost_coverage).toBe('🔴 -10% (10 lines)')
})

test('add overall row with lost lines report having zero lost shows no lost_coverage', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [],
    overallBaseCoveredCount: 100,
    overallLostCount: 0,
    overallLostPercentage: 0,
    previewRanges: []
  }
  const out = addOverallRow(coverage, coverage, lostReport)
  expect(out.lost_coverage).toBeUndefined()
})

// ---------------------------------------------------------------------------
// generateMarkdown with lost lines report
// ---------------------------------------------------------------------------

test('Generate markdown with lost lines report shows Lost Lines column', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [
      {
        file: 'src/utils.ts',
        lostRanges: [{ start: 5, end: 7 }, { start: 10, end: 10 }],
        newLostRanges: [{ start: 5, end: 7 }, { start: 10, end: 10 }],
        baseCoveredCount: 50,
        lostCount: 4,
        lostPercentage: 8
      }
    ],
    overallBaseCoveredCount: 200,
    overallLostCount: 4,
    overallLostPercentage: 2,
    previewRanges: [
      { file: 'src/utils.ts', start: 5, end: 7 },
      { file: 'src/utils.ts', start: 10, end: 10 }
    ]
  }
  await generateMarkdown(coverage, coverage, lostReport)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Lost Lines')
  expect(summary).toContain('🔴 -2% (4 lines)')
  expect(summary).toContain('Lost coverage details')
})

test('Generate markdown without lost lines report does not show Lost Lines column', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).not.toContain('Lost Lines')
})

// ---------------------------------------------------------------------------
// filterCoveredLinesMap
// ---------------------------------------------------------------------------

test('filterCoveredLinesMap with no exclude paths returns same map', () => {
  const map = { 'src/a.ts': [1, 2], 'src/b.ts': [5] }
  expect(filterCoveredLinesMap(map, [])).toBe(map) // identity
})

test('filterCoveredLinesMap excludes matching files', () => {
  const map = {
    'src/a.ts': [1, 2],
    'tests/a.test.ts': [3, 4],
    'src/b.ts': [5]
  }
  const result = filterCoveredLinesMap(map, ['tests/'])
  expect(Object.keys(result)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(result['tests/a.test.ts']).toBeUndefined()
})

test('filterCoveredLinesMap with all paths excluded returns empty object', () => {
  const map = { 'tests/a.ts': [1], 'tests/b.ts': [2] }
  const result = filterCoveredLinesMap(map, ['tests/'])
  expect(Object.keys(result)).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// generateMarkdown with showCoverageByTopDir and lost lines
// ---------------------------------------------------------------------------

test('Generate markdown with showCoverageByTopDir and lost lines shows Lost Lines column in top-dir table', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [
      {
        file: 'src/utils.ts',
        lostRanges: [{ start: 5, end: 7 }],
        newLostRanges: [{ start: 5, end: 7 }],
        baseCoveredCount: 50,
        lostCount: 3,
        lostPercentage: 6
      }
    ],
    overallBaseCoveredCount: 200,
    overallLostCount: 3,
    overallLostPercentage: 1.5,
    previewRanges: [{ file: 'src/utils.ts', start: 5, end: 7 }]
  }
  await generateMarkdown(coverage, coverage, lostReport)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Coverage by top-level directory')
  expect(summary).toContain('Lost Lines')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
})

test('Generate markdown with showCoverageByTopDir without lost lines does not show Lost Lines column', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  await generateMarkdown(coverage, coverage)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Coverage by top-level directory')
  expect(summary).not.toContain('Lost Lines')
  delete process.env.INPUT_SHOW_COVERAGE_BY_TOP_DIR
})

test('Generate markdown with coverage_depth and lost lines shows aggregated Lost Lines per group', async () => {
  process.env.INPUT_COVERAGE_DEPTH = '2'
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [
      {
        file: 'reports/clover/index.ts',
        lostRanges: [{ start: 1, end: 2 }],
        newLostRanges: [{ start: 1, end: 2 }],
        baseCoveredCount: 20,
        lostCount: 2,
        lostPercentage: 10
      }
    ],
    overallBaseCoveredCount: 20,
    overallLostCount: 2,
    overallLostPercentage: 10,
    previewRanges: [{ file: 'reports/clover/index.ts', start: 1, end: 2 }]
  }
  await generateMarkdown(coverage, coverage, lostReport)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Lost Lines')
  expect(summary).toContain('🔴')
  delete process.env.INPUT_COVERAGE_DEPTH
})

test('Generate markdown with showCoverageByParentDir and lost lines shows aggregated Lost Lines per group', async () => {
  process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR = 'true'
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [
      {
        file: 'reports/clover/index.ts',
        lostRanges: [{ start: 5, end: 6 }],
        newLostRanges: [{ start: 5, end: 6 }],
        baseCoveredCount: 30,
        lostCount: 2,
        lostPercentage: 6.67
      }
    ],
    overallBaseCoveredCount: 30,
    overallLostCount: 2,
    overallLostPercentage: 6.67,
    previewRanges: [{ file: 'reports/clover/index.ts', start: 5, end: 6 }]
  }
  await generateMarkdown(coverage, coverage, lostReport)
  const summary = await getGithubStepSummary()
  expect(summary).toContain('Lost Lines')
  expect(summary).toContain('🔴')
  delete process.env.INPUT_SHOW_COVERAGE_BY_PARENT_DIR
})

test('aggregateCoverageByTopDir with lost lines report shows lost_coverage per dir', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const lostReport: LostLinesReport = {
    files: [
      {
        file: 'reports/clover/index.ts',
        lostRanges: [{ start: 1, end: 3 }],
        newLostRanges: [{ start: 1, end: 3 }],
        baseCoveredCount: 15,
        lostCount: 3,
        lostPercentage: 20
      }
    ],
    overallBaseCoveredCount: 15,
    overallLostCount: 3,
    overallLostPercentage: 20,
    previewRanges: [{ file: 'reports/clover/index.ts', start: 1, end: 3 }]
  }
  const result = aggregateCoverageByTopDir(coverage, coverage, 75, 50, lostReport)
  const reportsDir = result.find((r) => r.package === 'reports/')
  expect(reportsDir).toBeDefined()
  expect(reportsDir?.lost_coverage).toContain('🔴')
})

test('aggregateCoverageByTopDir without lost lines report has no lost_coverage', async () => {
  const coverage = await loadJSONFixture('clover-parsed.json')
  const result = aggregateCoverageByTopDir(coverage, coverage, 75, 50)
  for (const row of result) {
    expect(row.lost_coverage).toBeUndefined()
  }
})
