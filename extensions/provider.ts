import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Message,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RoutingDecision,
  RouterTier,
  RouterPinByProfile,
  RouterThinkingByProfile,
  ClassifierResult,
} from './types';
import {
  profileNames,
  parseCanonicalModelRef,
  ROUTER_TIERS,
  resolveContextWindow,
  resolveMaxTokens,
  collectProfileThinkingLevels,
} from './config';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';
import {
  phaseForTier,
  buildRoutingDecision,
  buildDelegationTierChain,
  decideRouting,
  runClassifier,
  matchHighestTierRule,
  extractTextFromContent,
  hasImageAttachment,
  getLastUserText,
} from './routing';

export const createErrorMessage = (
  model: Model<Api>,
  message: string,
): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
};

/**
 * Heuristic token estimator (conservative: 3 characters per token)
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

/**
 * Truncate context to fit within a target token limit by removing oldest messages.
 * Always preserves the first system message and the latest user message.
 */
const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const getSystemTokens = () =>
    context.systemPrompt ? estimateTokens(context.systemPrompt) : 0;

  // Initial estimate
  const totalTokens =
    getSystemTokens() +
    messages.reduce(
      (sum, m) => sum + estimateTokens(extractTextFromContent(m.content)),
      0,
    );
  if (totalTokens <= limit) return context;

  const latestMessage = messages.pop();
  if (!latestMessage) return context;

  // Collect toolCallIds from a message's content (assistant toolCall parts).
  const extractToolCallIds = (msg: Message): string[] => {
    if (!Array.isArray(msg.content)) return [];
    return msg.content
      .filter((p) => p.type === 'toolCall' && 'id' in p && p.id)
      .map((p) => (p as { id: string }).id);
  };

  // Remove oldest until it fits, preserving toolCall/toolResult pairs.
  while (messages.length > 0) {
    const currentTokens =
      getSystemTokens() +
      estimateTokens(extractTextFromContent(latestMessage.content)) +
      messages.reduce(
        (sum, m) => sum + estimateTokens(extractTextFromContent(m.content)),
        0,
      );

    if (currentTokens <= limit) break;

    const evicted = messages.shift();
    if (evicted) {
      const toolCallIds = new Set(extractToolCallIds(evicted));
      if (toolCallIds.size > 0) {
        // Remove linked toolResult messages so pairs stay together.
        for (let j = messages.length - 1; j >= 0; j--) {
          const msg = messages[j];
          if (
            msg.role === 'toolResult' &&
            'toolCallId' in msg &&
            toolCallIds.has((msg as { toolCallId: string }).toolCallId)
          ) {
            messages.splice(j, 1);
          }
        }
      }
    }
  }

  const finalMessages: Message[] = [...messages, latestMessage];

  return { ...context, messages: finalMessages };
};

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig) continue;
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      if (modelRegistry.find(provider, modelId)?.reasoning) {
        return true;
      }
    } catch (_error) {
      // ignore invalid model refs here; config normalization handles warnings
    }
  }

  return false;
};

export const registerRouterProvider = (
  pi: ExtensionAPI,
  state: {
    lastRegisteredModels: string;
    readonly currentConfig: RouterConfig;
    readonly currentModelRegistry:
      | ExtensionContext['modelRegistry']
      | undefined;
    readonly lastExtensionContext: ExtensionContext | undefined;
    selectedProfile: string | undefined;
    routerEnabled: boolean;
    lastDecision: RoutingDecision | undefined;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly pinnedTierByProfile: RouterPinByProfile;
    accumulatedCost: number;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    getThinkingOverride: (
      profileName: string,
      tier: RouterTier,
    ) => ThinkingLevel | undefined;
    updateStatus: (ctx: ExtensionContext) => void;
    syncPiThinkingLevel: (level: ThinkingLevel) => void;
  },
) => {
  const profileList = profileNames(state.currentConfig);

  // Map profiles to their capacities
  const modelDefinitions = profileList.map((name) => {
    const profile = state.currentConfig.profiles[name];

    // Report the MAX context window and max output tokens across all tiers.
    // The honesty check + truncateContext handles the case where the
    // actually routed model is smaller.
    let maxContextWindow = DEFAULT_CONTEXT_WINDOW;
    let maxMaxTokens = DEFAULT_MAX_TOKENS;
    for (const tier of ROUTER_TIERS) {
      if (!profile[tier]) continue;
      const cw = resolveContextWindow(
        tier,
        profile,
        state.currentModelRegistry,
      );
      const mot = resolveMaxTokens(tier, profile, state.currentModelRegistry);
      if (cw > maxContextWindow) maxContextWindow = cw;
      if (mot > maxMaxTokens) maxMaxTokens = mot;
    }

    const hasReasoning = supportsReasoning(profile, state.currentModelRegistry);
    const profileLevels = collectProfileThinkingLevels(profile);
    // Build thinkingLevelMap from the union of all tier models' declared levels.
    // Only needed if xhigh is in the set (pi supports all others by default).
    const thinkingLevelMap: Record<string, string> | undefined =
      hasReasoning && profileLevels.has('xhigh')
        ? { xhigh: 'xhigh' }
        : undefined;

    // Honest image advertisement: union of tier model capabilities.
    const profileSupportsImages = (
      p: RouterConfig['profiles'][string],
      registry: ExtensionContext['modelRegistry'] | undefined,
    ): boolean => {
      // ponytail: no registry = advertise images (existing behavior, avoids
      // breaking registration before session_start).
      if (!registry) return true;
      for (const tier of ROUTER_TIERS) {
        if (!p[tier]) continue;
        const candidates = [p[tier]!.model, ...(p[tier]!.fallbacks ?? [])];
        for (const ref of candidates) {
          try {
            const { provider: pp, modelId: mm } = parseCanonicalModelRef(ref);
            if (registry.find(pp, mm)?.input?.includes('image')) return true;
          } catch {
            /* skip invalid */
          }
        }
      }
      return false;
    };
    const supportsImages = profileSupportsImages(
      profile,
      state.currentModelRegistry,
    );

    return {
      id: name,
      name: `Router ${name}`,
      reasoning: hasReasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: supportsImages
        ? (['text', 'image'] as ('text' | 'image')[])
        : (['text'] as ('text' | 'image')[]),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: maxContextWindow,
      maxTokens: maxMaxTokens,
    };
  });

  const modelsKey = modelDefinitions
    .map(
      (m) =>
        `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.reasoning}:${m.input.join('|')}`,
    )
    .join(',');
  if (state.lastRegisteredModels === modelsKey) return;

  pi.registerProvider('router', {
    baseUrl: 'router://local',
    apiKey: 'pi-model-router',
    api: 'router-local-api',
    models: modelDefinitions,
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      const stream = createAssistantMessageEventStream();

      (async () => {
        try {
          if (!state.currentModelRegistry) {
            throw new Error(
              'Router provider not initialized yet. Wait for session_start and retry.',
            );
          }
          const profile = state.currentConfig.profiles[model.id];
          if (!profile) {
            throw new Error(`Unknown router profile: ${model.id}`);
          }

          state.selectedProfile = model.id;
          state.routerEnabled = true;

          const pinnedTier = state.pinnedTierByProfile[model.id];
          const isBudgetExceeded =
            state.currentConfig.maxSessionBudget !== undefined &&
            state.accumulatedCost >= state.currentConfig.maxSessionBudget;

          // Pre-decision: gate classifier on no pin AND no rule match
          const prompt = getLastUserText(context).toLowerCase();
          const ruleHit = !pinnedTier
            ? matchHighestTierRule(prompt, state.currentConfig.rules)
            : undefined;

          let classifierResult: ClassifierResult | undefined;
          if (!pinnedTier && !ruleHit && state.currentConfig.classifierModel) {
            const classifierRefs = [
              state.currentConfig.classifierModel.model,
              ...(state.currentConfig.classifierModel.fallbacks ?? []),
            ];
            classifierResult = await runClassifier(
              classifierRefs,
              state.currentModelRegistry,
              context,
              state.lastDecision?.phase,
              state.currentConfig.classifierModel.thinking,
              hasImageAttachment(context), // pass image-present flag
            );
          }

          let decision: RoutingDecision = decideRouting(
            context,
            model.id,
            profile,
            state.lastDecision,
            pinnedTier,
            state.thinkingByProfile[model.id],
            state.currentConfig.phaseBias,
            state.currentConfig.rules,
            isBudgetExceeded,
            classifierResult,
            ruleHit,
          );

          // Google thought-signature continuation guard
          const lastMessage = context.messages[context.messages.length - 1];
          const previousDecision = state.lastDecision;
          const isGoogleThinkingToolContinuation =
            !pinnedTier && // skip guard when user pinned a tier
            lastMessage?.role === 'toolResult' &&
            previousDecision?.profile === model.id &&
            previousDecision.targetProvider === 'google' &&
            previousDecision.thinking !== 'off' &&
            decision.targetProvider === 'google' &&
            decision.thinking !== 'off' &&
            previousDecision.targetLabel !== decision.targetLabel;

          if (isGoogleThinkingToolContinuation) {
            decision = {
              ...decision,
              tier: previousDecision!.tier,
              phase: previousDecision!.phase,
              targetProvider: previousDecision!.targetProvider,
              targetModelId: previousDecision!.targetModelId,
              targetLabel: previousDecision!.targetLabel,
              thinking: previousDecision!.thinking,
              reasoning:
                `Preserved ${previousDecision!.targetLabel} for a Google tool-result continuation ` +
                `to avoid thought-signature replay errors. (Original: ${decision.reasoning})`,
            };
          }

          // Image-attachment tier promotion
          const imageAttached = hasImageAttachment(context);
          if (imageAttached) {
            const checkModelSupportsImage = (modelRef: string) => {
              try {
                const { provider: p, modelId: m } =
                  parseCanonicalModelRef(modelRef);
                const mm = state.currentModelRegistry?.find(p, m);
                return mm?.input?.includes('image') ?? false;
              } catch {
                return false;
              }
            };

            const tierModels = [
              decision.targetLabel,
              ...(profile[decision.tier]?.fallbacks ?? []),
            ];
            if (!tierModels.some(checkModelSupportsImage)) {
              const tiersToTry: RouterTier[] =
                decision.tier === 'low'
                  ? ['medium', 'high']
                  : decision.tier === 'medium'
                    ? ['high']
                    : [];

              let foundTier: RouterTier | undefined;
              for (const t of tiersToTry) {
                const tModels = [
                  profile[t]?.model,
                  ...(profile[t]?.fallbacks ?? []),
                ].filter((m): m is string => typeof m === 'string');
                if (tModels.some(checkModelSupportsImage)) {
                  foundTier = t;
                  break;
                }
              }

              if (foundTier) {
                const promotedDecision = buildRoutingDecision(
                  model.id,
                  profile,
                  foundTier,
                  phaseForTier(foundTier),
                  `Forced ${foundTier} tier because the originally routed ${decision.tier} tier does not support image attachments.`,
                  state.thinkingByProfile[model.id],
                  false,
                );
                // Carry forward provenance (modeled after routing.ts).
                promotedDecision.isPinned = decision.isPinned;
                promotedDecision.isRuleMatched = decision.isRuleMatched;
                promotedDecision.isBudgetForced = decision.isBudgetForced;
                if (decision.isClassifier) {
                  promotedDecision.isClassifier = decision.isClassifier;
                  promotedDecision.confidence = decision.confidence;
                  promotedDecision.rawText = decision.rawText;
                  promotedDecision.failureReason = decision.failureReason;
                  if (decision.isVetoed) {
                    promotedDecision.isVetoed = decision.isVetoed;
                    promotedDecision.vetoReason = decision.vetoReason;
                  }
                }
                decision = promotedDecision;
              }
            }
          }

          state.lastDecision = decision;
          // recordDebugDecision moved post-stream (Phase 5) so debug history
          // captures the actual streamed model after cross-tier fallback.

          const effectiveThinking =
            actions.getThinkingOverride(model.id, decision.tier) ??
            decision.thinking;
          actions.syncPiThinkingLevel(effectiveThinking);

          if (state.lastExtensionContext) {
            actions.updateStatus(state.lastExtensionContext);
          }

          // Cross-tier fallback loop
          const tierChain = buildDelegationTierChain(
            decision.tier,
            isBudgetExceeded,
          );
          const originalTier = decision.tier;

          let lastError: unknown;
          const skipReasons: string[] = [];
          let success = false;

          outer: for (const currentTier of tierChain) {
            const tierConfig = profile[currentTier];
            if (!tierConfig) {
              skipReasons.push(`${currentTier} tier not configured`);
              continue;
            }

            let modelsToTry = [
              tierConfig.model,
              ...(tierConfig.fallbacks ?? []),
            ];
            if (imageAttached) {
              modelsToTry = modelsToTry.filter((modelRef) => {
                try {
                  const { provider: p, modelId: m } =
                    parseCanonicalModelRef(modelRef);
                  return (
                    state.currentModelRegistry
                      ?.find(p, m)
                      ?.input?.includes('image') ?? false
                  );
                } catch {
                  return false;
                }
              });
              if (modelsToTry.length === 0) {
                skipReasons.push(
                  `${currentTier} tier: no image-capable models`,
                );
                continue;
              }
            }

            for (let i = 0; i < modelsToTry.length; i++) {
              const modelRef = modelsToTry[i];
              const { provider: targetProvider, modelId: targetModelId } =
                parseCanonicalModelRef(modelRef);

              if (targetProvider === 'router') {
                skipReasons.push(`skipped router self-reference: ${modelRef}`);
                continue;
              }

              const targetModel = state.currentModelRegistry.find(
                targetProvider,
                targetModelId,
              );
              if (!targetModel) {
                lastError = new Error(
                  `Routed model not found: ${targetProvider}/${targetModelId}`,
                );
                continue;
              }

              const auth =
                await state.currentModelRegistry.getApiKeyAndHeaders(
                  targetModel,
                );
              if (!auth.ok || !auth.apiKey) {
                lastError = new Error(
                  auth.ok
                    ? `No API key for routed model: ${targetProvider}/${targetModelId}`
                    : `Auth failed for routed model: ${targetProvider}/${targetModelId}: ${auth.error}`,
                );
                continue;
              }
              const apiKey = auth.apiKey;
              const headers = auth.headers;

              try {
                let effectiveContext = context;
                const targetLimit = resolveContextWindow(
                  currentTier,
                  profile,
                  state.currentModelRegistry,
                );
                if (targetLimit < model.contextWindow!) {
                  effectiveContext = truncateContext(context, targetLimit);
                }

                const thinkingOverride = actions.getThinkingOverride(
                  model.id,
                  currentTier,
                );
                // ponytail: runtime guard excludes 'off'; pi-ai ThinkingLevel excludes 'off', pi-agent-core includes it
                const delegatedReasoning:
                  | import('@earendil-works/pi-ai').ThinkingLevel
                  | undefined =
                  targetModel.reasoning &&
                  (thinkingOverride ?? decision.thinking) !== 'off'
                    ? ((thinkingOverride ??
                        decision.thinking) as import('@earendil-works/pi-ai').ThinkingLevel)
                    : undefined;

                if (state.lastExtensionContext) {
                  if (delegatedReasoning) {
                    state.lastExtensionContext.ui.setHiddenThinkingLabel?.(
                      `Thinking (${targetProvider}/${targetModelId})...`,
                    );
                  } else {
                    state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
                  }
                }

                const { reasoning: _piReasoning, ...delegationOptions } =
                  options ?? {};

                const delegatedStream = streamSimple(
                  targetModel,
                  effectiveContext,
                  {
                    ...delegationOptions,
                    apiKey,
                    headers,
                    ...(delegatedReasoning
                      ? { reasoning: delegatedReasoning }
                      : {}),
                  },
                );

                let contentReceived = false;
                for await (const event of delegatedStream) {
                  if (event.type === 'done') {
                    state.accumulatedCost +=
                      event.message.usage?.cost?.total ?? 0;
                  }
                  if (event.type === 'error' && !contentReceived) {
                    throw new Error(
                      event.error?.errorMessage ||
                        'Model failed before sending content.',
                    );
                  }
                  // ponytail: partial-stream cost — record usage if the error
                  // event carries it. If no usage available, cost is not
                  // recorded (accepted leak).
                  if (event.type === 'error' && contentReceived) {
                    const partialUsage = event.error?.usage;
                    if (partialUsage?.cost?.total) {
                      state.accumulatedCost += partialUsage.cost.total;
                    }
                  }
                  const isContent =
                    event.type === 'text_delta' ||
                    event.type === 'thinking_delta' ||
                    event.type === 'toolcall_delta' ||
                    event.type === 'toolcall_end';
                  if (isContent) contentReceived = true;
                  stream.push(event);
                }
                success = true;

                if (currentTier !== originalTier) {
                  decision.isFallback = true;
                  decision.tier = currentTier;
                  decision.phase = phaseForTier(currentTier);
                  decision.targetProvider = targetProvider;
                  decision.targetModelId = targetModelId;
                  decision.targetLabel = modelRef;
                  // Refresh thinking to the fallback tier (override > tier-configured > tier-default)
                  const fbBase =
                    profile[currentTier]?.thinking ??
                    (currentTier === 'high'
                      ? 'high'
                      : currentTier === 'low'
                        ? 'low'
                        : 'medium');
                  decision.thinking =
                    state.thinkingByProfile[model.id]?.[currentTier] ?? fbBase;
                  decision.reasoning =
                    `Cross-tier fallback from ${originalTier} to ${currentTier} after in-tier exhaustion. ` +
                    `(Original: ${decision.reasoning})`;
                } else if (i > 0) {
                  decision.isFallback = true;
                }
                if (state.lastExtensionContext && decision.isFallback) {
                  actions.updateStatus(state.lastExtensionContext);
                }
                break outer;
              } catch (err) {
                lastError = err;
              }
            }
          }

          if (!success) {
            throw (
              lastError ||
              new Error(
                skipReasons.length > 0
                  ? `Failed to delegate to any model in the chain. All candidates were skipped: ${skipReasons.join('; ')}`
                  : 'Failed to delegate to any model in the chain.',
              )
            );
          }

          // Phase 5: record debug decision post-stream so history reflects
          // actual streamed model (after cross-tier fallback may have mutated
          // decision.tier/provider/model/label).
          actions.recordDebugDecision(decision);

          stream.end();
        } catch (error) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: createErrorMessage(
              model,
              error instanceof Error ? error.message : String(error),
            ),
          });
          stream.end();
        } finally {
          actions.persistState();
        }
      })();

      return stream;
    },
  });

  state.lastRegisteredModels = modelsKey;
};
