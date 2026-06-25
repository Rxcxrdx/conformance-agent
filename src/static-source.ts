import type { Policy, RawViolation, Rule, Violation } from "./types.js";
import type { SourceFile } from "./source.js";

/**
 * Deterministic source-code engine. Runs every `engine: static, target: source`
 * rule from the policy as a regex over the production source.
 *
 *   flag_when: present  → each match is a violation (BOX-002: no panics).
 *   flag_when: absent   → not finding the pattern anywhere is the violation
 *                         (BOX-004/005/006: required routes are registered).
 *
 * 100% reproducible — no model involved, so these rules can never hallucinate
 * a pass or a block, and prompt injection cannot neutralise them.
 */
export function runStaticSourceChecks(rules: Rule[], files: SourceFile[]): RawViolation[] {
  const violations: RawViolation[] = [];

  for (const rule of rules) {
    if (rule.engine !== "static" || rule.target !== "source" || !rule.match) continue;
    const { pattern, flag_when, message, per_occurrence } = rule.match;

    if (flag_when === "present") {
      let reportedForRule = false;
      for (const file of files) {
        file.lines.forEach((line, idx) => {
          if (new RegExp(pattern).test(line)) {
            if (per_occurrence) {
              violations.push({ rule: rule.id, detail: `${message} — ${file.relPath}:${idx + 1}` });
            } else if (!reportedForRule) {
              violations.push({ rule: rule.id, detail: `${message} — ${file.relPath}:${idx + 1}` });
              reportedForRule = true;
            }
          }
        });
      }
    } else {
      const found = files.some((f) => new RegExp(pattern).test(f.content));
      if (!found) {
        violations.push({ rule: rule.id, detail: message });
      }
    }
  }

  return violations;
}

/**
 * Attaches severity to raw findings from the policy — the SINGLE place severity
 * is decided. Engines (including the LLM) never set it, so the model cannot
 * downgrade a rule, and findings for rule ids absent from the policy are
 * dropped (defends against a hallucinated rule id).
 */
export function enrichViolations(raw: RawViolation[], policy: Policy): Violation[] {
  const byId = new Map(policy.rules.map((r) => [r.id, r]));
  const out: Violation[] = [];

  for (const v of raw) {
    const rule = byId.get(v.rule);
    if (!rule) {
      console.error(`[conformance-gate] Ignoring finding for unknown rule id: ${v.rule}`);
      continue;
    }
    out.push({ ...v, severity: rule.severity });
  }

  return out;
}
