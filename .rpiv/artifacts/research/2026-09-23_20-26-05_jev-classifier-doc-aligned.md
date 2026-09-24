---
date: 2026-09-23T20:26:05+0700
author: Yogiswara Utama
commit: 3c861b82
branch: main
repository: pi-model-router
topic: "Jev classifier aligned to the documented TypeSafe System One contract"
tags: [research, codebase, typesafe, jev, classifier, routing, confidence, config]
status: ready
last_updated: 2026-09-23T20:26:05+0700
last_updated_by: Yogiswara Utama
---

# Research: Jev classifier aligned to the documented TypeSafe System One contract

## Research Question
Rework `extensions/typesafe.ts` (state builder, contrastive criteria, signal questions, failure reasons), add a numeric confidence field to `ClassifierResult` that the `extensions/routing.ts` merge gates read when present, and add the `thinking` warning in `extensions/config.ts` normalization — no new modules, no chat-path behavior change. Chained from `.rpiv/artifacts/discover/2026-09-23_19-56-27_jev-classifier-doc-aligned.md` (8 scope-tracer questions, 5 grouped dispatches + 1 precedent sweep).

## Summary
The typesafe backend is structurally sound but semantically misaligned with the vendor contract. The `state` field carries the full chat prompt string including the output directive (`routing.ts:845-848`), the request asks a single question with string criteria, every failure collapses to `undefined`, and all three merge gates read a word-confidence bucketed at `>=0.8/>=0.5` (`typesafe.ts:48-55`). The rebuild attaches at four surgical sites: (1) a structured state builder in `typesafe.ts` consuming the existing `ClassifierPromptContext` seam, (2) contrastive criteria objects plus atomic signal questions in the same POST, (3) an optional numeric confidence field read first by the three gates with word fallback (chat path byte-identical), and (4) failure-carrying results that repurpose the dormant `json-invalid` / `infra-failure` union members — zero sanitizer change because `state.ts:48-55` already accepts them. The `thinking`+typesafe warning attaches at `config.ts:518-531`, the only span where both validated locals are in scope, and fires once on the merged config (post-merge normalization catches cross-file dead pairs). Per-gate floors were locked at checkpoint: `0.85` rule-override, `0.85` veto-suppression, `0.5` degrade.

## Detailed Findings

### Typesafe request body (state + questions)
- Today the typesafe branch of `runClassifier` nests the chat builders: `buildClassifierPrompt(buildClassifierPromptContext(...))` ships as the `state` string, directive included (`extensions/routing.ts:845-848`; directive text at `routing.ts:245`).
- `buildClassifierPromptContext` (`extensions/routing.ts:274-287`) is the documented shared seam — pure, produces `ClassifierPromptContext` (`extensions/types.ts:43-52`). Its four FR1 fields map directly: `promptText` → latest turn, `historyText` → recent messages (pre-lowercased, lossy, by `getRecentConversationText`), `currentPhase` → phase, `hasImage` → `has_image` (decision D7; replaces the chat-only note at `routing.ts:217-221`).
- The leftover fields `toolResultCount` / `wordCount` / `multiLinePrompt` (`types.ts:45-47`) are the exact signals D5 promotes to atomic questions — currently encoded as English "Note:" lines at `routing.ts:224-243`.
- The new state builder belongs in `extensions/typesafe.ts`, consuming the context object; `routing.ts:846-848` becomes `state: buildTypesafeState(buildClassifierPromptContext(...))` — swap the outer call only. `TypesafeClassifierOptions.state` (`typesafe.ts:86`) changes `string` → object; `JSON.stringify` at `typesafe.ts:137` needs no change. The chat branch's nested call at `routing.ts:886-891` is untouched, making the FRD grep criterion (`"Return your decision"` absent from `typesafe.ts`) structurally guaranteed.
- `TIER_CRITERIA` (`extensions/typesafe.ts:36-41`) is module-private, referenced once at `typesafe.ts:144`. Rebuild as `{covers, not_for, examples}` objects with identical field names across tiers (D6). The chat prompt's tier lines at `routing.ts:199-201` duplicate these strings nearly verbatim and MUST stay byte-identical (FRD Non-Goal) — the two copies intentionally diverge in shape, not meaning.
- `mapTypesafeResponse` (`extensions/typesafe.ts:63-83`) reads only `answers.tier.{type,choice,confidence}` today; signal answers would survive only inside `rawText` (`typesafe.ts:80`). The mapper rewrites to consume multiple answers and combine tier + signals in code (D5).

### Confidence seam and merge gates
- No numeric confidence exists on `ClassifierResult` (`extensions/types.ts:54-60`, five fields). The number arrives at `typesafe.ts:75`, is collapsed by `toConfidenceLevel` (`typesafe.ts:48-55`: `>=0.8` high, `>=0.5` medium, else low; absent/NaN → silent `'medium'`), and dies there — surviving only inside `rawText` and the `reasoning` string.
- All three gates read the word inside `decideRouting`: rule-override merge `classifierResult.confidence === 'high'` (`extensions/routing.ts:444`), low-confidence degrade `=== 'low'` (`routing.ts:469`), and veto suppression `!== 'high'` twice (`routing.ts:483`, `routing.ts:491`).
- FR3 harm made concrete: a missing confidence becomes silent `'medium'`, which is `!== 'high'` (explicit-hint veto CAN override an answer whose confidence was never reported) and `!== 'low'` (never degraded to heuristics). An absent number is treated like a reported 0.5-0.79.
- The numeric field is OPTIONAL by construction: `parseClassifierOutput` (`routing.ts:661-719`) returns an inline object type (not `ClassifierResult`), emits only words, and the chat success literal at `routing.ts:936-941` assembles the result manually. Chat fixtures (`extensions/routing.test.ts:553-575`) and every `toEqual` pass unchanged with an absent optional key.
- Additive gate pattern: each gate checks the numeric first (`confidenceNumeric !== undefined && confidenceNumeric >= <floor>`) and falls back to the existing word branch. Chat never emits the number → identical word branch. Constants land beside `DEFAULT_STALL_TIMEOUT_MS` in `extensions/constants.ts` or as module consts adjacent to the gates.
- Locked floors (checkpoint): rule-override `0.85` (docs high-stakes — overriding an explicit user rule), veto-suppression `0.85`, degrade `<0.5` (docs do-not-act; matches today's `typesafe.ts:54` bucket exactly). Numerics in [0.8, 0.85) flip classifier-wins → rule-wins and become veto-eligible — typesafe-path-only deltas.

### Failure taxonomy
- Six paths collapse to the same `undefined` in `runTypesafeClassifier` (`extensions/typesafe.ts:100-164`): missing key (`:103`), pre-abort (`:106`), bad ref `continue` (`:108-112`), HTTP `!ok` `continue` (`:151`), unusable body via mapper `undefined` (`:70-72` via `:153-154`), stall/transport throw (`:152-157`).
- Contract split (checkpoint-confirmed): "never ran" (missing key, pre-abort, bad ref, not-configured) keeps `undefined` + heuristics; "ran, answered unusably" returns a failure-carrying result with `failureReason: 'json-invalid'` (dormant at `extensions/types.ts:39`); "ran, transport failure" (HTTP `!ok`, fetch throw, stall) carries `'infra-failure'` (`types.ts:40`).
- `ClassifierResult.tier` becomes optional (checkpoint-confirmed); `decideRouting` guards on `failureReason !== 'success'` before reading `.tier` at `routing.ts:437/466`. The provenance block `routing.ts:647-652` already threads `failureReason` for any truthy result — failure results must also tolerate absent `confidence`/`rawText`.
- `classifierAttempted` (`routing.ts:420`, set only at `:436/:465` inside tier-shaped branches, threaded at `:637`) is the binary "ran" bit pairing with the reason: `(false, undefined)` never ran; `(true, 'json-invalid'|'infra-failure')` ran-unusable; `(true, 'success', isClassifier:true)` used; `(true, 'success', isClassifier:false)` low-confidence degrade.
- Zero sanitizer change: `isFailureReason` (`extensions/state.ts:48-55`) already accepts both dormant variants; restore drops unknown variants silently (`state.ts:132-134`), so reusing existing members avoids provenance loss across restarts.
- Watch-outs: the mid-turn image-promotion rebuild copies `failureReason` only under `if (decision.isClassifier)` and drops `classifierAttempted` entirely (`extensions/provider.ts:751-759`) — a failure decision promoted mid-turn loses its "ran" bit; the new fields must join the carry-forward list. `/router fix` calibration records entries when `isClassifier || classifierAttempted` (`extensions/commands.ts:439-445`) — failure decisions enter calibration with empty summaries unless `rawText` carries the body snapshot.

### Config normalization (thinking warning)
- Attach point: `extensions/config.ts:518-531` — between the unknown-backend warning (`:518-525`) and the `classifierModel` literal (`:526-531`), the only span where both validated `thinking` (from `:484-486`) and `backend` (from `:516-517`) locals are in scope.
- Guard (checkpoint-confirmed): fire when `backend === 'typesafe' && rawClassifier.thinking !== undefined` — matches FR5 verbatim; an invalid level + typesafe fires two warnings (this + `:487-491`), honestly. Keep the `thinking` value in config (nothing reads it on the typesafe branch; `routing.ts:844-852` early-returns before the only read at `routing.ts:900-903`).
- Fire once, on the merged config: `loadRouterConfig` merges first (`config.ts:567-570`), normalizes second (`:571`). Because `mergeClassifier` (`config.ts:118-127`) is field-level spread, the dead pair can be assembled across files (global backend + project thinking, or reverse) — the post-merge check catches both; per-file checks would not.
- Warning surfaces to the user via `reloadConfig` → `lastConfigWarnings` → `ctx.ui.notify` (`extensions/index.ts:243-262`).
- Test landing: sibling of `config.test.ts:632-645` ("typesafe backend normalizes without warnings" — its raw config has no `thinking`, stays green). The invalid-thinking test at `config.test.ts:601-615` sets no backend, stays green.

### Persistence and render surfaces
- `RoutingDecision` NEEDS the numeric field (checkpoint-confirmed optional-number, guard shape `typeof value.X === 'number'` mirroring `state.ts:147-149` — but add NaN/finite rejection, copying `state.ts:180-182` instead, or `NaN` confidence persists). Every render surface consumes only the decision: notify (`index.ts:157-167`), widget (`ui.ts:25-32`), `/router status` (`commands.ts:190-196`), debug show (`ui.ts:30-34`).
- Write path is free: `buildPersistedState` passes decisions through by reference (`state.ts:233-262`); the dedup snapshot spreads decisions (`index.ts:210-219`); `pi.appendEntry('router-state', ...)` serializes all fields.
- Restore asymmetry: `lastDecision` is sanitized (`index.ts:446` via `sanitizeRoutingDecisionFields`) but `debugHistory` is restored raw (`index.ts:434-436`) — new fields are more durable in history than in `lastDecision` unless the guard is added.
- Notify gaps the FRD UX extends: shows the word not the number (`index.ts:166-167`), and the `isClassifier` conjunct hides confidence entirely on degraded ("misread") turns. `/router status` shows no confidence or failure reason at all (`commands.ts:190-196`). The `classifier-failed` widget flag (`ui.ts:25-26`) is the existing "misread visible" hook.
- Fixture updates: valid-preservation `state.test.ts:236-263` gains the numeric + failure variants; drop-invalid `state.test.ts:332-341` gains non-number numeric + bogus reason cases.

### Chat-path invariance surface
- Frozen surface: `parseClassifierOutput` (`routing.ts:661-719`, inline return type — unaffected by `ClassifierResult` growth), the chat ref loop (`routing.ts:855-957`: ref parse, `modelRegistry.find`, `raceStallTimeout` auth, `streamSimple` + `stallGuardedStream`, `reasoningOption` at `:900-903`), and the success literal `routing.ts:936-941`.
- Guarding tests: chat suite `routing.test.ts:911-1129` (shape anchor `toEqual` at `:953-960`; no `toStrictEqual` anywhere in `extensions/`), parser suite `routing.test.ts:830-909` (word-only confidence frozen), provider suites `extensions/provider.test.ts:1517-1560` (stall → heuristics) and `:1566-1604` (Jev config-driven run — doubles as a chat tripwire: the mock registry has no `typesafe` provider, so a backend-selector regression would fail `modelRegistry.find`).
- Shared seams touched additively only: `ClassifierResult` (one optional numeric), `runClassifier` signature (NO change — the number rides inside the returned object), `decideRouting`'s `classifierResult` param (no change), `buildClassifierPromptContext` (no change — repointed consumer only), provenance block `routing.ts:647-652`, notify `index.ts:166-167`.

### Ref pipeline and transport
- The rework is payload-only relative to transport: the abort composition (`typesafe.ts:113-128`) wraps the single fetch; a structured body changes only what `JSON.stringify` serializes (`typesafe.ts:137-146`). One POST per turn is preserved (FRD NFR), so no new controllers or timers. The total-duration timer (`typesafe.ts:119-122`) vs the chat path's per-event `stallGuardedStream` is correct for a single non-streaming POST.
- `onStall` fires only for stall-aborts (`typesafe.ts:156`; `propagateAbort` never sets `stalled`), chaining to `notifyStall` (`provider.ts:608-615`) — the only failure with a user-visible trace today, and it still must carry the failure reason per FR4.
- Confirmed out-of-scope (FRD Suggested Follow-ups, unchanged by research): the dead `modelId || TYPESAFE_DEFAULT_MODEL` fallback (`typesafe.ts:139` — any ref reaching the fetch has parsed, so `modelId` is non-empty; `parseCanonicalModelRef` throws on bare refs at `config.ts:152-166`, caught at `typesafe.ts:111-112` with `continue`) and the missing modelId allowlist (any `provider/anything` passes through — the provider half is discarded at `typesafe.ts:110`).
- Key handling: one `readFileSync` per classified turn (`typesafe.ts:102` via `:24-32`, agent-dir `typesafe_api_key`), shared across refs; absent → `undefined` → heuristics (the "never ran" bucket).

## Code References
- `extensions/typesafe.ts:36-41` — `TIER_CRITERIA` string criteria (D6 rebuild target)
- `extensions/typesafe.ts:48-55` — `toConfidenceLevel` buckets; silent `'medium'` on absent/NaN (FR3 violation)
- `extensions/typesafe.ts:63-83` — `mapTypesafeResponse`; `undefined` at `:70/:72`; result literal `:76-82`
- `extensions/typesafe.ts:85-90` — `TypesafeClassifierOptions`; `state: string` at `:86` (type change site)
- `extensions/typesafe.ts:100-164` — `runTypesafeClassifier`; six undefined-collapse paths; POST body `:131-149`
- `extensions/types.ts:35-40` — `ClassifierFailureReason` union; dormant `json-refused`/`json-invalid`/`infra-failure`
- `extensions/types.ts:43-52` — `ClassifierPromptContext` (shared seam; `isBudgetExceeded`/`phaseBias` dead)
- `extensions/types.ts:54-60` — `ClassifierResult` (numeric field + optional tier land here)
- `extensions/routing.ts:190-267` — `buildClassifierPrompt`; directive at `:245`; image note `:217-221`; signal notes `:224-243`
- `extensions/routing.ts:274-287` — `buildClassifierPromptContext` (documented shared seam)
- `extensions/routing.ts:432-460` — rule+classifier merge; word read at `:444`
- `extensions/routing.ts:461-476` — low-confidence degrade; word read at `:469`
- `extensions/routing.ts:477-514` — confidence-aware veto; word reads at `:483`, `:491`
- `extensions/routing.ts:647-652` — provenance threading block (numeric + reason thread here)
- `extensions/routing.ts:661-719` — `parseClassifierOutput` (frozen, inline return type)
- `extensions/routing.ts:827-857` — `runClassifier` signature + typesafe dispatch `:844-852`
- `extensions/routing.ts:855-957` — chat ref loop; `reasoningOption` `:900-903`; success literal `:936-941`
- `extensions/config.ts:118-127` — `mergeClassifier` (field-level spread; cross-file pair assembly)
- `extensions/config.ts:152-166` — `parseCanonicalModelRef` (throws on bare refs)
- `extensions/config.ts:457-544` — classifierModel normalization; warning attach `:518-531`
- `extensions/config.ts:560-577` — `loadRouterConfig` merge-then-normalize ordering
- `extensions/state.ts:39-56` — `isConfidenceLevel` / `isFailureReason` guards (already accept dormant variants)
- `extensions/state.ts:62-155` — `sanitizeRoutingDecisionFields`; numeric precedent `:147-149`; NaN-safe precedent `:180-182`
- `extensions/provider.ts:600-660` — classifier invocation (`:628-641`), abort choke, `decideRouting` handoff
- `extensions/provider.ts:751-759` — image-promotion rebuild (drops `classifierAttempted`; carry-forward gap)
- `extensions/index.ts:157-167` — notify source chain + word-confidence provenance suffix
- `extensions/index.ts:434-446` — restore: raw `debugHistory` vs sanitized `lastDecision`
- `extensions/ui.ts:25-32` — `classifier-failed` flag; `formatDecision` word confidence
- `extensions/commands.ts:186-196` — `/router status` (no confidence/reason today)
- `extensions/commands.ts:439-445` — `/router fix` calibration gating
- `extensions/constants.ts:5` — `DEFAULT_STALL_TIMEOUT_MS = 90_000` (oversized vs Jev ~100 ms; follow-up)
- `extensions/routing.test.ts:553-575` — `classifierHigh/Low/Medium` fixtures (optional-field compatibility)
- `extensions/routing.test.ts:1139-1184` — `okBody` / `runJev` / `sent` request-body assertion harness
- `extensions/routing.test.ts:1187-1235` — confidence-threshold + undefined-collapse tests (rewrite targets)
- `extensions/config.test.ts:601-615`, `:632-645` — warning test neighbors
- `extensions/state.test.ts:236-263`, `:332-341` — preserve / drop-invalid sanitizer tests
- `extensions/provider.test.ts:1517-1560`, `:1566-1604` — stall-degrade + Jev config-driven suites

## Integration Points

### Inbound References
- `extensions/provider.ts:628-641` — sole production caller of `runClassifier`; passes backend as 10th arg, refs from `classifierModel.model + fallbacks` (`:624-627`)
- `extensions/provider.ts:619-621` — pre-decision `matchHighestTierRule` (`ruleHit`) feeding the rule+classifier merge
- `extensions/provider.ts:656-668` — `decideRouting` receives `classifierResult` as 10th positional param
- `extensions/provider.ts:751-759` — image-promotion rebuild copies provenance selectively (gap for new fields)

### Outbound Dependencies
- `extensions/typesafe.ts:131-149` — `fetch` POST to `TYPESAFE_ENDPOINT` (`api.typesafe.ai/v1/systemone`), Bearer key from agent-dir file
- `extensions/typesafe.ts:20-32` — `readFileSync` on `getAgentDir()/typesafe_api_key`, once per turn
- `extensions/typesafe.ts:110` — `parseCanonicalModelRef` from config (provider half discarded; no registry lookup on this branch)

### Infrastructure Wiring
- `extensions/config.ts:567-577` — global+project parse → merge → normalize; warnings concat and surface via `extensions/index.ts:243-262` (`reloadConfig` → `ui.notify`)
- `extensions/routing.ts:844-852` — backend selector early-return; `thinking` param structurally dead here (D8)
- `extensions/index.ts:210-221` — dedup snapshot + `pi.appendEntry('router-state', state)` persistence
- `extensions/index.ts:407-446` — restore: `isRouterPersistedState` gate → `sanitizeRoutingDecisionFields` on `lastDecision`
- `extensions/provider.ts:605-615` — `stallTimeoutMs` resolution + `notifyStall` sink for `onStall`

## Architecture Insights
- **One seam, two consumers**: `buildClassifierPromptContext` feeds both backends today; the rework keeps it and repoints only the typesafe consumer to a structured builder. The chat prompt renderer (`buildClassifierPrompt`) becomes chat-only by construction.
- **The word-bucket is the isomorphism that makes the additive seam safe**: because both backends currently converge on `ConfidenceLevel`, gates can read numeric-first with word fallback and the chat path executes its identical branch forever.
- **Dormant union members are pre-built plumbing**: `json-invalid` and `infra-failure` already cross the persistence guard — repurposing them requires producers only, no consumer changes.
- **Normalize-once-post-merge is the fault-detection chokepoint**: cross-file field pairs (global backend + project thinking) only surface as faults in `normalizeConfig`, never per-file.
- **The parser/type decoupling makes chat invariance cheap**: `parseClassifierOutput` returns an inline type and `runClassifier` assembles `ClassifierResult` manually — growing the interface touches neither.
- **Provenance asymmetry**: `lastDecision` is strictly re-guarded on restore while `debugHistory` rides raw — new fields need the guard or they survive only in history.

## Precedents & Lessons
4 similar past changes analyzed.

### Precedent: Jev (typesafe.ai System One) classifier backend — the exact change being reworked
**Commit(s)**: `940be7f5` — "feat: Jev (typesafe.ai System One) classifier backend" (2026-09-23); `3c861b82` — "chore: record jev-typesafe-classifier workflow run artifacts" (2026-09-23)
**Blast radius**: 10 files across 4 layers — new `extensions/typesafe.ts` (164 lines), routing backend branch, config backend selector + `ClassifierBackend` type, provider 1-line plumb, 3 test suites, README, example.json

**Follow-up fixes**: none landed — the planned change IS the follow-up; the FRD (same day, 17 min later) documents real-session misrouting.

**Lessons from docs**:
- `discover/2026-09-23_19-56-27_jev-classifier-doc-aligned.md` — original plan never read vendor docs; verified latent bugs: dead default, no allowlist, dead failure reasons, write-only calibration, 90 s timeout.
- `validation/2026-09-23_17-05-31_jev-typesafe-classifier.md` — 163/163 tests + tsc + all gates green with every transport mocked; green gates did not catch the wrong contract.

**Takeaway**: structurally correct + semantically wrong ships when tests never assert the wire body — the rebuild must assert the literal request body and per-gate floors.

### Precedent: Classifier decision-making overhaul + confidence-aware veto
**Commit(s)**: `f873288a` (2026-07-04); `eff7ce1e` (2026-07-21)
**Blast radius**: 7 then 10 files across routing/types/config/state/ui/commands

**Follow-up fixes**: `c028bcb9` (1 day later, same seam); `fb79faf7` (2026-07-19, 15 files)

**Takeaway**: every prior change to the merge-gate seam drew a same-seam behavioral fix within 1-15 days — the numeric floors are the highest-risk part of this rework.

### Precedent: Router stall watchdog series
**Commit(s)**: `2eb3e129` → `d96f4741` → `5960f284` → `47e7c2ff` (2026-09-07)

**Follow-up fixes**: `37388b6a` — self-healing registry guard (next day)

**Takeaway**: new external waits need signal + stall wiring from day one — the typesafe fetch already threads both; keep it that way through the rework.

### Precedent: Six-defect routing fix after batched classifier features
**Commit(s)**: `14466e2f` (2026-06-28) after features `a860f4e4`/`a7443f28` (2026-06-17); follow-up `6cd0516a` (2026-06-30, config/registry drift)

**Takeaway**: the additive-seam discipline (D4: chat path unchanged, numeric read only when present) is the countermeasure to batched-feature payback.

### Composite Lessons
- Mocked transport + green gates ≠ correct vendor contract (`940be7f5`) — assert the literal request body: structured `state`, contrastive criteria, signal questions, per-gate floors.
- The `routing.ts` merge-gate seam breaks after every classifier change (`f873288a`→`c028bcb9`; features→`14466e2f`; watchdog→`37388b6a`) — budget explicit re-verification of rule override, veto, and heuristic fallback with chat tests passing unchanged.
- Silent/indistinguishable failures are the recurring defect class — dead failure reasons, write-only calibration, undefined-collapse; FR4's distinct provenance must be implemented and tested for all three outcome shapes or misreads stay invisible.
- Config knobs go dead silently unless normalization warns (`6cd0516a`) — the thinking+typesafe warning follows the warn-never-throw convention (`config.ts:470`).

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-09-23_19-56-27_jev-classifier-doc-aligned.md` — driving FRD: decisions D1-D8, requirements, acceptance criteria
- `.rpiv/artifacts/research/2026-09-23_16-05-23_jev-typesafe-classifier.md` — prior Jev research (pre-doc-alignment)
- `.rpiv/artifacts/validation/2026-09-23_17-05-31_jev-typesafe-classifier.md` — prior validation run (163/163 green, wrong contract)
- `.rpiv/artifacts/plans/2026-09-23_16-09-03_jev-typesafe-classifier.md` — original backend plan
- `.rpiv/artifacts/acceptance/2026-09-23_16-05-45_jev-typesafe-classifier.md` — original acceptance criteria
- `.rpiv/artifacts/plans/2026-07-21_19-27-12_classifier-routing-accuracy.md` — older classifier accuracy plan (merge-gate seam origin)

## Developer Context
**Q (discover: D1 — State becomes Jev-native content): The Jev request sends the full chat classifier prompt as `state`, including the 'Return your decision' directive (`extensions/routing.ts:846-848`). Keep or rebuild?**
A: Rebuild state Jev-native.

**Q (discover: D2 — Numeric doc-style confidence gating): Jev's numeric confidence is bucketed to words at `>=0.8/>=0.5` (`extensions/typesafe.ts:48-55`); non-numeric becomes silent 'medium'. Rework to doc-style numeric gating?**
A: Numeric doc-style gating.

**Q (discover: D3 — Distinguishable failure outcomes): Any unusable Jev answer silently returns `undefined`, identical to heuristics (`extensions/typesafe.ts:70-72`). Record distinguishable outcomes?**
A: Record failure reason.

**Q (discover: D4 — Scope: Jev path plus additive seam): The gating seam in `routing.ts` is shared with the chat backend. Where does scope stop?**
A: Jev path + additive seam.

**Q (discover: D5 — One tier choice plus atomic signal questions): Which question shape per the docs' decomposition guidance?**
A: One tier choice + signals.

**Q (discover: D6 — Contrastive criteria objects): `TIER_CRITERIA` are one-line strings (`extensions/typesafe.ts:36-43`). Upgrade to structured criteria?**
A: Contrastive objects.

**Q (discover: D7 — Image presence as a named state field): Jev is text-only. How should an image turn reach Jev?**
A: Named state field.

**Q (discover: D8 — Config warning for the dead thinking knob): `classifierModel.thinking` is accepted but never forwarded on the typesafe branch. What behavior?**
A: Config warning.

**Q (`extensions/routing.ts:444,469,483,491`): Per-gate numeric confidence floors — docs cite 0.5 do-not-act and 0.85 high-stakes; code has 0.8/0.5 implicit. Which floor set?**
A: 0.85 rule-override, 0.85 veto-suppression, 0.5 degrade — the FRD's open question, resolved at this research checkpoint.

**Q (`extensions/types.ts:35-40`): How should 'ran but unusable' vs 'transport failure' be recorded given the dormant union members?**
A: Repurpose dormant variants — `json-invalid` for unusable 200-OK bodies, `infra-failure` for HTTP/transport/stall.

**Q (`extensions/types.ts:55`): How should a 'Jev ran, answered unusably' result (no tier) be typed given `decideRouting` reads `.tier` at `routing.ts:437/466`?**
A: Optional tier field on `ClassifierResult`; gates guard on `failureReason !== 'success'` before reading `.tier`.

**Q (`extensions/config.ts:518-531`): Which condition fires the thinking+typesafe warning?**
A: Raw thinking set — `backend === 'typesafe' && rawClassifier.thinking !== undefined`; keep the value in config.

## Related Research
- `.rpiv/artifacts/research/2026-09-23_16-05-23_jev-typesafe-classifier.md` — prior Jev integration research; this document supersedes its contract assumptions with the doc-aligned decisions D1-D8.

## Open Questions
None. The FRD's single open question (per-gate floor values) was resolved at this research's developer checkpoint (0.85 / 0.85 / 0.5). The FRD's Suggested Follow-ups (dead `TYPESAFE_DEFAULT_MODEL` fallback, missing modelId allowlist, write-only `classifierCalibration`, oversized 90 s stall timeout) remain recorded there, confirmed out of this scope.
