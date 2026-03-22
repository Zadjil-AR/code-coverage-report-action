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
  lines_covered?: number;
  lines_valid?: number;
  covered_lines?: number[];
}

export interface LineRange {
  start: number;
  end: number;
}

export interface FileLostLines {
  file: string;
  /** Lost line ranges in base (original) file — for artifact storage */
  lostRanges: LineRange[];
  /** Lost line ranges in head (current) file — for display */
  newLostRanges: LineRange[];
  baseCoveredCount: number;
  lostCount: number;
  lostPercentage: number;
}

/** A single range entry used in the template preview (first 5 ranges). */
export interface LostRangePreview {
  file: string;
  start: number;
  end: number;
}

export interface LostLinesReport {
  files: FileLostLines[];
  overallBaseCoveredCount: number;
  overallLostCount: number;
  overallLostPercentage: number;
  /** First 5 lost-line ranges across all files (head line numbers), for template rendering. */
  previewRanges: LostRangePreview[];
  /**
   * Surviving base covered line count for every file (keyed by head path).
   * Includes files with 0 lost lines so directory aggregations use the full denominator.
   */
  baseCoveredCountByFile: Record<string, number>;
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
  showCoverageByTopDir: boolean;
  coverageDepth: number | undefined;
  showCoverageByParentDir: boolean;
  excludePaths: string[];
  trackLostLines: boolean;
  lostLinesMergeBaseSearchSteps: number;
  lostLinesMergeBaseMaxDepth: number;
}

export interface Files {
  [key: string]: CoverageFile;
}

export interface HandlebarContextCoverage {
  package: string;
  base_coverage: string;
  new_coverage?: string;
  difference?: string;
  /** Plain percentage for summary line only (no emoji), e.g. "0%" or "-1.51%" */
  difference_plain?: string;
  lost_coverage?: string;
}

export interface HandlebarContext {
  coverage_badge?: string;
  show_package_coverage?: boolean;
  minimum_allowed_coverage?: string;
  new_coverage?: string;
  negative_difference_threshold?: string | null;
  coverage: HandlebarContextCoverage[];
  overall_coverage: HandlebarContextCoverage;
  coverage_by_top_dir?: HandlebarContextCoverage[];
  inputs: Inputs;
  lost_lines_report?: LostLinesReport;
}
