# Conformance Gate

Gate de conformidad para microservicios Rust, empaquetado como **GitHub Action
compuesto**. Evalúa cada servicio y decide si bloquear el merge: `pass`,
`manual_review` o `block`.

El estándar que valida (envelope homogéneo, sin panics, rutas obligatorias,
reglas OCI del Dockerfile…) **no vive en el código**: vive en un archivo de
política YAML del repo consumidor. Para crear o ajustar una regla, editas ese
YAML — en la mayoría de los casos sin tocar el código del agente.

---

## Arquitectura

El gate corre **dos motores** por servicio. Cualquiera puede bloquear el merge.

| Motor | Qué evalúa | Reglas | Determinismo |
| ----- | ---------- | ------ | ------------ |
| **static** | Patrones sobre el código `.rs` de producción y el `Dockerfile` | `BOX-002/004/005/006/007`, `OCI-*` | 100% reproducible (regex / lógica). Nunca alucina. |
| **ai** | Reglas que requieren juicio | `BOX-001` (envelope), `BOX-003` (arquitectura), `BOX-008` (validación) | Modelo LLM vía OpenCode |

**Por qué este reparto:** las reglas que de verdad bloquean un merge se evalúan
de forma determinista, así no dependen de que un modelo acierte. El LLM solo
carga los juicios que un regex no puede hacer. Esto también cierra la inyección
de prompt: aunque el código del PR intente manipular al modelo, no puede tocar
lo que se valida deterministamente.

### Flujo (`src/`)

```
policy.ts          carga + valida el policy.yaml  → fuente única de verdad
source.ts          lee el .rs de producción (sin #[cfg(test)] y sin comentarios)
dockerfile.ts      checks OCI deterministas del Dockerfile
static-source.ts   motor regex genérico (BOX estáticos) + enrichViolations()
agent.ts           genera el prompt DESDE el policy, con reintentos
decision.ts        traduce violaciones → pass | manual_review | block
report.ts          tabla PASS/FAIL por regla
index.ts           orquesta todo
```

La severidad se asigna en **un solo lugar** (`enrichViolations`, desde el
policy). Los motores —incluido el LLM— solo dicen *qué regla* se violó y *por
qué*; nunca deciden la severidad, así que el modelo no puede degradar una regla
ni inventar una nueva (los ids desconocidos se descartan).

---

## Inputs

| Input | Requerido | Default | Descripción |
| ----- | --------- | ------- | ----------- |
| `services-dir` | uno de los dos | — | Carpeta con varios servicios; evalúa cada subdirectorio |
| `service-path` | uno de los dos | — | Ruta a un único servicio |
| `policy-path` | no | `policy/conformity-policy.yaml` | Política YAML (fuente de verdad) |

Variable de entorno requerida: `ANTHROPIC_API_KEY` (para el motor `ai`).
Opcional: `INPUT_MODEL` (default `claude-haiku-4-5`).

### Uso en un workflow

```yaml
- name: Run Conformance Gate
  uses: Rxcxrdx/conformance-agent@v7
  with:
    services-dir: services
    policy-path: policy/conformity-policy.yaml
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## Política de decisión

Se deriva de la severidad de las violaciones (ver `decision.ts`):

| Condición | Decisión |
| --------- | -------- |
| Sin violaciones | `pass` |
| Alguna `critical` | `block` |
| 2+ `high` | `block` |
| 1 `high` ó 3+ `medium` | `manual_review` |
| Solo `low`/`medium` (sueltas) | `pass` con warnings |

Si el motor `ai` falla tras 3 reintentos con backoff, el gate **falla cerrado**
(el job sale ≠ 0 → merge bloqueado). Un hipo del modelo nunca deja pasar un PR
en silencio.

---

## Cómo agregar o cambiar una regla

Edita el `policy.yaml` del repo consumidor. Una regla **determinista** nueva no
requiere tocar código:

```yaml
- id: BOX-010
  name: no_todo_comments
  category: quality
  severity: low
  engine: static
  target: source
  match:
    flag_when: present      # present = el patrón es la violación
    pattern: 'TODO|FIXME'   # JS RegExp (YAML en comillas simples)
    message: "TODO/FIXME en producción"
    per_occurrence: true    # reporta file:line por cada hit
```

Reglas de tipo `ai` declaran `engine: ai` + `description` (se inyecta verbatim
en el prompt) y opcionalmente `exceptions`. Los checks de Dockerfile con lógica
multi-condición siguen codificados en `dockerfile.ts`, pero su severidad y datos
(p.ej. los labels de `OCI-005`) salen del policy.

Esquema completo y semántica de cada campo: comentarios al inicio del
`policy.yaml`.

---

## Desarrollo local

```bash
npm install
# Evalúa un servicio apuntando a una política concreta:
INPUT_POLICY_PATH=../poc-agent-devops/policy/conformity-policy.yaml \
  npx tsx src/index.ts --service ../poc-agent-devops/services/rust-svc
```

El motor `ai` necesita `ANTHROPIC_API_KEY`; los motores deterministas corren sin
red.
