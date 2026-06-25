import type { Rule, Violation } from "./types.js";

const SEV_ICON: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "🟦",
};

// Group rules by id prefix (OCI-* vs BOX-*) for the report sections.
function group(rule: Rule): string {
  return rule.id.split("-")[0] ?? "OTHER";
}

function violationsByRule(violations: Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = map.get(v.rule) ?? [];
    arr.push(v);
    map.set(v.rule, arr);
  }
  return map;
}

function renderRow(rule: Rule, violations: Violation[] | undefined): string[] {
  const sev = SEV_ICON[rule.severity] ?? "⬜";
  if (!violations || violations.length === 0) {
    return [`  ✅ ${rule.id} ${sev} ${rule.name}`];
  }
  const lines = [`  ❌ ${rule.id} ${sev} ${rule.name}`];
  for (const v of violations) lines.push(`        └─ ${v.detail}`);
  return lines;
}

/** Per-service table: every rule in the policy with PASS/FAIL + detail. */
export function renderComplianceReport(
  serviceName: string,
  violations: Violation[],
  rules: Rule[],
): void {
  const byRule = violationsByRule(violations);

  const passed = rules.filter((r) => !byRule.has(r.id)).length;
  const failed = rules.length - passed;
  const pct = rules.length === 0 ? 100 : Math.round((passed / rules.length) * 100);

  // Stable section order: OCI first, then BOX, then anything else.
  const groups = [...new Set(rules.map(group))].sort((a, b) => {
    const order = (g: string) => (g === "OCI" ? 0 : g === "BOX" ? 1 : 2);
    return order(a) - order(b) || a.localeCompare(b);
  });

  console.error("");
  console.error(`📋 Compliance report · ${serviceName}`);
  console.error(
    `   Score: ${passed}/${rules.length} rules passed (${pct}%)  ·  ${failed} violation(s)`,
  );

  for (const g of groups) {
    console.error("");
    console.error(`   ── ${g} ───────────────────────────────────────`);
    for (const r of rules.filter((rule) => group(rule) === g)) {
      for (const line of renderRow(r, byRule.get(r.id))) console.error(line);
    }
  }
  console.error("");

  if (failed > 0) {
    console.error("   Severity legend: 🟥 critical · 🟧 high · 🟨 medium · 🟦 low");
    console.error("");
  }
}
