---
date: 2026-07-21T19:27:12+0700
author: Yogiswara Utama
commit: e4b5601f
branch: main
repository: pi-model-router
topic: classifier-routing-accuracy
tags:
  [classifier, routing, accuracy, confidence, prompt-engineering, calibration]
status: ready
parent: .rpiv/artifacts/research/2026-07-21_19-14-23_classifier-routing-accuracy.md
phase_count: 4
phases:
  - { n: 1, title: Types & State Foundation }
  - { n: 2, title: Prompt Builder }
  - { n: 3, title: Confidence Wiring }
  - { n: 4, title: Calibration Recording }
unresolved_phase_count: 0
last_updated: 2026-07-21T19:27:12+0700
last_updated_by: Yogiswara Utama
---

# Classifier Routing Accuracy Improvements

## Overview

Extract the inline classifier prompt template into a `buildClassifierPrompt()` function that injects signals the heuristic branch already uses (toolResultCount, wordCount, multiLinePrompt, phaseBias, budget context). Wire the classifier's `confidence` signal into decision logic — degrade to heuristics on low confidence, make the veto gate confidence-aware. Add provenance flags (`classifierAttempted`, richer `ClassifierFailureReason`) for debuggability. Collect calibration data from user corrections (`/router fix`) for future few-shot learning.

## Requirements

- Extract inline classifier prompt at `extensions/routing.ts:572-600` into a standalone `buildClassifierPrompt()` function
- Inject `toolResultCount`, `wordCount`, `multiLinePrompt`, `phaseBias`, `isBudgetExceeded` into the classifier prompt
- Increase history window from 4 to 6 messages (matching heuristic default)
- Wire `decision.confidence` into routing logic: degrade to heuristic branch on low confidence
- Make veto gate confidence-aware: only override classifier when `confidence !== 'high'`
- Always run classifier when `classifierModel` is configured (remove `!ruleHit` gate)
- Add `classifierAttempted` flag and richer `ClassifierFailureReason` values to `RoutingDecision`
- Record calibration entries from `/router fix` corrections for future few-shot learning
- Add sanitization and persistence for all new fields

## Current State Analysis

The classifier path (`runClassifier` at `extensions/routing.ts:540`) has 10 distinct accuracy gaps. The single highest-leverage improvement is extracting the inline prompt template into a `buildClassifierPrompt()` function. The confidence field is parsed, persisted, and displayed — but never used for decision logic. The veto gate fires unconditionally regardless of confidence. The classifier is suppressed when a keyword rule matches. There is no feedback loop from user corrections.

### Key Discoveries

- `extensions/routing.ts:572-600` — Inline classifier prompt template (needs extraction)
- `extensions/routing.ts:477` — `decision.confidence` parsed but never consumed for routing
- `extensions/routing.ts:336-351` — Veto gate fires unconditionally regardless of confidence
- `extensions/provider.ts:311` — Classifier gate: `!pinnedTier && !ruleHit` suppresses classifier on rule match
- `extensions/types.ts:71` — `ClassifierFailureReason` only `'success' | 'unparseable'`
- `extensions/types.ts:92-104` — `RoutingDecision` needs `classifierTier`, `vetoOutcome`, `classifierAttempted`
- `extensions/types.ts:107-119` — `RouterPersistedState` needs `classifierCalibration` array
- `extensions/state.ts:53` — `isConfidenceLevel` sanitizer for cosmetic-only field
- `extensions/state.ts:110-130` — `sanitizeRoutingDecisionFields` needs new optional fields
- `extensions/state.ts:152-183` — `buildPersistedState` needs calibration param
- `extensions/state.ts:215-230` — `isRouterPersistedState` needs calibration validation
- `extensions/index.ts:88-95` — `recordDebugDecision` notification source chain
- `extensions/index.ts:100-114` — `persistState` snapshot dedup
- `extensions/index.ts:127-155` — `restoreStateFromSession` array restoration pattern
- `extensions/commands.ts:429-442` — `handleFix` sets pin, no calibration recording
- `extensions/ui.ts:22-30` — `getDecisionFlags` needs `classifier-failed` flag
- `extensions/constants.ts` — `MAX_DEBUG_HISTORY = 12`, add `MAX_CALIBRATION_ENTRIES`

## Desired End State

```typescript
// buildClassifierPrompt accepts a context-bundle with all heuristic signals
const ctx: ClassifierPromptContext = {
  promptText: getLastUserText(context),
  historyText: getRecentConversationText(context, 6), // increased from 4
  toolResultCount: countToolResults(context),
  wordCount: countWords(prompt),
  multiLinePrompt: prompt.split('\n').length >= 4,
  currentPhase: state.lastDecision?.phase,
  hasImage: hasImageAttachment(context),
  isBudgetExceeded,
  phaseBias: state.currentConfig.phaseBias,
};
const prompt = buildClassifierPrompt(ctx);

// Confidence-aware routing: low confidence → heuristic fallback
if (classifierResult.confidence === 'low') {
  // fall through to heuristic branch, classifierAttempted = true
}

// Confidence-aware veto: only override when confidence !== 'high'
if (
  promptHasHighHint &&
  candidateTier !== 'high' &&
  classifierResult.confidence !== 'high'
) {
  candidateTier = 'high';
}

// Calibration recording on /router fix
if (state.lastDecision?.isClassifier) {
  classifierCalibration.push({
    promptSummary: state.lastDecision.rawText?.slice(0, 100),
    classifierTier: state.lastDecision.tier,
    finalTier: tier,
    userCorrection: true,
    timestamp: Date.now(),
  });
}
```

## What We're NOT Doing

- **Latency caching** (Q10): No prompt-hash cache or continuation fast-path. Deferred.
- **Thinking optimization** (Q7): No per-model thinking config for classifier. Deferred.
- **Budget-aware prompt injection** (Q9): No `isBudgetExceeded`/`accumulatedCost` in classifier prompt. Deferred — depends on Q4 extraction first.
- **Few-shot exemplar injection**: Calibration data is collected but not yet injected into the prompt. Deferred until enough data accumulates.
- **JSON-mode output parsing**: Not switching to JSON-mode via `streamSimple` options. The regex parser is kept but made more robust.
- **PhaseBias numeric rendering**: Not adding `phaseBias` numeric value to the prompt. Deferred — prose hints already exist.

## Decisions

### Decision 1: Extract buildClassifierPrompt() as linchpin refactor

- **Ambiguity**: 10 accuracy gaps — which to prioritize?
- **Explored**: Prompt builder refactor vs confidence-aware logic vs structured output parser vs calibration feedback loop
- **Decision**: Extract `buildClassifierPrompt()` first. It's the prerequisite for Q4 (signal injection), Q8 (calibration exemplars), and Q9 (budget awareness). Modeled after `buildRoutingDecision` at `extensions/routing.ts:133`.

### Decision 2: Increase history window from 4 to 6

- **Ambiguity**: Classifier uses hard-coded 4-message history; heuristics use default 6.
- **Explored**: Keep 4 vs increase to 6 vs make configurable
- **Decision**: Increase to 6 to match heuristic default. Low risk, small token cost increase.

### Decision 3: Degrade to heuristics on low confidence

- **Ambiguity**: `decision.confidence` is parsed and persisted but never consumed.
- **Explored**: Ignore confidence vs degrade on low vs degrade on low+medium
- **Decision**: When `classifierResult.confidence === 'low'`, fall through to heuristic branch. Preserve classifier provenance via `classifierAttempted` flag.

### Decision 4: Extend ClassifierFailureReason

- **Ambiguity**: Currently only `'success' | 'unparseable'`.
- **Explored**: Keep binary vs add `'json-refused' | 'json-invalid' | 'infra-failure'`
- **Decision**: Add `'json-refused' | 'json-invalid' | 'infra-failure'`. Safe additive change — existing code only checks `=== 'unparseable'`.

### Decision 5: Add classifierAttempted + veto fields to RoutingDecision

- **Ambiguity**: No provenance for classifier failure or veto outcome.
- **Explored**: Skip vs add optional fields
- **Decision**: Add `classifierAttempted: boolean`, `classifierTier: RouterTier`, `vetoOutcome: 'classifier-wins' | 'veto-wins'`, `vetoDisagreementMagnitude: number` as optional fields. Follows existing provenance pattern (`isClassifier`, `confidence`, `rawText`).

### Decision 6: Confidence-aware veto gate

- **Ambiguity**: Veto fires unconditionally regardless of classifier confidence.
- **Explored**: Keep unconditional vs confidence-aware vs magnitude-aware
- **Decision**: Only veto when `classifierResult.confidence !== 'high'`. Start simple; add magnitude check (≥2 tier gap) in follow-up if needed.

### Decision 7: Always run classifier when configured

- **Ambiguity**: `!ruleHit` gate at `provider.ts:311` suppresses classifier on rule match.
- **Explored**: Keep gate vs always run vs run with rule context
- **Decision**: Remove `!ruleHit` gate. Add merge logic in `decideRouting`: when rule and classifier disagree, prefer higher tier when classifier confidence is 'high'; trust the rule when confidence is 'low'.

### Decision 8: Calibration collection only (no injection yet)

- **Ambiguity**: How to implement the feedback loop.
- **Explored**: Full loop (collect + inject) vs collection-only vs skip
- **Decision**: Collect calibration entries from `/router fix` corrections. Store in `classifierCalibration` array on `RouterPersistedState`. Injection into prompt deferred until enough data accumulates.

## Phase 1: Types & State Foundation

### Overview

Add all new types, extended enums, constants, and state sanitization logic. Foundation for all subsequent phases.

### Changes Required

#### 1. extensions/types.ts

**File**: extensions/types.ts
**Changes**: MODIFY — Add `ClassifierPromptContext` interface, `ClassifierCalibrationEntry` type, extend `ClassifierFailureReason`, add optional fields to `RoutingDecision`, add `classifierCalibration` to `RouterPersistedState`

```typescript
export type ClassifierFailureReason =
  | 'success'
  | 'unparseable'
  | 'json-refused'
  | 'json-invalid'
  | 'infra-failure';

export interface ClassifierPromptContext {
  promptText: string;
  historyText: string;
  toolResultCount: number;
  wordCount: number;
  multiLinePrompt: boolean;
  currentPhase?: RouterPhase;
  hasImage?: boolean;
  isBudgetExceeded?: boolean;
  phaseBias?: number;
}

export interface ClassifierCalibrationEntry {
  promptSummary: string;
  classifierTier: RouterTier;
  finalTier: RouterTier;
  userCorrection?: boolean;
  timestamp: number;
}

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  phase: RouterPhase;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
  thinking: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean;
  isFallback?: boolean;
  isBudgetForced?: boolean;
  isRuleMatched?: boolean;
  isPinned?: boolean;
  confidence?: ConfidenceLevel;
  rawText?: string;
  failureReason?: ClassifierFailureReason;
  isVetoed?: boolean;
  vetoReason?: 'explicit-hint';
  classifierAttempted?: boolean;
  classifierTier?: RouterTier;
  vetoOutcome?: 'classifier-wins' | 'veto-wins';
  vetoDisagreementMagnitude?: number;
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier;
  pinByProfile?: RouterPinByProfile;
  thinkingByProfile?: RouterThinkingByProfile;
  debugEnabled?: boolean;
  widgetEnabled?: boolean;
  debugHistory?: RoutingDecision[];
  lastDecision?: RoutingDecision;
  lastNonRouterModel?: string;
  accumulatedCost?: number;
  classifierCalibration?: ClassifierCalibrationEntry[];
  timestamp: number;
}
```

#### 2. extensions/constants.ts

**File**: extensions/constants.ts
**Changes**: MODIFY — Add `MAX_CALIBRATION_ENTRIES` constant

```typescript
export const MAX_DEBUG_HISTORY = 12;
export const MAX_CALIBRATION_ENTRIES = 5;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
```

#### 3. extensions/state.ts

**File**: extensions/state.ts
**Changes**: MODIFY — Update `isFailureReason`, `sanitizeRoutingDecisionFields`, `isRouterPersistedState`, `buildPersistedState`

```typescript
import type {
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
  ClassifierCalibrationEntry,
} from './types';

const isFailureReason = (
  v: unknown,
): v is NonNullable<RoutingDecision['failureReason']> =>
  v === 'success' || v === 'unparseable' || v === 'json-refused' || v === 'json-invalid' || v === 'infra-failure';

// In sanitizeRoutingDecisionFields, after isFailureReason check:
  if (isOptionalBoolean(value.classifierAttempted)) {
    out.classifierAttempted = value.classifierAttempted;
  }
  if (isRouterTier(value.classifierTier)) {
    out.classifierTier = value.classifierTier;
  }
  if (value.vetoOutcome === 'classifier-wins' || value.vetoOutcome === 'veto-wins') {
    out.vetoOutcome = value.vetoOutcome;
  }
  if (typeof value.vetoDisagreementMagnitude === 'number') {
    out.vetoDisagreementMagnitude = value.vetoDisagreementMagnitude;
  }

// In isRouterPersistedState, after lastNonRouterModel check:
  if (v.classifierCalibration !== undefined) {
    if (!Array.isArray(v.classifierCalibration)) return false;
    for (const entry of v.classifierCalibration) {
      if (!isObjectRecord(entry)) return false;
      if (typeof entry.promptSummary !== 'string') return false;
      if (!isRouterTier(entry.classifierTier)) return false;
      if (!isRouterTier(entry.finalTier)) return false;
      if (typeof entry.timestamp !== 'number') return false;
    }
  }

export const buildPersistedState = (
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  debugEnabled: boolean,
  widgetEnabled: boolean,
  debugHistory: RoutingDecision[],
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  accumulatedCost: number,
  classifierCalibration: ClassifierCalibrationEntry[],
): RouterPersistedState => {
  return {
    enabled: routerEnabled,
    selectedProfile: selectedProfile ?? '',
    pinTier: selectedProfile ? pinnedTierByProfile[selectedProfile] : undefined,
    pinByProfile: { ...pinnedTierByProfile },
    thinkingByProfile: { ...thinkingByProfile },
    debugEnabled,
    widgetEnabled,
    debugHistory,
    lastDecision,
    lastNonRouterModel,
    accumulatedCost,
    classifierCalibration,
    timestamp: Date.now(),
  };
```

#### 4. extensions/ui.ts

**File**: extensions/ui.ts
**Changes**: MODIFY — Add `classifier-failed` flag to `getDecisionFlags`

```typescript
export const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isRuleMatched) flags.push('rule');
  if (decision.isClassifier) flags.push('classifier');
  if (decision.isVetoed) flags.push('vetoed');
  if (decision.isPinned) flags.push('pin');
  if (decision.classifierAttempted && !decision.isClassifier)
    flags.push('classifier-failed');
  return flags;
};
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] New types are exported from `types.ts`
- [x] `isFailureReason` accepts all 5 values
- [x] `isRouterPersistedState` validates calibration array entries
- [x] `sanitizeRoutingDecisionFields` preserves new optional fields

#### Manual Verification

- [ ] No breaking changes to existing persisted state (old snapshots restore correctly)
- [ ] `getDecisionFlags` shows `classifier-failed` when classifier attempted but didn't decide

## Phase 2: Prompt Builder

### Overview

Extract `buildClassifierPrompt()` function, modify `runClassifier` to use it, increase history window. Add tests.

### Changes Required

#### 1. extensions/routing.ts

**File**: extensions/routing.ts
**Changes**: MODIFY — Add `buildClassifierPrompt()` function, modify `runClassifier` to extract signals and call builder, increase history window from 4 to 6

```typescript
import type {
  RouterTier,
  RouterPhase,
  RouterProfile,
  RoutingDecision,
  RoutingRule,
  RouterThinkingByTier,
  ClassifierResult,
  ClassifierFailureReason,
  ConfidenceLevel,
  ClassifierPromptContext,
} from './types';

// Added after buildRoutingDecision:
export const buildClassifierPrompt = (ctx: ClassifierPromptContext): string => {
  const lines: string[] = [
    'You are a model router classifier. Your job is to categorize the user\'s latest request into one of three tiers: "high", "medium", or "low".',
    '',
    'Tiers:',
    '- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.',
    '- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.',
    '- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.',
    '',
  ];

  if (ctx.currentPhase) {
    lines.push(`Current conversation phase: ${ctx.currentPhase}`);
    lines.push('');
  }

  lines.push('Recent history:');
  lines.push(ctx.historyText);
  lines.push('');
  lines.push('Latest user message:');
  lines.push(ctx.promptText);
  lines.push('');

  if (ctx.hasImage) {
    lines.push(
      'Note: The user has attached an image. Bias toward "high" or "medium" tier as lower tiers may not support vision capabilities.',
    );
    lines.push('');
  }

  if (ctx.toolResultCount > 0) {
    lines.push(
      `Note: The conversation has ${ctx.toolResultCount} tool result(s), indicating active implementation work.`,
    );
    lines.push('');
  }

  if (ctx.wordCount >= 40) {
    lines.push(
      "Note: The user's message is long and detailed, suggesting a complex request.",
    );
    lines.push('');
  }

  if (ctx.multiLinePrompt) {
    lines.push(
      "Note: The user's message spans multiple lines, suggesting a structured or detailed request.",
    );
    lines.push('');
  }

  lines.push('Return your decision in exactly three lines:');
  lines.push('Tier: [high|medium|low]');
  lines.push('Confidence: [high|medium|low]');
  lines.push('Reasoning: [one short sentence]');
  lines.push('');

  if (ctx.currentPhase === 'planning') {
    lines.push(
      'Consider that the conversation is currently in a planning phase. Bias toward "high" unless the request is clearly a simple implementation or summary.',
    );
  }
  if (ctx.currentPhase === 'implementation') {
    lines.push(
      'Consider that the conversation is currently in an implementation phase. Bias toward "medium" unless the request is clearly planning or a simple summary.',
    );
  }

  return lines.join('\n');
};

// Modified runClassifier — history window 4→6, signal extraction, builder call:
const promptText = getLastUserText(context);
const historyText = getRecentConversationText(context, 6);
const toolResultCount = countToolResults(context);
const wordCount = countWords(promptText);
const multiLinePrompt = promptText.split('\n').length >= 4;

const classifierCtx: ClassifierPromptContext = {
  promptText,
  historyText,
  toolResultCount,
  wordCount,
  multiLinePrompt,
  currentPhase,
  hasImage,
};
const classifierPrompt = buildClassifierPrompt(classifierCtx);
```

#### 2. extensions/routing.test.ts

**File**: extensions/routing.test.ts
**Changes**: MODIFY — Add tests for `buildClassifierPrompt`

```typescript
import {
  extractTextFromContent,
  getLastUserText,
  getRecentConversationText,
  countToolResults,
  countWords,
  hasImageAttachment,
  phaseForTier,
  resolveAvailableTier,
  buildRoutingDecision,
  buildDelegationTierChain,
  buildClassifierPrompt,
  decideRouting,
  parseClassifierOutput,
  runClassifier,
} from './routing';

// Added after buildDelegationTierChain tests:
describe('buildClassifierPrompt', () => {
  it('includes the prompt text', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'refactor the auth module',
      historyText: '',
      toolResultCount: 0,
      wordCount: 4,
      multiLinePrompt: false,
    });
    expect(prompt).toContain('refactor the auth module');
  });

  it('includes phase context when provided', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'design the new API',
      historyText: '',
      toolResultCount: 0,
      wordCount: 5,
      multiLinePrompt: false,
      currentPhase: 'planning',
    });
    expect(prompt).toContain('Current conversation phase: planning');
    expect(prompt).toContain('planning phase');
  });

  it('includes image note when hasImage is true', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'what is this',
      historyText: '',
      toolResultCount: 0,
      wordCount: 3,
      multiLinePrompt: false,
      hasImage: true,
    });
    expect(prompt).toContain('attached an image');
  });

  it('omits image note when hasImage is false', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'what is this',
      historyText: '',
      toolResultCount: 0,
      wordCount: 3,
      multiLinePrompt: false,
      hasImage: false,
    });
    expect(prompt).not.toContain('attached an image');
  });

  it('includes tool result count when > 0', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'continue',
      historyText: '',
      toolResultCount: 3,
      wordCount: 1,
      multiLinePrompt: false,
    });
    expect(prompt).toContain('3 tool result');
  });

  it('includes word count note when >= 40', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'a'.repeat(200),
      historyText: '',
      toolResultCount: 0,
      wordCount: 40,
      multiLinePrompt: false,
    });
    expect(prompt).toContain('long and detailed');
  });

  it('includes multi-line note when multiLinePrompt is true', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'line1\nline2\nline3\nline4',
      historyText: '',
      toolResultCount: 0,
      wordCount: 4,
      multiLinePrompt: true,
    });
    expect(prompt).toContain('multiple lines');
  });

  it('returns exactly three output lines instruction', () => {
    const prompt = buildClassifierPrompt({
      promptText: 'test',
      historyText: '',
      toolResultCount: 0,
      wordCount: 1,
      multiLinePrompt: false,
    });
    expect(prompt).toContain('Tier: [high|medium|low]');
    expect(prompt).toContain('Confidence: [high|medium|low]');
    expect(prompt).toContain('Reasoning: [one short sentence]');
  });
});
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] `buildClassifierPrompt` tests pass (8 test cases)
- [x] History window increased from 4 to 6 in `runClassifier`
- [x] `runClassifier` no longer contains inline prompt template

#### Manual Verification

- [ ] Classifier prompt includes toolResultCount, wordCount, multiLinePrompt signals
- [ ] Classifier prompt matches heuristic signal set

## Phase 3: Confidence Wiring

### Overview

Wire confidence into decision logic: degrade to heuristics on low confidence, confidence-aware veto gate, always-run classifier, rule+classifier merge logic.

### Changes Required

#### 1. extensions/routing.ts

**File**: extensions/routing.ts
**Changes**: MODIFY — Update `decideRouting` for confidence-aware veto, low-confidence degrade, rule+classifier merge, thread new provenance fields

```typescript
import { parseCanonicalModelRef, isRouterTier, ROUTER_TIERS } from './config';

// New local variables in decideRouting:
let classifierAttempted = false;
let classifierTier: RouterTier | undefined;
let vetoOutcome: 'classifier-wins' | 'veto-wins' | undefined;
let vetoDisagreementMagnitude: number | undefined;

// Rule+classifier merge branch (before rule-only branch):
if (ruleMatch && classifierResult) {
  isClassifier = true;
  classifierAttempted = true;
  classifierTier = classifierResult.tier;
  const tierRank: Record<RouterTier, number> = { low: 1, medium: 2, high: 3 };
  if (
    classifierResult.confidence === 'high' &&
    tierRank[classifierResult.tier] > tierRank[ruleMatch.tier]
  ) {
    tier = classifierResult.tier;
    phase = previousDecision?.phase ?? phaseForTier(tier);
    reasoning = `Classifier: ${classifierResult.reasoning} (merged: classifier high-confidence preferred over rule)`;
    vetoOutcome = 'classifier-wins';
  } else {
    tier = ruleMatch.tier;
    phase = phaseForTier(tier);
    reasoning = ruleMatch.reasoning;
    isRuleMatched = true;
    vetoOutcome = 'classifier-wins';
  }

  // Classifier-only branch with low-confidence degrade and confidence-aware veto:
} else if (classifierResult) {
  classifierAttempted = true;
  classifierTier = classifierResult.tier;

  if (classifierResult.confidence === 'low') {
    // Fall through to heuristic branch below
  } else {
    isClassifier = true;
    let candidateTier = classifierResult.tier;

    const promptHasHighHint = containsAnyWord(prompt, explicitHighHints);
    const promptHasLowHint = containsAnyWord(prompt, explicitLowHints);
    if (
      promptHasHighHint &&
      candidateTier !== 'high' &&
      classifierResult.confidence !== 'high'
    ) {
      candidateTier = 'high';
      isVetoed = true;
      vetoReason = 'explicit-hint';
    } else if (
      promptHasLowHint &&
      candidateTier !== 'low' &&
      classifierResult.confidence !== 'high'
    ) {
      candidateTier = 'low';
      isVetoed = true;
      vetoReason = 'explicit-hint';
    }

    tier = candidateTier;
    phase = previousDecision?.phase ?? phaseForTier(tier);
    reasoning = isVetoed
      ? `Classifier: ${classifierResult.reasoning} (vetoed: explicit-hint forced ${tier})`
      : `Classifier: ${classifierResult.reasoning}`;

    if (isVetoed) {
      vetoOutcome = 'veto-wins';
      vetoDisagreementMagnitude = Math.abs(
        ROUTER_TIERS.indexOf(classifierResult.tier) -
          ROUTER_TIERS.indexOf(candidateTier),
      );
    } else {
      vetoOutcome = 'classifier-wins';
    }
  }
}

// Heuristic branch gated on !isClassifier && !ruleMatch && !pinnedTier

// Provenance threading (after buildRoutingDecision call):
decision.classifierAttempted = classifierAttempted;
if (classifierTier) {
  decision.classifierTier = classifierTier;
}
if (vetoOutcome) {
  decision.vetoOutcome = vetoOutcome;
}
if (vetoDisagreementMagnitude !== undefined) {
  decision.vetoDisagreementMagnitude = vetoDisagreementMagnitude;
}
// classifierResult fields set for ALL classifier results (not just isClassifier)
if (classifierResult) {
  decision.confidence = classifierResult.confidence;
  decision.rawText = classifierResult.rawText;
  decision.failureReason = classifierResult.failureReason;
  if (isVetoed) {
    decision.isVetoed = true;
    decision.vetoReason = vetoReason;
  }
}
```

#### 2. extensions/provider.ts

**File**: extensions/provider.ts
**Changes**: MODIFY — Remove `!ruleHit` gate condition

```typescript
          // Pre-decision: gate classifier on no pin (always run when configured)
          const prompt = getLastUserText(context).toLowerCase();
          const ruleHit = !pinnedTier
            ? matchHighestTierRule(prompt, state.currentConfig.rules)
            : undefined;

          let classifierResult: ClassifierResult | undefined;
          if (!pinnedTier && state.currentConfig.classifierModel) {
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] Low-confidence classifier result degrades to heuristic branch
- [x] High-confidence classifier result is not vetoed by explicit hints
- [x] Classifier runs even when rule matches (no `!ruleHit` gate)
- [x] Rule+classifier merge prefers higher tier when classifier confidence is 'high'

#### Manual Verification

- [ ] Debug notification shows `classifier-failed` when classifier attempted but degraded
- [ ] Veto only fires when confidence !== 'high'
- [ ] `/router debug show` shows `classifierAttempted` and `vetoOutcome` fields

## Phase 4: Calibration Recording

### Overview

Record calibration entries from `/router fix` corrections, restore from session, persist with snapshot dedup.

### Changes Required

#### 1. extensions/commands.ts

**File**: extensions/commands.ts
**Changes**: MODIFY — Add calibration recording in `handleFix`

```typescript
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterTier,
  ClassifierCalibrationEntry,
} from './types';

import { MAX_CALIBRATION_ENTRIES } from './constants';

// State object now includes:
    classifierCalibration: ClassifierCalibrationEntry[];

// In handleFix, after setting pinnedTierByProfile:
    // Record calibration entry when fixing a classifier decision
    if (state.lastDecision.isClassifier || state.lastDecision.classifierAttempted) {
      const entry: ClassifierCalibrationEntry = {
        promptSummary: state.lastDecision.rawText?.slice(0, 100) ?? '',
        classifierTier: state.lastDecision.classifierTier ?? state.lastDecision.tier,
        finalTier: tier as RouterTier,
        userCorrection: true,
        timestamp: Date.now(),
      };
      state.classifierCalibration = [
        ...state.classifierCalibration,
        entry,
      ].slice(-MAX_CALIBRATION_ENTRIES);
    }
```

#### 2. extensions/index.ts

**File**: extensions/index.ts
**Changes**: MODIFY — Add calibration restoration in `restoreStateFromSession`, add to `persistState` snapshot dedup, add `classifierCalibration` to state

```typescript
// Module-level state (changed from const to let):
  let classifierCalibration: ClassifierCalibrationEntry[] = [];

// State object passed to registerCommands:
      get classifierCalibration() {
        return classifierCalibration;
      },
      set classifierCalibration(v) {
        classifierCalibration = v;
      },

// In restoreStateFromSession, after accumulatedCost restoration:
      classifierCalibration = savedState.classifierCalibration
        ? [...savedState.classifierCalibration].slice(-MAX_CALIBRATION_ENTRIES)
        : [];

// In persistState snapshot dedup:
      classifierCalibration: state.classifierCalibration?.map((entry) => ({
        ...entry,
        timestamp: 0,
      })),
```

### Success Criteria

#### Automated Verification

- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] Calibration entry recorded when `/router fix` corrects a classifier decision
- [x] Calibration array capped at `MAX_CALIBRATION_ENTRIES`
- [x] Calibration entries restored from session on relaunch
- [x] Calibration entries included in state snapshot dedup

#### Manual Verification

- [ ] `/router fix` after a classifier decision records a calibration entry
- [ ] Calibration entries survive agent relaunch
- [ ] No calibration entry recorded when `/router fix` corrects a non-classifier decision

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc                 | codebase-loc              | severity   | dimension             | finding                                                                                                                                                          | recommendation                                                                                                          | resolution                                                           |
| -------- | ------------------------ | ------------------------- | ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| code     | Phase 3 §1 (routing.ts)  | extensions/routing.ts:416 | concern    | code-quality          | In the rule+classifier merge branch, the rule-wins `else` sub-branch sets `vetoOutcome = 'classifier-wins'` even though the rule won — the field is misused.     | Add a `'rule-wins'` literal to the `vetoOutcome` union or leave `vetoOutcome` undefined when the rule wins.             | applied: left `vetoOutcome` undefined in rule-wins branch            |
| code     | Phase 3 §1 (routing.ts)  | extensions/routing.ts:404 | concern    | codebase-fit          | The merge branch sets `isClassifier = true` unconditionally, so rule-wins decisions are mislabeled as `classifier` in debug notification.                        | Set `isClassifier = true` only inside the classifier-wins sub-branch.                                                   | applied: moved `isClassifier = true` into classifier-wins sub-branch |
| code     | Phase 1 §1 (types.ts)    | extensions/types.ts:23-24 | suggestion | code-quality          | `ClassifierPromptContext.phaseBias` and `isBudgetExceeded` are declared but never read by `buildClassifierPrompt` or populated by `runClassifier` — dead schema. | Drop them now and re-add in the deferred follow-up that actually injects budget/phaseBias signals.                      | deferred: kept as forward-compatible schema for Q9 follow-up         |
| coverage | ## Verification Notes §3 | <n/a>                     | concern    | verification-coverage | Note "Don't assume tier capabilities are ordered" — no Success Criteria bullet validates capability-independence.                                                | Add a bullet to Phase 3 SC: "No assumption that high >= medium >= low for context window, image support, or reasoning." | deferred: low-risk given existing per-model resolution in config.ts  |
| coverage | ## Verification Notes §4 | <n/a>                     | concern    | verification-coverage | Note "Provider-specific continuation guards break on tier switches" — no SC bullet tests continuation under classifier-induced tier switches.                    | Add a bullet to Phase 3 SC: "Continuation guard works correctly after classifier-driven tier switch."                   | deferred: continuation guard logic unchanged by this plan            |
| coverage | ## Verification Notes §5 | <n/a>                     | suggestion | verification-coverage | Note "Budget time for a follow-up fix commit" — no SC bullet, no code mirror.                                                                                    | Add a project-management note to track follow-up fixes.                                                                 | deferred: advisory note, not a code change                           |

## Ordering Constraints

- Phase 1 (Types & State) must come first — all other phases depend on new types
- Phase 2 (Prompt Builder) must come before Phase 3 (Confidence Wiring) — `buildClassifierPrompt` is used by the modified `runClassifier`
- Phase 3 (Confidence Wiring) depends on Phase 1 types and Phase 2's extracted prompt
- Phase 4 (Calibration Recording) depends on Phase 1 types only — can run in parallel with Phase 2 and Phase 3 in theory, but sequential is safer for state consistency

## Verification Notes

- **Classifier ordering is the #1 source of bugs** (precedents `14466e2f`, `f873288a`). Every change to gate order produces 2-3 follow-up fixes. Write exhaustive order-dependent tests.
- **String sniffing is fragile** (precedent `c028bcb9`). Use structured flags, not `reasoning.includes()`.
- **Don't assume tier capabilities are ordered** (precedent `0a9fcd5b`). Context window, image support, and reasoning support are NOT guaranteed `high >= medium >= low`.
- **Provider-specific continuation guards break on tier switches** (precedent `fb79faf7`). Gemini's thought-signature continuation, Google continuation, and in-tier fallback mutation all require special-casing.
- **Budget time for a follow-up fix commit** — every classifier change triggers 2-3 follow-up fixes within 1-2 weeks.

## Performance Considerations

- `buildClassifierPrompt` is a pure string-building function — negligible overhead
- Calibration array capped at `MAX_CALIBRATION_ENTRIES = 5` — negligible memory
- History window increase from 4 to 6 adds ~2 messages of token cost per classifier call
- Always-run classifier adds one LLM round-trip per turn when `classifierModel` is configured (~500ms-5s)
- No caching or continuation fast-path (deferred to follow-up)

## Migration Notes

- All new fields are optional — old persisted states restore without changes
- `ClassifierFailureReason` extension is additive — existing code only checks `=== 'unparseable'`
- `RoutingDecision` new fields are optional booleans/strings — `sanitizeRoutingDecisionFields` handles missing values gracefully
- `RouterPersistedState.classifierCalibration` is optional — old snapshots without it restore correctly

## Pattern References

- `extensions/routing.ts:133-166` — `buildRoutingDecision`: builder function pattern to follow for `buildClassifierPrompt`
- `extensions/routing.ts:163-188` — `buildDelegationTierChain`: another builder pattern
- `extensions/types.ts:63-69` — `ClassifierResult`: type style to follow for `ClassifierPromptContext`
- `extensions/types.ts:107-119` — `RouterPersistedState.debugHistory`: array pattern to follow for `classifierCalibration`
- `extensions/state.ts:110-130` — `sanitizeRoutingDecisionFields`: optional field sanitization pattern
- `extensions/state.ts:152-183` — `buildPersistedState`: builder with array param pattern
- `extensions/state.ts:215-230` — `isRouterPersistedState`: validate-if-present pattern
- `extensions/index.ts:88-95` — `recordDebugDecision`: push-and-slice capping pattern
- `extensions/index.ts:100-114` — `persistState`: snapshot dedup pattern
- `extensions/index.ts:127-155` — `restoreStateFromSession`: array restoration pattern
- `extensions/commands.ts:429-442` — `handleFix`: calibration hook point
- `extensions/ui.ts:22-30` — `getDecisionFlags`: flag pattern to extend

## Developer Context

**Q (extensions/routing.ts:572)**: Found 2 competing approaches for improving classifier accuracy — prompt builder refactor vs confidence-aware decision logic vs structured output parser vs calibration feedback loop. Which is the priority?
**A**: Prompt builder refactor (Recommended) — extract `buildClassifierPrompt()` to inject signals heuristics already use. Linchpin for all other improvements.

**Q (extensions/routing.ts:571)**: The classifier prompt uses a hard-coded 4-message history window. Heuristics use default 6. Should we increase it?
**A**: Increase to 6 (Recommended) — match heuristic default. Low risk, small token cost increase.

**Q (extensions/routing.ts:477)**: The classifier's `confidence` field is parsed and persisted but never consumed for routing decisions. Should it be wired into decision logic?
**A**: Yes, degrade to heuristics on low confidence (Recommended) — when classifier returns `confidence: 'low'`, fall through to heuristic branch. Preserve classifier provenance via `classifierAttempted` flag.

**Step 4 Directional Confirms (2026-07-21)**:

- Extend ClassifierFailureReason: Follow (additive, no breakage)
- Add classifierAttempted + veto fields: Follow (optional provenance)
- Confidence-aware veto gate: Follow (only veto when confidence !== 'high')
- Always run classifier when configured: Follow (remove !ruleHit gate)

## References

- `.rpiv/artifacts/research/2026-07-21_19-14-23_classifier-routing-accuracy.md` — Research artifact with 10 accuracy gap findings
- `extensions/routing.ts:488-530` — `parseClassifierOutput`: fragile regex parser
- `extensions/routing.ts:540-641` — `runClassifier`: classifier invocation with fallback loop
- `extensions/routing.ts:572-600` — Inline classifier prompt template (extraction target)
- `extensions/routing.ts:336-351` — Veto gate: binary override regardless of confidence
- `extensions/routing.ts:296-314` — Budget downgrade: post-hoc override
- `extensions/provider.ts:311` — Classifier gate: `!pinnedTier && !ruleHit`
- `extensions/types.ts:70-71` — `ConfidenceLevel` and `ClassifierFailureReason`
- `extensions/types.ts:92-104` — `RoutingDecision` provenance fields
- `extensions/types.ts:107-119` — `RouterPersistedState`

## Plan History

- Phase 1: Types & State Foundation — approved as generated
- Phase 2: Prompt Builder — approved as generated
- Phase 3: Confidence Wiring — approved as generated
- Phase 4: Calibration Recording — approved as generated
