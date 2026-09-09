import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerRouterProvider,
  createErrorMessage,
  modelRegistryFallback,
  notifyClosureShutdown,
} from './provider';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { RouterConfig, RoutingDecision } from './types';

class MockEventStream {
  events: any[] = [];
  onCallbacks: Record<string, Function[]> = {};

  push(event: any) {
    this.events.push(event);
    const callbacks = this.onCallbacks['data'] || [];
    for (const cb of callbacks) {
      cb(event);
    }
  }

  end() {
    const callbacks = this.onCallbacks['end'] || [];
    for (const cb of callbacks) {
      cb();
    }
  }

  on(event: string, cb: Function) {
    if (!this.onCallbacks[event]) {
      this.onCallbacks[event] = [];
    }
    this.onCallbacks[event].push(cb);
    return this;
  }

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) {
      yield event;
    }
  }
}

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
  getApiProvider: vi.fn().mockReturnValue({ streamSimple: vi.fn() }),
}));

describe('provider.ts', () => {
  let mockPi: any;
  let mockRegistry: any;
  let mockState: any;
  let mockActions: any;
  let registeredProviderName: string | null = null;
  let registeredProviderOptions: any = null;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredProviderName = null;
    modelRegistryFallback.current = undefined;
    registeredProviderOptions = null;

    mockPi = {
      registerProvider: (name: string, options: any) => {
        registeredProviderName = name;
        registeredProviderOptions = options;
      },
    };

    const config: RouterConfig = {
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o', resolvedContextWindow: 10000 },
          medium: {
            model: 'openai/gpt-4o-mini',
            resolvedContextWindow: 5000,
            fallbacks: ['google/gemini-1.5-flash'],
          },
        },
      },
    };

    mockRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' || provider === 'google') {
          return { provider, id: modelId, input: ['text', 'image'] };
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: 'test-key',
        headers: {},
      }),
    };

    mockState = {
      lastRegisteredModels: '',
      currentConfig: config,
      currentModelRegistry: mockRegistry,
      lastExtensionContext: {
        ui: {
          setHiddenThinkingLabel: vi.fn(),
        },
      },
      isExtensionContextDead: false,
      selectedProfile: undefined,
      routerEnabled: false,
      lastDecision: undefined,
      thinkingByProfile: {},
      pinnedTierByProfile: {},
      accumulatedCost: 0,
    };

    mockActions = {
      persistState: vi.fn(),
      recordDebugDecision: vi.fn(),
      getThinkingOverride: vi.fn().mockReturnValue(undefined),
      updateStatus: vi.fn(),
      syncPiThinkingLevel: vi.fn(),
    };
  });

  describe('createErrorMessage', () => {
    it('should create a valid error AssistantMessage', () => {
      const model = { api: 'openai', provider: 'openai', id: 'gpt-4o' } as any;
      const msg = createErrorMessage(model, 'Test error message');
      expect(msg.role).toBe('assistant');
      expect(msg.errorMessage).toBe('Test error message');
      expect(msg.stopReason).toBe('error');
    });
  });

  describe('registerRouterProvider', () => {
    it('should register provider under router name', () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      expect(registeredProviderName).toBe('router');
      expect(registeredProviderOptions).toBeDefined();
      expect(registeredProviderOptions.models[0].id).toBe('balanced');
    });

    it('should delegate streams and accumulate cost on success', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const delegateStream = (async function* () {
        yield { type: 'text_delta', delta: 'Answer part' };
        yield { type: 'done', message: { usage: { cost: { total: 0.0015 } } } };
      })();
      vi.mocked(streamSimple).mockReturnValue(delegateStream as any);

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      const providerStream = registeredProviderOptions.streamSimple(
        model,
        context,
      );

      // Wait for async execution of stream handler
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.selectedProfile).toBe('balanced');
      expect(mockState.routerEnabled).toBe(true);
      expect(mockState.accumulatedCost).toBe(0.0015);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should try fallbacks if the primary model fails', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        callCount++;
        if (model.id === 'gpt-4o-mini') {
          // Force fail for primary
          return (async function* () {
            throw new Error('primary failed');
          })() as any;
        }
        // Success for fallback
        return (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      // Force a medium tier routing decision
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callCount).toBe(2);
      expect(mockState.accumulatedCost).toBe(0.0005);
      expect(mockState.lastDecision.isFallback).toBe(true);
    });

    it('should preserve previous Google model on Google thinking tool continuation', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as any,
      );

      // Set up last decision as Google model with thinking
      mockState.lastDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        thinking: 'high',
        timestamp: Date.now(),
      };

      // Configure profile tiers to use google provider models
      mockState.currentConfig.profiles.balanced.high = {
        model: 'google/gemini-2.5-pro',
        thinking: 'high',
      };
      mockState.currentConfig.profiles.balanced.medium = {
        model: 'google/gemini-2.5-flash',
        thinking: 'medium',
      };

      // Set up registry search
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        return { provider, id: modelId, reasoning: true, input: ['text'] };
      };

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = {
        messages: [
          { role: 'user', content: 'initial', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 't',
            content: 'tool output',
            isError: false,
            timestamp: Date.now(),
          },
        ],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // The decision should be updated to preserve the previous model
      expect(mockState.lastDecision.targetModelId).toBe('gemini-2.5-pro');
      expect(mockState.lastDecision.reasoning).toContain(
        'Preserved google/gemini-2.5-pro for a Google tool-result continuation',
      );
    });

    describe('in-tier fallback mutates target fields', () => {
      it('reflects fallback model in decision when primary fails', async () => {
        registerRouterProvider(mockPi, mockState, mockActions);
        const stream = new MockEventStream();
        vi.mocked(createAssistantMessageEventStream).mockReturnValue(
          stream as any,
        );

        vi.mocked(streamSimple).mockImplementation(((model: any) => {
          if (model.id === 'gpt-4o-mini') {
            return (async function* () {
              throw new Error('primary failed');
            })() as any;
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'fallback answer' };
            yield {
              type: 'done',
              message: { usage: { cost: { total: 0.0007 } } },
            };
          })() as any;
        }) as any);

        mockState.pinnedTierByProfile['balanced'] = 'medium';

        const model = {
          id: 'balanced',
          api: 'router-api',
          provider: 'router',
        } as any;
        const context = {
          messages: [{ role: 'user', content: 'hello' }],
        } as any;

        registeredProviderOptions.streamSimple(model, context);

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockState.lastDecision.isFallback).toBe(true);
        expect(mockState.lastDecision.targetProvider).toBe('google');
        expect(mockState.lastDecision.targetModelId).toBe('gemini-1.5-flash');
        expect(mockState.lastDecision.targetLabel).toBe(
          'google/gemini-1.5-flash',
        );
        expect(mockState.lastDecision.reasoning).toContain(
          'In-tier fallback to google/gemini-1.5-flash',
        );
        // phase is not mutated on in-tier fallback
        expect(mockState.lastDecision.phase).toBe('implementation');
      });
    });

    describe('Google continuation guard after in-tier fallback', () => {
      it('routes back to the model that actually streamed', async () => {
        registerRouterProvider(mockPi, mockState, mockActions);
        const stream = new MockEventStream();
        vi.mocked(createAssistantMessageEventStream).mockReturnValue(
          stream as any,
        );

        const triedModels: string[] = [];
        vi.mocked(streamSimple).mockImplementation(((model: any) => {
          triedModels.push(model.id);
          return (async function* () {
            yield { type: 'text_delta', delta: 'done' };
          })() as any;
        }) as any);

        // Previous turn: in-tier fallback streamed gemini-2.5-flash
        // (gemini-2.5-pro was the tier primary but failed first).
        mockState.lastDecision = {
          profile: 'balanced',
          tier: 'high',
          phase: 'planning',
          targetProvider: 'google',
          targetModelId: 'gemini-2.5-flash',
          targetLabel: 'google/gemini-2.5-flash',
          thinking: 'high',
          timestamp: Date.now(),
        };

        // Force a new routing decision that resolves to a different
        // google model so the guard's `targetLabel !== decision.targetLabel`
        // check fires and escalates tier back to the previous one.
        mockState.currentConfig.profiles.balanced.high = {
          model: 'google/gemini-2.5-pro',
          thinking: 'high',
          fallbacks: ['google/gemini-2.5-flash'],
        };
        mockState.currentConfig.profiles.balanced.medium = {
          model: 'google/gemini-2.0-flash',
          thinking: 'medium',
        };
        mockState.currentConfig.profiles.balanced.low = {
          model: 'google/gemini-2.0-flash',
          thinking: 'low',
        };

        mockState.currentModelRegistry.find = (
          provider: string,
          modelId: string,
        ) => {
          return { provider, id: modelId, reasoning: true, input: ['text'] };
        };

        const model = {
          id: 'balanced',
          api: 'router-api',
          provider: 'router',
        } as any;
        const context = {
          messages: [
            { role: 'user', content: 'initial', timestamp: Date.now() },
            {
              role: 'toolResult',
              toolCallId: 'c1',
              toolName: 't',
              content: 'tool output',
              isError: false,
              timestamp: Date.now(),
            },
          ],
        } as any;

        registeredProviderOptions.streamSimple(model, context);

        await new Promise((resolve) => setTimeout(resolve, 100));

        // The continuation guard must restore the previous model, and the
        // prepend must put it first so the tier primary (gemini-2.5-pro,
        // which failed in the previous turn) is NOT tried first.
        expect(mockState.lastDecision.targetModelId).toBe('gemini-2.5-flash');
        expect(mockState.lastDecision.reasoning).toContain(
          'Preserved google/gemini-2.5-flash for a Google tool-result continuation',
        );
        expect(triedModels[0]).toBe('gemini-2.5-flash');
        expect(triedModels).not.toContain('gemini-2.5-pro');
      });
    });

    describe('cross-tier fallback', () => {
      it('mutates decision when all in-tier models fail and next tier succeeds', async () => {
        mockState.currentConfig.profiles.balanced.high = {
          model: 'openai/gpt-4o',
          fallbacks: ['google/gemini-pro'],
        };
        mockState.currentConfig.profiles.balanced.medium = {
          model: 'openai/gpt-4o-mini',
        };

        registerRouterProvider(mockPi, mockState, mockActions);
        const stream = new MockEventStream();
        vi.mocked(createAssistantMessageEventStream).mockReturnValue(
          stream as any,
        );

        vi.mocked(streamSimple).mockImplementation(((model: any) => {
          if (model.id === 'gpt-4o' || model.id === 'gemini-pro') {
            return (async function* () {
              throw new Error(`${model.id} failed`);
            })() as any;
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'medium tier answer' };
            yield {
              type: 'done',
              message: { usage: { cost: { total: 0.0003 } } },
            };
          })() as any;
        }) as any);

        // Pin to high so the whole high tier (primary + fallback) is
        // exhausted before the chain crosses to medium.
        mockState.pinnedTierByProfile['balanced'] = 'high';

        const model = {
          id: 'balanced',
          api: 'router-api',
          provider: 'router',
        } as any;
        const context = {
          messages: [{ role: 'user', content: 'hello' }],
        } as any;

        registeredProviderOptions.streamSimple(model, context);

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockState.lastDecision.tier).toBe('medium');
        expect(mockState.lastDecision.isFallback).toBe(true);
        expect(mockState.lastDecision.targetProvider).toBe('openai');
        expect(mockState.lastDecision.targetModelId).toBe('gpt-4o-mini');
        expect(mockState.lastDecision.targetLabel).toBe('openai/gpt-4o-mini');
        expect(mockState.lastDecision.reasoning).toContain(
          'Cross-tier fallback from high to medium',
        );
        expect(mockState.accumulatedCost).toBe(0.0003);
      });
    });

    describe('budget integration', () => {
      it('downgrades routing when accumulatedCost >= maxSessionBudget', async () => {
        mockState.currentConfig.maxSessionBudget = 0.5;
        mockState.accumulatedCost = 0.6;

        registerRouterProvider(mockPi, mockState, mockActions);
        const stream = new MockEventStream();
        vi.mocked(createAssistantMessageEventStream).mockReturnValue(
          stream as any,
        );

        const triedModels: string[] = [];
        vi.mocked(streamSimple).mockImplementation(((model: any) => {
          triedModels.push(model.id);
          return (async function* () {
            yield { type: 'text_delta', delta: 'budget answer' };
            yield {
              type: 'done',
              message: { usage: { cost: { total: 0.0001 } } },
            };
          })() as any;
        }) as any);

        const model = {
          id: 'balanced',
          api: 'router-api',
          provider: 'router',
        } as any;
        // 'carefully' is an explicit high hint — would normally route high.
        const context = {
          messages: [
            { role: 'user', content: 'plan the architecture carefully' },
          ],
        } as any;

        registeredProviderOptions.streamSimple(model, context);

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockState.lastDecision.tier).toBe('medium');
        expect(mockState.lastDecision.isBudgetForced).toBe(true);
        expect(mockState.lastDecision.targetModelId).toBe('gpt-4o-mini');
        expect(mockState.lastDecision.reasoning).toContain('Budget exceeded');
        // Budget-exceeded chain is down-only: high must never be tried.
        expect(triedModels).not.toContain('gpt-4o');
        expect(triedModels[0]).toBe('gpt-4o-mini');
      });
    });

    it('should force higher tier if current tier does not support image attachments', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as any,
      );

      // Medium tier model and fallback lack image support; high tier supports images.
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return { provider, id: modelId, input: ['text', 'image'] };
        }
        return { provider, id: modelId, input: ['text'] };
      };

      // No pin — heuristic routes to medium via 'implement' keyword.
      // (Previously pinned medium; removed because the I2 gate now blocks
      // promotion when pinnedTier is set.)

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text' as const, text: 'implement the fix' },
              {
                type: 'image' as const,
                image: { mimeType: 'image/png', data: 'data' },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.lastDecision.tier).toBe('high');
      expect(mockState.lastDecision.reasoning).toContain(
        'Forced high tier because the originally routed medium tier does not support image attachments',
      );
    });

    it('should NOT promote tier for images when budget is exceeded (I1)', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as any,
      );

      // Medium tier has no image support; high tier does.
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return { provider, id: modelId, input: ['text', 'image'] };
        }
        return { provider, id: modelId, input: ['text'] };
      };

      // Simulate exceeded budget: cost >= budget.
      mockState.currentConfig.maxSessionBudget = 1;
      mockState.accumulatedCost = 10;

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      // 'carefully' is an explicit high hint → heuristic routes to high.
      // Budget exceeded → downgrades to medium, isBudgetForced=true.
      // Without the I1 gate, the promotion block would override the budget
      // cap by promoting medium → high for image support. With the gate,
      // promotion is skipped.
      const context = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text' as const,
                text: 'plan the architecture carefully',
              },
              {
                type: 'image' as const,
                image: { mimeType: 'image/png', data: 'data' },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Tier stays at medium (budget downgrade from high). Promotion to
      // high was blocked by the I1 gate even though high supports images.
      expect(mockState.lastDecision.tier).not.toBe('high');
      expect(mockState.lastDecision.isBudgetForced).toBe(true);
      // The down-chain [medium, low] has no image-capable model; the
      // delegation loop throws "Failed to delegate to any model in the chain".
      // This is the expected I1 outcome (not a silent image drop) and the
      // user-visible error should surface via the stream.
      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain(
        'Failed to delegate to any model in the chain',
      );
    });

    it('should NOT promote tier for images when tier is pinned (I2)', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as any,
      );

      // Medium tier has no image support; high tier does.
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return { provider, id: modelId, input: ['text', 'image'] };
        }
        return { provider, id: modelId, input: ['text'] };
      };

      // Pin to medium tier (exists in profile, unlike 'low').
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image' as const,
                image: { mimeType: 'image/png', data: 'data' },
              },
            ],
            timestamp: Date.now(),
          },
        ],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Without the I2 gate, the promotion block would override the pin by
      // promoting medium → high for image support with 'Forced high tier...'
      // reasoning. With the gate, promotion is skipped; medium is exhausted
      // (no image models) and the tier chain falls through to high via
      // cross-tier fallback — preserving pin provenance.
      expect(mockState.lastDecision.isPinned).toBe(true);
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockState.lastDecision.reasoning).not.toContain(
        'Forced high tier because the originally routed',
      );
    });

    it('should auto-truncate context if target limit is smaller than reported context window', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let truncatedContextPassed: any = null;
      vi.mocked(streamSimple).mockImplementation(((model: any, ctx: any) => {
        truncatedContextPassed = ctx;
        return (async function* () {
          yield { type: 'text_delta', delta: 'done' };
        })() as any;
      }) as any);

      // Medium tier model has resolvedContextWindow = 5000 in config.
      // But let's verify if reported max context window of router is larger (which is 10000 from high tier).
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
        contextWindow: 10000,
      } as any;

      // Let's create a large context that exceeds 5000 tokens (approx 15000 chars)
      const context = {
        systemPrompt: 'System prompt instructions',
        messages: [
          { role: 'user', content: 'a'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'b'.repeat(8000), timestamp: Date.now() },
          { role: 'user', content: 'c'.repeat(2000), timestamp: Date.now() }, // latest message
        ],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(truncatedContextPassed).toBeDefined();
      // Old messages should have been truncated to fit 5000 tokens limit (15000 chars approx)
      // The first message 'a'.repeat(8000) should have been shifted out.
      expect(truncatedContextPassed.messages.length).toBeLessThan(
        context.messages.length,
      );
      expect(
        truncatedContextPassed.messages[
          truncatedContextPassed.messages.length - 1
        ].content,
      ).toBe('c'.repeat(2000));
    });

    it('should push error event when currentModelRegistry is undefined', async () => {
      mockState.currentModelRegistry = undefined;
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain('no model registry');
      // Guard fires before any state exists — nothing meaningful to persist
      // (L1-03: no garbage router-state entry on the failure path).
      expect(mockActions.persistState).not.toHaveBeenCalled();
    });

    it('should recover via module fallback when the closure never captured a registry', async () => {
      // Simulate a captureCtx from ANOTHER closure instance of the same
      // module (factory re-execution): module fallback set, this closure's
      // registry undefined.
      modelRegistryFallback.current = mockRegistry;
      mockState.currentModelRegistry = undefined;
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'fallback registry answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any,
      );

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = {
        messages: [{ role: 'user', content: 'hello' }],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Guard recovered: delegation ran and the closure state was healed
      // (write-back through the state bag's new setter in production; plain
      // property here).
      expect(vi.mocked(streamSimple)).toHaveBeenCalled();
      expect(mockState.selectedProfile).toBe('balanced');
      expect(mockState.currentModelRegistry).toBe(mockRegistry);
      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeUndefined();
    });

    it('should push error event when profile is unknown', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const model = {
        id: 'nonexistent-profile',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain('Unknown router profile');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should fall back when auth fails for primary model', async () => {
      let authCallCount = 0;
      mockState.currentModelRegistry.getApiKeyAndHeaders = async (
        model: any,
      ) => {
        authCallCount++;
        if (model.id === 'gpt-4o-mini') {
          return { ok: false, error: 'auth-error' };
        }
        return { ok: true, apiKey: 'fallback-key', headers: {} };
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any,
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(authCallCount).toBeGreaterThanOrEqual(2);
      expect(mockState.accumulatedCost).toBe(0.001);
    });

    it('should skip model not found in registry and try fallback', async () => {
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o-mini') return undefined; // primary not found
        return { provider, id: modelId, input: ['text', 'image'] };
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'answer from fallback' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.002 } } },
          };
        })() as any,
      );

      // Pin to medium so primary is gpt-4o-mini with fallback gemini-1.5-flash
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockState.accumulatedCost).toBe(0.002);
      expect(mockState.lastDecision.isFallback).toBe(true);
    });

    it('should push error when all models in chain fail', async () => {
      vi.mocked(streamSimple).mockImplementation((() => {
        return (async function* () {
          throw new Error('model unavailable');
        })() as any;
      }) as any);

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      // Pin to medium to get fallback chain
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      const model = {
        id: 'balanced',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain('model unavailable');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should throw enriched error when all candidates are silently skipped', async () => {
      // Profile whose only tier self-references the router — every candidate
      // is skipped by the router-self-ref guard; no real attempt sets lastError.
      mockState.currentConfig.profiles.selfRef = {
        high: { model: 'router/selfRef' },
      };
      mockState.pinnedTierByProfile['selfRef'] = 'high';

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const model = {
        id: 'selfRef',
        api: 'router-api',
        provider: 'router',
      } as any;
      const context = {
        messages: [{ role: 'user', content: 'hello' }],
      } as any;

      registeredProviderOptions.streamSimple(model, context);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain(
        'All candidates were skipped',
      );
      expect(errorEvent.error.errorMessage).toContain(
        'skipped router self-reference',
      );
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
      // All-skip path never attempts a real model call.
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
    });

  describe('session replacement gates (dead flag / abort)', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const makeModel = () =>
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =>
      ({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    it('should retry the fallback chain and surface error (not fabricated abort) when the inner stream aborts with a live run signal', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      // Deferred gate: the delegated stream blocks mid-stream until the test
      // simulates the kill.
      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await midStreamGate;
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      // Pin medium: [gpt-4o-mini, gemini-1.5-flash] + cross-tier [gpt-4o].
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']);

      // The session dies AND the underlying stream aborts — but the run
      // signal stays live (no user Esc, no pi abort of THIS turn). New
      // contract (2026-09-09 phantom-abort fix): a dead ctx alone must not
      // fabricate a user abort. The AbortError is a candidate failure —
      // the chain retries, then ends as a visible error.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(150);

      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('error');
      expect(terminalEvent.error.stopReason).toBe('error');
      expect(terminalEvent.error.errorMessage).toContain('aborted');
      expect(attempts).toEqual([
        'gpt-4o-mini',
        'gemini-1.5-flash',
        'gpt-4o',
      ]);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should stop candidate retries when only the abort signal fires', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await midStreamGate;
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      // Dead flag stays false: only the signal proves the choke's second
      // branch (user stop, not replacement).
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      controller.abort();
      releaseDelegated();
      await sleep(100);

      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should proceed to delegation when the session dies during the auth await (live signal)', async () => {
      let releaseAuth = () => {};
      const authGate = new Promise<void>((resolve) => {
        releaseAuth = resolve;
      });
      mockState.currentModelRegistry.getApiKeyAndHeaders = async () => {
        await authGate;
        return { ok: true, apiKey: 'key', headers: {} };
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0001 } } },
          };
        })() as any,
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // The owning session dies while the auth fetch is in flight — but the
      // run signal stays live. New contract: no fabricated abort; the turn
      // is still wanted, so delegation opens and completes.
      mockState.isExtensionContextDead = true;
      releaseAuth();
      await sleep(150);

      expect(vi.mocked(streamSimple)).toHaveBeenCalled();
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(mockActions.recordDebugDecision).toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify a stale-ctx throw as benign: aborted terminal event, still persists', async () => {
      // A pi-backed action throws pi's exact stale message mid-IIFE.
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        throw new Error(
          'This extension ctx is stale after session replacement',
        );
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should still surface a non-matching live error (negative control)', async () => {
      // Same throw site, wrong message: the classification must not mask a
      // live candidate failure (cdcfe2eb lesson).
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        throw new Error('API key revoked');
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain('API key revoked');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should keep gated ctx reads and still record the decision when a killed stream completes (reload case)', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        if (model.id === 'gpt-4o-mini') {
          // Primary fails normally (pre-kill) — the in-tier fallback opens.
          return (async function* () {
            throw new Error('primary failed');
          })() as any;
        }
        return (async function* () {
          // Fallback streams past the kill: on reload the delegated stream
          // runs to completion with the flag already set.
          yield { type: 'text_delta', delta: 'fallback answer' };
          await midStreamGate;
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // Replacement fires mid-stream; the running stream completes anyway.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // Silent, decision recorded, ctx-derived status update gated.
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(mockActions.recordDebugDecision).toHaveBeenCalledTimes(1);
      expect(mockActions.updateStatus).toHaveBeenCalledTimes(1); // pre-loop only
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should proceed to delegation when the session dies during the classifier await (live signal)', async () => {
      // No pin + a configured classifier: the classifier call flows through
      // the mocked compat streamSimple (routing.ts:746).
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let releaseClassifier = () => {};
      const classifierGate = new Promise<void>((resolve) => {
        releaseClassifier = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'medium' };
          await classifierGate;
          yield { type: 'text_delta', delta: 'medium' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0001 } } },
          };
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']); // classifier call in flight

      // The owning session dies mid-classifier — run signal stays live.
      // This is the exact 2026-09-09 phantom-abort shape: pi-subagents
      // evicted the subagent whose closure was (then) serving this stream.
      // New contract: no fabricated abort; delegation opens and completes.
      mockState.isExtensionContextDead = true;
      releaseClassifier();
      await sleep(150);

      // Classifier call + the delegated turn — the post-classifier choke
      // no longer kills the chain on a dead ctx alone.
      expect(attempts).toEqual(['gpt-4o-mini', 'gpt-4o-mini']);
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(mockActions.recordDebugDecision).toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should surface an AbortError with a live run signal as error (no fabricated abort)', async () => {
      // AbortError thrown straight into the IIFE catch with NO aborted run
      // signal. Old contract classified it as a user abort — the exact
      // fabrication vector behind the 2026-09-09 phantom "Operation
      // aborted". New contract: without signal.aborted it is a visible
      // error. (The real user-Esc path carries signal.aborted and is pinned
      // by the abort-signal test above.)
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('error');
      expect(terminalEvent.error.stopReason).toBe('error');
      expect(terminalEvent.error.errorMessage).toContain('aborted');
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should fall back when the delegated stream stalls silently', async () => {
      mockState.lastExtensionContext.ui.notify = vi.fn();
      mockState.currentConfig.stallTimeoutMs = 20;

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        if (model.id === 'gpt-4o-mini') {
          // Primary streams nothing — pure silence.
          return (async function* () {
            await new Promise<void>(() => {});
          })() as any;
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      expect(attempts).toEqual(['gpt-4o-mini', 'gemini-1.5-flash']);
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockState.lastDecision.reasoning).toContain('stalled');
      expect(mockState.lastExtensionContext.ui.notify).toHaveBeenCalled();
    });

    it('should fall back when the auth fetch stalls', async () => {
      mockState.lastExtensionContext.ui.notify = vi.fn();
      mockState.currentConfig.stallTimeoutMs = 20;
      let authCalls = 0;
      mockState.currentModelRegistry.getApiKeyAndHeaders = async () => {
        authCalls++;
        if (authCalls === 1) {
          // First candidate's auth hangs — never resolves, never rejects.
          await new Promise<void>(() => {});
        }
        return { ok: true, apiKey: 'key', headers: {} };
      };
      // NO AbortController — an aborted signal would take the silent-exit
      // branch instead of fallback (discriminator).

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any,
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      expect(authCalls).toBeGreaterThanOrEqual(2);
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockState.lastExtensionContext.ui.notify).toHaveBeenCalled();
    });

    it('should abort (not fall back) when the signal fires during a stalled stream', async () => {
      const controller = new AbortController();

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      mockState.lastExtensionContext.ui.notify = vi.fn();
      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await new Promise<void>(() => {}); // silence
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);
      controller.abort();
      await sleep(100);

      expect(attempts).toEqual(['gpt-4o-mini']);
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(mockState.lastExtensionContext.ui.notify).not.toHaveBeenCalled();
    });

    it('should degrade to heuristics when the classifier stalls', async () => {
      mockState.currentConfig.classifierModel = {
        model: 'openai/classifier-only',
        fallbacks: [],
      };
      mockState.currentConfig.stallTimeoutMs = 20;

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      mockState.lastExtensionContext.ui.notify = vi.fn();

      const delegated: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        if (model.id === 'classifier-only') {
          return (async function* () {
            await new Promise<void>(() => {}); // classifier stall
          })() as any;
        }
        delegated.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'heuristic answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      // classifier stalled → undefined → heuristics ('hello' → low tier →
      // falls up to medium — no low tier in the mock config) → delegated stream
      expect(delegated).toEqual(['gpt-4o-mini']);
      expect(
        stream.events.find((e: any) => e.type === 'error'),
      ).toBeUndefined();
      expect(
        mockState.lastExtensionContext.ui.notify,
      ).toHaveBeenCalledWith(
        expect.stringContaining('classifier'),
        'warning',
      );
      expect(mockActions.persistState).toHaveBeenCalled();
    });
  });

  describe('cross-session closure dispatcher (2026-09-09 phantom-abort fix)', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const makeModel = () =>
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =>
      ({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    // Two factory runs over the shared module (parent + in-process
    // subagent), each with its own pi/state/actions — replaying the
    // compat api-map last-registration-wins hijack.
    const makeClosure = (tag: string) => {
      const pi: any = {
        registerProvider: vi.fn(),
      };
      const state: any = {
        lastRegisteredModels: '',
        currentConfig: {
          profiles: {
            balanced: {
              medium: {
                model: 'openai/gpt-4o-mini',
                resolvedContextWindow: 5000,
              },
            },
          },
        },
        currentModelRegistry: mockRegistry,
        lastExtensionContext: {
          ui: { setHiddenThinkingLabel: vi.fn() },
        },
        isExtensionContextDead: false,
        selectedProfile: undefined,
        routerEnabled: false,
        lastDecision: undefined,
        thinkingByProfile: {},
        pinnedTierByProfile: {},
        accumulatedCost: 0,
      };
      const actions: any = {
        persistState: vi.fn(),
        recordDebugDecision: vi.fn(),
        getThinkingOverride: vi.fn(),
        updateStatus: vi.fn(),
        syncPiThinkingLevel: vi.fn(),
      };
      registerRouterProvider(pi, state, actions);
      const options = pi.registerProvider.mock.calls[0][1];
      return { tag, pi, state, actions, options };
    };

    it('should survive a subagent-closure eviction mid-turn: no fabricated abort (the 2026-09-09 session 01a08460 bug)', async () => {
      const parent = makeClosure('parent');
      const child = makeClosure('child'); // registered later — compat's last-wins

      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      // The turn is dispatched (picks the freshest closure — the child, as
      // compat did before the fix) and blocks mid-delegation.
      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });
      vi.mocked(streamSimple).mockImplementation(
        (() =>
          (async function* () {
            yield { type: 'text_delta', delta: 'partial' };
            await midStreamGate;
            yield {
              type: 'done',
              message: { usage: { cost: { total: 0.0002 } } },
            };
          })() as any) as any,
      );

      child.options.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // pi-subagents' 10-minute cleanup timer evicts the completed
      // subagent: session_shutdown lands on the child closure mid-turn.
      notifyClosureShutdown(child.pi);
      child.state.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(150);

      // The in-flight turn completes. No aborted terminal was fabricated.
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(child.actions.recordDebugDecision).toHaveBeenCalled();
      expect(child.actions.persistState).toHaveBeenCalled();
    });

    it('should reroute the next dispatch to the parent closure after the child session shuts down', async () => {
      const parent = makeClosure('parent');
      const child = makeClosure('child');

      notifyClosureShutdown(child.pi); // eviction

      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'from parent closure' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0001 } } },
          };
        })() as any,
      );

      // Any registered streamSimple is the same stable dispatcher — call
      // the PARENT's captured options: it must resolve to the parent
      // closure (the only live one), never to the dead child.
      parent.options.streamSimple(makeModel(), makeContext());
      await sleep(100);

      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(parent.actions.recordDebugDecision).toHaveBeenCalled();
      expect(child.actions.recordDebugDecision).not.toHaveBeenCalled();
      expect(parent.actions.persistState).toHaveBeenCalled();
    });

    it('should prefer the freshest live closure at dispatch time (capture ordering)', async () => {
      const parent = makeClosure('parent');
      const child = makeClosure('child');

      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'x' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0 } } },
          };
        })() as any,
      );

      // Both closures' captured streamSimple are the same stable
      // dispatcher. Registration order made the child fresher — a dispatch
      // right now must serve the CHILD closure (matches the pre-fix
      // hijack observable), and the child's state bag is the one mutated.
      parent.options.streamSimple(makeModel(), makeContext());
      await sleep(100);

      expect(child.actions.recordDebugDecision).toHaveBeenCalled();
      expect(parent.actions.recordDebugDecision).not.toHaveBeenCalled();
    });
  });
});
});
