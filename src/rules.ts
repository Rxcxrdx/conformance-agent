import type { Severity } from "./types.js";

export interface RuleSpec {
  id: string;
  severity: Severity;
  name: string;
  category: "OCI" | "BOX";
}

// Single source of truth: every rule the gate evaluates.
// Used to report PASS/FAIL for every rule, not just violations.
export const RULES: RuleSpec[] = [
  // ── Dockerfile / OCI rules (deterministic checks) ─────────────────────────
  {
    id: "OCI-003",
    severity: "critical",
    category: "OCI",
    name: "HEALTHCHECK present",
  },
  { id: "OCI-004", severity: "high", category: "OCI", name: "Non-root USER" },
  {
    id: "OCI-005",
    severity: "high",
    category: "OCI",
    name: "Required OCI labels",
  },
  {
    id: "OCI-008",
    severity: "high",
    category: "OCI",
    name: "Base image pinned (no :latest)",
  },
  {
    id: "OCI-009",
    severity: "medium",
    category: "OCI",
    name: "Multi-stage build",
  },
  {
    id: "OCI-010",
    severity: "medium",
    category: "OCI",
    name: "Package cache cleaned",
  },

  // ── Source / BOX rules (evaluated by the AI agent) ────────────────────────
  {
    id: "BOX-001",
    severity: "high",
    category: "BOX",
    name: "Homogeneous response envelope",
  },
  {
    id: "BOX-002",
    severity: "high",
    category: "BOX",
    name: "No panics in production code",
  },
  {
    id: "BOX-003",
    severity: "low",
    category: "BOX",
    name: "Hexagonal structure (routes vs domain)",
  },
  {
    id: "BOX-004",
    severity: "high",
    category: "BOX",
    name: "/swagger-ui registered",
  },
  {
    id: "BOX-005",
    severity: "high",
    category: "BOX",
    name: "/openapi.json registered",
  },
  {
    id: "BOX-006",
    severity: "critical",
    category: "BOX",
    name: "/health registered",
  },
  {
    id: "BOX-007",
    severity: "medium",
    category: "BOX",
    name: "Structured logging (tracing)",
  },
  {
    id: "BOX-008",
    severity: "medium",
    category: "BOX",
    name: "Input validation on extractors",
  },
];

export const OCI_RULE_IDS = RULES.filter((r) => r.category === "OCI").map(
  (r) => r.id,
);
export const BOX_RULE_IDS = RULES.filter((r) => r.category === "BOX").map(
  (r) => r.id,
);
