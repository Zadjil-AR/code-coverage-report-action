export interface Coverage {
  files: Files;
  coverage: number;
  timestamp: number;
  basePath: string;
}

export interface CoverageFile {
  relative: string;
  absolute: string;
  coverage: number;
  lines?: { [lineNum: number]: boolean };
}

export interface CoverageLineEntry {
  lineNum: number;
  hash: string;
  covered: boolean;
}

export interface CoverageLineData {
  [relativeFilePath: string]: CoverageLineEntry[];
}

export interface RegressedBlock {
  file: string;
  lostLines: number;
}

export interface RegressionResult {
  previouslyCoveredLines: number;
  lostLines: number;
  percentage: number;
  blocks: RegressedBlock[];
}

export interface Inputs {
  token: string;
  filename: string;
  badge: boolean;
  overallCoverageFailThreshold: number;
  fileCoverageErrorMin: number;
  fileCoverageWarningMax: number;
  failOnNegativeDifference: boolean;
  markdownFilename: string;
  artifactDownloadWorkflowNames: string[] | null;
  artifactName: string;
  negativeDifferenceBy: string;
  retention: number | undefined;
  withBaseCoverageTemplate: string;
  withoutBaseCoverageTemplate: string;
  negativeDifferenceThreshold: number;
  onlyListChangedFiles: boolean;
  skipPackageCoverage: boolean;
}

export interface Files {
  [key: string]: CoverageFile;
}

export interface HandlebarContextCoverage {
  package: string;
  base_coverage: string;
  new_coverage?: string;
  difference?: string;
}

export interface HandlebarContext {
  coverage_badge?: string;
  show_package_coverage?: boolean;
  minimum_allowed_coverage?: string;
  new_coverage?: string;
  coverage: HandlebarContextCoverage[];
  overall_coverage: HandlebarContextCoverage;
  inputs: Inputs;
  regression?: RegressionResult;
}
