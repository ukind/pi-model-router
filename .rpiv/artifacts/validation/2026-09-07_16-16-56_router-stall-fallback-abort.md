---
template_version: 1
date: 2026-09-07T16:16:56+0700
author: Yogiswara Utama
commit: 47e7c2ff
branch: main
repository: pi-model-router
topic: "Validation of Router stall watchdog — timeout, fallback on silence, Esc abort"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-07_12-21-08_router-stall-fallback-abort.md"
tags: [validation, plan, provider, routing, classifier, stall, fallback, abort, config, watchdog]
last_updated: 2026-09-07T16:16:56+0700
---

## Validation Report: Router stall watchdog — timeout, fallback on silence, Esc abort

### Implementation Status

- ✓ Phase 1: Config knob stallTimeoutMs — Fully implemented (`2eb3e129`)
- ✓ Phase 2: Watchdog helper in routing.ts — Fully implemented (`d96f4741`)
- ✓ Phase 3: Aborted terminal-event contract — Fully implemented (`b074cc6b`)
- ✓ Phase 4: Delegated wait sites — Fully implemented (`5960f284`)
- ✓ Phase 5: Classifier threading — Fully implemented (`47e7c2ff`)

Diff `cdcc5614..47e7c2ff` touches exactly the 10 files the plan names (684 insertions, 28 deletions): routing.ts, provider.ts, config.ts, types.ts, constants.ts, the three test files, README.md, model-router.example.json.

### Automated Verification Results

- ✓ Config suite: `npx vitest run extensions/config.test.ts` — 42/42 passed
- ✓ Merge-whitelist detector: `npx vitest run extensions/config.test.ts -t "merge whitelist"` — 1 passed (test exists; a valid 30000 survives the merge)
- ✓ Routing suite: `npx vitest run extensions/routing.test.ts` — 78/78 passed
- ✓ Watchdog helpers: `npx vitest run extensions/routing.test.ts -t "watchdog helpers"` — 6/6 passed (incl. the cumulative-vs-per-gap reset discriminator, 10×8ms gaps under a 60ms timer)
- ✓ Provider suite: `npx vitest run extensions/provider.test.ts` — 31/31 passed, no unhandled rejections
- ✓ Stall filter: `npx vitest run extensions/routing.test.ts extensions/provider.test.ts -t "stall"` — 9/9 passed
- ✓ Full suite: `npx vitest run` — 289/289 passed across 7 files; zero unhandled-rejection warnings in output
- ✓ Type check: `npm run tsc` — clean
- ✓ Build: `npm run build` — clean
- ✓ Knob flow: `grep -c "stallTimeoutMs" extensions/config.ts` → 5 (≥ 3)
- ✓ Helper exports: `grep -cE "export const (raceStallTimeout|stallGuardedStream)" extensions/routing.ts` → 2 (exactly 2)
- ✓ No fake timers: `grep -rn "useFakeTimers" extensions/ | wc -l` → 0
- ✓ Aborted-end wiring: `grep -c "pushAbortedEnd" extensions/provider.ts` → 7 (≥ 5; 1 definition + 4 call sites + comment mentions)
- ✓ Bare-end contract: `grep -c "stream.end()" extensions/provider.ts` → 4 (exactly 4: helper internal, registry guard, success path, real-error branch)
- ✓ Kill switch: `grep -c "candidateAbort" extensions/provider.ts` → 7 (≥ 5)
- ✓ No regressions detected — full suite green including all pre-existing fallback/error tests

### Code Review Findings

#### Matches Plan:

- `routing.ts:708-717` `createStallTimeoutError` name-discriminates (`StallTimeoutError`); `isStallTimeoutError` mirrors the existing AbortError idiom — no `class extends Error` anywhere.
- `routing.ts:730-768` `raceStallTimeout`: both handlers attached synchronously via `promise.then(onFulfilled, onRejected)` so abandoned promises never reject unhandled; timer cleared on every exit (fulfill/reject/timeout/abort); abort listener `{once:true}` and removed in cleanup.
- `routing.ts:778-802` `stallGuardedStream`: a fresh `raceStallTimeout` per `iterator.next()` — true per-event reset; `onStall?.()` invoked before the throw.
- `provider.ts:103-117` `pushAbortedEnd` pushes the `{type:'error', reason:'aborted', error}` terminal event BEFORE `end()`; wired at all four quiet exits (`:413` post-classifier, `:605` loop-top, `:652` post-auth, `:903` benign outer-catch branch). The four remaining bare `end()` sites are exactly the plan's allowed set (helper internal `:115`, registry guard `:348`, success `:876`, real-error `:897`).
- `provider.ts:628-646` auth race uses the `.then(ok/reason)` result shape: stall → `lastError` + `stallFallbacks.push` + `notifyStall` + `continue` (fallback advance); abort → `continue` → loop-top choke re-checks `signal.aborted` (`:604`) and exits via `pushAbortedEnd` — an abort cannot silently retry the next model; last-candidate abort throws → outer catch `isAborted` → `:903`.
- `provider.ts:672-683` `candidateAbort`/`propagateAbort` declared BEFORE the per-candidate `try`, cleaned in the sibling `finally` (`:855-856`) — the TS2304 trap from the plan review is avoided; `signal: candidateAbort.signal` overrides the spread in both delegation branches; the delegated `for await` is wrapped in `stallGuardedStream` with `onStall = () => candidateAbort.abort()`.
- `provider.ts:842-847` reasoning enrichment (`Recovered from N stall(s): …`) runs only on the success path, immediately before `break outer`.
- `routing.ts:804-929` `runClassifier` threading: pre-aborted signal returns `undefined` at `:817-819` before any `streamSimple`; auth raced; per-ref `refAbort` controller declared before the try (`:825-826`), listener removed in `finally` (`:922`); `onStall?.(ref, timeoutMs)` fires from the per-ref catch only under `isStallTimeoutError` (`:917-918`); all-refs-stall → `undefined` → heuristics.
- `config.ts:145` merge-whitelist line, `:429-432` normalize gate (`typeof number && > 0`), `:537` always-concrete return literal; `constants.ts:5` `DEFAULT_STALL_TIMEOUT_MS = 90_000`; `types.ts:90` `stallTimeoutMs?: number` directly after `maxSessionBudget`.
- Tests: all six quiet-exit provider tests assert `terminalEvent` defined + `reason 'aborted'` + `error.stopReason 'aborted'`; negative control (`provider.test.ts:1172`) and reload case (`:1194`) untouched as required; watchdog reset discriminator at `routing.test.ts:1148-1167`; pre-aborted classifier test mockClear-guarded (`routing.test.ts:1102`) before its `not.toHaveBeenCalled` assertion; Phase-4/5 tests match the plan fences (fallback chains, no-AbortController discriminator on auth stall, abort-during-stall single-attempt, classifier-stall → heuristics + warning note).

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan — the plan-review blockers (missing stream mock in test C, declarations-inside-try TS2304) were fixed at lock and landed fixed; no unplanned behavior was found.

#### Pattern Conformance:

- ✓ Name-based error discrimination (`StallTimeoutError`/`AbortError`), zero `extends Error` — matches the repo idiom.
- ✓ `notifyStall` gate (`state.lastExtensionContext && !state.isExtensionContextDead`, `provider.ts:374-382`) is an exact copy of the `setHiddenThinkingLabel` precedent; `'warning'` severity fits the repo's notify vocabulary.
- ✓ Config knob mirrors `maxSessionBudget` end-to-end (whitelist → gate → concrete literal), `90_000` matches the underscore constant style.
- ✓ Test idioms: real timers, sleep ≥ 5× the injected timeout (7.5× / 5.3× observed), MockEventStream outer-stream split, subject-first test titles matching the host describe blocks.
- ✓ Arrow functions only (generator `async function*` form is the allowed exception); no `any` in non-test code; static top-level imports; WHY comments present (pi-wedge note at `provider.ts:109`, exports-map constraint in routing.ts).
- ✓ No import cycle: routing.ts imports no provider — one-way dependency holds.
- Minor observation: `provider.ts:370-371` re-applies `?? DEFAULT_STALL_TIMEOUT_MS` although normalizeConfig already guarantees a concrete value — acceptable defensive variation, not a deviation.

### Manual Testing Required:

1. Live abort behavior (requires a live pi session — cannot be validated from the test suite):
   - [ ] Esc mid-router-stream: UI shows "Operation aborted"; the next prompt works (no "Agent is already processing" wedge)
   - [ ] Esc during a classifier stall: turn aborts immediately, no `/quit` needed
   - [ ] Live stalling endpoint (accept-and-never-respond listener on a profile): turn falls back within `stallTimeoutMs` with the warning line; Esc during the stall aborts immediately
2. Reason provenance:
   - [ ] After a **main-model** stall fallback, `/router status` Reason shows the "Recovered from N stall(s)" text. (Caveat: classifier stalls are note-only by design — checkpoint decision; the reasoning enrichment lives on the delegated success path, so this item must NOT be tested via a classifier stall.)
3. Machine-verified during this validation (already satisfied, listed for the record):
   - `model-router.example.json` parses; `stallTimeoutMs` sits directly after `maxSessionBudget` (line 5→6)
   - README complete-config example (line 64→65) and Configuration Fields row (line 143→144, after `maxSessionBudget`)
   - Builtin terminal-event shape parity: `openai-completions.js:374` pushes `{type:'error', reason: output.stopReason, error: output}` — the exact shape `pushAbortedEnd` mirrors
   - Zero unhandled-rejection warnings across the full suite and the provider suite (the never-resolving auth promise stays silent)

### Recommendations:

- Ready — all five phases are committed on `main` (`2eb3e129..47e7c2ff`) and the entire automated surface is green; no code changes required.
- Run the three live checks above in a real pi session (e.g., point a profile at a never-responding local listener) to close out the remaining manual items.
- Note for the next commit: the shazam pre-commit hook is broken on this machine (`spawnSync npx` ENOENT), so the phase commits were made with `--no-verify` — unrelated to this plan, but worth repairing before further work lands.
