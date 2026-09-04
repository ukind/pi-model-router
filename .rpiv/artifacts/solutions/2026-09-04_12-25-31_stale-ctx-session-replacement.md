---
date: 2026-09-04T12:25:31+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Fix stale extension ctx after session replacement in router provider"
confidence: high
complexity: medium
status: ready
verdict: pass
tags: [solutions, provider, stale-ctx, session-lifecycle, dead-flag]
last_updated: 2026-09-04T12:25:31+0700
last_updated_by: Yogiswara Utama
---

# Solution Analysis: Fix stale extension ctx after session replacement in router provider

**Date**: 2026-09-04T12:25:31+0700
**Author**: Yogiswara Utama
**Commit**: cdcfe2eb
**Branch**: main
**Repository**: pi-model-router

## Research Question

"when using model auto, from current project, it shows error: Error: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload(). need find the solution"

Input research: `.rpiv/artifacts/research/2026-09-04_10-46-35_stale-ctx-session-replacement.md`

## Summary

**Problem**: pi invalidates the extension ctx on every session replacement. The router extension holds one captured ctx across a long-lived provider stream. Stale reads throw and surface as user-visible errors.
**Recommended**: Dead-flag gate — one boolean set on `session_shutdown` and on the `captureCtx` catch, cleared on the next live capture, with gates at every ctx-derived read and benign classification in the stream catch.
**Effort**: Medium (~1 day)
**Confidence**: High

## Problem Statement

**Requirements:**
- Remove the user-visible stale error on every replacement path: new, fork, switch, import, quit, and reload.
- Fix all seams, not only the reported path (locked in research checkpoint).
- End a replacement-killed turn silently: no `type:'error'` event, `stream.end()` still called, `persistState` still runs.
- Stop post-abort tier retries with early `options.signal?.aborted` checks (locked in research checkpoint).
- Gate the three handler tails that touch ctx after an internal await (locked in research checkpoint).
- Add a mid-turn replacement regression test as the acceptance bar.

**Constraints:**
- Hard: the flag must not enter `RouterPersistedState`. A persisted `true` would disable the UI of the new instance forever.
- Hard: `withSession` has no call site here. The router never initiates a replacement.
- Hard: keep the silent no-op for persistence. No flush in `session_shutdown` (locked in research checkpoint).
- Soft: pi session-lifecycle hooks are not stable API. Commit `2b8e6862` removed two of them before.
- Soft: coding standards ban `any`, require arrow functions, and require top-level static imports.

**Success criteria:**
- No `type:'error'` event when the ctx dies mid-stream.
- At least one `text_delta` processed before death proves mid-turn execution.
- The `'end'` callback fires and `persistState` runs once.
- Recovery: the next live event delivers a fresh ctx and the flag clears.

## Current State

**Existing implementation:**
- `captureCtx` at `extensions/index.ts:70-79` captures ctx, registry, and cwd on every event. Its catch keeps the last values on a stale throw.
- The provider stream at `extensions/provider.ts:277-746` holds the captured state across the whole turn. `state.lastExtensionContext` is a plain closure getter.
- The stream IIFE catch at `extensions/provider.ts:730-739` pushes a `type:'error'` event on any throw. This is the user-visible bug path.
- The tier chain at `extensions/provider.ts:705-721` retries the next model after any per-candidate failure, including aborts.

**Relevant patterns:**
- Boolean latch in the closure: `extensions/index.ts:57-59` — used in 3 places (`isInitialized`, `isInternalModelSwitch`, `isInternalThinkingChange`).
- Stale swallow with comment: `extensions/index.ts:188-191` — used in 3 places total (`:75-78`, `:188-191`, `:455-457`).
- Event-handler registration: `extensions/index.ts:527-614` — used in 5 places. Each handler starts with `captureCtx(ctx)`.
- Conditional gate on ctx truthiness: `extensions/provider.ts:465`, `:587`, `:703` — used in 3 places. The new gates extend these conditions.

**Integration points:**
- `extensions/provider.ts:587-594` — reported user-error site. Reads `ctx.ui.setHiddenThinkingLabel`.
- `extensions/provider.ts:463, 465-466, 703-704` — the other direct stale-throw sites in the stream.
- `extensions/provider.ts:334, 548` — post-await race windows (classifier and auth).
- `extensions/index.ts:138-141` — `recordDebugDecision` notify. Unguarded ctx read.
- `extensions/index.ts:536-540, 569-572, 584` — handler tails after internal awaits.
- `extensions/index.ts:273-281` — `switchToRouterProfile` tail. Reached from `extensions/commands.ts:222, 684`.
- New `pi.on('session_shutdown')` — not registered anywhere today. The flag set point.
- `extensions/provider.ts:166-189` and `extensions/index.ts:284-338` — state and actions surfaces that carry the flag to the provider.

## Solution Options

### Option 1: Dead-flag gate
**How it works:**
Declare one boolean beside the closure captures. Set it in the `captureCtx` catch and in a new `session_shutdown` handler. Clear it in the `captureCtx` try block. Gate every ctx-derived read before the read, and re-verify liveness after each await boundary. In the stream IIFE catch, classify stale-message throws and `AbortError` as benign silent termination.

**Pros:**
- Strongest precedent fit. Every mechanism class already runs in this file pair: boolean latches (`extensions/index.ts:57-59`), ctx truthiness gates at exactly the three gate sites (`extensions/provider.ts:465, 587, 703`), and swallow-with-comment catches with commit provenance (`f67a7850`, `4ae87431`, `cdcfe2eb`).
- Matches every locked research decision: full-seam scope, session_shutdown invalidation, benign classification, abort checks, handler-tail gates.
- Safe ordering by construction. pi emits `session_shutdown` before invalidation, and awaits every handler. The flag turns true before the ctx dies, so no false-negative window exists.
- The flag never persists. It stays out of `RouterPersistedState` (`extensions/types.ts:121`) and `buildPersistedState` (`extensions/state.ts:223-251`).
- Stops post-abort tier retries. Existing fallback tests pass no signal, so none break.

**Cons:**
- The `session_shutdown` registration is new vocabulary. No handler for it exists today.
- One novel test construct is required: a manually resolved promise gate for the mid-turn window.
- The killed turn loses its final persist delta. The FRD accepts this loss.
- On reload, the delegated stream runs to completion with gated UI reads. The status line freezes for that turn.

**Complexity:** Medium (~1 day)
- Files to create: 0
- Files to modify: 4 (`extensions/index.ts`, `extensions/provider.ts`, and the two test files)
- Risk level: Low

### Option 2: Safe-ctx wrapper facade
**How it works:**
Wrap the captured ctx in a facade. The facade probes a throwing getter at access time and returns inert no-ops when dead. Call sites stay unchanged. The guards collapse into the wrapper.

**Pros:**
- Smallest touch on the ctx path. About 40 to 60 added lines in 1 to 2 files. `extensions/provider.ts` needs zero changes.
- About 17 call sites become safe with zero edits at the calls.
- Staleness becomes a synchronous property of a mock object. Most timing windows collapse in tests.

**Cons:**
- A probe-then-use race remains. A replacement between the probe and the call still throws. The stream IIFE catch must classify the throw anyway, so the wrapper alone is incomplete.
- The inert `ui` must be an object, not `undefined`. `extensions/provider.ts:589` reads `.ui.setHiddenThinkingLabel` and throws on `undefined`.
- A false-dead probe freezes status updates for the whole session.
- Identity-sensitive test assertions can break if the wrapper swaps function identity while alive (`extensions/index.test.ts:175, 197, 576`).
- The `pi` facade is not a ctx read. `syncPiThinkingLevel` at `extensions/index.ts:91-98` needs its own gate regardless.
- No wrapper or proxy pattern exists in the repo. New vocabulary.

**Complexity:** Medium (~1 day with the required IIFE backstop)
- Files to create: 1 (optional factory module)
- Files to modify: 1 to 2
- Risk level: Medium

### Option 3: Event-driven re-capture indirection
**How it works:**
The stream never holds ctx for side effects. Side effects go through a resolver that probes the newest live ctx at call time, fed by the existing five handlers. If no live ctx exists, skip or defer the effect.

**Pros:**
- Correctness by construction for the read path. Reads only resolve event-delivered ctx.
- `captureCtx` is a miniature of this pattern. The refresh-on-event shape has test coverage at `extensions/index.test.ts:109-146`.

**Cons:**
- The anchor premise is refuted. `before_provider_request` does not fire for `router/*` dispatch. pi compat resolves `router-local-api` straight to the provider closure. The comments at `extensions/index.ts:521-526` and `extensions/provider.ts:284-289` are wrong.
- Every side effect before delegation reads a ctx captured one event ago. The resolver needs a probe anyway, so it absorbs Option 2's mechanism.
- The resolver cannot revive a dead `pi` facade. `syncPiThinkingLevel` still needs a gate.
- A signature change on `updateStatus` ripples into 7 command sites (`extensions/commands.ts:206, 249, 275, 366, 417, 458, 475`) and the handler tails unless parameters become optional.
- The tier chain still retries after abort, and the final error event path stays untouched.
- Largest restructure: the `lastExtensionContext` getter leaves the provider-facing type.

**Complexity:** High (~2 days)
- Files to create: 0
- Files to modify: 3 to 4
- Risk level: Medium-High

### Option 4: Catch-only classification
**How it works:**
Add one helper that matches the stale message prefix and `AbortError`. Wrap each known ctx touch in a narrow try/catch. The IIFE catch gains one benign branch. No flag, no handler, no gates.

**Pros:**
- Smallest diff: about 30 to 40 lines in 2 files, or about 55 to 65 lines with the full-seam extension.
- Strongest direct precedent. 13 catch-and-continue sites exist. 3 are stale-specific.
- Fixes one current bug for free: a stale notify at `extensions/provider.ts:727` pushes `type:'error'` after a successful stream today.

**Cons:**
- Contradicts the locked research decision on aborts. No `options.signal?.aborted` check means the tier chain still walks every candidate after an abort.
- Nothing marks the ctx dead. Stale throws recur per iteration and repeat on every later turn.
- The stated shape leaves the handler tails unguarded. That fails the locked full-seam scope.
- Message-prefix classification is new vocabulary. All current swallows are blind catches.

**Complexity:** Low (~0.5 day)
- Files to create: 0
- Files to modify: 2
- Risk level: Medium-High

## Comparison

| Criteria | Option 1: Dead-flag gate | Option 2: Safe-ctx wrapper | Option 3: Re-capture indirection | Option 4: Catch-only |
|----------|--------------------------|----------------------------|----------------------------------|----------------------|
| Complexity | Medium | Medium | High | Low |
| Codebase fit | High | Medium | Low-Medium | High |
| Risk | Low | Medium | Medium-High | Medium-High |
| Meets locked decisions | All | Most | Few | Contradicts abort decision |
| Full-seam coverage | Yes | Partial | Partial | No as stated |

## Recommendation

**Selected:** Option 1 — Dead-flag gate

**Rationale:**
- Every mechanism class already runs in this codebase under test: boolean latches at `extensions/index.ts:57-59`, ctx gates at the exact three gate sites (`extensions/provider.ts:465, 587, 703`), and swallow catches with proven commit history (`f67a7850` needed zero follow-ups in 30 days).
- The set order is safe. pi emits `session_shutdown` before invalidation and awaits every handler (`pi core/agent-session-runtime.js:102-113`, `pi core/extensions/runner.js:579-611`). The flag turns true early, so the gate never reads a dead ctx as live.
- It satisfies every locked research decision in one shape: full-seam scope, handler-tail gates, abort checks, benign classification, and the persistence no-op.
- The flag stays runtime-only. No persisted state, no config, no new dependency, no pi-version constraint inside `extensions/`.

**Why not alternatives:**
- Option 2: the wrapper alone leaves a probe-then-use race, so it still needs the Option 1 catch classification. The hybrid adds a new proxy vocabulary and identity risk on top of the same core work.
- Option 3: it leans on the refuted `before_provider_request` anchor, ripples signatures into 7 command sites, and leaves the abort retries untouched. Largest restructure for a subset of the guarantees.
- Option 4: it contradicts the locked abort decision, leaves the handler tails broken, and lets stale throws recur every turn. Its best parts — the prefix helper and the benign IIFE branch — are already parts of Option 1.

**Trade-offs:**
- Accepting a silent killed turn and a swallowed final persist delta for a zero-churn gate design. The research bounds the loss: the killed turn's `lastDecision` and `accumulatedCost` deltas.
- Accepting a frozen status line on reload for that turn. The next live capture clears the flag and restores updates.
- Accepting message-prefix coupling to pi. If pi changes the wording, the failure direction stays visible: the throw falls through to the error event.

**Implementation approach:**
1. Flag core — declare the boolean beside `extensions/index.ts:54`, wire set and clear into `captureCtx` (`:71-78`), and register the `session_shutdown` handler beside the existing five (`:527-614`).
2. Provider gates — add the field to the inline state type (`extensions/provider.ts:166-189`), add liveness and abort re-verification after the classifier await (`:334`) and the auth await (`:548`), extend the fallback condition (`:703-704`), and add the benign branch to the IIFE catch (`:730-739`).
3. Orchestrator gates — extend the `recordDebugDecision` condition (`extensions/index.ts:119`) and gate the four tails (`:275-281`, `:536-540`, `:569-572`, `:584`).
4. Tests — add the mid-turn deferred-gate suite in `extensions/provider.test.ts`, and the registration, stale-drive, and recovery tests in `extensions/index.test.ts`.

**Integration points:**
- `extensions/index.ts:54-59` — flag declaration beside the sibling latches.
- `extensions/index.ts:70-79` — `captureCtx` set and clear.
- `extensions/index.ts:527-614` — sixth handler registration and the three tail gates.
- `extensions/index.ts:138-141` — notify gate. The history push at `:118` stays ungated because restore reads it at `:393-394`.
- `extensions/index.ts:284-338` — one new getter beside `get lastExtensionContext()` at `:300-302`.
- `extensions/provider.ts:166-189` — one new readonly field on the state type.
- `extensions/provider.ts:334, 548` — post-await liveness and abort re-verification.
- `extensions/provider.ts:703-704` — fallback condition extension.
- `extensions/provider.ts:730-739` — benign classification branch.

**Patterns to follow:**
- Boolean latch with try/finally toggles: `extensions/index.ts:57-59, 80-97`.
- Stale swallow with explanatory comment: `extensions/index.ts:188-191`.
- Handler registration with leading `captureCtx(ctx)`: `extensions/index.ts:527-614`.
- Early-return benign termination: `extensions/provider.ts:299-301`.

**Risks:**
- pi hook instability: commit `2b8e6862` removed deprecated hooks before. Mitigation: pin the pi version and verify the `session_shutdown` contract on upgrade.
- Message prefix drift in pi: mitigation is none needed for safety. A mismatch degrades to the visible error path, which fails loud, not silent.
- Mock tests cannot verify pi's real emission order: mitigation: keep the manual verification list below as the release gate for this fix.

## Scope Boundaries

**What we are building:**
- One runtime flag, one new event handler, gates at the mapped ctx-derived read sites, benign classification in the stream catch, and regression tests.

**What we are NOT doing:**
- No `withSession` restructure. The router never initiates a replacement.
- No persistence flush in `session_shutdown`.
- No structural registry fix. `modelRegistryFallback` and `turn_start` capture from `.rpiv/artifacts/designs/2026-08-30_09-02-24_registry-guard-structural-fix.md` stay unbuilt.
- No wrapper or proxy layer around ctx.
- No changes to `extensions/ui.ts`, `extensions/state.ts`, `extensions/types.ts`, or the delegation bridge at `extensions/provider.ts:607-616`.

## Testing Strategy

**Unit tests:**
- Flag lifecycle: the `captureCtx` catch sets the flag, the try block clears it, and the orphan closure keeps it set.
- `session_shutdown` registration asserted beside the existing block at `extensions/index.test.ts:91-108`.
- Stale drive with the existing getter pattern (`extensions/index.test.ts:126-133`), then recovery through a fresh `session_start` (`:142-146`).
- Benign classification: a stale-prefix throw and an `AbortError` fixture (`Object.assign(new Error('aborted'), { name: 'AbortError' })`) both end the stream with no `type:'error'` event.
- Abort stops tier retries: throw `AbortError` from the mocked primary model and assert the fallback model is not attempted. The existing retry test at `extensions/provider.test.ts:174-217` stays as the negative control.
- A non-matching error still surfaces. This proves the classification does not mask real failures.

**Integration tests:**
- Mid-turn replacement: a manually resolved promise gate inside the compat `streamSimple` mock holds the IIFE at the `for await` at `extensions/provider.ts:636`. Flip the flag, release the gate, then assert: no `type:'error'` event, at least one `text_delta`, the `'end'` callback resolved, and `persistState` ran once.
- Death during the auth await at `extensions/provider.ts:548`: gate `getApiKeyAndHeaders`, flip the flag, assert no read at `:587-594` and a benign end.
- Death during the fallback loop: combine a stale ctx with the fallback fixtures to cover `:703-704`.

**Manual verification:**
- [ ] Run pi with `router/auto`, start a generation, run `/new` mid-stream. Confirm no error surface and a silent turn end.
- [ ] Repeat with `/fork` and a session switch.
- [ ] Repeat with a reload mid-stream.
- [ ] After each replacement, confirm the status line updates again on the next turn. This proves flag recovery.

## Open Questions

**Resolved during research:**
- Does the registry snapshot throw stale? No. The raw `ModelRegistry` has no stale check. Guards re-anchor to the ctx-derived sites only.
- Does pi abort the in-flight run before `session_shutdown`? Yes on new, fork, switch, import, and quit. Only reload never aborts. The guards compose with abort through the signal checks.
- Are the handler tails in scope? Yes. Same flag, four gate sites.
- Does a flush belong in `session_shutdown`? No. The killed stream is still mid-flight, and fork and new never read the old file.

**Requires user input:**
- None. All branches resolved in the research checkpoint.

**Blockers:**
- None.

## References

- `.rpiv/artifacts/research/2026-09-04_10-46-35_stale-ctx-session-replacement.md` — input research. Seam census, lifecycle ground truth, and locked decisions.
- `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md` — FRD for this fix.
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — refutes the `before_provider_request` anchor for `router/*` dispatch.
- `.rpiv/artifacts/designs/2026-08-30_09-02-24_registry-guard-structural-fix.md` — structural registry fix that never landed. Do not plan against it.
- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — prior root-cause review.
- `extensions/index.ts:57-59` — boolean latch pattern.
- `extensions/index.ts:188-191` — stale swallow precedent, commit `f67a7850`.
- `extensions/index.ts:70-79` — `captureCtx`, commits `4ae87431`.
- `extensions/provider.ts:607-616` — delegation bridge `.bind` requirement, commit `cdcfe2eb`.
- `pi docs/extensions.md:516-521, 1247-1251, 1300-1308` — `session_shutdown` contract, `withSession` footguns, reload semantics.
