---
date: 2026-08-30T08:33:23+0700
author: Yogiswara Utama
commit: 4ae87431
branch: main
repository: pi-model-router
topic: "Intermittent error: Router provider has no model registry — no ctx was captured before this stream (post Phase-1 recurrence)"
tags: [research, provider, ctx-lifecycle, before_provider_request, subagents, pi-internals]
status: ready
last_updated: 2026-08-30T08:33:23+0700
last_updated_by: Yogiswara Utama
---

# Research: Intermittent "Router provider has no model registry: no ctx was captured before this stream"

## Research Question

The error `Router provider has no model registry: no ctx was captured before this stream. This is a router extension bug — please report it.` appears sometimes. Why does it still fire after commit `4ae87431` (Phase 1 of the ctx-lifecycle review) made `captureCtx` run on every event, with `before_provider_request` as the "capture contract anchor"?

## Summary

The Phase-1 anchor assumption is false. `before_provider_request` never fires before the router's own `streamSimple`. Pi emits it from the `onPayload` callback, and only builtin API implementations call `onPayload` while they build an HTTP payload. A `router/*` request resolves through compat's api map straight to the router's own `streamSimple` closure. No payload is built and no hook runs. The hook fires later, inside the delegated inner concrete-model call, after the guard has already run.

So the guard at `extensions/provider.ts:290-303` is protected only by earlier events — `session_start`, `model_select`, `turn_end`, or `thinking_level_select`. It is a first-call race, not an invariant. The error means one thing: a router stream reached an extension closure that never received a live ctx. `captureCtx` cannot unset the registry, so no stale-capture path produces this message.

Trigger windows: a router stream issued after session replacement or reload but before the new `session_start`; a session that never calls `bindExtensions` (SDK hosts, some subagent paths); auto-compaction or branch summarization as the first LLM call (they carry no `onPayload`); a partial extension-factory failure that discards all handlers while the provider registration survives on the shared runtime; and process-global api-map aliasing, where a fresh closure overwrites the previous closure that a still-running session depends on.

Ruled out: the `modelsKey` memoization freeze, a stale-but-present registry, a torn write inside `captureCtx`, and cross-extension handler interference. None can produce this message.

Fix direction chosen at checkpoint: structural fix at guard time, plus a deterministic regression test built on the real `ExtensionRunner`, plus the diagnostic logging the review already mandates.

## Detailed Findings

### Dispatch chain for a `router/*` request — no hook before the guard

- `agent-loop.js:189-193` calls `streamFunction(config.model, llmContext, ...config)` with `onPayload` inside the options (`pi-agent-core/dist/agent.js:117, 284`).
- Pi's `streamFn` (`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:176-198`) resolves auth and calls compat `streamSimple` (`sdk.js:189`). It passes `onPayload` down. It never calls it.
- Compat (`node_modules/@earendil-works/pi-ai/dist/compat.js:170-176`): `shouldUseBuiltinModels` is false for `router/*` (`compat.js:148-151`), so `resolveApiProvider('router-local-api')` returns the entry that `model-registry.js:697-704` registered from `pi.registerProvider` (`extensions/provider.ts:271-279`). The router closure runs directly.
- The guard at `extensions/provider.ts:290-303` runs synchronously, before the first `await`. Nothing extension-visible ran before it.

### Where `before_provider_request` actually fires

- `sdk.js:200-205` emits it from `onPayload`, gated by `runner.hasHandlers` (`runner.js:343-351`).
- Only builtin pi-ai API implementations call `onPayload`: `anthropic-messages.js:346`, `openai-completions.js:106`, `openai-responses.js:98`, `google-generative-ai.js:37`, `google-vertex.js:47`, `bedrock-converse-stream.js:127`, `mistral-conversations.js:31`, `openai-codex-responses.js:156`.
- The router forwards `onPayload` into the delegated inner call via `delegationOptions` (`extensions/provider.ts:597-598`, delegated call at `:614-628`). The hook therefore fires inside the guarded region, during delegation — after the guard has already passed or failed.
- The anchor comments at `extensions/index.ts:521-529` and `extensions/provider.ts:283-289` state the opposite order. The comments are wrong for the router's own entry point.

### `captureCtx` semantics — the registry can only go from undefined to set

- `captureCtx` (`extensions/index.ts:70-79`) writes `lastExtensionContext`, then `currentModelRegistry`, then `currentCwd`, inside one `try/catch`. On a stale ctx, `ctx.modelRegistry` throws in `assertActive` (`runner.js:435-438`, `:329-333`, invalidation from `AgentSession.dispose()` at `agent-session.js:490`).
- The catch keeps prior values. No path assigns `undefined`. After one successful capture, the guard can never fire again in that closure. The error therefore proves the closure never captured anything.
- Torn write exists but produces a different failure: `lastExtensionContext` can hold a dead ctx while the registry stays truthy. Consumers then throw pi's stale-ctx text — `actions.updateStatus(state.lastExtensionContext)` at `extensions/provider.ts:465-466` fails in the outer try and kills the turn; `state.lastExtensionContext.ui.setHiddenThinkingLabel?.()` at `:587-594` fails per candidate and exhausts the fallback chain. Optional chaining does not help: the `.ui` getter throws before the call.

### Trigger windows for an undefined registry at guard time

1. Session replacement or `/reload`: the factory re-executes (`loader.js:346`; module cache holds the factory only, `loader.js:295-317`), producing a fresh closure with `currentModelRegistry === undefined` (`extensions/index.ts:40`). The provider re-registers into the new registry (`agent-session-services.js:47-81`). Print mode awaits `rebindSession` before the first prompt (`print-mode.js:93-95`), so a clean child start is safe. The hazard is a stream issued after `dispose()` but before the new `session_start` (`agent-session.js:1666`, reached only via `bindExtensions` at `:1646`).
2. `AgentSession.reload()` emits `session_start` only when `hasBindings` is true (`agent-session.js:1960-1966`). Without UI/command/shutdown/error bindings, the fresh closure never captures.
3. SDK hosts that never call `bindExtensions` — no `session_start` at all.
4. Auto-compaction (`agent-session.js:1563` → `compaction.js:467`) and branch summarization (`agent-session.js:2240-2254`, `branch-summarization.js:226`) call the stream function directly with options that carry no `onPayload`. If one of these is the first LLM call of a fresh closure, the guard fires and no hook can prevent it.
5. Partial factory load: `loadExtension` discards the whole extension object on a throw (`loader.js:339-354`), but `pendingProviderRegistrations` lives on the shared runtime (`loader.js:160-162`) and is still flushed. Result: provider live, zero handlers, registry permanently undefined in that process. Candidate throw sites sit between `actions.reloadConfig()` (`extensions/index.ts:341`) and the `pi.on` registrations.
6. Process-global api-map aliasing: `registerApiProvider` installs the router closure into compat's process-global api map (`compat.js:62-71`). `ModelRegistry.refresh()` resets and re-applies stored provider configs (`model-registry.js:273-284`). A fresh closure can overwrite the map entry that a still-running session relies on. This matches the observed surface (parent TUI, triggered by parallel subagents — see Developer Context).

### Ruled-out hypotheses

- `modelsKey` memoization (`extensions/provider.ts:264-270`): the guard reads the live getter, not registration-time state. A frozen registration cannot make the registry undefined. The only real defect here is stale `thinkingLevelMap`/`name` advertisement when the key matches but those fields changed.
- Stale-but-present registry: `ModelRegistry` holds no session reference and has no invalidation (`model-registry.js:251-269`). `find` is a pure scan (`:501-503`); `getApiKeyAndHeaders` converts every throw to `{ok:false,error}` (`:532-581`). A stale registry produces `Routed model not found`, auth failure, or fallback exhaustion — never this message. Also, services normally reuse one registry across sessions.
- Cross-extension interference: the `before_provider_request` emit loop has no break or short-circuit (`runner.js:714-745`); each handler is individually caught and iteration continues. No other extension can skip the router's handler. A hung earlier handler can delay it, because handlers run sequentially (`runner.js:727`).

### Latent secondary defects found

- The `runtime?.streamSimple` branch at `extensions/provider.ts:607-613` is dead in this pi version: `ModelRegistry` has no `runtime` member. Custom api ids always take the compat branch and throw `No API provider registered for api: ...`.
- Dead-ctx-with-truthy-registry crashes delegation through `lastExtensionContext` (see above), surfacing as pi's stale-ctx message instead of a router diagnostic.
- `commands.ts` handlers receive a ctx but never call `captureCtx` (harmless today; they use ctx directly).
- Forensics: the guard path writes nothing. No `recordDebugDecision` (it runs only post-stream, `extensions/provider.ts:723`), no `router-state` (the guard returns before the persisting `finally`, `:736-737`, asserted by `extensions/provider.test.ts:812`). The only durable trace is the assistant error entry appended to the session JSONL via `message_end` (`agent-session.js:277-288`). Mode, subagent identity, and capture provenance are not recorded anywhere.

### Test gap

- `extensions/index.test.ts:53-66` — the mock discards provider configs; `:109-146` asserts handler wiring and stale-ctx tolerance with no assertions on the stale path itself.
- `extensions/provider.test.ts:788-813` — sets `currentModelRegistry = undefined` by direct assignment on a plain object (production uses a getter, `extensions/index.ts:297-302`), then calls `streamSimple` directly.
- Neither test drives the real ordering: factory → `bindCore` flush (`runner.js:184-203`) → first `streamSimple` with `session_start` omitted. `ExtensionRunner`, `createExtensionRuntime`, `ModelRegistry`, and `createAgentSession` are exported from the package root (`dist/index.js:11,13,19`), so a deterministic test is buildable without deep imports.

## Code References

- `extensions/index.ts:40` — `currentModelRegistry` starts `undefined` per closure instance
- `extensions/index.ts:70-79` — `captureCtx`: assignment order, swallow-on-stale catch
- `extensions/index.ts:222,264,341` — `registerRouterProvider` call sites; factory-load-time registration
- `extensions/index.ts:297-302` — live getter bag handed to provider
- `extensions/index.ts:521-534` — anchor comment + `before_provider_request` and `session_start` handlers
- `extensions/index.ts:542-596` — `model_select`, `turn_end`, `thinking_level_select` capture sites
- `extensions/provider.ts:264-279` — `modelsKey` memoization and `pi.registerProvider`
- `extensions/provider.ts:290-303` — the guard and its error message
- `extensions/provider.ts:465-466,587-594` — `lastExtensionContext` consumers that throw on a dead ctx
- `extensions/provider.ts:597-628` — `delegationOptions` forwards `onPayload`; dead `runtime.streamSimple` branch
- `extensions/provider.ts:736-737` — persisting `finally` skipped by the guard
- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:176-205` — `streamFn` dispatch and `onPayload` emission
- `node_modules/@earendil-works/pi-ai/dist/compat.js:62-71,148-176` — process-global api map and router dispatch
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:697-731` — provider registration into the registry and api map
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:184-203,411-479,714-745` — flush, `createContext` getters, `emitBeforeProviderRequest` loop
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:129-182,295-354` — stale runtime, pending registrations, factory re-execution, discard-on-throw
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:490,1563,1646-1667,1949-1968,2240-2254` — dispose, compaction, `bindExtensions`/`session_start`, conditional reload emit, branch summary
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js:48-108` — headless bind-before-prompt and error surfacing
- `extensions/index.test.ts:53-66,109-146` and `extensions/provider.test.ts:61-66,92-106,788-813` — the test gap

## Integration Points

### Inbound References

- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:189` → compat → router `streamSimple` (`extensions/provider.ts:277`) — the turn's provider entry; no hook precedes it
- `agent-session.js:1563` (auto-compaction) and `agent-session.js:2240-2254` (branch summary) → same entry, without `onPayload`
- Five event handlers at `extensions/index.ts:527-596` → `captureCtx` — the only registry writers
- `runner.js:714-745` → router's `before_provider_request` handler — runs only from the delegated inner request's `onPayload`

### Outbound Dependencies

- `extensions/provider.ts:614-628` → pi-ai compat `streamSimple` for the delegated concrete model
- `extensions/provider.ts:541-558` → `modelRegistry.find` and `modelRegistry.getApiKeyAndHeaders`
- `extensions/routing.ts:698-750` → `runClassifier` uses compat `streamSimple` directly; never passes `onPayload`; runs after the guard, so it cannot cause this error

### Infrastructure Wiring

- `pi.registerProvider` (`extensions/provider.ts:271`) pre-bind queues into `pendingProviderRegistrations` (`loader.js:160-162`), flushed at `agent-session-services.js:69-81` (CLI, before `--model` resolution) or `runner.js:184-203` (`bindCore`)
- compat `registerApiProvider` (`compat.js:62-71`) — process-global; last closure registered wins
- Extension factory re-execution per session replacement (`agent-session-runtime.js:126-243` → `loader.js:346`) — the closure-per-instance model that makes capture state per-session

## Architecture Insights

- The capture contract as designed cannot hold: no pi event reliably precedes a custom provider's `streamSimple`. Events that do precede it (`session_start`) are delivered only by `bindExtensions`, which several paths skip or delay. A fix must resolve the registry at guard time from a source that does not depend on event delivery, or pi must provide a pre-dispatch hook. Both need verification against the `ExtensionAPI` surface — see Open Questions.
- Provider registration is process-global but capture state is per-closure. These two lifetimes disagree after any factory re-execution. That disagreement is the structural root of the recurrence.
- The repo's pattern across three commits is local suppression of ctx-lifecycle defects: delete capture points (`2b8e6862`), swallow the throw (`f67a7850`), reword the guard (`4ae87431`). The review's own protocol anticipated this: prove the invariant with an observable test, do not assert it in a comment.
- `assertActive` guards ctx getters per-runner (`runner.js:329-333`), but the objects the getters hand out (the registry) escape invalidation. Staleness is observable only at the getter, never at the captured value.

## Precedents & Lessons

6 relevant commits analyzed.

### Precedent: original single-capture design
**Commit(s)**: `bf82d348` — "Implement router pinning, widget, and debug improvements" (2026-03-18)
**Blast radius**: 6 files, 1 layer (`extensions/index.ts` monolith + docs/config)

**Lessons**: guard + capture-once-from-`session_start` design dates from here.

### Precedent: modularization split producer from consumer
**Commit(s)**: `90667cc1` (2026-03-19), follow-up `7e3a9fe4` (2026-03-20)
**Blast radius**: 14 files; guard moved to `provider.ts`, capture stayed in `index.ts`

### Precedent: capture points deleted on an untested assumption
**Commit(s)**: `2b8e6862` — "Update to pi 0.65.0, remove deprecated session_switch/session_fork handlers" (2026-04-03)
**Blast radius**: `extensions/index.ts` (−8)

**Lessons**: commit message assumed `session_start` covers all lifecycle events. It does not cover streams that precede it.

### Precedent: tests froze the buggy contract
**Commit(s)**: `65140186` (2026-06-08), `9d431f3b` (2026-06-23)
**Blast radius**: test suite; asserted the old error text and failure-path persistence

### Precedent: first stale-ctx fix was symptomatic
**Commit(s)**: `f67a7850` — "fix: guard persistState against stale ctx after session reload" (2026-07-23)
**Blast radius**: `extensions/index.ts` (+9/−2)

**Lessons**: bare `try {} catch {}` suppressed the crash recorded in `.rpiv/workflows/runs/2026-07-23_06-42-23-5831.jsonl`; the long-lived-capture defect stayed.

### Precedent: Phase 1 of the review (the refuted fix)
**Commit(s)**: `4ae87431` — "fix: refresh runtime captures on every event and hoist provider registry guard" (2026-08-29) — HEAD, unpushed, no follow-up
**Blast radius**: 4 files (+124/−14): `extensions/index.ts`, `extensions/provider.ts`, both test files

**Follow-up fixes**: none in git. Field refutation: `.rpiv/workflows/runs/2026-08-30_08-33-21-99c1.jsonl` records the new wording ~8h after the commit.

**Lessons from docs**:
- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — Phase 1 risk callout demanded a regression test (`streamSimple` succeeds when `before_provider_request` fired but `session_start` did not). It was never written. Cross-phase risk #1 says: if the incident recurs, re-open L0-01 diagnostics before Phase 2. The recurrence condition has now fired.

**Takeaway**: every fix in this chain asserted an invariant in prose that no test or instrumentation observed. The anchor claim was checkable against installed pi internals and is contradicted by them.

### Composite Lessons

- Three consecutive local suppressions (`2b8e6862`, `f67a7850`, `4ae87431`) of one structural defect: provider lifetime is process-global, capture lifetime is per-closure-instance. State the next invariant as an observable, tested condition.
- `before_provider_request` fires from `onPayload` inside the delegated downstream request (`sdk.js:200`, `pi-agent-core/dist/agent.js:284`, pi-ai `api/*.js`). Treat it as an intra-request hook, never a pre-dispatch one, for custom providers.
- The empty catch in `captureCtx` (`extensions/index.ts:75-78`) repeats the `f67a7850` blind-swallow pattern and hides "stale ctx forever" from all observability.
- Phase 2-4 of the review are gated on Phase 1 being proven. It is refuted. Land a corrected Phase 1 as its own commit before starting Phase 2.

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — the review whose Phase 1 landed as `4ae87431`
- `.rpiv/artifacts/plans/2026-07-21_19-27-12_classifier-routing-accuracy.md` — unrelated classifier-accuracy plan (no implementation plan exists for Phase 1)
- `.rpiv/artifacts/research/` — two classifier-accuracy research docs, tangential here

## Developer Context

**Q (`extensions/provider.ts:290-303`): Where was the error observed — which surface?**
A: Parent TUI session. Reproducible with a workflow that spawns parallel subagents. This points away from a clean child-startup race (print mode awaits `bindExtensions` before the first prompt) and toward the in-process windows: api-map aliasing across factory re-executions, in-turn replacement, or an in-process subagent path that never calls `bindExtensions`.

**Q (`extensions/provider.test.ts:788-813`): Can it be reproduced on demand?**
A: Yes — with parallel subagents. No deterministic in-repo repro exists yet; the review-mandated regression test was never written.

**Q (`extensions/index.ts:521-529`): What fix direction?**
A: Structural fix at guard time plus a deterministic regression test (real `ExtensionRunner`, `bindCore` flush, `session_start` omitted) plus the diagnostic logging the review's L0-01 callout already mandates. Diagnose-only and upstream-only were considered and rejected as the sole path; an upstream pi issue remains an optional parallel action.

## Related Research

- None in `.rpiv/artifacts/research/` cover provider lifecycle. This doc supersedes the root-cause section of the 2026-08-29 architecture review for the T1-ctx-lifecycle thread.

## Open Questions

- Does pi's built-in Agent tool create in-process subagent sessions that re-execute extension factories and overwrite the compat api map in the parent process? This is the leading candidate for the observed parent-TUI surface and is not yet verified.
- Does the `ExtensionAPI` object expose any live registry or model accessor that `streamSimple` can read at guard time (so the extension can self-heal without an event)? Not surveyed yet.
- Which concrete window fired in the field — api-map aliasing, in-turn replacement, reload-without-bindings, compaction-as-first-call, or partial factory load? The planned guard-path diagnostic entry (mode, pid, argv, elapsed-since-load, capture provenance) answers this.
- Will upstream pi accept a pre-dispatch hook for custom providers, or pass a ctx into provider `streamSimple`? Determines whether the local fix is a workaround or permanent.
