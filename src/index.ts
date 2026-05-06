import { resolve, join } from "path";
import { readdirSync, statSync } from "fs";
import { checkDockerfile } from "./dockerfile.js";
import { createAgentClient, runAgentChecks } from "./agent.js";
import { decide } from "./decision.js";
import type { Violation } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

function getServicePaths(): string[] {
  // Option A: single service via INPUT_SERVICE_PATH or --service
  const fromEnv = process.env["INPUT_SERVICE_PATH"];
  if (fromEnv) return [resolve(fromEnv)];

  const args = process.argv.slice(2);
  const svcIdx = args.indexOf("--service");
  if (svcIdx !== -1 && args[svcIdx + 1]) {
    return [resolve(args[svcIdx + 1]!)];
  }

  // Option B: all subdirectories in INPUT_SERVICES_DIR or --services-dir
  const dirFromEnv = process.env["INPUT_SERVICES_DIR"];
  const dirIdx = args.indexOf("--services-dir");
  const servicesDir = dirFromEnv ?? (dirIdx !== -1 ? args[dirIdx + 1] : null);

  if (servicesDir) {
    const resolved = resolve(servicesDir);
    return readdirSync(resolved)
      .map((name) => join(resolved, name))
      .filter((p) => statSync(p).isDirectory());
  }

  console.error("Usage: tsx src/index.ts --service <path>");
  console.error("       tsx src/index.ts --services-dir <path>");
  console.error(
    "       or set INPUT_SERVICE_PATH / INPUT_SERVICES_DIR env vars",
  );
  process.exit(2);
}

async function evaluateService(client: OpencodeClient, servicePath: string): Promise<{
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

  console.error("[Step A] Checking Dockerfile (OCI-003/004/005)...");
  const dockerViolations = checkDockerfile(servicePath);
  if (dockerViolations.length > 0) {
    dockerViolations.forEach((v) =>
      console.error(`  ❌ ${v.rule} [${v.severity}]: ${v.detail}`),
    );
  } else {
    console.error("  ✅ Dockerfile checks passed");
  }

  console.error("[Step B] OpenCode agent analyzing source (BOX-001/002/003)...");
  const agentViolations = await runAgentChecks(client, servicePath);
  if (agentViolations.length > 0) {
    agentViolations.forEach((v) =>
      console.error(`  ❌ ${v.rule} [${v.severity}]: ${v.detail}`),
    );
  } else {
    console.error("  ✅ Agent found no BOX violations");
  }

  const allViolations = [...dockerViolations, ...agentViolations];
  const result = decide(serviceName, allViolations);

  const icon =
    result.decision === "pass"
      ? "✅"
      : result.decision === "manual_review"
        ? "⚠️"
        : "❌";
  console.error(
    `\n${icon} ${serviceName}: ${result.decision.toUpperCase()} (confidence: ${result.confidence})`,
  );

  return {
    serviceName,
    decision: result.decision,
    confidence: result.confidence,
    violations: allViolations,
  };
}

async function main(): Promise<void> {
  const servicePaths = getServicePaths();

  console.error(
    `\n[conformance-gate] Services to evaluate: ${servicePaths.length}`,
  );

  // Start ONE server for all services — reuse across evaluations
  const client = await createAgentClient();

  const results = [];
  let hasBlock = false;

  for (const servicePath of servicePaths) {
    const result = await evaluateService(client, servicePath);
    results.push(result);
    if (result.decision === "block") hasBlock = true;
  }

  // Overall decision: block if any service blocks
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
      r.decision === "pass"
        ? "✅"
        : r.decision === "manual_review"
          ? "⚠️"
          : "❌";
    console.error(`  ${icon} ${r.serviceName}: ${r.decision}`);
  });
  console.error(`${"═".repeat(60)}\n`);

  // Structured JSON to stdout — CI can parse this for audit logs
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

  if (hasBlock) process.exit(1);
}

main().catch((err) => {
  console.error("[conformance-gate] Fatal error:", err);
  process.exit(2);
});
