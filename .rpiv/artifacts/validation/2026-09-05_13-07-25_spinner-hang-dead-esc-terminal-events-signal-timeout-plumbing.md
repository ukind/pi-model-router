---
template_version: 1
date: 2026-09-05T13:07:25+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Validation of Spinner hang + dead ESC: terminal events + signal/timeout plumbing"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-05_12-33-55_router-hang-terminal-events.md"
tags: [validation, provider, routing, abort, timeout]
last_updated: 2026-09-05T13:07:25+0700
---

## Validation Report: Spinner hang + dead ESC: terminal events + signal/timeout plumbing

### Implementation Status

- ✓ Phase 1: Config foundation — candidateTimeoutMs field — Fully implemented
- ✓ Phase 2: Terminal events on silent exits — the ESC-dead fix — Fully implemented
- ✓ Phase 3: Classifier signal + timeoutMs plumbing — Fully implemented
- ✓ Phase 4: Delegation timeoutMs plumbing + project checks — Fully implemented

### Automated Verification Results

- ✓ Type checking: `npm run tsc` — exit 0, no errors
- ✓ Full test suite: `npm test` — 7 files, 277 tests passed, 0 failures (superset of Phase 2's scoped `npx vitest run extensions/provider.test.ts` and Phase 4's terminal whole-repo baseline)
- ✓ Phase 1 field wiring: `grep -r "candidateTimeoutMs" extensions/ | wc -l` — 25 (≥6)
- ✓ Phase 2 helper count: `grep -c "createAbortedMessage" extensions/provider.ts` — 5 (≥5)
- ✓ Phase 2 flipped tests: `grep -c "reason === 'aborted'" extensions/provider.test.ts` — 6 (≥6)
- ✓ Phase 2 result() waiter: `grep -c "result()" extensions/provider.test.ts` — 5 (≥5)
- ✓ Phase 2 silent-exit sites: `grep -n -B3 "stream.end()" extensions/provider.ts` — 3 gate sites (385, 583, 620) each preceded by `reason: 'aborted'` + `createAbortedMessage`; catch block (851) push verified by source read (push sits outside the -B3 window due to if/else branching)
- ✓ Phase 3 signature params: `grep -cE "signal\?: AbortSignal|timeoutMs\?: number" extensions/routing.ts` — 2 (≥2)
- ✓ Phase 3 spread: `grep -cE "signal \? \{ signal \}|timeoutMs \? \{ timeoutMs \}" extensions/routing.ts` — 2 (≥2)
- ✓ Phase 3 call site: `grep -c "state.currentConfig.candidateTimeoutMs" extensions/provider.ts` — 2 (≥1)
- ✓ Phase 3 test: `grep -c "callOptions.signal" extensions/routing.test.ts` — 1 (≥1)
- ✓ Phase 4 delegation branches: `grep -c "timeoutMs: candidateTimeoutMs" extensions/provider.ts` — 2 (≥2)
- ✓ Phase 4 test: `grep -c "callOptions.timeoutMs" extensions/provider.test.ts` — 1 (≥1)
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- types.ts:90 — `candidateTimeoutMs?: number` added to RouterConfig
- constants.ts:5 — `DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000`
- config.ts:18,142,427-430,535 — import, merge (`override ?? base`), normalize validation (positive number else default), return field
- config.test.ts:28,150,163,179,281,304,312-326 — import, merge base/override/assertion, normalize raw/assertion, two new default tests (absent + non-positive)
- provider.ts:76-95 — `createAbortedMessage` mirrors `createErrorMessage` with `stopReason: 'aborted'`, zeroed usage
- provider.ts:380-385,578-583,615-620 — 3 silent-exit gates (post-classifier, loop-top, post-auth) each push `{type:'error', reason:'aborted', error: createAbortedMessage(model)}` before `stream.end()` and `return`
- provider.ts:826-851 — catch block branches: stale-ctx (`STALE_CTX_MESSAGE_PREFIX`) or `AbortError` → `aborted` event; else → `error` event via `createErrorMessage`; then `stream.end()`. `finally { actions.persistState() }` intact
- provider.ts:363-372 — runClassifier call site passes `options?.signal` and `state.currentConfig.candidateTimeoutMs` as the last two args
- provider.ts:672-722 — delegation block: `const candidateTimeoutMs = state.currentConfig.candidateTimeoutMs;`; both branches (runtime + compat) spread `...(candidateTimeoutMs ? { timeoutMs: candidateTimeoutMs } : {})` after `...delegationOptions` (compat: after `apiKey`/`headers`), before the `reasoning` spread
- routing.ts:698-709 — runClassifier appends `signal?: AbortSignal,` and `timeoutMs?: number,` before the return type
- routing.ts:747-753 — classifier streamSimple call conditionally spreads `signal` and `timeoutMs` alongside the existing `reasoningOption` spread
- routing.test.ts:1044-1067 — new test asserts `callOptions.signal === controller.signal` and `callOptions.timeoutMs === 30_000`, using `mock.calls.at(-1)![2]` (the Step-4-review fix)
- provider.test.ts:7-46 — MockEventStream.result() waiter mirrors pi-ai EventStream (resolves only on terminal `done`/`error`; bare `end()` does NOT resolve it — the gap that shipped d793dbde)
- provider.test.ts:152-165 — `createAbortedMessage` test asserts `role === 'assistant'`, `stopReason === 'aborted'`, `errorMessage` undefined
- provider.test.ts:204-232 — delegation timeout test sets `candidateTimeoutMs: 45000` and asserts `callOptions.timeoutMs === 45000`
- provider.test.ts:1124,1171,1213,1238,1358,1385 — 6 flipped tests assert a terminal `aborted` event plus `await terminated(stream) === true`
- provider.test.ts:1311 — reload-case test unchanged (`toBeUndefined()`); line 1263 — "API key revoked" negative control unchanged (asserts genuine `error` event). Both correctly left unflipped
- provider.test.ts:76-77 — `beforeEach(() => vi.clearAllMocks())` confirmed, so Phase 4's `mock.calls[0][2]` is safe; routing.test.ts has no clearing and no vitest `clearMocks` config, so Phase 3's `mock.calls.at(-1)![2]` is required — both index choices verified correct
- Success path (provider.ts:753,821) — loop forwards the delegated `done` event via `stream.push(event)` before `break outer`, so the line 821 `stream.end()` is a normal close after a terminal event, not a silent exit. No latent hang introduced or left behind

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ New tests follow existing `it(...)` / `vi.mocked(...)` / `mockState` / `registerRouterProvider` conventions; the `createAbortedMessage` test mirrors the `createErrorMessage` test shape
- ✓ MockEventStream.result() faithfully mirrors pi-ai's EventStream resolution rules (terminal event only; bare `end()` does not resolve) — the fidelity that lets the flipped tests detect a hang
- ✓ Conditional spreads `...(x ? { ... } : {})` match the existing `reasoningOption` spread pattern in routing.ts; the delegation branches reuse the runtime/compat split already established for custom-api models
- Minor observation: provider.ts:368 adds an inline `// pass image-present flag` comment after `hasImageAttachment(context)` not present in the plan's code fence — acceptable clarification, not a deviation

### Manual Testing Required:

1. ESC during a router turn:
   - [ ] Press ESC during a router turn → spinner clears within seconds, shows "Operation aborted" (no error toast)
   - [ ] `/router debug show` after a cancelled turn shows no stuck state
2. Session replacement:
   - [ ] A session-replacement kill mid-turn clears the spinner (no permanent hang)
3. Reload mid-session:
   - [ ] Reload extensions mid-session, send a prompt, confirm no no-registry error (or only the deferred known one from Option 3)
4. Candidate timeout (against nvm install pi 0.84.3, not repo node_modules):
   - [ ] Set `candidateTimeoutMs` low (e.g. 5000) in `model-router.json` against a stalling provider → turn aborts at ~5 s, fallback chain proceeds to the next candidate

### Recommendations:

- Ready to commit — implementation is complete and validated.
