import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  ClassifierBackend,
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
import { parseCanonicalModelRef, isRouterTier, ROUTER_TIERS } from './config';
import {
  DEFAULT_STALL_TIMEOUT_MS,
  CLASSIFIER_OVERRIDE_FLOOR,
  CLASSIFIER_VETO_FLOOR,
  CLASSIFIER_DEGRADE_FLOOR,
} from './constants';
import { runTypesafeClassifier, buildTypesafeState } from './typesafe';

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

  const explicitHighHints = [
    'best',
    'deep',
    'deeply',
    'carefully',
    'thoroughly',
    'robust',
    'comprehensive',
    'step by step',
    'think hard',
    'highest quality',
    'ultrathink',
  ];
  const explicitLowHints = [
    'fast',
    'cheap',
    'quick',
    'quickly',
    'brief',
    'briefly',
    'one sentence',
    'one line',
    'tiny',
    'small',
  ];
  const planningKeywords = [
    'plan',
    'planning',
    'architecture',
    'architect',
    'design',
    'tradeoff',
    'trade-off',
    'research',
    'investigate',
    'root cause',
    'analyze',
    'analysis',
    'migration',
    'strategy',
    'compare',
    'options',
    'approach',
  ];
  const summaryKeywords = [
    'summarize',
    'summary',
    'changelog',
    'rewrite',
    'reformat',
    'format',
    'rename',
    'explain briefly',
    'recap',
    'tl;dr',
  ];
  const implementationKeywords = [
    'implement',
    'code',
    'fix',
    'update',
    'edit',
    'write',
    'refactor',
    'add tests',
    'patch',
    'change',
    'apply',
    'continue',
    'resume',
    'make the changes',
    'go ahead',
  ];
  const lookupKeywords = [
    'where is',
    'which file',
    'show me',
    'list',
    'what files',
    'find',
    'grep',
  ];

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
      // Rule + classifier both present: merge logic. Prefer the higher tier
      // when the classifier clears the override floor (numeric first; word
      // fallback keeps the chat path identical).
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      const tierRank: Record<RouterTier, number> = {
        low: 1,
        medium: 2,
        high: 3,
      };
      if (
        isHighConfidence(usableResult, CLASSIFIER_OVERRIDE_FLOOR) &&
        tierRank[usableResult.tier] > tierRank[ruleMatch.tier]
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

      if (containsAnyWord(prompt, explicitHighHints)) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Detected an explicit request for deeper or higher-quality reasoning.';
      } else if (containsAnyWord(prompt, explicitLowHints)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning =
          'Detected an explicit request for a faster or lighter response.';
      } else if (containsAnyWord(prompt, summaryKeywords)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected summary or lightweight transformation keywords.';
      } else if (
        containsAnyWord(prompt, planningKeywords) ||
        prompt.startsWith('why ') ||
        wordCount >= highThreshold ||
        multiLinePrompt
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          previousDecision?.phase === 'planning'
            ? 'Continued planning phase based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      } else if (containsAnyWord(prompt, implementationKeywords)) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected implementation-oriented work with bounded execution scope.';
      } else if (
        containsAnyWord(prompt, lookupKeywords) &&
        wordCount <= 24 &&
        toolResultCount === 0
      ) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short read-only lookup request.';
      } else if (
        previousDecision?.phase === 'planning' &&
        toolResultCount === 0 &&
        wordCount > lowThreshold
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Kept the planning-phase bias because the conversation still looks exploratory.';
      } else if (
        toolResultCount > 0 ||
        previousDecision?.phase === 'implementation' ||
        recentConversation.includes('plan:')
      ) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected active implementation work from prior tools or recent plan execution context.';
      } else if (wordCount <= lowThreshold) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short bounded request.';
      }
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
  tier?: RouterTier;
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
  const tierLine = lines.find((l) => /^tier:\s*/i.test(l));
  const confidenceLine = lines.find((l) => /^confidence:\s*/i.test(l));
  const reasoningLine = lines.find((l) => /^reasoning:\s*/i.test(l));

  if (!tierLine) {
    return {
      confidence: 'medium',
      reasoning: '',
      failureReason: 'unparseable',
    };
  }

  const tierRaw = tierLine
    .replace(/^tier:\s*/i, '')
    .trim()
    .toLowerCase();
  const tierWord = tierRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '');
  if (!isRouterTier(tierWord)) {
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

  return { tier: tierWord, confidence, reasoning, failureReason: 'success' };
};

/**
 * Stall-watchdog primitives shared by the provider turn loop (delegated
 * stream + auth) and runClassifier (classifier stream + auth).
 *
 * A wait counts as stalled when no progress arrives within `timeoutMs`.
 * Stalls throw a StallTimeoutError-named error so the existing
 * exception-driven fallback chains advance; aborts throw AbortError-named
 * errors so benign-abort classification stays intact.
 */
export const createStallTimeoutError = (
  timeoutMs: number,
  what: string,
): Error => {
  const error = new Error(
    `${what} stalled after ${timeoutMs}ms with no progress`,
  );
  error.name = 'StallTimeoutError';
  return error;
};

export const isStallTimeoutError = (
  error: unknown,
): error is Error =>
  error instanceof Error && error.name === 'StallTimeoutError';

/**
 * Race `promise` against an inactivity timer and an abort signal.
 * Losing branches clear the timer and detach the listener, so an
 * abandoned promise never produces an unhandled rejection (safe for
 * total functions like ModelRegistry.getApiKeyAndHeaders).
 */
export const raceStallTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  what = 'Operation',
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(createStallTimeoutError(timeoutMs, what));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (reason) => {
        cleanup();
        reject(reason);
      },
    );
  });
};

/**
 * Wrap an async iterable with a per-event inactivity watchdog.
 * Every yielded event resets the timer; silence for `timeoutMs` invokes
 * `onStall` (cancel the underlying transport) and then throws
 * StallTimeoutError. Abort of `signal` throws an AbortError-named error.
 */
export const stallGuardedStream = async function* <T>(
  stream: AsyncIterable<T>,
  timeoutMs: number,
  onStall?: () => void,
  signal?: AbortSignal,
  what = 'Stream',
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    let result: IteratorResult<T>;
    try {
      result = await raceStallTimeout(
        iterator.next(),
        timeoutMs,
        signal,
        what,
      );
    } catch (error) {
      if (isStallTimeoutError(error)) onStall?.();
      throw error;
    }
    if (result.done) return result.value;
    yield result.value;
  }
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
        return undefined;
      }

      return {
        tier: parsed.tier!,
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
      void error;
    } finally {
      signal?.removeEventListener('abort', propagateRefAbort);
    }
  }
  return undefined;
};
