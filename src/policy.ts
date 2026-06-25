import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import type { Policy, Rule, Severity } from "./types.js";

const VALID_SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

// Default location of the policy inside the consumer repo's workspace.
export const DEFAULT_POLICY_PATH = "policy/conformity-policy.yaml";

/**
 * Loads and validates the policy that drives every engine.
 * This file is the SINGLE SOURCE OF TRUTH: rule list, severities, the AI prompt
 * and the deterministic matchers all derive from it. To change a rule, edit
 * only this YAML — no code changes needed for regex/source rules.
 */
export function loadPolicy(policyPath: string): Policy {
  const abs = resolve(policyPath);

  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch {
    throw new Error(
      `[conformance-gate] Could not read policy file at: ${abs}\n` +
        `Set 'policy-path' in the action or place it at '${DEFAULT_POLICY_PATH}'.`,
    );
  }

  const parsed = parse(raw) as Partial<Policy> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[conformance-gate] Policy at ${abs} is empty or not an object`);
  }
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error(`[conformance-gate] Policy at ${abs} has no 'rules' array`);
  }

  const rules = parsed.rules.map((r, i) => validateRule(r, i, abs));

  // Guard against duplicate ids — they would make severity lookup ambiguous.
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) {
      throw new Error(`[conformance-gate] Duplicate rule id in policy: ${r.id}`);
    }
    seen.add(r.id);
  }

  return {
    policy_version: String(parsed.policy_version ?? "unknown"),
    rules,
  };
}

function validateRule(r: unknown, index: number, file: string): Rule {
  const rule = r as Partial<Rule>;
  const where = `rule #${index + 1}${rule?.id ? ` (${rule.id})` : ""} in ${file}`;

  if (!rule.id) throw new Error(`[conformance-gate] Missing 'id' for ${where}`);
  if (!rule.severity || !VALID_SEVERITIES.includes(rule.severity)) {
    throw new Error(
      `[conformance-gate] ${where}: 'severity' must be one of ${VALID_SEVERITIES.join(", ")}`,
    );
  }
  if (rule.engine !== "ai" && rule.engine !== "static") {
    throw new Error(`[conformance-gate] ${where}: 'engine' must be 'ai' or 'static'`);
  }

  if (rule.engine === "static" && rule.target === "source") {
    const m = rule.match;
    if (!m || !m.pattern || !m.flag_when || !m.message) {
      throw new Error(
        `[conformance-gate] ${where}: static+source rules need 'match' with { pattern, flag_when, message }`,
      );
    }
    if (m.flag_when !== "present" && m.flag_when !== "absent") {
      throw new Error(`[conformance-gate] ${where}: match.flag_when must be 'present' or 'absent'`);
    }
    // Fail fast on a malformed regex instead of at scan time.
    try {
      new RegExp(m.pattern);
    } catch (e) {
      throw new Error(`[conformance-gate] ${where}: invalid match.pattern — ${(e as Error).message}`);
    }
  }

  return {
    id: rule.id,
    name: rule.name ?? rule.id,
    category: rule.category ?? "uncategorized",
    severity: rule.severity,
    engine: rule.engine,
    target: rule.target,
    description: rule.description,
    exceptions: rule.exceptions,
    required_labels: rule.required_labels,
    match: rule.match,
  };
}
