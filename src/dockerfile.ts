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

  return violations;
}
