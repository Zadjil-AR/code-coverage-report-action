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
  buildCoveredRanges,
  computeLostCoverage
} from '../src/utils'
import {
  expect,
  test,
  beforeEach,
  afterEach,
  jest,
  beforeAll,
  afterAll,
  describe
} from '@jest/globals'
import {loadJSONFixture} from './utils'

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
    enableLineLossReport: false,
    //This is a cheat
    withBaseCoverageTemplate: f.withBaseCoverageTemplate,
    withoutBaseCoverageTemplate: f.withoutBaseCoverageTemplate
  })
})

test('getInputs parses artifact_download_workflow_names into an array', () => {
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.INPUT_FILENAME = 'filename.xml'
  process.env.INPUT_ARTIFACT_DOWNLOAD_WORKFLOW_NAMES = 'workflow1, workflow2'

  const f = getInputs()
  expect(f.artifactDownloadWorkflowNames).toEqual(['workflow1', 'workflow2'])
})

test('getInputs throws when artifact_name does not include %name%', () => {
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.INPUT_FILENAME = 'filename.xml'
  process.env.INPUT_ARTIFACT_NAME = 'coverage-report'

  expect(() => getInputs()).toThrow('artifact_name is missing %name% variable')
})

test('parse clover into file format', async () => {
  const ret = await parseCoverage(__dirname + '/fixtures/clover.xml')

  const loadedFixture = await loadJSONFixture('clover-parsed.json')
  expect(loadedFixture).toEqual(ret)
})

test('parse clover retains coveredRanges when enableLineLossReport is true', async () => {
  process.env.INPUT_GITHUB_TOKEN = 'token'
  process.env.INPUT_FILENAME = 'filename.xml'
  process.env.INPUT_ENABLE_LINE_LOSS_REPORT = 'true'

  const ret = await parseCoverage(__dirname + '/fixtures/clover.xml')
  expect(ret).not.toBeNull()
  // coveredRanges should be present and populated when the flag is on
  expect(ret?.coveredRanges).toBeDefined()
  expect(Object.keys(ret?.coveredRanges ?? {})).not.toHaveLength(0)
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

describe('buildCoveredRanges', () => {
  test('returns empty array for empty input', () => {
    expect(buildCoveredRanges([])).toEqual([])
  })

  test('handles a single line', () => {
    expect(buildCoveredRanges([5])).toEqual([[5, 5]])
  })

  test('merges contiguous lines into one range', () => {
    expect(buildCoveredRanges([1, 2, 3, 4, 5])).toEqual([[1, 5]])
  })

  test('handles non-contiguous lines as separate ranges', () => {
    expect(buildCoveredRanges([1, 2, 5, 6, 10])).toEqual([
      [1, 2],
      [5, 6],
      [10, 10]
    ])
  })

  test('sorts unsorted input before merging', () => {
    expect(buildCoveredRanges([10, 1, 5, 6, 2])).toEqual([
      [1, 2],
      [5, 6],
      [10, 10]
    ])
  })

  test('treats adjacent lines as contiguous', () => {
    expect(buildCoveredRanges([3, 4])).toEqual([[3, 4]])
  })
})

describe('computeLostCoverage', () => {
  test('returns zero loss when all base lines are deleted', () => {
    const baseCoveredRanges = { 'src/foo.ts': [[1, 5]] as [number, number][] }
    const newCoveredRanges = {}
    // One hunk that deletes lines 1-5
    const translationMaps = new Map([
      [
        'src/foo.ts',
        [{ oldStart: 1, oldCount: 5, newStart: 1, newCount: 0 }]
      ]
    ])
    const result = computeLostCoverage(
      baseCoveredRanges,
      newCoveredRanges,
      translationMaps
    )
    expect(result.totalLost).toBe(0)
    expect(result.files).toHaveLength(0)
  })

  test('reports lines that moved but are no longer covered', () => {
    const baseCoveredRanges = { 'src/foo.ts': [[1, 3]] as [number, number][] }
    const newCoveredRanges = { 'src/foo.ts': [] as [number, number][] }
    const translationMaps = new Map([['src/foo.ts', []]])

    const result = computeLostCoverage(
      baseCoveredRanges,
      newCoveredRanges,
      translationMaps
    )
    expect(result.totalLost).toBe(3)
    expect(result.totalPreviouslyCovered).toBe(3)
    expect(result.overallLossPercent).toBe(100)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].fileName).toBe('src/foo.ts')
    expect(result.files[0].lostRanges).toEqual([[1, 3]])
  })

  test('does not count covered-in-new lines as lost', () => {
    const baseCoveredRanges = { 'src/foo.ts': [[1, 5]] as [number, number][] }
    const newCoveredRanges = { 'src/foo.ts': [[1, 5]] as [number, number][] }
    const translationMaps = new Map([['src/foo.ts', []]])

    const result = computeLostCoverage(
      baseCoveredRanges,
      newCoveredRanges,
      translationMaps
    )
    expect(result.totalLost).toBe(0)
    expect(result.overallLossPercent).toBe(0)
  })

  test('limits first5Ranges to 5 entries across files', () => {
    const baseCoveredRanges = {
      'src/a.ts': [
        [1, 1],
        [3, 3],
        [5, 5]
      ] as [number, number][],
      'src/b.ts': [
        [10, 10],
        [20, 20],
        [30, 30]
      ] as [number, number][]
    }
    const newCoveredRanges = {
      'src/a.ts': [] as [number, number][],
      'src/b.ts': [] as [number, number][]
    }
    const translationMaps = new Map([
      ['src/a.ts', []],
      ['src/b.ts', []]
    ])

    const result = computeLostCoverage(
      baseCoveredRanges,
      newCoveredRanges,
      translationMaps
    )
    expect(result.first5Ranges).toHaveLength(5)
  })
})
