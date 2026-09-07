---
date: 2026-07-18T20:46:11+0700
author: Yogiswara Utama
commit: c028bcb9
branch: main
repository: pi-model-router
topic: 'c028bcb9 Structured-Flags Defect Fix Design'
tags:
  [
    design,
    defect-fix,
    budget-downgrade,
    image-promotion,
    state-validator,
    notify-chain,
  ]
status: complete
last_updated: 2026-07-18T20:46:11+0700
last_updated_by: Yogiswara Utama
type: feature_development
---

# Handoff: Design skill — fix 6 defects from c028bcb9 review (Slices 1-2 approved, Slice 3 needs atomicity fix)

## Task(s)

**Running `/skill:design` on the code review artifact** `.rpiv/artifacts/reviews/2026-07-18_19-08-10_commit-structured-flags.md`. The review identified 3 critical (I1-I3) and 3 important (Q1-Q3) findings in the c028bcb9 "structured flags" commit.

| Status                  | Task                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ Complete             | Steps 1-5: Read review, spawn research agents, dimension sweep, developer checkpoint (3 questions asked), decomposition into 5 slices, skeleton artifact written                                          |
| ✅ Approved             | Slice 1: type guards + per-field validator (Q2) — `config.ts`, `state.ts`, `index.ts`, `state.test.ts`                                                                                                    |
| ✅ Approved             | Slice 2: routing.ts budget floor branch (Q3) — `routing.ts`, `routing.test.ts`                                                                                                                            |
| ⚠️ Generated, needs fix | Slice 3: provider.ts image-promotion gates (I1+I2) — code generated, slice-verifier found an **atomicity VIOLATION** (see Learnings). Code is in the artifact but NOT yet presented to user for approval. |
| 🔲 Pending              | Slice 4: drop `level` param from `getUnsupportedTiers` (I3) — `config.ts`, `index.ts`, `commands.ts`, test files                                                                                          |
| 🔲 Pending              | Slice 5: index.ts notify chain fix (Q1) — `index.ts`                                                                                                                                                      |

## Critical References

1. **Design artifact** (source of truth): `.rpiv/artifacts/designs/2026-07-18_19-57-05_c028bcb9-defect-fix.md` — contains all decisions, architecture code fences, and slice success criteria.
2. **Review artifact** (input): `.rpiv/artifacts/reviews/2026-07-18_19-08-10_commit-structured-flags.md` — the 12 findings (I1-I3, Q1-Q3, Q4-Q9) and the recommendation table.
3. **Types interface** (ground truth for sanitizer): `extensions/types.ts:70-89` — `RoutingDecision` has 9 non-optional fields and 11 optional fields.

## Recent changes

No source files modified — design skill produces a document artifact only; `implement` does the source edits.

**Artifact edits made during this session:**

- `.rpiv/artifacts/designs/2026-07-18_19-57-05_c028bcb9-defect-fix.md` — created skeleton, filled Slice 1 and Slice 2 code + tests, filled Slice 3 code + tests (unapproved). Design History shows Slices 1-2 as "approved as generated", Slices 3-5 as "pending".

## Learnings

### Slice 1 type-error (FIXED)

The initial `sanitizeRoutingDecisionFields` only defaulted `phase` and `thinking` for invalid values, treating `targetProvider`/`targetModelId`/`targetLabel`/`reasoning` as droppable. But `RoutingDecision` (`types.ts:70-79`) declares all 6 as **non-optional** — `tsc` strict mode rejects the object literal. **Fix applied**: all 6 non-optional fields now get defensive defaults (`''` for strings, `'implementation'` for phase, `'medium'` for thinking). The slice-verifier caught this on the first pass; re-verified OK after fix.

### Slice 3 atomicity VIOLATION (UNFIXED — next agent must resolve)

The slice-verifier found that the **I1 test** (`provider.test.ts`, "should NOT promote tier for images when budget is exceeded") asserts `expect(mockState.lastDecision.isBudgetForced).toBe(true)`. This test sets `accumulatedCost=10; maxSessionBudget=1` with a short message → heuristic routes to `tier='low'` → budget downgrade chain fires. **Without Slice 2's Q3 floor branch** (which adds `else if (isBudgetExceeded && tier === 'low') { isBudgetForced = true }`), the flag stays `false` → test fails in isolation. Since Slice 2 IS already approved and will be implemented first, this is a **sequencing dependency, not a code bug**. Two resolution paths:

1. **Surface-and-proceed**: present the verbatim VIOLATION to the user at the 6.3 micro-checkpoint with a one-line rationale ("test depends on Q3 floor branch from Slice 2, which is already approved and ordered first"). Let the user ratify.
2. **Fix-and-re-dispatch**: rewrite the I1 test to use a prompt that lands on `tier='high'` (e.g. `'think hard'`), then budget downgrades to `'medium'` → `isBudgetForced=true` WITHOUT needing Slice 2's floor branch. This avoids the cross-slice dependency entirely.

Option 2 is cleaner — the test should be self-contained. The existing budget test at `provider.test.ts:530` uses `'plan the architecture carefully'` (explicit high hint) + `accumulatedCost >= budget` → high downgraded to medium. The I1 test can follow the same pattern but add an image attachment.

### Decision I2 doc/code drift (minor)

The artifact's Decision I2(a) text says `tiersToTry = pinnedTier ? [] : ...` (modify the ternary inside the block). The actual Slice 3 code does `if (imageAttached && !isBudgetExceeded && !pinnedTier)` (gate the outer `if`). Functionally equivalent but the Decision prose doesn't match the emitted code fence. Low priority — the code is correct.

### Key architectural patterns

- **Type guard style**: equality-chain (`isRouterTier`, `isRouterPhase`) at `config.ts:42-46`. Follow this for any new union-type guards.
- **Validate-if-present**: `state.ts:46-54` (`accumulatedCost`) pattern. The new `isRouterPersistedState` uses `hasValidRequiredDecisionFields` for required fields; consumer (`index.ts:~365`) calls `sanitizeRoutingDecisionFields` for optional-field drop.
- **Budget snapshot**: `provider.ts:298-300` captures `pinnedTier` and `isBudgetExceeded` as `const` before `decideRouting`. Both are available for the image-promotion gate without new variable capture.

## Artifacts

- `.rpiv/artifacts/designs/2026-07-18_19-57-05_c028bcb9-defect-fix.md` — **primary artifact**, status `in-progress`. Contains all 5 slices' Architecture code fences (Slices 1-3 filled, Slices 4-5 have skeleton placeholders from the initial write). `## Slices` section has Success Criteria for all 5. `## Design History` shows approval status.
- `.rpiv/artifacts/reviews/2026-07-18_19-08-10_commit-structured-flags.md` — input review artifact (read-only).

## Action Items & Next Steps

1. **Fix Slice 3 I1 test atomicity**: rewrite the I1 test (`"should NOT promote tier for images when budget is exceeded"`) so it uses a prompt that routes to `tier='high'` via explicit hint, then budget-downgrades to `tier='medium'` — making `isBudgetForced=true` without depending on Slice 2's Q3 floor branch. Then re-dispatch slice-verifier.
2. **Present Slice 3 to user** (Step 6.3 micro-checkpoint): show the condensed review with the I2 doc/code drift note, get approval.
3. **Generate Slice 4** (I3 — drop `level` param from `getUnsupportedTiers`): modify `config.ts:687-704` signature, update callers at `index.ts:518-519` and `commands.ts:370-371`, delete `config.test.ts:559` test, update `index.test.ts:26` stub. Verify + present.
4. **Generate Slice 5** (Q1 — add `isVetoed` to notify chain): add `else if (decision.isVetoed) source = 'vetoed';` at `index.ts:104`, update comment at `index.ts:96-97`. Verify + present.
5. **Step 7: Finalize** — verify all Architecture code fences filled, all `## Slices` Success Criteria filled, flip `status: in-progress` → `status: ready`.
6. **Step 8: Present** — tell user the artifact location and suggest `/skill:plan .rpiv/artifacts/designs/2026-07-18_19-57-05_c028bcb9-defect-fix.md`.

## Other Notes

- **Scope**: Q4-Q9 (6 blue suggestions) explicitly deferred per user decision. Each is a separate PR.
- **Advisor was consulted** for I3 decision: advisor recommended option (c) — drop the `level` parameter entirely. This was the only question that went to advisor; the user typed "ask advisor modal for guidance" as a free-form response.
- **Existing design artifact in the same directory**: `.rpiv/artifacts/designs/2026-07-18_15-05-21_deslop-false-promises.md` (status: ready) is a prior design for a different set of defects from the same commit. No overlap with this design's scope.
- **Test fixtures**: `routing.test.ts:219-223` defines `profile` with all 3 tiers (`high: openai/gpt-4o`, `medium: openai/gpt-4o-mini`, `low: openai/gpt-4o-micro`). `provider.test.ts` uses `mockState`, `mockPi`, `mockActions`, `registeredProviderOptions`, `MockEventStream` — follow the existing image-promotion test at `provider.test.ts:553-597` for Slice 3 pattern.
- **`RoutingDecision` field coverage**: the `sanitizeRoutingDecisionFields` function in the Slice 1 Architecture code covers all 20 fields of `RoutingDecision` (`types.ts:70-89`). The 9 non-optional fields are defaulted; the 11 optional fields are dropped if invalid.
