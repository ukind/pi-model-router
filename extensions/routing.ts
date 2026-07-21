import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
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
import { parseCanonicalModelRef, isRouterTier, ROUTER_TIERS } from './config';

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
    if (ruleMatch && classifierResult) {
      // Rule + classifier both present: merge logic
      // Prefer higher tier when classifier confidence is 'high'
      // Trust the rule when classifier confidence is 'low'
      classifierAttempted = true;
      classifierTier = classifierResult.tier;
      const tierRank: Record<RouterTier, number> = {
        low: 1,
        medium: 2,
        high: 3,
      };
      if (
        classifierResult.confidence === 'high' &&
        tierRank[classifierResult.tier] > tierRank[ruleMatch.tier]
      ) {
        isClassifier = true;
        tier = classifierResult.tier;
        phase = previousDecision?.phase ?? phaseForTier(tier);
        reasoning = `Classifier: ${classifierResult.reasoning} (merged: classifier high-confidence preferred over rule)`;
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
    } else if (classifierResult) {
      classifierAttempted = true;
      classifierTier = classifierResult.tier;

      // Low confidence: degrade to heuristic branch
      if (classifierResult.confidence === 'low') {
        // Fall through to heuristic branch below
        // classifierAttempted = true for provenance
        // isClassifier stays false — heuristic branch runs
      } else {
        isClassifier = true;
        let candidateTier = classifierResult.tier;

        // Confidence-aware veto: only override when confidence !== 'high'
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
    decision.confidence = classifierResult.confidence;
    decision.rawText = classifierResult.rawText;
    decision.failureReason = classifierResult.failureReason;
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

export const runClassifier = async (
  refs: string[],
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  hasImage?: boolean,
): Promise<ClassifierResult | undefined> => {
  for (const ref of refs) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(ref);
      const model = modelRegistry.find(provider, modelId);
      if (!model) continue;

      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) continue;
      const apiKey = auth.apiKey;
      const headers = auth.headers;

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
        ...(reasoningOption ? { reasoning: reasoningOption } : {}),
      });
      let fullText = '';
      let contentReceived = false;
      for await (const event of stream) {
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
      // ponytail: infra failure (invalid ref / auth reject / stream threw) — try next ref
      void error;
    }
  }
  return undefined;
};
