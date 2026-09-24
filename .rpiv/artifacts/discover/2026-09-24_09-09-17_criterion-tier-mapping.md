---
date: 2026-09-24T09:09:17+0700
author: Yogiswara Utama
commit: c58c7454
branch: main
repository: pi-model-router
topic: "Criterion-driven tier classification"
tags: [intent, frd, routing, typesafe, classifier]
status: ready
last_updated: 2026-09-24T09:09:17+0700
last_updated_by: Yogiswara Utama
---

# FRD: Criterion-driven tier classification

## Summary

The router classifier stops answering a tier directly. Both classifier backends answer a work type (criterion) instead. A shared criterion-to-tier map converts the work type to a model tier before any downstream consumer runs. Confidence expresses certainty of the criterion classification, so a read-work turn can be high-confidence for the low tier.

## Problem & Intent

Intent answer (interview, "Router user"): "My turns pick the wrong model: implementation work runs on a weak model and scan or read work burns a strong model. Success: each work type lands on its matching tier."

Original input, verbatim: "it should be not like that . the basis for tier high / medium / low . is not the confidance score. the current codebase has their criterion which is high or low. for example. implementation should be routed to high and scanning / read work should be goes for low tier. so the scores comes from each criterion . implementation can be scores high confidance as it need to implementation, and read work file can also reads as high confidance for low model tier therefore routed to low model"

The underlying motivation: today the classifier answers "which tier" and confidence gates that answer (`TIER_CRITERIA` is keyed by tier, `extensions/typesafe.ts:59-156`). So confidence means confidence-in-a-tier. The developer wants the tier to follow deterministically from a named work-type criterion, with confidence answering only "how sure are we of the work type". Note: the input's seed rule "implementation should be routed to high" was revised during the interview — see Decision 5.

## Goals

- The classifier answers a work type, never a tier.
- A deterministic criterion-to-tier map decides the tier. The map uses the existing tier targets.
- Confidence (numeric and word) expresses certainty of the criterion classification only.
- One classification semantics on both backends (chat and typesafe) and on the degrade path.
- Downstream consumers (rules, pins, budget, provider, state) stay tier-keyed and unchanged.

## Non-Goals

- No change to tier targets: implementation stays medium, planning stays high, summary and lookup stay low (`extensions/routing.ts:594-618`). The input's implementation-to-high seed was dropped in the interview.
- No criterion-aware rules, budget, or pins. The downstream boundary stays tier-keyed.
- No new criterion vocabulary. The existing sets are the criteria: planning, implementation, summary, lookup.
- No config-driven criterion-to-tier map. The map is code.
- No changes to model fallback chains, delegation, or provider stream logic.

## Functional Requirements

1. The system SHALL classify each turn into one work type from the set {planning, implementation, summary, lookup}. An unknown or ambiguous turn SHALL map to medium.
2. A module-level criterion-to-tier map SHALL convert the work type to a `RouterTier` before `decideRouting` returns. No consumer outside the classification layer SHALL ever see a criterion.
3. The map SHALL keep the existing targets: planning to high, implementation to medium, summary to low, lookup to low, unknown to medium.
4. Confidence SHALL express certainty of the criterion classification on both backends. A high-confidence lookup answer SHALL route to the low tier.
5. The three floors SHALL keep their values (0.85, 0.85, 0.5 in `extensions/constants.ts`) and SHALL mean criterion certainty: override floor for beating a matched rule, veto floor for surviving an explicit-hint veto, degrade floor for falling back to heuristics.
6. The chat backend prompt and parser SHALL switch from tier output to work-type output. The `isHighConfidence`/`isLowConfidence` word fallbacks SHALL read as criterion certainty.
7. The typesafe question key SHALL rename from `tier` to `work_type` in the POST body and in the response reader (`extensions/typesafe.ts:193-197, 289-291`).
8. The degrade/fallback heuristics SHALL classify a work type through the existing keyword sets (`extensions/routing.ts:367-448`) and convert through the same map. Length, multi-line, and phase-bias rules SHALL stay as post-map tier nudges.
9. Persisted-state validators SHALL accept both old tier-only and new criterion-bearing calibration entries. New fields SHALL be optional so old sessions restore.
10. The explicit-hint veto (ultrathink, fast) SHALL remain. A hint SHALL override the mapped tier when criterion certainty sits below the veto floor.
11. Provenance surfaces (`/router debug`, status line, `/router fix` calibration, image-promotion copy list in `extensions/provider.ts:740-778`) SHALL carry the criterion field alongside `classifierTier`.
12. The three noul signal questions (long_request, structured_request, implementation_context) SHALL stay, recorded for reasoning text only.

## Non-Functional Requirements

- **Performance**: No additional model call per turn. One POST (typesafe) or one stream (chat), same as today. The map lookup is O(1).
- **Security**: API-key handling unchanged (agent-dir file, `extensions/typesafe.ts:34-36`).
- **UX**: Status line and debug output SHALL display confidence without implying tier certainty. Wording updates in `extensions/ui.ts:30-33` and `extensions/index.ts:172-177`.
- **Reliability**: Failure semantics unchanged. `json-invalid`, `infra-failure`, or a missing key SHALL degrade to the keyword heuristics (`extensions/typesafe.ts:299-306, 395-403, 34-36`).

## Constraints & Assumptions

- Extension-first: no pi core changes. TypeScript strict, no `any`, arrow functions, top-level static imports (project standards).
- Hard invariant: `RouterTier` is the only currency downstream. The criterion resolves to a tier inside or immediately after classification.
- Assumption: the existing keyword sets cover real prompts well enough. Evidence: eval comment "19/19 on the labeled live eval, mean confidence 0.976" (`extensions/typesafe.ts:157-158`).
- Assumption: chat models answer work-type words reliably enough. Unmeasured — no chat-backend eval exists.
- Tests asserting current tier semantics must update: floors (`extensions/routing.test.ts:580-620`), word parsing (`extensions/routing.test.ts:1041-1114`), Jev bucketing (`extensions/routing.test.ts:1442-1472`).

## Acceptance Criteria

- [ ] `npm test` (vitest run) exits 0 with the classifier tests updated to work-type semantics.
- [ ] `npm run tsc` exits 0.
- [ ] A unit test proves a high-confidence lookup answer produces a low-tier routing decision with confidence recorded as high.
- [ ] A unit test proves `buildTypesafeQuestions` emits the `work_type` key and `mapTypesafeResponse` reads it.
- [ ] No site ranks tiers by classifier confidence: the `tierRank` comparison at `extensions/routing.ts:486` is gone, verified by test or grep.
- [ ] A restore test proves an old tier-only `router-state` entry still validates and restores.

## Recommended Approach

Rework classification inside `extensions/`: add a `RouterWorkType` union and the criterion-to-tier map beside `ROUTER_TIERS` in `config.ts`; both classifier backends (`typesafe.ts` questions/response mapping, `routing.ts` chat prompt and parser) emit work types; `decideRouting` gates keep the three floors as criterion-certainty licenses; the heuristic branch classifies work types through the existing keyword sets and converts through the same map; state and calibration validators accept both shapes; provider provenance copy lists gain the criterion field.

## Decisions

### State compatibility
**Question**: Pre-resolved from codebase evidence — persisted router-state restores only when every calibration entry validates; one invalid entry drops the whole state (`extensions/state.ts:217-227`, `extensions/index.ts:411-419`). Keep dual-shape tolerant validators?
**Recommended**: Keep. New criterion fields optional; validators accept old tier-only and new entries.
**Chosen**: Keep.
**Rationale**: evidence: extensions/state.ts:217-227 + extensions/index.ts:411-419 + confirmed. Old sessions keep restoring without silent loss.

### Downstream tier boundary
**Question**: Pre-resolved from codebase evidence — rules, pins, budget, model pick, fallback chains are tier-keyed (`extensions/routing.ts:463-470, 645-668`, `extensions/provider.ts:797-812`). Keep the boundary: criterion resolves to tier before `decideRouting` returns?
**Recommended**: Keep. Smallest blast radius.
**Chosen**: Keep.
**Rationale**: evidence: extensions/routing.ts:463-470 + 645-668 + extensions/provider.ts:797-812 + confirmed. No downstream consumer sees a criterion.

### Explicit-hint veto
**Question**: Pre-resolved from codebase evidence — hint words like ultrathink or fast veto the classifier today (`extensions/routing.ts:524-540`). Keep the veto with criterion-certainty meaning?
**Recommended**: Keep. The user hint still wins over a weak criterion read.
**Chosen**: Keep.
**Rationale**: evidence: extensions/routing.ts:524-540 + confirmed. The veto floor now measures criterion certainty.

### Criterion vocabulary
**Question**: Pre-resolved from codebase evidence — the repo already names work-type keyword sets (`extensions/routing.ts:367-448`). Build the criterion list from these sets?
**Recommended**: Keep. One vocabulary across criteria, heuristics, and rules.
**Chosen**: Keep.
**Rationale**: evidence: extensions/routing.ts:367-448 + confirmed. No new vocabulary.

### Tier targets
**Question**: The current targets are planning to high, implementation to medium, summary and lookup to low (`extensions/routing.ts:594-618`). Your seed rule moves implementation to high. Which target set defines the feature?
**Recommended**: Seeds plus existing (implementation rises to high).
**Chosen**: Existing targets. Implementation stays medium.
**Rationale**: Developer interview choice. Only the classification mechanics change; tier outcomes stay identical to today.

### Chat backend parity
**Question**: The chat prompt rubric and parser hard-code tiers (`extensions/routing.ts:202-208, 744-755`). Which way does the chat path go?
**Recommended**: Unify on work types.
**Chosen**: Unify on work types.
**Rationale**: One semantics everywhere and one test surface. Accepts the chat prompt/parser rewrite and a reliability risk on work-type words.

### Fallback path semantics
**Question**: The fallback fires on classifier failure and rarely on low confidence (eval mean 0.976, `extensions/typesafe.ts:157-158`). Which semantics applies when it fires?
**Recommended**: Same map — heuristics classify a work type, the shared map converts.
**Chosen**: Same map.
**Rationale**: One conversion boundary. Identical prompts route the same way at any certainty. Costs the `extensions/routing.ts:579-640` branch rewrite.

### Jev wire key
**Question**: The Jev question key is named tier and read back as answers.tier (`extensions/typesafe.ts:193-197, 289-291`). Rename to work_type?
**Recommended**: Rename.
**Chosen**: Rename.
**Rationale**: The key names what the answer now is. The key is internal to the request, so nothing external breaks.

### Signal questions
**Question**: The three noul signal questions fold into reasoning text only (`extensions/typesafe.ts:219-238, 261-275`). Keep them?
**Recommended**: Keep.
**Chosen**: Keep.
**Rationale**: Provenance text keeps its context. Zero behavioral risk. Relabel implementation_context as context only.

### Criterion naming
**Question**: Keep the existing names (planning, implementation, summary, lookup) or rename lookup to scan_read?
**Recommended**: Keep names.
**Chosen**: Keep names.
**Rationale**: One vocabulary with the keyword sets and rules. Zero churn in criteria text and tests.

## Open Questions

None. No item was deferred during the interview.

## Suggested Follow-ups

- Tier-ranking language still sits in the criterion text ("40 or more words", "images default to medium") — `extensions/typesafe.ts:66-92` — cleanup belongs to design.
- `vetoDisagreementMagnitude` loses its tier-index metric and needs redefinition — `extensions/types.ts:120`, `extensions/routing.ts:550-553`.
- UI confidence wording can mislead once a LOW route shows high confidence — `extensions/ui.ts:31-32`, `extensions/index.ts:172-177`.
- Chat-model reliability on work-type words is unmeasured; a labeled eval exists only for the Jev backend — `extensions/typesafe.ts:157-158`.

## References
- Free-text input (verbatim in Problem & Intent)
- Probe reports: codebase-locator (36 tool uses) and codebase-analyzer (28 tool uses), both verified against live source at HEAD c58c7454
- `extensions/routing.ts`, `extensions/typesafe.ts`, `extensions/types.ts`, `extensions/constants.ts`, `extensions/config.ts`, `extensions/provider.ts`, `extensions/state.ts`, `extensions/commands.ts`, `extensions/ui.ts`, `extensions/index.ts`
