import type { Violation, Decision, ConformanceResult } from './types.js'

export function decide(
  service: string,
  violations: Violation[]
): ConformanceResult {
  const hasCritical = violations.some((v) => v.severity === 'critical')
  const highCount = violations.filter((v) => v.severity === 'high').length
  const hasAny = violations.length > 0
  const onlyLow =
    hasAny && violations.every((v) => v.severity === 'low')

  let decision: Decision
  let confidence: number
  let summary: string

  if (!hasAny) {
    decision = 'pass'
    confidence = 1.0
    summary = 'All conformance checks passed'
  } else if (hasCritical) {
    decision = 'block'
    confidence = 1.0
    const criticals = violations
      .filter((v) => v.severity === 'critical')
      .map((v) => v.rule)
      .join(', ')
    summary = `Service blocked: critical violations found (${criticals})`
  } else if (onlyLow) {
    decision = 'pass'
    confidence = 0.97
    summary = `Passed with ${violations.length} low-severity warning(s)`
  } else if (highCount >= 2) {
    decision = 'block'
    confidence = 1.0
    summary = `Service blocked: ${highCount} high-severity violations found`
  } else {
    // exactly 1 high violation, no critical
    decision = 'manual_review'
    confidence = 0.85
    summary = `Manual review required: 1 high-severity violation found`
  }

  return { service, decision, confidence, violations, summary }
}
