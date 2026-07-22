---
template_version: 1
date: 2026-07-21T21:11:17+0700
author: Yogiswara Utama
commit: e4b5601f
branch: main
repository: pi-model-router
topic: 'Validation of classifier-routing-accuracy'
status: ready
verdict: pass
parent: '.rpiv/artifacts/plans/2026-07-21_19-27-12_classifier-routing-accuracy.md'
tags:
  [
    validation,
    classifier,
    routing,
    accuracy,
    confidence,
    prompt-engineering,
    calibration,
  ]
last_updated: 2026-07-21T21:11:17+0700
---

## Validation Report: Classifier Routing Accuracy Improvements

### Implementation Status

- ✓ Phase 1: Types & State Foundation — Fully implemented
- ✓ Phase 2: Prompt Builder — Fully implemented
- ✓ Phase 3: Confidence Wiring — Fully implemented
- ✓ Phase 4: Calibration Recording — Fully implemented

### Automated Verification Results

- ✓ TypeScript: `npm run tsc` — 0 errors
- ✓ Tests: `npm test` — 7 test files, 255 tests, all passed
- ✓ `buildClassifierPrompt` tests — 8 test cases, all passing
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan

- `extensions/types.ts:31-35` — `ClassifierFailureReason` extended with `'json-refused' | 'json-invalid' | 'infra-failure'`
- `extensions/types.ts:37-46` — `ClassifierPromptContext` interface with all 7 fields
- `extensions/types.ts:55-62` — `ClassifierCalibrationEntry` interface
- `extensions/types.ts:112-115` — `RoutingDecision` extended with `classifierAttempted`, `classifierTier`, `vetoOutcome`, `vetoDisagreementMagnitude`
- `extensions/types.ts:130` — `RouterPersistedState.classifierCalibration` added
- `extensions/constants.ts:2` — `MAX_CALIBRATION_ENTRIES = 5`
- `extensions/state.ts:48-55` — `isFailureReason` accepts all 5 values
- `extensions/state.ts:132-150` — `sanitizeRoutingDecisionFields` preserves new optional fields
- `extensions/state.ts:207-216` — `isRouterPersistedState` validates calibration array entries
- `extensions/state.ts:231-248` — `buildPersistedState` accepts `classifierCalibration` param
- `extensions/ui.ts:25-26` — `getDecisionFlags` shows `classifier-failed` when classifier attempted but didn't decide
- `extensions/routing.ts:191-258` — `buildClassifierPrompt()` extracted as standalone function
- `extensions/routing.ts:715-735` — `runClassifier` uses `buildClassifierPrompt` with signal extraction (toolResultCount, wordCount, multiLinePrompt) and history window 4→6
- `extensions/routing.ts:405-435` — Rule+classifier merge logic: prefers higher tier when classifier confidence is 'high'
- `extensions/routing.ts:437-490` — Low-confidence degrade: falls through to heuristic branch
- `extensions/routing.ts:449-478` — Confidence-aware veto: only overrides when `confidence !== 'high'`
- `extensions/routing.ts:610-625` — Provenance threading: `classifierAttempted`, `classifierTier`, `vetoOutcome`, `vetoDisagreementMagnitude` set on decision
- `extensions/routing.ts:618` — Classifier provenance fields set for ALL classifier results (not just `isClassifier`)
- `extensions/provider.ts:304` — `!ruleHit` gate removed, classifier always runs when configured
- `extensions/commands.ts:439-460` — Calibration recording in `handleFix` when fixing classifier decision
- `extensions/index.ts:53` — `classifierCalibration` module-level state
- `extensions/index.ts:146` — `classifierCalibration` passed to `buildPersistedState`
- `extensions/index.ts:158-162` — Calibration entries in snapshot dedup with timestamp zeroed
- `extensions/index.ts:377-380` — Calibration entries restored from session on relaunch, capped at `MAX_CALIBRATION_ENTRIES`
- `extensions/index.ts:466-472` — `classifierCalibration` getter/setter on state object

#### Deviations from Plan

None. Implementation is a faithful realization of the plan.

#### Plan Review Findings Resolution

- **vetoOutcome misused in rule-wins branch** (review concern) — Resolved: `vetoOutcome` left undefined when rule wins, no veto occurred.
- **isClassifier mislabeled in rule-wins branch** (review concern) — Resolved: `isClassifier = true` only inside classifier-wins sub-branch.
- **Dead schema (phaseBias, isBudgetExceeded)** (review suggestion) — Deferred per plan: kept as forward-compatible schema for Q9 follow-up.
- **Coverage concerns** (review concerns) — Deferred per plan: low-risk, continuation guard unchanged, advisory notes.

### Manual Testing Required

1. Classifier prompt signal injection:
   - [ ] Classifier prompt includes `toolResultCount`, `wordCount`, `multiLinePrompt` signals
   - [ ] Classifier prompt matches heuristic signal set

2. Confidence-aware routing:
   - [ ] Debug notification shows `classifier-failed` when classifier attempted but degraded
   - [ ] Veto only fires when confidence !== 'high'
   - [ ] `/router debug show` shows `classifierAttempted` and `vetoOutcome` fields

3. Calibration recording:
   - [ ] `/router fix` after a classifier decision records a calibration entry
   - [ ] Calibration entries survive agent relaunch
   - [ ] No calibration entry recorded when `/router fix` corrects a non-classifier decision

4. Backward compatibility:
   - [ ] No breaking changes to existing persisted state (old snapshots restore correctly)
   - [ ] `getDecisionFlags` shows `classifier-failed` when classifier attempted but didn't decide

### Recommendations

- Ready to commit — implementation is complete and validated.
- All 4 phases implemented, all automated checks pass, no regressions.
- Manual testing steps above should be verified before production deployment.
