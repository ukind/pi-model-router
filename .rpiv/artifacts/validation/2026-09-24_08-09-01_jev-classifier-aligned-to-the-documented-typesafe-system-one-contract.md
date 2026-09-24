---
template_version: 1
date: 2026-09-24T08:09:01+0700
author: Yogiswara Utama
commit: 3c861b82
branch: main
repository: pi-model-router
topic: "Validation of Jev classifier aligned to the documented TypeSafe System One contract"
status: ready
verdict: fail
parent: ".rpiv/artifacts/plans/2026-09-23_21-32-37_jev-classifier-doc-aligned.md"
tags: [validation, plan, classifier, typesafe, jev, routing, confidence, config]
last_updated: 2026-09-24T08:09:01+0700
---

## Validation Report: Jev classifier aligned to the documented TypeSafe System One contract

### Implementation Status

- ✓ Phase 1: Additive numeric gate seam — Fully implemented
- ✓ Phase 2: Jev-native request — Implemented as planned, but the planned request shape does not work against the live API
- ✓ Phase 3: Response mapping + failure taxonomy — Fully implemented
- ✓ Phase 4: Config warning + persisted-state sanitizer — Fully implemented
- ✓ Phase 5: Provenance surfaces + whole-plan gates — Fully implemented

The code matches the plan fences line-for-line, and every plan gate passes. A live contract probe run after the first report reverses the verdict. The live API rejects the planned `bool` signal questions with HTTP 400, so every typesafe turn falls back to heuristics. The plan premise came from the planner, not from the vendor docs (see Deviations).

The implementation sits uncommitted in the working tree. The dirty set is exactly the 12 declared files across the five phases. The only untracked paths are the three run artifacts under `.rpiv/artifacts/`. No `--goal`, `--baseline`, `--scope`, or `--acceptance` input was provided. The plan carries no `risks:` frontmatter.

### Automated Verification Results

- ✓ Phase 1 routing suite: `npx vitest run extensions/routing.test.ts` — 104 tests passed, including both 0.85 boundary tests
- ✓ Type check (all phases): `npx tsc --noEmit` — no errors
- ✓ Phase 1 floor constants: floors grep on `extensions/constants.ts` — 3 lines matched
- ✓ Phase 1 gate helpers: export grep on `extensions/routing.ts` — 3 lines matched
- ✓ Phase 2 wire-body assertion: the `not.toContain('Return your decision')` check rides the routing suite and passed
- ✓ Phase 2 builders: export grep on `extensions/typesafe.ts` — 2 lines matched
- ✓ Phase 3 failure reasons: failureReason grep on `extensions/typesafe.ts` — 2 lines matched
- ✓ Phase 3 numeric passthrough: `confidenceNumeric,` grep on `extensions/typesafe.ts` — 1 line matched
- ✓ Phase 3 provider suite: `npx vitest run extensions/provider.test.ts` — 37 tests passed
- ✓ Phase 4 config + state suites: `npx vitest run extensions/config.test.ts extensions/state.test.ts` — 72 tests passed, including the two-warning case
- ✓ Phase 4 warning string: grep on `extensions/config.ts` — 1 line matched
- ✓ Phase 4 numeric guard: `Number.isFinite(value.confidenceNumeric)` grep on `extensions/state.ts` — 1 line matched
- ✓ Phase 5 carry-forward: `promotedDecision.classifierAttempted` grep on `extensions/provider.ts` — 1 line matched
- ✓ Phase 5 notify suffix: `confidenceNumeric.toFixed(2)` grep on `extensions/index.ts` — 1 line matched
- ✓ Whole-plan baseline: `npx vitest run` — 8 files, 332 tests passed
- ✓ No chat directive in state: `grep -F "Return your decision" extensions/typesafe.ts` — no match
- ✓ No regressions detected in the mocked suites
- ✗ Live contract probe (outside the plan): the planned request body returns HTTP 400 `api_usage_error: Invalid request` from `https://api.typesafe.ai/v1/systemone`
- ✗ Live contract probe (outside the plan): the pre-rework request body returns HTTP 200 with a usable tier answer. The regression is in the new request shape, not in the key or the network

### Code Review Findings

#### Matches Plan:

- extensions/types.ts:56-67, :120 — `ClassifierResult` widened exactly as fenced: optional `tier`/`confidence`/`rawText`, new optional `confidenceNumeric`; `RoutingDecision.confidenceNumeric` added beside the word field.
- extensions/constants.ts:7-12 — `CLASSIFIER_OVERRIDE_FLOOR` (0.85), `CLASSIFIER_VETO_FLOOR` (0.85), `CLASSIFIER_DEGRADE_FLOOR` (0.5), each with the planned JSDoc.
- extensions/routing.ts:316-347 — `isUsableClassifierResult`, `isHighConfidence`, `isLowConfidence` exported as pure arrow functions, numeric-first with word fallback.
- extensions/routing.ts:467-567 — all three gates read the floors; the failure-carrying branch keeps `classifierAttempted` true and falls back to heuristics.
- extensions/routing.ts:696-709 — provenance threads `failureReason`, optional `confidence`/`rawText`, and `confidenceNumeric`.
- extensions/routing.ts:898-909 — typesafe dispatch builds structured state through `buildTypesafeState(buildClassifierPromptContext(...))`. The chat path and `parseClassifierOutput` are untouched.
- extensions/typesafe.ts:42-150 — contrastive `TIER_CRITERIA` objects (identical `covers`/`not_for`/`examples` fields), `TypesafeState`, both exported builders, `state` typed `TypesafeState`.
- extensions/typesafe.ts:186-222 — mapper requires a finite numeric confidence on success and folds signal answers into `reasoning` as provenance only (D9).
- extensions/typesafe.ts:236-337 — failure taxonomy as specified: never-ran keeps `undefined`, a 200 body with no usable answer records `json-invalid` with the raw body snapshot, HTTP/transport/stall records `infra-failure`. `response.text()` runs before `JSON.parse`, per-ref continue with last-failure memory, mid-run abort returns `undefined`.
- extensions/config.ts:527-535 — dead-knob warning after the unknown-backend block, guarded on raw presence, exact D12 phrasing.
- extensions/state.ts:129-136 — NaN/finite-rejecting numeric guard beside the `confidence` guard.
- extensions/provider.ts:753-780 — `classifierAttempted`, `classifierTier`, `confidenceNumeric`, `rawText`, `failureReason` all copied outside the `isClassifier` guard. `ui.ts:25-26` still turns that bit into the `classifier-failed` widget flag.
- extensions/index.ts:165-171 — notify suffix shows the numeric value when present, the word otherwise.
- Tests land as fenced: routing.test.ts:580-781 (ten gate tests, both boundaries), :1347-1355 (dual-accessor `okBody`), :1399-1433 (wire-body test), :1454-1610 (eight taxonomy tests); the superseded undefined-collapse test is deleted; config.test.ts:647-698; state.test.ts:253-293; provider.test.ts:1572-1580 and :1610-1659.
- Chat-path invariance holds: the diff touches no chat prompt, parser, ref-loop, or chat test body.
- Phase 4 cross-file claim confirmed by code: `loadRouterConfig` merges first (config.ts:575-579), then normalizes the merged object once.
- Gate-level behavior is correct once a usable answer arrives. The morning session history shows the new taxonomy working as designed: `failureReason=infra-failure` with `classifierAttempted=true` and `isClassifier=false`.

#### Deviations from Plan:

- Live vendor contract (blocking): the plan's Phase 2 request shape carries three `type: "bool"` signal questions. The live API rejects any request that contains a `bool` question with HTTP 400. The plan premise was never sourced from the vendor docs. The research artifact (`.rpiv/artifacts/research/2026-09-23_20-26-05_jev-classifier-doc-aligned.md`) contains zero mentions of `bool`. The question type entered at decision D5. The plan, not the code, deviated from the vendor contract.

  Probe evidence, run against the live endpoint with the configured key:
  - new body, as shipped (object state, object criteria, three `bool` questions) — HTTP 400 `Invalid request`
  - pre-rework body (string state, string criteria, no signal questions) — HTTP 200 with `{"model":"jev-1.13.0",...}`
  - object state with object criteria and no signal questions — HTTP 200
  - string state with object criteria and no signal questions — HTTP 200
  - one `bool` question alone, `type: "boolean"`, and a `bool` question without `instructions` — HTTP 400 each
  - a second `choice` question — HTTP 200
  - a `choice` question with `yes`/`no` criteria — HTTP 200, and the answer carries `long_request: {choice: "no", ...}`

  Conclusion: the endpoint accepts multiple `choice` questions and accepts structured `state` and structured `criteria`. It rejects the `bool` type outright.

- extensions/routing.test.ts:781 — the new describe block closes with `});;` (one extra semicolon) instead of the fenced `});`. Legal TypeScript. Cosmetic. No action required.

#### Pattern Conformance:

- ✓ Arrow functions, static top-level imports, and no new `any` in production code. The new `as any` casts in provider.test.ts copy that file's existing mock-harness pattern.
- ✓ Pure builders carry short JSDoc with purity notes, modeled on `buildClassifierPromptContext`.
- ✓ The config warning matches the sentence-case family with the raw value quoted and warns without throwing.
- ✓ `ui.ts` and `commands.ts` are untouched, so the widget and `/router status` stay unchanged as the FRD non-goal requires.
- Minor observation: the mocked transport keeps every request-shape defect invisible to the whole suite. This is the second time a green gate set missed a wrong wire contract (the plan itself records 940be7f5 as the first). Acceptable variation from the plan, not a deviation.

#### Potential Issues:

- extensions/typesafe.ts:262-292 — the three `bool` questions make every typesafe turn fail. The turn then takes the heuristic branch. The user sees `heuristic` in the notification and the `classifier-failed` flag in the widget.
- extensions/typesafe.ts:196-203 — the mapper checks type, NaN, and finite, but does not clamp to [0,1]. The plan fence specified exactly this check set, so the code is faithful. Add a range check only if Jev reports out-of-range values.
- No repo command can detect this defect class. The plan forbids live calls in tests (NRT: transport stays mocked). An opt-in smoke check, gated behind an environment variable, would catch a rejected wire shape before release.
- README.md:156-179 — the Jev section still describes only the endpoint, key file, and fallback. No statement became untrue. Document the numeric floors after the request shape is fixed.

### Manual Testing Required:

1. Live Jev turn — **FAILED**:
   - [ ] Set `classifierModel` to `{ "backend": "typesafe", "model": "typesafe/jev-latest" }` with a valid key file. Send a work request. Confirm the notification shows `(confidence: 0.NN)`.
   - Observed: the notification shows source `heuristic`. The Jev call returns HTTP 400, so the turn degrades.
2. Live failure turn:
   - [ ] After a failed Jev answer, run `/router debug show`. Confirm the history entry carries `failureReason: 'infra-failure'` with no raw body snapshot (the 400 carries none).
   - [ ] Run `/router fix <tier>` after a failure. Confirm the calibration summary is not blank. A `json-invalid` failure carries the snapshot. An `infra-failure` does not.
3. Stall:
   - [ ] Set a short `stallTimeoutMs` against a blocked endpoint. Confirm the `classifier <ref> stalled after <ms>ms` warning appears.
4. Image promotion:
   - [ ] Send an image turn that promotes across tiers after a classifier failure. Confirm the widget keeps the `classifier-failed` flag.
5. Config load:
   - [ ] Pair an invalid `thinking` level with the typesafe backend. Confirm two warnings appear in the load notification.

### Recommendations:

- Escalate to `/skill:revise .rpiv/artifacts/plans/2026-09-23_21-32-37_jev-classifier-doc-aligned.md`. The Phase 2 request shape rests on a premise the vendor API contradicts. The plan's FR2 signal questions need a `choice`-shaped form, or removal.
- Apply the smallest fix that makes the classifier work: express the three signal questions as `choice` questions with `yes`/`no` criteria, and read `choice === 'yes'` in `readTypesafeSignals`. Decision D9 makes the signals provenance-only, so deleting them instead costs no routing behavior. The tier choice and the numeric confidence carry the routing decision.
- Add an opt-in live smoke check for the request shape. Keep it out of the default suite. Gate it behind an environment variable.
- Re-run `/skill:validate` after the fix. The mocked suites cannot prove the vendor contract.
- Delete the extra semicolon at routing.test.ts:781 during your next edit of that file. Optional.
- Do not commit yet. The feature falls back to heuristics on every typesafe turn.
