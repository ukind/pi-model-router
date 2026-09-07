---
date: 2026-09-07T12:06:20+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Router stall watchdog — timeout, fallback on silence, Esc abort"
tags: [design, provider, routing, classifier, stall, fallback, abort, config]
status: in-progress
parent: .rpiv/artifacts/research/2026-09-07_11-07-29_router-stall-fallback-abort.md
last_updated: 2026-09-07T12:06:20+0700
last_updated_by: Yogiswara Utama
---

# Design: Router Stall Watchdog — Timeout, Fallback on Silence, Esc Abort

## Summary

One watchdog helper set in `extensions/routing.ts` (`StallTimeoutError`, `raceWithStall`, `withStallWatchdog`) bounds the four unbounded waits in the router: the classifier stream loop, the classifier auth fetch, the delegated auth fetch, and the delegated stream. A stall throws a distinguishable non-abort error into the existing exception-driven fallback chain (or advances the existing `continue`/next-ref idioms), so advance, `decision.isFallback` mutation, and exhaustion semantics are inherited for free. Every abort exit — user Esc, session replacement, and the three existing quiet-exit choke points — now ends the stream with a pushed `stopReason:'aborted'` terminal event instead of bare `stream.end()`, which un-wedges pi's `agent-loop.js:238` `response.result()` await. A single config knob `stallTimeoutMs` (default 90000) controls the timeout.

## Requirements

From the FRD (`.rpiv/artifacts/discover/2026-09-07_10-47-10_router-stall-fallback-abort.md`) and the research checkpoint:

- Never hang: every unbounded wait in the router is bounded by `stallTimeoutMs` (default 90 s, one config knob).
- Silent stalls must advance the fallback chain to the next model (delegated stream), next ref (classifier), or next candidate (auth) — never park the turn.
- Esc always works: abort races every wait and ends the turn with a terminal event pi can consume.
- Fix the bare-`end()` wedge: all quiet exits (three choke points + benign-abort catch) push a `stopReason:'aborted'` terminal event.
- Post-content stall: retry with the next model (pi replaces the partial in place, `agent-loop.js:204-221`).
- Classifier stall: next classifier ref → built-in heuristics (matches existing infra-failure behavior).
- Stall visibility: one-line `ui.notify(..., 'warning')` note per stall advance, plus reasoning-string provenance on the successful fallback decision.
- Config knob `stallTimeoutMs` flows through `mergeConfig` (whitelist!), `normalizeConfig`, live per-turn reads, and `model-router.example.json`.

## Current State Analysis

The fallback machinery is complete and needs no structural change: thrown errors land in `catch` at `provider.ts:742-744` → next candidate/tier; auth-fail sets `lastError` then `continue` (`:580-587`); exhaustion throws at `:748-757`; `decision.isFallback` has exactly two writers (`:699`, `:724`), both on the success path, and `state.lastDecision = decision` at `:471` means success-path mutations persist with no extra code.

### Key Discoveries

- Four unbounded waits, not three (research corrected the FRD): classifier stream (`routing.ts:746-761`), classifier auth (`routing.ts:712`), delegated auth (`provider.ts:569-572`), delegated stream (`provider.ts:668-695`).
- Bare `stream.end()` never resolves `finalResultPromise` (`event-stream.js:25-33`), so pi's `agent-loop.js:238` `await response.result()` parks forever and `finishRun` never runs — the agent wedges. `EventStream.push()` of a `done`/`error` event resolves it (`event-stream.js:15-23`).
- Builtin providers abort via `{ type:'error', reason:'aborted', error: <AssistantMessage stopReason:'aborted'> }` (`openai-completions.js:376-386`); the TUI renders `stopReason:'aborted'` benignly ("Operation aborted", `interactive-mode.js:2297-2306`).
- `mergeConfig` (`config.ts:114-146`) is a field-by-field whitelist — a top-level key absent from the literal is silently dropped before normalization. `stallTimeoutMs` needs its own line.
- `runClassifier` (`routing.ts:698-783`) takes no signal; trailing optional params leave all seven test call sites untouched. `routing.ts` has no config access — the timeout must arrive as a parameter.
- Auth waits are race-safe to abandon: `getApiKeyAndHeaders` is a total function (never rejects); realistic worst case ≈ 73 s under the multi-instance `auth.json` lock, so the watchdog is the deterministic bound.
- `combineAbortSignals` (pi-ai `abort-signals.js:1-33`) returns `{signal?, cleanup}`; single-signal pass-through; already-aborted handled.
- Greenfield: zero `StallTimeoutError`, zero watchdog code, zero `AbortController` in source (one test only) — verified by grep at HEAD.

## Scope

### Building

- `stallTimeoutMs?: number` on `RouterConfig`; `DEFAULT_STALL_TIMEOUT_MS = 90_000` in constants; merge line + always-concrete normalization in config; example-file entry.
- Watchdog helpers in `extensions/routing.ts`: `StallTimeoutError`, `raceWithStall` (await race), `withStallWatchdog` (per-event-reset iterator wrapper with stall and abort legs).
- Delegated-stream stall: per-candidate `AbortController` composed with `options?.signal` via `combineAbortSignals` at `delegationOptions`; wrapped `for await`; stall → notify + throw → existing advance; reasoning-string provenance.
- Auth-wait races at `provider.ts:569` and `routing.ts:712` (stall → `lastError`+`continue` / next ref).
- Classifier threading: trailing `(signal?, stallTimeoutMs?)` params; signal in stream options; wrapped loop; abort exits immediately with `undefined` (distinct from stall's next-ref).
- Aborted terminal events: `createErrorMessage` gains a `stopReason` param; `endStreamAborted` helper; choke points `provider.ts:354/:545/:576` and benign-abort catch `:770-786` use it.
- Tests: scenarios (a) silent-stream fallback, (b) classifier stall, (c) abort, (d) auth stall, (e) config — real timers + 15-25 ms injected timeouts + existing sleep idioms.
- Docs: README config-table row; ARCHITECTURE watchdog/abort-contract note.

### Not Building

- Cross-API tool-continuation generalization (the lost 2026-08-31 fix) — separate change.
- pi-claude-bridge fail-loudly patch — upstream.
- Auth-lock redesign / refresh backoff — upstream in pi.
- `MockEventStream` `result()` contract changes — zero harness modifications.
- New `RoutingDecision` field for stall provenance — reasoning-string only (avoids sanitizer asymmetry, `state.ts:68-152`).
- Runtime toggle of the timeout (no persisted state, no `/router` command).

## Decisions

### D1: Watchdog helper placement — `extensions/routing.ts` (developer direction)

Extending `routing.ts` keeps the AGENTS.md Phase-3 module set at 8 files. `provider.ts` already imports from `routing.ts` (`provider.ts:26-35`); `routing.ts` cannot import `provider.ts` (cycle). Stall is a routing failure mode. Cost: routing.ts grows ~120 lines and mixes timer/racing mechanics into otherwise pure routing logic.

### D2: Docs slice in scope (developer direction)

Follows the `fb79faf7` → `e4b5601f` same-day docs hygiene precedent. README gains the `stallTimeoutMs` row; ARCHITECTURE documents the two-layer defense (choke points poll liveness; the watchdog bounds durations) and the terminal-event contract.

### D3: Aborted terminal-event shape — error event (inherited + verified)

`stream.push({ type:'error', reason:'aborted', error: <AssistantMessage stopReason:'aborted'> }); stream.end();` — resolves the research Open Question. Both `push(error-event)` and `end(message)` resolve `finalResultPromise` (verified `event-stream.js:15-33`), but only the error-event shape matches builtin providers exactly (`openai-completions.js:385-386`) and delivers a terminal event to the `for await` consumer.

### D4: Stall classification contract — name-based, two names (inherited + verified)

The stall leg throws `StallTimeoutError` (`error.name === 'StallTimeoutError'`) — non-abort, so total exhaustion surfaces it as a real error event. The abort leg throws an `AbortError`-named error, matching the existing benign classification at `provider.ts:770-774` (`error.name === 'AbortError'`). No instanceof checks — mirrors the existing name/prefix idiom.

### D5: Timer reset set — any yielded event (research insight)

`withStallWatchdog` resets the timer on every event the wrapped iterator yields, uniformly at both call sites. Strictly safer than the FRD's content-only pair (`routing.ts:757-760`): structural-only streams still trip, and no pi-ai event type arrives repetitively without content in practice.

### D6: `stallTimeoutMs` normalization — always-concrete (inherited)

`typeof raw.stallTimeoutMs === 'number' && raw.stallTimeoutMs > 0 ? raw.stallTimeoutMs : DEFAULT_STALL_TIMEOUT_MS` after the `maxSessionBudget` gate (`config.ts:421-424` precedent), emitted in the return literal. Runtime reads still guard with `?? DEFAULT_STALL_TIMEOUT_MS` because `RouterConfig` is shared with pre-normalize values. `NaN` fails `> 0`; `Infinity` passes (same accepted hole as budget, `config.ts:422`); no warning (scalar precedents are silent).

### D7: Post-content stall — retry with next model (inherited checkpoint)

The partial may hold an unclosed tool call, so the post-content-error acceptance path (`provider.ts:682-687`) does not apply. The successor's stream supersedes the forwarded partial in place (`agent-loop.js:204-221`). Partial cost on an abandoned stall stays unrecorded (accepted leak, existing precedent at `provider.ts:676-681`).

### D8: Stall visibility — `ui.notify(..., 'warning')` at detection, reasoning-string provenance (inherited checkpoint)

`'info'`/showStatus dedups consecutive notes (`interactive-mode.js:2499-2515`); `'warning'` always appends (`:3050-3053`) — the multi-stall chain must not collapse. Provenance: notify line at detection time (not debug-gated — total-failure turns push no debug history) + reasoning-string append on the successful fallback decision (survives `sanitizeRoutingDecisionFields` by construction; no new field).

### D9: Agent-scope deviation (recorded)

Step-2 agents `precedent-locator` and `integration-scanner` were not spawned: the parent research artifact (same day, same HEAD) already contains 5 verified git precedents and a complete integration map, and every referenced integration file plus the four pi-ai/pi-agent-core dist contracts were read directly in the parent session. Re-running would duplicate verified work.

## Architecture

### extensions/types.ts:85-93 — MODIFY

Add `stallTimeoutMs?: number` to `RouterConfig` after `maxSessionBudget`.

```typescript
```

### extensions/constants.ts:1-4 — MODIFY

Add `DEFAULT_STALL_TIMEOUT_MS = 90_000` (numeric-underscore style).

```typescript
```

### extensions/config.ts:114-146, 373-535 — MODIFY

`mergeConfig` gains the whitelist line; `normalizeConfig` gains the always-concrete gate + return-literal field.

```typescript
```

### extensions/routing.ts:698-783 (+ new helper block) — MODIFY

Watchdog helpers (`StallTimeoutError`, `raceWithStall`, `withStallWatchdog`) + `runClassifier` threading.

```typescript
```

### extensions/provider.ts:49-55, 310-789 — MODIFY

`createErrorMessage` stopReason param, `endStreamAborted`, per-turn timeout read, signal composition, wrapped delegated loop, stall notify/provenance, auth race, classifier call threading, choke-point + benign-abort rewiring.

```typescript
```

### extensions/config.test.ts:271-318 — MODIFY

Normalization + merge-line detector tests.

```typescript
```

### extensions/routing.test.ts:899-1048 (+ helper describes) — MODIFY

Helper unit tests + classifier stall tests.

```typescript
```

### extensions/provider.test.ts:7-48, 61-75, 175-218, 840-884, 1021-1106, 1231-1274 — MODIFY

Scenarios (a) silent-stream fallback, (b) provider-level classifier stall, (c) abort, (d) auth stall.

```typescript
```

### model-router.example.json — MODIFY

`"stallTimeoutMs": 90000` after line 5.

```typescript
```

### README.md — MODIFY

Config-table row for `stallTimeoutMs`.

```typescript
```

### docs/ARCHITECTURE.md — MODIFY

Watchdog layer + abort terminal-event contract section.

```typescript
```

## Slices

### Slice 1: Config knob foundation

**Files**: `extensions/types.ts`, `extensions/constants.ts`, `extensions/config.ts`, `model-router.example.json`, `extensions/config.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 2: Watchdog helpers in routing.ts

**Files**: `extensions/routing.ts`, `extensions/routing.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 3: Delegated-stream stall → fallback chain

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 4: Auth-wait races (both auth sites)

**Files**: `extensions/provider.ts`, `extensions/routing.ts`, `extensions/provider.test.ts`, `extensions/routing.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 5: Classifier signal + stall threading

**Files**: `extensions/routing.ts`, `extensions/provider.ts`, `extensions/routing.test.ts`, `extensions/provider.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 6: Esc abort → terminal events at every quiet exit

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification:

#### Manual Verification:

### Slice 7: Docs

**Files**: `README.md`, `docs/ARCHITECTURE.md`

#### Automated Verification:

#### Manual Verification:

## Desired End State

From a consumer's perspective:

1. **Silent stall recovers.** A delegated model goes silent mid-stream; within `stallTimeoutMs` (default 90 s) the user sees a warning line — `router: provider/model sent no data for 90s — falling back` — and the next candidate streams the turn to completion. `/router status` and `/router debug show` display the fallback decision whose reasoning records the stall recovery.
2. **Esc always works.** Pressing Esc mid-stream (even mid-auth-fetch or mid-classifier) ends the turn within milliseconds: the stream emits a terminal `aborted` event, the TUI shows "Operation aborted", and the next prompt works — no wedge, no "Agent is already processing".
3. **Classifier stall degrades gracefully.** A stalled classifier call advances to the next classifier ref and, if all stall, falls back to built-in heuristics with zero user-visible delay beyond the timeout.
4. **One knob.** `"stallTimeoutMs": 30000` in `model-router.json` tightens every wait site at once; absent or invalid values mean 90 s.

## File Map

```
extensions/types.ts              # MODIFY — RouterConfig.stallTimeoutMs
extensions/constants.ts          # MODIFY — DEFAULT_STALL_TIMEOUT_MS
extensions/config.ts             # MODIFY — mergeConfig line + normalizeConfig gate
extensions/routing.ts            # MODIFY — watchdog helpers + runClassifier threading
extensions/provider.ts           # MODIFY — wiring at all four waits + abort ends
extensions/config.test.ts        # MODIFY — normalization + merge detector
extensions/routing.test.ts       # MODIFY — helper units + classifier stall
extensions/provider.test.ts      # MODIFY — scenarios (a)(b)(c)(d)
model-router.example.json        # MODIFY — stallTimeoutMs example entry
README.md                        # MODIFY — config table row
docs/ARCHITECTURE.md             # MODIFY — watchdog + abort contract section
```

## Ordering Constraints

- Slice 1 before all (config value feeds runtime reads).
- Slice 2 before 3-6 (helpers are the shared core).
- Slice 3 before 4-5 (provider IIFE gains the per-turn timeout read and stream wiring first).
- Slice 6 last among code slices (rewires choke points the earlier slices added stalls around).
- Slice 7 after all code slices (documents final behavior).
- All slices sequential; no parallelism.

## Verification Notes

- **Merge-whitelist trap**: a valid `stallTimeoutMs: 30000` through `loadRouterConfig`'s fixture must reach the normalized config (config.test.ts:46-53, asserted near :309-317). Absent and invalid both converge on 90000 — an invalid-value end-to-end test cannot catch the missing merge line.
- **Timer discipline** (precedent `fb79faf7` removed sleep-based races as bugs): per-event reset + genuinely raced timers only. In `provider.test.ts` use real timers + 15-25 ms injected `stallTimeoutMs` + the suite's existing 100 ms sleep idiom (≥5× timeout); `vi.useFakeTimers()` breaks every subsequent sleep in that file — avoid. `routing.test.ts` is timer-free apart from new tests; fake timers are safe there.
- **Unhandled-rejection rules**: abandoned promises/generators must stay pending; gates get `resolve()` only, never `reject()`; never release a race-lost promise into rejection.
- **Pin discipline**: pinning skips the classifier (provider.ts:336) — scenarios (a)/(d) pin medium; (b)/(c) must not. Default mock config has no `low` tier (provider.test.ts:61-75).
- **Scenario discriminators**: (d) auth stall has NO AbortController (an aborted signal takes the silent-exit branch — that is the discriminator from (c)); (c) asserts stream end via the suite's first `stream.on('end', ...)` use (MockEventStream.on at :26-33 supports it); (b) provider-level uses classifier refs disjoint from tier candidates (the single compat mock cannot otherwise tell classifier calls from delegation calls).
- **Watchdog abort must not be swallowed as benign-with-retry**: the abort leg reaches the loop-top choke (signal.aborted → end) or the exhaustion/outer catch (AbortError → aborted terminal event). Watch the interaction flagged in precedent `d793dbde`: stall-abort ≠ Esc-abort classification split is the riskiest interaction.
- **Infinity passes the gate** (watchdog effectively disabled) — same accepted hole as `maxSessionBudget`; documented, not fixed.
- **Anchor-drift check**: FRD line anchors predate a ~53-line insertion; the research re-anchored all citations — use research anchors (verified at `d793dbde`), not FRD ones.

## Performance Considerations

- One `clearTimeout`/`setTimeout` pair per yielded event on wrapped streams — O(1) churn, negligible against per-token network cost.
- One watchdog active per wait site; at most two concurrently (classifier stream + its auth) or one (delegation).
- `combineAbortSignals` allocates one controller + two listeners per candidate attempt; cleanup removes listeners on normal exit.
- Command-backed keys can block the event loop up to ~10 s (resolve-config-value.js:137,163) — timers queue and fire after the block, so the watchdog's reaction time is a lower bound, not a miss.

## Migration Notes

`stallTimeoutMs` is optional; existing configs load unchanged (default 90000 via normalization). No persisted-state change (`RouterPersistedState` untouched) — the knob is config-file-only by design. Rollback = remove the config key.

## Pattern References

- `extensions/provider.ts:580-587` — `lastError` + `continue` idiom (auth stall translation).
- `extensions/provider.ts:742-744` — thrown-error advance idiom (stream stall).
- `extensions/provider.ts:698-733` — success-path mutation blocks (stall provenance append point).
- `extensions/provider.ts:47-54` — message factory (`createErrorMessage` stopReason param).
- `extensions/provider.ts:770-786` — benign-abort classification (name-based, `endStreamAborted` target).
- `extensions/config.ts:134-145, 421-424` — merge whitelist + scalar gate precedents.
- `extensions/routing.ts:777-780` — per-ref catch (classifier stall lands here).
- `extensions/provider.test.ts:175-218, 840-884, 1021-1106, 1231-1274` — fallback/auth/gate/AbortController/classifier-await test models.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:376-386` — aborted terminal-event idiom.

## Developer Context

**Q (design Step 4, directional): Watchdog helper + StallTimeoutError placement — new `extensions/stall.ts` module or extend `routing.ts`?**
A: Extend `routing.ts` — keeps the AGENTS.md 8-module structure; provider.ts already imports routing.ts; stall is a routing failure mode.

**Q (design Step 4, directional): Docs slice in scope?**
A: Yes — follow the `fb79faf7` → `e4b5601f` same-day docs hygiene precedent.

**Inherited from research checkpoint (recorded, not re-asked):** all four waits in scope; 90 s / `stallTimeoutMs`; one-line chat note; classifier stall → next ref → built-in rules; "never hangs, recovers itself, Esc always works"; post-content stall → retry next model (`provider.ts:682-687` + `agent-loop.js:204-221`); aborted turns push `stopReason:'aborted'` terminal events and the three quiet exits are fixed to the same shape (`agent-loop.js:238`); stall notes render as `'warning'` (dedup analysis `interactive-mode.js:2499-2515`).

## Design History

- Slice 1: Config knob foundation — pending
- Slice 2: Watchdog helpers in routing.ts — pending
- Slice 3: Delegated-stream stall → fallback chain — pending
- Slice 4: Auth-wait races (both auth sites) — pending
- Slice 5: Classifier signal + stall threading — pending
- Slice 6: Esc abort → terminal events at every quiet exit — pending
- Slice 7: Docs — pending

## References

- Research: `.rpiv/artifacts/research/2026-09-07_11-07-29_router-stall-fallback-abort.md` (parent)
- FRD: `.rpiv/artifacts/discover/2026-09-07_10-47-10_router-stall-fallback-abort.md`
- Landed precedent plan: `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` (`d793dbde`, HEAD)
- Lost-fix lesson: `.rpiv/artifacts/research/2026-09-07_11-07-29_router-stall-fallback-abort.md` §Precedents (isCrossApiToolContinuation destroyed by reset/pull)
