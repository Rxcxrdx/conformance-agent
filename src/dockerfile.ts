import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Violation } from "./types.js";

const REQUIRED_LABELS = [
  "org.opencontainers.image.version",
  "org.opencontainers.image.revision",
  "org.opencontainers.image.source",
  "com.conformance.owner",
  "com.conformance.policy-version",
];

export function checkDockerfile(servicePath: string): Violation[] {
  const dockerfilePath = join(servicePath, "Dockerfile");
  const violations: Violation[] = [];

  if (!existsSync(dockerfilePath)) {
    violations.push({
      rule: "OCI-003",
      severity: "critical",
      detail: "Dockerfile not found in service root",
    });
    return violations;
  }

  const content = readFileSync(dockerfilePath, "utf-8");

  // OCI-003: HEALTHCHECK must be present
  if (!/^\s*HEALTHCHECK\b/m.test(content)) {
    violations.push({
      rule: "OCI-003",
      severity: "critical",
      detail: "Dockerfile missing HEALTHCHECK instruction",
    });
  }

  // OCI-004: USER nonroot — must not run as root
  const userMatch = content.match(/^\s*USER\s+(\S+)/m);
  if (!userMatch) {
    violations.push({
      rule: "OCI-004",
      severity: "high",
      detail: "Dockerfile missing USER instruction — container runs as root",
    });
  } else {
    const user = userMatch[1].toLowerCase();
    if (user === "root" || user === "0") {
      violations.push({
        rule: "OCI-004",
        severity: "high",
        detail: `Dockerfile sets USER to "${userMatch[1]}" — must be a non-root user`,
      });
    }
  }

  // OCI-005: all required OCI labels must be present
  const missingLabels = REQUIRED_LABELS.filter(
    (label) => !content.includes(label),
  );
  if (missingLabels.length > 0) {
    violations.push({
      rule: "OCI-005",
      severity: "high",
      detail: `Missing required OCI labels: ${missingLabels.join(", ")}`,
    });
  }

  // OCI-008: base image must be pinned (no :latest, no missing tag)
  const fromLines = content.match(/^\s*FROM\s+(\S+)/gim) ?? [];
  for (const line of fromLines) {
    const img = line.replace(/^\s*FROM\s+/i, "").trim();
    if (img.endsWith(":latest")) {
      violations.push({
        rule: "OCI-008",
        severity: "high",
        detail: `FROM uses :latest tag (${img}) — pin a specific version for reproducibility`,
      });
    } else if (!img.includes(":") && !img.includes("@")) {
      violations.push({
        rule: "OCI-008",
        severity: "high",
        detail: `FROM has no tag (${img}) — pin a specific version for reproducibility`,
      });
    }
  }

  // OCI-009: multi-stage build required (at least 2 FROM statements)
  if (fromLines.length < 2) {
    violations.push({
      rule: "OCI-009",
      severity: "medium",
      detail: `Dockerfile has only ${fromLines.length} FROM stage(s) — use multi-stage build to keep runtime image small`,
    });
  }

  // OCI-010: apt/yum/apk cache must be cleaned in same RUN layer
  // Detect any `apt-get install` or `apk add` not followed by cleanup
  const installRuns =
    content.match(
      /RUN\s+[^\n]*(?:apt-get\s+install|apk\s+add|yum\s+install)[^\n]*(\\\n[^\n]*)*/gi,
    ) ?? [];
  for (const run of installRuns) {
    const hasCleanup =
      /rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(run) ||
      /apt-get\s+clean/.test(run) ||
      /--no-cache/.test(run) ||
      /yum\s+clean\s+all/.test(run);
    if (!hasCleanup) {
      violations.push({
        rule: "OCI-010",
        severity: "medium",
        detail: `RUN with package install missing cache cleanup (rm -rf /var/lib/apt/lists/* or --no-cache) — bloats image`,
      });
      break; // one is enough
    }
  }

  return violations;
}
