---
template_version: 1
date: 2026-09-24T15:13:37+0700
author: Yogiswara Utama
commit: c58c7454
branch: main
repository: pi-model-router
topic: "Validation of Criterion-driven tier classification"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-24_14-07-15_criterion-tier-mapping.md"
tags: [validation, routing, classifier, work-type, staged-rework]
last_updated: 2026-09-24T15:13:37+0700
---

## Validation Report: Criterion-driven tier classification

### Implementation Status

- ✓ Phase 1: Vocabulary foundation — Fully implemented
- ✓ Phase 2: Jev backend — Fully implemented
- ✓ Phase 3: Chat backend — Fully implemented
- ✓ Phase 4: Provenance + state tolerance — Fully implemented
- ✓ Phase 5: Live probe — Implemented (hermetic gate verified; live POST not run — see Manual Testing Required)
- ✓ Phase 6: Floor-gated merge — Fully implemented
- ✓ Phase 7: Heuristic classify + nudge — Fully implemented
- ✓ Phase 8: Criterion wording — Fully implemented

Implementation is uncommitted. Validation compared the working tree against HEAD `c58c7454`. The dirty set matches the plan's declared write-set exactly (16 files plus the new `scripts/probe-work-type.mjs`). The `.rpiv/artifacts/` entries are workflow artifacts.

### Automated Verification Results

- ✓ Full suite: `npm test` — 8 files, 366 tests passed (7.58s)
- ✓ Type check: `npm run tsc` — clean, no errors
- ✓ Phase 1 greps (3/3): union at `types.ts:7`; config map and guard count 3; mock entry at `index.test.ts:54`
- ✓ Phase 2 greps (7/7): `TIER_CRITERIA` count 0; mapper reads `answers?.work_type` (`typesafe.ts:302`); `work_type` count 4; FR7 round-trip (`routing.test.ts:1702`); parity references 2; tier words in criteria prose 0
- ✓ Phase 3 greps (7/7): "work type" count 6; `isRouterTier` 0; `tierLine` 0; conversion at `routing.ts:674`; old-wire rejection test (`routing.test.ts:1342`); `Work type:` count 23
- ✓ Phase 4 greps (9/9): criterion thread count 5; promotion copy (`provider.ts:761`); fix-writer copy (`commands.ts:453`); state guard count 3; dual-shape count 10; promotion test (`provider.test.ts:623`); old `answers: { tier:` stubs 0; `index.test.ts` count 4; zero `toEqual({` sites
- ✓ Phase 5 checks (4/4): hermetic gate exits 1 and prints the usage line; `work_type` count 9; `process.exit(1)` count 3; live POST deferred (paid call — see Manual Testing Required)
- ✓ Phase 6 greps (5/5): differs gate (`routing.ts:491`); `const tierRank` count 1; FR4 acceptance (`routing.test.ts:808`); boundary tests 2; floor values 3
- ✓ Phase 7 greps (6/6): classify seed (`routing.ts:590`); shared-map conversion count 2; complexity pins 3; `FR8:` pins 7; HEAD reasoning strings 2; merge-gate invariant 1
- ✓ Phase 8 greps (6/6): suffix helper count 4; notify branches 2; widget pin (`ui.test.ts:380`); status pins 2; rule-won pin (`ui.test.ts:417`); formatDecision pin (`ui.test.ts:48`)
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- `extensions/config.ts:39` — `WORK_TYPE_TO_TIER` matches the FR3 map (planning to high, implementation to medium, summary to low, lookup to low, unknown to medium)
- `extensions/routing.ts:491` — the merge gate is the floor-gated differs form: `isHighConfidence(usableResult, CLASSIFIER_OVERRIDE_FLOOR) && usableResult.tier !== ruleMatch.tier`
- `extensions/routing.ts:590-691` — the heuristic branch is the classify + nudge split: hints, then summary, then planning/`why `, then implementation, then gated lookup. Then the complexity raise, then the unknown-only nudges, then one `WORK_TYPE_TO_TIER` conversion
- `extensions/state.ts:229-235` — the calibration validator checks `classifierCriterion` only when present (FR9 validate-if-present)
- `extensions/typesafe.ts:312` — the confidence guard keeps the single `typeof confidenceNumeric !== 'number'` clause (review-row 2 repair landed)
- `extensions/ui.ts:38-39` — `formatCriterionSuffix` is shared by `formatDecision`, the status line, and the widget Route line
- `extensions/index.ts:165-173` — notify provenance interpolates the criterion in both confidence branches
- `extensions/types.ts:1` — imports only `ThinkingLevel` from `@earendil-works/pi-agent-core`
- `extensions/routing.ts:303,309` — `tierRank` survives only inside `matchHighestTierRule`
- `extensions/commands.ts:501` — `/router debug` history renders through `formatDecision`, so the criterion shows without a `commands.ts` change
- `package.json` `files` — `scripts/` is absent, so the probe never ships to npm

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ New tests follow the existing `describe`/`it` vitest conventions and sit inside the correct suites
- ✓ The `index.test.ts` config mock keeps the established hand-enumeration pattern
- Minor observation: `scripts/probe-work-type.mjs` carries its own compact copy of the question schema. The in-file comment names the reason (plain Node cannot import the extensionless TS specifiers). Content parity is pinned by the `routing.test.ts` 66-token multiset test. Acceptable variation, not a deviation.

### Manual Testing Required:

1. Live Jev wire (paid POST; also the plan's ordering gate for commit 2):
   - [ ] `PI_MODEL_ROUTER_PROBE=1 node scripts/probe-work-type.mjs` exits 0 — HTTP 200, on-vocabulary `answers.work_type.choice`, numeric confidence
   - [ ] A failed probe prints its cause (key file path, HTTP status with body, or off-vocabulary answer)
2. Chat-backend live sample:
   - [ ] Run about 5 turns through `runClassifier`'s work-type prompt. Record the unparseable rate (Testing Strategy §6)
3. UI smoke (automated pins exist; a manual look confirms the live render):
   - [ ] Status line shows `Route: low (lookup)` for a read-only turn
   - [ ] `/router fix high` records `classifierCriterion: 'lookup'` on the calibration entry
   - [ ] An old tier-only `router-state` restores unchanged (dual-shape matrix; automated evidence exists in `state.test.ts` and `index.test.ts`)

Verified mechanically by this run: the Phase 1 import check, the Phase 3 `decideRouting`-untouched invariant, the Phase 6 floor values and ordering invariants, the Phase 7 reasoning-string preservation, and the Phase 8 criterion-free render byte-equality (the pre-existing exact-string assertions stay green in the suite).

### Recommendations:

- Run the live probe before staging commit 2. Its pass is the plan's gate for Phases 6-8, and that evidence does not exist yet.
- After the live probe passes, proceed to `/skill:commit` (commit 1: Phases 1-4; commit 2: probe and Phases 6-8).
- If the TypeSafe wire schema ever changes, update both the real builder and the probe's schema copy (documented in-file).
