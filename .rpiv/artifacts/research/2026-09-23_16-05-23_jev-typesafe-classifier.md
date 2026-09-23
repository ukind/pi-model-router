---
date: 2026-09-23T16:05:23+0700
author: Yogiswara Utama
commit: 1673674c
branch: main
repository: pi-model-router
topic: 'add Jev (typesafe.ai System One) as the model classifier backend'
tags: [research, classifier, typesafe, jev, external-api, grounding]
status: ready
last_updated: 2026-09-23T16:05:23+0700
last_updated_by: Yogiswara Utama
parent: brief - "add Jev from typesafe.ai ... for model classifier"
---

# Grounding: Jev (TypeSafe System One) as the Model Classifier

## Brief classification

Tier B. The brief names a service and a purpose. It names no root cause, no file, and no fix.
This document maps ground truth for a one-phase plan. It holds no design decision except the
lazy recommendation in section 6.

## 1. What the brief asks

Add Jev as the model classifier. The router runs the classifier before heuristics. The
classifier selects tier `high`, `medium`, or `low` for the turn.

## 2. Jev API contract (external - vendor docs, no repo citation)

Source: https://docs.typesafe.ai/introduction/quickstart (fetched 2026-09-23).

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Auth header: `Authorization: Bearer <API_KEY>`
- Request body: `{ state, model: "jev-latest", questions }`
- Question types: `choice` (criteria map), `score` (criteria list), `noul` (yes/no probability)
- Response: `{ model, answers: { <key>: {...} }, usage: { input_tokens, output_tokens } }`
- Choice answer: `{ type: "choice", choice, confidence, probabilities }`
- Score answer: `{ type: "score", score, confidence, legend, probabilities }`
- Noul answer: `{ type: "noul", noul }`
- `confidence` is a number in [0,1]. TypeSafe derives it from the probability spread
  (https://docs.typesafe.ai/confidence.md).
- The Python SDK reads `TYPESAFE_API_KEY` from the environment. Default model is `jev-latest`.

Fit note: the API is not chat-shaped. A request carries `state` plus typed `questions`. The
answer is structured. There is no text stream.

## 3. Verified anchors

| Item | Location | Result |
|---|---|---|
| `runClassifier` definition | `extensions/routing.ts:804` (ends 926) | confirmed |
| Classifier prompt builder | `extensions/routing.ts:192` | confirmed |
| Output parser | `extensions/routing.ts:637` | confirmed |
| Chat stream call | `extensions/routing.ts:876` | confirmed |
| Stall helpers | `extensions/routing.ts:730`, `:778` | confirmed |
| Provider gate + call | `extensions/provider.ts:623`, `:628` | confirmed (early draft said 616-660) |
| Abort check after classifier | `extensions/provider.ts:650` | confirmed |
| `ClassifierConfig` | `extensions/types.ts:24` | confirmed |
| Ref grammar | `extensions/config.ts:152` requires `provider/model` | confirmed |
| Config normalize + merge | `extensions/config.ts:458-528`, `:107` | confirmed |
| Example config | `model-router.example.json:3` | confirmed |
| Docs | `README.md:11`, `:119`, `:142`, `:147`; `docs/ARCHITECTURE.md` | confirmed |
| Graph line drift | index said `runClassifier` at 698-783; source says 804 | drift found, index refreshed |

## 4. Code references - the classifier path, end to end

1. `extensions/provider.ts:623` - gate: `if (!pinnedTier && state.currentConfig.classifierModel)`.
2. `extensions/provider.ts:628` - `await runClassifier(classifierRefs, modelRegistry, ...)`.
3. `extensions/routing.ts:804` - loops the refs: primary then `fallbacks`.
4. `extensions/routing.ts:834` `modelRegistry.find`; `:835` `if (!model) continue`;
   `:838` `getApiKeyAndHeaders`; `:843` `if (!auth.ok || !auth.apiKey) continue`.
5. `extensions/routing.ts:876` `streamSimple`; `:884` `stallGuardedStream`;
   `:902` `parseClassifierOutput`; `:904` `return undefined` on `unparseable`.
6. `extensions/provider.ts:650-652` - turn abort after the classifier await.
7. `extensions/index.ts:146` `recordDebugDecision`; `:160` source `'classifier'`;
   `:166-167` confidence in the notify text.

## 5. Integration points

- `extensions/types.ts:24` - `ClassifierConfig { model, thinking?, fallbacks? }`. Needs a backend
  discriminator, a Jev model id, and a key source.
- `extensions/config.ts:458-528` - normalize + `warnings.push`; `:107-113` `mergeClassifier`
  (flat spread); `:139` `mergeConfig`.
- `extensions/routing.ts:804` - `runClassifier` must branch to a non-stream backend, or an
  adapter provider must be registered.
- `extensions/types.ts:31` - `ClassifierFailureReason` already has `'infra-failure'`. Reuse it
  for HTTP failures.
- `extensions/index.ts:146`, `extensions/ui.ts` - provenance display only.
- `README.md:142`, `model-router.example.json:3`, `docs/ARCHITECTURE.md` - documentation.
- Tests: `extensions/routing.test.ts:901` `describe('runClassifier')`, `:24-26` mocks
  `@earendil-works/pi-ai/compat`; `extensions/provider.test.ts:50-53`, `:89-98` mock registry;
  `extensions/config.test.ts:585-620`. Command: `npm test` (`vitest run`).

## 6. Two candidate shapes

A. Adapter provider - `pi.registerProvider('typesafe', {...})` (precedent `extensions/provider.ts:1169`).
   Needs a `streamSimple` that calls the TypeSafe API and emits the `Tier:` text that
   `extensions/routing.ts:637` parses. Cost: the provider enters the selectable model list.
B. First-class backend - one new module that calls the API and returns `ClassifierResult`
   directly. `extensions/routing.ts:804` branches on the backend type.

Recommendation (lazy): B. Shape A invents a fake text contract and exposes a new model that
cannot answer a chat request. Shape B maps `answers.tier.choice` to `RouterTier` with no parser.

## 7. Conventions the implement lane must match

- No `any`. Arrow functions. Static imports only.
- Config faults warn, never throw: `warnings.push(...)` (`extensions/config.ts:470`, `:520`).
- Keep the `provider/model` ref grammar (`extensions/config.ts:152`). A bare `"jev-latest"`
  throws at `:156`.
- Secrets: `extensions/` has no env read today. Read `process.env.TYPESAFE_API_KEY`. Never
  hardcode the key. `pi.registerProvider` supports `$ENV_VAR` (pi `types.d.ts:984`) for shape A.
- Failure semantics: per-ref `continue` (`extensions/routing.ts:835`, `:843`); an infra failure
  returns `undefined` and heuristics take over (`:904`). No throw reaches the turn.
- Stall + abort: wrap each external await in `raceStallTimeout` (`extensions/routing.ts:730`)
  and honor `signal` (`:879`). A `fetch` must accept an `AbortSignal`.
- Provenance: fill `ClassifierResult` (`extensions/types.ts:50`) - tier, confidence, reasoning,
  rawText, failureReason.
- Tests mock the transport. No live API call in a test (`extensions/routing.test.ts:24-26`).

## 8. Open decisions for the plan

1. Confidence mapping: Jev `confidence` in [0,1] to `ConfidenceLevel`. Thresholds are needed.
   The veto gate consumes confidence.
2. Prompt reuse: `buildClassifierPrompt` (`extensions/routing.ts:192`) targets a chat model. Jev
   needs `state` plus `questions.criteria`. Decide: text as `state`, or a criteria map from
   `ClassifierPromptContext`.
3. Secret placement: env var (recommended) or config field.
4. Question type: `choice` with criteria {high, medium, low} returns the tier directly. `score`
   returns an ordered level. Choice is the shorter path.
5. HTTP 401 and 429 map to `'infra-failure'` and fall through to heuristics.

## 9. Prior art in this repo

- `.rpiv/artifacts/research/2026-07-21_19-14-23_classifier-routing-accuracy.md` - classifier gaps.
- `.rpiv/artifacts/research/2026-08-29_11-37-58_external-tier-classifier-approaches.md` - external
  routers. No TypeSafe or Jev entry. This document is the first TypeSafe record.
- `.rpiv/artifacts/plans/2026-07-21_19-27-12_classifier-routing-accuracy.md` - 4 phases.

## 10. Evidence limits

- Coverage check on the 8 extension paths: `no_recorded_issue`, freshness `metadata_changed`.
  Index generation was 2026-09-04. HEAD is 2026-09-23.
- The index was stale. It reported `runClassifier` at 698-783. Source says 804. I refreshed the
  index during this grounding (nodes 498 to 1603) and re-verified every anchor against source.
- Jev contract facts come from vendor documentation, not a live call. No request went to
  api.typesafe.ai.
- Tier 2 (verify) evidence. Not a full audit.
