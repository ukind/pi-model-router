---
date: 2026-09-24T10:13:40+0700
author: Yogiswara Utama
commit: c58c7454
branch: main
repository: pi-model-router
topic: "Criterion-driven tier classification"
confidence: high
complexity: high
status: ready
verdict: pass
tags: [solutions, routing, classifier, work-type, staged-rework]
last_updated: 2026-09-24T10:13:40+0700
last_updated_by: Yogiswara Utama
---

# Solution Analysis: Criterion-driven tier classification

**Date**: 2026-09-24T10:13:40+0700
**Author**: Yogiswara Utama
**Commit**: c58c7454
**Branch**: main
**Repository**: pi-model-router

## Research Question

Rework classification inside `extensions/` so both classifier backends (Jev/typesafe, chat) answer a `RouterWorkType` (`planning`, `implementation`, `summary`, `lookup`, `unknown`) instead of a tier. A shared `WORK_TYPE_TO_TIER` map converts the answer before any tier-keyed consumer reads it.

Full spec: `.rpiv/artifacts/research/2026-09-24_09-37-49_criterion-tier-mapping.md` (research) and `.rpiv/artifacts/discover/2026-09-24_09-09-17_criterion-tier-mapping.md` (FRD). All checkpoint decisions there are inputs here, not open questions.

## Summary

**Problem**: The classifiers answer a resource tier, not the work the turn does. Confidence therefore reads as tier certainty. A high-certainty `lookup` cannot pull below a matched rule because the merge gate is upward-only (`extensions/routing.ts:479-486`).

**Recommended**: Staged layered rework — the research spec split into two independently-green commits, with the live `work_type` wire probe between the stages.

**Effort**: High (~2-3 days)

**Confidence**: High

## Problem Statement

**Requirements:**

- FR1/FR8: one classification semantics on both backends and the degrade path. Heuristics classify a work type and convert through the same map.
- FR4: confidence means criterion certainty. A high-certainty classifier answer can pull the tier below a matched rule. Floor-gated merge replaces the rank comparison.
- FR7: Jev question key becomes `work_type` with four choices. `unknown` never crosses the wire. An off-vocabulary answer stays `json-invalid`.
- FR9: state validators accept old tier-only and new criterion-bearing shapes.
- FR11: criterion appears on `/router debug`, status line, `/router fix` calibration, and the provider promotion copy list.
- FR5/FR6/FR10/FR12: floors stay 0.85/0.85/0.5; chat backend unifies on work types; the explicit-hint veto stays; noul signal questions stay.

**Constraints:**

- Downstream consumers stay tier-keyed (resolved checkpoint; smallest blast radius).
- `types.ts` stays a pure leaf. A union in `config.ts` would create the repo's only module cycle (`config.ts:5-16` imports 11 type symbols from `./types`).
- Persisted state is additive-only. One invalid calibration entry rejects the whole state (`extensions/state.ts:217-227`). A required new field would break old sessions.
- Gate order Budget → Pin → Rule → Classifier → Heuristic is fragile. Every historical reorder produced defects (`14466e2f`, `f873288a`).

**Success criteria:**

- `npm test` and `npm run tsc` exit 0.
- FR4 unit test: high-certainty `lookup` plus a medium rule yields low tier.
- `buildTypesafeQuestions` emits `work_type`; `mapTypesafeResponse` reads it (round-trip test).
- The `tierRank` comparison at `extensions/routing.ts:486` is gone. The grep must be scoped: `matchHighestTierRule`'s internal rank at `:296`/`:302` survives.
- An old tier-only `router-state` restores.

## Current State

All anchors re-verified fresh at HEAD `c58c7454` by four independent codebase-analyzer agents (direct reads; cbmem graph confirmed ready with 1889 nodes and no recorded coverage issues on any cited path). Minor drift versus the research doc: `mapTypesafeResponse` is `extensions/typesafe.ts:284-317`; `isUsableClassifierResult` is `extensions/routing.ts:319-324`.

**Existing implementation:**

- `TIER_CRITERIA` `extensions/typesafe.ts:59-156` — 3 tier-keyed criteria, 66 keyword tokens; eval invariant comment at `:56-58`.
- `TypesafeQuestions.tier` `:191-198`; `buildTypesafeQuestions` `:206-251`; POST body `:369-382`.
- `mapTypesafeResponse` `:284-317` — validates with `isRouterTier` at `:295`, tier identity at `:306`.
- `runTypesafeClassifier` failure paths `:318-435` — `json-invalid` / `infra-failure` / `undefined` taxonomy.
- Chat prompt `extensions/routing.ts:199-268` (`Tier:` contract at `:251`); `parseClassifierOutput` `:716-776` (`/^tier:/i` at `:732`, `isRouterTier` at `:749`); chat return `:992-998`.
- `decideRouting` `:348-714`: merge `:473-499` with local `tierRank` `:479-486`; classifier branch `:507-556` (veto `:524-540`, magnitude `:549-553`); heuristic branch `:565-642`; budget `:644-665`; resolution `:667-674`.
- Floors `extensions/constants.ts:9,11,13` (0.85/0.85/0.5); `isHighConfidence`/`isLowConfidence` `extensions/routing.ts:331-347` — never read a tier.
- Provenance cluster `extensions/types.ts:104-130` (`classifierAttempted` `:126`, `classifierTier` `:127`).
- `sanitizeRoutingDecisionFields` `extensions/state.ts:68-165` (`classifierTier` branch `:145-147`); `hasValidRequiredDecisionFields` `:167-173`; calibration loop `:217-227`.
- Image-promotion rebuild `extensions/provider.ts:749-778` (`classifierTier` copy `:757-759`; rebuild destroys uncopied fields).
- `/router fix` calibration writer `extensions/commands.ts:424-465`.
- Notify `extensions/index.ts:165-173`; `recordDebugDecision` `:148-150`; `persistState` `:200-219`; restore `:410-448`.
- `formatDecision` `extensions/ui.ts:30-33`; status/widget `:83-152` (no confidence shown today).
- `index.test.ts` config mock `extensions/index.test.ts:5-46` hand-enumerates `./config` exports — agent-discovered seam: new exports must be added to the mock.

**Relevant patterns:**

- Vocabulary split (union in `types.ts`, values/guard in `config.ts`): `RouterTier:3` ↔ `ROUTER_TIERS config.ts:23` ↔ `isRouterTier config.ts:49-50`; `RouterPhase:5` ↔ `isRouterPhase :52-53`; `THINKING_LEVELS :26-31` ↔ `isThinkingLevel :39-41`. 3 instances.
- `classifierTier` provenance template: 5 write/copy sites (`routing.ts:687-688`, `provider.ts:757-759`, `commands.ts:446-447`, `state.ts:145-147`, `state.ts:217-227`) plus 2 free spreads (`index.ts:148-150`, `:206-212`). `classifierCriterion` mirrors it with two deviations: no `/router fix` fallback; optional on the calibration entry.
- Validate-if-present persisted additions: every persisted-field addition since `fb79faf7` (for example `confidenceNumeric` in `a44baa28`).
- Single-commit full-spec rework: `f873288a`, `eff7ce1e`, `940be7f5`, `a44baa28` — 4 of 16 local commits; 100% of prior classifier-semantics changes.

**Integration points:**

- `extensions/routing.ts:479-486` — the deleted `tierRank` comparison; becomes the floor-gated differs test.
- `extensions/typesafe.ts:306` — the identity assignment; becomes the `WORK_TYPE_TO_TIER` lookup.
- `extensions/routing.ts:992-993` — the chat return; second map call site.
- `extensions/provider.ts:757-759` — image-promotion copy list; add one guarded criterion copy.
- `extensions/state.ts:145-147` and `:217-227` — sanitizer branch and validator line.
- `extensions/commands.ts:444-451` — `/router fix` writer; add `classifierCriterion` with no fallback.
- `extensions/index.test.ts:5-46` — config mock; add `ROUTER_WORK_TYPES`, `WORK_TYPE_TO_TIER`, `isRouterWorkType` or restore-path tests go red.

## Solution Options

### Option 1: Layered single-commit rework

**How it works:**
The full research spec lands in one commit. Union in `types.ts`; `ROUTER_WORK_TYPES` + `WORK_TYPE_TO_TIER` + `isRouterWorkType` in `config.ts` beside `ROUTER_TIERS`. Both backends emit work types; conversion at the typesafe mapper and the chat return. Gates reinterpret as certainty licenses with zero code change. The `tierRank` merge becomes a floor-gated inequality. The heuristic branch splits into classify plus nudge. Provenance and state gain the criterion field. All tests flip in the same commit.

**Pros:**

- Strongest precedent fit: every prior classifier-semantics change used this shape (`f873288a`, `eff7ce1e`, `940be7f5`, `a44baa28`). `a44baa28` rewrote every file in this scope in one commit.
- One review cycle; no dual-vocabulary intermediate state.
- No shim residue — incumbent removal is nearly free.

**Cons:**

- The wire rename and the behavioral change land together. A live-probe failure strands the whole commit.
- 3 of 4 comparable reworks required a follow-up fix within 1-11 days; the single commit does not isolate the riskiest delta.

**Complexity:** Medium-high (~2 days)
- Files to create: 0. Files to modify: 13 (+4 incidental test files in blast radius).
- Line churn: ~1,000-1,100; test share 45-50%.
- Risk level: Medium.

### Option 2: Staged layered rework (Recommended)

**How it works:**
Identical end state, two independently-green commits.

Commit 1 (vocabulary + wires + provenance): union/map/guard in `types.ts`/`config.ts`; Jev re-key `TIER_CRITERIA` 3→4 with the 66-token multiset preserved (planning 25 = 16 planning + 9 high-hints; implementation 15; summary 20 = 10 summary + 10 low-hints; lookup 6); question key `work_type`; mapper validates with `isRouterWorkType` and converts at `:306`; chat rubric/parser `Work type:` plus conversion at the chat return; `ClassifierResult.workType?` (optional — load-bearing) and `RoutingDecision.classifierCriterion` threaded through all 7 copy sites; validators validate-if-present; sanitizer drop-if-invalid; fix-writer copy; promotion guarded copy; `index.test.ts` config mock extended. The `tierRank` merge stays byte-identical — it reads `usableResult.tier`, which remains post-map, so routing outcomes are identical to HEAD for every input.

Between stages: env-gated live POST probe of the real `work_type` body (gating pattern from `scripts/e2e-esc-abort.mjs:42-48`), asserting HTTP 200 plus a usable `answers.work_type` choice.

Commit 2 (semantics): delete `tierRank` `:479-486` → floor-gated differs test (FR4); split the heuristic branch into classify + nudge preserving arm precedence; notify wording; `formatDecision` criterion suffix; floors JSDoc; three merge-boundary test rewrites plus the FR4 acceptance test plus precedence pins.

**Pros:**

- The wire-shape defect class broke twice with fully green mocked suites (`940be7f5` HTTP 400; `a44baa28` next-day fix). The mandatory probe now gates the wire change before the behavior change lands.
- FR4 is the only behavioral delta. It lands alone, independently revertible, with a small test surface (3 rewrites + 1 new).
- No double work: the floors block `routing.test.ts:580-782`, veto/degrade/provenance blocks `:783-1037`, and heuristic outcome blocks `:236-556` stay green unmodified through commit 1 — conditional on `workType?` staying optional.
- Strictly better bisection than one mega-commit; commit 2's blast radius is one file's test block plus wording.

**Cons:**

- Staging shape has no precedent in this repo (0 of 4 rework commits; closest analog is the unplanned `940be7f5` → `a44baa28` pair).
- Revert order is forced (2 then 1) once both land.
- One extra `vitest` + `tsc` cycle and one probe run.

**Complexity:** Medium-high (~2-3 days)
- Files: same set as Option 1 (union 11-13 files; `a44baa28` touched 12). Churn ≈ +730/−300 split as commit 1 ≈ +550/−180 and commit 2 ≈ +180/−120; test share ~50%.
- Risk level: Low-medium.

### Option 3: Criterion-native pipeline

**How it works:**
Work types replace tiers end-to-end: `RoutingDecision`, rules, pins, calibration, persisted state, `/router fix`, and UI key on work type. Tier resolves only at the model-pick/budget/fallback boundary in `provider.ts`. This contradicts the resolved tier-boundary checkpoint; it was scored to put the cost of the truest criterion-first shape on record.

**Pros:**

- One vocabulary everywhere; no map at a seam.
- `unknown` semantics could reach the provider instead of collapsing to medium.

**Cons:**

- `thinkingByProfile` is stranded: `ui.ts:14-15` and `provider.ts:787-789` index by `decision.tier` before any provider boundary exists.
- `matchesPin` (`ui.ts:98`) compares pin to `lastDecision.tier`; re-keyed pins make the status line permanently read "waiting".
- `RoutingDecision` has four tier-derived required fields (`types.ts:108-111` from `buildRoutingDecision` `routing.ts:160-198`, which throws on unconfigured tiers). Removing `tier` either cascades optionality into the sanitizer or does not actually move the boundary.
- Re-keyed validators reject old `classifierTier` entries and silently drop pins and calibration for every existing session (`state.ts:217-227` whole-state reject). The one persisted re-key precedent (`pinTier` → `pinByProfile`) used a tolerant dual-read shim plus migration test (`index.test.ts:730-761`) — the mirror image.
- `/router fix` semantically inverts: user corrections target the model wanted, not a work type.
- Pin values collide with `RouterPhase` (`'planning'`, `'implementation'` also satisfy `isRouterPhase`, `config.ts:52-53`).

**Complexity:** High (~4-5 days)
- ~20 files; ~500-700 source lines; ~1,300-1,800 test lines; 130-155 of 332 tests change (40-47% of the suite); README and `model-router.example.json` re-keyed.
- Risk level: High.

### Option 4: Wire-only shim

**How it works:**
Rename only the Jev key to `work_type` and reword the chat rubric; convert to tier immediately at the mapper and parser. No union exported from `types.ts`; no `ClassifierResult.workType`; no merge change; no state changes; heuristics stay tier-flavored.

**Pros:**

- Mechanically a 7-site rename with zero fan-out; one commit analog (`a44baa28` used the same rename-at-wire shape).
- Floors block and `state.test.ts`/`index.test.ts` stay entirely green; ~410-460 total churn lines.

**Cons:**

- Fails FRD acceptance by its own verification method: the banned `tierRank` comparison at `routing.ts:479-486` stays.
- The keyword re-partition is forced anyway: the criteria keys are the wire answer vocabulary (`Record` keys at `typesafe.ts:191-198`), so `TIER_CRITERIA` must be re-keyed 3→4 and the 66 tokens re-partitioned regardless. The shim rewrites the same ~260 lines in `typesafe.ts`/`routing.ts` as the layered options, and saves only ~200-250 lines downstream while leaving FR1(degrade-path)/FR4(merge)/FR8/FR9/FR11 undelivered or partial.
- Two hand-maintained work-type vocabularies (5-word local, 4-word wire) that TypeScript cannot keep aligned; `Record<string, RouterTier>` is unsound without `noUncheckedIndexedAccess` (`tsconfig.json`); phase value collision risk.
- Institutionalizes the existing keyword-mirror drift (routing locals `:367-448` vs typesafe criteria already differ: `what files`, `architect`, `deeply`, `carefully`).
- FR4's merge-form acceptance test (high-certainty lookup vs a matched rule) is impossible to write.

**Complexity:** Medium (~1-1.5 days) — but rejected on requirements coverage, not cost.
- Risk level: High (fails acceptance criteria).

## Comparison

| Criteria | Option 1 | Option 2 | Option 3 | Option 4 |
|----------|----------|----------|----------|----------|
| Complexity | Med-high | Med-high | High | Medium |
| Codebase fit | High | Med-high | Low | Medium |
| Risk | Medium | Low-medium | High | High |
| FRD coverage | Full | Full | Over-scope | 6 of 12 FRs |
| Test churn | ~45-50% of diff | ~50% of diff | 40-47% of suite | ~30-35% of diff |

## Recommendation

**Selected:** Option 2 — Staged layered rework

**Rationale:**

- The commit-1 intermediate is green by construction: the merge gate reads `usableResult.tier` (`routing.ts:478-486`), which stays post-map because `WORK_TYPE_TO_TIER` preserves today's tier targets (planning→high, implementation→medium, summary→low, lookup→low). Routing outcomes are identical to HEAD for every input at that point.
- The `work_type` wire-shape class broke twice with fully green mocked suites (`940be7f5` shipped a body the live API rejected with HTTP 400; `a44baa28` was the next-day fix). The validation artifact records 332/332 green plus clean `tsc` alongside the live 400. The probe is mandatory for every option; staging places it where a failure costs the least.
- FR4 (below-rule pull) is the riskiest semantic delta and the FRD's acceptance case. It lands alone in commit 2, independently revertible, with only three merge-boundary tests rewritten plus one new acceptance test.
- No double work, conditionally verified: because `workType` stays optional on `ClassifierResult`, the hand-built fixtures (`routing.test.ts:558-576`, `:581-588`) keep passing through commit 1 and are touched exactly once in commit 2.
- Same end state, same file set, and near-same total churn as Option 1. The staging premium is one commit boundary, one extra suite run, and one probe run the repo needs anyway.

**Why not alternatives:**

- Option 1: Safe and house-style, and the runner-up. It ships wire rename plus behavior change in one commit, so a probe failure strands or forces rework of everything. Choose it if single-commit style is a hard requirement; the code spec is identical.
- Option 3: Blocked on integration risk — `thinkingByProfile` stranding, `matchesPin` breakage, persisted-state whole-state reject breaking every existing session, `/router fix` inversion, pin/phase collision. It also contradicts a resolved developer checkpoint. Roughly 2× source and ~2.5× test churn of the baseline.
- Option 4: Fails FRD acceptance by design (the banned line stays; the merge-form FR4 test cannot exist). The keyword re-partition is forced, so most of the diff remains, and two untyped vocabularies replace one typed one.

**Trade-offs:**

- Accepting a novel-for-this-repo staging shape (0/4 precedent) in exchange for independent greenness, better bisection, and probe placement.
- Accepting forced revert order (2 then 1) in exchange for an isolated behavioral delta.

**Implementation approach:**

1. Commit 1 — vocabulary and wires: `RouterWorkType` union in `types.ts` (after `:5`); `ROUTER_WORK_TYPES`, `WORK_TYPE_TO_TIER: Record<RouterWorkType, RouterTier>`, `isRouterWorkType` in `config.ts` beside `ROUTER_TIERS:23`; re-key `TIER_CRITERIA` with the 66-token multiset preserved; `work_type` question key; mapper conversion at `typesafe.ts:306`; chat rubric/parser to `Work type:` with conversion at `routing.ts:992-998`; provenance `workType?` + `classifierCriterion` through all 7 copy sites; validators/sanitizer/fix-writer/promotion additions; extend `index.test.ts:5-46` config mock. Full suite green; `tsc` green.
2. Probe — env-gated live POST to `TYPESAFE_ENDPOINT` (`typesafe.ts:23`, key from `readTypesafeApiKeyFile` `:26-37`); assert HTTP 200, `answers.work_type.choice` in vocabulary, numeric confidence. A failure blocks commit 2, not the repo.
3. Commit 2 — semantics: floor-gated differs merge replacing `:479-486`; heuristic classify + nudge split with arm precedence preserved (complexity beats implementation/lookup but loses to summary; phase/tool/short arms only when `unknown`); notify and `formatDecision` criterion wording; floors JSDoc; merge-boundary test rewrites; FR4 acceptance test; precedence pins.

**Integration points:**

- `extensions/routing.ts:479-486` — delete `tierRank`; floor-gated differs test (commit 2).
- `extensions/typesafe.ts:306` and `extensions/routing.ts:992-993` — the two map call sites (commit 1).
- `extensions/provider.ts:757-759` — guarded criterion copy beside `classifierTier` (commit 1). This path fires exactly when the criterion diverges from the promoted tier.
- `extensions/state.ts:145-147` (sanitizer) and `:217-227` (validator) — validate-if-present / drop-if-invalid (commit 1).
- `extensions/commands.ts:444-451` — criterion copy, no fallback (commit 1).
- `extensions/index.test.ts:5-46` — config mock must gain the three new exports (commit 1).
- `extensions/index.ts:165-173` and `extensions/ui.ts:30-33` — criterion wording (commit 2).

**Patterns to follow:**

- `classifierTier` threading template: `routing.ts:687-688`, `provider.ts:757-759`, `commands.ts:446-447`, `state.ts:145-147`, `state.ts:217-227`.
- Vocabulary split convention: `RouterTier:3` ↔ `ROUTER_TIERS config.ts:23` ↔ `isRouterTier config.ts:49-50`.
- Legacy-state migration test model: `index.test.ts:730-761` (pinTier → pinByProfile).
- Env-gated harness gating: `scripts/e2e-esc-abort.mjs:42-48`.

**Risks:**

- Live API rejects the `work_type` key or the 4-key criteria record → the between-stage probe catches it before the behavior change. The prior probe matrix already showed `choice` questions returning HTTP 200.
- Chat backend answers off-vocabulary words → silent heuristic fallback (`routing.ts:988-990`). Mitigation: a small live chat sample set; keep the unparseable → `undefined` taxonomy.
- Follow-up fix within days (3 of 4 historical precedents) → budget one fix commit; the staged shape makes its blast radius smaller.
- Acceptance grep false-fails on `matchHighestTierRule`'s surviving internal rank (`:296`/`:302`) → scope the grep or rely on the FR4 test.
- Guard-test false pass: `'planning'`/`'implementation'` also satisfy `isRouterPhase` → write guard tests with `'lookup'`/`'summary'`.

## Scope Boundaries

- Building: work-type classification vocabulary, both backend reworks, shared map, floor-gated merge, heuristic classify + nudge, criterion provenance, dual-shape state tolerance, criterion wording on debug/fix/notify/status.
- Not doing: criterion-native downstream re-key (rejected — Option 3); `/router pin`, `/router fix`, `/router thinking` CLI vocabulary changes (stay tier-keyed); `vetoDisagreementMagnitude` redefinition (default: keep post-map tier distance, zero textual edits); widget redesign beyond the additive criterion display the FRD names; README/example-config rewrites beyond what the FRD lists.

## Testing Strategy

**Unit tests:**

- Parser block flip ×12 (`routing.test.ts:1038-1117`): `Tier:` inputs → `Work type:` inputs; preserve tolerance cases (markdown `:1058`, punctuation `:1066`, multi-word `:1071`, `\r\n` `:1084`, partial chunk `:1092`).
- Jev block: `okBody` builds `answers.work_type`; criteria loop iterates four keys; `sent.questions.work_type.type === 'choice'` round-trip (FR7); relax `keywords.length > 10` (`:1430-1433`) for `lookup`'s 6 tokens.
- New keyword multiset-parity test: union of the four criteria arrays equals today's 66 tokens (guards Decision 8 fallback equivalence).
- FR4 acceptance: `criterion('lookup', 0.86)` plus a medium rule → low tier, confidence high; plus the 0.85 boundary and 0.84 under-floor cases.
- Heuristic precedence pins: complexity beats implementation/lookup but loses to summary; phase/tool/short arms only when `unknown`; `'Defaulted to medium'` reasoning (`routing.test.ts:541-556`).
- Guard tests using `'lookup'`/`'summary'` to prove the new guard fired (phase collision).
- `state.test.ts` dual-shape matrix: old tier-only entry validates; criterion-bearing entry validates; present-but-invalid criterion rejects the whole state; mixed array proves per-entry independence. Close the existing sanitizer coverage gap: the preserves-optional-fields test (`:231-263`) omits the whole classifier provenance quad.

**Integration tests:**

- `index.test.ts` restore: old tier-only `router-state` restores pins and calibration (model: `:404-435`, legacy model `:730-761`).
- `/router fix` writes `classifierCriterion` when a classifier decision exists.
- Image promotion preserves the criterion (provider.test.ts, model: `:565-760` block).

**Manual verification:**

- [ ] Live probe run: HTTP 200, usable `work_type` choice.
- [ ] `/router debug` shows criterion beside tier.
- [ ] Status line renders `Route: low (lookup)` when criterion exists.
- [ ] Old session file restores without calibration loss.

**Live probes (not mockable — proven twice):**

- Env-gated Jev POST probe between stages.
- Small live chat-backend sample for work-type word compliance (no labeled chat eval exists; only the Jev rubric has one, `typesafe.ts:56-58`).

## Open Questions

**Resolved during research:**

- Conversion placement — mapper (`typesafe.ts:306`) plus chat return; one shared map constant, two call sites (research checkpoint, Decision 8).
- `unknown` on the wire — no; four choices; off-vocabulary stays `json-invalid` (checkpoint).
- Staging coherence — verified: the merge reads post-map `tier`, so commit-1 outcomes equal HEAD for every input.
- `index.test.ts` config mock — must gain the three new exports (agent-discovered; neither FRD nor research named it).
- Fixture double-work — avoided: `workType?` optional keeps `routing.test.ts:236-576` and `:580-1037` green unmodified through commit 1.

**Requires user input:**

- `vetoDisagreementMagnitude`: keep post-map tier distance (default; zero textual edits at `routing.ts:549-553`) or drop the write-only field. Default assumption for design: keep.
- Low-hint token attachment: ride `summary` (default; either low-mapping criterion preserves tier outcomes identically).
- Keyword-count bound: relax `> 10` (default: lower the bound to `>= 5`, or replace it with the multiset-parity test which is stronger).

**Blockers:**

- None. The live probe requires the typesafe key file (`typesafe.ts:26-37`); without it, every option stalls at the same gate.

## References

- `.rpiv/artifacts/research/2026-09-24_09-37-49_criterion-tier-mapping.md` — research this analysis answers
- `.rpiv/artifacts/discover/2026-09-24_09-09-17_criterion-tier-mapping.md` — FRD
- `.rpiv/artifacts/validation/2026-09-24_08-09-01_jev-classifier-aligned-to-the-documented-typesafe-system-one-contract.md` — wire-shape defect evidence (332 green + live HTTP 400)
- `.rpiv/artifacts/research/2026-09-23_20-26-05_jev-classifier-doc-aligned.md` — Jev contract, floors, failure taxonomy
- `extensions/a44baa28` (git) — closest single-commit analog: 12 files, +976/−91
- `extensions/index.test.ts:730-761` — legacy-state migration test model
- `scripts/e2e-esc-abort.mjs:42-48` — env-gated harness gating pattern
