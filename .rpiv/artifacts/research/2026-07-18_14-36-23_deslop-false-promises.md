---
date: 2026-07-18T14:36:23+0700
author: Yogiswara Utama
commit: c028bcb9
branch: main
repository: pi-model-router
topic: 'De-slop audit: find and fix false promises in pi-model-router'
tags:
  [
    research,
    codebase,
    deslop,
    false-promises,
    types,
    config,
    routing,
    provider,
    commands,
    tests,
  ]
status: ready
last_updated: 2026-07-18T14:36:23+0700
last_updated_by: Yogiswara Utama
---

# Research: De-Slop Audit — False Promises in pi-model-router

## Research Question

De AI-slop current codebase, find and fix any false promise, to make it real.

## Summary

10 false-promise / AI-slop findings across 9 source files, 7 test files, and 3 doc files. The codebase is genuinely implemented — budget tracking, fallback chains, veto gate, and pin persistence are all real, working code paths. But a layer of dead observability plumbing, dead default branches, and README claims that diverge from runtime behavior accumulates. The shared anti-pattern: **types/contracts promise more than the runtime enforces**.

Severity breakdown:

- **2 real bugs**: Q3 (veto false-positive via substring), Q5 (continuation guard broken post-in-tier-fallback)
- **3 dead code**: Q1 (3 dead `ClassifierFailureReason` variants), Q2 (dead tier-based thinking default), Q7 (write-only `lastPhase`)
- **3 doc drift**: Q3 (rules matching), Q4 (`reasoning`/`thinkingLevels` false promise), Q10 (upward escalation undocumented)
- **2 code quality**: Q8 (dead guard + undocumented `all`), Q9 (50ms sleeps + misleading comment)

## Detailed Findings

### Q1: ClassifierFailureReason — 3 Dead Variants

**Type union** at `types.ts:30-35` declares 5 variants: `'success' | 'model-not-found' | 'auth-failure' | 'stream-error' | 'unparseable'`.

**Only producer** is `runClassifier` at `routing.ts:540-630`. Every branch that should produce a non-success value discards the reason instead:

- Registry miss (`routing.ts:553`): `if (!model) continue;` — no `'model-not-found'`
- Auth failure (`routing.ts:556`): `if (!auth.ok || !auth.apiKey) continue;` — no `'auth-failure'`
- Stream error (`routing.ts:627-628`): `catch (error) { void error; }` — no `'stream-error'`
- Unparseable (`routing.ts:615`): `if (parsed.failureReason === 'unparseable') return undefined;` — converted to `undefined`, never a `ClassifierResult`

Only return with a `ClassifierResult` is at `routing.ts:624` — always `failureReason: 'success'`.

**Dead branches downstream:**

- `index.ts:107-109`: `decision.failureReason !== 'success'` guard in `recordDebugDecision` — unreachable
- `ui.ts:30-32`: `<${failureReason}>` display in `formatDecision` — unreachable

**Tests** (`routing.test.ts:525-806`): only assert `'success'` or `'unparseable'`-from-`parseClassifierOutput`. No test ever asserts a `ClassifierResult` with `'model-not-found'`, `'auth-failure'`, or `'stream-error'`.

**Fix fork:**

- A) Enrich `runClassifier` to return failed `ClassifierResult` carrying the real reason — makes observability real. ~30 LoC + 3 tests.
- B) Drop the 3 dead variants from the union + remove dead branches in `index.ts:107` and `ui.ts:30`. Makes types honest. ~10 LoC deletion.

### Q2: Tier-Based Thinking Default — Dead Code

`normalizeTierConfig` at `config.ts:283-286` always sets `thinking: isThinkingLevel(value.thinking) ? value.thinking : 'medium'`. Every normalized `RoutedTierConfig.thinking` is always defined.

**Dead branches:**

- `routing.ts:159-162`: `routed.thinking ?? (tier === 'high' ? 'high' : ...)` — `??` never fires
- `provider.ts:605-612`: `fbBase` fallback — same dead `??` chain

**Symptom**: `high` tier omitting `thinking` silently runs at `'medium'` rather than the `'high'` default the dead branch implies was intended. No warning emitted for omitted `thinking` (only for invalid values).

**Tests**: `routing.test.ts:227-231` constructs profiles without `thinking` — the `??` fallback fires but no test asserts `decision.thinking`. `config.test.ts:231-272` doesn't assert what happens when `thinking` is omitted.

**Fix fork:**

- A) Change `normalizeTierConfig` to leave `thinking` undefined when omitted → let tier-based default fire. ~5 LoC + 3 tests.
- B) Delete dead `??` chains, document `'medium'` is always the default. ~8 LoC deletion + README update.

### Q3: Rules vs Hints Matching — Substring vs Word-Boundary Bug

README at line 120 says rules use "substring match, case-insensitive". Code at `matchHighestTierRule` (`routing.ts:192`) calls `containsAnyWord` — word-boundary regex via `wordBoundaryRegex` (`routing.ts:80-94`). Rule `"deploy"` will NOT match `"redeployment"`.

**Separate bug**: Classifier veto gate at `routing.ts:300-315` uses `containsAny` (plain substring). Low hints include `'small'`, `'tiny'` — so prompt containing `"smallest"` substring-matches and vetoes classifier verdict down to `low`. This is a false-positive veto on legitimate prompts like "smallest possible deployment footprint".

**Call site split:**

- `containsAnyWord`: 1 call site (rules at `routing.ts:192`)
- `containsAny`: 7 call sites (veto gate + heuristics at `routing.ts:333-397`)

**Veto tests** (`routing.test.ts:542-646`) only use exact whole-word hints — no test exercises a substring false-positive.

**Fix fork:**

- A) Switch veto/heuristic to `containsAnyWord` (consistent with rules). Fix phrase hints like `'step by step'`. Update README to "word-boundary match". ~5 LoC + 2 tests.
- B) Switch rules to `containsAny` (consistent with README). Loses word-boundary protection. ~1 LoC.
- Recommended: A. The veto false-positive is a real user-facing bug.

### Q4: `reasoning`/`thinkingLevels` Config — False Promise

README at line 240 claims `"reasoning": false` "disables reasoning and restricts the available thinking levels". `normalizeTierConfig` docstring at `config.ts:230-237` admits `resolvedThinkingLevels` is "advisory-only" and enforcement is "deferred".

**Runtime gate** at `provider.ts:543-551` consults only `targetModel.reasoning` (live registry boolean). Config `reasoning: false` on a tier has zero runtime effect if the registry model has `reasoning: true`.

**`thinkingLevels: ['low']`** only affects whether `xhigh` is exposed in the TUI via `collectProfileThinkingLevels` (`config.ts:630-639`) → `thinkingLevelMap` at `provider.ts:215-222`. Never restricts actual routing.

**`resolvedThinkingLevels` consumers**: only `collectProfileThinkingLevels` → `thinkingLevelMap` for xhigh UI. No runtime restriction.

**Fix fork:**

- A) Honor config `reasoning: false` in the delegation gate + filter `decision.thinking` through `resolvedThinkingLevels`. Feature add — ~15 LoC + tests.
- B) Rewrite README + example to say these fields are advisory/warnings-only. Doc fix — ~30min.
- Recommended: B first (honest docs), A later if runtime enforcement is desired.

### Q5: Google Continuation Guard — Broken Post-In-Tier-Fallback

**The bug**: In-tier fallback at `provider.ts:630-632` only sets `decision.isFallback = true` — does NOT update `targetProvider`/`targetModelId`/`targetLabel`. Compare cross-tier fallback at `provider.ts:614-616` which DOES update all three.

**Consequence**: After in-tier fallback, `lastDecision.targetLabel` still points to the tier PRIMARY (the model that failed), not the fallback model that actually streamed. The continuation guard at `provider.ts:338-351` checks `previousDecision.targetLabel !== decision.targetLabel` — since both point to the tier primary, the guard does NOT fire when it should.

**Scenario**: Turn N streams `google/gemini-2.5-flash` (fallback after `gemini-2.5-pro` failed). `decision.targetLabel` still says `gemini-2.5-pro`. Turn N+1 (toolResult) — guard checks `'gemini-2.5-pro' !== 'gemini-2.5-pro'` → `false` → guard doesn't fire → delegation loop retries `gemini-2.5-pro` (the model that FAILED) first, potentially hitting a thought-signature replay error.

**Second bug**: Even when the guard fires, `modelsToTry` at `provider.ts:466-470` always rebuilds from tier config — `decision.targetLabel` is never used to reorder the list. The guarded model isn't tried first.

**Test** at `provider.test.ts:247-284` only covers cross-tier label divergence. No test covers in-tier-fallback-then-continuation.

**Fix:**

1. In-tier fallback (`provider.ts:630-632`): also update `targetProvider`/`targetModelId`/`targetLabel` to match the model that actually streamed (mirror cross-tier branch).
2. When continuation guard fires: insert `decision.targetLabel` at front of `modelsToTry`.

### Q6: Budget Tracking — Real, with Documented Soft Spots

Budget tracking is **real**: `accumulatedCost` accrues from `event.message.usage?.cost?.total` at `provider.ts:581-583`, persists via `state.ts:104`, restores via `index.ts:364`, gates routing at `provider.ts:300-302`.

**Soft spot 1** — ponytail leak at `provider.ts:591-598`: mid-stream error without usage data silently drops cost. Explicitly acknowledged in code comment.

**Soft spot 2** — per-turn gate at `provider.ts:300-302`: `const isBudgetExceeded` evaluated once before streaming. Single turn can overshoot arbitrarily. By design — no mid-stream interrupt.

**Test gap**: Budget accrual tests exist (`provider.test.ts:140-535`). But no integration test for `isBudgetExceeded → decideRouting → tier downgrade` through the provider stream. Unit-only at `routing.test.ts:349-367`.

**Fix**: Add integration test + README caveat about soft per-turn cap. No code change needed.

### Q7: Write-Only `lastPhase` Persistence

`RouterPersistedState.lastPhase` at `types.ts:106` — declared, written at `state.ts:101`, tested at `state.test.ts:167`, **never read** at `index.ts:330-395`.

Phase stickiness flows through restored `lastDecision.phase` consumed at `routing.ts:308`. `lastPhase` is redundant.

`isRouterPersistedState` (`state.ts:30-42`) doesn't validate `lastPhase` either.

Compare `pinTier` (`index.ts:355-356`): intentional legacy-compat migration field, IS read at restore. Not slop.

**Fix**: Delete `lastPhase` from type (`types.ts:106`), builder (`state.ts:101`), test (`state.test.ts:167`). ~5 LoC deletion.

### Q8: Commands Surface — Dead Guard + Undocumented `all`

**Dead guard** at `commands.ts:330`: `if (tier !== 'all' && !tierValues.includes(tier as string))` — unreachable. By line 330, `tier` is always `'all'`, `'high'`, `'medium'`, or `'low'` (validated/returned at lines 310-316).

**`'all'` tier**: accepted at `commands.ts:310`, tested at `commands.test.ts:757-766`, but not in autocomplete (`commands.ts:113-160`), error message (`commands.ts:313`: "Use high, medium, or low"), or help text.

**`debug clear` mutation**: `commands.ts:476` uses `state.debugHistory.length = 0` (mutation) while `recordDebugDecision` at `index.ts:91` uses `debugHistory = [...]` (reassignment). Works through getter indirection but test at `commands.test.ts:289` uses plain POJO, not getter-backed state.

**Fix**: Delete dead guard. Add `'all'` to error message + autocomplete. Replace `debugHistory.length = 0` with a `clearDebugHistory()` method using reassignment.

### Q9: Orchestrator — 50ms Sleep Races + Misleading Comment

**50ms sleeps** at `index.ts:224` and `index.ts:311` — timing-based sync after `registerProvider`. `registerProvider` is called without `await` (`provider.ts:272`), test mocks are synchronous (`index.test.ts:51`). No evidence it's async. Classic flake source.

**Misleading comment** at `index.ts:98-99`: "Check isFallback first so pinned-then-fallbacked decisions classify as 'fallback' not 'pin'" — but the actual order is `isBudgetForced > isClassifier > isRuleMatched > isFallback > isPinned > heuristic`. Classifier/rule checked BEFORE fallback, contradicting the comment.

**Widget inconsistency**: `getDecisionFlags` (`ui.ts:17-25`) shows ALL flags (non-exclusive). `recordDebugDecision` reports ONE source (exclusive). A classifier+fallback decision shows `source='classifier'` in debug but `flags=['fallback','classifier']` in widget. Also: `getDecisionFlags` doesn't check `isPinned` at all.

**Fix**: Remove 50ms sleeps (or replace with proper sync). Rewrite comment to match actual priority order. Add `isPinned` to `getDecisionFlags`.

### Q10: Test Honesty — Untested Paths + README Under-Promise

**Untested paths:**

- No test invokes `runClassifier` through the real provider stream (`provider.ts:305-320`). All classifier tests are unit-level via `routing.test.ts`.
- `buildDelegationTierChain` (`routing.ts:106-115`) has zero tests.
- Cross-tier fallback (all in-tier models fail → different tier succeeds) never tested in `provider.test.ts`.
- No test for decision cloning rationale (cross-tier mutation + `recordDebugDecision` interaction).

**README under-promise**: Lines 14 and 195 say fallback is "high → medium → low" (down-only). Code does down-then-up for non-budget: `buildDelegationTierChain('medium', false)` = `['medium','low','high']`. Code comment at `routing.ts:103` accurately says "down-then-nearest-up" but README omits upward escalation.

**Fix**: Add `buildDelegationTierChain` tests (3 tiers × 2 budget states = 6 cases). Add cross-tier fallback provider test. Fix README to document upward escalation.

## Code References

- `extensions/types.ts:30-35` — ClassifierFailureReason union (Q1)
- `extensions/types.ts:106` — lastPhase declaration (Q7)
- `extensions/routing.ts:75-94` — containsAny vs containsAnyWord (Q3)
- `extensions/routing.ts:106-115` — buildDelegationTierChain (Q10)
- `extensions/routing.ts:159-162` — dead thinking default (Q2)
- `extensions/routing.ts:192` — matchHighestTierRule calls containsAnyWord (Q3)
- `extensions/routing.ts:300-315` — veto gate uses containsAny (Q3)
- `extensions/routing.ts:540-630` — runClassifier only returns 'success' (Q1)
- `extensions/config.ts:230-237` — normalizeTierConfig docstring admits advisory-only (Q4)
- `extensions/config.ts:283-286` — always sets thinking to 'medium' (Q2)
- `extensions/config.ts:630-639` — collectProfileThinkingLevels (Q4)
- `extensions/provider.ts:215-222` — thinkingLevelMap only for xhigh UI (Q4)
- `extensions/provider.ts:300-302` — budget gate (Q6)
- `extensions/provider.ts:338-365` — Google continuation guard (Q5)
- `extensions/provider.ts:466-470` — modelsToTry ignores targetLabel (Q5)
- `extensions/provider.ts:543-551` — runtime reasoning gate (Q4)
- `extensions/provider.ts:581-598` — cost accrual + ponytail leak (Q6)
- `extensions/provider.ts:605-612` — fbBase dead thinking fallback (Q2)
- `extensions/provider.ts:630-632` — in-tier fallback only sets isFallback (Q5)
- `extensions/state.ts:101` — lastPhase write-only (Q7)
- `extensions/index.ts:91` — debugHistory reassignment (Q8)
- `extensions/index.ts:95-101` — recordDebugDecision priority order (Q9)
- `extensions/index.ts:107-109` — dead failureReason branch (Q1)
- `extensions/index.ts:224` — 50ms sleep (Q9)
- `extensions/index.ts:311` — 50ms sleep (Q9)
- `extensions/index.ts:330-395` — restoreStateFromSession never reads lastPhase (Q7)
- `extensions/ui.ts:17-25` — getDecisionFlags missing isPinned (Q9)
- `extensions/ui.ts:30-32` — dead failureReason display (Q1)
- `extensions/commands.ts:310` — accepts 'all' undocumented (Q8)
- `extensions/commands.ts:313` — error message omits 'all' (Q8)
- `extensions/commands.ts:330` — dead guard (Q8)
- `extensions/commands.ts:476` — debugHistory mutation vs reassignment (Q8)

## Integration Points

### Inbound References

- `extensions/index.ts:1-50` — imports from all modules, orchestrates lifecycle
- `extensions/commands.ts:1-10` — imports state/config types, registers CLI surface
- Test files import production modules for unit testing

### Outbound Dependencies

- `@earendil-works/pi-ai` — ThinkingLevel type, model registry API
- `pi.registerProvider` — provider registration (synchronous API per test evidence)
- `pi.appendEntry` — state persistence

### Infrastructure Wiring

- `extensions/index.ts:444` — state object bridges provider closure vars via getters/setters
- `extensions/provider.ts:272` — registerProvider call (no await)
- `extensions/state.ts:85-110` — buildPersistedState serializes to pi.appendEntry

## Architecture Insights

**Anti-pattern across all findings**: Types/contracts promise more than runtime enforces. Union types with dead variants, optional fields with dead defaults, README claims with no runtime gate.

**Root cause**: The codebase evolved through rapid feature additions (classifier overhaul, veto gate, thinking sync, fallback chains) where each feature was added with forward-looking types/docs, but the runtime was wired conservatively — resulting in types that anticipate capabilities the runtime doesn't deliver.

**Test pattern**: Strong unit coverage of individual functions (`decideRouting`, `buildRoutingDecision`, `normalizeConfig`, `parseClassifierOutput`). Weak integration coverage of combined paths (classifier-through-provider-stream, cross-tier-fallback, budget-gate-downgrade). Recent commits added features but tests stayed unit-level.

## Precedents & Lessons

### Precedent: Six routing defect fix (commit 14466e2f)

**Commit(s)**: `14466e2f` — "fix: resolve six routing defects — classifier order, budget downgrade, cross-tier fallback, debug notify, isClassifier flag, README docs"
**Blast radius**: routing.ts, provider.ts, index.ts, README.md
**Takeaway**: The team catches and fixes routing defects in bulk. This research finds a similar pattern — multiple interrelated false promises that should be fixed together.

### Precedent: Classifier overhaul (commit f873288a)

**Commit(s)**: `f873288a` — "feat: overhaul classifier decision-making with veto gate, structured result, and provenance"
**Takeaway**: The veto gate was added but the `containsAny` substring matching was inherited from the pre-overhaul heuristic path without re-evaluating whether substring is appropriate for a classifier veto.

### Composite Lessons

- Each feature addition widened the type surface without tightening runtime enforcement — fix the gap at the boundary, not per-feature
- Unit tests passed but integration paths between features were untested — add cross-cutting tests for combined paths

## Historical Context (from `.rpiv/artifacts/`)

- No prior `.rpiv/artifacts/` found for this repository.

## Developer Context

(No developer questions asked — scan was comprehensive, user chose to proceed to write.)

## Related Research

- None yet.

## Open Questions

1. Should `ClassifierFailureReason` be enriched (make observability real) or pruned (make types honest)? Both are valid — enriching adds ~30 LoC, pruning removes ~10 LoC.
2. Should `reasoning`/`thinkingLevels` runtime enforcement be built (feature add) or deferred with honest docs? The docstring already says "deferred" — doc fix may be the right first move.
3. Should the 50ms sleeps be removed outright or replaced with proper synchronization? Depends on whether `pi.registerProvider` is guaranteed synchronous across pi versions.
4. Should upward escalation in fallback chains be documented (README under-promises) or removed (code over-delivers)?
