---
template_version: 1
date: 2026-09-04T18:23:58+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Validation of Dead-flag gate for stale extension ctx after session replacement"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md"
tags: [validation, plan, provider, stale-ctx, session-lifecycle, dead-flag]
last_updated: 2026-09-04T18:23:58+0700
---

## Validation Report: Dead-flag gate for stale extension ctx after session replacement

### Implementation Status

- ✓ Phase 1: Flag core — runtime latch + session_shutdown wiring — Fully implemented
- ✓ Phase 2: Provider stream gates — silent dead/aborted turn — Fully implemented
- ✓ Phase 3: Orestrator gates — ctx-safe handler tails — Fully implemented

### Automated Verification Results

- ✓ P1 targeted suite: `npx vitest run extensions/index.test.ts` — 25 passed, including the 2 new flag-core tests (registration + shutdown/stale/recovery lifecycle)
- ✓ P1 grep: `grep -c "session_shutdown" extensions/index.ts` — 3 (≥ 2 required: declaration comment + death-anchor comment + registration)
- ✓ P1 grep: `grep -n "isExtensionContextDead" extensions/provider.ts extensions/index.ts` — 21 matches (≥ 3 required: type field + flag + getter)
- ✓ P2 targeted suite: `npx vitest run extensions/provider.test.ts` — 27 passed, including the 8 new gate tests (mid-turn replacement, abort-only signal, auth-await death, stale classification, non-matching negative control, reload completion, classifier-await death, AbortError-in-catch)
- ✓ P2 grep: `grep -c "isExtensionContextDead" extensions/provider.ts` — 7 (≥ 6 required)
- ✓ P2 grep: `grep -Fc "signal?.aborted" extensions/provider.ts` — 3 (exact match required: post-classifier, choke, post-auth)
- ✓ P2 grep: `grep -Fc "This extension ctx is stale after session replacement" extensions/provider.ts` — 1 (exactly 1 required: single constant, no inline copies)
- ✓ P3 full baseline: `npm run tsc && npm test` — `tsc --noEmit` clean; 7 test files, 272 tests, all passed
- ✓ P3 grep: `grep -c "isExtensionContextDead" extensions/index.ts` — 14 (≥ 12 required)
- ✓ P3 grep: `grep -n "lastExtensionContext && !isExtensionContextDead" extensions/index.ts` — present at index.ts:132 (extended recordDebugDecision condition)
- ✓ No regressions detected — full suite green including the existing fixed-settle retry negative-control test (provider.test.ts:174-217, which passes no signal and must keep surfacing errors)

### Code Review Findings

#### Matches Plan:

- extensions/index.ts:61-64 — flag declaration beside the sibling latches (`isInternalModelSwitch`/`isInternalThinkingChange`), comment verbatim from HUNK 1
- extensions/index.ts:76-93 — `captureCtx` set/clear points: flag cleared first inside `try`, set in the `catch`; plan-review-amended NOTE comment (dead `lastExtensionContext` pointer warning) carried verbatim; code order kept as designed
- extensions/index.ts:317-320 — getter bridge entry inside `registerRouterProvider` state object, directly after `get lastExtensionContext()`
- extensions/index.ts:551-558 — sixth handler `pi.on('session_shutdown', …)` registered immediately after the `before_provider_request` block; flag-only (never touches ctx), with the pi emit-contract comment
- extensions/index.ts:132 — `recordDebugDecision` notify condition extended with `!isExtensionContextDead`; history push stays ungated (restore reads it)
- extensions/index.ts:287-300 — both `switchToRouterProfile` tail gates (failure notify + `updateStatus`); state sets and ungated `persistState` preserved per HUNK 6
- extensions/index.ts:563-569 — `session_start` debug-notify gate after the restore await
- extensions/index.ts:597-607 — both `model_select` tail gates (`setHiddenThinkingLabel` + `updateStatus`); `persistState` ungated
- extensions/index.ts:616-620 — `turn_end` status gate; `persistState` ungated
- extensions/provider.ts:46-51 — module constant `STALE_CTX_MESSAGE_PREFIX` immediately before `createErrorMessage`, with the pi-drift fails-loud comment
- extensions/provider.ts:179 — `readonly isExtensionContextDead: boolean;` on the provider state type, directly after `readonly lastExtensionContext`
- extensions/provider.ts:351-358 — post-classifier re-verification inserted between the classifier if-block and `let decision = decideRouting(`
- extensions/provider.ts:480 — ctx gate at the :465 anchor (`updateStatus` guarded)
- extensions/provider.ts:542-548 — inner-loop-top choke as the FIRST statement of the candidate-loop body, before `const modelRef`
- extensions/provider.ts:573-580 — post-auth re-verification immediately after `await modelRegistry.getApiKeyAndHeaders(targetModel)`
- extensions/provider.ts:616-620 — ctx gate at the :587 anchor (delegated hidden-thinking-label/status reads guarded)
- extensions/provider.ts:735-739 — ctx gate at the :703 anchor, condition order `lastExtensionContext && !isExtensionContextDead && decision.isFallback`
- extensions/provider.ts:767-784 — benign 2-branch classification in the IIFE catch: `startsWith(STALE_CTX_MESSAGE_PREFIX)` + `name === 'AbortError'`; non-matching errors still push the error event; `stream.end()` unconditional
- extensions/index.test.ts:148-202 — flag-core describe (2 tests) inserted after the test ending at :146, inside the outer orchestrator describe; code verbatim from plan
- extensions/index.test.ts:204-390 — handler-tails describe (6 tests) inserted directly after the flag-core describe; code verbatim from plan
- extensions/provider.test.ts:105 — `mockState` beforeEach gains `isExtensionContextDead: false`
- extensions/provider.test.ts:1002-1297 — gate describe (8 tests) inserted inside `describe('registerRouterProvider')` after the all-skip test, before that describe closes; code verbatim from plan

Hard constraints verified against the tree:

- The flag never enters persistence — `isExtensionContextDead` appears nowhere in `extensions/state.ts`, `extensions/types.ts` (RouterPersistedState untouched), `extensions/ui.ts`, or `extensions/commands.ts`
- Working-tree delta = exactly the plan's declared write-set (index.ts, provider.ts, index.test.ts, provider.test.ts); every other file byte-identical to base `cdcfe2eb`
- `thinking_level_select` body left ungated and `persistState` calls left ungated (stale-swallowing), per "What We're NOT Doing"
- Benign-classification masking premise sound: pi's stale message originates only from dead ctx getters in pi core, and the non-matching negative-control test proves live errors still surface (cdcfe2eb lesson honored)

#### Deviations from Plan:

- None. Implementation is a faithful realization of the plan. All hunks applied verbatim at their declared anchors; observed grep counts satisfy every threshold as written (`session_shutdown` = 3 vs the plan-review audit-note prediction of 2, and provider.ts flag count = 7 vs predicted 8 — both are prediction inaccuracy in audit notes, not deviations; the criteria as written pass).

#### Pattern Conformance:

- ✓ New tests follow established suite conventions: `MockEventStream`, `vi.mocked` mocking, `mockState`/`mockActions` surface, `pinnedTierByProfile` pinning, `vi` already imported in both test files; describe-block nesting matches the surrounding structure
- Minor observation (acceptable variation, not a deviation): the Phase 2 deferred-gate tests introduce the suite's first promise-gate + fixed-real-timer-sleep (`sleep(50)`/`sleep(100)`) assertions. Consistent with the suite's existing fixed-settle style and explicitly acknowledged in the plan's Testing Strategy with a poll-until-helper escape hatch if loaded CI flakes — a design follow-up, no action now

### Manual Testing Required:

1. Extension load (Phase 1 only):
   - [ ] Load the extension in pi (`router/auto`) — behavior unchanged (flag exists, no consumer gates in that slice)
2. Dev session with all phases applied:
   - [ ] Mid-stream `/new` on a `router/auto` turn — no provider error surface, turn ends silently
   - [ ] Repeat with `/fork`, a session switch, and a reload — no error surface, silent turn end
   - [ ] After each replacement path, the status line updates again on the next turn (flag recovery via live capture)
3. Pi upgrade monitoring:
   - [ ] Verify the `session_shutdown` emit contract still awaits every handler before ctx invalidation (pi core `agent-session-runtime.js` ordering) — pi hooks are not stable API; commit `2b8e6862` removed 2 of 5 event names in one minor bump

### Recommendations:

- Ready to commit — implementation is complete and validated.
- Keep the manual dev-session checklist above as the pre-commit sanity pass; the automated suite cannot reproduce a real pi session replacement.
- If CI ever flakes on the four timing-dependent assertions in the new provider gate describe, apply the plan's documented escape hatch (poll-until helper) rather than widening the sleeps.