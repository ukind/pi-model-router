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
import { streamSimple, getApiProvider } from '@earendil-works/pi-ai/compat';
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
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STALL_TIMEOUT_MS,
} from './constants';
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
  raceStallTimeout,
  stallGuardedStream,
  isStallTimeoutError,
} from './routing';

// Exact pi stale-ctx message prefix (ctx getters throw with this prefix in
// pi core). Benign classification matches it exactly; pi drift degrades to
// the visible error path (fails loud).
const STALE_CTX_MESSAGE_PREFIX =
  'This extension ctx is stale after session replacement';

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

export const createAbortedMessage = (model: Model<Api>): AssistantMessage => {
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
    stopReason: 'aborted',
    timestamp: Date.now(),
  };
};

const pushAbortedEnd = (
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): void => {
  // Push BEFORE end(): a done/error event — not a bare end() — is what
  // resolves pi's response.result() (event-stream.js isComplete). Bare
  // end() parks agent-loop.js:238 forever ("Working..." wedge).
  stream.push({
    type: 'error',
    reason: 'aborted',
    error: createAbortedMessage(model),
  });
  stream.end();
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
    readonly isExtensionContextDead: boolean;
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

      // Invariant guard: pi emits `before_provider_request` with a fresh ctx
      // before every provider request (the router extension re-captures there),
      // so the registry is guaranteed set by the time streamSimple runs.
      // If this fires, the capture contract broke — fail loudly WITHOUT
      // persisting state (nothing meaningful exists to persist). (L1-01,
      // L1-03.)
      if (!state.currentModelRegistry) {
        stream.push({
          type: 'error',
          reason: 'error',
          error: createErrorMessage(
            model,
            'Router provider has no model registry: no ctx was captured before this stream. This is a router extension bug — please report it.',
          ),
        });
        stream.end();
        return stream;
      }

      (async () => {
        try {
          // The hoisted invariant guard above guarantees the registry is live
          // here; the getter's type remains `| undefined`, so snapshot it once
          // for the narrowing that the in-IIFE guard previously provided.
          const modelRegistry = state.currentModelRegistry!;
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

          const stallTimeoutMs =
            state.currentConfig.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

          const notifyStall = (message: string) => {
            if (state.lastExtensionContext && !state.isExtensionContextDead) {
              state.lastExtensionContext.ui.notify(
                `router: ${message} — trying next`,
                'warning',
              );
            }
          };
          // Pre-decision: gate classifier on no pin (always run when configured)
          const prompt = getLastUserText(context).toLowerCase();
          const ruleHit = !pinnedTier
            ? matchHighestTierRule(prompt, state.currentConfig.rules)
            : undefined;

          let classifierResult: ClassifierResult | undefined;
          if (!pinnedTier && state.currentConfig.classifierModel) {
            const classifierRefs = [
              state.currentConfig.classifierModel.model,
              ...(state.currentConfig.classifierModel.fallbacks ?? []),
            ];
            classifierResult = await runClassifier(
              classifierRefs,
              modelRegistry,
              context,
              state.lastDecision?.phase,
              state.currentConfig.classifierModel.thinking,
              hasImageAttachment(context), // pass image-present flag
              options?.signal,
              stallTimeoutMs,
              (ref, ms) => {
                notifyStall(`classifier ${ref} stalled after ${ms}ms`);
              },
            );
          }

          // The classifier await can span a session replacement. Re-verify
          // liveness before any ctx-derived read below: direct return keeps
          // the finally-running persistState and surfaces no error event.
          if (state.isExtensionContextDead || options?.signal?.aborted) {
            pushAbortedEnd(stream, model);
            return;
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
          // I1+I2: skip promotion when budget is exceeded (the budget cap must be
          // honored even when the downgraded tier lacks image-capable models) or
          // when the user pinned a tier (the pin promise must be honored).
          if (imageAttached && !isBudgetExceeded && !pinnedTier) {
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

          if (state.lastExtensionContext && !state.isExtensionContextDead) {
            actions.updateStatus(state.lastExtensionContext);
          }

          // Cross-tier fallback loop
          const tierChain = buildDelegationTierChain(
            decision.tier,
            isBudgetExceeded,
          );
          const originalTier = decision.tier;

          let lastError: unknown;
          const stallFallbacks: string[] = [];
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
            if (
              isGoogleThinkingToolContinuation &&
              previousDecision &&
              currentTier === originalTier
            ) {
              // Prepend the previously-successful model so the continuation
              // guard actually takes effect after an in-tier fallback (the
              // tier primary would otherwise be tried first). Gated to the
              // original tier so later cross-tier iterations don't prepend a
              // wrong-tier model. Duplicates are harmless (the inner loop
              // breaks on first success).
              modelsToTry = [previousDecision.targetLabel, ...modelsToTry];
            }
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
              // Choke point: every tier transition and candidate retry
              // re-enters this loop top. After a replacement kill (dead
              // flag) or a user abort, stop the fallback chain silently.
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                pushAbortedEnd(stream, model);
                return;
              }
              const modelRef = modelsToTry[i];
              const { provider: targetProvider, modelId: targetModelId } =
                parseCanonicalModelRef(modelRef);

              if (targetProvider === 'router') {
                skipReasons.push(`skipped router self-reference: ${modelRef}`);
                continue;
              }

              const targetModel = modelRegistry.find(
                targetProvider,
                targetModelId,
              );
              if (!targetModel) {
                lastError = new Error(
                  `Routed model not found: ${targetProvider}/${targetModelId}`,
                );
                continue;
              }

              const authResult = await raceStallTimeout(
                modelRegistry.getApiKeyAndHeaders(targetModel),
                stallTimeoutMs,
                options?.signal,
                `auth for ${modelRef}`,
              ).then(
                (value) => ({ ok: true as const, value }),
                (reason) => ({ ok: false as const, reason }),
              );
              if (!authResult.ok) {
                lastError = authResult.reason;
                if (isStallTimeoutError(authResult.reason)) {
                  stallFallbacks.push(authResult.reason.message);
                  notifyStall(authResult.reason.message);
                }
                continue;
                // abort: next loop-top choke (Phase 3) does pushAbortedEnd + return;
                // as-last-candidate: throw lastError → outer catch isAborted → pushAbortedEnd
              }
              const auth = authResult.value;

              // The auth fetch awaited — a replacement can land mid-await.
              // Re-verify before opening the delegated stream.
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                pushAbortedEnd(stream, model);
                return;
              }
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

              // (e) per-candidate kill switch — declarations live outside the
              // sibling try/finally so the finally can detach the listener.
              // On stall we abort this controller to error the in-flight
              // SSE read. Compose the run signal + kill switch manually —
              // pi-ai ships combineAbortSignals in dist/utils but does NOT
              // re-export it (blocked by the package exports map).
              const candidateAbort = new AbortController();
              const runSignal = options?.signal;
              const propagateAbort = () =>
                candidateAbort.abort(runSignal?.reason);
              if (runSignal?.aborted) {
                candidateAbort.abort();
              } else if (runSignal) {
                runSignal.addEventListener('abort', propagateAbort, {
                  once: true,
                });
              }
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

                if (
                  state.lastExtensionContext &&
                  !state.isExtensionContextDead
                ) {
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

                // Custom (non-builtin) api ids — e.g. cliproxyapi-codex-responses —
                // have no entry in compat's api-registry; compat streamSimple throws
                // "No API provider registered for api: ...". Delegate through pi's
                // ModelRuntime instead: provider-aware and resolves auth itself
                // (same path that makes direct selection work).
                // ponytail: runtime facade shape is untyped; guard + compat fallback
                // keeps behavior at least as good as before if pi changes internals.
                const hasCompatApi = Boolean(getApiProvider(targetModel.api));
                const registryRuntime = (
                  state.currentModelRegistry as unknown as {
                    runtime?: { streamSimple?: typeof streamSimple };
                  }
                )?.runtime;
                // ModelRuntime.streamSimple reads `this.prepareRequest`, so a
                // detached reference throws and silently demotes the model.
                const runtimeStreamSimple =
                  registryRuntime?.streamSimple?.bind(registryRuntime);

                const delegatedStream =
                  !hasCompatApi && runtimeStreamSimple
                    ? runtimeStreamSimple(targetModel, effectiveContext, {
                        ...delegationOptions,
                        signal: candidateAbort.signal,
                        ...(delegatedReasoning
                          ? { reasoning: delegatedReasoning }
                          : {}),
                      })
                    : streamSimple(targetModel, effectiveContext, {
                        ...delegationOptions,
                        signal: candidateAbort.signal,
                        apiKey,
                        headers,
                        ...(delegatedReasoning
                          ? { reasoning: delegatedReasoning }
                          : {}),
                      });

                let contentReceived = false;
                for await (const event of stallGuardedStream(
                  delegatedStream,
                  stallTimeoutMs,
                  () => candidateAbort.abort(),
                  candidateAbort.signal,
                  modelRef,
                )) {
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
                  // Refresh thinking to the fallback tier (override > tier-configured)
                  // `fbBase` chain was unreachable: normalizeTierConfig (config.ts)
                  // always sets `thinking` on the production config path, and this
                  // branch only runs against already-normalized config. The
                  // `?? 'medium'` is a defensive backstop for the type system.
                  decision.thinking =
                    state.thinkingByProfile[model.id]?.[currentTier] ??
                    tierConfig.thinking ??
                    'medium';
                  decision.reasoning =
                    `Cross-tier fallback from ${originalTier} to ${currentTier} after in-tier exhaustion. ` +
                    `(Original: ${decision.reasoning})`;
                } else if (i > 0) {
                  // In-tier fallback: the model that actually streamed is
                  // `modelRef`, not the tier primary. Update decision fields
                  // so the Google continuation guard sees the real model next
                  // turn. (Do NOT mutate `decision.phase` here — the
                  // classifier-decoupled value must survive an in-tier
                  // fallback to preserve the sticky-phase heuristic.)
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
                if (
                  state.lastExtensionContext &&
                  !state.isExtensionContextDead &&
                  decision.isFallback
                ) {
                  actions.updateStatus(state.lastExtensionContext);
                }
                if (stallFallbacks.length > 0) {
                  decision.reasoning =
                    `Recovered from ${stallFallbacks.length} stall(s): ${stallFallbacks.join('; ')}. ` +
                    `(Original: ${decision.reasoning})`;
                }
                break outer;
              } catch (err) {
                lastError = err;
                if (isStallTimeoutError(err)) {
                  stallFallbacks.push(err.message);
                  notifyStall(err.message);
                }
              } finally {
                runSignal?.removeEventListener('abort', propagateAbort);
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
          // Benign termination: a session replacement killed this turn.
          // Branch 1 — stale ctx throw: pi's exact prefix. Branch 2 —
          // pi's abort: AbortError. Neither is a router failure, so both
          // end with the aborted terminal event. Non-matching errors
          // still surface.
          const isStaleCtx =
            error instanceof Error &&
            error.message.startsWith(STALE_CTX_MESSAGE_PREFIX);
          const isAborted =
            error instanceof Error && error.name === 'AbortError';
          if (!isStaleCtx && !isAborted) {
            stream.push({
              type: 'error',
              reason: 'error',
              error: createErrorMessage(
                model,
                error instanceof Error ? error.message : String(error),
              ),
            });
            stream.end();
          } else {
            // Stale ctx / user abort: end with the builtin-shaped aborted
            // terminal event. Harmless on the stale-ctx path (session
            // discarded); mandatory on the user-abort path (pi wedges on a
            // bare end()).
            pushAbortedEnd(stream, model);
          }
        } finally {
          actions.persistState();
        }
      })();

      return stream;
    },
  });

  state.lastRegisteredModels = modelsKey;
};
