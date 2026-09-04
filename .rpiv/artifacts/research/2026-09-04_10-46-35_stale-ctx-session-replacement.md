---
date: 2026-09-04T10:46:35+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Fix stale extension ctx after session replacement in router provider"
tags: [research, codebase, provider, session-lifecycle, stale-ctx]
status: ready
last_updated: 2026-09-04T10:46:35+0700
last_updated_by: Yogiswara Utama
---

# Research: Fix stale extension ctx after session replacement in router provider

## Research Question

Developer's report (verbatim): "when using model auto, from current project, it shows error: Error: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload(). need find the solution"

Input artifact: `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md`

Citation prefixes: repo paths are relative to the repo root. `pi …` paths are relative to the installed package `C:\Users\utama\AppData\Local\nvm\v24.14.0\node_modules\@earendil-works\pi-coding-agent`. `pi-agent-core …` paths are relative to `@earendil-works/pi-agent-core` in the same node_modules.

## Summary

pi invalidates an extension ctx by setting a stale message on the extension runner. Every ctx getter and every `pi` facade method then throws a plain `Error`. The stale message starts with "This extension ctx is stale after session replacement or reload."

Two FRD premises needed correction. First, the registry snapshot at `extensions/provider.ts:308` cannot throw the stale error. The raw `ModelRegistry` facade has no stale check (`pi core/model-registry.js:32-34`). The reported error comes from ctx-derived reads in the stream. The main throw sites are `extensions/provider.ts:587-594`, `:463`, `:465-466`, and `:703-704`, plus the notify at `extensions/index.ts:138-141`. Second, pi aborts the in-flight run before `session_shutdown` on new, fork, switch, and quit. Only reload never aborts (`pi core/agent-session.js:2140-2146`).

Both FRD assumptions were verified otherwise. `session_shutdown` fires before old-runtime teardown, and pi awaits every handler to completion. The fix shape holds: a dead-flag set by a `session_shutdown` handler and by the `captureCtx` catch, cleared on the next live capture. Guards sit around ctx-derived reads and after await boundaries. The catch at `extensions/provider.ts:730-739` classifies stale throws and AbortError as benign silent termination.

## Detailed Findings

### pi session-replacement lifecycle (ground truth from installed package source)

- Teardown order for newSession, fork, switchSession, and import: abort the old turn, await idle, emit `session_shutdown`, then dispose. All four flows call `teardownCurrent()` at `pi core/agent-session-runtime.js:102-113`. Line 105 aborts. Lines 106-110 emit the event. Line 112 disposes.
- Every `session_shutdown` handler promise is awaited, in order, before invalidation. `emitSessionShutdownEvent()` awaits the runner emit at `pi core/extensions/runner.js:50-60`. The runner awaits each handler at `pi core/extensions/runner.js:579-611`. Handler throws are caught at lines 598-606 and reported, never propagated.
- The in-flight turn settles before `session_shutdown` fires on abort paths. `AgentSession.abort()` aborts the run controller and awaits idle at `pi core/agent-session.js:1171-1175`. The run cannot go idle before the router's returned stream ends.
- Reload is the exception. `reload()` emits `session_shutdown` at line 2145 and invalidates at line 2146, with no abort anywhere in `pi core/agent-session.js:2140-2166`. An in-flight agent run keeps running while the ctx is already stale.
- Quit disposes with reason "quit" at `pi core/agent-session-runtime.js:289-296`.
- CHANGELOG confirms the ordering is deliberate: settle-then-shutdown at pi `CHANGELOG.md:1711`, invalidation contract at line 1741.
- Lifecycle docs match the code: `pi docs/extensions.md:316-326` (event order), `:449` (fork), `:516-521` (`session_shutdown` definition), `:1247-1251` (`withSession` footguns), `:1300-1308` (reload).

### What actually throws the stale error

- pi stores one stale message, then poisons read-time getters. `invalidate()` at `pi core/extensions/runner.js:352-357`. `assertActive()` throws `new Error(this.staleMessage)` at lines 358-362. Guarded getters: `ui` at 464-467, `cwd` at 476-479, `modelRegistry` at 484-487, `signal` at 508-511, and the rest through 535.
- The `pi` facade mirrors this. Every method asserts at `pi core/extensions/loader.js:217-385`. Examples: `setThinkingLevel` at 279-282, `setModel` at 272-275, `appendEntry` at 300-303. The stale throw is at lines 143-145.
- The raw `ModelRegistry` does not check staleness. `find` delegates to the shared runtime at `pi core/model-registry.js:32-34`. `getApiKeyAndHeaders` wraps its body in try/catch and converts any throw to `{ ok: false, error }` at lines 48-75. Grep for "is stale" in `pi-agent-core dist` returns nothing.
- Session replacement reuses the same `ModelRuntime`. Services create it once at `pi core/agent-session-services.js:56-61`. Every new session receives it at lines 116-127, wrapped in a fresh `ModelRegistry` at `pi core/agent-session.js:2127`. A captured old `ModelRegistry` keeps working mechanically. What dies is the ctx object and the `pi` facade.
- Message shape: a plain `Error`. The text starts with "This extension ctx is stale after session replacement or reload." The repo's simulated message at `extensions/index.test.ts:128` is truncated. A discriminator must match the prefix, not the full string.
- Raised by ctx getters and `pi` facade methods only. Not by registry methods and not by the delegated model stream.

### Stale-read seam map (corrected, replacing FR2's premise)

Guards are needed only where the stream touches ctx getters or the `pi` facade, and after await boundaries. The full census:

| Site | Code | Stale throw? | Guard |
|---|---|---|---|
| Classifier await | `extensions/provider.ts:334` | No (internally caught in `extensions/routing.ts:707, 777-780`) | Liveness check after the await |
| Image-promotion reads | `extensions/provider.ts:396, 407, 410-425` | No (live getter, caught at 392-401 and 514-516) | None |
| Registry snapshot | `extensions/provider.ts:308` | No (raw facade, shared runtime) | Keep as-is |
| Delegation `find` | `extensions/provider.ts:536-539` | No | None |
| Auth await | `extensions/provider.ts:547-550` | No (converted to `ok:false`) | Liveness check after the await |
| Thinking label | `extensions/provider.ts:587-594` | Yes (ctx `ui` getter) | Check before the property access |
| `syncPiThinkingLevel` | `extensions/provider.ts:463` | Yes (`pi` facade) | Covered by the check after the classifier await |
| `updateStatus` (pre-stream) | `extensions/provider.ts:465-466` | Yes (ctx `ui` getter) | Check before the call |
| `updateStatus` (fallback) | `extensions/provider.ts:703-704` | Yes | Check before the call, or per-iteration in the loop |
| Debug notify | `extensions/index.ts:138-141` | Yes | Try/catch swallow, or flag gate |
| `appendEntry` in `persistState` | `extensions/index.ts:186` | Yes | Already swallowed at 188-191 |
| Runtime bridge | `extensions/provider.ts:607-616` | No (shared runtime, bound) | None |

- `runClassifier` at `extensions/routing.ts:698-783` discards per-ref errors at 707 and 777-780. A stale throw inside never reaches the IIFE. The worst outcome is heuristic routing.
- The runtime bridge must keep its `.bind` at `extensions/provider.ts:615-616`. Precedent `cdcfe2eb` fixed a detached-`this` throw here.
- Two liveness signals exist. An identity check (`state.currentModelRegistry !== modelRegistry`) misses the window between teardown and the next fresh capture, because the `captureCtx` catch keeps old values at `extensions/index.ts:75-78`. A probe getter read in try/catch detects invalidation immediately and is the reliable discriminator.
- Event handlers can also race death across internal awaits: `extensions/index.ts:534→536-540` (session_start trailing notify), `:561→569-572` (model_select tail), `:580→584` (turn_end status). `thinking_level_select` is synchronous and always fresh (`extensions/index.ts:587-614`). `switchToRouterProfile` awaits at `extensions/index.ts:273`, then notifies and updates status at 275-281; reached from `extensions/commands.ts:222, 684`.

### Abort signal behavior

- `options.signal` in the router's `streamSimple` is the live agent-run signal. Wiring: `pi-agent-core dist/agent.js:191-194` (signal getter), `pi-agent-core dist/agent-loop.js:190-193` (options build), `pi core/sdk.js:186-207` (spread into `modelRuntime.streamSimple`), `pi core/model-runtime.js:461-465` (forward), `pi core/provider-composer.js:309-324` (extension providers get the same options).
- The stream keeps the signal in `delegationOptions` at `extensions/provider.ts:597-598` (only `reasoning` is destructured out). Both delegation branches forward it.
- On abort, the delegated stream throws into the `for await` at `extensions/provider.ts:636`, or emits an error event that throws at lines 641-644. Either path lands in the IIFE catch. The proxy provider also checks `options.signal?.aborted` and marks abort events (verified in minified bundle `pi dist/bundle/chunks/chunk-E5KXRMZK.js:1075`; behavior-confirmed, code minified).
- The tier chain retries the next model after an abort today. The per-candidate catch at `extensions/provider.ts:705-709` stores the error and the loop continues. An early `options.signal?.aborted` check at the await sites stops those retries. Developer decision: add the check and classify AbortError as benign.
- Guard classes are disjoint. The abort path covers turn-bound work on new, fork, switch, import, and quit. The dead-flag covers reload and any detached work that no signal governs.

### Benign termination (concrete definition)

- No `type: 'error'` event is pushed. The shape to avoid is asserted at `extensions/provider.test.ts:787-813`.
- `stream.end()` is still called. Without it, the consumer await hangs. The existing early-return pattern at `extensions/provider.ts:299-301` shows the shape.
- `persistState()` still runs from the `finally` at `extensions/provider.ts:740-742`. It is total: build at `extensions/index.ts:153-166`, dedupe at 182-184, swallow at 188-191.
- The IIFE swallows the classified error. No rethrow. An unhandled rejection would surface through `emitError` at `pi core/extensions/runner.js:794-802`.
- Discriminator: dead-flag probe before each ctx touch, primary. Message-prefix match (`startsWith('This extension ctx is stale')`) in the catch, backstop. AbortError gets the same benign classification.

### Dead-flag design

- One boolean, for example `lastExtensionContextDead`, declared beside the capture closures near `extensions/index.ts:54`. A per-reason map is rejected: `captureCtx` receives only `ctx`, and the five reasons reduce to two reset outcomes.
- Set in two places: the catch in `captureCtx` at `extensions/index.ts:75-78` (throwing getters prove death), and a new `session_shutdown` handler. The handler is required: a fork mid-stream delivers no further event to the orphan, so the catch alone never fires.
- Clear in the `captureCtx` try block. A successful read of `ctx.modelRegistry` and `ctx.cwd` proves a live ctx. This covers `session_start` after reload and every `before_provider_request`.
- The orphaned instance never clears the flag. That is correct: it receives no live ctx again. Reload keeps the closure, and the next capture clears the flag (`pi docs/extensions.md:1300-1308`).
- The flag must not enter `RouterPersistedState` (`extensions/types.ts:121`). It is per-instance runtime state. A persisted true would disable the new instance's UI forever. `buildPersistedState` at `extensions/state.ts:223-251` stays unchanged.
- Surface: add a `readonly lastExtensionContextDead: boolean` to the inline state type at `extensions/provider.ts:165-181`, and a matching getter in the state object at `extensions/index.ts:284-338`.
- `reloadConfig` re-registration at `extensions/index.ts:222-246` needs no flag. It touches no ctx.
- Gate placement: at the provider call sites (the three stream sites), not inside `updateStatus` (`extensions/ui.ts:76-153`). Most `updateStatus` callers hold a fresh delivered ctx, and tests assert on its behavior (`extensions/index.test.ts:175, 197, 576`). Guard only the notify inside `recordDebugDecision` at `extensions/index.ts:138-141`. The history push at line 118 stays ungated: it feeds restore at `extensions/index.ts:393-394` via `buildPersistedState` field `debugHistory` at `extensions/state.ts:244`.

### Persistence on dead sessions

- Loss when the final `appendEntry` is swallowed: the killed turn's `lastDecision` (post-fallback mutation at `extensions/provider.ts:456, 666-684, 692-701`), its `accumulatedCost` delta (lines 638-639, 650-654), and its `debugHistory` record when line 727 ran. Pins, thinking maps, and calibration are untouched by the stream.
- The dedupe is one-directional and never masks a real delta. All timestamps are zeroed in the comparison snapshot at `extensions/index.ts:170-181`. `appendEntry` is reached only when a real field changed. Every swallowed append carried a real delta.
- Fork and clone inherit the prior entries up to the fork point (`pi docs/sessions.md:31-32, 118-127`; `pi docs/extensions.md:322-326`). The last pre-death persisted entry restores, not the swallowed delta. A fork at an older user message drops later persisted entries too.
- New session starts empty (`pi docs/extensions.md:316-320`). Restore falls back to the defaults at `extensions/index.ts:346-365`. Resume restores the target session's own last entry. Reload restores from the same file.
- No flush belongs in `session_shutdown` (FRD decision confirmed): a flush there runs while the killed stream is still mid-flight, so the delta fields do not exist yet. It would also write to the old file, which fork and new never read.
- The old instance's handlers never fire again after replacement (`pi docs/extensions.md:432, 449, 1247`). The swallowed delta has no retry site. This is accepted.

### Regression test design

- Suite split: stream guards in `extensions/provider.test.ts` (it calls `registerRouterProvider` directly at line 134 and never mocks `pi.on`). Listener wiring in `extensions/index.test.ts` (it captures handlers into `eventListeners` at lines 49-66 and stubs `registerProvider` as a bare `vi.fn()`).
- The deferred gate is the only lever for the mid-turn window. No existing test defers: every mocked generator yields immediately (`extensions/provider.test.ts:147-151, 225-229, 604-608, 857-861, 900-904`). The gate is a manually resolved promise inside the compat `streamSimple` generator. It holds the IIFE at the `for await` at `extensions/provider.ts:636`.
- State lever: `Object.defineProperty` on `mockState.lastExtensionContext`, backed by a `dead` closure variable. `mockState` fields are plain properties, not getters (`extensions/provider.test.ts:96-112`). In-test state shaping is the established convention (line 208, 227).
- Execution order: register an `'end'` callback on the `MockEventStream` (fires synchronously from `end()` at `extensions/provider.test.ts:19-24`), call `streamSimple`, settle one short tick, flip `dead`, release the gate, await the end promise.
- Assertions: no event with `type === 'error'` (inverse of the pattern at `extensions/provider.test.ts:666, 807, 833, 955, 988`), at least one `text_delta` (proves mid-turn execution), the `'end'` callback resolved, and `persistState` ran once.
- `index.test.ts` additions: assert `session_shutdown` registration beside the existing assertions at `extensions/index.test.ts:91-108`. Drive the handlers with a stale ctx (shape at 126-133). Then prove recovery: fresh `before_provider_request` plus a full `session_start` (pattern at 142-146).
- Runner: `npm test` runs `vitest run` (`package.json:43`). No vitest config file exists. Default 5-second timeout, real timers, and the 100 ms sleep convention (`extensions/provider.test.ts:166` and roughly 20 siblings).

## Code References

- `extensions/index.ts:70-79` — `captureCtx`: try/catch capture of ctx, registry, cwd; keeps last values on stale throw
- `extensions/index.ts:115-143` — `recordDebugDecision`: history push at 118, unguarded notify at 138-141
- `extensions/index.ts:153-192` — `persistState`: snapshot dedupe at 182-184, `appendEntry` at 186, stale swallow at 188-191
- `extensions/index.ts:284-338` — state getter surface passed to `registerRouterProvider`
- `extensions/index.ts:343-438` — `restoreStateFromSessionInner`: defaults reset, branch read at 367, `router-state` filter at 369-373
- `extensions/index.ts:444-459` — `restoreStateFromSession`: guarded wrapper
- `extensions/index.ts:527-614` — the five `pi.on` handlers; `session_start` at 531-542, `model_select` at 543-573, `turn_end` at 575-585
- `extensions/provider.ts:165-181` — inline state type consumed by the provider
- `extensions/provider.ts:277-746` — `streamSimple`: hoisted registry guard at 290-301, IIFE at 303
- `extensions/provider.ts:587-594` — `setHiddenThinkingLabel` reads; the reported user-error site
- `extensions/provider.ts:597-634` — delegation options destructure and both delegation branches
- `extensions/provider.ts:636-664` — `for await` loop, cost capture, error-event conversion
- `extensions/provider.ts:705-721` — per-candidate catch, `!success` rethrow of `lastError`
- `extensions/provider.ts:727-742` — success path, `type:'error'` push, `finally` persist
- `extensions/ui.ts:76-153` — `updateStatus`: setStatus at 111 and 113, setWidget at 117 and 149, theme.fg at 151
- `extensions/state.ts:223-251` — `buildPersistedState`
- `extensions/types.ts:121` — `RouterPersistedState` (flag must not extend this)
- `extensions/routing.ts:698-783` — `runClassifier`: swallows per-ref errors at 707 and 777-780
- `extensions/config.ts:583-601` — `resolveContextWindow` guarded fallback
- `extensions/provider.test.ts:6-118` — `MockEventStream`, module mocks, `mockState`/`mockActions`
- `extensions/index.test.ts:49-147` — listener capture, stale-getter pattern, recovery pattern

## Integration Points

### Inbound References

- `pi.on('before_provider_request')` at `extensions/index.ts:527-530` — capture anchor; see Open Questions on its router/* coverage
- `pi.on('session_start')` at `extensions/index.ts:531-542` — restore entry point; trailing notify can race death
- `pi.on('model_select')` at `extensions/index.ts:543-573` — profile tracking; tail can race death
- `pi.on('turn_end')` at `extensions/index.ts:575-585` — post-turn persist and status
- `pi.on('thinking_level_select')` at `extensions/index.ts:587-614` — synchronous, always fresh
- New `pi.on('session_shutdown')` — not yet registered anywhere; the dead-flag set point
- `registeredProviderOptions.streamSimple` called by pi through `pi core/provider-composer.js:309-324`

### Outbound Dependencies

- `modelRegistry.find` and `getApiKeyAndHeaders` — raw facade over the shared `ModelRuntime` (`pi core/model-registry.js:32-34, 48-75`); no stale behavior
- `registryRuntime.streamSimple` bridge at `extensions/provider.ts:607-616` — shared runtime, `.bind` mandatory
- compat `streamSimple` at `extensions/provider.ts:616-634` — receives `delegationOptions` including `signal`
- `actions.updateStatus` → `extensions/ui.ts:76-153` — ctx `ui` getters; the stale throw path
- `actions.recordDebugDecision` → `extensions/index.ts:138-141` — ctx `ui.notify`; stale throw path
- `pi.appendEntry` at `extensions/index.ts:186` — `pi` facade assert (`pi core/extensions/loader.js:300-303`); swallowed

### Infrastructure Wiring

- Provider registration: `pi.registerProvider('router', …)` inside `extensions/provider.ts:288` onward; re-registered from `reloadConfig` at `extensions/index.ts:222-246` via the getter surface
- Persistence: `router-state` custom entries, restore filter at `extensions/index.ts:369-373`, documented in `docs/ARCHITECTURE.md:43-50` as the only restore mechanism
- Abort signal: agent-run signal flows to the provider options through `pi core/sdk.js:186-207` and reaches both delegation branches

## Architecture Insights

- pi's invalidation is read-time and lazy: captured values stay usable, fresh reads throw. The dead-flag design composes with this because it gates reads, not captures.
- The two guard classes are disjoint: abort covers turn-bound work on aborting replacement paths; the flag covers reload and detached work. A fix that only adds the dead-flag leaves abort-path retries and abort-path error events in place.
- The shared `ModelRuntime` survives session replacement. Only the ctx facade and the `pi` facade die. Guards therefore belong at facade boundaries, not around registry use.
- The delegation loop swallows per-candidate failures by design. Any guard inside it can hide real errors. Benign classification must be explicit and narrow: stale prefix match plus AbortError.
- Extension instance lifecycle: fork/new/resume orphan the old closure; reload keeps it and re-fires `session_start`. A flag cleared on next live capture handles both without reason tracking.
- Inconsistency (unresolved): the comment at `extensions/index.ts:512-526` claims `before_provider_request` is a guaranteed pre-stream anchor. Prior research found the hook fires only from builtin API payload builders, not for router/* dispatch. The observed stale error (not a no-registry error) shows the registry is usually captured by other events first.

## Precedents & Lessons

4 similar past changes analyzed.

### Precedent: captureCtx runtime captures + before_provider_request anchor
**Commit(s)**: `4ae87431` — "fix: refresh runtime captures on every event and hoist provider registry guard" (2026-08-29)
**Blast radius**: 4 files across 2 layers
- extensions/index.ts — `captureCtx` (70-79) called from every handler; guarded restore
- extensions/provider.ts — hoisted no-registry guard (290-303)
- extensions/index.test.ts — stale-getter tests
- extensions/provider.test.ts — guard-error test update

**Follow-up fixes**:
- None landed. Research the next day proved the anchor assumption false for router/* dispatch.

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — `before_provider_request` fires only from builtin payload builders; router/* requests dispatch straight to the provider closure
- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — pi invalidates captured ctx on every replacement; single-event capture can miss

**Takeaway**: Verify each pi hook's emission point in pi source before building an invariant on it.

### Precedent: appendEntry swallow in persistState
**Commit(s)**: `f67a7850` — "fix: guard persistState against stale ctx after session reload" (2026-07-23)
**Blast radius**: 1 source file (9 lines) plus session-capture files

**Follow-up fixes**:
- None in 30 days. The swallow held.

**Takeaway**: The silent no-op on a dead session is the proven pattern in this repo. Extend it, do not add re-queue machinery.

### Precedent: ModelRuntime delegation
**Commit(s)**: `524afdec` — "fix(provider): delegate custom-api models through ModelRuntime instead of compat" (2026-08-27)
**Blast radius**: 2 files across 1 layer

**Follow-up fixes**:
- `cdcfe2eb` — "fix: bind ModelRuntime.streamSimple when delegating custom-api models" (2026-08-30) — detached `this` threw on every attempt; the fallback loop masked it

**Takeaway**: The delegation loop hides per-candidate failures behind successful fallbacks. Benign classification added inside it must be narrow and explicit.

### Precedent: session lifecycle handler removal
**Commit(s)**: `2b8e6862` — "Update to pi 0.65.0, remove deprecated session_switch/session_fork handlers" (2026-04-03)
**Blast radius**: 2 files

**Follow-up fixes**:
- None recorded.

**Takeaway**: pi session-lifecycle hooks are not stable API. Pin the pi version when testing the `session_shutdown` contract.

### Composite Lessons
- Verify hook emission in pi source, not in comments — `4ae87431` built an invariant on an unverified anchor, and research falsified it the next day.
- The silent no-op on dead sessions is proven — `f67a7850` needed zero follow-ups in 30 days.
- The delegation loop masks failures — `cdcfe2eb` showed a broken primary tier was invisible. A dead session that falls through to a fallback tier can look like success. Add a diagnostic on the benign-termination path.
- The designed structural registry fix never landed — `modelRegistryFallback` and `turn_start` capture exist only in `.rpiv/artifacts/designs/2026-08-30_09-02-24_registry-guard-structural-fix.md`. Plan against the current five-handler capture set.
- Mock-based wiring tests passed while the real invariant was false — the stale-getter tests in `4ae87431` could not detect the missing anchor. The regression test must simulate the real mid-turn timing window, which the deferred-gate design does.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md` — FRD for this fix (input artifact)
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — prior research on registry capture and the before_provider_request anchor
- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — architecture review with L0/L1 findings referenced in code comments
- `.rpiv/artifacts/designs/2026-08-30_09-02-24_registry-guard-structural-fix.md` — structural registry-fix design, never landed

## Developer Context

**Q (discover: Fix scope — all stale seams, not just the reported path): Keep full-seam scope, or narrow?**
A: Keep: fix all seams

**Q (discover: Architecture — session_shutdown invalidation): How should the extension stop touching stale ctx after session replacement? (withSession has no call site here — the router never initiates a replacement.)**
A: Shutdown invalidation — keep `captureCtx`, add the dead-flag, guard around awaits, classify stale throws as benign

**Q (discover: Persistence — keep silent no-op swallow): Keep the silent no-op, or add a best-effort flush in session_shutdown?**
A: Keep silent no-op

**Q (discover: Regression test — add mid-turn replacement test): Add one as the acceptance bar?**
A: Add: mid-turn replacement test

**Q (discover: Killed-turn UX — silent termination, no router notice): How should a replacement-killed turn end?**
A: Silent end of replacement-killed turns

**Q (`extensions/provider.ts:308`): The registry snapshot cannot throw the stale error — the raw `ModelRegistry` has no stale check (`pi core/model-registry.js:32-34, 48-75`). Re-anchor FR2's guard list to the ctx-derived sites (`extensions/provider.ts:587-594, 463, 465-466, 703-704`; `extensions/index.ts:138-141`)?**
A: Re-anchor to ctx sites. Flag-gate those sites plus post-await checks at `:334` and `:548`. Keep the `:308` snapshot as-is.

**Q (`extensions/provider.ts:705-709`): pi aborts the run before `session_shutdown` on new/fork/switch/quit (`pi core/agent-session-runtime.js:105-110`); reload never aborts (`pi core/agent-session.js:2140-2146`). The tier chain retries the next model after an abort. How should the fix treat the abort path?**
A: Check + benign. Early `options.signal?.aborted` check at the await sites stops the retries. The catch classifies stale-message throws and AbortError as silent termination.

**Q (`extensions/index.ts:534→536-540, 561→569-572, 580→584`): Three event handlers use ctx after an internal await and can race a replacement. Extend the dead-flag gate to these handler tails?**
A: Extend to handlers. Same flag, three more gate sites. Satisfies the FRD goal literally.

## Related Research
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — registry capture anchor and its limits

## Open Questions

Carried forward from the FRD, now resolved:

- "None — all interview branches were resolved. Research should verify the two assumptions listed under Constraints & Assumptions (shutdown-event ordering vs. in-flight deref; pi abort behavior on replacement)."
  - Assumption 1 verified: `session_shutdown` fires before old-runtime teardown on every replacement path, and pi awaits every handler (`pi core/agent-session-runtime.js:102-113`, `pi core/extensions/runner.js:579-611`).
  - Assumption 2 corrected: pi aborts the in-flight run before shutdown on new, fork, switch, import, and quit. Only reload never aborts (`pi core/agent-session.js:2140-2146`). The guards compose with abort per the checkpoint decision.

Remaining open:

- Does `before_provider_request` fire before a `router/*` provider request in the installed pi version? The comment at `extensions/index.ts:512-526` claims it does. Prior research (`.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md`) found it fires only from builtin payload builders. This research did not re-verify the emission point for extension providers. The dead-flag design does not depend on the answer. Verify before relying on the anchor for the registry invariant.
