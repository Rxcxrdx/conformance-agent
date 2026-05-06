export type Severity = "critical" | "high" | "medium" | "low";
export type Decision = "pass" | "manual_review" | "block";

export interface Violation {
  rule: string;
  severity: Severity;
  detail: string;
}

export interface ConformanceResult {
  service: string;
  decision: Decision;
  confidence: number;
  violations: Violation[];
  summary: string;
}
