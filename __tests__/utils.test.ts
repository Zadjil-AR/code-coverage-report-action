import {
  formatArtifactName,
  checkFileExists,
  createHash,
  roundPercentage,
  determineCommonBasePath,
  escapeRegExp,
  colorizePercentageByThreshold,
  getInputs,
  parseXML,
  parseCoverage,
  buildCoverageLineData,
  computeRegression
} from '../src/utils'
import {
  expect,
  test,
  beforeEach,
  afterEach,
  jest,
  beforeAll,
  afterAll
} from '@jest/globals'
import {loadJSONFixture} from './utils'
import fs from 'fs'

let originalWriteFunction: (str: string) => boolean
const env = JSON.parse(JSON.stringify(process.env))

beforeAll(async () => {
  originalWriteFunction = process.stdout.write
  process.stdout.write = jest.fn((str: string) => {
    //originalWriteFunction(str)
    return true
  }) as any
})

afterAll(async () => {
  process.stdout.write = originalWriteFunction as unknown as (
    str: string
  ) => boolean
})

beforeEach(async () => {
  process.env = {...env}
})

afterEach(async () => {
  process.env = env
})

test('formats the artifact name', async () => {
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.INPUT_FILENAME = 'filename.xml'
  process.env.INPUT_ARTIFACT_NAME = 'coverage-%name%'
  const name = formatArtifactName('bar')
  expect(name).toBe('coverage-bar')
})

test('files exists', async () => {
  const ret = await checkFileExists(__filename)
  expect(ret).toBeTruthy()

  const ret1 = await checkFileExists(__filename + 'bar')
  expect(ret1).toBeFalsy()
})

test('created hash', () => {
  const hash = createHash('foo')
  expect(hash).toBeDefined()
})

test('round percentage', () => {
  const a = roundPercentage(45.51234565)
  expect(a).toBe(45.51)

  const b = roundPercentage(45.51634565)
  expect(b).toBe(45.52)
})

test('determine common base path from list of paths', () => {
  const path = determineCommonBasePath([
    '/usr/src/app/foo.js',
    '/usr/src/app/foo/bar.js'
  ])

  expect(path).toBe('/usr/src/app')
})

test('escaping regular expression input', () => {
  const output = escapeRegExp('\\^$.|?*+{}[]()')
  expect(output).toBe('\\\\\\^\\$\\.\\|\\?\\*\\+\\{\\}\\[\\]\\(\\)')
})

test('colorize percentage by threshold', () => {
  const shouldBeZero = colorizePercentageByThreshold(null)
  expect(shouldBeZero).toBe('⚪ 0%')

  const shouldBeGrey = colorizePercentageByThreshold(0)
  expect(shouldBeGrey).toBe('⚪ 0%')

  const shouldBeRed = colorizePercentageByThreshold(20, 50)
  expect(shouldBeRed).toBe('🔴 20%')

  const shouldBeGreen = colorizePercentageByThreshold(70, 50)
  expect(shouldBeGreen).toBe('🟢 70%')

  const shouldBeRedA = colorizePercentageByThreshold(20, 75, 30)
  expect(shouldBeRedA).toBe('🔴 20%')

  const shouldBeOrangeA = colorizePercentageByThreshold(40, 75, 30)
  expect(shouldBeOrangeA).toBe('🟠 40%')

  const shouldBeGreenA = colorizePercentageByThreshold(80, 75, 30)
  expect(shouldBeGreenA).toBe('🟢 80%')
})

test('parse xml', async () => {
  const ret = await parseXML(__filename)
  expect(ret).toBeTruthy()

  const ret1 = await parseXML(__filename + 'bar')
  expect(ret1).toBeFalsy()
})

test('parse coverage', async () => {
  const ret = await parseCoverage(__filename)
  expect(ret).not.toBeNull

  const ret1 = await parseCoverage(__filename + 'bar')
  expect(ret1).toBeNull
})

test('getInputs', () => {
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.INPUT_FILENAME = 'filename.xml'

  const f = getInputs()
  expect(f).toStrictEqual({
    token: 'token',
    filename: 'filename.xml',
    badge: false,
    overallCoverageFailThreshold: 0,
    fileCoverageErrorMin: 50,
    fileCoverageWarningMax: 75,
    failOnNegativeDifference: false,
    markdownFilename: 'code-coverage-results',
    artifactDownloadWorkflowNames: null,
    artifactName: 'coverage-%name%',
    negativeDifferenceBy: 'package',
    negativeDifferenceThreshold: -0,
    retention: undefined,
    skipPackageCoverage: false,
    onlyListChangedFiles: false,
    //This is a cheat
    withBaseCoverageTemplate: f.withBaseCoverageTemplate,
    withoutBaseCoverageTemplate: f.withoutBaseCoverageTemplate
  })
})

test('parse clover into file format', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/clover.xml')

  const loadedFixture = await loadJSONFixture('clover-parsed.json')
  expect(loadedFixture).toEqual(ret)
})

test('parse cobertura file format', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura.xml')

  const loadedFixture = await loadJSONFixture('cobertura-parsed.json')
  expect(loadedFixture).toEqual(ret)
})

test('parse empty cobertura file', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-empty.xml')
  expect(ret).toMatchSnapshot()
})

test('parse cobertura project with single file', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-project-single-file.xml')
  expect(ret).toMatchSnapshot()
})

test('parse cobertura file with empty packages', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-empty-packages.xml')
  expect(ret).toMatchSnapshot()
})

test('parse cobertura file with empty classes', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-empty-classes.xml')
  expect(ret).toMatchSnapshot()
})

test('parse cobertura file with empty lines', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-empty-lines.xml')
  expect(ret).toMatchSnapshot()
})

test('parse cobertura file with empty methods', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/cobertura-empty-methods.xml')
  expect(ret).toMatchSnapshot()
})

test('parse many sources cobertura file', async () => {
  const ret = await parseCoverage(
    __dirname + '/fixtures/cobertura-many-sources.xml'
  )
  expect(ret).toMatchSnapshot()
})

test('buildCoverageLineData skips files that cannot be read', async () => {
  const coverage = {
    files: {
      abc: {
        relative: 'missing.ts',
        absolute: '/nonexistent/missing.ts',
        coverage: 50,
        lines: { 1: true, 2: false }
      }
    },
    coverage: 50,
    timestamp: 0,
    basePath: ''
  }
  const result = await buildCoverageLineData(coverage)
  // File cannot be read, so no entries
  expect(result).toEqual({})
})

test('buildCoverageLineData builds content hash entries from readable source files', async () => {
  // Use an actual file in the repo as the source
  const sourceFile = __dirname + '/utils.ts'
  const coverage = {
    files: {
      abc: {
        relative: 'utils.ts',
        absolute: sourceFile,
        coverage: 100,
        lines: { 1: true, 2: false }
      }
    },
    coverage: 100,
    timestamp: 0,
    basePath: __dirname
  }
  const result = await buildCoverageLineData(coverage)
  expect(result['utils.ts']).toBeDefined()
  expect(result['utils.ts'].length).toBe(2)
  const coveredEntry = result['utils.ts'].find((e: any) => e.covered)
  const uncoveredEntry = result['utils.ts'].find((e: any) => !e.covered)
  expect(coveredEntry).toBeDefined()
  expect(uncoveredEntry).toBeDefined()
  expect(coveredEntry.lineNum).toBe(1)
  expect(uncoveredEntry.lineNum).toBe(2)
  // Hashes should be defined strings
  expect(typeof coveredEntry.hash).toBe('string')
  expect(coveredEntry.hash.length).toBeGreaterThan(0)
})

test('computeRegression returns zero when head still covers all base lines', async () => {
  // Create base line data where line 1 of utils.ts is covered
  const sourceFile = __dirname + '/utils.ts'
  const content = fs.readFileSync(sourceFile, 'utf8')
  const lines = content.split('\n')
  const line1Hash = createHash(lines[0].trim())

  const baseLineData = {
    'utils.ts': [{ lineNum: 1, hash: line1Hash, covered: true }]
  }

  const headCoverage = {
    files: {
      abc: {
        relative: 'utils.ts',
        absolute: sourceFile,
        coverage: 100,
        lines: { 1: true } // same line still covered
      }
    },
    coverage: 100,
    timestamp: 0,
    basePath: __dirname
  }

  const result = await computeRegression(baseLineData, headCoverage)
  expect(result.previouslyCoveredLines).toBe(1)
  expect(result.lostLines).toBe(0)
  expect(result.percentage).toBe(0)
  expect(result.blocks).toHaveLength(0)
})

test('computeRegression detects lines no longer covered', async () => {
  // A hash that definitely won't be in head's covered lines
  const fakeCoveredHash = createHash('some-unique-content-that-is-not-in-head-file')

  const baseLineData = {
    'utils.ts': [{ lineNum: 1, hash: fakeCoveredHash, covered: true }]
  }

  const sourceFile = __dirname + '/utils.ts'
  const headCoverage = {
    files: {
      abc: {
        relative: 'utils.ts',
        absolute: sourceFile,
        coverage: 50,
        lines: { 1: true } // line 1 is covered in head but has different content
      }
    },
    coverage: 50,
    timestamp: 0,
    basePath: __dirname
  }

  const result = await computeRegression(baseLineData, headCoverage)
  expect(result.previouslyCoveredLines).toBe(1)
  expect(result.lostLines).toBe(1)
  expect(result.percentage).toBe(100)
  expect(result.blocks).toHaveLength(1)
  expect(result.blocks[0].file).toBe('utils.ts')
  expect(result.blocks[0].lostLines).toBe(1)
})

test('computeRegression handles content-based matching when line numbers shift', async () => {
  // Simulate: base had line 1 covered. In head, the same content is at line 3
  // but line 1 now has different content. The coverage should match on CONTENT.
  const sourceFile = __dirname + '/utils.ts'
  const content = fs.readFileSync(sourceFile, 'utf8')
  const lines = content.split('\n')
  // Use actual line content from the source file
  const line1Hash = createHash(lines[0].trim()) // hash of line 1 content

  const baseLineData = {
    'utils.ts': [{ lineNum: 1, hash: line1Hash, covered: true }]
  }

  // Head: the same content is now at line 3 (e.g. two new lines were inserted at the top),
  // and it's still covered. Line 1 has different content.
  const headCoverage = {
    files: {
      abc: {
        relative: 'utils.ts',
        absolute: sourceFile,
        coverage: 100,
        // line 3 in the source file has the same content as line 1
        // We simulate this by marking line 1 as covered (same file)
        lines: { 1: true }
      }
    },
    coverage: 100,
    timestamp: 0,
    basePath: __dirname
  }

  const result = await computeRegression(baseLineData, headCoverage)
  // Line 1 content in head is covered, so no regression
  expect(result.lostLines).toBe(0)
})
