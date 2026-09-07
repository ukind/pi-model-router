---
date: 2026-07-18T15:05:21+0700
author: Yogiswara Utama
commit: c028bcb9
branch: main
repository: pi-model-router
topic: 'De-slop: fix 10 false promises in pi-model-router'
tags:
  [
    design,
    deslop,
    false-promises,
    types,
    config,
    routing,
    provider,
    commands,
    tests,
    docs,
  ]
status: ready
parent: 2026-07-18_14-36-23_deslop-false-promises.md
last_updated: 2026-07-18T15:05:21+0700
last_updated_by: Yogiswara Utama
---

# Design: De-Slop False Promises

## Summary

Drop dead types/branches, fix the two real bugs (Q3 veto false-positive via substring, Q5 broken Google continuation guard after in-tier fallback), and align README with runtime. Net effect: 8 source files modified, 0 new source files, 1 README updated, ~9 new test scenarios added.

## Requirements

From research (`2026-07-18_14-36-23_deslop-false-promises.md`):

- Q1: 3 dead `ClassifierFailureReason` variants — prune (types honest).
- Q2: dead tier-based thinking default `??` chains — drop.
- Q3: veto gate substring false-positive (e.g. "smallest" contains "small") — switch to word-boundary.
- Q4: `reasoning`/`thinkingLevels` config — doc only, runtime enforcement deferred.
- Q5: in-tier fallback doesn't update `targetProvider/ModelId/Label` → continuation guard misfires — fix to mirror cross-tier branch + put `targetLabel` first in `modelsToTry` when guard fires.
- Q6: budget tracking — doc caveat + integration test, no code change.
- Q7: write-only `lastPhase` field — delete.
- Q8: dead `commands.ts` guard, undocumented `'all'` tier, `debugHistory.length = 0` mutation — fix all three.
- Q9: 50ms sleeps, misleading comment, `getDecisionFlags` missing `isPinned` — fix all three.
- Q10: untested `buildDelegationTierChain` + cross-tier-fallback + README under-promises upward escalation — add unit + provider tests, document.

## Current State Analysis

### Key Discoveries

- `containsAny` (plain `String.includes`) is used in 7 call sites in `routing.ts:333, 365, 370, 375, 380, 391, 397`. Only `matchHighestTierRule` (line 192) uses `containsAnyWord`. **Inconsistency: rules word-boundary, heuristics substring.**
- `normalizeTierConfig` at `config.ts:283-286` always sets `thinking` to `'medium'` when omitted, so `routing.ts:159-162` `??` chain and `provider.ts:605-612` `fbBase` `??` chain are unreachable.
- `provider.ts:630-632` (in-tier fallback `i > 0` branch) only sets `decision.isFallback = true`; the cross-tier branch at lines 614-616 mutates `tier/phase/targetProvider/targetModelId/targetLabel/reasoning/thinking`. **Two parallel fallback paths with divergent mutation contracts.**
- `provider.ts:466-470` rebuilds `modelsToTry` from `tierConfig.model + fallbacks`; never consults `decision.targetLabel` even when the continuation guard fires. Guard fires but the guarded model isn't tried first.
- `pi.registerProvider` is called sync at `provider.ts:272` (no `await`); `index.test.ts:51` mocks are synchronous. The 50ms sleeps at `index.ts:224, 311` are timing-based padding, not actual async sync.
- `getDecisionFlags` at `ui.ts:17-25` checks `isFallback/isBudgetForced/isRuleMatched/isClassifier/isVetoed` but not `isPinned`. `recordDebugDecision` at `index.ts:95-101` does check `isPinned`. **Widget and notification diverge for pinned decisions.**
- `isRouterPersistedState` at `state.ts:30-77` validates `lastPhase` indirectly (only checks fields that are present); no `lastPhase` validator. `lastPhase` is only written at `state.ts:101` and never read at `index.ts:330-395`.

### Pattern References

- `extensions/routing.ts:80-94` — `wordBoundaryRegex` + module-level cache: the pattern to extend for the new `containsAnyWord` call sites.
- `extensions/routing.ts:192` — `matchHighestTierRule` shows the existing `containsAnyWord` call site as the model.
- `extensions/provider.ts:613-630` — cross-tier fallback mutation contract: the pattern the in-tier branch should mirror.

## Scope

### Building

- Delete 3 dead `ClassifierFailureReason` union variants + their dead downstream branches.
- Delete `lastPhase` field + builder code + its test.
- Switch all 7 veto + heuristic call sites to `containsAnyWord` (with phrase-hint special case for "step by step").
- Delete dead `??` thinking chains in `routing.ts` and `provider.ts`.
- Update in-tier fallback to mirror cross-tier mutation contract.
- Insert `decision.targetLabel` at front of `modelsToTry` when continuation guard fires.
- Remove 50ms sleeps in `index.ts`.
- Rewrite misleading `recordDebugDecision` comment to match actual priority order.
- Add `isPinned` to `getDecisionFlags`.
- Delete `commands.ts:330` dead guard, add `'all'` to error/help/autocomplete, replace `debugHistory.length = 0` with reassignment.
- Add unit tests for `buildDelegationTierChain` (6 cases) and cross-tier fallback (provider).
- Update README: word-boundary match (with phrase exception), upward escalation, advisory fields doc caveat.

### Not Building

- Runtime enforcement of `reasoning: false` / `thinkingLevels` (Q4): deferred — research recommends doc-first; can ship as separate feature.
- Mid-stream cost accounting for error-without-usage (Q6): accepted leak, ponytail comment already notes it.
- Classifier-through-provider-stream integration test (Q10): unit + provider-level tests only.
- Any schema changes (no migration needed).

## Decisions

### Q1 — Prune dead ClassifierFailureReason variants

- **Ambiguity**: enrich (A, ~30 LoC + 3 tests) vs prune (B, ~10 LoC deletion).
- **Decision**: Prune (B). Research verdict: makes types honest; the upstream can enrich later if observability is wanted.
- **Action**:
  - `types.ts:30-35`: union drops `'model-not-found' | 'auth-failure' | 'stream-error'`. Keep `'success' | 'unparseable'`.
  - `index.ts:107-109`: drop the `decision.failureReason !== 'success'` branch from the `provenance` ternary.
  - `ui.ts:30-32`: drop the `<${failureReason}>` interpolation; collapse to plain format.

### Q2 — Drop dead `fbBase` chain (provider.ts only)

- **Ambiguity**: drop dead `??` (B) vs honour tier-based default (A).
- **Decision**: Drop the **provider.ts** `fbBase` chain (B). Keep the `routing.ts:165` `??` chain — it is reachable from test/manual profile construction that bypasses `normalizeTierConfig` (e.g. `routing.test.ts:227-231` constructs a `RouterProfile` without `thinking` and calls `buildRoutingDecision` directly). The cross-tier-fallback path in `provider.ts:605-612` runs only on already-normalized config, so the `fbBase` chain there is genuinely dead.
- **Action**:
  - `provider.ts:605-612`: replace the `fbBase` chain with `profile[currentTier]?.thinking`. No semantic change in production.

### Q3 — Word-boundary everywhere

- **Ambiguity**: switch veto to word-boundary (fix) vs switch rules to substring (preserve README, keep bug).
- **Decision**: Switch veto to word-boundary. Fixes real false-positive; aligns rules/veto/heuristics on one matcher.
- **Action**:
  - `routing.ts:75-94`: extend `containsAnyWord` to handle phrase hints. Single-word hints use the existing `wordBoundaryRegex`; multi-word hints (whitespace-separated) use plain substring.
  - `routing.ts:300-315, 333, 365, 370, 375, 380, 391, 397`: replace `containsAny` with `containsAnyWord` (now phrase-aware).
  - `routing.test.ts:542-646`: add 2 tests: (a) "smallest possible deployment footprint" must NOT trigger `low` veto, (b) "step by step" phrase hint must still match.

### Q4 — Doc only

- **Decision**: README updated to say `reasoning: false` and `thinkingLevels` are advisory. No runtime change.
- **Action**:
  - `README.md`: replace false "disables reasoning and restricts the available thinking levels" claim with "advisory; runtime gate consults the live registry".

### Q5 — Fix in-tier fallback + continuation guard

- **Decision**: Mirror cross-tier mutation contract in in-tier branch. When guard fires, put `targetLabel` first.
- **Action**:
  - `provider.ts:630-632` (in-tier `i > 0` branch): also set `decision.tier/phase/targetProvider/targetModelId/targetLabel/thinking` from the fallback model. Mirror the cross-tier branch shape exactly.
  - `provider.ts:466-470`: prepend `decision.targetLabel` to `modelsToTry` when `isGoogleThinkingToolContinuation` is true. The label is the model that _successfully_ streamed the previous turn.
  - `provider.test.ts:247-284`: add in-tier-fallback-then-continuation test.

### Q6 — Doc + integration test

- **Decision**: README caveat for soft per-turn cap. Add `isBudgetExceeded → decideRouting → tier downgrade` integration test in `provider.test.ts`.
- **Action**: `README.md`: add note in "Advanced Behaviors" — single-turn cost can exceed cap because the gate is pre-stream.

### Q7 — Delete lastPhase

- **Decision**: Pure deletion. Phase stickiness flows through `lastDecision.phase` (consumed at `routing.ts:308`).
- **Action**:
  - `types.ts:106`: remove `lastPhase?: RouterPhase;`.
  - `state.ts:101`: remove `lastPhase: lastDecision?.phase,`.
  - `state.test.ts:167`: remove `expect(state.lastPhase).toBe('planning');`.

### Q8 — Commands surface cleanup

- **Decision**: Delete dead guard, document 'all' tier, replace mutation with reassignment.
- **Action**:
  - `commands.ts:330`: delete the unreachable `if (tier !== 'all' && !tierValues.includes(tier as string))` block. Earlier branch at lines 320-325 already validates.
  - `commands.ts:313`: change "Use high, medium, or low" → "Use high, medium, low, or all".
  - `commands.ts:113-160`: add 'all' to the `getThinkingCompletions` second-arg branch.
  - `commands.ts:476`: replace `state.debugHistory.length = 0` with `actions.clearDebugHistory()` (the state object declares `debugHistory` as `readonly` and the getter at `index.ts:444-446` has no setter, so direct reassignment won't compile). Add `clearDebugHistory` to the `actions` object in `index.ts:91-` as a companion change. The action does closure-variable reassignment, mirroring `recordDebugDecision` at `index.ts:91`.

### Q9 — Orchestrator cleanup

- **Decision**: Remove 50ms sleeps, rewrite misleading comment, add `isPinned` to widget flags.
- **Action**:
  - `index.ts:224`: remove the `await new Promise((resolve) => setTimeout(resolve, 50))` after `registerProvider()`.
  - `index.ts:311`: remove the second 50ms sleep in `restoreStateFromSession`.
  - `index.ts:98-99`: rewrite comment to match actual priority order: `isBudgetForced > isClassifier > isRuleMatched > isFallback > isPinned > heuristic`.
  - `ui.ts:17-25`: add `if (decision.isPinned) flags.push('pin')`.

### Q10 — Tests + README

- **Decision**: Add `buildDelegationTierChain` unit tests (6 cases) + cross-tier-fallback provider test. Document upward escalation in README.
- **Action**:
  - `routing.test.ts`: new `describe('buildDelegationTierChain')` block. 6 cases: 3 tiers × {budget, non-budget}.
  - `provider.test.ts`: new `describe('cross-tier fallback')` block. In-tier primary + all in-tier fallbacks fail → next tier primary succeeds → decision mutated correctly.
  - `README.md`: replace "high → medium → low" wording in fallback sections with "down-then-nearest-up (non-budget) / down-only (budget-exceeded)".

## Architecture

### extensions/types.ts:30-35 — MODIFY

```typescript
export type ClassifierFailureReason = 'success' | 'unparseable';
```

### extensions/types.ts:106 — MODIFY

Remove the `lastPhase?: RouterPhase;` line from the `RouterPersistedState` interface.

### extensions/routing.ts:75-94 — MODIFY

Replace `containsAnyWord` with a phrase-aware version. Single-word hints (no whitespace) use `wordBoundaryRegex`; multi-word hints (contain whitespace) use plain substring match.

```typescript
export const containsAnyWord = (text: string, keywords: string[]): boolean => {
  const lcText = text.toLowerCase();
  return keywords.some((keyword) => {
    if (/\s/.test(keyword)) {
      // Multi-word phrase: substring match (no word-boundary semantics for phrases)
      return lcText.includes(keyword.toLowerCase());
    }
    return wordBoundaryRegex(keyword).test(lcText);
  });
};
```

The internal `wordBoundaryRegex` function and its cache (lines 80-94) remain unchanged.

### extensions/provider.ts:605-612 — MODIFY

Replace the dead `fbBase` chain with the direct `profile[currentTier]?.thinking` access. `normalizeTierConfig` always sets `thinking` on the production config path, and the cross-tier-fallback branch only runs against already-normalized config.

```typescript
// `fbBase` chain was unreachable: normalizeTierConfig (config.ts:283-286)
// always sets `thinking` on the production config path, and this branch
// only runs against already-normalized config. The `?? 'medium'` is a
// defensive backstop for the type system (RoutedTierConfig.thinking is
// optional at the type level); the loop guard at provider.ts:461 ensures
// `tierConfig` is non-null.
decision.thinking =
  state.thinkingByProfile[model.id]?.[currentTier] ??
  tierConfig.thinking ??
  'medium';
```

### extensions/routing.ts:300-315, 333, 365, 370, 375, 380, 391, 397 — MODIFY

Replace every `containsAny(prompt, <array>)` call with `containsAnyWord(prompt, <array>)`. The function signature is unchanged; semantics now match rules (with phrase-hint exception for multi-word hints).

Affected lines and their arrays:

- 333: `explicitHighHints`
- 334: `explicitLowHints` (rename variable to make this clearer)
- 365: `explicitHighHints`
- 370: `explicitLowHints`
- 375: `summaryKeywords`
- 380: `planningKeywords`
- 391: `implementationKeywords`
- 397: `lookupKeywords`

### extensions/routing.ts — NEW (tests in routing.test.ts)

The test block lives in the existing `routing.test.ts`. No production code change beyond the `containsAnyWord` extension above.

### extensions/provider.ts:466-470 — MODIFY

When the continuation guard fires, prepend `decision.targetLabel` to `modelsToTry` so the previously-successful model is tried first.

```typescript
let modelsToTry = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];
if (isGoogleThinkingToolContinuation) {
  // Prepend the previously-successful model so the guard actually
  // takes effect. Duplicates are harmless (the inner loop short-circuits).
  modelsToTry = [previousDecision!.targetLabel, ...modelsToTry];
}
```

`isGoogleThinkingToolContinuation` and `previousDecision` are both already in scope (computed at the top of the same `try` block around provider.ts:330-360). No hoisting required.

### extensions/provider.ts:605-612 — MODIFY

Replace the dead `fbBase` chain with `tierConfig.thinking ?? 'medium'`. The outer `for (const currentTier of tierChain)` loop at provider.ts:459 sets `tierConfig` and the `if (!tierConfig) continue` guard at line 461 ensures `tierConfig` is non-null in this scope. The `?? 'medium'` is a defensive backstop for the type system (`RoutedTierConfig.thinking` is optional at the type level even though `normalizeTierConfig` always sets it in production).

```typescript
// `fbBase` chain was unreachable: normalizeTierConfig (config.ts:283-286)
// always sets `thinking` on the production config path, and this branch
// only runs against already-normalized config. The `?? 'medium'` is a
// defensive backstop for the type system.
decision.thinking =
  state.thinkingByProfile[model.id]?.[currentTier] ??
  tierConfig.thinking ??
  'medium';
```

### extensions/provider.ts:630-632 — MODIFY

In the in-tier fallback `i > 0` branch, mirror the cross-tier mutation contract at lines 614-616.

```typescript
} else if (i > 0) {
  // In-tier fallback: model that actually streamed is `modelRef`,
  // not the tier primary. Update decision fields so the
  // continuation guard (provider.ts:338-351) sees the real model.
  decision.isFallback = true;
  decision.tier = currentTier;
  decision.phase = phaseForTier(currentTier);
  decision.targetProvider = targetProvider;
  decision.targetModelId = targetModelId;
  decision.targetLabel = modelRef;
  decision.thinking =
    state.thinkingByProfile[model.id]?.[currentTier] ??
    tierConfig.thinking ??
    'medium';
  decision.reasoning = `In-tier fallback to ${modelRef}. (Original: ${decision.reasoning})`;
}
```

### extensions/index.ts:91-114 — MODIFY

Rewrite the comment to match actual priority order. Remove dead `failureReason` branch from the provenance ternary.

```typescript
const recordDebugDecision = (decision: RoutingDecision) => {
  // Clone before pushing — Phase 2's cross-tier branch mutates the live
  // `decision` reference in place.
  debugHistory = [...debugHistory, { ...decision }].slice(-MAX_DEBUG_HISTORY);
  if (debugEnabled && lastExtensionContext) {
    // Priority order (matches getDecisionFlags at ui.ts:17-29):
    // isBudgetForced > isClassifier > isRuleMatched > isFallback > isPinned > heuristic.
    let source: string;
    if (decision.isBudgetForced) source = 'budget';
    else if (decision.isClassifier) source = 'classifier';
    else if (decision.isRuleMatched) source = 'rule';
    else if (decision.isFallback) source = 'fallback';
    else if (decision.isPinned) source = 'pin';
    else source = 'heuristic';
    const provenance =
      decision.isClassifier && decision.confidence
        ? ` (confidence: ${decision.confidence})`
        : '';
    lastExtensionContext.ui.notify(
      `router → ${decision.targetProvider}/${decision.targetModelId} [${decision.tier}, ${source}]${provenance}`,
      'info',
    );
  }
};
```

### extensions/index.ts:224 — MODIFY

Remove the 50ms sleep. The call is sync.

```typescript
actions.registerRouterProvider();
const routerModel = ctx.modelRegistry.find('router', profileName);
```

### extensions/index.ts:311 — MODIFY

Remove the 50ms sleep. `currentModelRegistry = ctx.modelRegistry` (line 308) is already set; no async gap needed.

### extensions/ui.ts:17-29 — MODIFY

Add `isPinned` to the flag list.

```typescript
export const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isRuleMatched) flags.push('rule');
  if (decision.isClassifier) flags.push('classifier');
  if (decision.isVetoed) flags.push('vetoed');
  if (decision.isPinned) flags.push('pin');
  return flags;
};
```

### extensions/ui.ts:30-32 — MODIFY

Drop the dead failure-reason interpolation (Q1 prune).

```typescript
export const formatDecision = (decision: RoutingDecision): string => {
  const confidence = decision.confidence ? ` {${decision.confidence}}` : '';
  return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}] (${decision.reasoning})${confidence}`;
};
```

### extensions/state.ts:101 — MODIFY

Remove the `lastPhase` line from the `buildPersistedState` return.

### extensions/commands.ts:310-330 — MODIFY

Add 'all' to the error message. Delete the unreachable dead guard at line 330 (earlier branch validates `tier` against `tierValues` + `'all'` already).

```typescript
if (tier !== 'all' && !tierValues.includes(tier as string)) {
  // DELETED — unreachable: earlier branch (line 320-325) already
  // validates against tierValues ∪ {'all'}.
}
```

Replace the "Use high, medium, or low" message at line 313 with "Use high, medium, low, or all".

### extensions/commands.ts:113-160 — MODIFY

Add 'all' as a valid second token in `getThinkingCompletions`. The current logic at line 141 only matches `tierValues` (high/medium/low) for the tier position; add 'all' to the matched set.

### extensions/commands.ts:476 — MODIFY

Replace mutation with action call. The state object (`commands.ts:42`) declares `debugHistory` as `readonly`, and the getter in `index.ts:444-446` has no setter, so direct reassignment won't compile. The action pattern is already established by `recordDebugDecision` at `index.ts:91` (closure-variable reassignment wrapped in a closure).

```typescript
else if (cmd === 'clear') actions.clearDebugHistory();
```

### extensions/index.ts:91 — MODIFY (companion change)

Add `clearDebugHistory` to the closure (declared right after `recordDebugDecision` ends at line 126, before `getThinkingOverride` at line 127) and include it in the `actions` object (line 155-187). This placement keeps it independent of `recordDebugDecision` so Slice 6's later body rewrite of `recordDebugDecision` does not clobber it.

```typescript
const recordDebugDecision = (decision: RoutingDecision) => {
  /* existing body — unchanged by Slice 5 */
};

// NEW: Slice 5 — companion action for the debug clear command.
const clearDebugHistory = () => {
  debugHistory = [];
};

const actions = {
  // ... existing actions ...
  clearDebugHistory,
  // ...
};
```

### extensions/commands.ts:75-100 — MODIFY (companion change)

Add `clearDebugHistory` to the `actions` parameter type. Without this, `actions.clearDebugHistory()` at `commands.ts:476` fails type-checking.

```typescript
actions: {
  persistState: () => void;
  updateStatus: (ctx: ExtensionContext) => void;
  reloadConfig: (
    ctx?: ExtensionContext,
    options?: { preserveDebug?: boolean },
  ) => void;
  ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
  switchToRouterProfile: (
    profileName: string,
    ctx: ExtensionContext,
    strict?: boolean,
  ) => Promise<boolean>;
  syncPiThinkingLevel: (level: ThinkingLevel) => void;
  clearDebugHistory: () => void; // NEW
}
```

### extensions/commands.test.ts:76-83, 288-289 — MODIFY

Two changes in the test file:

1. `buildMockActions()` at line 76-83 must include `clearDebugHistory: vi.fn()`.
2. The test at line 288-289 must assert that `actions.clearDebugHistory` was called (not assert on `state.debugHistory.length`).

```typescript
// 1. buildMockActions
const buildMockActions = () => ({
  persistState: vi.fn(),
  updateStatus: vi.fn(),
  reloadConfig: vi.fn(),
  ensureValidActiveRouterProfile: vi.fn(),
  switchToRouterProfile: vi.fn().mockResolvedValue(true),
  syncPiThinkingLevel: vi.fn(),
  clearDebugHistory: vi.fn(), // NEW
});

// 2. test assertion (line 288-289)
await cmd.handler('debug clear', ctx as any);
expect(actions.clearDebugHistory).toHaveBeenCalled();
```

### extensions/routing.test.ts — MODIFY

Add 3 new test blocks:

1. `describe('buildDelegationTierChain')` — 6 cases:
   - high, non-budget → ['high', 'medium', 'low']
   - high, budget → ['high', 'medium', 'low']
   - medium, non-budget → ['medium', 'low', 'high']
   - medium, budget → ['medium', 'low']
   - low, non-budget → ['low', 'medium', 'high']
   - low, budget → ['low']

2. `describe('word-boundary veto')` — 2 cases:
   - "smallest possible deployment footprint" + classifier high → no veto, tier='high' (not downgraded by 'small' substring)
   - "step by step please" + classifier low → veto to 'high' (phrase hint still matches)

### extensions/provider.test.ts — MODIFY

Add 2 new test blocks:

1. `describe('in-tier fallback mutates target fields')` — 1 case:
   - primary model fails, fallback in same tier succeeds → `decision.targetProvider/ModelId/Label` reflect the fallback model, `decision.isFallback === true`.

2. `describe('cross-tier fallback')` — 1 case:
   - All in-tier primary + fallbacks fail → next tier primary succeeds → `decision.tier` mutated, `decision.isFallback === true`, `decision.targetProvider/ModelId/Label` reflect the next-tier primary.

3. `describe('Google continuation guard after in-tier fallback')` — 1 case:
   - Turn N streams `google/gemini-2.5-flash` after in-tier fallback from `gemini-2.5-pro` → Turn N+1 (toolResult) routes back to `gemini-2.5-flash` (not `gemini-2.5-pro`).

4. `describe('budget integration')` — 1 case:
   - `accumulatedCost >= maxSessionBudget` → `decideRouting` downgrades high → medium.

### extensions/state.test.ts:167 — MODIFY

Remove the `expect(state.lastPhase).toBe('planning');` assertion.

### README.md — MODIFY

5 surgical edits:

1. **Line 14, "high → medium → low"** → "down-then-nearest-up (non-budget) / down-only (budget-exceeded)".
2. **Line 120, "substring match, case-insensitive"** → "word-boundary match (case-insensitive); multi-word phrase hints (e.g. `step by step`) use substring match".
3. **Line 195, backtick-wrapped `\`high\` → \`medium\` → \`low\``(inside the phrase "drops to the next lower tier (`high`→`medium`→`low`)")** → "drops to the next lower tier, or nearest-up if the cap is not exceeded (down-then-nearest-up). When the budget cap is exceeded, the chain is down-only".
4. **Add a paragraph to "Advanced Behaviors"** between Context Truncation and Turn-End Auto-Restore: a one-line caveat that the budget gate is pre-stream; a single turn can exceed the cap.
5. _\_Line 242, in the `### \`reasoning\` Defaults to \`true\`` subsection of Advanced Behaviors\*\* (not the Config Fields table): replace the sentence _"Only an explicit `"reasoning": false` disables reasoning and restricts the available thinking levels."_ with _"An explicit `"reasoning": false` is advisory; the runtime delegation gate consults the live model registry, not the config field. `thinkingLevels` similarly narrows what the TUI exposes, not what routing can pick."\_

## Slices

### Slice 1: Q7 + Q1 dead type/branch removal

**Files**: `extensions/types.ts`, `extensions/state.ts`, `extensions/state.test.ts`, `extensions/index.ts`, `extensions/ui.ts`

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] `grep -n "lastPhase" extensions/` returns 0 matches
- [ ] `grep -n "model-not-found\|auth-failure\|stream-error" extensions/types.ts` returns 0 matches

#### Manual Verification

- [ ] `npm test -- extensions/state.test.ts` passes with the removed assertion

### Slice 2: Q3 word-boundary + phrase handling

**Files**: `extensions/routing.ts`, `extensions/routing.test.ts`

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] New tests pass: "smallest possible deployment footprint" does not trigger low veto
- [ ] New tests pass: "step by step" still matches phrase hints

#### Manual Verification

- [ ] `grep -n "containsAny(" extensions/routing.ts` returns 0 matches (all replaced with `containsAnyWord`)

### Slice 3: Q2 dead fbBase chain (provider.ts only)

**Files**: `extensions/provider.ts`

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] `grep -n "fbBase" extensions/provider.ts` returns 0 matches
- [ ] `grep -n "currentTier === 'high'" extensions/provider.ts` returns 0 matches

#### Manual Verification

- [ ] Existing tests that exercise the cross-tier fallback path still pass (the in-tier-fallback Slice 4 test will also cover this).

### Slice 4: Q5 in-tier fallback + continuation guard

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] New in-tier fallback test passes
- [ ] New Google continuation guard after in-tier fallback test passes

#### Manual Verification

- [ ] `grep -n "decision.isFallback = true" extensions/provider.ts` returns exactly 2 matches (in-tier + cross-tier branches)

### Slice 5: Q8 commands surface

**Files**: `extensions/commands.ts`, `extensions/commands.test.ts` (if assertions need updating)

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] `grep -n "Use high, medium, or low" extensions/commands.ts` returns 0 matches
- [ ] `grep -n "if (tier !== 'all' && !tierValues.includes" extensions/commands.ts` returns 0 matches
- [ ] `grep -n "debugHistory.length = 0" extensions/commands.ts` returns 0 matches

#### Manual Verification

- [ ] `/router thinking all off` no longer errors with "Use high, medium, or low"
- [ ] `/router debug clear` still empties the history (visible via `/router status`)

### Slice 6: Q9 orchestrator (50ms sleeps, comment, widget flags)

**Files**: `extensions/index.ts`, `extensions/ui.ts`

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] `grep -n "setTimeout(resolve, 50)" extensions/index.ts` returns 0 matches
- [ ] Widget renders 'pin' flag for a pinned decision

#### Manual Verification

- [ ] No test flake increase after sleep removal (run `npm test` 5x in a row)

### Slice 7: Q10 unit tests (buildDelegationTierChain)

**Files**: `extensions/routing.test.ts`

#### Companion change — import statement

Add `buildDelegationTierChain` to the import from `./routing` at `extensions/routing.test.ts:5-17`:

```typescript
import {
  // ... existing imports ...
  buildRoutingDecision,
  buildDelegationTierChain, // NEW
  decideRouting,
  // ...
} from './routing';
```

#### Test additions

A new `describe('buildDelegationTierChain')` block in `extensions/routing.test.ts` with 6 test cases:

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] New `buildDelegationTierChain` describe block has 6 test cases, all green

#### Manual Verification

- [ ] Coverage report shows `buildDelegationTierChain` exercised

### Slice 8: Q4 + Q6 + Q10 README docs

**Files**: `README.md`

#### Automated Verification

- [ ] `grep -n "substring match, case-insensitive" README.md` returns 0 matches
- [ ] `grep -n "high → medium → low" README.md` returns 0 matches
- [ ] `grep -n "\`high\` → \`medium\` → \`low\`" README.md` returns 0 matches
- [ ] `grep -n "disables reasoning and restricts" README.md` returns 0 matches
- [ ] Budget caveat paragraph present in "Advanced Behaviors"

#### Manual Verification

- [ ] README renders correctly (no markdown lint errors)

### Slice 9: Integration — budget gate, cross-tier fallback

**Files**: `extensions/provider.test.ts`

#### Test bodies

Two test additions to `extensions/provider.test.ts`:

1. `describe('cross-tier fallback')` — 1 case:

   ```typescript
   it('mutates decision when all in-tier models fail and next tier succeeds', async () => {
     // Profile: high tier = [gpt-4o, fails], [gemini-pro, fails]
     //         medium tier = [gpt-4o-mini, succeeds]
     // Expected: decision.tier = 'medium', decision.isFallback = true,
     //           decision.targetProvider = 'openai', decision.targetModelId = 'gpt-4o-mini'
   });
   ```

2. `describe('budget integration')` — 1 case:

   ```typescript
   it('downgrades routing when accumulatedCost >= maxSessionBudget', async () => {
     // Config: maxSessionBudget = 0.50, state.accumulatedCost = 0.60
     // Profile: high = gpt-4o (reasoning), medium = gpt-4o-mini
     // Prompt: 'plan the architecture carefully' (would normally route to high)
     // Expected: decision.tier = 'medium', decision.isBudgetForced = true
   });
   ```

#### Automated Verification

- [ ] Type checking passes: `npm run check`
- [ ] Tests pass: `npm test`
- [ ] New budget integration test passes
- [ ] New cross-tier fallback test passes

#### Manual Verification

- [ ] All new tests together pass with `npm test` (no flake)

## Desired End State

After this design is implemented:

1. A prompt like "smallest possible deployment footprint" no longer false-vetoes a classifier 'high' decision to 'low' — `decideRouting` returns `tier: 'high'`, `isVetoed: undefined`.
2. After an in-tier fallback, the next turn's Google continuation guard correctly identifies the model that actually streamed (e.g. `gemini-2.5-flash` after `gemini-2.5-pro` failed) and routes to it, avoiding thought-signature replay errors.
3. The `lastPhase` field no longer appears in `RouterPersistedState` — `isRouterPersistedState` no longer writes it, tests no longer assert it.
4. The `ClassifierFailureReason` type is two-variant (`'success' | 'unparseable'`), and no dead branches in `index.ts:107` or `ui.ts:30` exist.
5. All keyword matching in `routing.ts` (rules, veto, heuristics) uses one matcher with consistent word-boundary semantics (and phrase-hint exception for multi-word hints).
6. README accurately documents: word-boundary matching, upward escalation, advisory `reasoning`/`thinkingLevels`, budget pre-stream cap.
7. The `getDecisionFlags` widget shows 'pin' for pinned decisions, matching the debug notification.

## File Map

```
extensions/types.ts:30-35                # MODIFY — Q1 prune ClassifierFailureReason union
extensions/types.ts:106                  # MODIFY — Q7 remove lastPhase
extensions/routing.ts:75-94              # MODIFY — Q3 phrase-aware containsAnyWord
extensions/routing.ts:300-397            # MODIFY — Q3 switch containsAny to containsAnyWord
extensions/routing.test.ts               # MODIFY — Q3 + Q10 new tests
extensions/provider.ts:466-470           # MODIFY — Q5 modelsToTry prepending
extensions/provider.ts:605-612           # MODIFY — Q2 drop dead fbBase chain
extensions/provider.ts:630-632           # MODIFY — Q5 mirror cross-tier mutation
extensions/provider.ts                   # MODIFY — Q5 (continuation guard)
extensions/provider.test.ts              # MODIFY — Q5 + Q10 new tests
extensions/index.ts:91-114               # MODIFY — Q9 fix comment + drop failureReason branch
extensions/index.ts:224                   # MODIFY — Q9 remove 50ms sleep
extensions/index.ts:311                   # MODIFY — Q9 remove 50ms sleep
extensions/ui.ts:17-25                    # MODIFY — Q9 add isPinned flag
extensions/ui.ts:30-32                    # MODIFY — Q1 drop failureReason display
extensions/state.ts:101                   # MODIFY — Q7 drop lastPhase
extensions/state.test.ts:167              # MODIFY — Q7 drop lastPhase assertion
extensions/commands.ts:113-160            # MODIFY — Q8 add 'all' to thinking completions
extensions/commands.ts:310-330            # MODIFY — Q8 dead guard + error message
extensions/commands.ts:476                # MODIFY — Q8 debugHistory reassignment
README.md                                 # MODIFY — Q3, Q4, Q6, Q10 doc fixes
```

## Ordering Constraints

- Slice 1 (Q7 + Q1) is the foundation: it deletes type fields that no later slice should reference. Must run first.
- Slice 2 (Q3 word-boundary) modifies `containsAnyWord`, which Slice 3 (Q2) doesn't depend on but Slice 4 (Q5) tests reference indirectly through the routing flow. Can run after Slice 1.
- Slice 3 (Q2 dead ?? chains) is independent of Slice 2 but modifies the same file; bundle or sequence.
- Slice 4 (Q5 in-tier fallback) depends on the dead `??` chain being removed in Slice 3 (cleaner mutation logic).
- Slice 5 (Q8 commands) and Slice 6 (Q9 orchestrator) are independent and can run in either order.
- Slice 7 (Q10 unit tests) is independent — can run after Slice 1.
- Slice 8 (README) is independent of code changes — can run in parallel with any slice.
- Slice 9 (integration tests) depends on Slices 4 + 6 being in (it tests cross-tier fallback + budget integration end-to-end).

## Verification Notes

- Build: `npm run check` (typescript) + `npm test` (vitest) must both pass after every slice.
- Grep checks: each slice has explicit grep patterns to confirm dead code was removed.
- `extensions/routing.test.ts` and `extensions/provider.test.ts` use `vi.fn()` mocks for the model registry; no live API calls. Tests are fast and deterministic.
- Ponytail ceilings (no new ones introduced; existing ones preserved):
  - `extensions/provider.ts:591-598` — partial-stream cost leak (accepted, no change).
  - `extensions/routing.ts:80-94` — module-level regex cache (kept; no change).
- Risk: Slice 4's in-tier fallback mutation changes `decision.targetProvider/ModelId/Label` for any in-tier fallback scenario, not just Google. This is the intended fix but may surface latent bugs in widget/notification display. The widget update (Slice 6) addresses `isPinned` but not the broader field-mutation visibility — visual review of `/router status` after a forced in-tier fallback is recommended.

## Performance Considerations

No hot-path changes. The new `containsAnyWord` call sites add the same number of regex tests as the old `containsAny` did. The `modelsToTry` prepend is O(n) once. The 50ms sleep removal is a strict improvement (eliminates 100ms of synchronous blocking per startup).

## Migration Notes

No data migration. Persisted state files containing `lastPhase` will continue to load (validation at `state.ts:30-77` only checks `lastPhase`-adjacent fields; the field will be silently dropped on the next `buildPersistedState` call). This is a forward-compatible drop.

## Pattern References

- `extensions/routing.ts:80-94` — `wordBoundaryRegex` + module-level cache: the pattern to extend for phrase-aware matching.
- `extensions/routing.ts:192` — `matchHighestTierRule` shows the existing `containsAnyWord` call site to model after.
- `extensions/provider.ts:613-630` — cross-tier fallback mutation contract: the in-tier branch should mirror this exactly.
- `extensions/index.ts:91` — `debugHistory = [...]` reassignment through state getter: the pattern to use in `commands.ts:476` for the `clear` command.

## Developer Context

Q1 question: "Prune dead variants (B, ~10 LoC) or enrich runClassifier (A, ~30 LoC)?" → Prune (B). Research verdict: types honest; future enrichment is cheap.

Q3 question: "Switch veto to word-boundary (fix bug) or switch rules to substring (preserve README)?" → Switch veto. Real false-positive veto; rules are correctly stricter.

Q2 question: "Drop dead fallbacks (B) or honour tier-based default (A)?" → Drop (B). `normalizeTierConfig` always sets 'medium'; that is the documented default.

Q9 50ms sleeps: "Remove or replace with proper sync?" → Remove. `registerProvider` is sync per code + test evidence.

Q10 tests: "Add unit + provider tests or include integration test too?" → Add unit + provider tests. Skip the full classifier-through-stream test (low ROI).

Decomposition approved: 9 slices, foundation-first, all small.

## Design History

- Slice 1: Q7 + Q1 dead type/branch removal — approved as generated
- Slice 2: Q3 word-boundary + phrase handling — approved as generated
- Slice 3: Q2 dead fbBase chain (provider.ts only) — approved as generated
- Slice 4: Q5 in-tier fallback + continuation guard — approved as generated
- Slice 5: Q8 commands surface — approved as generated
- Slice 6: Q9 orchestrator — approved as generated
- Slice 7: Q10 unit tests (buildDelegationTierChain) — approved as generated
- Slice 8: Q4 + Q6 + Q10 README docs — approved as generated
- Slice 9: Integration — budget gate, cross-tier fallback — approved as generated

## References

- `2026-07-18_14-36-23_deslop-false-promises.md` — research artifact (parent)
- Commit `14466e2f` — "fix: resolve six routing defects" (precedent for bulk fix)
- Commit `f873288a` — "feat: overhaul classifier decision-making with veto gate" (precedent for veto gate, but introduced the substring bug)
