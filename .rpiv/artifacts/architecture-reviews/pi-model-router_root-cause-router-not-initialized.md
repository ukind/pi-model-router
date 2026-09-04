---
date: 2026-08-29T12:00:37+0700
author: Yogiswara Utama
commit: 524afdec
branch: main
repository: pi-model-router
target: extensions/
target_kind: module
layer_count: 8
unresolved_finding_count: 0
status: ready
tags: [architecture-review, pi-model-router, ctx-lifecycle, subagents]
phases: [{ n: 1, title: Root-cause fix — ctx capture lifecycle, depends_on: [], blast_radius: internal, effort: S }, { n: 2, title: Vocabulary — RouterRuntimeState + single pin writer, depends_on: [1], blast_radius: internal, effort: M }, { n: 3, title: Routing core structure + capability helpers, depends_on: [2], blast_radius: internal, effort: M }, { n: 4, title: Provider decomposition, depends_on: [3], blast_radius: internal, effort: L }]
status: ready
last_updated: 2026-08-29T12:00:37+0700
last_updated_by: Yogiswara Utama
---

# Architecture review — extensions/ (pi-model-router)

Review triggered by intermittent subagent failures: `Error: Router provider not initialized yet. Wait for session_start and retry.` when `pi-subagents` spawns child agents (`pi --mode json -p --model router/auto`). Root-cause investigation completed before layer review: the router's model registry is captured only from the `session_start` event handler, while pi invalidates extension ctx after session replacement (`newSession`/`fork`/`switchSession`/`reload`) and child sessions are replaced during startup — so the capture can be missed or invalidated before the first model call. Scope: all 8 source files in `extensions/` (~4.4k LOC, tests excluded).

---

## Conventions

### Finding shape

Each finding is a level-3 heading `### L<layer>-<seq> — <title>` followed by the fields below.

| Field | Meaning |
|---|---|
| **Evidence** | `file.ext:lineA-lineB` (+ short quote when useful) |
| **Current state** | what the code does today |
| **Desired state** | what we want it to look like |
| **Proposed improvement** | concrete action (rename, extract, merge, split, delete) |
| **Severity** | Low / Med / High — how wrong this is today |
| **Effort** | S / M / L — bounded changes ship cheaply |
| **Blast radius** | `internal` / `public-API` / `on-disk` / `cross-module` |
| **Class** | `polish` (rename / refactor / DRY) vs `redesign` (structural shift) |
| **Status** | `open` / `accepted` / `rejected` / `deferred` / `withdrawn` |
| **Depends on** | other finding IDs that must land first |
| **Cross-cut tag** | optional — see "Cross-cutting themes" |

### Status legend

- `open` — flagged, not yet triaged
- `accepted` — will land; includes the chosen option summary
- `rejected` — declined with reason inline
- `deferred` — accepted in principle but punted post-release
- `withdrawn` — initial diagnosis turned out incorrect; kept for audit

### Layers (top → down)

| # | Layer | Files |
|---|---|---|
| 0 | Orchestrator / event wiring | `index.ts` |
| 1 | Custom provider / delegation stream | `provider.ts` |
| 2 | Routing decision core | `routing.ts` |
| 3 | Config load / normalize | `config.ts` |
| 4 | CLI command surface | `commands.ts` |
| 5 | UI status / widget | `ui.ts` |
| 6 | Persistence | `state.ts` |
| 7 | Type vocabulary / constants | `types.ts`, `constants.ts` |

---

## Methodology principles

_Principles emerge during Step 5 triage and are captured at Step 6. Patterns that govern multiple decisions get named here; one block per principle._

---

## Layer 0 — Orchestrator / event wiring

Files: `extensions/index.ts`

_Read fully. This layer owns: extension lifecycle wiring, closure state, event handlers, persistence triggers, and the state object handed to provider/commands. The root-cause incident lives here and in Layer 1._

### L0-01 — Model registry captured only in session_start (root cause)

**Evidence**

`index.ts:26` (`let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;`), `index.ts:245-247` (sole assignment, inside `restoreStateFromSession`), called only from `index.ts:418` (`pi.on('session_start', ...)`).

```
pi.on('session_start', async (_event, ctx) => {
  isInitialized = true;
  await restoreStateFromSession(ctx);   // ← only place ctx.modelRegistry is captured
```

**Current state**

Any missed or stale `session_start` leaves the registry undefined for the process lifetime; `provider.ts` then throws `Router provider not initialized yet. Wait for session_start and retry.` on every call. Two observed failure shapes (session logs 2026-08-29T04:32-05:00Z): subagent children (`pi --mode json -p --model router/auto`, spawned by pi-subagents as child processes whose session is replaced during startup) fail on the first call; a parent session that routed successfully for four turns loses routing permanently after spawning a failing child. Pi invalidates extension ctx after session replacement (`agent-session.js:570` — "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()"), so a stale handler ctx aborts `restoreStateFromSession` before the assignment ever runs.

**Desired state**

The registry is guaranteed fresh before every `streamSimple` call, in every pi mode, and self-heals after any session replacement.

**Proposed improvement**

Add `captureCtx(ctx)` — try/catch around `ctx.modelRegistry`, `ctx.cwd`, `lastExtensionContext` — called at the top of every registered `pi.on(...)` handler, plus a new `pi.on('before_provider_request', (_e, ctx) => captureCtx(ctx))` handler. Pi's documented turn lifecycle (`before_agent_start` → `agent_start` → `before_provider_request` → model call) guarantees a fresh ctx immediately before each provider request, which covers the child first-call race and re-captures after parent-side replacement. `session_start` remains the full state restore.

- **Severity:** High
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — capture on every event + `before_provider_request` (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T1-ctx-lifecycle`

### L0-02 — Stale lastExtensionContext held long-term and used by provider

**Evidence**

`index.ts:46` (`let lastExtensionContext: ExtensionContext | undefined;`); consumed in `provider.ts` via `state.lastExtensionContext.ui.setHiddenThinkingLabel?.()` and `actions.updateStatus(state.lastExtensionContext)`.

**Current state**

The captured ctx outlives the session it came from; after replacement its getters throw (`assertActive`), and UI calls from the provider can fail.

**Desired state**

`lastExtensionContext` refreshed on every event alongside the registry; never older than the current turn.

**Proposed improvement**

None beyond L0-01 — `captureCtx` refreshes it.

- **Severity:** High
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted (absorbed into L0-01)**
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-ctx-lifecycle`

### L0-03 — restoreStateFromSession has no error isolation

**Evidence**

`index.ts:245-339` — single function: ctx capture, config reload, session branch scan, state restore, model re-select, persistence. Any throw (stale ctx getter, sessionManager error) aborts the whole `session_start` handler with state half-applied.

**Current state**

A mid-function throw leaves `isInitialized = true` but registry/cwd unset and pins/thinking/debug state un-restored — the exact half-initialized condition observed in failing child sessions.

**Desired state**

Capture never fails; restore failures are contained, surfaced via `ui.notify`, and never leave capture stale.

**Proposed improvement**

Split: `captureCtx` (two assignments, must-never-fail) + `restoreStateFromSession` keeps full restore with its own guard that notifies on failure instead of aborting silently.

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — split capture from restore
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-ctx-lifecycle`

### L0-04 — Event gates swallow ctx capture

**Evidence**

`index.ts:426` (`pi.on('model_select')` starts `if (!isInitialized || isInternalModelSwitch) return;`), same pattern in `thinking_level_select` (`index.ts:497`).

**Current state**

During the child startup race, events that arrive before `session_start` completes carry a fresh ctx but return before capturing anything.

**Desired state**

Capture happens on every event arrival regardless of behavioral gates.

**Proposed improvement**

`captureCtx` runs before the early-returns in every handler (rides L0-01's helper).

- **Severity:** Med
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — hoist capture above gates
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-ctx-lifecycle`

### L0-05 — routerEnabled/selectedProfile state machine spread across four handlers

**Evidence**

`routerEnabled` is written in `restoreStateFromSession`, `model_select`, `turn_end`, `ensureValidActiveRouterProfile`, `switchToRouterProfile`; `selectedProfile` in six places.

**Current state**

Correct today, but each new handler must remember to update the pair; nothing enforces it.

**Desired state**

Unchanged — the multi-writer pattern is accepted as-is (works, tested, low churn).

**Proposed improvement**

None.


- **Severity:** Low
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **rejected** — keep multi-writer pattern; consolidation adds churn with no behavioral gain (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T2-router-state-machine`

### Layer 0 — tally

| Status | Count |
|---|---|
| accepted | 4 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T1-ctx-lifecycle`, `T2-router-state-machine`.
Cross-cutting tags reused: —.

Dependency edges within Layer 0:

- L0-02 depends on L0-01 (same captureCtx helper)
- L0-03 depends on L0-01 (split introduces captureCtx)
- L0-04 depends on L0-01 (hoisting rides the helper)


---

## Layer 1 — Custom provider / delegation stream

Files: `extensions/provider.ts`

_Read fully. Owns: provider registration (honest capacities), streamSimple delegation, tier/model fallback loops, context truncation, cost accumulation. Consumes the closure-state getter-bag built in Layer 0._

### L1-01 — streamSimple hard-throws when registry unset; message misleads

**Evidence**

`provider.ts:106-109`

```
if (!state.currentModelRegistry) {
  throw new Error('Router provider not initialized yet. Wait for session_start and retry.');
}
```

**Current state**

The throw turns a recoverable capture gap into a permanent per-process failure; the message instructs users to wait for an event that will never re-fire. With L0-01 (capture on every event + `before_provider_request`) the guard becomes a last-resort invariant.

**Desired state**

Guard kept as an invariant check; message states the capture contract failed (no live ctx at stream time) rather than asking to wait.

**Proposed improvement**

Keep the guard; reword to e.g. `Router provider has no model registry: ctx capture never ran before this stream. This is a bug in the router extension — please report.` (exact wording at implementation time).

- **Severity:** Med (post-L0-01: safety net only)
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — keep + reword (developer choice)
- **Depends on:** L0-01
- **Cross-cut tag:** `T1-ctx-lifecycle`

### L1-02 — streamSimple IIFE is ~430 lines (granularity / intention)

**Evidence**

`provider.ts:117-565` — single async IIFE: decision, Google thought-signature continuation guard, image-attachment promotion, two nested fallback loops (`outer:` + inner for), stream pumping, cost tracking, decision mutation on fallback.

**Current state**

One function owns five concerns; inline helpers (`profileSupportsImages` inside the model-definitions map, `checkModelSupportsImage` inside the promotion block) are re-created per call; the fallback loop is hard to unit-test in isolation.

**Desired state**

Named phases that read top-down: `resolveDecision()` → `runDelegationLoop()` → `pumpStream()`; helpers hoisted to module scope.

**Proposed improvement**

Extract within `provider.ts` (no new files): phase functions taking explicit state/decision params; hoist `profileSupportsImages` and `checkModelSupportsImage` to module scope. No behavior change.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — extract phases (developer choice)
- **Depends on:** L1-01 (guard lands first so extraction keeps the reworded invariant)
- **Cross-cut tag:** —

### L1-03 — garbage router-state persisted from the failure path

**Evidence**

`provider.ts:568-570` (`finally { actions.persistState(); }`) — runs even when the L1-01 guard throws.

**Current state**

Failing child sessions persist `router-state { enabled: false, selectedProfile: "" }` before exiting (observed as entry 5 in session `web-search-researcher#c0b1016a`, 2026-08-29T04:35:10Z). Harmless but pollutes session files and misleads diagnosis.

**Desired state**

No persistence from the not-initialized guard path; persistence only after a decision has been made.

**Proposed improvement**

Skip `persistState()` when the L1-01 guard fires (throw before entering the try/finally that persists, or set a flag the finally checks).

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — skip persist on guard (developer choice)
- **Depends on:** L1-01
- **Cross-cut tag:** —

### L1-04 — duplicated fallback decision-mutation blocks (DRY)

**Evidence**

`provider.ts` cross-tier fallback block vs in-tier fallback block — both rebuild `decision.{isFallback,tier,phase,targetProvider,targetModelId,targetLabel,thinking,reasoning}` with near-identical assignments.

**Current state**

Two ~15-line blocks differ only in reasoning text and whether `phase` is recomputed.

**Desired state**

One `markDecisionFallback(decision, { tier, provider, modelId, label, thinking, reason })` helper used by both sites.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — dedupe via markDecisionFallback helper (developer choice)
- **Depends on:** L1-02 (extraction is the natural vehicle)
- **Cross-cut tag:** —

### L1-05 — closure-state getter-bag type declared inline in provider.ts

**Evidence**

`provider.ts:47-77` (~30-line inline `state` param), `commands.ts:36-71` (~40-line inline twin), and 11-positional-param signatures in `ui.ts:56-67` (`updateStatus`) and `state.ts:150-161` (`buildPersistedState`) mirroring the same fields.

**Current state**

The shared runtime-state contract lives in the consumer instead of the vocabulary layer.

**Desired state**

Named type (`RouterRuntimeState`) in `types.ts`; `provider.ts`, `commands.ts`, `index.ts` reference it; `updateStatus`/`buildPersistedState` take the bag instead of 11 positional params.

**Proposed improvement**

Add `RouterRuntimeState` to `types.ts` (readonly getters where the closure is read-only). Replace all three inline declarations and the long param lists.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — named type in types.ts, covers commands/ui/state signatures (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T3-runtime-state-vocabulary`

### L1-06 — context truncation utilities embedded in provider

**Evidence**

`provider.ts:33-141` — `estimateTokens`, `truncateContext` (~70 lines incl. toolCall/toolResult pair preservation).

**Current state**

Context-shaping logic lives in the provider layer; `routing.ts` already exports `extractTextFromContent` which provider imports for it.

**Desired state**

Truncation co-located with the other context-reading helpers in `routing.ts`.

**Proposed improvement**

Move `estimateTokens` + `truncateContext` to `routing.ts` (provider already imports `extractTextFromContent` from there).

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — move to routing.ts (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T4-helper-locality`

### Layer 1 — tally

| Status | Count |
|---|---|
| accepted | 6 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: `T3-runtime-state-vocabulary`, `T4-helper-locality`. Reused: `T1-ctx-lifecycle`.

Dependency edges within Layer 1:

- L1-02 depends on L1-01 (guard lands first)
- L1-03 depends on L1-01
- L1-04 depends on L1-02 (extraction is the vehicle)

---

## Layer 2 — Routing decision core

Files: `extensions/routing.ts`

_Read fully. Pure decision core: context readers, tier chain builders, heuristics, classifier prompt/parse/run. Importable without pi runtime (pure functions + one classifier I/O path)._

### L2-01 — decideRouting is ~250 lines with per-call keyword tables

**Evidence**

`routing.ts:207-462` — five keyword arrays (`explicitHighHints`, `explicitLowHints`, `planningKeywords`, `summaryKeywords`, `implementationKeywords`, `lookupKeywords`) and a `tierRank` map (duplicated from `matchHighestTierRule` at `routing.ts:198`) are rebuilt on every call.

**Current state**

The decision core works and is tested, but the function body interleaves table constants with three control branches (rule-merge, classifier-veto, heuristic cascade), and the tables rebuild per call.

**Desired state**

Tables and rank maps at module scope (matching the existing `wordBoundaryRegexCache` pattern); the three branches extracted as named helpers; `decideRouting` reads top-down as a story.

**Proposed improvement**

Hoist tables to module scope; extract `mergeRuleAndClassifier`, `applyClassifierDecision`, `applyHeuristicBranch`. No behavior change.

- **Severity:** Med
- **Effort:** M
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — hoist + extract branches (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T4-helper-locality`

### L2-03 — runClassifier collapses unparseable into undefined

**Evidence**

`routing.ts:509-512`

```
const parsed = parseClassifierOutput(fullText);
if (parsed.failureReason === 'unparseable') {
  return undefined;
}
```

**Current state**

`'no model available'`, `'stream failed'`, and `'output unparseable'` all return `undefined`, discarding the `failureReason` + `rawText` detail that `ClassifierResult` exists to carry — calibration and debugging lose the distinction.

**Desired state**

Distinct outcomes: callers can tell infra unavailability from parse failure.

**Proposed improvement**

Return `ClassifierResult` with `failureReason: 'unparseable'` (and `rawText`) instead of `undefined`. Callers already tolerate result-shaped returns (`decideRouting` consumes `failureReason`).

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — return failure result (developer choice)
- **Depends on:** —
- **Cross-cut tag:** —

### L2-04 — runClassifier duplicates provider's auth+stream pattern

**Evidence**

`routing.ts:475-495` (parse ref → `registry.find` → `getApiKeyAndHeaders` → `streamSimple`) mirrors `provider.ts` delegation loop.

**Current state**

Two call sites with different pumping needs (classifier accumulates text; provider streams forward + tracks cost); the shared part is ~6 lines.

**Desired state**

Unchanged — abstraction not worth it at two sites with different consumers.

**Proposed improvement**

None.

- **Severity:** Low
- **Effort:** M
- **Blast radius:** cross-module
- **Class:** polish
- **Status:** **rejected** — keep separate; shared surface is too small and consumers differ (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T4-helper-locality`

### Layer 2 — tally

| Status | Count |
|---|---|
| accepted | 2 |
| rejected | 1 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: —. Reused: `T4-helper-locality`.
Dependency edges within Layer 2: none.

---


## Layer 3 — Config load / normalize

Files: `extensions/config.ts`

_Read fully. Owns: global+project config merge, alias resolution, tier normalization, capability resolution chains. Pure FS + validation; no pi-runtime coupling beyond `getAgentDir`._

### L3-01 — capability-resolution twins and triple-duplicated probes

**Evidence**

`config.ts:489-523` (`resolveContextWindow`) vs `config.ts:527-563` (`resolveMaxTokens`) — line-for-line twins differing only in the field read (`contextWindow` vs `maxTokens`). Capability probing (parse ref → registry.find → field check) appears three times: `supportsReasoning` (`provider.ts:142-166`), `profileSupportsImages` (`provider.ts:207-228`, inside the map callback), `tierSupportsReasoning` (`config.ts:656-672`).

**Current state**

Four near-identical resolution/probe implementations; a registry-shape change would require four coordinated edits.

**Desired state**

One resolution helper + one capability probe in `config.ts`; provider imports them.

**Proposed improvement**

Extract `resolveTierCapability(tier, profile, registry, field)` (absorbing the twins) and `modelSupportsInRegistry(ref, registry, predicate)` (absorbing the probes). `supportsReasoning`/`profileSupportsImages` become thin loops over the probe.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — merge twins + probes (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T4-helper-locality`

### Layer 3 — tally

| Status | Count |
|---|---|
| accepted | 1 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: —. Reused: `T4-helper-locality`.
Dependency edges within Layer 3: none.

---


## Layer 4 — CLI command surface

Files: `extensions/commands.ts`

_Read fully. Owns: `/router` subcommands, autocomplete, calibration recording. Receives the inline state twin (see L1-05) and writes `pinnedTierByProfile` directly._

### L4-02 — dead pin helpers; pin writes bypass any shared writer

**Evidence**

`index.ts:81-97` — `getPinnedTierForProfile` / `setPinnedTierForProfile` defined with **zero callers** (verified by grep across all source files). Meanwhile `handlePin` (`commands.ts:221-223`) and `handleFix` (`commands.ts:442`) write `state.pinnedTierByProfile[...]` directly.

**Current state**

Two dead accessors coexist with direct map writes; there is no single writer for pin state.

**Desired state**

One writer; no dead code.

**Proposed improvement**

Delete the two dead helpers; route `/router pin` and `/router fix` through one `setPinnedTier` action.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — delete dead helpers + unify writer (developer choice)
- **Depends on:** —
- **Cross-cut tag:** `T3-runtime-state-vocabulary`

### L4-04 — classifierCalibration is write-only state

**Evidence**

`handleFix` (`commands.ts:426-456`) records entries; `state.ts` validates/persists them; **nothing reads them** — `decideRouting` never consults past corrections (verified by grep: sole consumers are persist/restore).

**Current state**

Durable telemetry with no consumer; README frames `/router fix` as calibration capture for a future calibration loop.

**Desired state**

Recording kept; the write-only status made explicit in code so future readers do not hunt for a consumer.

**Proposed improvement**

Keep recording; add a one-line comment at the recording site (and on the type) noting calibration is not yet consumed by routing.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted** — keep as future-feature telemetry, document write-only status (developer choice)
- **Depends on:** —
- **Cross-cut tag:** —

### L4-01 — commands.ts inline state type twin

Absorbed into L1-05 (same contract, same fix).

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted (absorbed into L1-05)**
- **Depends on:** L1-05
- **Cross-cut tag:** `T3-runtime-state-vocabulary`

### Layer 4 — tally

| Status | Count |
|---|---|
| accepted | 3 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: —. Reused: `T3-runtime-state-vocabulary`.
Dependency edges within Layer 4: L4-01 rides L1-05.

---


## Layer 5 — UI status / widget

Files: `extensions/ui.ts`

_Read fully. Pure formatters + `updateStatus` (status line + widget render). No findings beyond the 11-positional-param signature on `updateStatus` (`ui.ts:56-67`) — the same runtime-state contract as L1-05._

### L5-01 — updateStatus takes 11 positional params

**Evidence**

`ui.ts:56-67` — `updateStatus(ctx, routerEnabled, selectedProfile, pinnedTierByProfile, thinkingByProfile, lastDecision, lastNonRouterModel, accumulatedCost, widgetEnabled, currentConfig)`.

**Current state**

The parameter list mirrors the runtime-state bag that provider.ts and commands.ts declare as inline types.

**Desired state**

One named bag type shared across layers.

**Proposed improvement**

Rides L1-05: pass `RouterRuntimeState` (+ ctx) instead of the positional list.

- **Severity:** Low
- **Effort:** S
- **Blast radius:** internal
- **Class:** polish
- **Status:** **accepted (absorbed into L1-05)**
- **Depends on:** L1-05
- **Cross-cut tag:** `T3-runtime-state-vocabulary`

### Layer 5 — tally

| Status | Count |
|---|---|
| accepted | 1 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: —. Reused: `T3-runtime-state-vocabulary`.
Dependency edges within Layer 5: L5-01 depends on L1-05.

---


## Layer 6 — Persistence

Files: `extensions/state.ts`

_Read fully. Owns: `RouterPersistedState` validation (reject-whole vs per-field sanitize), state building. Clean layer — validators are thorough and well-documented. `buildPersistedState` carries the same 11-positional-param signature as `updateStatus`; covered by L1-05 (no separate finding)._

_No new findings._

### Layer 6 — tally

| Status | Count |
|---|---|
| accepted | 0 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

Cross-cutting tags introduced: —. Reused: `T3-runtime-state-vocabulary` (via L1-05 only).

---


## Layer 7 — Type vocabulary / constants

Files: `extensions/types.ts`, `extensions/constants.ts`

_Read fully. `types.ts` is a clean single-source vocabulary (tier/phase/decision/persisted-state); `constants.ts` is 4 lines. The only vocabulary gap is the missing `RouterRuntimeState` (L1-05). `RoutedTierConfig` mixes user-written and pre-resolved fields — documented in code and consumed by `collectProfileThinkingLevels`; left as-is._

_No new findings._

### Layer 7 — tally

| Status | Count |
|---|---|
| accepted | 0 |
| rejected | 0 |
| deferred | 0 |
| withdrawn | 0 |

---


## Cross-cutting themes

Cross-cut threads surfaced during layer-by-layer review. Each thread ties multiple findings together; the polishing plan groups by theme where possible to minimise merge conflicts and review burden.

### T1 — ctx-lifecycle (active, closed by Phase 1)

**Findings:** L0-01, L0-02, L0-03, L0-04, L1-01, L1-03.

The root-cause thread. The router holds long-lived captures (`currentModelRegistry`, `lastExtensionContext`) sourced exclusively from `session_start`, while pi delivers fresh ctx on every event and invalidates old ctx after any session replacement. Subagent children (fresh `pi` processes whose sessions are replaced during startup) and parents that replace sessions hit the stale or missing capture and fail with "Router provider not initialized". Thread deliverable: capture-on-every-event + `before_provider_request`, error-isolated restore, guard kept as a reworded invariant, no garbage persistence — after which the failure mode is structurally impossible rather than merely rarer.

### T2 — router-state-machine (closed by L0-05 rejection)

**Findings:** L0-05.

The `routerEnabled`/`selectedProfile` multi-writer state machine was flagged for consolidation; the developer rejected the change (works, tested, low churn). Theme closed with no code movement.

### T3 — runtime-state vocabulary (active, closed by Phase 2)

**Findings:** L1-05, L4-01, L4-02, L5-01.

The router runtime state has one conceptual shape and four actual spellings (two inline types, a dead accessor pair with direct writes, two 11-param signatures). Thread deliverable: one named `RouterRuntimeState` in `types.ts`, signatures become bag-based, one pin-writer.

### T4 — helper locality and DRY (active, closed by Phase 3)

**Findings:** L1-04, L1-06, L2-01, L2-04 (rejected), L3-01.

Helper placement and duplication: phase functions in provider, table hoisting in routing, truncation relocation to routing, resolution twins and capability probes merged in config. The L2-04 rejection bounds the theme — auth+stream wiring stays per-consumer by design.

---


## Consolidated polish plan

4 phases, ordered top-to-bottom, sequenced to avoid same-file conflicts. Each phase is blueprint-consumable; sizing is by agent-relevant signals, never human-days.

### Phase 1 — Root-cause fix: ctx capture lifecycle

**Goal:** make "Router provider not initialized yet" structurally impossible — fresh model registry guaranteed before every `streamSimple`, self-healing after session replacement.

**Findings (6, incl. 1 absorbed):** L0-01, L0-02 (absorbed), L0-03, L0-04, L1-01, L1-03.

**Files touched (2):** `extensions/index.ts`, `extensions/provider.ts`.

**Blast-radius mix:** internal: 6.

**Class mix:** polish: 6; redesign: 0.

**Coordination:** none.

**Risk callouts:** behavior-affecting but small. Keep the `session_start` full restore path intact (it seeds pin/thinking/profile state); the new `captureCtx` must be try/catch-guarded so a stale ctx getter never aborts a handler. Extend `index.test.ts` and `provider.test.ts`: add a test that `streamSimple` succeeds when `before_provider_request` fired but `session_start` did not.

### Phase 2 — Vocabulary: RouterRuntimeState + single pin writer

**Goal:** one named runtime-state contract; dead code removed; pin writes unified.

**Findings (5, incl. 2 absorbed):** L1-05, L4-01 (absorbed), L5-01 (absorbed), L4-02, L4-04 (doc comment).

**Files touched (6):** `extensions/types.ts`, `extensions/index.ts`, `extensions/provider.ts`, `extensions/commands.ts`, `extensions/ui.ts`, `extensions/state.ts`.

**Blast-radius mix:** internal: 5.

**Class mix:** polish: 5; redesign: 0.

**Coordination:** none.

**Risk callouts:** wide but mechanical — every file is touched; land as one coherent commit after Phase 1 is proven in the field. Type-only changes except the pin-writer move.

### Phase 3 — Routing core structure + capability helpers

**Goal:** decision core reads top-down; classifier failure reasons preserved; helper locality settled.

**Findings (4):** L2-01, L2-03, L1-06, L3-01.

**Files touched (3):** `extensions/routing.ts`, `extensions/provider.ts`, `extensions/config.ts`.

**Blast-radius mix:** internal: 4.

**Class mix:** polish: 4; redesign: 0.

**Coordination:** none.

**Risk callouts:** L2-01 is behavior-preserving extraction over an 18-branch heuristic cascade — lean on `routing.test.ts` (1185 lines) as the safety net; do L3-01 and L1-06 in the same phase to avoid touching `provider.ts` twice.

### Phase 4 — Provider decomposition

**Goal:** streamSimple reads as named phases (decision, delegation, stream pump); fallback mutation deduped.

**Findings (2):** L1-02, L1-04.

**Files touched (1):** `extensions/provider.ts`.

**Blast-radius mix:** internal: 2.

**Class mix:** polish: 2; redesign: 0.

**Coordination:** none.

**Risk callouts:** largest single-artifact refactor of the review (728-line file becomes phase functions). Run after Phases 1-3 so the guard, vocabulary, and helpers land first. The Google continuation guard and fallback loops are subtle — extract without reordering side effects (`recordDebugDecision` post-stream, `persistState` in finally).

### Dependency graph (phase-level)

```
Phase 1 (ctx capture — root cause)
   ↓
Phase 2 (vocabulary)
   ↓
Phase 3 (routing + capability helpers)
   ↓
Phase 4 (provider decomposition)
```

### Phase scope summary

| Phase | Findings | Files | Blast-radius mix | Coordination |
|---|---|---|---|---|
| 1 — ctx capture fix | 6 | 2 | internal: 6 | none |
| 2 — vocabulary | 5 | 6 | internal: 5 | none |
| 3 — routing structure | 4 | 3 | internal: 4 | none |
| 4 — provider decomposition | 2 | 1 | internal: 2 | none |
| **Total** | **17** | **8 distinct** | — | — |

**Total findings reviewed: 19 (17 accepted, 2 rejected). Accepted includes 3 absorbed (L0-02, L4-01, L5-01).**

### Risk callouts (cross-phase)

1. Phase 1 is the field experiment for the whole review: ship it alone, watch a workflow with parallel subagents, then continue. If the incident recurs after Phase 1, re-open L0-01 diagnostics (log when `before_provider_request` fires with an already-stale ctx) before starting Phase 2.
2. Phases 3 and 4 both touch `provider.ts`. Complete Phase 3 fully before starting Phase 4 — L1-04's helper lands inside the L1-02 decomposition.
3. All phases are `internal` blast radius; no on-disk format, public-API, or cross-module coordination is required (router config and the `router-state` session-entry schema are untouched).

### Final tally

| Layer | Findings | Accepted | Rejected | Withdrawn |
|---|---|---|---|---|
| L0 — Orchestrator / event wiring | 5 | 4 | 1 | 0 |
| L1 — Custom provider / delegation stream | 6 | 6 | 0 | 0 |
| L2 — Routing decision core | 3 | 2 | 1 | 0 |
| L3 — Config load / normalize | 1 | 1 | 0 | 0 |
| L4 — CLI command surface | 3 | 3 | 0 | 0 |
| L5 — UI status / widget | 1 | 1 | 0 | 0 |
| L6 — Persistence | 0 | 0 | 0 | 0 |
| L7 — Type vocabulary / constants | 0 | 0 | 0 | 0 |
| **Total** | **19** | **17** | **2** | **0** |

**Cross-cuts closed by completion of this plan:** T1, T3, T4 (3 of 4).

**Cross-cuts remaining active (by design, post-completion):** T2 — closed by rejection at triage; documented for audit only.

Plan ready for the implementation phase.

