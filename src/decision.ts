import type { Violation, Decision, ConformanceResult } from "./types.js";

export function decide(
  service: string,
  violations: Violation[],
): ConformanceResult {
  const hasCritical = violations.some((v) => v.severity === "critical");
  const highCount = violations.filter((v) => v.severity === "high").length;
  const mediumCount = violations.filter((v) => v.severity === "medium").length;
  const hasAny = violations.length > 0;
  const onlyLowOrMedium =
    hasAny &&
    violations.every((v) => v.severity === "low" || v.severity === "medium");

  let decision: Decision;
  let confidence: number;
  let summary: string;

  if (!hasAny) {
    decision = "pass";
    confidence = 1.0;
    summary = "All conformance checks passed";
  } else if (hasCritical) {
    decision = "block";
    confidence = 1.0;
    const criticals = violations
      .filter((v) => v.severity === "critical")
      .map((v) => v.rule)
      .join(", ");
    summary = `Service blocked: critical violations found (${criticals})`;
  } else if (highCount >= 2) {
    decision = "block";
    confidence = 1.0;
    summary = `Service blocked: ${highCount} high-severity violations found`;
  } else if (highCount === 1 || mediumCount >= 3) {
    decision = "manual_review";
    confidence = 0.85;
    summary =
      highCount === 1
        ? `Manual review required: 1 high-severity violation found`
        : `Manual review required: ${mediumCount} medium-severity warnings`;
  } else if (onlyLowOrMedium) {
    decision = "pass";
    confidence = 0.95;
    summary = `Passed with ${violations.length} non-blocking warning(s)`;
  } else {
    decision = "manual_review";
    confidence = 0.85;
    summary = `Manual review required`;
  }

  return { service, decision, confidence, violations, summary };
}
