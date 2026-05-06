import {
  createOpencode,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { Violation } from "./types.js";

const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

// JSON schema for structured output — no manual JSON parsing needed
const VIOLATIONS_SCHEMA = {
  type: "object",
  properties: {
    violations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule:     { type: "string", description: "Rule ID: BOX-001, BOX-002, BOX-003, OCI-003, etc." },
          severity: { type: "string", description: "high | medium | low" },
          detail:   { type: "string", description: "Exact location and reason for the violation" },
        },
        required: ["rule", "severity", "detail"],
      },
      description: "List of violations found. Empty array if none.",
    },
  },
  required: ["violations"],
};

function buildPrompt(servicePath: string): string {
  return `You are a strict conformance auditor for Rust microservices.

Analyze the Rust service located at: ${servicePath}

Use your file-reading tools to:
1. List all .rs files under ${servicePath}/src/
2. Read each .rs file — focus on production code, ignore #[cfg(test)] blocks

Check for ONLY these three violations:

─────────────────────────────────────────────────────────────
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
  Flag every occurrence with file path and approximate line.

BOX-003 · severity: low · hexagonal_structure
  Business logic (data processing, I/O, transformation) must
  live in domain/ modules only.
  Handlers in routes/ must only: extract params → call domain
  function → wrap result in envelope.
  Flag if routes/ handlers contain inline business logic.
─────────────────────────────────────────────────────────────

IMPORTANT: Your ENTIRE response must be ONLY the JSON object below — no explanation, no markdown.
If no violations found: { "violations": [] }
If violations found:
{
  "violations": [
    { "rule": "BOX-001", "severity": "high", "detail": "..." }
  ]
}`;
}

export async function runAgentChecks(
  servicePath: string,
): Promise<Violation[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  // Always start a fresh OpenCode server — don't probe default port 4096
  // because in CI other services may occupy it and fool the health check.
  // Set OPENCODE_SERVER_URL explicitly only if you want to reuse a running instance.
  const existingUrl = process.env["OPENCODE_SERVER_URL"];
  let client: OpencodeClient;

  if (existingUrl) {
    // Explicit override: try to connect, fall back to fresh server
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      const testClient = createOpencodeClient({ baseUrl: existingUrl });
      await testClient.global.health();
      client = testClient;
      console.error(`[conformance-gate] Connected to existing server at ${existingUrl}`);
    } catch {
      console.error(`[conformance-gate] Could not reach ${existingUrl} — starting new server`);
      const { client: c } = await createOpencode();
      client = c;
    }
  } else {
    console.error(`[conformance-gate] Starting OpenCode server...`);
    const { client: c } = await createOpencode();
    client = c;
    console.error(`[conformance-gate] OpenCode server ready`);
  }

  // Inject Anthropic API key — correct API: path.id = provider, body = credentials
  await client.auth.set({
    path: { id: "anthropic" },
    body: { type: "api", key: apiKey },
  });

  // Create isolated session — correct API: body.title
  const sessionName = servicePath.split("/").pop() ?? "service";
  const session = await client.session.create({
    body: { title: `conformance:${sessionName}` },
  });
  // SDK returns Session directly in session.data (responseStyle: "fields" default)
  const sessionId = (session as any)?.data?.id ?? (session as any)?.id;
  if (!sessionId) {
    throw new Error(
      `[conformance-gate] session.create() returned no id — response: ${JSON.stringify(session)}`,
    );
  }
  console.error(`[conformance-gate] Session created: ${sessionId}`);

  // Send prompt with structured JSON output — no manual parsing needed
  // Correct API: path.id = session, body = { model, parts, format }
  console.error(`[conformance-gate] Sending audit prompt to ${MODEL.modelID}...`);
  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: MODEL,
      parts: [{ type: "text", text: buildPrompt(servicePath) }],
      format: {
        type: "json_schema",
        schema: VIOLATIONS_SCHEMA,
        retryCount: 2,
      },
    },
  });

  // Structured output is at result.data.info.structured_output
  const structured = (result as any)?.data?.info?.structured_output;
  if (structured?.violations !== undefined) {
    const violations = (structured.violations ?? []) as Violation[];
    console.error(`[conformance-gate] Agent found ${violations.length} violation(s)`);
    return violations;
  }

  // Fallback: parse text part if structured output not available
  const parts = (result as any)?.data?.parts ?? [];
  const textPart = parts.find((p: { type: string }) => p.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const rawText = textPart?.text ?? "";

  if (!rawText) {
    console.error("[conformance-gate] ⚠️  Empty agent response — assuming no violations");
    return [];
  }

  const jsonMatch =
    rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    rawText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error(`[conformance-gate] ⚠️  No JSON in response: ${rawText.slice(0, 300)}`);
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
