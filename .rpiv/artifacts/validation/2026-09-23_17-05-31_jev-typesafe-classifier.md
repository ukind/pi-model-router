---
template_version: 1
date: 2026-09-23T17:05:31+0700
author: Yogiswara Utama
commit: 1673674c
branch: main
repository: pi-model-router
topic: "Validation of add Jev (typesafe.ai System One) as the model classifier backend"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-23_16-09-03_jev-typesafe-classifier.md"
tags: [validation, plan]
last_updated: 2026-09-23T17:05:31+0700
---
## Validation Report: Add Jev (typesafe.ai System One) as the model classifier backend

### Implementation Status

- ✓ Phase 1: Jev (TypeSafe System One) classifier backend — Fully implemented (uncommitted working tree on top of `1673674c`)

The run's own delta is exactly the 10 files the plan declares. `git status -uall` minus the
5 `--baseline` paths leaves `extensions/typesafe.ts` (new), `extensions/types.ts`,
`extensions/config.ts`, `extensions/routing.ts`, `extensions/provider.ts`,
`extensions/routing.test.ts`, `extensions/config.test.ts`, `extensions/provider.test.ts`,
`model-router.example.json`, `README.md` (309 insertions, 18 deletions). No file outside the
write-set was touched.

Scope floor (`--scope`): verdict `pass`, `findings` empty. No
`.rpiv/artifacts/verdicts/scope-quarantine__*.json` manifest exists, so no quarantine or
refused entry needs a ruling.

Pre-existing working-tree changes (baseline): the 5 paths recorded in
`baseline-2026-09-23T08-52-03-414Z.json` are run bookkeeping (goal, baseline, workflow logs).
They are out of scope and do not count as violations.

### Automated Verification Results

Plan criteria:

- ✓ Type check: `npx tsc --noEmit` — exit 0, whole tree.
- ✓ Suites: `npx vitest run extensions/routing.test.ts extensions/config.test.ts extensions/provider.test.ts` — 163/163 passed (83 routing, 44 config, 36 provider).
- ✓ Vendor constants: `grep -rFq "api.typesafe.ai/v1/systemone" extensions/ && grep -rFq "jev-latest" extensions/ && grep -rFq "TYPESAFE_API_KEY" extensions/` — exit 0.
- ✓ No key literal: `! grep -rEq "apikey_[0-9a-f]{16,}" extensions/ README.md model-router.example.json docs/` — exit 0.
- ✗ Name check (non-blocking): `grep -rFiq "jev" model-router.example.json && grep -rFiq "jev" README.md` — unrunnable as written. The default `grep` (GNU grep 3.0, `/usr/bin/grep`) aborts with SIGABRT (exit 134) on every `-F` + `-i` combination. This was reproduced on stdin and on a scratch file outside the repo, so the failure does not depend on repo content. The command exits 0 under the bundled Windows build (`/c/Program Files/coreutils/bin/grep`), and `grep -iq jev` exits 0 on both files. The criterion is ruled not met as written, non-blocking: an environment defect, not an implementation defect.

Acceptance inventory (`--acceptance`, all items mapped to phase 1 as `implemented`):

- ✓ a1: `npx vitest run extensions/config.test.ts` — 44/44. The Jev backend loads with no warning.
- ✓ a2: `grep -rFq "api.typesafe.ai/v1/systemone" extensions/ && grep -rFq "jev-latest" extensions/` — exit 0.
- ✓ a3: `grep -rFq "TYPESAFE_API_KEY" extensions/ && ! grep -rEq "apikey_[0-9a-f]{16,}" extensions/ README.md model-router.example.json docs/` — exit 0. The key is read from the environment (`extensions/typesafe.ts:93`) and no key literal exists.
- ✓ a4: `npx vitest run extensions/routing.test.ts` — 83/83. The Jev answer maps to a router tier.
- ✓ a5: `npx vitest run extensions/provider.test.ts` — 36/36. The provider test proves the Jev path ran: one fetch call, `isClassifier` true, tier `high`, delegation to `gpt-4o`.
- ⚠ a6 (non-blocking, unmeasurable as written): same `grep -rFiq` abort as above. The exact command exits 0 under `/c/Program Files/coreutils/bin/grep`, and the case-insensitive equivalent `grep -iq jev` exits 0 on both files. Item ruled unmeasurable as written, non-blocking, per the environmental proof.

No regressions: `runClassifier` has exactly one production caller (`extensions/provider.ts:628`, confirmed by grep and by graph inbound trace). The chat path keeps its shape, and its tests still pass.

### Code Review Findings

#### Matches Plan:

- `extensions/typesafe.ts` — matches the plan verbatim. Endpoint, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_API_KEY_ENV`, `TIER_CRITERIA`, the 0.8/0.5 confidence thresholds, `mapTypesafeResponse`, and the per-ref loop with manual abort composition.
- `extensions/types.ts:24-29` — `ClassifierBackend` union and the optional `backend` field, as planned.
- `extensions/config.ts:514-531` — `backend` is read in the object branch. An unknown value warns and degrades to the chat transport, which mirrors the `thinking` rule above it. The string-form branch (`config.ts:468`) is unchanged. `mergeClassifier` spreads the field with no extra code.
- `extensions/routing.ts:265-285` — `buildClassifierPromptContext` is extracted and pure. The chat path calls it at `routing.ts:890-893`, and the replacement is behavior-identical to the removed inline assembly.
- `extensions/routing.ts:837,841-853` — the tenth parameter defaults to `'chat'`, so the existing chat path and its tests are inert to the change.
- `extensions/provider.ts:640` — passes `state.currentConfig.classifierModel.backend`. The call site sits inside the `classifierModel` guard at `provider.ts:623`, so the access is safe.
- Tests — `routing.test.ts:1118` nests `describe('typesafe (Jev) backend)` inside `describe('runClassifier')` (`routing.test.ts:901`) and reuses its `mockRegistry`, with all five planned cases. `config.test.ts:632,647` adds the two planned cases. `provider.test.ts:1554` adds the end-to-end Jev case. Both test files gained `afterEach` cleanup that unstubs globals and deletes `TYPESAFE_API_KEY`.
- Docs — `README.md:120,144,156-177` and `model-router.example.json:3` carry the three planned edits.
- Goal conformance (`--goal`) — Jev is now a selectable classifier backend, and the goal's API key is read at runtime from `TYPESAFE_API_KEY`. The key literal was deferred by an approved `## Out of Scope` line, and acceptance item a3 enforces the deferral.

#### Deviations from Plan:

- Plan deviation, non-blocking — criterion 5 is unrunnable as written (the `grep -F` + `-i` abort described above). The intent holds under an equivalent invocation, so no implementation gap exists.
- Plan deviation, non-blocking, comment-only — the plan authored two line citations against the pre-change `routing.ts`, and the implementation copied them verbatim. The phase's own insertions in `routing.ts` made both stale:
  - `extensions/typesafe.ts:26` cites `(routing.ts:678)`. Line 678 is now `const reasoningLine = ...`. The cited default (`let confidence: ConfidenceLevel = 'medium';`) is now at `routing.ts:701`. The pointer still lands inside `parseClassifierOutput` (`routing.ts:660-730`), so the target stays locatable.
  - `extensions/typesafe.ts:95` cites `(routing.ts:826)`. That line is now blank, just above `export const runClassifier` at `routing.ts:827`. The cited manual abort composition is now at `routing.ts:864` (`const refAbort = new AbortController();`) inside the chat ref loop.
  - Both were accurate against the base commit (`git show HEAD:extensions/routing.ts` has `let confidence ... = 'medium'` at 678 and `const refAbort` at 825). There is no behavioral or test impact, and no criterion exercises the numbers. The fix is a two-token edit per comment, recorded under Recommendations.

#### Pattern Conformance:

- ✓ Arrow-function consts, strict TypeScript with no `any`, top-level static imports, and exported-const-then-interface ordering. The new module matches every sibling in `extensions/`.
- ✓ Error handling follows the codebase rule: every failure mode in `runTypesafeClassifier` collapses to `undefined`, so the heuristics take over and no error reaches the turn. This mirrors `parseClassifierOutput`'s unparseable path and the chat ref loop's `!response.ok` continuation.
- ✓ Test style matches the siblings: nested `describe`, `vi.stubGlobal('fetch', ...)`, and `afterEach` global cleanup, as in the stall tests.
- ✓ Line-number citations in comments are an established convention (`extensions/state.ts:62,79,177`), but they rot under edits. See Deviations and Potential Issues.

#### Potential Issues:

- Pre-existing, non-blocking — `extensions/state.ts:62` and `state.ts:79` cite `types.ts:70-79` as the six non-optional `RoutingDecision` fields. That range already pointed into `RoutedTierConfig` at the base commit (`git show HEAD:extensions/types.ts` has `RoutedTierConfig` at 66 and `RoutingDecision` at 96). This change's 4-line insert in `types.ts` moved `RoutedTierConfig` to line 70, so the stale range now starts exactly on it. The debt predates the run, and `state.ts` is outside the plan's write-set.
- Low, non-blocking — `docs/ARCHITECTURE.md:26` describes the classifier step only as "a fast LLM is called". The `typesafe` backend is not named there. The plan's write-set excluded the file, and the README documents the field.
- Evidence note — the codebase knowledge graph predates this change (indexed `2026-09-23T09:03:56Z`; all 10 touched paths report `metadata_changed`, and `extensions/typesafe.ts` is not tracked). Caller claims in this report were confirmed by grep against the live source. Re-index before the next graph-based pass.

### Manual Testing Required:

The plan's three manual criteria. Each needs a live key and one interactive turn:

1. Jev-configured turn:
   - [ ] Set `TYPESAFE_API_KEY`, select `{ "backend": "typesafe", "model": "typesafe/jev-latest" }`, and run one turn. The routing notification must show the classifier tier and its confidence.
2. Missing key:
   - [ ] Unset `TYPESAFE_API_KEY` and run one turn. The turn must complete on the heuristics with no error notification.
3. Wrong key:
   - [ ] Use an invalid key and run one turn. The HTTP 401 must fall through to the heuristics, and the turn must complete.

### Recommendations:

- Fix the two stale citations: `extensions/typesafe.ts:26` to `routing.ts:701`, and `extensions/typesafe.ts:95` to `routing.ts:864`. Citing the symbol name instead of a line number avoids future rot.
- Optional: refresh the stale `types.ts:70-79` range in `extensions/state.ts:62,79`, or switch that comment to symbol names too.
- Optional: name the `typesafe` backend in the classifier step of `docs/ARCHITECTURE.md`.
- Ready to commit — the implementation is complete and validated.
