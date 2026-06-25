import { resolve, join } from "path";
import { readdirSync, statSync } from "fs";
import { checkDockerfile } from "./dockerfile.js";
import { createAgentClient, runAgentChecks } from "./agent.js";
import { runStaticSourceChecks, enrichViolations } from "./static-source.js";
import { readProductionSources } from "./source.js";
import { loadPolicy, DEFAULT_POLICY_PATH } from "./policy.js";
import { decide } from "./decision.js";
import { renderComplianceReport } from "./report.js";
import type { Policy, Violation } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

function getArg(flag: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : null;
}

function getPolicyPath(): string {
  return (
    process.env["INPUT_POLICY_PATH"] || getArg("--policy") || DEFAULT_POLICY_PATH
  );
}

function getServicePaths(): string[] {
  const fromEnv = process.env["INPUT_SERVICE_PATH"];
  if (fromEnv) return [resolve(fromEnv)];

  const single = getArg("--service");
  if (single) return [resolve(single)];

  const servicesDir = process.env["INPUT_SERVICES_DIR"] || getArg("--services-dir");
  if (servicesDir) {
    const resolved = resolve(servicesDir);
    return readdirSync(resolved)
      .map((name) => join(resolved, name))
      .filter((p) => statSync(p).isDirectory());
  }

  console.error("Usage: tsx src/index.ts --service <path> [--policy <path>]");
  console.error("       tsx src/index.ts --services-dir <path> [--policy <path>]");
  console.error("       or set INPUT_SERVICE_PATH / INPUT_SERVICES_DIR / INPUT_POLICY_PATH");
  process.exit(2);
}

async function evaluateService(
  client: OpencodeClient,
  servicePath: string,
  policy: Policy,
): Promise<{
  serviceName: string;
  decision: string;
  confidence: number;
  violations: Violation[];
}> {
  const serviceName = servicePath.split("/").pop() ?? servicePath;

  console.error(`\n${"─".repeat(60)}`);
  console.error(`[conformance-gate] Evaluating: ${serviceName}`);
  console.error(`[conformance-gate] Path: ${servicePath}`);
  console.error(`${"─".repeat(60)}`);

  // Read production source once; shared by the static and AI engines.
  const sources = readProductionSources(servicePath);

  console.error("[Step A] Deterministic checks (Dockerfile OCI + source BOX)...");
  const dockerRaw = checkDockerfile(servicePath, policy.rules);
  const staticRaw = runStaticSourceChecks(policy.rules, sources);
  console.error(
    `         ${dockerRaw.length + staticRaw.length === 0 ? "✅ all deterministic checks passed" : `❌ ${dockerRaw.length + staticRaw.length} violation(s)`}`,
  );

  console.error("[Step B] AI agent analyzing source (judgement rules)...");
  const aiRules = policy.rules.filter((r) => r.engine === "ai");
  const agentRaw = await runAgentChecks(client, sources, aiRules);
  console.error(
    `         ${agentRaw.length === 0 ? "✅ no AI violations found" : `❌ ${agentRaw.length} AI violation(s)`}`,
  );

  // Severity is attached here, from the policy — the single source of truth.
  const allViolations = enrichViolations([...dockerRaw, ...staticRaw, ...agentRaw], policy);

  renderComplianceReport(serviceName, allViolations, policy.rules);

  const result = decide(serviceName, allViolations);

  const icon =
    result.decision === "pass" ? "✅" : result.decision === "manual_review" ? "⚠️" : "❌";
  console.error(
    `${icon} ${serviceName}: ${result.decision.toUpperCase()} (confidence: ${result.confidence})`,
  );

  return {
    serviceName,
    decision: result.decision,
    confidence: result.confidence,
    violations: allViolations,
  };
}

async function main(): Promise<void> {
  const policyPath = getPolicyPath();
  const servicePaths = getServicePaths();

  const policy = loadPolicy(policyPath);
  console.error(
    `[conformance-gate] Policy v${policy.policy_version} loaded (${policy.rules.length} rules) from ${policyPath}`,
  );
  console.error(`[conformance-gate] Services to evaluate: ${servicePaths.length}`);

  const { client, closeServer } = await createAgentClient();

  const results = [];
  let hasBlock = false;

  try {
    for (const servicePath of servicePaths) {
      const result = await evaluateService(client, servicePath, policy);
      results.push(result);
      if (result.decision === "block") hasBlock = true;
    }
  } finally {
    console.error("[conformance-gate] Shutting down OpenCode server...");
    closeServer();
  }

  const overallDecision = hasBlock
    ? "block"
    : results.some((r) => r.decision === "manual_review")
      ? "manual_review"
      : "pass";

  const overallConfidence = Math.min(...results.map((r) => r.confidence));
  const allViolations = results.flatMap((r) => r.violations);

  console.error(`\n${"═".repeat(60)}`);
  console.error(`[conformance-gate] OVERALL: ${overallDecision.toUpperCase()}`);
  results.forEach((r) => {
    const icon =
      r.decision === "pass" ? "✅" : r.decision === "manual_review" ? "⚠️" : "❌";
    const failedSummary =
      r.violations.length === 0
        ? "all rules passed"
        : `${r.violations.length} violation(s): ${r.violations.map((v) => v.rule).join(", ")}`;
    console.error(`  ${icon} ${r.serviceName}: ${r.decision} — ${failedSummary}`);
  });
  console.error(`${"═".repeat(60)}\n`);

  console.log(
    JSON.stringify(
      {
        decision: overallDecision,
        confidence: overallConfidence,
        violations: allViolations,
        services: results,
      },
      null,
      2,
    ),
  );

  process.exit(hasBlock ? 1 : 0);
}

main().catch((err) => {
  console.error("[conformance-gate] Fatal error:", err);
  process.exit(2);
});
