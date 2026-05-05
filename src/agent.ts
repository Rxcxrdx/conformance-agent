import {
  createOpencode,
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { Violation } from "./types.js";

const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

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

  // createOpencode() starts the OpenCode server automatically
  // and returns a connected client — no separate Docker service needed.
  // If a server is already running (local dev), connect to it instead.
  const existingUrl =
    process.env["OPENCODE_SERVER_URL"] ?? "http://127.0.0.1:4096";
  let client: OpencodeClient;
  try {
    const testClient = createOpencodeClient({ baseUrl: existingUrl });
    await testClient.global.health();
    client = testClient;
    console.error(
      `[conformance-gate] Connected to existing OpenCode server at ${existingUrl}`,
    );
  } catch {
    const { client: newClient } = await createOpencode();
    client = newClient;
    console.error(`[conformance-gate] Started new OpenCode server`);
  }

  // Inject Anthropic credentials into the running server
  await client.auth.set({
    providerID: "anthropic",
    auth: { type: "api", key: apiKey },
  });

  // Create an isolated session for this evaluation
  const sessionName = servicePath.split("/").pop() ?? "service";
  const sessionResp = await client.session.create({
    title: `conformance:${sessionName}`,
  });
  const sessionId = sessionResp.data.id;

  // Send the audit prompt — agent uses file.read + find.files to explore the repo,
  // then returns JSON violations in text. We parse it below.
  const result = await client.session.prompt({
    sessionID: sessionId,
    model: MODEL,
    parts: [{ type: "text", text: buildPrompt(servicePath) }],
  });

  const textPart = result.data?.parts?.find(
    (p: { type: string }) => p.type === "text",
  ) as { type: "text"; text: string } | undefined;
  const rawText = textPart?.text ?? "";

  // Extract the JSON object from the response (may be wrapped in markdown code block)
  const jsonMatch =
    rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    rawText.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error(
      "[conformance-gate] Agent response had no JSON — assuming no violations",
    );
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return (parsed.violations ?? []) as Violation[];
  } catch {
    console.error(
      "[conformance-gate] Failed to parse agent JSON:",
      jsonMatch[1],
    );
    return [];
  }
}
