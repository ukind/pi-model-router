import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  ClassifierBackend,
  RouterTier,
  RouterPhase,
  RouterProfile,
  RouterWorkType,
  RoutingDecision,
  RoutingRule,
  RouterThinkingByTier,
  ClassifierResult,
  ClassifierFailureReason,
  ConfidenceLevel,
  ClassifierPromptContext,
} from './types';
import {
  parseCanonicalModelRef,
  isRouterWorkType,
  ROUTER_TIERS,
  WORK_TYPE_TO_TIER,
} from './config';
import {
  DEFAULT_STALL_TIMEOUT_MS,
  CLASSIFIER_OVERRIDE_FLOOR,
  CLASSIFIER_VETO_FLOOR,
  CLASSIFIER_DEGRADE_FLOOR,
} from './constants';
import { runTypesafeClassifier, buildTypesafeState } from './typesafe';
import {
  raceStallTimeout,
  stallGuardedStream,
  isStallTimeoutError,
  createStallTimeoutError,
} from './watchdog';
import {
  explicitHighHints,
  explicitLowHints,
  planningKeywords,
  summaryKeywords,
  implementationKeywords,
  lookupKeywords,
} from './keywords';

// F004 re-export: provider.ts, provider.test.ts, and routing.test.ts import
// the watchdog primitives from './routing'; keep the surface stable.
export {
  raceStallTimeout,
  stallGuardedStream,
  isStallTimeoutError,
  createStallTimeoutError,
} from './watchdog';

export const extractTextFromContent = (
  content: string | Message['content'],
): string => {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.thinking;
      if (part.type === 'toolCall')
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role === 'user') {
      return extractTextFromContent(message.content).trim();
    }
  }
  return '';
};

export const getRecentConversationText = (
  context: Context,
  limit = 6,
): string => {
  return context.messages
    .slice(-limit)
    .map((message) => extractTextFromContent(message.content).trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
};

export const countToolResults = (context: Context): number => {
  return context.messages.filter((message) => message.role === 'toolResult')
    .length;
};

export const countWords = (text: string): number => {
  return text.split(/\s+/).filter(Boolean).length;
};

export const hasImageAttachment = (context: Context): boolean => {
  return context.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
};

// ponytail: module-level cache avoids recompiling regex per call
const wordBoundaryRegexCache = new Map<string, RegExp>();

const wordBoundaryRegex = (keyword: string): RegExp => {
  let r = wordBoundaryRegexCache.get(keyword);
  if (!r) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    r = new RegExp(`\\b${escaped}\\b`, 'i');
    wordBoundaryRegexCache.set(keyword, r);
  }
  return r;
};

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

export const phaseForTier = (tier: RouterTier): RouterPhase => {
  if (tier === 'high') return 'planning';
  if (tier === 'medium') return 'implementation';
  return 'lightweight';
};

/**
 * Build the delegation fallback tier chain for runtime model delegation.
 * Non-budget: preferred → down → nearest-up (down-then-nearest-up).
 * Budget: preferred → down only (respect the cap, no upward escape).
 */
export const buildDelegationTierChain = (
  startTier: RouterTier,
  isBudgetExceeded: boolean,
): RouterTier[] => {
  const downOrder: RouterTier[] = ['high', 'medium', 'low'];
  const startIdx = downOrder.indexOf(startTier);
  const downChain = downOrder.slice(startIdx);
  if (isBudgetExceeded) return downChain;
  const upChain = downOrder.slice(0, startIdx).reverse();
  return [...downChain, ...upChain];
};

export const resolveAvailableTier = (
  profile: RouterProfile,
  preferred: RouterTier,
  preferDown = false,
): RouterTier => {
  if (profile[preferred]) return preferred;
  const order: RouterTier[] = ['low', 'medium', 'high'];
  const startIdx = order.indexOf(preferred);
  if (preferDown) {
    // Budget path: try lower tiers first to respect the cap
    for (let i = startIdx - 1; i >= 0; i--) {
      if (profile[order[i]]) return order[i];
    }
    // Last resort: fall up (e.g. high-only profile)
    for (let i = startIdx + 1; i < order.length; i++) {
      if (profile[order[i]]) return order[i];
    }
  } else {
    // Normal path: fall up first
    for (let i = startIdx + 1; i < order.length; i++) {
      if (profile[order[i]]) return order[i];
    }
    for (let i = startIdx - 1; i >= 0; i--) {
      if (profile[order[i]]) return order[i];
    }
  }
  return preferred; // unreachable if profile has ≥1 tier
};

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  phase: RouterPhase,
  reasoning: string,
  thinkingOverrides?: RouterThinkingByTier,
  isClassifier?: boolean,
): RoutingDecision => {
  const routed = profile[tier];
  if (!routed) {
    throw new Error(
      `Profile "${profileName}" has no configuration for the ${tier} tier.`,
    );
  }
  const { provider, modelId } = parseCanonicalModelRef(routed.model);
  const baseThinking =
    routed.thinking ??
    (tier === 'high' ? 'high' : tier === 'low' ? 'low' : 'medium');
  const effectiveThinking = thinkingOverrides?.[tier] ?? baseThinking;

  return {
    profile: profileName,
    tier,
    phase,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: routed.model,
    reasoning,
    thinking: effectiveThinking,
    timestamp: Date.now(),
    isClassifier,
  };
};

/**
 * Build the classifier prompt string from a context-bundle object.
 * Pure function — no I/O, no side effects.
 */
export const buildClassifierPrompt = (ctx: ClassifierPromptContext): string => {
  const lines: string[] = [
    'You are a model router classifier. Your job is to categorize the user\'s latest request into one of four work types: "planning", "implementation", "summary", or "lookup".',
    '',
    'Work types:',
    '- planning: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.',
    '- implementation: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.',
    '- summary: Summaries, changelogs, formatting, quick explanations, small bounded text transforms.',
    '- lookup: Read-only lookups that locate information and add no new text beyond it.',
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
      'Note: The user has attached an image. Bias toward "planning" or "implementation" as the models for "summary" and "lookup" may not support vision capabilities.',
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
  lines.push('Work type: [planning|implementation|summary|lookup]');
  lines.push('Confidence: [high|medium|low]');
  lines.push('Reasoning: [one short sentence]');
  lines.push('');

  if (ctx.currentPhase === 'planning') {
    lines.push(
      'Consider that the conversation is currently in a planning phase. Bias toward "planning" unless the request is clearly a simple implementation or summary.',
    );
  }
  if (ctx.currentPhase === 'implementation') {
    lines.push(
      'Consider that the conversation is currently in an implementation phase. Bias toward "implementation" unless the request is clearly planning or a simple summary.',
    );
  }

  return lines.join('\n');
};

/**
 * Assemble the classifier prompt context from a conversation. Pure — no I/O.
 * Shared by the chat backend and the TypeSafe backend.
 */
export const buildClassifierPromptContext = (
  context: Context,
  currentPhase?: RouterPhase,
  hasImage?: boolean,
): ClassifierPromptContext => {
  const promptText = getLastUserText(context);
  return {
    promptText,
    historyText: getRecentConversationText(context, 6),
    toolResultCount: countToolResults(context),
    wordCount: countWords(promptText),
    multiLinePrompt: promptText.split('\n').length >= 4,
    currentPhase,
    hasImage,
  };
};

export const matchHighestTierRule = (
  prompt: string,
  rules: RoutingRule[] | undefined,
): { tier: RouterTier; reasoning: string } | undefined => {
  if (!rules) return undefined;
  const tierRank: Record<RouterTier, number> = { low: 1, medium: 2, high: 3 };
  let best: { tier: RouterTier; reasoning: string } | undefined;
  for (const rule of rules) {
    const matches = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
    const lowercaseMatches = matches.map((m) => m.toLowerCase());
    if (containsAnyWord(prompt, lowercaseMatches)) {
      if (!best || tierRank[rule.tier] > tierRank[best.tier]) {
        best = {
          tier: rule.tier,
          reasoning:
            rule.reason ??
            `Matched custom routing rule for: ${matches.join(', ')}`,
        };
      }
    }
  }
  return best;
};

/**
 * A classifier result is usable when it succeeded and carries a tier.
 * Failure-carrying results (ran but unusable / transport failure) are not.
 */
export const isUsableClassifierResult = (
  result: ClassifierResult | undefined,
): result is ClassifierResult & { tier: RouterTier } =>
  result !== undefined &&
  result.failureReason === 'success' &&
  result.tier !== undefined;

/**
 * True when the result clears a high-stakes floor (rule override, veto
 * suppression). Reads the numeric confidence first; falls back to the word
 * bucket so the chat path (words only) is unchanged.
 */
export const isHighConfidence = (
  result: ClassifierResult,
  floor: number,
): boolean =>
  result.confidenceNumeric !== undefined
    ? result.confidenceNumeric >= floor
    : result.confidence === 'high';

/**
 * True when the result falls below the degrade floor and the classifier
 * answer must not be used. Numeric first; word fallback ('low') for chat.
 */
export const isLowConfidence = (result: ClassifierResult): boolean =>
  result.confidenceNumeric !== undefined
    ? result.confidenceNumeric < CLASSIFIER_DEGRADE_FLOOR
    : result.confidence === 'low';

/**
 * Heuristic work-type classification (F004 extraction). Keyword arms only
 * (hints preempt, summary beats planning); complexity signals are nudges,
 * not classify arms. Every non-unknown arm pairs its work type with the
 * HEAD reasoning string, so outcomes stay identical for identical inputs.
 * Pure — no I/O, no side effects.
 */
export const classifyByHeuristics = (args: {
  prompt: string;
  wordCount: number;
  multiLinePrompt: boolean;
  toolResultCount: number;
  recentConversation: string;
  previousDecision: RoutingDecision | undefined;
  phaseBias: number;
}): { workType: RouterWorkType; reasoning: string } => {
  const {
    prompt,
    wordCount,
    multiLinePrompt,
    toolResultCount,
    recentConversation,
    previousDecision,
    phaseBias,
  } = args;

  const highThreshold = Math.max(
    40,
    120 - (previousDecision?.phase === 'planning' ? phaseBias * 80 : 0),
  );
  const lowThreshold = Math.max(
    4,
    12 -
      (previousDecision?.phase === 'implementation' ||
      previousDecision?.phase === 'planning'
        ? phaseBias * 8
        : 0),
  );

  let workType: RouterWorkType = 'unknown';
  let reasoning = 'Defaulted to medium tier for general coding work.';

  if (containsAnyWord(prompt, explicitHighHints)) {
    workType = 'planning';
    reasoning =
      'Detected an explicit request for deeper or higher-quality reasoning.';
  } else if (containsAnyWord(prompt, explicitLowHints)) {
    workType = 'summary';
    reasoning =
      'Detected an explicit request for a faster or lighter response.';
  } else if (containsAnyWord(prompt, summaryKeywords)) {
    workType = 'summary';
    reasoning = 'Detected summary or lightweight transformation keywords.';
  } else if (
    containsAnyWord(prompt, planningKeywords) ||
    prompt.startsWith('why ')
  ) {
    workType = 'planning';
    reasoning =
      previousDecision?.phase === 'planning'
        ? 'Continued planning phase based on complexity or keywords.'
        : 'Detected planning, broad analysis, or a high-complexity request.';
  } else if (containsAnyWord(prompt, implementationKeywords)) {
    workType = 'implementation';
    reasoning =
      'Detected implementation-oriented work with bounded execution scope.';
  } else if (
    containsAnyWord(prompt, lookupKeywords) &&
    wordCount <= 24 &&
    toolResultCount === 0
  ) {
    workType = 'lookup';
    reasoning = 'Detected a short read-only lookup request.';
  }

  // Complexity nudge (the raise): a long or multi-line turn raises every
  // classification except summary and planning.
  if (
    (wordCount >= highThreshold || multiLinePrompt) &&
    workType !== 'summary' &&
    workType !== 'planning'
  ) {
    workType = 'planning';
    reasoning =
      previousDecision?.phase === 'planning'
        ? 'Continued planning phase based on complexity or keywords.'
        : 'Detected planning, broad analysis, or a high-complexity request.';
  }

  // Unknown-only nudges, in HEAD order: phase bias, then tool/plan context,
  // then shortness. These never displace a keyword classification.
  if (workType === 'unknown') {
    if (
      previousDecision?.phase === 'planning' &&
      toolResultCount === 0 &&
      wordCount > lowThreshold
    ) {
      workType = 'planning';
      reasoning =
        'Kept the planning-phase bias because the conversation still looks exploratory.';
    } else if (
      toolResultCount > 0 ||
      previousDecision?.phase === 'implementation' ||
      recentConversation.includes('plan:')
    ) {
      workType = 'implementation';
      reasoning =
        'Detected active implementation work from prior tools or recent plan execution context.';
    } else if (wordCount <= lowThreshold) {
      workType = 'summary';
      reasoning = 'Detected a short bounded request.';
    }
  }

  return { workType, reasoning };
};

export const decideRouting = (
  context: Context,
  profileName: string,
  profile: RouterProfile,
  previousDecision: RoutingDecision | undefined,
  pinnedTier?: RouterTier,
  thinkingOverrides?: RouterThinkingByTier,
  phaseBias = 0.5,
  rules?: RoutingRule[],
  isBudgetExceeded = false,
  classifierResult?: ClassifierResult,
  ruleHit?: { tier: RouterTier; reasoning: string },
): RoutingDecision => {
  const prompt = getLastUserText(context).toLowerCase();
  const recentConversation = getRecentConversationText(context);
  const toolResultCount = countToolResults(context);
  const wordCount = countWords(prompt);
  const multiLinePrompt = prompt.split('\n').length >= 4;

  let phase: RouterPhase = previousDecision?.phase ?? 'implementation';
  let tier: RouterTier = 'medium';
  let reasoning = 'Defaulted to medium tier for general coding work.';
  let isRuleMatched = false;
  let isClassifier = false;
  let isVetoed = false;
  let isPinned = false;
  let vetoReason: 'explicit-hint' | undefined;
  let classifierAttempted = false;
  let classifierTier: RouterTier | undefined;
  let classifierCriterion: RouterWorkType | undefined;
  let vetoOutcome: 'classifier-wins' | 'veto-wins' | undefined;
  let vetoDisagreementMagnitude: number | undefined;

  if (pinnedTier) {
    phase = phaseForTier(pinnedTier);
    tier = pinnedTier;
    reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
    isPinned = true;
  } else {
    const ruleMatch = ruleHit ?? matchHighestTierRule(prompt, rules);
    const usableResult = isUsableClassifierResult(classifierResult)
      ? classifierResult
      : undefined;
    if (ruleMatch && usableResult) {
      // Rule + classifier both present: merge logic. The classifier
      // displaces the rule when its certainty clears the override floor
      // (numeric first; word fallback keeps the chat path identical) and
      // its mapped tier differs from the rule's tier — above or below (FR4).
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      classifierCriterion = usableResult.workType;
      if (
        isHighConfidence(usableResult, CLASSIFIER_OVERRIDE_FLOOR) &&
        usableResult.tier !== ruleMatch.tier
      ) {
        isClassifier = true;
        tier = usableResult.tier;
        phase = previousDecision?.phase ?? phaseForTier(tier);
        reasoning = `Classifier: ${usableResult.reasoning} (merged: classifier high-confidence preferred over rule)`;
        vetoOutcome = 'classifier-wins';
      } else {
        tier = ruleMatch.tier;
        phase = phaseForTier(tier);
        reasoning = ruleMatch.reasoning;
        isRuleMatched = true;
        // vetoOutcome left undefined — rule won, no veto occurred
      }
    } else if (ruleMatch) {
      tier = ruleMatch.tier;
      phase = phaseForTier(tier);
      reasoning = ruleMatch.reasoning;
      isRuleMatched = true;
      // A failure-carrying classifier result still ran — keep it visible.
      if (classifierResult) classifierAttempted = true;
    } else if (usableResult) {
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      classifierCriterion = usableResult.workType;

      // Low confidence: degrade to heuristic branch
      if (isLowConfidence(usableResult)) {
        // Fall through to heuristic branch below.
        // classifierAttempted stays true for provenance;
        // isClassifier stays false — heuristic branch runs.
      } else {
        isClassifier = true;
        let candidateTier = usableResult.tier;

        // Confidence-aware veto: only override when confidence is below the
        // veto floor (numeric first; word fallback keeps chat identical).
        const promptHasHighHint = containsAnyWord(prompt, explicitHighHints);
        const promptHasLowHint = containsAnyWord(prompt, explicitLowHints);
        if (
          promptHasHighHint &&
          candidateTier !== 'high' &&
          !isHighConfidence(usableResult, CLASSIFIER_VETO_FLOOR)
        ) {
          candidateTier = 'high';
          isVetoed = true;
          vetoReason = 'explicit-hint';
        } else if (
          promptHasLowHint &&
          candidateTier !== 'low' &&
          !isHighConfidence(usableResult, CLASSIFIER_VETO_FLOOR)
        ) {
          candidateTier = 'low';
          isVetoed = true;
          vetoReason = 'explicit-hint';
        }

        tier = candidateTier;
        phase = previousDecision?.phase ?? phaseForTier(tier);
        reasoning = isVetoed
          ? `Classifier: ${usableResult.reasoning} (vetoed: explicit-hint forced ${tier})`
          : `Classifier: ${usableResult.reasoning}`;

        if (isVetoed) {
          vetoOutcome = 'veto-wins';
          vetoDisagreementMagnitude = Math.abs(
            ROUTER_TIERS.indexOf(usableResult.tier) -
              ROUTER_TIERS.indexOf(candidateTier),
          );
        } else {
          vetoOutcome = 'classifier-wins';
        }
      }
    } else if (classifierResult) {
      // Classifier ran but its answer was unusable (json-invalid /
      // infra-failure): visible fallback to heuristics. The reason threads
      // through the provenance block below.
      classifierAttempted = true;
    }

    if (!isClassifier && !ruleMatch && !pinnedTier) {
      // Heuristic branch (also reached on low-confidence degrade)
      const heuristic = classifyByHeuristics({
        prompt,
        wordCount,
        multiLinePrompt,
        toolResultCount,
        recentConversation,
        previousDecision,
        phaseBias,
      });

      // Step 4 — convert through the shared map and apply (FR8). The
      // 'unknown' path keeps tier medium, the previous phase, and the
      // default reasoning (FR1).
      if (heuristic.workType !== 'unknown') {
        tier = WORK_TYPE_TO_TIER[heuristic.workType];
        phase = phaseForTier(tier);
      }
      reasoning = heuristic.reasoning;
    }
  }

  let isBudgetForced = false;
  if (isBudgetExceeded && tier === 'high') {
    tier = 'medium';
    phase = 'implementation';
    reasoning = `Budget exceeded. Downgraded from high to medium tier. (Original: ${reasoning})`;
    isBudgetForced = true;
  } else if (isBudgetExceeded && tier === 'medium') {
    tier = 'low';
    phase = 'lightweight';
    reasoning = `Budget exceeded. Downgraded from medium to low tier. (Original: ${reasoning})`;
    isBudgetForced = true;
  } else if (isBudgetExceeded && tier === 'low') {
    // Q3: floor case — cannot downgrade further; still mark budget-forced
    // so consumers (notify, widget) surface the exceeded-budget signal.
    // tier + phase stay as the heuristic picked them; reasoning is the
    // floor-warning variant (no "Downgraded" claim since no downgrade
    // happened).
    reasoning = `Budget exceeded; already at lowest tier — no further downgrade possible. (Original: ${reasoning})`;
    isBudgetForced = true;
  }

  // [Slice 1] passes isBudgetExceeded for preferDown
  const resolvedTier = resolveAvailableTier(profile, tier, isBudgetExceeded);
  if (resolvedTier !== tier) {
    reasoning = `Resolved from ${tier} to ${resolvedTier} tier (${tier} tier is not configured). Original: ${reasoning}`;
    phase = phaseForTier(resolvedTier);
    tier = resolvedTier;
  }

  const decision = buildRoutingDecision(
    profileName,
    profile,
    tier,
    phase,
    reasoning,
    thinkingOverrides,
    isClassifier,
  );
  decision.isRuleMatched = isRuleMatched;
  decision.isPinned = isPinned;
  decision.isBudgetForced = isBudgetForced;
  decision.classifierAttempted = classifierAttempted;
  if (classifierTier) {
    decision.classifierTier = classifierTier;
  }
  if (classifierCriterion) {
    decision.classifierCriterion = classifierCriterion;
  }
  if (vetoOutcome) {
    decision.vetoOutcome = vetoOutcome;
  }
  if (vetoDisagreementMagnitude !== undefined) {
    decision.vetoDisagreementMagnitude = vetoDisagreementMagnitude;
  }
  // Thread classifier provenance when classifier was the source
  if (classifierResult) {
    if (classifierResult.confidence) {
      decision.confidence = classifierResult.confidence;
    }
    if (classifierResult.rawText) {
      decision.rawText = classifierResult.rawText;
    }
    decision.failureReason = classifierResult.failureReason;
    if (classifierResult.confidenceNumeric !== undefined) {
      decision.confidenceNumeric = classifierResult.confidenceNumeric;
    }
    if (isVetoed) {
      decision.isVetoed = true;
      decision.vetoReason = vetoReason;
    }
  }
  return decision;
};

export const parseClassifierOutput = (
  rawText: string,
): {
  workType?: RouterWorkType;
  confidence: ConfidenceLevel;
  reasoning: string;
  failureReason: ClassifierFailureReason;
} => {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const stripMarkdown = (line: string): string =>
    line
      .replace(/^[\s*#>`]*/, '')
      .replace(/[*`]/g, '')
      .trim();

  const lines = normalized.split('\n').map(stripMarkdown);
  const workTypeLine = lines.find((l) => /^work type:\s*/i.test(l));
  const confidenceLine = lines.find((l) => /^confidence:\s*/i.test(l));
  const reasoningLine = lines.find((l) => /^reasoning:\s*/i.test(l));

  if (!workTypeLine) {
    return {
      confidence: 'medium',
      reasoning: '',
      failureReason: 'unparseable',
    };
  }

  const workTypeRaw = workTypeLine
    .replace(/^work type:\s*/i, '')
    .trim()
    .toLowerCase();
  const workTypeWord = workTypeRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '');
  if (!isRouterWorkType(workTypeWord)) {
    return {
      confidence: 'medium',
      reasoning: '',
      failureReason: 'unparseable',
    };
  }

  let confidence: ConfidenceLevel = 'medium';
  if (confidenceLine) {
    const confRaw = confidenceLine
      .replace(/^confidence:\s*/i, '')
      .trim()
      .toLowerCase();
    const confWord = confRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '');
    if (confWord === 'high' || confWord === 'medium' || confWord === 'low') {
      confidence = confWord;
    }
  }

  let reasoning = 'Classifier decision.';
  if (reasoningLine) {
    const reasoningText = reasoningLine.replace(/^reasoning:\s*/i, '');
    if (reasoningText.trim()) reasoning = reasoningText.trim();
  }

  return {
    workType: workTypeWord,
    confidence,
    reasoning,
    failureReason: 'success',
  };
};

export const runClassifier = async (
  refs: string[],
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  hasImage?: boolean,
  signal?: AbortSignal,
  stallTimeoutMs?: number,
  onStall?: (ref: string, ms: number) => void,
  backend: ClassifierBackend = 'chat',
): Promise<ClassifierResult | undefined> => {
  const timeoutMs = stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  // TypeSafe (Jev) backend: one structured POST, no chat stream, no registry.
  // The state carries Jev-native conversation content; instructions live in
  // the questions.
  if (backend === 'typesafe') {
    return runTypesafeClassifier(refs, {
      state: buildTypesafeState(
        buildClassifierPromptContext(context, currentPhase, hasImage),
      ),
      signal,
      timeoutMs,
      onStall,
    });
  }

  for (const ref of refs) {
    if (signal?.aborted) {
      return undefined;
    }

    // Per-ref kill switch: run-abort propagation + stall abort (same manual
    // composition as the delegated path). Declared BEFORE the try so the
    // sibling finally can detach the listener (try-scoped consts are not
    // visible in finally).
    const refAbort = new AbortController();
    const propagateRefAbort = () => refAbort.abort(signal?.reason);
    if (signal?.aborted) {
      refAbort.abort();
    } else if (signal) {
      signal.addEventListener('abort', propagateRefAbort, { once: true });
    }
    try {
      const { provider, modelId } = parseCanonicalModelRef(ref);
      const model = modelRegistry.find(provider, modelId);
      if (!model) continue;

      const auth = await raceStallTimeout(
        modelRegistry.getApiKeyAndHeaders(model),
        timeoutMs,
        signal,
        `classifier auth for ${ref}`,
      );
      if (!auth.ok || !auth.apiKey) continue;
      const apiKey = auth.apiKey;
      const headers = auth.headers;

      const classifierCtx = buildClassifierPromptContext(
        context,
        currentPhase,
        hasImage,
      );
      const classifierPrompt = buildClassifierPrompt(classifierCtx);

      const classifierContext: Context = {
        ...context,
        messages: [
          { role: 'user', content: classifierPrompt, timestamp: Date.now() },
        ],
      };

      const reasoningOption =
        model.reasoning && thinking && thinking !== 'off'
          ? thinking
          : undefined;

      const stream = streamSimple(model, classifierContext, {
        apiKey,
        headers,
        signal: refAbort.signal,
        ...(reasoningOption ? { reasoning: reasoningOption } : {}),
      });
      let fullText = '';
      let contentReceived = false;
      for await (const event of stallGuardedStream(
        stream,
        timeoutMs,
        () => refAbort.abort(),
        refAbort.signal,
        `classifier ${ref}`,
      )) {
        if (event.type === 'error' && !contentReceived) {
          break;
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          if (event.type === 'text_delta') fullText += event.delta;
          contentReceived = true;
        }
      }

      if (!contentReceived) continue;

      const parsed = parseClassifierOutput(fullText);
      if (parsed.failureReason === 'unparseable') {
        // F005: propagate the failure-carrying result. decideRouting's
        // `else if (classifierResult)` branch marks classifierAttempted and
        // threads failureReason into the decision provenance, so the
        // fallback to heuristics stays visible instead of silently
        // pretending the classifier never ran. isUsableClassifierResult
        // gates on failureReason === 'success', so no other consumer
        // changes.
        return {
          reasoning: parsed.reasoning,
          rawText: fullText,
          failureReason: 'unparseable',
        };
      }

      const workType = parsed.workType!;
      return {
        tier: WORK_TYPE_TO_TIER[workType],
        workType,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        rawText: fullText,
        failureReason: 'success',
      };
    } catch (error) {
      // Infra failure (invalid ref / auth reject / stall / stream threw) —
      // try next ref. Stall additionally notifies via the caller's callback.
      if (isStallTimeoutError(error)) {
        onStall?.(ref, timeoutMs);
      }
    } finally {
      signal?.removeEventListener('abort', propagateRefAbort);
    }
  }
  return undefined;
};
