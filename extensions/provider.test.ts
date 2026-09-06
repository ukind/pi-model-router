import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRouterProvider, createErrorMessage, createAbortedMessage } from './provider';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { RouterConfig, RoutingDecision } from './types';

class MockEventStream {
  events: any[] = [];
  onCallbacks: Record<string, Function[]> = {};
  // Mirror of pi-ai EventStream.result() (event-stream.js:17-36): resolves
  // only when a terminal `done`/`error` event is pushed. A bare end() with no
  // terminal event never resolves it — the exact gap that shipped d793dbde
  // (the mock could not see the hang). extractResult mirrors pi: done →
  // message, error → error.
  private resultResolve: ((value: any) => void) | null = null;
  private resultPromise: Promise<any> = new Promise((resolve) => {
    this.resultResolve = resolve;
  });

  push(event: any) {
    this.events.push(event);
    if (event.type === 'done' || event.type === 'error') {
      this.resultResolve?.(event.type === 'done' ? event.message : event.error);
    }
    const callbacks = this.onCallbacks['data'] || [];
    for (const cb of callbacks) {
      cb(event);
    }
  }

  end() {
    // Mirrors pi-ai: bare end() (no result arg) does NOT resolve result() —
    // only a terminal event does. Keeping this faithful is what lets the
    // flipped tests detect a hang.
    const callbacks = this.onCallbacks['end'] || [];
    for (const cb of callbacks) {
      cb();
    }
  }

  result() {
    return this.resultPromise;
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

  describe('createAbortedMessage', () => {
    it('should create a valid aborted AssistantMessage', () => {
      const model = { api: 'openai', provider: 'openai', id: 'gpt-4o' } as any;
      const msg = createAbortedMessage(model);
      expect(msg.role).toBe('assistant');
      expect(msg.stopReason).toBe('aborted');
      expect(msg.errorMessage).toBeUndefined();
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

    it('should pass candidateTimeoutMs as timeoutMs to the delegated call', async () => {
      mockState.currentConfig.candidateTimeoutMs = 45000;

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

      const callOptions = vi.mocked(streamSimple).mock.calls[0][2] as any;
      expect(callOptions.timeoutMs).toBe(45000);
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

    // Asserts the stream terminated: result() resolved because a terminal
    // event was pushed. Races against a timeout so a regression (bare end(),
    // no terminal event) fails fast instead of stalling the suite.
    const terminated = (stream: MockEventStream, ms = 500) =>
      Promise.race([
        stream.result().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), ms),
        ),
      ]);

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

      // Silent end: no error event, no fallback retry, state persisted.
      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
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

      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
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

      // Post-auth gate fired: no delegated stream opened, silent end.
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify a stale-ctx throw as benign: no error event, still persists', async () => {
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

      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
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

      // Post-classifier gate fired: silent end, no delegated stream opened.
      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify pi abort (AbortError) as benign: no error event', async () => {
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

      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    // Two-turn sticky-state guard (FRD acceptance core): one ESC abort
    // mid-classifier must not poison the NEXT turn. Both turns run through
    // the SAME captured provider options and the SAME mockState — no reset
    // between turns (a reset would mask exactly the sticky-state bugs this
    // exists to catch: sticky dead flag, cached/reused signal, one-shot
    // abort latch, delegation skip).
    it('should recover on the next turn after a mid-classifier abort', async () => {
      // Shared, configured ONCE: the classifier runs in both turns (no pin —
      // a pin would skip the classifier entirely, see provider.ts pre-decision).
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };

      registerRouterProvider(mockPi, mockState, mockActions);

      // ── Turn A stream
      const streamA = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        streamA as any,
      );

      let releaseClassifier = () => {};
      const classifierGate = new Promise<void>((resolve) => {
        releaseClassifier = resolve;
      });

      // Order-dispatching mock: call 1 = turn A classifier (gated, then
      // AbortError), call 2 = turn B classifier (instant), call 3 = turn B
      // delegation (done). Both classifier calls target gpt-4o-mini
      // (classifierModel.model, no fallbacks); the 'medium' yield is
      // unparseable (no 'tier:' line) so runClassifier returns undefined and
      // decideRouting's short-prompt branch picks 'low' (wordCount 1 <= 12),
      // which is unconfigured in this profile — resolveAvailableTier falls
      // up to 'medium', so the delegated target is gpt-4o-mini
      // deterministically.
      let compatCall = 0;
      vi.mocked(streamSimple).mockImplementation((() => {
        compatCall++;
        if (compatCall === 1) {
          return (async function* () {
            yield { type: 'text_delta', delta: 'medium' };
            await classifierGate;
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            throw abortError;
          })() as any;
        }
        if (compatCall === 2) {
          return (async function* () {
            yield { type: 'text_delta', delta: 'medium' };
          })() as any;
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'delegated answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0015 } } },
          };
        })() as any;
      }) as any);

      // ── Turn A: user ESC lands while the classifier is in flight.
      const controllerA = new AbortController();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controllerA.signal,
      } as any);
      await sleep(50);
      // Classifier call in flight; nothing decided yet.
      expect(vi.mocked(streamSimple).mock.calls.length).toBe(1);
      expect(mockState.lastDecision).toBeUndefined();

      controllerA.abort(); // ESC: signal aborted BEFORE the classifier finishes
      releaseClassifier(); // classifier completes (runClassifier swallows the AbortError, returns undefined)
      await sleep(100);

      // Turn A exited at gate 1 on the signal branch: terminal aborted event,
      // NO delegated call, decision never recorded, state persisted once.
      const abortedEvent = streamA.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(streamA)).toBe(true);
      expect(vi.mocked(streamSimple).mock.calls.length).toBe(1);
      expect(mockState.lastDecision).toBeUndefined();
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);

      // ── Turn B: SAME provider options, SAME mockState (no reset), fresh
      // controller and fresh stream — exactly what pi does on the next turn.
      const streamB = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        streamB as any,
      );
      const controllerB = new AbortController();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controllerB.signal,
      } as any);
      await sleep(100);

      // Turn B recovers: classifier runs, delegation streams to done.
      expect(
        streamB.events.find((e: any) => e.type === 'error'),
      ).toBeUndefined();
      const calls = vi.mocked(streamSimple).mock.calls;
      expect(calls.length).toBe(3); // A-classifier + B-classifier + B-delegate
      const delegateCall = calls[calls.length - 1];
      expect(delegateCall[0].id).toBe('gpt-4o-mini'); // delegated target
      expect((delegateCall[2] as any).signal).toBe(controllerB.signal); // fresh signal — NOT turn A's
      const doneMessage = await streamB.result();
      expect(doneMessage.usage.cost.total).toBe(0.0015); // resolved done, not aborted
      expect(await terminated(streamB)).toBe(true);
      expect(mockState.isExtensionContextDead).toBe(false); // no sticky flag write
      expect(mockState.accumulatedCost).toBe(0.0015); // turn A contributed nothing
      expect(mockActions.persistState).toHaveBeenCalledTimes(2); // exactly once per turn
    });
  });

  // Slice 3: per-exit emission tests — sibling describe, inserted AFTER the
  // closing `});` of `describe('session replacement gates (dead flag / abort)')`,
  // inside the `registerRouterProvider` describe. Helpers are local per file
  // convention (the gates describe scopes its own; only MockEventStream is
  // module-level). Pure addition: the existing suites stay byte-identical.
  describe('abort-gate debug emission (router[abort] lines)', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // Same contract mirror as the gates suite: true only when a terminal
    // event resolved result(). Races a timeout so a bare-end() regression
    // fails fast instead of stalling the suite.
    const terminated = (stream: MockEventStream, ms = 500) =>
      Promise.race([
        stream.result().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), ms),
        ),
      ]);

    const makeModel = () =>
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =>
      ({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    // Debug on + a notify spy as the emission surface. The default ui mock
    // (beforeEach, ~:119-122) has no notify — every emission test provides a
    // callable one so assertions can see (or prove the absence of) gate lines.
    const enableDebugEmission = (notifyImpl?: () => void) => {
      const notify = vi.fn(notifyImpl);
      mockState.debugEnabled = true;
      mockState.lastExtensionContext = {
        ui: { notify, setHiddenThinkingLabel: vi.fn() },
      };
      return notify;
    };
    const gateLines = (notify: ReturnType<typeof vi.fn>) =>
      notify.mock.calls
        .map((call: any) => String(call[0]))
        .filter((line: string) => line.startsWith('router[abort]'));
    const abortedEventOf = (stream: MockEventStream) =>
      stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );

    it('emits one router[abort] gate1 line with the operand snapshot on a signal-aborted turn', async () => {
      const notify = enableDebugEmission();
      // Classifier configured: the instant compat mock completes it, so the
      // line pins the post-await classifierRan wiring (the flag is set only
      // after runClassifier resolves — provider.ts slice-1 section D).
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'medium' };
        })() as any,
      );

      const controller = new AbortController();
      controller.abort(); // ESC before the turn starts: entry=true
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      // Exactly one gate line, through the info notify transport.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/^router\[abort\] gate1 /),
        'info',
      );
      const [line] = gateLines(notify);
      expect(line).toContain('profile=balanced');
      expect(line).toContain('dead=false');
      expect(line).toContain('signal=true');
      expect(line).toContain('entry=true');
      expect(line).toContain('classifierRan=true');
      // Turn still ends through the original gate-1 exit.
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate2 line when a replacement kill stops the candidate retry', async () => {
      const notify = enableDebugEmission();
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

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

      // Pin medium: [gpt-4o-mini, gemini-1.5-flash].
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']);

      // Replacement lands mid-stream: flag set, delegated stream aborted.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // The per-candidate catch swallows the AbortError (provider.ts:769-772);
      // the retry is stopped by the loop-top gate — exactly what emits here.
      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate2 loop-top');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('tier=medium');
      expect(line).toContain('candidate=2/2');
      expect(line).toContain('dead=true');
      expect(line).toContain('signal=false');
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(attempts).toEqual(['gpt-4o-mini']); // candidate 2 never opened
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate3 line when a replacement lands during the auth await', async () => {
      const notify = enableDebugEmission();
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

      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate3 post-auth');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('tier=medium');
      expect(line).toContain('model=openai/gpt-4o-mini');
      expect(line).toContain('dead=true');
      expect(line).toContain('signal=false');
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate4 line for a direct AbortError into the catch', async () => {
      const notify = enableDebugEmission();
      // AbortError thrown before the delegation loop (syncPiThinkingLevel
      // runs pre-chain at provider.ts:504): phase stays 'post-classifier'
      // and lastError is unset — delegated=false.
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
      await sleep(50);

      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate4 catch');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('stale=false');
      expect(line).toContain('abort=true');
      expect(line).toContain('phase=post-classifier');
      expect(line).toContain('delegated=false');
      expect(line).toContain('name=AbortError');
      expect(line).toContain('msg=The operation was aborted');
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate4 line with delegated=true when an exhausted chain rethrows a swallowed AbortError', async () => {
      const notify = enableDebugEmission();
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      // No abort state is set, so the loop-top gate lets every candidate
      // open; each candidate's AbortError is swallowed into lastError, the chain
      // exhausts, and `throw lastError` re-enters the catch (delegated=true
      // — the arm the poison research flagged as indistinguishable without
      // the phase/delegated markers).
      expect(attempts).toEqual([
        'gpt-4o-mini',
        'gemini-1.5-flash',
        // Up-chain: medium is not budget-capped, so after both medium
        // candidates throw, the chain reaches the configured high tier.
        'gpt-4o',
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate4 catch');
      expect(line).toContain('stale=false');
      expect(line).toContain('abort=true');
      expect(line).toContain('phase=delegation');
      expect(line).toContain('delegated=true');
      expect(line).toContain('name=AbortError');
      // Name-based classification keeps the rethrow benign — not reason:'error'.
      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.reason).toBe('aborted');
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('stays inert with debug off: no notify, terminal contract unchanged', async () => {
      // Explicit off (the default mockState omits the key — falsy — the
      // explicit flag documents the contract under test): the emitter must
      // short-circuit before touching ui, and the gate exit must behave
      // exactly as pre-instrumentation.
      mockState.debugEnabled = false;
      const notify = vi.fn();
      mockState.lastExtensionContext = {
        ui: { notify, setHiddenThinkingLabel: vi.fn() },
      };
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      controller.abort();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      expect(notify).not.toHaveBeenCalled();
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('swallows a dead-egress notify throw: gate-1 classification survives, no gate-4 re-emit', async () => {
      // TOCTOU shape (D1): the guard passed (debug on, ctx present) but the
      // egress plane died before notify ran. The emitter's try/catch must
      // swallow so the ORIGINAL gate's push still lands — an escaping throw
      // would skip the branch's stream.push and reclassify through gate 4
      // as reason:'error' (the d793dbde regression class).
      const notify = enableDebugEmission(() => {
        throw new Error('egress plane dead');
      });
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      controller.abort();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      // Gate 1 attempted its emit exactly once; the throw was contained. A
      // gate-4 reclassification would emit a second line (debug still on,
      // ctx still set), so call count 1 IS the no-reclassification proof.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(String((notify.mock.calls[0] as any[])[0])).toMatch(
        /^router\[abort\] gate1 /,
      );
      expect(abortedEventOf(stream)).toBeDefined();
      expect(
        stream.events.find(
          (e: any) => e.type === 'error' && e.reason === 'error',
        ),
      ).toBeUndefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });
  });
  });
});
