module.exports = {
	clearMocks: true,
	resetModules: true,
	moduleFileExtensions: ['js', 'ts'],
	testMatch: ['**/*.test.ts'],
	transform: {
	  '^.+\\.ts$': 'ts-jest'
	},
	snapshotSerializers: ['<rootDir>/__tests__/number-array-serializer.js'],
	verbose: true,
	collectCoverage: true,
	collectCoverageFrom: ['src/**/*.{js,ts}'],
	coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/main.ts'],
	coverageReporters: ['clover', 'cobertura', ['text', {skipFull: true}]]
  }