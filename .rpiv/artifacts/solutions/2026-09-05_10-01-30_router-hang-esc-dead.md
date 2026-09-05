---
date: 2026-09-05T10:01:30+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Spinner hang + dead ESC after router changes: provider slowness vs regression"
confidence: high
complexity: medium
status: ready
verdict: pass
tags: [solutions, provider, routing, classifier, abort]
last_updated: 2026-09-05T10:01:30+0700
last_updated_by: Yogiswara Utama
---

# Solution Analysis: Spinner hang + dead ESC — provider slowness vs router regression

**Date**: 2026-09-05T10:01:30+0700
**Author**: Yogiswara Utama
**Commit**: d793dbde
**Branch**: main
**Repository**: pi-model-router

## Research Question

"By my latest changes in this project, does it introduce a new bug? Currently the LLM stays '⠧ Working...' too long. I cannot cancel with ESC. The provider is too slow. Also an error appeared: 'Router provider has no model registry: no ctx was captured before this stream.'"

## Summary
**Problem**: Turns hang at the spinner for a long time. ESC does not cancel. One turn errored with the no-registry guard message.
**Recommended**: Fix Option 2 — push a terminal event on every silent exit, and forward `signal` plus `timeoutMs` into the classifier call.
**Effort**: Low-Medium (~1 day)
**Confidence**: High (mechanisms demonstrated in source)

## Problem Statement

**Requirements:**
- ESC must cancel any in-flight router turn.
- A slow provider must not hold the spinner past a bounded time.
- The router must not error with "no model registry" on requests that follow pi's real event order.

**Constraints:**
- Extension-first: no changes to pi core.
- The user runs pi 0.84.3 (`C:/Users/utama/AppData/Local/nvm/v24.14.0/node_modules/@earendil-works/`). The repo's `node_modules` pins 0.80.1 for type checks only.
- settings.json loads the router directly from `H:\fork\pi-model-router`, so the user runs HEAD code.

**Success criteria:**
- ESC ends the turn within seconds, always, with a visible or benign outcome.
- A stalled candidate model costs at most `timeoutMs`, then falls back.
- No spurious "router extension bug" error after session reload or subagent races.

## Current State

**Environment facts (decisive):**
- Running pi = 0.84.3. Repo tests run against 0.80.1. `ModelRuntime` exists only in 0.84.3 (`pi-coding-agent/dist/core/model-runtime.js:26`).
- Live config `~/.pi/agent/model-router.json`: HIGH `glm-53` chain, MEDIUM 13 candidates, `debug: true`. Classifier = `ds-flash`. Every routed model resolves to a compat-registered api (`openai-completions` via ollama-cloud/zai-paas/nube, plus `mistral-glm-api` registered by the extension).

**Existing implementation (with evidence):**
1. **Silent exits end the stream bare.** Three guards plus a swallow path call `stream.end()` with no event: post-classifier (`extensions/provider.ts:354-356`), loop-top (`:545-547`), post-auth (`:576-578`), and the benign catch for `AbortError`/stale-ctx (`:772-786`). Added in `d793dbde`.
2. **pi waits forever on a bare-ended stream.** `EventStream.result()` resolves only on a `done`/`error` event or `end(result)` (`pi-ai/dist/utils/event-stream.js:17-36`). The agent loop does `await response.result()` at `pi-agent-core/dist/agent-loop.js:240`. `isStreaming` stays true (`agent-session.js:511-512`), the spinner shows while streaming (`interactive-mode.js:1341-1361`), and ESC only signals an already-aborted controller (`agent.js:196-198`, `interactive-mode.js:3145-3146`).
3. **The capture invariant is false in 0.84.3.** The extension event `before_provider_request` fires from `onPayload` inside builtin api calls (`pi-coding-agent/dist/core/sdk.js:200-206`). Compat calls the router's registered provider directly without `onPayload` (`pi-ai/dist/compat.js:189-193`). So no event guarantees a capture before the router's own `streamSimple`. After a reload, `session_start` is emitted only `if (hasBindings)` (`agent-session.js:1963`) — one race window that produces the no-registry error.
4. **Classifier call has no signal and no timeout.** `extensions/routing.ts:746-750` passes only `apiKey`, `headers`, `reasoning`. First abort read is after the await (`provider.ts:354`). SDK caps each ref at 10 minutes (`node_modules/openai/client.js:573`); refs run sequentially.
5. **Auth await carries no signal.** `provider.ts:570-572`. Bounded at 10 s for command keys; unbounded only for expired OAuth (`auth-storage.js:351, :395`).
6. **Delegation path is signal-complete and unchanged.** `agent-loop.js:192` → `provider.ts:629-630` → `compat.js:170-175` → `api/openai-completions.js:110-113`. The last 4 commits did not touch the executed delegation lines. ESC aborts the delegated fetch, and builtin apis push `error` with `stopReason: "aborted"` (`openai-completions.js:346-348`) — that path ends cleanly.
7. **ModelRuntime branch is unreachable for this config.** It requires `!hasCompatApi` (`provider.ts:639`). All live models have compat entries. And 0.84.3's `ModelRuntime.streamSimple` forwards `signal` into auth and the provider call anyway (`model-runtime.js:429`, `:445-465`). Candidate refuted.

**Relevant patterns:**
- No-registry guard: pushes an error event before `end()` (`provider.ts:296-311`). This turn ends visibly. It is the correct terminal-event pattern.
- Builtin abort handling: error event with `stopReason: "aborted"` → clean stop at `agent-loop.js:107`.

**Integration points:**
- `extensions/provider.ts:354,545,576,772-786` — the silent exits.
- `extensions/routing.ts:746-750` — classifier stream options.
- `extensions/provider.ts:629-630` — `delegationOptions` (add `timeoutMs` here).
- `extensions/index.ts:547-557` — capture/dead-flag anchors.

## Solution Options

### Option 1: Terminal event on every silent exit (minimal)
**How it works:**
Replace each bare `stream.end()` with an error-event push before `end()`, mirroring the no-registry guard. For the abort windows, push a benign error event (for example "Turn cancelled."). In the catch, stop swallowing `AbortError` silently; push the same benign event. pi then stops cleanly at `agent-loop.js:107` and `isStreaming` clears.

**Pros:**
- Restores ESC with the smallest diff. Four sites, one pattern each.
- Uses the pattern the codebase already has (`provider.ts:296-311`).
- Tests exist for the current behavior and will pin the new one (`provider.test.ts:1063, :1078-1080, :1148-1150` assert "Silent end: no error event" — flip those assertions).

**Cons:**
- Does not bound the spinner for slow providers.
- Does not fix the no-registry error.

**Complexity:** Low (~0.5 day)
- Files to modify: 1 (`extensions/provider.ts`, ~40 lines)
- Files to modify: 1 test (`extensions/provider.test.ts`)
- Risk level: Low

### Option 2: Option 1 + signal and timeout plumbing (recommended)
**How it works:**
Add Option 1. Then thread `options.signal` and a `timeoutMs` into the classifier `streamSimple` call (`routing.ts:746-750`). Add `signal` and per-candidate `timeoutMs` to the delegated call through `delegationOptions` (`provider.ts:629-630`). Also accept `signal` in `runClassifier` and pass it through.

**Pros:**
- ESC kills the classifier fetch immediately. The long-spinner worst case drops from N×10 minutes to N×`timeoutMs`.
- Uses fields pi-ai already supports (`types.d.ts:47`, `:88`). No new abstractions.
- Bounds the spinner even when the provider is genuinely slow — the user's original complaint.

**Cons:**
- Slightly wider surface: three files.
- `timeoutMs` needs a default value picked (suggest 120 s per candidate, configurable).

**Complexity:** Low-Medium (~1 day)
- Files to modify: 2 (`extensions/provider.ts`, `extensions/routing.ts`)
- Files to modify: 1 test file
- Risk level: Low

### Option 3: Full hardening (contract repair + budget)
**How it works:**
Add Option 2. Then repair the capture contract: capture ctx on `turn_start` as well (fires before turn requests), and tolerate the reload race by waiting briefly for a registry in the guard (poll up to ~2 s) instead of erroring at once. Optionally add a tier-level wall-clock budget across the candidate chain.

**Pros:**
- Removes the spurious "router extension bug" error.
- One bounded retry covers subagent races without pi-core changes.

**Cons:**
- The 2-second poll is a workaround for a pi-core edge (`session_start` skipped when no bindings). Mark it with a `ponytail:` comment.
- Largest diff; touches `index.ts` event wiring.

**Complexity:** Medium (~2 days)
- Files to modify: 3
- Risk level: Medium

## Comparison

| Criteria | Option 1 | Option 2 | Option 3 |
|----------|----------|----------|----------|
| Complexity | Low | Low-Med | Medium |
| Codebase fit | High | High | Medium |
| Risk | Low | Low | Medium |
| Fixes ESC dead | Yes | Yes | Yes |
| Bounds slow provider | No | Yes | Yes |
| Fixes no-registry error | No | No | Yes |

## Recommendation

**Selected:** Option 2

**Rationale:**
- ESC-dead is a demonstrated regression from `d793dbde` (silent exits at `provider.ts:354,545,576,772-786` against `agent-loop.js:240`). Option 1's terminal events fix it with an existing pattern.
- The long spinner is provider slowness on a timeout-free path (10-minute SDK cap per ref, 13 MEDIUM candidates). Signal plus `timeoutMs` plumbing bounds it with fields pi-ai already supports.
- The ModelRuntime delegation path is exonerated: signal forwards correctly and the branch never runs for the live config.

**Why not alternatives:**
- Option 1: leaves the user's primary complaint (long spinner) unbounded.
- Option 3: the poll-for-registry workaround papers over a pi-core edge; ship it only if the no-registry error recurs after Option 2. Track it as a follow-up.

**Trade-offs:**
- Accepting a visible "Turn cancelled." message instead of silent termination, for a spinner that always ends.

**Implementation approach:**
1. Replace the three bare `stream.end()` exits and the catch swallow with error-event pushes (`provider.ts`).
2. Flip the "Silent end: no error event" test assertions to expect the terminal event.
3. Thread `signal` + `timeoutMs` into `runClassifier` (`routing.ts`) and `delegationOptions` (`provider.ts`).
4. Add a config default for per-candidate `timeoutMs` (suggest 120 s).
5. Re-run `detect_changes` after the edits; run the vitest suite.

**Integration points:**
- `extensions/provider.ts:354-356, :545-547, :576-578, :772-786` — terminal events.
- `extensions/routing.ts:746-750` — classifier signal/timeout.
- `extensions/provider.ts:629-630` — `delegationOptions` timeout.

**Patterns to follow:**
- No-registry guard error push: `provider.ts:296-311`.
- Builtin abort event: `api/openai-completions.js:346-348`.

**Risks:**
- Tests pin the old silent behavior: update them in the same change.
- pi 0.84.3 vs repo 0.80.1 drift: verify signal behavior against the nvm install, not repo node_modules.

## Scope Boundaries
- Building: terminal events on all router stream exits; signal and timeout plumbing for classifier and delegation.
- Not doing: pi-core changes; ModelRuntime branch changes (exonerated); capture-contract poll (deferred to Option 3 if the error recurs).

## Testing Strategy

**Unit tests:**
- Each guard exits with a terminal error event, not a bare end.
- Catch pushes a benign event for `AbortError`.
- Classifier receives `signal` and `timeoutMs` in its stream options.

**Integration tests:**
- Abort mid-classifier: stream ends within one tick, turn terminates.
- Slow candidate: aborts at `timeoutMs`, falls through to the next candidate.

**Manual verification:**
- [ ] Point the classifier at a slow model, press ESC during the wait, confirm the spinner clears.
- [ ] `/router debug show` after a cancelled turn shows no stuck state.
- [ ] Reload extensions mid-session, send a prompt, confirm no no-registry error (or only the deferred known one).

## Open Questions
**Resolved during research:**
- "Provider or my change?" — Both. Provider slowness causes the long spinner (no regression there; delegation path unchanged and signal-complete). The dead ESC is a regression from `d793dbde` silent exits. The no-registry error comes from `4ae87431`'s false invariant about `before_provider_request` in 0.84.3.
- "Is the ModelRuntime delegation buggy?" — No. It forwards `signal` (`model-runtime.js:429`, `:445-465`), and the branch is unreachable for the live config.

**Requires user input:**
- Default per-candidate `timeoutMs` (assumed 120 s).
- Whether the no-registry error recurs often enough to justify Option 3 now.

**Blockers:**
- None.

## References
- `pi-agent-core/dist/agent-loop.js:240` — the unresolvable await on bare end.
- `pi-ai/dist/utils/event-stream.js:17-36` — result resolution rules.
- `pi-coding-agent/dist/core/sdk.js:200-206` — where `before_provider_request` actually fires.
- `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` — the change that introduced the silent exits.
- `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md` — prior design context.
