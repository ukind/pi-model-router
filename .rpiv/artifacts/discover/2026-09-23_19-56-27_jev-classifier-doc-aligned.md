---
date: 2026-09-23T19:56:27+0700
author: Yogiswara Utama
commit: 3c861b82
branch: main
repository: pi-model-router
topic: "Jev classifier aligned to the documented TypeSafe System One contract"
tags: [intent, frd, classifier, typesafe, jev, routing, config]
status: ready
last_updated: 2026-09-23T19:56:27+0700
last_updated_by: Yogiswara Utama
---

# FRD: Jev classifier aligned to the documented TypeSafe System One contract

## Summary
Rebuild the typesafe (Jev) classifier backend so it uses Jev the way the vendor documents it. State becomes structured conversation content, not a chat prompt. One tier choice question plus atomic signal questions go out in a single call, with contrastive criteria. The router consumes numeric confidence with explicit floors, and records why a Jev answer was discarded. The chat backend stays unchanged.

## Problem & Intent
The developer's input, verbatim:

> latest commit we add Jev support for model classifier, but Jev is far different for common LLM . it seems current modelClassifier if using Jev . is not mean to be correctly . its correct if using common LLM, but for Jev as classifier is not correct per real use case of Jev from typesafe

Stated intent (interview answer): wrong tier routing. Jev's responses get misread, so the router picks high/medium/low incorrectly during real sessions. The integration was built as if Jev were a common chat LLM. The Jev vendor documentation defines a different contract, and the developer directed the interview to read that documentation first.

## Goals
- The Jev request matches the documented System One contract: state holds content, questions hold judgments.
- Tier selection reflects Jev's actual answer. No silent misread converts a Jev answer into a heuristic tier.
- The router gates on Jev's numeric confidence with explicit floors, one floor per decision point.
- A discarded Jev answer is distinguishable in provenance from a turn where Jev never ran.

## Non-Goals
- The chat classifier backend keeps its current prompt, parser, and word-confidence behavior.
- No heuristics redesign, no new classifier backends, no status-line or UI redesign.
- No config grammar change. The `provider/model` ref rule stays (`extensions/config.ts:152`).
- No live API call in tests. Tests mock the transport.

## Functional Requirements
1. The system SHALL send `state` as a structured JSON object of conversation content (latest turn, recent messages, phase, has_image) with no output-format instructions.
2. The system SHALL ask one tier `choice` question whose criteria are contrastive objects (`covers`, `not_for`, `examples`) with identical field names across tiers, plus atomic signal questions in the same request.
3. The system SHALL consume Jev's numeric confidence through explicit floors at each decision point (rule override, veto, heuristic fallback). A missing or non-numeric confidence SHALL count as a recorded failure, not as silent `medium`.
4. The typesafe path SHALL produce distinguishable outcomes: unusable answer shape, HTTP or transport failure, and low-confidence fallback each surface a distinct reason in provenance.
5. Config SHALL push a warning when `classifierModel.thinking` is set with `backend: "typesafe"`.
6. The chat backend path SHALL behave identically to today. Shared seams change only additively (a numeric confidence field the gates read when present).

## Non-Functional Requirements
- **Performance**: Jev answers in about 100 ms per the docs. One POST per turn. The 90 s stall budget stays.
- **Security**: The API key stays in the `typesafe_api_key` agent-dir file. No key in state, questions, or logs. No new dependencies.
- **UX / Accessibility**: The routing notification shows the tier and the numeric confidence. A misread turn is visible as a distinct outcome, not a silent heuristic tier.
- **Reliability**: Per-ref `continue` on failure. No throw reaches the turn. Heuristics remain the fallback when Jev cannot answer.

## Constraints & Assumptions
- Repo conventions: no `any`, arrow functions, static imports only, config faults warn and never throw, tests mock the transport.
- Jev accepts text only. Images cannot reach the API, so image presence travels as a named state field.
- Jev is English-primary. Other languages, including Indonesian, have lower accuracy. The developer's mixed-language sessions are assumed to still classify acceptably.
- Doc facts come from docs.typesafe.ai fetched 2026-09-23. The API can change after that date.

## Acceptance Criteria
- [ ] `npx vitest run` exits 0 across all suites with the new typesafe tests included.
- [ ] `grep -rF "Return your decision" extensions/typesafe.ts` returns no match — state carries no chat-format directive.
- [ ] A test asserts the request body: `state` is an object with named fields, and `questions` holds the tier choice plus at least one signal question.
- [ ] A test asserts each merge gate (rule override, veto, heuristic fallback) reads the numeric confidence floor.
- [ ] A test asserts an unusable Jev answer produces a distinct failure reason instead of a heuristic-identical `undefined`.
- [ ] A config test asserts `thinking` plus `backend: "typesafe"` pushes a warning.
- [ ] The existing chat-path tests in `extensions/provider.test.ts` pass unchanged.

## Recommended Approach
Rework `extensions/typesafe.ts` (state builder, contrastive criteria, signal questions, failure reasons) and add a numeric confidence field to `ClassifierResult` that the `extensions/routing.ts` merge gates read when present. Add the `thinking` warning in `extensions/config.ts` normalization. No new modules, no chat-path behavior change.

## Decisions

### D1 — State becomes Jev-native content
**Question**: The Jev request sends the full chat classifier prompt as `state`, including the directive 'Return your decision in exactly three lines' (extensions/routing.ts:846-848, routing.ts:245-247), alongside a choice-typed tier question (extensions/typesafe.ts:142-145). Keep or rebuild? (Re-asked doc-grounded after the developer directed: read the Jev documentation first.)
**Recommended**: Rebuild state Jev-native.
**Chosen**: Rebuild state Jev-native.
**Rationale**: Docs: state is the content to evaluate and instructions belong in questions (docs.typesafe.ai/concepts/state.md, 'Separate content from questions'). Confirmed by the developer after the doc fetch.

### D2 — Numeric doc-style confidence gating
**Question**: Jev's numeric confidence is bucketed to words at >=0.8/>=0.5 (extensions/typesafe.ts:48-55); non-numeric becomes silent 'medium'; <0.5 drops Jev's tier (extensions/routing.ts:469-473). Rework to doc-style numeric gating?
**Recommended**: Numeric doc-style gating.
**Chosen**: Numeric doc-style gating.
**Rationale**: Docs: confidence is a probability-spread statistic and an 'I don't know' signal; patterns gate on explicit numeric floors, 0.5 to not act and 0.85 for high stakes (docs.typesafe.ai/confidence.md, patterns/confidence-routing.md, patterns/intent-routing.md).

### D3 — Distinguishable failure outcomes
**Question**: Any unusable Jev answer silently returns undefined and looks identical to heuristics (extensions/typesafe.ts:70-72,151,163); failure reasons never fire on this path (extensions/types.ts:42-46). Record distinguishable outcomes?
**Recommended**: Record failure reason.
**Chosen**: Record failure reason.
**Rationale**: Docs treat low confidence as a deliberate, visible escalation; our analog is visible fallback. The silent swallow hides every misread from provenance.

### D4 — Scope: Jev path plus additive seam
**Question**: The gating seam in routing.ts is shared with the chat backend. Where does scope stop?
**Recommended**: Jev path + additive seam.
**Chosen**: Jev path + additive seam.
**Rationale**: The chat backend works today per the developer's own framing ('its correct if using common LLM'); additive numeric field keeps its tests and behavior stable.

### D5 — One tier choice plus atomic signal questions
**Question**: Docs call decomposition 'probably the most important concept' and fan out several questions per call at no extra round-trip. Which question shape?
**Recommended**: One tier choice + signals.
**Chosen**: One tier choice + signals.
**Rationale**: Docs: broad questions hide several judgments; atomic questions are inspectable and combinable in code (concepts/how-to-build-with-system-one.md, primitives.md). The tier choice keeps the direct three-path mapping the docs recommend for Choice.

### D6 — Contrastive criteria objects
**Question**: TIER_CRITERIA are one-line strings (extensions/typesafe.ts:36-43). Upgrade to structured criteria?
**Recommended**: Contrastive objects.
**Chosen**: Contrastive objects.
**Rationale**: Docs: criteria descriptions can be objects with the same field names across options (covers / not_for / examples) so the model compares options directly (primitives.md, 'Use structure in the questions').

### D7 — Image presence as a named state field
**Question**: Jev is text-only (concepts/state.md). How should an image turn reach Jev?
**Recommended**: Named state field.
**Chosen**: Named state field.
**Rationale**: The fact 'this turn has an image' is text-representable and feeds tier weight; pixels are not sendable, and silent omission hides the fact from Jev.

### D8 — Config warning for the dead thinking knob
**Question**: classifierModel.thinking is accepted in config but never forwarded on the typesafe branch (extensions/routing.ts:844-850; types.ts:30-32). What behavior?
**Recommended**: Config warning.
**Chosen**: Config warning.
**Rationale**: Repo convention: config faults warn, never throw (extensions/config.ts:470). A warning surfaces the dead knob without breaking existing configs.

## Open Questions
- Floor values per gate: the docs give pattern examples (0.5 do-not-act floor, 0.85 high stakes) and the code has 0.8/0.5 today, but the per-gate numbers (rule override, veto, heuristic fallback) are not pinned. Research or design must set them.

## Suggested Follow-ups
- `parseCanonicalModelRef` rejects bare refs, so the `|| TYPESAFE_DEFAULT_MODEL` fallback is dead code and a bare `jev-latest` skips the ref loop entirely — extensions/typesafe.ts:108-112,139.
- Any `provider/anything` modelId passes through to System One with no allowlist — extensions/typesafe.ts:110,139.
- `ClassifierFailureReason` variants `json-refused` / `json-invalid` are produced nowhere in the codebase — extensions/types.ts:42-46.
- `classifierCalibration` is write-only state; Jev's `probabilities` field could feed it later — architecture review L4-04.
- The 90 s stall timeout is oversized for Jev's ~100 ms profile — extensions/constants.ts:5.

## References
- Developer input (free text, this session).
- docs.typesafe.ai: introduction/quickstart, concepts/state.md, confidence.md, primitives.md, concepts/how-to-build-with-system-one.md, patterns/intent-routing.md, patterns/confidence-routing.md (fetched 2026-09-23).
- .rpiv/artifacts/research/2026-09-23_16-05-23_jev-typesafe-classifier.md — prior Jev research.
- .rpiv/artifacts/validation/2026-09-23_17-05-31_jev-typesafe-classifier.md — prior validation.
- Commit 940be7f5 — feat: Jev (typesafe.ai System One) classifier backend.
