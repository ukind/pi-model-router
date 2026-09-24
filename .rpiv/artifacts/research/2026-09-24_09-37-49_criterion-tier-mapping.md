---
date: 2026-09-24T09:37:49+0700
author: Yogiswara Utama
commit: c58c7454
branch: main
repository: pi-model-router
topic: "Criterion-driven tier classification"
tags: [research, codebase, routing, classifier, typesafe, state, provenance]
status: ready
last_updated: 2026-09-24T09:37:49+0700
last_updated_by: Yogiswara Utama
---

# Research: Criterion-driven tier classification

## Research Question
Chained from `.rpiv/artifacts/discover/2026-09-24_09-09-17_criterion-tier-mapping.md` (FRD). Rework classification inside `extensions/`: add a `RouterWorkType` union and the criterion-to-tier map beside `ROUTER_TIERS` in `config.ts`. Both classifier backends (`typesafe.ts` questions/response mapping, `routing.ts` chat prompt and parser) emit work types. `decideRouting` gates keep the three floors as criterion-certainty licenses. The heuristic branch classifies work types through the existing keyword sets and converts through the same map. State and calibration validators accept both shapes. Provider provenance copy lists gain the criterion field.

## Summary
- The classifier answers a work type from {planning, implementation, summary, lookup}. `WORK_TYPE_TO_TIER` (planning→high, implementation→medium, summary→low, lookup→low, unknown→medium) converts before `decideRouting` consumes the result. Downstream consumers stay tier-keyed.
- The union lives in `types.ts` (a pure leaf module). The map, `isRouterWorkType`, and `ROUTER_WORK_TYPES` live in `config.ts` beside `ROUTER_TIERS`. A union in `config.ts` would create the repo's only module cycle, because `types.ts` itself becomes a consumer of the union.
- The typesafe conversion runs inside `mapTypesafeResponse` at `extensions/typesafe.ts:306` (checkpoint decision). The wire offers four choices. `unknown` never crosses the wire. An unrecognized answer stays `json-invalid` and degrades to heuristics.
- The confidence gates (`isHighConfidence`, `isLowConfidence`, three floors) never read a tier. They reinterpret as criterion-certainty licenses with zero code change.
- The `tierRank` comparison at `extensions/routing.ts:486` is deleted. The rule merge becomes a floor-gated inequality test. A high-certainty classifier answer can now pull the tier below a matched rule. That is the FR4 acceptance case.
- The heuristic branch splits into work-type classification plus post-map tier nudges. Hint, complexity, phase-bias, tool-context, and length arms stay as nudges in the original precedence.
- Provenance travels as `ClassifierResult.workType` and `RoutingDecision.classifierCriterion`. State validators accept old tier-only and new criterion-bearing shapes.

## Detailed Findings

### Placement and export set
- The repo splits vocabulary by module kind. Unions live in `types.ts` (`RouterTier` at `extensions/types.ts:3`, `RouterPhase` at :5). Runtime values and guards live in `config.ts` (`ROUTER_TIERS` at `extensions/config.ts:23`, `isRouterTier` at :49-50, `isRouterPhase` at :52-53). `config.ts` imports 11 type symbols from `./types` (`extensions/config.ts:5-16`); `types.ts` imports only `ThinkingLevel` and stays a pure leaf.
- Three `types.ts` interfaces become consumers of the union: `ClassifierResult` (`extensions/types.ts:54-64`), `ClassifierCalibrationEntry` (:66-72), `RoutingDecision` (:104-130). A union in `config.ts` would force `types.ts` to import from `config.ts` and close a cycle `types.ts` ⇄ `config.ts`.
- The map must not live in `routing.ts`: `routing.ts:25` already imports from `./typesafe`; `typesafe.ts` importing a map from `routing.ts` would create a runtime cycle. `config.ts` is already value-imported by `routing.ts:18`, `typesafe.ts:19`, and `state.ts:8-13`.
- Exact exports: `RouterWorkType = 'planning' | 'implementation' | 'summary' | 'lookup' | 'unknown'` in `types.ts`; `ROUTER_WORK_TYPES`, `WORK_TYPE_TO_TIER: Record<RouterWorkType, RouterTier>`, `isRouterWorkType` in `config.ts`. Typing the map as a full `Record` gives compile-time exhaustiveness.
- Import churn: `routing.ts` drops `isRouterTier` (its only use is the chat parser validation at `extensions/routing.ts:749`) and gains `isRouterWorkType` plus `WORK_TYPE_TO_TIER`. `ROUTER_TIERS` stays for the veto magnitude. `typesafe.ts` drops `isRouterTier` (only use at `extensions/typesafe.ts:295`). `state.ts` gains `isRouterWorkType` in its `./config` block (`extensions/state.ts:8-13`).
- Value-space collision: `'planning'` and `'implementation'` also satisfy `isRouterPhase` (`extensions/config.ts:52-53`). Guard tests must use `'lookup'` or `'summary'` to prove the new guard fired.

### Typesafe (Jev) backend
- Verified anchors (several FRD citations were stale): `TIER_CRITERIA` at `extensions/typesafe.ts:59-156`; low keywords at :127-154; `TypesafeQuestions.tier` at :191-198; `buildTypesafeQuestions` at :206-251; `mapTypesafeResponse` at :283-316 with the tier identity at :306; POST body at :369-382 (questions at :379). The eval comment sits at :56-58, not :157-158.
- The current 66 keyword tokens partition, not trim. High holds 25 tokens: 16 planning words plus 9 high-hint words (`ultrathink`, `think hard`, `deep`, `thoroughly`, `comprehensive`, `robust`, `best`, `highest quality`, `step by step`). Medium holds 15 tokens and renames to `implementation` unchanged. Low holds 26 tokens: 10 summary words, 6 lookup words (`where is`, `which file`, `show me`, `list`, `find`, `grep`), plus 10 low-hint words.
- Construction rule: the multiset union of the four new `keywords` arrays equals today's 66 tokens. The eval invariant at `extensions/typesafe.ts:56-58` migrates above the renamed constant.
- Hint tails attach to the criterion sharing their tier target. High hints ride `planning`. Low hints ride `summary`. Duplicating a token into two choices weakens contrastive discrimination.
- The `not_for` tier references (`extensions/typesafe.ts:98-99`, `:123-124`) become work-type references. Residual tier-ranking language in `covers` text (`:61-62`, `:97`) is design-layer cleanup flagged by the FRD.
- `mapTypesafeResponse` reads `answers.work_type`, validates with `isRouterWorkType`, and converts via the map at :306. The result gains `workType`; `tier` stays post-map. The reasoning string names work type and tier separately.
- `ClassifierResult.tier` must stay. `isUsableClassifierResult` (`extensions/routing.ts:319-326`) and every `decideRouting` gate read it. A work-type-only result would silently degrade every typesafe turn.
- Failure paths never read the question key. Missing key, absent/unrecognized choice, non-numeric confidence → `json-invalid` with body snapshot (`extensions/typesafe.ts:384-406`). HTTP error, transport failure, stall → `infra-failure` (:407-418). A missing API key or pre-aborted signal → `undefined` (:337-344). All semantics survive the rename by construction.

### decideRouting gates and the rule merge
- Merge branch at `extensions/routing.ts:473-499`. The banned comparison is `tierRank[usableResult.tier] > tierRank[ruleMatch.tier]` at :486, fed by the local `tierRank` at :479-483.
- New merge rule: delete the rank; the classifier wins when certainty clears `CLASSIFIER_OVERRIDE_FLOOR` (0.85) and its mapped tier differs from the rule's tier. Tiers equal → rule wins (outcome identical; only flags differ). Certainty under floor → rule wins.
- Behavioral delta: a high-certainty answer can now pull the tier below a matched rule. Today's strict `>` is upward-only. The below case is the FRD acceptance test (high-confidence lookup → low tier).
- `matchHighestTierRule` keeps its internal `tierRank` (`extensions/routing.ts:296`, use at :302). It ranks rules against rules, both tier-keyed user data. No classifier confidence is involved.
- `classifierAttempted` and `classifierTier` fire in both merge outcomes at `extensions/routing.ts:477-478`. `classifierTier` records the post-map tier; four tier-typed consumers force this (`extensions/types.ts:127`, `extensions/state.ts:145-147`, `extensions/commands.ts:446-447`, `extensions/provider.ts:757-759`).
- The gates never read a tier: `isHighConfidence` (`extensions/routing.ts:331-337`) is a numeric-first confidence reader with a word fallback; `isLowConfidence` (:343-347) is numeric-under-floor with a word fallback. Floors stay 0.85 / 0.85 / 0.5 (`extensions/constants.ts:9,11,13`). Only their JSDoc meaning changes.
- The explicit-hint veto (`extensions/routing.ts:524-540`) is mechanically unchanged. `candidateTier` reads the mapped tier. FR10 is the existing code with the new meaning.
- `vetoDisagreementMagnitude` (`extensions/routing.ts:549-553`, declared at `extensions/types.ts:129`) is specified as post-map tier distance: `|indexOf(map(workType)) − indexOf(hintTier)|`. With the mapped tier on `ClassifierResult.tier`, the site needs zero textual edits. Dropping the field is the open alternative — it is write-only telemetry and the only ordinal consumer of `ROUTER_TIERS`.
- `vetoOutcome` literals survive intact (`extensions/routing.ts:492, :549, :555`; validator at `extensions/state.ts:148-153`).

### Heuristic branch and chat backend
- Branch entered when `!isClassifier && !ruleMatch && !pinnedTier` (`extensions/routing.ts:565`). Arm disposition:
- Summary keywords (:590-593) → work type `summary`. Planning keywords (:595) → `planning`. Implementation keywords (:606-610) → `implementation`. Lookup keywords with the guards `wordCount <= 24 && toolResultCount === 0` (:611-618) → `lookup`; the guards are classification gates, because the lookup words are generic verbs that appear in long tool-active turns.
- Post-map nudges: explicit high/low hints (:580-589) preempt everything, mirroring the classifier-path veto. Complexity (starts with `why`, length over threshold, multi-line, :596-598) raises to high and skips `summary`. Planning-phase bias (:619-627), tool-result context (:628-636), and short-prompt (:637-640) arms apply only when the work type is `unknown`.
- Precedence invariants the rewrite must reproduce: complexity beats implementation and lookup but loses to summary; the phase/tool/short arms only ran when no keyword arm matched. An unconditional phase-bias nudge would regress `"implement the agreed plan"` during planning.
- `unknown → medium` lives in the map. The `'Defaulted to medium'` reasoning attaches when the work type is `unknown` and no nudge fired, pinned by `extensions/routing.test.ts:541-556`.
- Chat prompt (`extensions/routing.ts:199-268`): rubric becomes four work types plus an ambiguous→`unknown` line. Output line becomes `Work type: [planning|implementation|summary|lookup|unknown]`. Image, length, and multi-line notes reword to work-type language.
- Parser (`extensions/routing.ts:716-776`): line find becomes `/^work ?type:/i`. The markdown stripper (:725-729) already handles `**Work type:**`. First-word extraction keeps the multi-word and trailing-punctuation tolerance tested at `extensions/routing.test.ts:1066-1076`. Validation swaps `isRouterTier` for `isRouterWorkType`.
- Chat conversion runs in `runClassifier`'s chat return (near `extensions/routing.ts:992-998`). One map constant, two call sites (typesafe mapper at `extensions/typesafe.ts:306`, chat return). The checkpoint chose this over centralizing in `runClassifier` for both backends.
- Both degrade chains converge: chat-unparseable → `runClassifier` returns `undefined` (`extensions/routing.ts:988-990`); typesafe `json-invalid`/`infra-failure` returns carry no tier. Both land in the heuristic branch via the unusable arm (:558-564).

### State validators and provenance surfaces
- Three strictness levels in `state.ts`: whole-state reject (`isRouterPersistedState`, `extensions/state.ts:175-234`), whole-decision reject (`hasValidRequiredDecisionFields`, :167-173, checks only `profile`/`tier`/`timestamp`), and per-field drop (`sanitizeRoutingDecisionFields`, :68-165). The calibration loop (:217-227) is the strictest code in the file.
- `ClassifierCalibrationEntry` (`extensions/types.ts:66-72`) keeps `classifierTier`/`finalTier` required and gains optional `classifierCriterion?: RouterWorkType`. The validator gains one validate-if-present line between the two tier checks, mirroring the `pinTier` pattern at `extensions/state.ts:201`.
- The sanitizer gains a drop-if-invalid branch beside the `classifierTier` branch (:145-147). `hasValidRequiredDecisionFields` gains nothing — adding a criterion check there would reject old `lastDecision` shapes.
- The `/router fix` writer (`extensions/commands.ts:444-451`) adds `classifierCriterion: state.lastDecision.classifierCriterion` with no fallback. Heuristic, pin, and rule decisions never had a classifier answer. `strict: true` without `exactOptionalPropertyTypes` makes the single-line form typecheck.
- The image-promotion rebuild (`extensions/provider.ts:749-778`) destroys uncopied fields when `decision = promotedDecision` runs. Add `if (decision.classifierCriterion)` beside the `classifierTier` copy (:757-759). The promotion path is reachable exactly when the criterion diverges from the promoted tier — losing it degrades `/router debug` and the calibration corpus.
- `recordDebugDecision` spreads copy the field for free (`extensions/index.ts:148-150`). `persistState` spreads copy it into `router-state` (:206-212). No builder changes: `buildRoutingDecision` (`extensions/routing.ts:160-198`) stays tier-only; provenance bolts on after the build.
- Notify wording (`extensions/index.ts:165-173`): render `(criterion: lookup — certainty 0.97)` so a low-tier line no longer implies tier certainty. `formatDecision` (`extensions/ui.ts:30-33`): render `{lookup: certainty: high}` when the criterion exists, `{certainty: high}` otherwise.
- The widget and status line show no confidence today (`extensions/ui.ts:83-152`). FR11's criterion display there is additive, for example `Route: low (lookup) [classifier-failed]`.
- The criterion must not reach: `phaseForTier`, `buildDelegationTierChain`, `resolveAvailableTier`, the pinned branch, rule matching, the budget block, `getDecisionFlags`. All read tiers only.

### Test surface
- Fixture helpers (`extensions/routing.test.ts:558-576`) gain `workType` plus the mapped tier. The `numeric` helper (:581-588) becomes a `criterion()` helper keyed by work type and deriving the tier through the map.
- Floors block (:580-782): rule-merge boundaries re-specify to floor-only semantics; the veto boundary tests with `criterion('lookup', 0.86/0.85)` plus `decision.confidence === 'high'` become the FR4 acceptance test.
- Parser block (:1038-1117) hard-breaks: twelve tests flip from `Tier:` inputs and `result.tier` assertions to work-type inputs and `result.workType`.
- `runClassifier` chat block (:1119-1334): stream mocks yield `Work type:` lines; assertions stay mapped-tier. This block proves the conversion boundary.
- Jev block (:1336-1672): `okBody` builds `answers.work_type`; the criteria loop iterates four keys; `sent.questions.work_type.type === 'choice'` is the FR7 round-trip acceptance test. The `keywords.length > 10` assertion (:1430-1433) must relax — `lookup` alone holds 6 words.
- Restore tests: unit cases in `extensions/state.test.ts` (old tier-only entry validates; criterion-bearing entry validates; present-but-invalid criterion rejects the whole state; mixed array proves per-entry independence). Integration case in `extensions/index.test.ts` modeled on the session_start restore test (:404-435).
- A coverage gap to close while touching `state.test.ts`: the sanitizer's preserves-valid-optional-fields test (:231-263) omits the whole classifier provenance quad.

## Code References
- `extensions/types.ts:3-8` — tier/phase/pin unions; `RouterWorkType` lands after :5
- `extensions/types.ts:54-64` — `ClassifierResult`; gains `workType?`
- `extensions/types.ts:66-72` — `ClassifierCalibrationEntry`; gains optional criterion
- `extensions/types.ts:104-130` — `RoutingDecision` provenance cluster; `classifierCriterion` beside `classifierTier` (:127)
- `extensions/config.ts:23` — `ROUTER_TIERS`; `ROUTER_WORK_TYPES` + `WORK_TYPE_TO_TIER` land beside
- `extensions/config.ts:49-53` — `isRouterTier` / `isRouterPhase`; `isRouterWorkType` mirrors
- `extensions/constants.ts:8-13` — the three floors (0.85 / 0.85 / 0.5), meaning reworded
- `extensions/routing.ts:199-268` — chat prompt rubric and output contract
- `extensions/routing.ts:291-312` — `matchHighestTierRule`; internal `tierRank` survives
- `extensions/routing.ts:319-347` — `isUsableClassifierResult`, `isHighConfidence`, `isLowConfidence`
- `extensions/routing.ts:348-452` — `decideRouting` head, locals, medium default init
- `extensions/routing.ts:367-448` — six keyword-set locals (criterion vocabulary)
- `extensions/routing.ts:473-499` — rule+classifier merge; `tierRank` at :479-486 deleted
- `extensions/routing.ts:508-556` — classifier branch: candidate, veto, magnitude (:549-553)
- `extensions/routing.ts:565-642` — heuristic branch to split into classify + nudge
- `extensions/routing.ts:716-776` — `parseClassifierOutput`
- `extensions/routing.ts:883-1012` — `runClassifier`; chat return near :992-998 applies the map
- `extensions/typesafe.ts:42-58` — `TypesafeCriterion` interface + eval invariant comment
- `extensions/typesafe.ts:59-156` — `TIER_CRITERIA` → work-type-keyed criteria (3→4)
- `extensions/typesafe.ts:191-251` — question interface + builder; `tier` → `work_type`
- `extensions/typesafe.ts:283-316` — `mapTypesafeResponse`; conversion at :306
- `extensions/typesafe.ts:318-435` — `runTypesafeClassifier` failure paths (unchanged semantics)
- `extensions/typesafe.ts:369-382` — POST body; `questions` at :379
- `extensions/state.ts:68-165` — `sanitizeRoutingDecisionFields`; drop-if-invalid branch added
- `extensions/state.ts:167-234` — required-field check + `isRouterPersistedState` calibration loop
- `extensions/provider.ts:749-778` — image-promotion copy list; criterion copy beside :757-759
- `extensions/commands.ts:424-465` — `/router fix` calibration writer
- `extensions/index.ts:146-174` — `recordDebugDecision` + notify wording
- `extensions/index.ts:200-219` — `persistState` snapshot dedup + `appendEntry`
- `extensions/index.ts:410-448` — session restore: `findLast(isRouterPersistedState)` + sanitizer
- `extensions/ui.ts:30-33` — `formatDecision` confidence suffix
- `extensions/ui.ts:83-152` — status line + widget (no confidence shown today)
- `extensions/routing.test.ts:558-1672` — six test blocks inventoried above
- `extensions/state.test.ts:231-263` — sanitizer optional-fields coverage gap
- `extensions/index.test.ts:404-435` — restore integration test template

## Integration Points

### Inbound References
- `extensions/provider.ts:619` — precomputes `matchHighestTierRule` and passes `ruleHit` into `decideRouting`
- `extensions/provider.ts:628-669` — invokes `runClassifier` then `decideRouting` (classifier completes before routing starts)
- `extensions/index.ts:410-417` — session_start restore: `findLast(isRouterPersistedState)` over `router-state` entries
- `extensions/commands.ts:439-451` — `/router fix` gates on `isClassifier || classifierAttempted`, reads `lastDecision`
- `extensions/ui.ts:18-27` — `getDecisionFlags` reads provenance booleans (`classifier-failed` flag)

### Outbound Dependencies
- `extensions/typesafe.ts:369-382` — POST to `https://api.typesafe.ai/v1/systemone` (key from agent-dir file, :337-338)
- `extensions/routing.ts` chat loop — `streamSimple` from `@earendil-works/pi-ai/compat`
- `extensions/types.ts:1` — `ThinkingLevel` from `@earendil-works/pi-agent-core` (types.ts stays a leaf)

### Infrastructure Wiring
- `extensions/index.ts:200-219` — `persistState` builds a dedup snapshot and calls `appendEntry('router-state', ...)`
- `extensions/index.ts:146-150` — debug history capped at `MAX_DEBUG_HISTORY = 12` (`extensions/constants.ts:1`)
- `extensions/index.ts:441-443` — calibration restore capped at `MAX_CALIBRATION_ENTRIES = 5` (`extensions/constants.ts:2`)
- `extensions/ui.ts:83-152` — `updateStatus` renders status line + widget route line

## Architecture Insights
- Vocabulary split convention: unions in `types.ts`, runtime values and guards in `config.ts`. The work-type rework mirrors it exactly. `types.ts` stays a pure leaf; the FRD's literal "union in config.ts" reading would create the repo's only module cycle.
- One `Record` is both request schema and answer validator. The criteria keys of the choice question are the legal answer vocabulary on both wire sides. Changing the union moves both together.
- The `RoutingDecision` provenance cluster is display-only. No gate reads it. `classifierCriterion` joins that cluster; FR2's boundary means decision-making consumers (rules, pins, budget, model pick, fallback) never read it, while FR11's read-only observers do.
- `classifierTier` is the template for the new field: threaded unconditionally, guarded-copy on promotion, validate-if-present in state, drop-if-invalid in sanitizer. Two deviations: no `/router fix` fallback (nothing always-present to fall back to) and optional on the calibration entry (FR9).
- Gate order is a fragile invariant: Budget → Pin → Rules → Classifier → Heuristics. Every historical reorder produced defects (`14466e2f`, `f873288a`).
- The keyword arrays are mirrored between `routing.ts` locals and the typesafe criteria. Drift between them breaks the fallback equivalence promised by Decision 8 (same prompt, same tier at any certainty).
- The confidence gates never read tiers. The criterion-certainty reinterpretation needs zero gate code change — only prompt, parser, mapper, and JSDoc wording.
- Whole-state-reject makes persisted-state validators additive-only. Every new persisted field must be optional and validate-if-present, or old sessions silently lose pins and calibration.

## Precedents & Lessons
6 similar past changes analyzed.

### Precedent: Jev (typesafe) classifier backend added, then realigned to vendor contract next day
**Commit(s)**: `940be7f5` — "feat: Jev (typesafe.ai System One) classifier backend" (2026-09-23); `a44baa28` — "feat: align Jev classifier to documented System One contract" (2026-09-24)
**Blast radius**: 940be7f5: 10 files, +535. a44baa28: 12 files, +976/−91 — touches every file in this rework's scope.
**Follow-up fixes**:
- `a44baa28` is itself the follow-up: all six failure paths collapsed to `undefined`; absent confidence silently bucketed as `'medium'`.
- Validation `2026-09-24_08-09-01` caught a live HTTP 400 from a `bool`-question wire shape despite a fully green mocked suite.
**Takeaway**: The `work_type` key rename is the exact wire-shape class that broke twice. Mocked vitest cannot catch it. Probe the live POST body before commit.

### Precedent: Classifier decision overhaul (veto gate, structured result, provenance)
**Commit(s)**: `f873288a` (2026-07-04)
**Blast radius**: 7 files, +671/−86 — routing.ts +209, routing.test.ts +443.
**Follow-up fixes**:
- `c028bcb9` — "fix: use structured flags and remove off short-circuit" (2026-07-05, next day) — replaced a `reasoning.includes('Pinned to')` sniff with structured flags; introduced the validate-if-present sanitizer pattern.
**Takeaway**: Prompt/parser/decision-structure rewrites spawn a next-day fix; the parser and provenance plumbing are where regressions land.

### Precedent: Confidence-aware veto, rule+classifier merge, calibration tracking
**Commit(s)**: `eff7ce1e` (2026-07-21)
**Blast radius**: 10 files, +411 — introduced `tierRank` merge gate, word-confidence veto, `/router fix` calibration.
**Follow-up fixes**:
- None immediate; the word-confidence semantics it introduced were found harmful two months later and replaced by numeric floors in `a44baa28`.
**Takeaway**: This commit and `a44baa28` are the direct ancestors of the FRD (`tierRank`, floors). Every gate site must be enumerated and re-anchored, or one silently keeps tier semantics.

### Precedent: Rules-first routing change → six-defect fix
**Commit(s)**: `a860f4e4` (2026-06-17); `14466e2f` — "fix: resolve six routing defects" (2026-06-28)
**Blast radius**: 14466e2f: 7 files (provider.ts 345 lines, routing.ts 126).
**Takeaway**: Re-semantifying anything inside `decideRouting`'s chain reliably produces multi-defect follow-ups. Enumerate budget/pin/rule/classifier/heuristic ordering explicitly in the plan.

### Precedent: Routing persistence + per-field state sanitizer
**Commit(s)**: `fb79faf7` (2026-07-19)
**Blast radius**: 15 files, +929/−119 — state.ts +132 (`sanitizeRoutingDecisionFields`).
**Takeaway**: Every persisted-field addition since July used optional validate-if-present guards. FR9's dual-shape tolerance is cheap only if that pattern is followed.

### Precedent: Classifier threading through stall watchdog
**Commit(s)**: `47e7c2ff` (2026-09-07)
**Blast radius**: 5 files, +171.
**Takeaway**: The criterion field must survive the stall-degrade path, not just the happy path.

### Composite Lessons
- Plan for a follow-up fix commit: three of four structural classifier changes required one within 1–11 days (`f873288a`→`c028bcb9`, `940be7f5`→`a44baa28`, `a860f4e4`→`14466e2f`).
- Mocked tests hid wire-shape defects twice. Run an env-gated live contract probe for the `work_type` POST body before commit.
- Never let classifier results silently collapse: never-ran → `undefined`, ran-unusable → `json-invalid`/`infra-failure`. Preserve the taxonomy under criterion semantics.
- Enumerate every gate site and provenance copy list. The provider.ts image-promotion rebuild already dropped `classifierAttempted` once.
- Budget roughly 40% of the blast radius for test churn; the FRD's three named test blocks understate it (the Jev `work_type` mapper tests are a fourth).
- Line-number citations rot within one commit. Prefer symbol names in the new map's comments.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-09-24_09-09-17_criterion-tier-mapping.md` — FRD this research answers
- `.rpiv/artifacts/research/2026-09-23_20-26-05_jev-classifier-doc-aligned.md` — Jev contract alignment research (floors, failure taxonomy)
- `.rpiv/artifacts/research/2026-07-21_19-14-23_classifier-routing-accuracy.md` — confidence/gate semantics research (gate-order invariant)
- `.rpiv/artifacts/research/2026-08-29_11-37-58_external-tier-classifier-approaches.md` — external tier-classifier approach survey
- `.rpiv/artifacts/validation/2026-09-24_08-09-01_jev-classifier-aligned-to-the-documented-typesafe-system-one-contract.md` — wire-shape defect validation (mocked suite stayed green)
- `.rpiv/artifacts/validation/2026-09-23_17-05-31_jev-typesafe-classifier.md` — first Jev validation (citation-rot lesson)

## Developer Context
**Q (discover: State compatibility): Pre-resolved from codebase evidence — persisted router-state restores only when every calibration entry validates; one invalid entry drops the whole state (`extensions/state.ts:217-227`, `extensions/index.ts:411-419`). Keep dual-shape tolerant validators?**
A: Keep. New criterion fields optional; validators accept old tier-only and new entries.

**Q (discover: Downstream tier boundary): Pre-resolved from codebase evidence — rules, pins, budget, model pick, fallback chains are tier-keyed (`extensions/routing.ts:463-470, 645-668`, `extensions/provider.ts:797-812`). Keep the boundary: criterion resolves to tier before `decideRouting` returns?**
A: Keep. Smallest blast radius. No downstream consumer sees a criterion.

**Q (discover: Explicit-hint veto): Pre-resolved from codebase evidence — hint words like ultrathink or fast veto the classifier today (`extensions/routing.ts:524-540`). Keep the veto with criterion-certainty meaning?**
A: Keep. The user hint still wins over a weak criterion read.

**Q (discover: Criterion vocabulary): Pre-resolved from codebase evidence — the repo already names work-type keyword sets (`extensions/routing.ts:367-448`). Build the criterion list from these sets?**
A: Keep. One vocabulary across criteria, heuristics, and rules.

**Q (discover: Tier targets): The current targets are planning to high, implementation to medium, summary and lookup to low (`extensions/routing.ts:594-618`). Your seed rule moves implementation to high. Which target set defines the feature?**
A: Existing targets. Implementation stays medium.

**Q (discover: Chat backend parity): The chat prompt rubric and parser hard-code tiers (`extensions/routing.ts:202-208, 744-755`). Which way does the chat path go?**
A: Unify on work types.

**Q (discover: Fallback path semantics): The fallback fires on classifier failure and rarely on low confidence (`extensions/typesafe.ts:157-158`). Which semantics applies when it fires?**
A: Same map — heuristics classify a work type, the shared map converts.

**Q (discover: Jev wire key): The Jev question key is named tier and read back as answers.tier (`extensions/typesafe.ts:193-197, 289-291`). Rename to work_type?**
A: Rename.

**Q (discover: Signal questions): The three noul signal questions fold into reasoning text only (`extensions/typesafe.ts:219-238, 261-275`). Keep them?**
A: Keep. Relabel implementation_context as context only.

**Q (discover: Criterion naming): Keep the existing names (planning, implementation, summary, lookup) or rename lookup to scan_read?**
A: Keep names.

**Q (`extensions/typesafe.ts:306`): Where does `WORK_TYPE_TO_TIER` run for the typesafe path — in the mapper at the existing identity assignment, or centrally in `runClassifier` for both backends?**
A: In the mapper. `typesafe.ts:306` becomes the map lookup. Direct mapper tests (`extensions/routing.test.ts:1379-1397`) keep asserting mapped tier. Decision 8's "same map" means both paths share the map constant, not one call site.

**Q (`extensions/typesafe.ts:59-156`): Does `unknown` become a Jev wire choice (five-key criteria record) or stay off the wire (four choices, unrecognized answer stays `json-invalid`)?**
A: Four choices, no `unknown` on the wire. An off-vocabulary answer is `json-invalid` → heuristics classify `unknown` locally → map yields medium.

**Q (`extensions/types.ts:127`): Name for the criterion provenance field on `RoutingDecision`, in the cluster where `classifierTier` sits?**
A: `classifierCriterion`, matching the `classifier*` prefix convention (`classifierAttempted` :126, `classifierTier` :127). `ClassifierResult` carries `workType` as the raw answer.

## Related Research
- `.rpiv/artifacts/research/2026-09-23_20-26-05_jev-classifier-doc-aligned.md` — Jev contract, floors, failure taxonomy
- `.rpiv/artifacts/research/2026-07-21_19-14-23_classifier-routing-accuracy.md` — confidence semantics and gate order
- `.rpiv/artifacts/research/2026-08-29_11-37-58_external-tier-classifier-approaches.md` — external classifier survey

## Open Questions
From the FRD, verbatim: "None. No item was deferred during the interview."

Opened by this research, not resolved at the checkpoint:
- `vetoDisagreementMagnitude` (`extensions/routing.ts:549-553`, `extensions/types.ts:129`): post-map tier distance is specified; dropping the write-only field remains an alternative for design.
- Low-hint keyword attachment: the 10 low-hint words ride `summary` per analyst A; either low-mapping criterion preserves tier outcomes identically.
- The `keywords.length > 10` assertion (`extensions/routing.test.ts:1430-1433`) must relax for the split criteria; the bound is a design choice.
- Chat-backend reliability on work-type words is unmeasured; no labeled chat eval exists.
- The `work_type` POST body needs an env-gated live probe before commit; mocked tests hid wire defects twice (`940be7f5`, `a44baa28`).
