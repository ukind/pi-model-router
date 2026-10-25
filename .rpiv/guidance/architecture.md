# Project Overview

`pi-model-router` — a per-turn model router extension for the pi coding agent. TypeScript, ESM-only, distributed as source: the pi host executes the `.ts` directly, nothing is compiled. The router exposes user-configured profiles as stable logical models (`router/<profile>`) and picks a concrete `high`/`medium`/`low` tier model every turn.

# Architecture

Single flat source layer — everything lives in `extensions/` (see `.rpiv/guidance/extensions/architecture.md` for the layer's module map and patterns).

Per-turn decision flow: budget check → manual pin → custom keyword rules → optional LLM classifier (chat or TypeSafe/Jev) → local heuristics → phase-bias stickiness. Failures fall back in-tier first, then down-then-nearest-up across tiers (down-only once the budget cap is exceeded).

Delivery contract (`package.json`):
- `pi.extensions: ["./extensions/index.ts"]` — the single entry point the host loads through jiti
- 4 `peerDependencies` at `*` (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) — the host supplies all runtime APIs; zero runtime dependencies
- `files` ships `extensions/` (tests stripped), `README.md`, `LICENSE`, `model-router.example.json`

# Project map

- `extensions/` — the entire source layer (15 modules + co-located tests)
- `model-router.example.json` — canonical config schema example (published)
- `scripts/probe-work-type.mjs` — live TypeSafe wire probe; gated by `PI_MODEL_ROUTER_PROBE=1`, paid call, not in CI
- `docs/ARCHITECTURE.md`, `AGENTS.md`, `TECH_DEBT_AUDIT.md` — repo-only docs (not published)
- `.github/workflows/ci.yml` — the only workflow; no release automation

# Commands

| Command | What it does |
|---|---|
| `npm run tsc` | Typecheck (`tsc --noEmit`) — the only "build"; `npm run build` emits nothing by design |
| `npm test` | `vitest run` over `extensions/**/*.test.ts` |
| `npm run test:coverage` | v8 coverage; thresholds (40% lines/statements, 30% branches/functions) on `provider.ts` + `routing.ts` only — local gate, not CI |
| `npm run format` | `prettier --write extensions` (repo-wide form) |
| `npx prettier --write <paths>` | path-scoped form — use for write-scoped verification of changed files |
| `npm run probe:work-type` | live TypeSafe `work_type` schema probe (requires `PI_MODEL_ROUTER_PROBE=1`) |
| `pi install .` | install the extension into pi from source |

# Business Context

Users trade cost against capability per turn: `high` for planning/architecture, `medium` for implementation, `low` for summaries and lookups. Config: `~/.pi/agent/model-router.json` (global base) deep-merged with `.pi/model-router.json` (project overrides). Session state (pins, profile, costs, debug history) persists via custom `router-state` session entries — branch-safe across restarts and conversation branches.

<important if="you are adding a user-facing config field">
- The full checklist spans `types.ts` → `config.ts` → `constants.ts` → consumers → `README.md` + `model-router.example.json`
- See `.rpiv/guidance/extensions/architecture.md` ("Adding a Config Field") — the README field table and the example JSON are the root-side artifacts
</important>

<important if="you are changing what ships in the npm package">
- The `files` whitelist is the contract: `extensions/` minus `*.test.ts`, `README.md`, `LICENSE`, `model-router.example.json`
- `docs/`, `AGENTS.md`, `TECH_DEBT_AUDIT.md`, `scripts/` are NOT published
</important>

<important if="you are releasing a new version">
- Manual `npm version` + `npm publish` — no git tags, no CHANGELOG, no release workflow exist
- `prepublishOnly` (typecheck + full test suite) is the only gate; CI never publishes
</important>
