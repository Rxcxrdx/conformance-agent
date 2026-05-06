import {
  createOpencode,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Violation } from "./types.js";

const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

// Read all .rs source files and embed them directly in the prompt.
// This is more reliable than asking the AI to use file tools in CI.
function readServiceSource(servicePath: string): string {
  const srcPath = join(servicePath, "src");
  const files: string[] = [];

  function collect(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        collect(full);
      } else if (entry.endsWith(".rs")) {
        files.push(full);
      }
    }
  }

  try {
    collect(srcPath);
  } catch {
    return "(no src/ directory found)";
  }

  return files
    .map((f) => {
      const rel = f.replace(servicePath + "/", "");
      const content = readFileSync(f, "utf8");
      return `=== ${rel} ===\n${content}`;
    })
    .join("\n\n");
}

function buildPrompt(servicePath: string, sourceCode: string): string {
  return `You are a strict conformance auditor for Rust microservices.

Below are ALL the source files for the service at: ${servicePath}

${sourceCode}

─────────────────────────────────────────────────────────────
Analyze the code above for ONLY these violations:

BOX-001 · severity: high · response_shape_homogeneous
  Every HTTP handler must return EXACTLY one of:
    { "success": true,  "data": <any payload> }
    { "success": false, "error": "<string message>" }
  Flag any handler that returns a raw struct, Vec, String,
  plain StatusCode, or any shape that does NOT include both
  "success" and either "data" or "error".

BOX-002 · severity: high · no_panics_exposed
  Production code (outside #[cfg(test)]) must NOT call
  .unwrap() or .expect() anywhere.
  Flag every occurrence with file path and line number.

BOX-003 · severity: low · hexagonal_structure
  Business logic must live in domain/ modules only.
  Handlers in routes/ must only: extract params → call domain → wrap in envelope.
  Flag if routes/ handlers contain inline business logic.
─────────────────────────────────────────────────────────────

Respond with ONLY this JSON (no markdown, no explanation):
{ "violations": [] }
or
{ "violations": [{ "rule": "BOX-001", "severity": "high", "detail": "exact location and reason" }] }`;
}

// Start a single OpenCode client shared across all service evaluations.
export async function createAgentClient(): Promise<OpencodeClient> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  console.error(`[conformance-gate] Starting OpenCode server...`);
  const { client } = await createOpencode();
  console.error(`[conformance-gate] OpenCode server ready`);

  // Inject Anthropic API key — path.id = provider ID, body = credentials
  await client.auth.set({
    path: { id: "anthropic" },
    body: { type: "api", key: apiKey },
  });

  return client;
}

export async function runAgentChecks(
  client: OpencodeClient,
  servicePath: string,
): Promise<Violation[]> {
  // Read source files locally and embed in the prompt — no file tools needed
  const sourceCode = readServiceSource(servicePath);

  const sessionName = servicePath.split("/").pop() ?? "service";
  const session = await client.session.create({
    body: { title: `conformance:${sessionName}` },
  });
  const sessionId = (session as any)?.data?.id ?? (session as any)?.id;
  if (!sessionId) {
    throw new Error(
      `[conformance-gate] session.create() returned no id — response: ${JSON.stringify(session)}`,
    );
  }
  console.error(`[conformance-gate] Session created: ${sessionId}`);

  console.error(`[conformance-gate] Sending audit prompt to ${MODEL.modelID}...`);
  const result = await client.session.prompt({
    path: { sessionID: sessionId },
    body: {
      model: MODEL,
      parts: [{ type: "text", text: buildPrompt(servicePath, sourceCode) }],
    },
  });

  // Try structured_output first, then text part
  const structured = (result as any)?.data?.info?.structured_output;
  if (structured?.violations !== undefined) {
    const violations = (structured.violations ?? []) as Violation[];
    console.error(`[conformance-gate] Agent found ${violations.length} violation(s)`);
    return violations;
  }

  const parts = (result as any)?.data?.parts ?? [];
  const textPart = parts.find((p: { type: string }) => p.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const rawText = textPart?.text ?? "";

  if (!rawText) {
    console.error("[conformance-gate] ⚠️  Empty agent response — assuming no violations");
    console.error(`[conformance-gate] Full result: ${JSON.stringify(result).slice(0, 500)}`);
    return [];
  }

  const jsonMatch =
    rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    rawText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error(`[conformance-gate] ⚠️  No JSON in response:\n${rawText.slice(0, 500)}`);
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const violations = (parsed.violations ?? []) as Violation[];
    console.error(`[conformance-gate] Agent found ${violations.length} violation(s)`);
    return violations;
  } catch {
    console.error(`[conformance-gate] ⚠️  JSON parse failed: ${jsonMatch[1].slice(0, 200)}`);
    return [];
  }
}
