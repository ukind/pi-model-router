import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRouterProvider, createErrorMessage } from './provider';
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
  let mockState: any;
  let mockActions: any;
  let registeredProviderName: string | null = null;
  let registeredProviderOptions: any = null;

  beforeEach(() => {
    vi.clearAllMocks();
    registeredProviderName = null;
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

    const mockRegistry = {
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

    it('should end a mid-turn replacement silently and stop fallback retries', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      // Deferred gate (the suite's one new construct): the delegated stream
      // blocks mid-stream until the test simulates the replacement kill.
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
          // pi aborts the underlying provider stream on session replacement.
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      // Pin medium: [gpt-4o-mini, gemini-1.5-flash] — the retry that must
      // NOT happen after the kill.
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']);

      // Session replacement: session_shutdown fired (flag set, Slice 1) and
      // the underlying stream aborted.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // Aborted terminal event: no fallback retry, state persisted.
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
      expect(attempts).toEqual(['gpt-4o-mini']);
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

    it('should exit silently when the session dies during the auth await', async () => {
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
          yield { type: 'text_delta', delta: 'never reached' };
        })() as any,
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // Replacement lands while the auth fetch is in flight.
      mockState.isExtensionContextDead = true;
      releaseAuth();
      await sleep(100);

      // Post-auth gate fired: no delegated stream opened, aborted end.
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
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

    it('should exit silently when the session dies during the classifier await', async () => {
      // No pin + a configured classifier: the classifier call flows through
      // the mocked compat streamSimple (routing.ts:746) — the same
      // deferred-gate construct, no new mock surface.
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
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']); // classifier call in flight

      // Replacement lands mid-classifier.
      mockState.isExtensionContextDead = true;
      releaseClassifier();
      await sleep(100);

      // Post-classifier gate fired: aborted end, no delegated stream opened.
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify pi abort (AbortError) as benign: aborted terminal event', async () => {
      // AbortError thrown straight into the IIFE catch (not swallowed by
      // the per-candidate catch) — proves the catch's second branch.
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
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });
  });
  });
});
