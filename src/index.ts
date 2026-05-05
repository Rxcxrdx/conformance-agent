import { resolve } from "path";
import { checkDockerfile } from "./dockerfile.js";
import { runAgentChecks } from "./agent.js";
import { decide } from "./decision.js";
import type { Violation } from "./types.js";

function parseArgs(): { servicePath: string } {
  // GitHub Actions injects inputs as INPUT_<NAME> env vars
  const fromAction = process.env["INPUT_SERVICE_PATH"];
  if (fromAction) {
    return { servicePath: resolve(fromAction) };
  }

  // Local CLI: tsx src/index.ts --service <path>
  const args = process.argv.slice(2);
  const idx = args.indexOf("--service");
  if (idx === -1 || !args[idx + 1]) {
    console.error("Usage: tsx src/index.ts --service <path-to-service>");
    console.error("       or set INPUT_SERVICE_PATH env var (GitHub Actions)");
    process.exit(2);
  }
  return { servicePath: resolve(args[idx + 1]!) };
}

async function main(): Promise<void> {
  const { servicePath } = parseArgs();
  const serviceName = servicePath.split("/").pop() ?? servicePath;

  console.error(`\n[conformance-gate] Evaluating: ${serviceName}`);
  console.error(`[conformance-gate] Path: ${servicePath}\n`);

  // Step A — deterministic Dockerfile checks (no LLM, instant)
  console.error("[Step A] Checking Dockerfile (OCI-003/004/005)...");
  const dockerViolations = checkDockerfile(servicePath);
  if (dockerViolations.length > 0) {
    dockerViolations.forEach((v) =>
      console.error(`  ❌ ${v.rule} [${v.severity}]: ${v.detail}`),
    );
  } else {
    console.error("  ✅ Dockerfile checks passed");
  }

  // Step B — OpenCode agent explores the repo and checks BOX-001/002/003
  // The agent uses file.read + find.files tools autonomously — no manual source reading
  console.error(
    "\n[Step B] OpenCode agent analyzing source (BOX-001/002/003)...",
  );
  console.error("  → Agent is exploring the repository with file tools...");

  let agentViolations: Violation[] = [];
  agentViolations = await runAgentChecks(servicePath);

  if (agentViolations.length > 0) {
    agentViolations.forEach((v) =>
      console.error(`  ❌ ${v.rule} [${v.severity}]: ${v.detail}`),
    );
  } else {
    console.error("  ✅ Agent found no BOX violations");
  }

  // Decision
  const allViolations = [...dockerViolations, ...agentViolations];
  const result = decide(serviceName, allViolations);

  const icon =
    result.decision === "pass"
      ? "✅"
      : result.decision === "manual_review"
        ? "⚠️"
        : "❌";

  console.error(
    `\n${icon} DECISION: ${result.decision.toUpperCase()} (confidence: ${result.confidence})`,
  );
  console.error(`   ${result.summary}\n`);

  // Structured JSON to stdout — CI can parse this for audit logs
  console.log(JSON.stringify(result, null, 2));

  // exit 1 on block → GitHub Actions job fails → merge is blocked
  if (result.decision === "block") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[conformance-gate] Fatal error:", err);
  process.exit(2);
});
