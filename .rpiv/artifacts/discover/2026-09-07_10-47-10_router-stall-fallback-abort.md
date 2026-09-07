---
date: 2026-09-07T10:47:10+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Router stall watchdog — timeout, fallback on silence, Esc abort"
tags: [intent, frd, provider, routing, classifier, abort, fallback]
status: ready
last_updated: 2026-09-07T10:47:10+0700
last_updated_by: Yogiswara Utama
---

# FRD: Router stall watchdog — timeout, fallback on silence, Esc abort

## Summary

When a backend API call stalls silently (connection open, zero events), the router waits forever — the turn hangs at "Working...", Esc is dead, and only `/quit` recovers. The fix adds an inactivity watchdog to every external wait in the per-turn path (classifier call, delegated model stream, API-key fetch): 90 seconds of silence counts as a stall, the stalled model is cancelled, and the existing fallback chain takes the next model. The abort signal is threaded through every wait so Esc always cancels.

## Problem & Intent

Developer's words: "when using multiple pi coding agent instance, and use this project sometimes it stuck in Working... it seems hang as is does not continue anymore", "pressing esc is not respected. i need to call /quit", and "also there is fallback model, instead of waiting, so be call fallback model".

Desired outcome (picked in interview, all three): **it never hangs, it recovers itself, Esc always works**.

Evidence from the hung session (`pi-session-2026-09-07T03-22-05-586Z_*.html`, cwd `H:\tuntun\aop`, `router/auto`): last entry is a `toolResult` at 03:39:02; the next turn never started. Every decision was classifier-driven (6/6, `zai-paas/glm-5.3`). Root cause chain:

- `runClassifier` (`extensions/routing.ts:698-783`) is awaited inside the turn's stream IIFE (`extensions/provider.ts:341`) and opens its `streamSimple` **without `options.signal`** (`routing.ts:746-750`). A stalled classifier stream parks the `for await` forever.
- Pi core aborts **only** via `options.signal` (`pi-agent-core/dist/agent.js:196-197`, `agent-loop.js:189-196`); it never destroys the returned event stream. Signal never reaches the classifier stream → Esc does nothing.
- The main delegated stream already forwards signal (`provider.ts:629-630,652-665`) and pi-ai honors it in fetch/SSE (`openai-completions.js:111`, `anthropic-messages.js:269-275`) — but a silent stall never errors, and the fallback loop (`provider.ts:625`) only advances on **thrown errors**, never on silence.
- `getApiKeyAndHeaders` → OAuth refresh has no signal/timeout either (`provider.ts:~507`; `auth-storage.js:374-417`).
- Multi-instance correlation: shared `~/.pi/auth.json` lock (`auth-storage.js:90-103,158`, 10 retries × 10 s) plus N instances × (classifier + main call) on one API key — upstream stalls become likely under concurrent load.

## Goals

- No turn hangs forever: every external wait in the per-turn path is bounded by a stall timeout.
- A silent stall triggers the **existing fallback chain** — the router switches models instead of waiting; the user never sees a forever-"Working..." state.
- Esc always cancels: the abort signal reaches every in-flight wait and the turn ends cleanly, no `/quit` needed.
- Every stall-triggered fallback is visible as one short line in the chat.

## Non-Goals

- Fixing upstream provider/proxy stall behavior (zai-paas under concurrent load) — defended against, not fixed.
- Changing tier routing logic, classifier prompt, or classifier accuracy.
- Redesigning cross-instance `~/.pi/auth.json` locking — recorded as follow-up.
- Any pi-core modification — extension-only changes.

## Functional Requirements

1. The system SHALL treat **zero stream events for `stallTimeoutMs`** (default 90000) as a stall. The watchdog is an inactivity timer: every event (`text_delta`, `thinking_delta`, `toolcall_delta`, `toolcall_end`) resets it.
2. On a main-model stream stall, the system SHALL cancel the stalled stream and continue the existing fallback chain (next model in tier, then cross-tier) exactly as a thrown error does today.
3. On a classifier stall, the system SHALL try the next classifier fallback ref; when all refs stall or fail, the system SHALL proceed with heuristic routing (`decideRouting` without a classifier result). The turn never blocks on the classifier.
4. The system SHALL pass `options.signal` into the classifier `streamSimple` call and race abort against every await in the per-turn path (classifier, auth fetch, delegated stream). On abort, the router stream SHALL end cleanly with no error event — matching the existing benign-abort handling (`provider.ts:774-775`).
5. The system SHALL bound `getApiKeyAndHeaders` (including the OAuth refresh path) by the same stall timeout; on timeout, skip to the next candidate/fallback instead of hanging.
6. On any stall-triggered fallback, the system SHALL push one short user-visible line (for example: `glm-5.3 stalled 90s — switched to glm-5.3-flash`) and record the stall in router debug history and decision reasoning.
7. `stallTimeoutMs` SHALL be an optional top-level key in `model-router.json`. Absent → 90000. Invalid (non-positive, non-number) → normalized to the default with existing config normalization.

## Non-Functional Requirements

- **Performance**: zero added latency on healthy streams — the watchdog only resets timers per event; no extra network calls.
- **Reliability**: stall handling reuses the existing error/fallback path — no new failure modes; abort exits are silent (no error surfaced to the agent loop).
- **UX**: stall notes are one line, plain, no stack traces; "Working..." never exceeds `stallTimeoutMs` without visible progress.
- **Security**: no new network surface; only signal propagation and timers.

## Constraints & Assumptions

- Extension-only: changes live in `extensions/provider.ts`, `extensions/routing.ts`, `extensions/config.ts`. No pi-core edits.
- `StreamOptions.signal` exists in pi-ai (`pi-ai/dist/types.d.ts:44-47`) and compat forwards it verbatim (`compat.js:140-146,170-175`).
- Assumption for research to verify: pi-ai SSE read loops honor an already-aborted signal on a connection that stalls mid-body (openai-completions re-checks per read — confirm).
- The multi-instance trigger is assumed external (shared API-key load + `auth.json` lock contention); the router only defends, it does not prevent upstream stalls.
- Session evidence grounds the classifier as the primary hang point; the same defense is applied to all three wait classes regardless.

## Acceptance Criteria

- [ ] Test: a fake stream that emits no events falls back at `stallTimeoutMs` — the next model in the tier chain streams, and the one-line stall note is pushed.
- [ ] Test: classifier stream stalls → next classifier ref tried → all refs stall → heuristic routing used, turn completes.
- [ ] Test: `options.signal` aborted mid-classifier-await → router's outer stream ends immediately with no error event.
- [ ] Test: `getApiKeyAndHeaders` exceeds the stall timeout → next candidate model tried.
- [ ] Test: `stallTimeoutMs` absent in config → 90000; invalid value → 90000 after normalization.
- [ ] Manual: point a profile at a stalling endpoint (e.g. a listener that accepts and never responds) — "Working..." resolves within ~90 s via fallback, the stall note appears, and Esc during the stall cancels immediately.
- [ ] `npm run build` and the extension test suite pass with no regressions to existing fallback/error tests.

## Recommended Approach

One shared inactivity-watchdog helper (timer reset per event / per-await tick, `Promise.race` against timeout and abort) reused in three places: the classifier stream loop in `routing.ts`, the delegated-stream `for await` in `provider.ts` (stall → throw → existing fallback chain), and the auth-fetch await. Thread `options.signal` into `runClassifier` and race abort in the stream IIFE. Stall fallbacks push a one-line custom message and enrich `decision.reasoning`/debug history. Config gains the single `stallTimeoutMs` knob in `config.ts` normalization.

## Decisions

### Fix scope — all four defect-class parts
**Question**: Pre-resolved from codebase evidence — confirmed in Step 4. "I found three places where a stalled API call can hang the turn forever with no timeout and no Esc, plus Esc-propagation. Which are in scope?"
**Recommended**: All four (classifier hang, silent-stall→no-fallback, auth-fetch hang, Esc-cancels-everything) — same defect class: a wait with no timeout and no abort.
**Chosen**: All four.
**Rationale**: evidence: `routing.ts:746-750` (no signal), `provider.ts:625` (fallback only on error), `provider.ts:~507` (unbounded auth await), `pi-agent-core/dist/agent.js:196-197` (abort only via signal) + confirmed.

### Stall timeout value
**Question**: How long with zero data before a model counts as stalled?
**Recommended**: 90 seconds, one config knob `stallTimeoutMs`.
**Chosen**: 90 seconds.
**Rationale**: reasoning models stream continuous small updates, so a 90 s gap is a real stall, not slow thinking.

### Stall visibility
**Question**: When a stall fires and the router switches models, how visible is it?
**Recommended**: One-line note in chat.
**Chosen**: One-line note.
**Rationale**: the user's pain is silent hangs — an invisible fallback hides both the fault and the model actually answering.

### Classifier stall behavior
**Question**: If the tier-classifier call itself stalls, what happens?
**Recommended**: Next classifier ref → built-in rules.
**Chosen**: Next ref → rules.
**Rationale**: matches existing classifier infra-failure behavior (returns `undefined` → heuristics) — stall becomes just another failure mode.

### Desired outcome (intent)
**Question**: "When the pi agent gets stuck at 'Working...' and Esc does nothing, what does a good outcome look like?"
**Recommended**: n/a — `intent` question.
**Chosen**: "It never hangs, It recovers itself, Esc always works" (all three).
**Rationale**: developer's own framing; drives all functional requirements above.

## Open Questions

None — all interview branches resolved.

## Suggested Follow-ups

- Cross-instance contention on shared `~/.pi/auth.json` (`auth-storage.js:90-103,158`): bounded (~100 s worst case) but real multi-instance latency — a lock redesign or refresh backoff belongs upstream in pi.
- zai-paas stalls under concurrent load from a single API key: worth measuring/reporting to the provider; the router now defends but cannot prevent.
- pi-claude-bridge returns silent empty completions on malformed foreign tool-call history instead of erroring loudly (known from a prior fix in this fork) — same "fail silently" family, patch to fail loudly someday.

## References

- Input: `pi-session-2026-09-07T03-22-05-586Z_01a079e3-2992-7b1b-91a9-9f830e99e6fa.html` — hung session export (cwd `H:\tuntun\aop`), last entry toolResult 03:39:02.
- `extensions/provider.ts` — `streamSimple` IIFE (277-746), fallback loop, delegation options signal forwarding (629-665).
- `extensions/routing.ts` — `runClassifier` (698-783), signal-less stream open (746-750).
- `extensions/index.ts` — `persistState` (per-session JSONL, not shared).
- Audit citations: `pi-ai/dist/types.d.ts:44-47`, `pi-ai/dist/compat.js:140-175`, `pi-ai/dist/openai-completions.js:111`, `pi-ai/dist/anthropic-messages.js:269-275`, `pi-agent-core/dist/agent.js:196-197,310-320`, `pi-agent-core/dist/agent-loop.js:189-196`, `pi-coding-agent/dist/core/auth-storage.js:90-103,158,374-417`.
