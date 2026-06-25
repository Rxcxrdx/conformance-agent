/**
 * Step-by-step verification of the conformance-gate refactor.
 *
 * Runs WITHOUT network for the deterministic parts. The AI step (STEP 7) runs
 * only if ANTHROPIC_API_KEY is set, otherwise it is skipped.
 *
 *   npm run verify
 *
 * Paths default to the sibling poc-agent-devops repo; override with env vars
 * POLICY_PATH and GOOD_SVC if your layout differs.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { loadPolicy } from "../src/policy.js";
import { readProductionSources, joinSources } from "../src/source.js";
import { checkDockerfile } from "../src/dockerfile.js";
import { runStaticSourceChecks, enrichViolations } from "../src/static-source.js";
import { decide } from "../src/decision.js";
import { createAgentClient, runAgentChecks } from "../src/agent.js";
import type { Severity } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const poc = resolve(here, "../../poc-agent-devops");
const POLICY_PATH = process.env["POLICY_PATH"] ?? join(poc, "policy/conformity-policy.yaml");
const GOOD_SVC = process.env["GOOD_SVC"] ?? join(poc, "services/rust-svc");

let passed = 0;
let failed = 0;

function step(n: number, title: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    process.stdout.write(`\n── STEP ${n}: ${title}\n`);
    try {
      await fn();
      passed++;
      console.log(`   ✅ STEP ${n} OK`);
    } catch (e) {
      failed++;
      console.error(`   ❌ STEP ${n} FAILED: ${(e as Error).message}`);
    }
  })();
}

function check(label: string, cond: boolean) {
  if (!cond) throw new Error(label);
  console.log(`   · ${label}`);
}

// Builds a deliberately non-conforming service in a temp dir.
function makeBadService(): string {
  const dir = mkdtempSync(join(tmpdir(), "bad-svc-"));
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(
    join(dir, "Dockerfile"),
    ["FROM rust:latest", "RUN apt-get install -y curl", "COPY . .", "USER root", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "main.rs"),
    [
      "fn main() {",
      "    let x: Option<i32> = None;",
      '    println!("v {}", x.unwrap());',
      "    // este comentario menciona .unwrap() y NO debe contar",
      '    let _u = "https://host//path";',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "routes", "mod.rs"),
    ["// sin /health, sin /openapi.json, sin SwaggerUi", "pub fn nada() {}", ""].join("\n"),
  );
  return dir;
}

async function main() {
  console.log(`Policy : ${POLICY_PATH}`);
  console.log(`Good svc: ${GOOD_SVC}`);
  if (!existsSync(POLICY_PATH) || !existsSync(GOOD_SVC)) {
    console.error(
      "\n⚠️  No encuentro el policy o el servicio bueno. Ajusta POLICY_PATH / GOOD_SVC.",
    );
    process.exit(2);
  }

  const policy = loadPolicy(POLICY_PATH);

  // ── STEP 1 ───────────────────────────────────────────────────────────────
  await step(1, "El policy.yaml es la fuente de verdad y carga/valida bien", () => {
    check("policy_version = 3.0.0", policy.policy_version === "3.0.0");
    check("tiene 14 reglas", policy.rules.length === 14);

    const ai = policy.rules.filter((r) => r.engine === "ai").map((r) => r.id);
    const src = policy.rules
      .filter((r) => r.engine === "static" && r.target === "source")
      .map((r) => r.id);
    const dock = policy.rules
      .filter((r) => r.engine === "static" && r.target === "dockerfile")
      .map((r) => r.id);

    check("IA = BOX-001/003/008 (juicio)", ai.join(",") === "BOX-001,BOX-003,BOX-008");
    check(
      "estático/source = BOX-002/004/005/006/007",
      src.join(",") === "BOX-002,BOX-004,BOX-005,BOX-006,BOX-007",
    );
    check("estático/dockerfile = OCI-*", dock.every((id) => id.startsWith("OCI-")) && dock.length === 6);
    check("BOX-009 (francés) ya NO existe", !policy.rules.some((r) => r.id === "BOX-009"));

    // Un policy malformado debe fallar rápido (regla static+source sin pattern).
    const badPolicy = join(mkdtempSync(join(tmpdir(), "policy-")), "p.yaml");
    writeFileSync(
      badPolicy,
      'policy_version: "x"\nrules:\n  - id: X\n    severity: high\n    engine: static\n    target: source\n    match: { flag_when: present, message: "m" }\n',
    );
    assert.throws(() => loadPolicy(badPolicy), /pattern/i);
    check("policy inválido (sin pattern) lanza error", true);
  });

  // ── STEP 2 ───────────────────────────────────────────────────────────────
  let goodSources: ReturnType<typeof readProductionSources> = [];
  await step(2, "El código se sanea: sin tests, sin comentarios, sin falsos positivos", () => {
    goodSources = readProductionSources(GOOD_SVC);
    const joined = joinSources(goodSources);

    check("leyó archivos de producción", goodSources.length > 0);
    check("bloques #[cfg(test)] eliminados ('mod tests' fuera)", !joined.includes("mod tests"));
    check(
      "comentarios eliminados (doc '/// Historia de Hacker News' fuera)",
      !joined.includes("Historia de Hacker News"),
    );

    const residualUnwrap = goodSources.flatMap((f) =>
      f.lines.filter((l) => /\.unwrap\(\)/.test(l)),
    );
    check("cero .unwrap() residual en producción", residualUnwrap.length === 0);

    const unwrapOr = goodSources.flatMap((f) => f.lines).filter((l) => /\.unwrap_or/.test(l));
    check(".unwrap_or* preservado y NO confundido con .unwrap()", unwrapOr.length > 0);
  });

  // ── STEP 3 ───────────────────────────────────────────────────────────────
  await step(3, "Motores deterministas: el servicio BUENO pasa", () => {
    const raw = [
      ...checkDockerfile(GOOD_SVC, policy.rules),
      ...runStaticSourceChecks(policy.rules, goodSources),
    ];
    const violations = enrichViolations(raw, policy);
    if (violations.length) console.log("   inesperadas:", JSON.stringify(violations));
    check("0 violaciones deterministas", violations.length === 0);
    check("decisión = pass", decide("rust-svc", violations).decision === "pass");
  });

  // ── STEP 4 ───────────────────────────────────────────────────────────────
  await step(4, "Motores deterministas: un servicio MALO se bloquea", () => {
    const bad = makeBadService();
    const sources = readProductionSources(bad);
    const raw = [
      ...checkDockerfile(bad, policy.rules),
      ...runStaticSourceChecks(policy.rules, sources),
    ];
    const violations = enrichViolations(raw, policy);
    const ids = new Set(violations.map((v) => v.rule));

    for (const id of ["OCI-003", "OCI-004", "OCI-005", "OCI-008", "OCI-009", "OCI-010"]) {
      check(`detecta ${id}`, ids.has(id));
    }
    for (const id of ["BOX-002", "BOX-004", "BOX-005", "BOX-006", "BOX-007"]) {
      check(`detecta ${id}`, ids.has(id));
    }

    const box002 = violations.filter((v) => v.rule === "BOX-002");
    check("BOX-002 apunta a main.rs:3 (el .unwrap() real)", box002.some((v) => v.detail.includes("main.rs:3")));
    check(
      "BOX-002 NO marca el comentario de la línea 4",
      !box002.some((v) => v.detail.includes("main.rs:4")),
    );

    check("decisión = block", decide("bad-svc", violations).decision === "block");
  });

  // ── STEP 5 ───────────────────────────────────────────────────────────────
  await step(5, "La severidad la fija el policy; ids desconocidos se descartan", () => {
    const enriched = enrichViolations(
      [
        { rule: "BOX-002", detail: "x" },
        { rule: "BOX-006", detail: "y" },
        { rule: "INVENTADA-999", detail: "hallucinated" },
      ],
      policy,
    );
    check("regla inventada descartada (2 de 3 sobreviven)", enriched.length === 2);
    check("BOX-002 → high (desde policy)", enriched.find((v) => v.rule === "BOX-002")?.severity === "high");
    check(
      "BOX-006 → critical (desde policy, no lo que diga el motor)",
      enriched.find((v) => v.rule === "BOX-006")?.severity === "critical",
    );
  });

  // ── STEP 6 ───────────────────────────────────────────────────────────────
  await step(6, "La política de decisión por severidad es correcta", () => {
    const v = (s: Severity) => ({ rule: "R", detail: "d", severity: s });
    check("[] → pass", decide("s", []).decision === "pass");
    check("1 high → manual_review", decide("s", [v("high")]).decision === "manual_review");
    check("2 high → block", decide("s", [v("high"), v("high")]).decision === "block");
    check("1 critical → block", decide("s", [v("critical")]).decision === "block");
    check(
      "3 medium → manual_review",
      decide("s", [v("medium"), v("medium"), v("medium")]).decision === "manual_review",
    );
  });

  // ── STEP 7 (opcional) ─────────────────────────────────────────────────────
  await step(7, "Motor de IA end-to-end (solo si hay ANTHROPIC_API_KEY)", async () => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      console.log("   · (saltado: ANTHROPIC_API_KEY no está definido)");
      return;
    }
    const aiRules = policy.rules.filter((r) => r.engine === "ai");
    const { client, closeServer } = await createAgentClient();
    try {
      const raw = await runAgentChecks(client, goodSources, aiRules);
      check("el agente respondió un array de violaciones", Array.isArray(raw));
      console.log(`   · el agente reportó ${raw.length} violación(es) en el servicio bueno`);
    } finally {
      closeServer();
    }
  });

  console.log(`\n${"═".repeat(50)}`);
  console.log(`RESULTADO: ${passed} pasos OK, ${failed} fallidos`);
  console.log("═".repeat(50));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
