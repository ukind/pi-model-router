---
template_version: 1
date: 2026-09-24T08:50:50+0700
author: Yogiswara Utama
commit: 3c861b82
branch: main
repository: pi-model-router
topic: "Validation of Jev classifier aligned to the documented TypeSafe System One contract"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-23_21-32-37_jev-classifier-doc-aligned.md"
tags: [validation, classifier, typesafe, jev, routing, confidence, config]
last_updated: 2026-09-24T08:50:50+0700
---

## Validation Report: Jev classifier aligned to the documented TypeSafe System One contract

### Implementation Status

- ✓ Phase 1: Additive numeric gate seam — Fully implemented
- ✓ Phase 2: Jev-native request — Fully implemented
- ✓ Phase 3: Response mapping + failure taxonomy — Fully implemented
- ✓ Phase 4: Config warning + persisted-state sanitizer — Fully implemented
- ✓ Phase 5: Provenance surfaces + whole-plan gates — Fully implemented

The implementation is uncommitted in the working tree. It touches 12 files (+976/−91) against HEAD 3c861b82. The dirty set equals the declared files: union of the plan. Only `.rpiv/` workflow artifacts are untracked alongside.

### Automated Verification Results

- ✓ Routing suite (Phases 1-3): `npx vitest run extensions/routing.test.ts` — 104 tests passed
- ✓ Config and state suites (Phase 4): `npx vitest run extensions/config.test.ts extensions/state.test.ts` — 72 tests passed
- ✓ Provider suite (Phases 3 and 5): `npx vitest run extensions/provider.test.ts` — 37 tests passed
- ✓ Type check (all phases): `npx tsc --noEmit` — clean, no errors
- ✓ Whole-plan baseline (Phase 5): `npx vitest run` — 8 files, 332 tests, all passed
- ✓ No regressions detected — chat-path suites pass unchanged inside the whole run
- ✓ Floor constants (Phase 1): grep on `extensions/constants.ts` — 3 (exact)
- ✓ Gate helpers (Phase 1): grep on `extensions/routing.ts` — 3 (exact)
- ✓ Builders (Phase 2): grep on `extensions/typesafe.ts` — 2 (exact)
- ✓ Failure reasons (Phase 3): grep on `extensions/typesafe.ts` — 2 (meets ≥2)
- ✓ Numeric on success (Phase 3): grep on `extensions/typesafe.ts` — 1 (exact)
- ✓ Warning string (Phase 4): grep on `extensions/config.ts` — 1 (exact)
- ✓ Sanitizer guard (Phase 4): grep on `extensions/state.ts` — 1 (exact)
- ✓ Carry-forward ran-bit (Phase 5): grep on `extensions/provider.ts` — 1 (exact)
- ✓ Notify numeric (Phase 5): grep on `extensions/index.ts` — 1 (exact)
- ✓ No chat directive in typesafe state: `grep -cF "Return your decision" extensions/typesafe.ts` — 0 matches (plan note `! grep -qF` holds)

### Code Review Findings

#### Matches Plan:

Phase 1 — additive numeric gate seam
- `extensions/types.ts:55-63` — `ClassifierResult.tier/confidence/rawText` optional, `confidenceNumeric` added. `types.ts:121-123` — `RoutingDecision` gains `confidenceNumeric`
- `extensions/constants.ts:6-11` — `CLASSIFIER_OVERRIDE_FLOOR` and `CLASSIFIER_VETO_FLOOR` (0.85), `CLASSIFIER_DEGRADE_FLOOR` (0.5), beside `DEFAULT_STALL_TIMEOUT_MS`
- `extensions/routing.ts:319-345` — `isUsableClassifierResult`, `isHighConfidence`, `isLowConfidence`. Numeric first, word fallback for the chat path
- `extensions/routing.ts:470,485,512,527,535` — all three gates read the floors. Failure results degrade with `classifierAttempted` provenance
- `extensions/routing.ts:705-706` — `confidenceNumeric` threads into the decision
- `extensions/routing.test.ts:580` — floor describe with both 0.85 boundary tests

Phase 2 — Jev-native request
- `extensions/typesafe.ts:163-180` — `TypesafeState` carries content only. `buildTypesafeState` maps the shared `ClassifierPromptContext` seam
- `extensions/typesafe.ts:42,59` — contrastive `TIER_CRITERIA` objects with per-tier `keywords` arrays (eval-v2 rubric, Follow-up 2)
- `extensions/typesafe.ts:184-229` — three signal questions ship as `noul` with `criteria {true, false}` (D13)
- `extensions/typesafe.ts:319,333` — `state` is typed `TypesafeState`. The POST body carries `buildTypesafeQuestions()`
- `extensions/routing.ts:902` — dispatch passes `buildTypesafeState(...)`
- `extensions/routing.test.ts:1399-1439` — request-body test asserts structured state, contrastive criteria keys, `noul` signal types, and no chat directive in the sent body

Phase 3 — response mapping + failure taxonomy
- `extensions/typesafe.ts:284-316` — mapper requires a finite numeric confidence. Missing or non-numeric returns undefined
- `extensions/typesafe.ts:255-281` — `readTypesafeSignals` records `noul >= 0.5` in provenance only (D9)
- `extensions/typesafe.ts:333-416` — ref loop: never-ran `undefined`, `json-invalid` with raw body snapshot, `infra-failure` for HTTP, transport, and stall. Per-ref continue with last-failure memory
- `extensions/routing.test.ts:1476-1594` — all eight taxonomy tests. `provider.test.ts:1577` — text-aware mock

Phase 4 — config warning + sanitizer
- `extensions/config.ts:531-533` — dead-knob warning runs after merge, exact D12 phrasing, raw-presence guard
- `extensions/state.ts:130-134` — NaN and Infinity rejection for `confidenceNumeric`
- `extensions/config.test.ts:668-696` — warning on, off, and the two-warnings case. `state.test.ts:268-289` — drops NaN, Infinity, and wrong type, keeps 0.87

Phase 5 — provenance surfaces
- `extensions/provider.ts:750-776` — `classifierAttempted` survives image promotion unconditionally. `confidenceNumeric`, `rawText`, and `failureReason` copy outside the `isClassifier` guard
- `extensions/index.ts:165-172` — notify shows `(confidence: 0.NN)` when the number exists, the word otherwise
- `extensions/provider.test.ts:1610` — a Jev failure stays visible in decision provenance

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ `typesafe.ts` keeps repo conventions: static top-level imports, arrow functions, `unknown` narrowing, no `any`, `Pure:` JSDoc markers
- ✓ Config warning matches the `classifierModel ...` sentence-case family with the value quoted
- ✓ Test harness unchanged: `okBody` dual accessor, `runJev`, stubbed fetch, mocked `readFileSync`, `afterEach` cleanup
- ✓ No drift: `TypesafeBoolQuestion` and `type: 'bool'` have zero matches across `extensions/`. The chat directive string is absent from `typesafe.ts`

#### Potential Issues:

- `extensions/typesafe.ts:284-316` — the mapper rejects non-number, NaN, and Infinity. It does not reject a finite value outside [0,1]. A vendor bug that reports 1.5 would clear the 0.85 floors. Observation only. No failing case exists. Non-blocking.

### Manual Testing Required:

1. Live contract probe (Phase 2, unchecked):
   - [ ] POST the exact `buildTypesafeQuestions()` body to `https://api.typesafe.ai/v1/systemone` with a real key. Expect HTTP 200. The D13 follow-up records a live 200 for this shape on 2026-09-24.
2. Live notification (Phase 5, unchecked):
   - [ ] Run a live Jev turn. The routing notification must show `(confidence: 0.NN)`.
3. Image promotion (Phase 5, unchecked):
   - [ ] Send an image turn that promotes across tiers after a classifier failure. The widget must keep the `classifier-failed` flag.

Manual criteria the plan marks done are covered by the suites above (two-warnings case, stall `onStall` report, sanitizer drops).

### Recommendations:

- Ready to commit — implementation is complete and validated.
- Optional hardening for a later pass: range-check `confidenceNumeric` to [0,1] in `mapTypesafeResponse`.
