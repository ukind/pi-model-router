---
date: 2026-07-18T17:40:41+0700
author: Yogiswara Utama
commit: c028bcb9
branch: main
repository: pi-model-router
topic: 'De-slop: fix 10 false promises in pi-model-router'
tags:
  [
    plan,
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
parent: '.rpiv/artifacts/designs/2026-07-18_15-05-21_deslop-false-promises.md'
phase_count: 9
phases:
  - { n: 1, title: 'Q7 + Q1 dead type/branch removal' }
  - { n: 2, title: 'Q3 word-boundary + phrase handling' }
  - { n: 3, title: 'Q2 dead fbBase chain (provider.ts only)' }
  - { n: 4, title: 'Q5 in-tier fallback + continuation guard' }
  - { n: 5, title: 'Q8 commands surface' }
  - { n: 6, title: 'Q9 orchestrator (50ms sleeps, comment, widget flags)' }
  - { n: 7, title: 'Q10 unit tests (buildDelegationTierChain)' }
  - { n: 8, title: 'Q4 + Q6 + Q10 README docs' }
  - { n: 9, title: 'Integration — budget gate, cross-tier fallback' }
last_updated: 2026-07-18T17:40:41+0700
last_updated_by: Yogiswara Utama
---

# De-slop False Promises Implementation Plan

## Overview

Drop dead types/branches, fix two real bugs (Q3 veto false-positive via substring, Q5 broken Google continuation guard after in-tier fallback), and align README with runtime. Plan inherits 9 slices 1:1 from design.

## Desired End State

After implementation:

1. "smallest possible deployment footprint" no longer false-vetoes a classifier 'high' decision to 'low'.
2. After in-tier fallback, next turn's Google continuation guard routes to the model that actually streamed.
3. `lastPhase` field removed from `RouterPersistedState`; tests no longer assert it.
4. `ClassifierFailureReason` reduced to two variants; no dead branches.
5. All keyword matching in `routing.ts` uses one matcher (word-boundary + phrase-hint exception).
6. README accurately documents: word-boundary matching, upward escalation, advisory `reasoning`/`thinkingLevels`, budget pre-stream cap.
7. `getDecisionFlags` widget shows 'pin' for pinned decisions.

## What We're NOT Doing

- Runtime enforcement of `reasoning: false` / `thinkingLevels` (deferred — doc-first).
- Mid-stream cost accounting for error-without-usage (accepted leak, ponytail comment already notes it).
- Classifier-through-provider-stream integration test.
- Any schema changes (no migration needed).

## Phase 1: Q7 + Q1 dead type/branch removal

### Overview

Foundation slice. Deletes dead `lastPhase` field + 3 dead `ClassifierFailureReason` variants + downstream branches. Must run first because later slices should not reference removed types/fields.

### Changes Required

#### 1. types.ts — prune ClassifierFailureReason + drop lastPhase

**File**: `extensions/types.ts`
**Changes**: Drop `'model-not-found' | 'auth-failure' | 'stream-error'` from the union (keep `'success' | 'unparseable'`). Remove `lastPhase?: RouterPhase;` from `RouterPersistedState`.

#### 2. state.ts — drop lastPhase writer

**File**: `extensions/state.ts`
**Changes**: Remove `lastPhase: lastDecision?.phase,` from `buildPersistedState` return (line 101).

#### 3. state.test.ts — drop lastPhase assertion

**File**: `extensions/state.test.ts`
**Changes**: Remove `expect(state.lastPhase).toBe('planning');` at line 167.

#### 4. index.ts — [no-op here; failureReason removal consolidated into Phase 6 §2]

**File**: `extensions/index.ts`
**Changes**: No edit in this phase. The `decision.failureReason !== 'success'` branch at lines 107-109 is overwritten by Phase 6 §2's full-body rewrite of `recordDebugDecision`. Phase 6 handles the deletion; Phase 1 §5 (ui.ts) still drops the format-string interpolation.

#### 5. ui.ts — drop failureReason display

**File**: `extensions/ui.ts`
**Changes**: Drop the `<${failureReason}>` interpolation; collapse to plain format at lines 30-32.

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check` (npm script is `tsc`; ran `npm run tsc` — clean)
- [x] Tests pass: `npm test`
- [x] `grep -rn "lastPhase" extensions/` returns 0 matches
- [x] `grep -n "model-not-found\|auth-failure\|stream-error" extensions/types.ts` returns 0 matches

#### Manual Verification

- [x] `npm test -- extensions/state.test.ts` passes with the removed assertion

---

## Phase 2: Q3 word-boundary + phrase handling

### Overview

Fix veto gate substring false-positive (e.g. "smallest" contains "small"). Extend `containsAnyWord` to handle phrase hints. Replace all 7 `containsAny` call sites in `routing.ts` with `containsAnyWord`.

### Changes Required

#### 1. routing.ts — phrase-aware containsAnyWord

**File**: `extensions/routing.ts`
**Changes**: Extend `containsAnyWord` (lines 75-94) — single-word hints use `wordBoundaryRegex`; multi-word hints (contain whitespace) use plain substring. Replace every `containsAny(prompt, <array>)` with `containsAnyWord(prompt, <array>)` at the verified call sites: `routing.ts:333, 334, 365, 370, 375, 380, 391, 397`. **After replacing all call sites, delete the `containsAny` export from `routing.ts` and remove its test block at `routing.test.ts:151-156`** — the function becomes production-dead once no caller remains, which contradicts the de-slop goal.

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

#### 2. routing.test.ts — add word-boundary veto tests

**File**: `extensions/routing.test.ts`
**Changes**: Add 2 tests in new `describe('word-boundary veto')` block (lines 542-646 area).

```typescript
describe('word-boundary veto', () => {
  it('does not false-veto high when "smallest" contains "small"', () => {
    // "smallest possible deployment footprint" + classifier high → tier='high'
  });
  it('matches phrase hints via substring fallback', () => {
    // "step by step please" + classifier low → veto to 'high'
  });
});
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] New tests pass: "smallest possible deployment footprint" does not trigger low veto
- [x] New tests pass: "step by step" still matches phrase hints

#### Manual Verification

- [x] `grep -n "containsAny(" extensions/routing.ts` returns 0 matches (all replaced with `containsAnyWord`)
- [x] `grep -n "containsAny\b" extensions/routing.ts` returns 0 matches (function itself deleted)
- [x] `grep -n "wordBoundaryRegex\|regexCache" extensions/routing.ts` returns ≥2 matches (ponytail ceiling: module-level regex cache at routing.ts:80-94 must be preserved)
- [x] `grep -rn "fetch(\|axios\|http\.request\|https\.request" extensions/*.test.ts` returns 0 matches (tests make no live API calls)

---

## Phase 3: Q2 dead fbBase chain (provider.ts only)

### Overview

Drop unreachable `fbBase` chain in provider.ts. The cross-tier-fallback path runs only against already-normalized config (where `normalizeTierConfig` already set `thinking`). Routing.ts `??` chain stays — it is reachable from test/manual profile construction.

### Changes Required

#### 1. provider.ts — drop fbBase chain

**File**: `extensions/provider.ts`
**Changes**: Replace dead `fbBase` chain at `provider.ts:617-626` with `tierConfig.thinking ?? 'medium'`.

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

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check` (`npm run tsc` — clean)
- [x] Tests pass: `npm test` (222/222 passed)
- [ ] `grep -n "fbBase" extensions/provider.ts` returns 0 matches
- [x] `grep -n "currentTier === 'high'" extensions/provider.ts` returns 0 matches
- [x] `grep -n "partial-stream\|cost leak\|mid-stream" extensions/provider.ts` returns ≥1 match (ponytail ceiling: cost-leak handling code at provider.ts:591-598 must be preserved)

#### Manual Verification

- [x] Existing tests that exercise the cross-tier fallback path still pass (the in-tier-fallback Slice 4 test will also cover this).

---

## Phase 4: Q5 in-tier fallback + continuation guard

### Overview

Fix the in-tier fallback `i > 0` branch to mirror cross-tier mutation contract (currently only sets `isFallback`). When Google continuation guard fires, prepend `targetLabel` to `modelsToTry` so the previously-successful model is tried first. Depends on Phase 3 (cleaner mutation logic).

### Changes Required

#### 1. provider.ts — modelsToTry prepend for continuation guard

**File**: `extensions/provider.ts`
**Changes**: At lines 466-470, when `isGoogleThinkingToolContinuation` is true, prepend `decision.targetLabel` to `modelsToTry`.

```typescript
// (Note: `isGoogleThinkingToolContinuation` is gated to the original tier
// — if `previousDecision.targetLabel` belongs to a different tier than the
// current iteration, skip the prepend. Otherwise we'd prepend a wrong-tier
// model on every tier after the first, wasting auth/lookup latency.)
let modelsToTry = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];
if (
  isGoogleThinkingToolContinuation &&
  previousDecision &&
  tierConfig.model === previousDecision.targetLabel // original-tier gate
) {
  // Prepend the previously-successful model so the guard actually
  // takes effect. Duplicates are harmless (the inner loop short-circuits).
  modelsToTry = [previousDecision.targetLabel, ...modelsToTry];
}
```

`isGoogleThinkingToolContinuation` and `previousDecision` are both already in scope (computed at the top of the same `try` block around provider.ts:330-360). No hoisting required.

#### 2. provider.ts — in-tier fallback mutation contract

**File**: `extensions/provider.ts`
**Changes**: At lines 630-632, mirror cross-tier mutation contract in the in-tier `i > 0` branch.

```typescript
} else if (i > 0) {
// In-tier fallback: model that actually streamed is `modelRef`,
// not the tier primary. Update decision fields so the
// continuation guard (provider.ts:343-366) sees the real model.
// (Do NOT mutate `decision.phase` here — the classifier-decoupled
// value set at routing.ts:345-346 must survive an in-tier fallback
// to preserve sticky-phase heuristic for the next turn.)
decision.isFallback = true;
decision.tier = currentTier;
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

#### 3. provider.test.ts — in-tier + Google guard tests

**File**: `extensions/provider.test.ts`
**Changes**: Add 2 test blocks **after `provider.test.ts:289`** (end of the existing `it`; new `describe` blocks cannot be nested inside an `it`).

```typescript
describe('in-tier fallback mutates target fields', () => {
  it('reflects fallback model in decision when primary fails', async () => {
    // primary model fails, fallback in same tier succeeds →
    // decision.targetProvider/ModelId/Label reflect the fallback model,
    // decision.isFallback === true
  });
});

describe('Google continuation guard after in-tier fallback', () => {
  it('routes back to the model that actually streamed', async () => {
    // Turn N streams google/gemini-2.5-flash after in-tier fallback
    // from gemini-2.5-pro → Turn N+1 (toolResult) routes back to
    // gemini-2.5-flash (not gemini-2.5-pro)
  });
});
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] New in-tier fallback test passes
- [x] New Google continuation guard after in-tier fallback test passes

#### Manual Verification

- [x] `grep -n "decision.isFallback = true" extensions/provider.ts` returns exactly 2 matches (in-tier + cross-tier branches)

---

## Phase 5: Q8 commands surface

### Overview

Delete dead guard at commands.ts:330, document 'all' tier, replace `debugHistory.length = 0` mutation with action call. The `readonly` modifier on the property does **not** prevent `.length = 0` (the current code compiles and works), but mutation via the closure-scoped array is the pattern used by `recordDebugDecision`; an explicit action keeps the contract auditable in `commands.ts`.

### Changes Required

#### 1. commands.ts — delete dead guard + update error message

**File**: `extensions/commands.ts`
**Changes**: Delete unreachable `if (tier !== 'all' && !tierValues.includes(tier as string))` block at line 330. Update error message at `commands.ts:323` from "Use high, medium, or low" → "Use high, medium, low, or all". (The second occurrence at `commands.ts:332` is inside the dead guard being deleted entirely.)

```typescript
if (tier !== 'all' && !tierValues.includes(tier as string)) {
  // DELETED — unreachable: earlier branch (line 320-325) already
  // validates against tierValues ∪ {'all'}.
}
```

#### 2. commands.ts — add 'all' to thinking completions

**File**: `extensions/commands.ts`
**Changes**: At lines 113-160, add 'all' to the matched set in `getThinkingCompletions` second-arg branch (currently only matches `tierValues`).

#### 3. commands.ts — debugHistory via action

**File**: `extensions/commands.ts`
**Changes**: At line 476, replace `state.debugHistory.length = 0` with `actions.clearDebugHistory()`. (The `readonly` modifier on the property does not prevent `.length = 0`, but the action pattern is the auditable one — see Phase 5 Overview.)

```typescript
else if (cmd === 'clear') actions.clearDebugHistory();
```

#### 4. commands.ts — add clearDebugHistory to actions type

**File**: `extensions/commands.ts`
**Changes**: At `commands.test.ts:83-90`, add `clearDebugHistory: vi.fn()` to `buildMockActions()`. At lines 288-289, assert `actions.clearDebugHistory` was called (not `state.debugHistory.length`).

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

#### 5. index.ts — add clearDebugHistory action

**File**: `extensions/index.ts`
**Changes**: Add `clearDebugHistory` closure. Insert **after `recordDebugDecision` ends at `index.ts:117`, before `getThinkingOverride` at `index.ts:119`**. Include in the `actions` object (line 155-187).

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

#### 6. commands.test.ts — update mock + assertion

**File**: `extensions/commands.test.ts`
**Changes**: At `commands.test.ts:83-90`, add `clearDebugHistory: vi.fn()` to `buildMockActions()`. At lines 288-289, assert `actions.clearDebugHistory` was called (not `state.debugHistory.length`).

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

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] `grep -n "Use high, medium, or low" extensions/commands.ts` returns 0 matches
- [x] `grep -n "if (tier !== 'all' && !tierValues.includes" extensions/commands.ts` returns 0 matches
- [x] `grep -n "debugHistory.length = 0" extensions/commands.ts` returns 0 matches

#### Manual Verification

- [x] `/router thinking foo off` errors with updated message including "all" (or `/router thinking all <tab>` shows level completions)
- [x] `/router debug clear` still empties the history (visible via `/router status`)

---

## Phase 6: Q9 orchestrator (50ms sleeps, comment, widget flags)

### Overview

Remove 50ms sleeps (timing-based padding, `registerProvider` is sync), rewrite misleading comment to match actual priority order, add `isPinned` to widget flags.

### Changes Required

#### 1. index.ts — remove 50ms sleeps

**File**: `extensions/index.ts`
**Changes**: Remove `await new Promise((resolve) => setTimeout(resolve, 50))` at line 224 (after `registerProvider()`) and line 311 (in `restoreStateFromSession`).

```typescript
actions.registerRouterProvider();
const routerModel = ctx.modelRegistry.find('router', profileName);
```

`currentModelRegistry = ctx.modelRegistry` (line 308) is already set; no async gap needed at line 311.

#### 2. index.ts — fix comment + drop failureReason ternary (companion to Phase 1)

**File**: `extensions/index.ts`
**Changes**: At lines 91-114, rewrite `recordDebugDecision` comment to match actual priority order. Drop dead `failureReason` branch from the provenance ternary (also from Phase 1).

```typescript
const recordDebugDecision = (decision: RoutingDecision) => {
  // Clone before pushing — Phase 4's cross-tier branch mutates the live
  // `decision` reference in place.
  debugHistory = [...debugHistory, { ...decision }].slice(-MAX_DEBUG_HISTORY);
  if (debugEnabled && lastExtensionContext) {
    // Priority order for the notification source label;
    // `getDecisionFlags` (ui.ts:17-29) accumulates all applicable
    // flags into an array for the widget — it is not a priority
    // selector.
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

#### 3. ui.ts — add isPinned flag

**File**: `extensions/ui.ts`
**Changes**: At lines 17-25, add `if (decision.isPinned) flags.push('pin');` to `getDecisionFlags`.

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

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check` (`npm run tsc` — clean)
- [x] Tests pass: `npm test` (225/225 passed)
- [x] `grep -n "setTimeout(resolve, 50)" extensions/index.ts` returns 0 matches
- [x] Widget renders 'pin' flag for a pinned decision
- [x] New `it('returns pin flag when isPinned is true', ...)` test added to `ui.test.ts` (end of `getDecisionFlags` describe block): `mk({ isPinned: true })` → `['pin']`

#### Manual Verification

- [ ] No test flake increase after sleep removal (run `npm test` 5x in a row)

---

## Phase 7: Q10 unit tests (buildDelegationTierChain)

### Overview

Add 6 test cases for `buildDelegationTierChain` (3 tiers × {budget, non-budget}). Independent of code changes — can run after Phase 1.

### Changes Required

#### 1. routing.test.ts — add buildDelegationTierChain import

**File**: `extensions/routing.test.ts`
**Changes**: At `routing.test.ts:9-15`, add `buildDelegationTierChain` to the import from `./routing`.

```typescript
import {
  // ... existing imports ...
  buildRoutingDecision,
  buildDelegationTierChain, // NEW
  decideRouting,
  // ...
} from './routing';
```

#### 2. routing.test.ts — new buildDelegationTierChain describe block

**File**: `extensions/routing.test.ts`
**Changes**: Add new `describe('buildDelegationTierChain')` block with 6 test cases.

```typescript
describe('buildDelegationTierChain', () => {
  it('high, non-budget → [high, medium, low]', () => {});
  it('high, budget → [high, medium, low]', () => {});
  it('medium, non-budget → [medium, low, high]', () => {});
  it('medium, budget → [medium, low]', () => {});
  it('low, non-budget → [low, medium, high]', () => {});
  it('low, budget → [low]', () => {});
});
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] New `buildDelegationTierChain` describe block has 6 test cases, all green

#### Manual Verification

- [x] Coverage report shows `buildDelegationTierChain` exercised

---

## Phase 8: Q4 + Q6 + Q10 README docs

### Overview

Update README to match runtime: word-boundary matching, upward escalation, advisory `reasoning`/`thinkingLevels`, budget pre-stream cap. Independent of code changes — can run in parallel with any slice.

### Changes Required

#### 1. README.md — 5 surgical edits

**File**: `README.md`
**Changes**:

1. **Line 14, "high → medium → low"** → "down-then-nearest-up (non-budget) / down-only (budget-exceeded)"
2. **Line 120, "substring match, case-insensitive"** → "word-boundary match (case-insensitive); multi-word phrase hints (e.g. `step by step`) use substring match"
3. **Line 195**, inside the phrase "drops to the next lower tier (`high`→`medium`→`low`)": replace with "drops to the next lower tier, or nearest-up if the cap is not exceeded (down-then-nearest-up). When the budget cap is exceeded, the chain is down-only"
4. **Add a paragraph to "Advanced Behaviors"** between Context Truncation and Turn-End Auto-Restore: one-line caveat that the budget gate is pre-stream; a single turn can exceed the cap
5. **Line 242, in the `###`reasoning`Defaults to`true`` subsection of Advanced Behaviors**: replace "Only an explicit `"reasoning": false` disables reasoning and restricts the available thinking levels." with "An explicit `"reasoning": false` is advisory; the runtime delegation gate consults the live model registry, not the config field. `thinkingLevels` similarly narrows what the TUI exposes, not what routing can pick."

### Success Criteria

#### Automated Verification

- [x] `grep -n "substring match, case-insensitive" README.md` returns 0 matches
- [x] `grep -n "high → medium → low" README.md` returns 0 matches
- [x] `grep -n "\`high\` → \`medium\` → \`low\`" README.md` returns 0 matches
- [x] `grep -n "disables reasoning and restricts" README.md` returns 0 matches
- [x] Budget caveat paragraph present in "Advanced Behaviors" (README.md:237)

#### Manual Verification

- [x] README renders correctly (no markdown lint errors)

---

## Phase 9: Integration — budget gate, cross-tier fallback

### Overview

Add cross-tier fallback + budget integration tests. Depends on Phases 4 + 6 (tests cross-tier fallback + budget integration end-to-end).

### Changes Required

#### 1. provider.test.ts — cross-tier fallback test

**File**: `extensions/provider.test.ts`
**Changes**: Add new `describe('cross-tier fallback')` block.

```typescript
describe('cross-tier fallback', () => {
  it('mutates decision when all in-tier models fail and next tier succeeds', async () => {
    // Profile: high tier = [gpt-4o, fails], [gemini-pro, fails]
    //         medium tier = [gpt-4o-mini, succeeds]
    // Expected: decision.tier = 'medium', decision.isFallback = true,
    //           decision.targetProvider = 'openai', decision.targetModelId = 'gpt-4o-mini'
  });
});
```

#### 2. provider.test.ts — budget integration test

**File**: `extensions/provider.test.ts`
**Changes**: Add new `describe('budget integration')` block.

```typescript
describe('budget integration', () => {
  it('downgrades routing when accumulatedCost >= maxSessionBudget', async () => {
    // Config: maxSessionBudget = 0.50, state.accumulatedCost = 0.60
    // Profile: high = gpt-4o (reasoning), medium = gpt-4o-mini
    // Prompt: 'plan the architecture carefully' (would normally route to high)
    // Expected: decision.tier = 'medium', decision.isBudgetForced = true
  });
});
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run check`
- [x] Tests pass: `npm test`
- [x] New budget integration test passes
- [x] New cross-tier fallback test passes
- [x] `grep -rn "fetch(\|axios\|http\.request\|https\.request" extensions/*.test.ts` returns 0 matches (tests make no live API calls)

#### Manual Verification

- [x] All new tests together pass with `npm test` (no flake)

---

## Testing Strategy

### Automated

- `npm run check` (typescript) + `npm test` (vitest) must both pass after every slice.
- Grep checks per slice confirm dead code was removed.

### Manual Testing Steps

1. `/router thinking all off` no longer errors with "Use high, medium, or low".
2. `/router debug clear` still empties the history.
3. Widget shows 'pin' flag for pinned decisions.
4. No test flake increase after sleep removal (run `npm test` 5x in a row).
5. Visual review of `/router status` after a forced in-tier fallback (latent display bugs may surface).

## Performance Considerations

No hot-path changes. The new `containsAnyWord` call sites add the same number of regex tests as the old `containsAny` did. The `modelsToTry` prepend is O(n) once. The 50ms sleep removal is a strict improvement (eliminates 100ms of synchronous blocking per startup).

## Migration Notes

No data migration. Persisted state files containing `lastPhase` will continue to load (validation at `state.ts:30-77` only checks `lastPhase`-adjacent fields; the field will be silently dropped on the next `buildPersistedState` call). Forward-compatible drop.

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. All 21 findings triaged at Step 5: 21 applied._

| source   | plan-loc                                  | codebase-loc                                                   | severity   | dimension             | finding                                                                               | recommendation                                     | resolution                                                                       |
| -------- | ----------------------------------------- | -------------------------------------------------------------- | ---------- | --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| code     | Phase 2 §1 (routing.ts)                   | extensions/routing.ts:333-334,365,370,375,380,391,397          | blocker    | actionability         | Misses line 334 (veto site); includes bogus '300-315' range                           | Use verified set 333,334,365,370,375,380,391,397   | applied: fixed enumeration + added containsAny deletion + cache/live-API greps   |
| code     | Phase 4 §2 (provider.ts)                  | extensions/provider.ts:630-643, extensions/routing.ts:345-346  | blocker    | code-quality          | In-tier branch clobbers classifier-decoupled phase                                    | Drop `decision.phase = phaseForTier(currentTier);` | applied: removed phase line from in-tier code fence                              |
| code     | Phase 6 §2 (index.ts)                     | extensions/index.ts:90-117, extensions/ui.ts:17-25             | blocker    | codebase-fit          | Comment wrongly claims getDecisionFlags is a priority selector                        | Reword comment                                     | applied: reworded to 'notification source label; getDecisionFlags accumulates'   |
| coverage | ## Verification Notes §4a                 | <n/a>                                                          | blocker    | verification-coverage | No preservation check for partial-stream cost leak at provider.ts:591-598             | Add preservation grep                              | applied: added `grep "partial-stream\|cost leak"` to Phase 3 Auto                |
| code     | Phase 4 §1 (provider.ts)                  | extensions/provider.ts:343-366,466-470                         | concern    | code-quality          | prepend fires on every tier iteration after guard                                     | Move outside loop or gate by tier                  | applied: gated prepend on `tierConfig.model === previousDecision.targetLabel`    |
| code     | Phase 6 §1 (index.ts)                     | extensions/index.ts:90-117                                     | concern    | actionability         | Phase 1 §4 deletes branch that Phase 6 §2 overwrites (dead work)                      | Consolidate                                        | applied: Phase 1 §4 marked no-op; Phase 6 §2 handles deletion                    |
| code     | Phase 2 §1 (routing.ts)                   | extensions/routing.ts:75, extensions/routing.test.ts:9,151-156 | concern    | codebase-fit          | containsAny becomes production-dead but stays exported+tested                         | Delete the export                                  | applied: Phase 2 §1 now deletes containsAny export + test block                  |
| code     | Phase 5 (commands.ts Overview)            | extensions/commands.ts:48                                      | concern    | code-quality          | readonly does not prevent `.length = 0`; stated rationale is wrong                    | Reword rationale                                   | applied: reworded to closure-pattern + auditable-contract rationale              |
| code     | Phase 5 §1 (commands.ts)                  | extensions/commands.ts:323,332                                 | concern    | codebase-fit          | Plan cites 'line 313' but occurrences are at 323 and 332                              | Cite 323 + note 332 in deleted guard               | applied: cite updated to 323 with 332-deleted note                               |
| code     | Phase 5 §5 (index.ts)                     | extensions/index.ts:90,117,119                                 | concern    | actionability         | Plan says 'line 91 ... ends at 126' but actual is 91 (body) ends 117 next 119         | Fix citation                                       | applied: cite updated to 'after 117, before 119'                                 |
| code     | Phase 5 §6 (commands.test.ts)             | extensions/commands.test.ts:83-90,288-289                      | concern    | codebase-fit          | buildMockActions is at 83-90, not 76-83                                               | Fix citation                                       | applied: cite updated to 83-90                                                   |
| code     | Phase 4 §3 (provider.test.ts)             | extensions/provider.test.ts:218-289                            | concern    | actionability         | 'lines 247-284' is inside existing `it()`; new `describe` can't nest there            | Place after 289                                    | applied: placement updated to 'after provider.test.ts:289'                       |
| code     | Phase 5 (commands.ts Manual Verification) | extensions/commands.ts:318,323                                 | concern    | actionability         | `/router thinking all off` already works at HEAD; doesn't validate any Phase 5 change | Use a case that exercises Phase 5                  | applied: replaced with 'foo off' error message or 'all <tab>' completions        |
| coverage | ## Verification Notes §4b                 | <n/a>                                                          | blocker    | verification-coverage | No preservation check for module-level regex cache at routing.ts:80-94                | Add preservation grep                              | applied: added `grep "wordBoundaryRegex\|regexCache" ≥2 matches` to Phase 2 Auto |
| coverage | ## Verification Notes §3                  | <n/a>                                                          | concern    | verification-coverage | 'no live API calls' has no criteria bullet                                            | Add grep to test-touching slices                   | applied: added `grep "fetch(\|axios\|http.request"` to Phases 2 + 9 Auto         |
| code     | Phase 1 §4 (index.ts)                     | extensions/index.ts:107-109                                    | suggestion | codebase-fit          | Branch already dead after Phase 1 narrows ClassifierFailureReason                     | Cross-reference Phase 6                            | applied: handled by C-2 consolidation (Phase 1 §4 → no-op)                       |
| code     | Phase 6 §3 (ui.ts)                        | extensions/ui.test.ts:93-127                                   | suggestion | actionability         | 'pin' flag has no test added                                                          | Add it() to ui.test.ts                             | applied: added isPinned test requirement to Phase 6 Auto                         |
| code     | Phase 1 (types.ts Success Criteria)       | extensions/                                                    | suggestion | code-quality          | `grep -n` without `-r` won't read directories                                         | Add `-r`                                           | applied: Phase 1 grep updated to `grep -rn "lastPhase" extensions/`              |
| code     | Phase 3 §1 (provider.ts)                  | extensions/provider.ts:617-626                                 | suggestion | codebase-fit          | Cites 605-612 but actual is 617-626                                                   | Fix citation                                       | applied: cite updated to 617-626                                                 |
| code     | Phase 4 §1 (provider.ts)                  | extensions/provider.ts:343-366                                 | suggestion | codebase-fit          | Cites guard as 338-351; actual is 343-366                                             | Fix citation                                       | applied: cite updated to 343-366 (and 341-343 for declarations)                  |
| code     | Phase 7 §1 (routing.test.ts)              | extensions/routing.test.ts:9-15                                | suggestion | codebase-fit          | Cites import at 5-17; actual is 9-15                                                  | Fix citation                                       | applied: cite updated to 9-15                                                    |

## References

- Design: `.rpiv/artifacts/designs/2026-07-18_15-05-21_deslop-false-promises.md`
- Research: `.rpiv/artifacts/research/2026-07-18_14-36-23_deslop-false-promises.md`
- Commit `14466e2f` — precedent for bulk routing-defect fix
- Commit `f873288a` — precedent for veto gate (introduced substring bug)
