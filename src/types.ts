export type Severity = "critical" | "high" | "medium" | "low";
export type Decision = "pass" | "manual_review" | "block";

// How a rule is evaluated.
export type Engine = "ai" | "static";
// What artifact a static rule inspects.
export type Target = "source" | "dockerfile";
// Whether finding the pattern is the violation, or the absence of it is.
export type FlagWhen = "present" | "absent";

export interface RuleException {
  path: string;
  reason: string;
}

// Declarative matcher for static source rules (engine: static, target: source).
export interface MatchSpec {
  flag_when: FlagWhen;
  pattern: string;
  message: string;
  // present-rules only: report every hit with file:line instead of once.
  per_occurrence?: boolean;
}

// One rule, exactly as declared in policy.yaml — the single source of truth.
export interface Rule {
  id: string;
  name: string;
  category: string;
  severity: Severity;
  engine: Engine;
  target?: Target;
  // AI rules: the description fed (verbatim) into the generated prompt.
  description?: string;
  exceptions?: RuleException[];
  // OCI-005: labels the Dockerfile must declare.
  required_labels?: string[];
  // static + source rules: the deterministic matcher.
  match?: MatchSpec;
}

export interface Policy {
  policy_version: string;
  rules: Rule[];
}

// A finding before severity is attached. Engines never decide severity —
// they only say which rule was violated and why.
export interface RawViolation {
  rule: string;
  detail: string;
}

// A finding after severity is resolved from the policy (single source of truth).
export interface Violation extends RawViolation {
  severity: Severity;
}

export interface ConformanceResult {
  service: string;
  decision: Decision;
  confidence: number;
  violations: Violation[];
  summary: string;
}
