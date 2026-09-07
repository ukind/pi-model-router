---
date: 2026-09-07T11:07:29+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Router stall watchdog — timeout, fallback on silence, Esc abort"
tags: [research, provider, routing, classifier, stall, fallback, abort, config]
status: ready
last_updated: 2026-09-07T11:07:29+0700
last_updated_by: Yogiswara Utama
---

# Research: Router stall watchdog — timeout, fallback on silence, Esc abort

## Research Question

Chained from `.rpiv/artifacts/discover/2026-09-07_10-47-10_router-stall-fallback-abort.md`. One shared inactivity-watchdog helper (timer reset per stream event, `Promise.race` against timeout and abort) reused at the per-turn wait sites in the router extension: the classifier stream loop in `extensions/routing.ts`, the delegated-stream `for await` in `extensions/provider.ts` (stall → throw → existing fallback chain), and the auth-fetch await. Thread `options.signal` into `runClassifier`; stall fallbacks push a one-line custom message and enrich decision reasoning/debug history; config gains a single `stallTimeoutMs` knob (default 90000) in `config.ts` normalization. Verified at HEAD `d793dbde`; `stallTimeoutMs` and any watchdog code are greenfield (zero matches in `extensions/`).

## Summary

The defect is real and worse than the FRD states: there are **four** unbounded waits (classifier stream, classifier auth fetch, delegated auth fetch, delegated stream — the FRD listed three), and a fifth platform-level wedge the FRD did not know about: **any quiet stream termination (`stream.end()` without a terminal event) parks pi's agent loop forever** (`agent-loop.js:238` awaits `response.result()`, which bare `end()` never resolves), leaving the run marked streaming — a second, independent reason Esc "feels dead". The fallback machinery itself is complete and needs no changes: a watchdog that throws a distinguishable non-abort error from inside the per-candidate `try` (provider.ts:591) inherits advance, `decision.isFallback` mutation, and exit semantics for free; the classifier needs zero advance code (its catch at routing.ts:777-780 already converts any failure into next-ref → `undefined` → heuristics). The auth wait is safe to race (`getApiKeyAndHeaders` is a total function that never rejects) and is internally bounded at ~73 s worst case, not infinite — the watchdog there is defense, not the primary bound. Three design decisions were resolved at the developer checkpoint: post-content stall retries with the next model; Esc-aborted turns end with a pushed `stopReason:'aborted'` terminal event (also fixing the three existing quiet-exit points); stall notes render as `ui.notify(..., 'warning')` lines. Two implementation traps were found: `mergeConfig` is a field-by-field whitelist that silently drops unknown top-level keys (config.ts:134-145), and the test harness's `MockEventStream` has no `result()` contract, so no existing test can catch the bare-`end()` wedge class.

## Detailed Findings

### Anchor drift — FRD citations vs. verified current source

The FRD (and the 2026-09-03 graph index) predate a ~53-line insertion (image promotion + Google-continuation prepend). All FRD conclusions survive renumbering. Verified corrections used throughout this document:

| FRD/scope-tracer claim | Verified at `d793dbde` |
|---|---|
| delegated `for await` provider.ts:721 | `extensions/provider.ts:668` |
| `isContent` set :731-736 | `extensions/provider.ts:688-692` |
| fallback loop :625 | outer loop `extensions/provider.ts:495`; inner `:541`; catch `:742-744` |
| auth await ~507 | `extensions/provider.ts:569-572`; auth-fail continue `:580-587` |
| cross-tier mutation :711-722 | `extensions/provider.ts:698-716` |
| in-tier mutation :723-737 | `extensions/provider.ts:717-733` |
| exhaustion throw :774-781 | `extensions/provider.ts:748-757` |
| benign-abort :774-775 | checks `extensions/provider.ts:770-774`, suppression `:775-783` |
| classifier pair routing.ts:755-763 | `extensions/routing.ts:757-760`; `!contentReceived` continue `:763`; catch `:777-780` |
| `RoutingDecision` types.ts:76-113, reasoning :92 | `extensions/types.ts:95-119`, reasoning `:102` |
| `StreamOptions.signal` pi-ai types.d.ts:44-47 | `node_modules/@earendil-works/pi-ai/dist/types.d.ts:43` |
| `runClassifier` :698-783, `decideRouting` :286-634, classifier await provider.ts:341, chokes :354/:545/:576 | exact, unchanged |

### Wait-site inventory (four waits, not three)

`registerRouterProvider` (provider.ts:284) registers the `streamSimple` IIFE (async IIFE at :310-789). Its external waits:

1. **Classifier await** — `provider.ts:341-348` → `runClassifier` (routing.ts:698-783), which itself contains two more waits: the per-ref auth fetch (routing.ts:712) and the classifier stream open (routing.ts:746-750, **no signal** — the primary defect) consumed by `for await` at routing.ts:753-761.
2. **Delegated auth fetch** — `provider.ts:569-572` between choke :545-548 and post-await choke :576-579.
3. **Delegated stream** — `for await` at `provider.ts:668-695`.
4. **Classifier auth fetch** — `routing.ts:712-713` (unnamed in the FRD; same `getApiKeyAndHeaders` choke under the multi-instance `auth.json` lock scenario).

The existing choke points (:354, :545, :576) are liveness *polls* — they fire only when control reaches them; a stalled await never returns to them. The watchdog is their temporal complement.

### Candidate advance machinery — the minimal insertion points

All advance today is exception-driven or continue-driven: thrown errors land in `catch (err) { lastError = err; }` (provider.ts:742-744) → next candidate/tier; auth-fail and model-not-found set `lastError` then `continue` (:562-567, :580-587); tier skips push `skipReasons` (:497-500, :533-538, :553-556). Exhaustion throws the `skipReasons`/`lastError` error at :748-757, surfaced as an `error` event at :775-783 unless benign (:770-774). `decision.isFallback` has exactly two writers — :699 (cross-tier) and :724 (in-tier) — both on the success path; `buildRoutingDecision` never initializes it. `state.lastDecision = decision` happens at :471 before the loops, so success-path mutations update the persisted decision post-hoc with no extra code.

Consequences for the watchdog:

- **Delegated-stream stall**: throw a distinguishable non-abort error from inside the `try` at :591 (the stall throw originates in the wrapped iterator at :668) → :742-744 does all advance → if a later candidate succeeds, the mutation blocks :698-733 fire unchanged → `break outer` :741 → `recordDebugDecision` :763 → `stream.end()` :765. If all stall, exhaustion surfaces the last stall error exactly like today's total failure. A `break` (not throw) would be wrong: it falls through to `success = true` (:696) and falsely marks the stalled candidate successful.
- **Auth stall**: the await at :569-572 sits **outside** the :591 `try` — a raw throw skips `lastError` bookkeeping and kills the turn at the outer catch. The stall outcome must be translated into the :580-587 idiom (`lastError = stallError; continue;`); the abort outcome performs the choke idiom (end + return) since a hung auth starves the :576 choke. Same race shape at routing.ts:712, where the :777 catch already provides ref advance.
- **Classifier stall**: zero advance code — a stall throw inside the :753 loop lands in the per-ref catch (:777-780, `void error`) → next ref → exhaustion returns `undefined` (:782) → `decideRouting` heuristics. The loop-top abort check (new, before :706) keeps abort distinct: `return undefined` immediately so the caller's :354 choke ends the turn.

**Abort classification contract**: the outer catch classifies benign exits by error name/message only (:770-774 — `STALE_CTX_MESSAGE_PREFIX` prefix, defined at :49-50, or `error.name === 'AbortError'`). The watchdog's abort leg must produce an `AbortError`-named error (suppressed or caught at loop-top :545); its stall leg must be a distinct non-abort name (e.g. `StallTimeoutError`) so total exhaustion surfaces it as a real error event.

**Post-content stall (resolved)**: a stall after content cannot mimic the post-content-error path (:682-687 records partial usage and accepts the partial) because the partial may hold an unclosed tool call. Checkpoint decision: retry with the next model — pi's agent loop updates the partial message in place (`agent-loop.js:204-221`, `partialMessage = event.partial`), so the successor model's stream supersedes the forwarded partial rather than duplicating it in context.

### Signal threading into `runClassifier`

`runClassifier` (routing.ts:698-705) takes no signal. Trailing optional parameters (`signal?: AbortSignal`, `stallTimeoutMs?: number`) leave all seven test call sites (routing.test.ts:934-1040) untouched. The stream options at :746-750 gain `...(signal ? { signal } : {})`; the plumbing is verified end-to-end: compat forwards options verbatim (compat.js:170-175, `withEnvApiKey` at :140-146 only enriches `apiKey`) → openai-completions fetch options (openai-completions.js:111) / anthropic fetch + per-read check (anthropic-messages.js:351, :226-227). On abort mid-stream pi-ai emits an `error` event with `stopReason 'aborted'` (openai-completions.js:368,374), which the classifier loop already treats as pre-content error → next ref (routing.ts:754-756). The caller passes `options?.signal` at provider.ts:341-348 (in scope in the closure, used at :354). `routing.ts` has no config access at all (verified: zero `currentConfig` references) — the timeout value must arrive as a parameter, mirroring how `thinking` is threaded at :346.

### Auth wait semantics — race safety and real bounds

`ModelRegistry.getApiKeyAndHeaders` (pi-coding-agent/dist/core/model-registry.js:532-565) is a **total function**: any throw becomes `{ ok: false, error }` (:558-564). A `Promise.race` that abandons it leaves a promise that always resolves with no `.then` — no unhandled rejection, ever. The underlying chain: `AuthStorage.getApiKey` (auth-storage.js:374-426) → expired-oauth path takes a `proper-lockfile` lock on `~/.pi/auth.json` (retries 10 × backoff ≈ 42.7 s worst, stale 30 s — :90-103) → refresh POST internally bounded at 30 s for Anthropic (pi-ai oauth anthropic.js:151) → write-back inside the lock, release in `finally` (:115-124). **Correction to the FRD premise**: the realistic worst case is ≈ 73 s, not unbounded-forever; true infinity requires a provider refresh without internal timeout or a lock holder killed without release. The multi-instance correlation stands (N instances × (classifier + main) auth awaits on one `auth.json`), and the watchdog remains the deterministic bound. Caveats: command-backed keys and sync lock paths block the event loop up to ~10 s (resolve-config-value.js:137,163) — timers queue and fire after the block, so the watchdog still wins, but reaction time is a lower bound. **Abort has no cancellation surface here** — no API in the chain accepts a signal; abort is abandon-and-exit (the refresh finishes in the background under its own bounds).

### The platform terminal-event contract (critical finding — changes FRD req 4)

Verified mechanics:

- `EventStream.end(result)` resolves `finalResultPromise` **only if `result !== undefined`** (pi-ai event-stream.js:25-33); bare `end()` sets `done` and wakes consumers but leaves `result()` (:63-65) pending forever.
- pi's `callLLM` loop ends the `for await` on iterator-done, then unconditionally `await response.result()` (agent-loop.js:238; terminal `done`/`error` events short-circuit at :222-236 via `await response.result()` at :225).
- `Agent.runWithLifecycle` (agent.js:309-325) awaits the executor with **no abort race**; `finishRun()` (agent.js:349-359 area) runs only in `finally` after the executor returns. A parked `response.result()` means `finishRun` never runs → `_state.isStreaming` stays true → the agent wedges ("Agent is already processing" on next prompt; UI stuck).
- Esc in interactive mode: `interactive-mode.js:1930-1931` → `restoreQueuedMessagesToEditor({abort:true})` → `this.agent.abort()` (:3144-3156) — fire-and-forget; `abort()` only flips the controller (agent.js:195-198). `AgentSession.abort()` (agent-session.js:1077-1082) *does* await `waitForIdle()` and would hang on a parked run.
- **Builtin providers never end quietly on abort**: pi-ai converts an aborted fetch into an `error` event with `stopReason: 'aborted'` (openai-completions.js:361-376), which resolves `finalResultPromise` and lets the loop emit `message_end`; the TUI renders `stopReason === 'aborted'` benignly as "Operation aborted" (interactive-mode.js:2297-2306).

Therefore the router's quiet exits — the three choke points (provider.ts:354-357, :545-548, :576-579), the benign-abort catch (:770-786), and the exhausted-error suppression — all call bare `stream.end()`. On the stale-ctx path that is survivable (the session object is discarded); on the **user-abort path it wedges the run**. The stale-ctx/abort test at provider.test.ts:1231-1274 passes only because `MockEventStream` has no `result()` contract at all. Checkpoint decision: aborted turns end with a pushed `stopReason:'aborted'` terminal event, and the existing quiet-exit points are fixed to the same shape in this change.

### Stall-note surface (resolved: `ui.notify` at 'warning')

- `ctx.ui.notify(message, level)` is synchronous in interactive mode — every level appends to `chatContainer` and requests render; there is no queue and no gating on stream state (interactive-mode.js:1824-1834). During a stream, the assistant partial renders in place (:2257-2268), so an appended note lands below the growing text without corruption. This is the same channel `recordDebugDecision` already uses mid-turn (index.ts:151-155).
- **`'info'` dedups** (showStatus, interactive-mode.js:2499-2515, dedup at :2503-2506): two back-to-back stall notes collapse into one updated line — exactly the multi-stall case. **`'warning'` always appends** (:3050-3053). Decision: `'warning'`.
- Disqualified: synthetic `stream.push` of a text event (agent-loop writes `event.partial` into `context.messages` — the note would become model-authored content, persisted and re-fed to the LLM); `pi.sendMessage` (mid-stream it degrades to steer/followUp — injects into the live turn's LLM context, agent-session.js:983-1012); the debug-notify channel (gated on `debugEnabled`, default false — index.ts:43,132).
- Mode caveats: notify renders in interactive and RPC modes (rpc-mode.js:86-95); print mode is a no-op (runner.js:87-91). Notes are TUI-only, not persisted to the session transcript (persistence happens on `message_end`, agent-session.js:277-288). Both acceptable for FRD req 6.
- Complement available: `ui.setWorkingMessage` (extensions types.d.ts:80-81) can relabel "Working..." during the retry window.

### Provenance attachment (resolved: reasoning-string-only)

All enrichment precedents rewrite the reasoning string in place on the live decision after the successful stream: Google guard :395-397, cross-tier :714-716, in-tier :733 (pattern `(Original: ...)`). `recordDebugDecision` clones the decision post-stream (index.ts:131, called at provider.ts:763 after the mutation blocks — deliberate, comment at :472-474), ring-bounded by `MAX_DEBUG_HISTORY = 12` (constants.ts:1). Consumers render the reasoning string everywhere: `/router status` (commands.ts:195), `/router debug show` (commands.ts:498 → ui.ts:30-33), widget flags (ui.ts:17-28 shows `fallback` via `getDecisionFlags`). The notify source-label chain (index.ts:139-146) is single-winner — a stall fallback resolves to `'fallback'`; the stall distinction lives in the reasoning text. Constraint: `sanitizeRoutingDecisionFields` (state.ts:68-152) builds the restored `lastDecision` field-by-field and drops unknown fields, while `debugHistory` restore is **not** sanitized (index.ts:413-415) — a new optional field would survive in history but vanish from `lastDecision`, an asymmetry that argues against a new field (full flag cost if ever needed: types.ts:95-119 + sanitizer line + `getDecisionFlags` push + label-chain branch before `isFallback` + state.test.ts case). Gap to know: total-failure turns push no history entry (`recordDebugDecision` runs only on success) — the notify line at detection time is then the only provenance, which is why it must not be debug-gated. Classifier stalls need no new provenance (stall = existing infra-failure shape → `failureReason: 'infra-failure'` family, types.ts:57-63).

### Config knob flow — the merge whitelist trap

- `parseConfigFile` (config.ts:52-74) checks existence/JSON/object only; blind cast at :65 — invalid values survive to normalization.
- **`mergeConfig` (config.ts:114-146) returns an explicit object literal listing exactly seven fields (:134-145) — no spread.** A top-level key absent from that literal is silently discarded before `normalizeConfig` ever sees it (loadRouterConfig folds base/global/project at :542-547). `stallTimeoutMs` needs one merge line mirroring `maxSessionBudget` at :141 (`override.stallTimeoutMs ?? base.stallTimeoutMs`), or the knob is dead on every load path (init index.ts:361, restore :364, `/router reload` commands.ts:519).
- Normalization shape: the `maxSessionBudget` gate (:421-424) combined with an always-concrete default — `typeof === 'number' && v > 0 ? v : DEFAULT_STALL_TIMEOUT_MS` — placed after :424, emitted in the return literal near :528. `NaN` fails `> 0`; `Infinity` passes (same hole as budget at :422); no warning (all three scalar precedents :416-419, :421-424, :525 are silent — this resolves the Q7/Q8 divergence in favor of silence).
- Type: optional `stallTimeoutMs?: number` on `RouterConfig` (types.ts:85-93, after `maxSessionBudget` :89) — required would break the pre-load placeholder (index.ts:39), `Partial<RouterConfig>` parsing, and test fixtures. Not on `RouterPersistedState` (no runtime toggle).
- Constant: `DEFAULT_STALL_TIMEOUT_MS = 90_000` in constants.ts beside `DEFAULT_CONTEXT_WINDOW` (:3-4, numeric-underscore style).
- Runtime read: per-turn inside the IIFE — `state.currentConfig.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS` (the `??` guard is required despite normalization because `RouterConfig` is shared with pre-normalize values; precedent index.ts:232). Config reaches provider.ts via the live getter (index.ts:311-313 → provider.ts:174), so per-turn reads see `/router reload`; do not snapshot at registration. Thread the value into `runClassifier` as a parameter.
- Example file: `"stallTimeoutMs": 90000` after model-router.example.json:5.

### Test harness bounds

Zero modifications to `MockEventStream` and zero new mock surfaces needed. Load-bearing facts:

- Role split: `MockEventStream` mocks only the **outer** router stream (via `vi.mock('@earendil-works/pi-ai')`, provider.test.ts:41-43); classifier and delegated streams come from the mocked compat `streamSimple` (:45-48). "Fake stream that emits no events" is a never-yielding async generator returned by that mock. `getApiProvider` always truthy (:47) → the router always takes the compat delegation branch.
- Timing: real timers + a 15-25 ms `stallTimeoutMs` injected into `mockState.currentConfig` (plain literal :61-75) + the suite's existing 100 ms sleep idiom (:169, :214, :590, `sleep` :1003-1004). `vi.useFakeTimers()` would break every subsequent sleep in the file and requires `advanceTimersByTimeAsync` (never sync) for the detached IIFE — avoid in provider.test.ts; routing.test.ts is timer-free apart from the new tests, so fake timers are safer there.
- Suspension idioms exist: `midStreamGate` (:1021-1025, :1067-1071), `authGate` (:1102-1106), `classifierGate` (:1247-1251) — a generator that yields one delta then awaits an unreleased gate is exactly the production stall shape.
- Per-scenario models: (a) silent-stream fallback — model after :175-218 (throw-then-fallback, `callCount === 2`, `lastDecision.isFallback`); (b) classifier stall — routing.test.ts:998-1021 (retry) + :950-957 (all-fail → undefined); the provider-level half after :1231-1274, using classifier refs **disjoint from tier candidates** (the single compat mock cannot otherwise tell classifier calls from delegation calls); (c) abort — AbortController idiom :1058-1099 + gate; assert stream ended via the suite's **first-ever** `stream.on('end', ...)` use (MockEventStream.on :26-33 supports it; nothing consumes the iterator); (d) auth stall — the override registry mock :840-884 fused with a never-resolving `getApiKeyAndHeaders`; **no AbortController** in this test (an aborted signal would take the silent-exit branch instead of fallback — that is the discriminator from (c)); (e) config — pure assertions in the normalizeConfig describe (config.test.ts:271-306). The **merge-line detector** must be a valid value (30000) through `loadRouterConfig`'s fixture (:46-53) asserted at :309-317 — absent and invalid both converge on 90000, so an invalid-value end-to-end test cannot catch the missing merge line.
- Unhandled-rejection rules: abandoned promises/generators must stay pending; gates get `resolve()` only, never `reject()`; never release a race-lost promise into rejection.
- Pin discipline: pinning skips the classifier (provider.ts:336) — (a)/(d) pin medium; (b)/(c) must not. Default mock config has no `low` tier (:61-75).

### Platform contracts — SSE abort mechanics (FRD assumption verified)

- Per-read signal re-check exists **only** in the Anthropic path (`iterateSseMessages`, anthropic-messages.js:219-229, check at :226-227 before each `reader.read()`). The OpenAI path is a bare `for await` over the SDK stream (openai-completions.js:231) — no in-loop check.
- Both vendored SDKs keep the user abort listener attached for the signal's lifetime (only `clearTimeout` in `finally`): `@anthropic-ai/sdk@0.91.1` client.mjs:322-354 and `openai@6.26.0` client.js:387-414 (signal injected at :488) — so a mid-body abort errors the pending read through the fetch layer. Google transport: own controller per request (node/index.mjs:13174-13179), read loop :13217-13236 with no signal check.
- The OpenAI SDK iterator **swallows AbortError and returns cleanly** (openai/core/streaming.js:64-68); pi-ai converts that into an `error` event via its post-loop `signal?.aborted` check (openai-completions.js:346, :361-376). Conclusion: a correctly-threaded signal does terminate stalled reads in practice, but the extension-level abort race remains the only guaranteed bound on non-cooperative stacks — the FRD's assumption holds with that nuance.
- `EventStream` has no cancellation primitive: `push()` no-ops after done (event-stream.js:16-18), `end()` only wakes consumers (:25-33), there is no `throw()`/`close()`. Dropping the iterator stops consumption but not the underlying fetch — the only kill switch is the signal composed into the delegation options. The single wiring point is `delegationOptions` after the :629-630 destructure (covers both delegation branches' spreads at :653/:659): compose the watchdog's per-candidate `AbortController` with `options?.signal` (pi-ai ships `combineAbortSignals`, abort-signals.js:1-33). On stall: abort the controller (kills the SSE read) then throw.
- Complementary existing bound: pi-ai options already carry `timeoutMs` (types.d.ts:84-88; threaded at openai-completions.js:112, anthropic-messages.js:352) — a total-request ceiling the classifier options could set today with zero new machinery.

## Code References

- `extensions/provider.ts:277-746` — `streamSimple` registration + IIFE (verified 797-line file)
- `extensions/provider.ts:336-348` — classifier gate, refs build, `runClassifier` call (no signal passed today)
- `extensions/provider.ts:354-357` — post-classifier choke (bare end + return)
- `extensions/provider.ts:395-397` — Google-continuation reasoning rewrite (enrichment precedent)
- `extensions/provider.ts:471` — `state.lastDecision = decision` (pre-loop assignment)
- `extensions/provider.ts:495-541` — outer tier loop / inner candidate loop
- `extensions/provider.ts:545-548` — per-candidate choke point
- `extensions/provider.ts:569-587` — auth await, post-auth choke, auth-fail `lastError`+`continue`
- `extensions/provider.ts:591` — per-candidate `try` (watchdog stall throw must originate inside)
- `extensions/provider.ts:629-665` — `delegationOptions` destructure (signal already forwarded), ModelRuntime/compat ternary
- `extensions/provider.ts:668-695` — delegated `for await`: cost :669-672, pre-content throw :673-678, partial-usage :682-687, `isContent` :688-692, forward :694
- `extensions/provider.ts:696-741` — `success = true`; cross-tier :698-716 and in-tier :717-733 mutation blocks; `break outer` :741
- `extensions/provider.ts:742-757` — catch → `lastError`; exhaustion throw
- `extensions/provider.ts:763-789` — post-stream `recordDebugDecision`, `stream.end()`, benign-abort catch (:770-774 checks, :775-783 suppression), `finally` persistState
- `extensions/routing.ts:111-149` — `buildDelegationTierChain`, `resolveAvailableTier`
- `extensions/routing.ts:698-783` — `runClassifier`: signature :698-705, auth :712-713, signal-less open :746-750, loop :753-761, `!contentReceived` :763, catch :777-780, `undefined` :782
- `extensions/config.ts:114-146` — `mergeConfig` field whitelist (the trap)
- `extensions/config.ts:373-535` — `normalizeConfig` (scalar precedents :416-419, :421-424, :525)
- `extensions/config.ts:537-555` — `loadRouterConfig` merge-then-normalize flow
- `extensions/index.ts:128-156` — `recordDebugDecision` (clone, debug gate, source-label chain, notify)
- `extensions/index.ts:311-313` — live `currentConfig` getter into provider state
- `extensions/state.ts:68-152` — `sanitizeRoutingDecisionFields` (field-by-field restore whitelist)
- `extensions/types.ts:24-29, 57-63, 85-93, 95-119, 137-145` — `ClassifierConfig`, failure reasons, `RouterConfig`, `RoutingDecision`, `ConfigLoadResult`
- `extensions/constants.ts:1-4` — `MAX_DEBUG_HISTORY`, defaults (home of `DEFAULT_STALL_TIMEOUT_MS`)
- `extensions/ui.ts:17-33` — `getDecisionFlags`, `formatDecision`
- `extensions/commands.ts:166-207, 495-519` — `/router status` (reasoning :195), `/router debug show`, `/router reload`
- `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js:16-33, 35-65` — push/end/iterator/result mechanics
- `node_modules/@earendil-works/pi-ai/dist/utils/abort-signals.js:1-33` — `combineAbortSignals`
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:189-196, 222-236, 238` — signal pass, terminal-event case, post-loop `response.result()`
- `node_modules/@earendil-works/pi-agent-core/dist/agent.js:192-198, 309-359` — abort ownership, `runWithLifecycle` (no abort race), `finishRun`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1077-1082` — session abort awaits idle
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1930-1931, 2499-2515, 3050-3053, 3144-3156` — Esc path, showStatus dedup, showWarning append, `agent.abort()`
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:111, 231, 346, 361-376` — fetch signal, no per-read check, post-loop abort conversion
- `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:219-229, 351` — per-read aborted check, fetch signal
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:532-565` — total `getApiKeyAndHeaders`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:90-103, 330-365, 374-426` — lock options, locked refresh, `getApiKey`
- `extensions/provider.test.ts:7-48, 61-75, 175-218, 840-884, 1021-1106, 1231-1274` — harness, config literal, fallback test, auth-fail test, gates, AbortController, classifier-await test
- `extensions/routing.test.ts:899-1048` — classifier suite (retry :998-1021, no-retry-after-content :1023-1048)
- `extensions/config.test.ts:28-70, 271-318` — fs mocks, normalizeConfig/loadRouterConfig describes

## Integration Points

### Inbound References
- `pi-agent-core/dist/agent-loop.js:189-196` — the agent loop calls the router's `streamSimple` with `{...config, apiKey, signal}`; `options.signal` is the run's abort signal (`AbortController` created in `runWithLifecycle`, agent.js:310-320). Esc ⇔ `options.signal.aborted`.
- `agent-loop.js:196-238` — the sole consumer of the router's returned stream: forwards events, replaces `partialMessage` in place, and **requires** a terminal `done`/`error` event (or `end(result)`) to resolve `response.result()` and finish the run.
- `interactive-mode.js:1930-1931 → 3144-3156` — Esc → `agent.abort()` (fire-and-forget); the run must unwind itself via the signal.
- Session persistence: `agent-session.js:277-288` appends messages on `message_end` — only terminal-event-shaped turns persist.

### Outbound Dependencies
- compat `streamSimple` (provider.ts:11 import; routing.ts:1 import) — forwards options verbatim including signal; used for classifier (:746-750) and compat-path delegation (:658-664).
- `state.currentModelRegistry.runtime.streamSimple` (:650-656) — ModelRuntime delegation for custom api ids; receives `delegationOptions` (signal included).
- `modelRegistry.getApiKeyAndHeaders` (provider.ts:569-572; routing.ts:712) — total function; internally bounded (~73 s worst); no signal parameter (race-only).
- `state.lastExtensionContext.ui.notify` (index.ts:151-155 precedent) — stall note surface; `ui.setHiddenThinkingLabel` (:616-627 precedent) shows the liveness-gate idiom for mid-turn ctx access; `ui.setWorkingMessage` available.
- `actions.recordDebugDecision` (provider.ts:763), `actions.updateStatus` (:735-740), `actions.persistState` (:787-789).

### Infrastructure Wiring
- Provider registration: `pi.registerProvider('router', {...})` at provider.ts:279-288; registry captured via `before_provider_request` event (index.ts:113-140); `isExtensionContextDead` set on ctx getter throw (:83) and session kill (:557), cleared on live capture (:78).
- Config delivery: `loadRouterConfig` (config.ts:537-555) → `currentConfig` (index.ts:39, reassigned only by `actions.reloadConfig` :228-229, invoked at init :361, restore :364, `/router reload` commands.ts:519) → live getters into provider (:311-313) and commands (:484-486).
- State persistence: `persistState` in the IIFE `finally` (:787-789) → `buildPersistedState` (state.ts:222-266); restore sanitizes `lastDecision` (index.ts:419) but not `debugHistory` (:413-415).

## Architecture Insights

- **Exception-driven fallback**: every advance is a throw into :742-744 or a `continue` that sets `lastError`; every success-shape mutation is centralized at :698-733. A watchdog that throws distinguishable errors inherits the entire machine — the design rule is "own the timer and the race, never the loop movement" (the classifier loop moves by `continue`, the delegated loop by `throw`: same defect class, opposite idioms).
- **The platform terminal-event contract**: provider streams must terminate with `done`/`error` (or `end(result)`); quiet `end()` wedges `agent-loop.js:238`. This contract is invisible to the current test harness (`MockEventStream` has no `result()`), which is how the wedge survived five rounds of fallback tests. `stopReason:'aborted'` terminal events are the platform's own benign-abort idiom, rendered as "Operation aborted".
- **Two-layer defense composition**: choke points poll flags (liveness), the watchdog bounds durations (temporal liveness); they compose — the watchdog guarantees waits end so the choke points get to run.
- **Timer-reset sets**: `isContent` (four events, :688-692) gates `contentReceived`; a connection-inactivity watchdog should reset on any yielded event (strictly safer; structural-only streams still trip). The FRD's classifier pair (:757-760) is the conservative subset; a shared helper should use one set uniformly.
- **Merge-whitelist config**: top-level keys live or die at `mergeConfig` (:134-145); normalization is always-concrete for scalars that need defaults. Config reaches code via live getters, threaded as plain arguments into stateless `routing.ts` functions (config-extraction-at-call-boundary).
- **Visibility layering**: `ui.notify('warning')` for append-per-call user notes; reasoning-string for all persisted/rendered provenance (survives the sanitizer by construction); `failureReason` lattice for classifier failure taxonomy. A new optional decision field costs five touch points and hits a restore asymmetry — avoid.
- **Race-safety idioms**: total-function dependencies are safe to `Promise.race`-abandon; abandoned generators/pending promises must never transition to rejection (unhandled-rejection failures in Vitest).
- **pi hooks are unstable API and in-repo comments about them have been wrong** — verify abort/signal contracts against `pi-agent-core`/`pi-ai` dist, not comments (validation 2026-09-04).

## Precedents & Lessons

5 similar past changes analyzed.

### Precedent: Custom-API delegation rewrite — a 4-fix chain over the same fallback loop
**Commit(s)**: `2a0fb0a8` + `524afdec` (2026-08-27) "delegate custom-api models through ModelRuntime" → `4ae87431` (08-29) "refresh runtime captures…" → `cdcfe2eb` (08-30) "bind ModelRuntime.streamSimple" → `d793dbde` (09-04) "dead-flag gate stale extension ctx".
**Blast radius**: 08-27: 2 files; 08-29: 4 files; 08-30: 1 file; 09-04: 16 files (+553 test lines).
**Follow-up fixes**: the 08-27 change needed three more fixes in 8 days. `cdcfe2eb` documents the exact silent-demotion mechanism: an error landing in `lastError` advanced the chain invisibly — "debug history logged the successful fallback and never the failed primary". `4ae87431` was refuted in the field ~8 h after commit.
**Takeaway**: stall must feed the existing thrown-error path AND be visible per-advance (note + reasoning) or it repeats the silent-demotion bug class.

### Precedent: Lost 2026-08-31 cross-API tool-continuation fix — HIGH severity
**Commit(s)**: none — `git log -S isCrossApiToolContinuation --all` is empty; working tree clean at HEAD contains only the Google-only guard (provider.ts:373 comment anchor). The 08-31 edit died in a `reset: moving to 524afdec` / `pull` cycle (reflog `HEAD@{2026-08-31}`).
**Takeaway**: commit each fix immediately; the planner must not assume the cross-API generalization exists — it likely needs redoing as a follow-up.

### Precedent: Classifier overhaul and next-day structured-flags fix
**Commit(s)**: `f873288a` (07-04) → `c028bcb9` (07-05, replaced prose-sniffing with structured flags) → `fb79faf7` (07-19, also **removed 50 ms `setTimeout` race workarounds** as bugs) → `eff7ce1e` (07-21, `ClassifierFailureReason` expansion).
**Takeaway**: stall = a new failure mode in the structured pipeline, never prose-sniffed; watchdog timers must be per-event-reset + genuinely raced, never sleep-based.

### Precedent: Multi-defect fallback-guard bundle
**Commit(s)**: `fb79faf7` (07-19) — Google continuation guard + in-tier fallback mutation ("so next turn's guard sees the real model") + per-field sanitizer; docs follow-up `e4b5601f` same day, reviewed clean.
**Takeaway**: stall-triggered fallback must mutate decision state identically; same-day docs commits are the hygiene pattern.

### Precedent: Abort/stale classification gates — HEAD itself
**Commit(s)**: `d793dbde` (2026-09-04) — classifies stale-ctx throw **and `AbortError` as benign**, stops the chain when the session dies mid-stream; three `signal?.aborted` gates.
**Takeaway**: watchdog abort and user-Esc hit the **same catch sites** — a stall-abort must not be swallowed as benign, while Esc-abort must stay silent-but-terminal. This classification split is the riskiest interaction of the planned change. The new terminal-event requirement interacts with :770-786 directly.

### Composite Lessons
- Silence never advances the fallback loop; implement stall as throw-into-existing-chain (`cdcfe2eb`, FRD root cause).
- Silent failure masking: every stall-advance needs a user note + debug-history enrichment (`cdcfe2eb`).
- Uncommitted fixes get destroyed by reset/pull cycles — the 08-31 fix left no trace (reflog ×2 resets).
- Verify platform contracts against dist, not in-repo comments (anchor comments provably wrong about hook ordering; pi removed 2 of 5 event names in one minor bump, commit `2b8e6862`).
- Every prior fix asserted invariants no test observed; drive real ordering, not mocks (`4ae87431` field refutation; `MockEventStream`'s missing `result()` contract is this lesson, live).
- Designed-but-never-landed fixes happen here (the 827-line 2026-08-30 registry-guard design has zero code matches).
- Config-knob naming is API (`maxOutputTokens`→`maxTokens` rename `e33d57d7`; `thinkingLevels` `a7443f28`).
- Timing-dependent tests flake — the dead-flag validation flagged 4 fixed-settle assertions as flake risk; prefer injected small timeouts + real sleeps ≥ 5× the timeout.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-09-07_10-47-10_router-stall-fallback-abort.md` — the FRD this research answers (requirements, decisions, acceptance criteria)
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — prior research on registry capture; documents where `before_provider_request` actually fires
- `.rpiv/artifacts/designs/2026-08-30_09-02-24_registry-guard-structural-fix.md` — designed, never landed (lesson source)
- `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` — landed as `d793dbde` (HEAD)
- `.rpiv/artifacts/plans/2026-07-21_19-27-12_classifier-routing-accuracy.md` — landed as `eff7ce1e`
- `.rpiv/artifacts/research/2026-07-13_19-15-32_ai-slop-codebase-audit.md` — notes the 380-line IIFE and 11-param `decideRouting` smells (context for why the IIFE is the change surface)

## Developer Context
**Q (discover: Fix scope — all four defect-class parts): Which of the waits/abort defects are in scope?**
A: All four — classifier hang, silent-stall→no-fallback, auth-fetch hang, Esc-cancels-everything. (Research found a fourth auth site at routing.ts:712 and the bare-`end()` wedge platform defect in the same class.)

**Q (discover: Stall timeout value): How long with zero data before a model counts as stalled?**
A: 90 seconds, one config knob `stallTimeoutMs`.

**Q (discover: Stall visibility): When a stall fires and the router switches models, how visible is it?**
A: One-line note in chat.

**Q (discover: Classifier stall behavior): If the tier-classifier call itself stalls, what happens?**
A: Next classifier ref → built-in rules (matches existing infra-failure behavior).

**Q (discover: Desired outcome): What does a good outcome look like?**
A: "It never hangs, It recovers itself, Esc always works" (all three).

**Q (`extensions/provider.ts:682-687` + `:694`): A model streams half an answer, then goes silent 90s (post-content stall) — retry or keep the partial?**
A: Retry with the next model (FRD req 2 literal). The successor's partial replaces the old one in place in pi's context (`agent-loop.js:204-221`), so the turn completes coherently.

**Q (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:238` + `extensions/provider.ts:354/545/576`): Bare `stream.end()` parks pi's core forever — how should an Esc-aborted turn end?**
A: Push a `stopReason:'aborted'` terminal event exactly like builtin providers (pi renders "Operation aborted" benignly, interactive-mode.js:2297-2306). Also fix the three existing quiet-exit choke points and the AbortError catch to the same shape, so Esc stops wedging everywhere.

**Q (`interactive-mode.js:2499-2515`): Stall note style — warning or info?**
A: Warning line — `'info'`/showStatus dedups consecutive notes (a multi-stall chain would collapse to one line); `'warning'` always appends.

## Related Research
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — registry capture contract (precondition of the delegation ternary at provider.ts:650-665)

## Open Questions
- Cross-instance contention on shared `~/.pi/auth.json` (auth-storage.js:90-103,158): bounded ~73 s worst case, real multi-instance latency — lock redesign or refresh backoff belongs upstream in pi (carried from FRD).
- zai-paas stalls under concurrent load from a single API key: worth measuring/reporting upstream; the router defends but cannot prevent (carried from FRD).
- pi-claude-bridge returns silent empty completions on malformed foreign tool-call history instead of erroring loudly (carried from FRD; same fail-silently family).
- The 2026-08-31 `isCrossApiToolContinuation` fix was destroyed (never committed); the Google-only guard remains at provider.ts:373-399 — redo the cross-API generalization as a separate change.
- Exact shape of the aborted terminal event (error event with `stopReason:'aborted'` vs `end(message)` with a synthetic aborted AssistantMessage) — pick in design; both resolve `finalResultPromise`, only the error-event shape matches builtin providers exactly.
- `Infinity` passes the `stallTimeoutMs` gate (watchdog effectively disabled) — same hole as `maxSessionBudget` at config.ts:422; acceptable by FRD wording, note in design.
