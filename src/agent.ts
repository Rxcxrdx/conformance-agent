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
Analyze the code above and report violations of these rules:

BOX-001 · severity: high · response_shape_homogeneous
  Every HTTP handler must return EXACTLY one of:
    { "success": true,  "data": <any payload> }
    { "success": false, "error": "<string message>" }
  Flag handlers returning raw structs, Vec, String, plain StatusCode,
  or shapes without "success" + ("data" | "error").

BOX-002 · severity: high · no_panics_exposed
  Production code (outside #[cfg(test)]) must NOT call
  .unwrap(), .expect() or panic!() anywhere.
  Flag every occurrence with file path and line number.

BOX-003 · severity: low · hexagonal_structure
  Business logic must live in domain/ modules only.
  Handlers in routes/ must only: extract params → call domain → wrap in envelope.
  Flag if routes/ contain inline business logic (DB queries, HTTP calls,
  data transformations beyond extracting params).

BOX-004 · severity: high · swagger_ui_registered
  The service MUST register a /swagger-ui route (look for SwaggerUi::new
  or .merge(...swagger...) in router setup, typically src/main.rs or src/router.rs).
  Flag if no /swagger-ui route is registered.

BOX-005 · severity: high · openapi_spec_registered
  The service MUST register a /openapi.json route serving the OpenAPI spec
  (look for /openapi.json or openapi route registration).
  Flag if no /openapi.json route is registered.

BOX-006 · severity: critical · health_endpoint_registered
  The service MUST register a /health route returning service status.
  Flag if no /health route is registered.

BOX-007 · severity: medium · structured_logging
  The service MUST use structured logging via the tracing crate
  (look for use tracing::, #[instrument], or tracing_subscriber init).
  Flag if it uses println! or eprintln! in production code instead.

BOX-008 · severity: medium · input_validation
  Request body extractors (Json<T>, Form<T>, Query<T>) where T contains
  String fields SHOULD use validation (validator crate, garde, or manual checks).
  Flag handlers that accept user input without any validation.
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

  // v2 SDK: auth.set uses path.providerID, not path.id
  await client.auth.set({
    path: { providerID: "anthropic" },
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

  // Fail loudly if the SDK call returned an error envelope — never silently pass.
  const sdkError = (result as any)?.error;
  if (sdkError) {
    throw new Error(
      `[conformance-gate] SDK error from session.prompt: ${JSON.stringify(sdkError).slice(0, 800)}`,
    );
  }

  // Response shape with default "fields" responseStyle: { data: { info, parts }, ... }
  const data = (result as any)?.data ?? result;
  const parts = data?.parts ?? [];
  const textPart = parts.find((p: { type: string }) => p.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const rawText = textPart?.text ?? "";

  if (!rawText) {
    throw new Error(
      `[conformance-gate] Agent returned empty response — refusing to assume pass. Full result: ${JSON.stringify(result).slice(0, 800)}`,
    );
  }

  console.error(`[conformance-gate] Agent response (${rawText.length} chars): ${rawText.slice(0, 200)}...`);

  const jsonMatch =
    rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    rawText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(
      `[conformance-gate] Agent response had no JSON block:\n${rawText.slice(0, 800)}`,
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const violations = (parsed.violations ?? []) as Violation[];
    console.error(`[conformance-gate] Agent found ${violations.length} violation(s)`);
    return violations;
  } catch (e) {
    throw new Error(
      `[conformance-gate] Agent JSON parse failed: ${(e as Error).message}\nRaw: ${jsonMatch[1].slice(0, 500)}`,
    );
  }
}
