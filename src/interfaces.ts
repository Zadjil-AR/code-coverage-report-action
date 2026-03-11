export type LineRange = [number, number];
export type CoveredRanges = Record<string, LineRange[]>;

export interface LostCoverageFile {
  fileName: string;
  previouslyCovered: number;
  lostLines: number;
  lossPercent: number;
  lostRanges: LineRange[];
}

export interface LostCoverageSummary {
  files: LostCoverageFile[];
  totalPreviouslyCovered: number;
  totalLost: number;
  overallLossPercent: number;
  first5Ranges: { file: string; range: LineRange }[];
}

export interface Coverage {
  files: Files;
  coverage: number;
  timestamp: number;
  basePath: string;
  coveredRanges?: CoveredRanges;
}

export interface CoverageFile {
  relative: string;
  absolute: string;
  coverage: number;
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
  enableLineLossReport: boolean;
}

export interface Files {
  [key: string]: CoverageFile;
}

export interface HandlebarContextCoverage {
  package: string;
  base_coverage: string;
  new_coverage?: string;
  difference?: string;
  previously_covered?: number;
  lost_lines?: number;
  loss_percent?: string;
}

export interface HandlebarContext {
  coverage_badge?: string;
  show_package_coverage?: boolean;
  minimum_allowed_coverage?: string;
  new_coverage?: string;
  coverage: HandlebarContextCoverage[];
  overall_coverage: HandlebarContextCoverage;
  inputs: Inputs;
  lostCoverage?: LostCoverageSummary;
}
