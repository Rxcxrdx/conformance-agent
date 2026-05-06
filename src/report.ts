import { RULES, type RuleSpec } from "./rules.js";
import type { Violation } from "./types.js";

const SEV_ICON: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "🟦",
};

function violationsByRule(violations: Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = map.get(v.rule) ?? [];
    arr.push(v);
    map.set(v.rule, arr);
  }
  return map;
}

function renderRow(
  rule: RuleSpec,
  violations: Violation[] | undefined,
): string[] {
  const sev = SEV_ICON[rule.severity] ?? "⬜";
  if (!violations || violations.length === 0) {
    return [`  ✅ ${rule.id} ${sev} ${rule.name}`];
  }
  const lines = [`  ❌ ${rule.id} ${sev} ${rule.name}`];
  for (const v of violations) {
    lines.push(`        └─ ${v.detail}`);
  }
  return lines;
}

export function renderComplianceReport(
  serviceName: string,
  violations: Violation[],
): void {
  const byRule = violationsByRule(violations);

  const ociRules = RULES.filter((r) => r.category === "OCI");
  const boxRules = RULES.filter((r) => r.category === "BOX");

  const passed = RULES.filter((r) => !byRule.has(r.id)).length;
  const failed = RULES.length - passed;
  const pct = Math.round((passed / RULES.length) * 100);

  console.error("");
  console.error(`📋 Compliance report · ${serviceName}`);
  console.error(
    `   Score: ${passed}/${RULES.length} rules passed (${pct}%)  ·  ${failed} violation(s)`,
  );
  console.error("");
  console.error("   ── OCI / Dockerfile ──────────────────────────────");
  for (const r of ociRules) {
    for (const line of renderRow(r, byRule.get(r.id))) console.error(line);
  }
  console.error("");
  console.error("   ── BOX / Source code (AI-evaluated) ──────────────");
  for (const r of boxRules) {
    for (const line of renderRow(r, byRule.get(r.id))) console.error(line);
  }
  console.error("");

  if (failed > 0) {
    console.error(
      "   Severity legend: 🟥 critical · 🟧 high · 🟨 medium · 🟦 low",
    );
    console.error("");
  }
}
