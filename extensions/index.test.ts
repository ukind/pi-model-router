import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modelRegistryFallback } from './provider';
import routerExtension from './index';

vi.mock('./config', () => ({
  loadRouterConfig: () => ({
    config: {
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
      },
    },
    warnings: [],
  }),
  profileNames: () => ['balanced'],
  resolveProfileName: (config: unknown, name: unknown) =>
    name === 'balanced' ? 'balanced' : undefined,
  parseCanonicalModelRef: (_ref: string) => ({
    provider: 'openai',
    modelId: 'gpt-4o',
  }),
  resolveContextWindow: () => 100000,
  resolveMaxTokens: () => 4000,
  collectProfileThinkingLevels: () => new Set<string>(),
  getUnsupportedTiers: (_profile?: unknown, _registry?: unknown) =>
    [] as string[],
  ROUTER_TIERS: ['high', 'medium', 'low'] as const,
  ROUTER_PIN_VALUES: ['auto', 'high', 'medium', 'low'] as const,
  THINKING_LEVELS: [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ] as const,
  isRouterTier: (v: unknown) => v === 'high' || v === 'medium' || v === 'low',
  isRouterPhase: (v: unknown) =>
    v === 'planning' || v === 'implementation' || v === 'lightweight',
  isThinkingLevel: (v: unknown) =>
    typeof v === 'string' &&
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(v),
  isObjectRecord: (v: unknown) => typeof v === 'object' && v !== null,
}));

describe('index.ts (orchestrator)', () => {
  let mockPi: any;
  let eventListeners: Record<string, Function[]> = {};

  beforeEach(() => {
    eventListeners = {};
    mockPi = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      setThinkingLevel: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (!eventListeners[event]) {
          eventListeners[event] = [];
        }
        eventListeners[event].push(handler);
      }),
    };
    modelRegistryFallback.current = undefined;
  });

  const buildMockCtx = () => ({
    cwd: '/mock/cwd',
    modelRegistry: {
      find: vi.fn().mockReturnValue({ provider: 'router', id: 'balanced' }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'key' }),
    },
    model: { provider: 'router', id: 'balanced' },
    sessionManager: {
      getBranch: () => [] as unknown[],
    },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      theme: { fg: (c: string, text: string) => text },
      notify: vi.fn(),
    },
  });

  it('should initialize and register commands, provider, and event hooks', () => {
    routerExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
    );
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'session_start',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'model_select',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
  });

  it('should wire before_provider_request capture that survives stale ctx', async () => {
    routerExtension(mockPi);

    // The capture contract: a before_provider_request handler must exist and
    // run before every provider request, independent of session_start (L0-01).
    const captureHandlers = eventListeners['before_provider_request'] || [];
    expect(captureHandlers.length).toBeGreaterThan(0);

    // Fresh ctx (as pi delivers before every stream) must capture cleanly.
    const mockCtx = buildMockCtx();
    for (const handler of captureHandlers) {
      await handler({}, mockCtx);
    }

    // Stale ctx after session replacement throws from ctx getters; the
    // capture must swallow the throw and keep the last captured registry
    // instead of aborting the event pipeline.
    const staleCtx = {
      get modelRegistry() {
        throw new Error('This extension ctx is stale after session replacement');
      },
      get cwd() {
        throw new Error('This extension ctx is stale after session replacement');
      },
    };
    for (const handler of captureHandlers) {
      // Sync handler returns undefined; the assertion is that it does not
      // throw despite the stale ctx.
      handler({}, staleCtx);
    }

    // Rest of the lifecycle still works after stale-ctx captures: a full
    // session_start with a fresh ctx completes without throwing.
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }
  });

  describe('session_shutdown dead-flag gate (flag core)', () => {
    it('should register a session_shutdown handler', () => {
      routerExtension(mockPi);
      expect(mockPi.on).toHaveBeenCalledWith(
        'session_shutdown',
        expect.any(Function),
      );
    });

    it('should survive shutdown + stale captures and recover on the next live event', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // session_shutdown fires before ctx invalidation — the handler must
      // not touch ctx (flag-only), so it cannot throw.
      const shutdownHandlers = eventListeners['session_shutdown'] || [];
      for (const handler of shutdownHandlers) {
        handler({}, mockCtx);
      }

      // A stale delivered ctx sets the flag via the captureCtx catch; the
      // swallow contract (index.test.ts:126-133) still holds.
      const staleCtx = {
        get modelRegistry() {
          throw new Error(
            'This extension ctx is stale after session replacement',
          );
        },
        get cwd() {
          throw new Error(
            'This extension ctx is stale after session replacement',
          );
        },
      };
      const captureHandlers = eventListeners['before_provider_request'] || [];
      for (const handler of captureHandlers) {
        handler({}, staleCtx);
      }

      // Recovery: the next live event (session_start with a fresh ctx)
      // completes a full restore — the flag cleared via live capture and
      // the extension stays fully functional.
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    });
  });

  describe('session_shutdown dead-flag gate (handler tails)', () => {
    const STALE_MESSAGE =
      'This extension ctx is stale after session replacement';

    const fireShutdown = () => {
      for (const handler of eventListeners['session_shutdown'] || []) {
        handler();
      }
    };

    it('should skip ctx reads in the switchToRouterProfile tail when the session dies during the model switch', async () => {
      routerExtension(mockPi);

      // Entry: the real /router command handler → handleProfile →
      // actions.switchToRouterProfile (commands.ts:222).
      const routerCommand = mockPi.registerCommand.mock.calls[0][1];
      const mockCtx = buildMockCtx();

      // Death lands during `await setModelInternally` (index.ts:273).
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      await routerCommand.handler('profile balanced', mockCtx);

      // Tail ran past the gates: persist happened, but the ctx-derived
      // status update was skipped (index.ts:281 gate).
      expect(mockPi.appendEntry).toHaveBeenCalled();
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        'Switched to router profile: balanced',
        'info',
      );
    });

    it('should skip the failure notify when the session dies during a failed model switch', async () => {
      routerExtension(mockPi);

      const routerCommand = mockPi.registerCommand.mock.calls[0][1];
      const mockCtx = buildMockCtx();

      // Death lands mid-switch AND the switch fails → the :275 gate must
      // skip the error notify; the command surfaces nothing either.
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return false;
      });

      await routerCommand.handler('profile balanced', mockCtx);

      // switchToRouterProfile returned false; handleProfile's success
      // notify did not fire; the router's own failure notify was gated.
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });

    it('should skip the session_start debug notify when the session dies during restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => {
        // Death lands mid-restore (index.ts:534).
        fireShutdown();
        return [
          {
            type: 'custom',
            customType: 'router-state',
            data: {
              enabled: true,
              selectedProfile: 'balanced',
              pinByProfile: {},
              thinkingByProfile: {},
              debugEnabled: true,
              timestamp: Date.now(),
            },
          },
        ];
      };

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Restore completed (mock ctx stays live) but the debug notify at
      // index.ts:535-540 was gated — no 'Router initialized' toast.
      expect(mockCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('Router initialized'),
        'info',
      );
    });

    it('should survive a stale delivered ctx in the model_select tail and still persist', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      mockCtx.ui.setStatus.mockClear();

      // Delivered-dead ctx: every getter throws (real dead-ctx shape —
      // pi runner.js ctx getters all throw after invalidation).
      const staleCtx = {
        get modelRegistry() {
          throw new Error(STALE_MESSAGE);
        },
        get cwd() {
          throw new Error(STALE_MESSAGE);
        },
        get ui() {
          throw new Error(STALE_MESSAGE);
        },
      };

      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        // Without the :569/:572 gates this rejects (ui getter throws);
        // with them the handler completes and still persists.
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          staleCtx,
        );
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
          lastNonRouterModel: 'anthropic/claude-3-5-sonnet',
        }),
      );
    });

    it('should skip the model_select status update when the session dies during the capacity refresh', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      mockCtx.ui.setStatus.mockClear();

      // Event model carries capacities that differ from the registry model
      // (undefined) → the capacity-refresh await at index.ts:561 runs.
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          {
            model: {
              provider: 'router',
              id: 'balanced',
              contextWindow: 999999,
              maxTokens: 9999,
            },
          },
          mockCtx,
        );
      }

      // Router branch completed (state already matched → persist may
      // dedupe), but the :572 gate skipped the status update.
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });

    it('should skip the turn_end status update when the session dies during the model restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // routerEnabled=true + non-router active model → turn_end restores
      // via `await setModelInternally` (index.ts:580).
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };
      mockCtx.ui.setStatus.mockClear();

      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }

      // persistState ran (snapshot may dedupe — enabled state unchanged);
      // the ctx-derived status update at index.ts:584 was skipped.
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });
  });

  it('should restore state from session on session_start hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();
    mockCtx.sessionManager.getBranch = () => [
      {
        type: 'custom',
        customType: 'router-state',
        data: {
          enabled: true,
          selectedProfile: 'balanced',
          pinByProfile: { balanced: 'high' },
          thinkingByProfile: {},
          debugEnabled: true,
          widgetEnabled: true,
          accumulatedCost: 0.012,
          timestamp: Date.now(),
        },
      },
    ];

    // Trigger session_start
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  it('should handle model select hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    // Trigger session_start to initialize first
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    const modelSelectHandlers = eventListeners['model_select'] || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
  });

  it('should enforce router model on turn_end hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    // Trigger session_start to initialize
    const sessionStartHandlers = eventListeners['session_start'] || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    // Now trigger model_select to select a router model
    const modelSelectHandlers = eventListeners['model_select'] || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    // Change current model to non-router model
    mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

    // Trigger turn_end
    const turnEndHandlers = eventListeners['turn_end'] || [];
    for (const handler of turnEndHandlers) {
      await handler({}, mockCtx);
    }

    // It should have restored model selection to the active router profile model
    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  describe('model_select event', () => {
    it('should set routerEnabled=false, record lastNonRouterModel, and call setHiddenThinkingLabel for non-router model', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize via session_start
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear appendEntry calls from initialization
      mockPi.appendEntry.mockClear();

      // Select a non-router model
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      // Should have called setHiddenThinkingLabel
      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

      // Should have persisted state (routerEnabled=false, lastNonRouterModel set)
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
          lastNonRouterModel: 'anthropic/claude-3-5-sonnet',
        }),
      );
    });

    it('should be a no-op before session_start (isInitialized=false)', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Clear calls from constructor
      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      // Trigger model_select WITHOUT session_start first
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      // Should NOT have persisted state or updated status
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
      expect(mockCtx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
    });
  });

  describe('thinking_level_select event', () => {
    it('should apply thinking level as all-tier override for active profile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize via session_start (sets routerEnabled=true, selectedProfile='balanced')
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear appendEntry calls from initialization
      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'high' }, mockCtx);
      }

      // Should persist state with thinking overrides for all tiers
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          thinkingByProfile: {
            balanced: { high: 'high', medium: 'high', low: 'high' },
          },
        }),
      );
    });

    it('should be ignored when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Set model to non-router so routerEnabled stays false after restore
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      // Initialize via session_start with non-router model
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'medium' }, mockCtx);
      }

      // Should NOT have called appendEntry (no persist because early return)
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it('should be ignored before initialization', () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      mockPi.appendEntry.mockClear();

      // Trigger thinking_level_select without session_start
      const thinkingHandlers = eventListeners['thinking_level_select'] || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'low' }, mockCtx);
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe('restoreStateFromSession edge cases', () => {
    it('should handle fresh session with no saved router-state entries', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Empty session
      mockCtx.sessionManager.getBranch = () => [];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should still set model (model is router/balanced by default)
      expect(mockPi.setModel).toHaveBeenCalled();
      // Should persist initial state
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
        }),
      );
    });

    it('should handle failed model restoration (setModel returns false)', async () => {
      mockPi.setModel = vi.fn().mockResolvedValue(false);
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should notify about failure
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore router/balanced'),
        'warning',
      );

      // routerEnabled should be set to false
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should handle router model unavailable in registry', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Registry returns undefined for router model
      mockCtx.modelRegistry.find = vi.fn().mockReturnValue(undefined);
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should notify about unavailability
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unable to restore router/balanced'),
        'warning',
      );

      // Should call setHiddenThinkingLabel
      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

      // routerEnabled should be false
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('should migrate legacy pinTier field to pinByProfile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinTier: 'medium',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Should persist with the legacy pinTier migrated into pinByProfile
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          pinByProfile: expect.objectContaining({ balanced: 'medium' }),
        }),
      );
    });

    it('should sync thinking level when lastDecision exists on successful restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const decision = {
        profile: 'balanced',
        tier: 'high' as const,
        phase: 'planning' as const,
        targetProvider: 'openai',
        targetModelId: 'gpt-4o',
        targetLabel: 'openai/gpt-4o',
        reasoning: 'test',
        thinking: 'high' as const,
        timestamp: Date.now(),
      };
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            lastDecision: decision,
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // setModel succeeds (default mock), lastDecision exists => should sync thinking level
      expect(mockPi.setThinkingLevel).toHaveBeenCalledWith('high');
    });
  });

  describe('turn_end event', () => {
    it('should persist state and update status but NOT restore model when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      // Set model to non-router
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      // Initialize via session_start with non-router model
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Clear mocks after initialization
      mockPi.setModel.mockClear();
      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      // Trigger turn_end
      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }

      // Should NOT call setModel (router is not enabled)
      expect(mockPi.setModel).not.toHaveBeenCalled();

      // Should still update status
      expect(mockCtx.ui.setStatus).toHaveBeenCalled();

      // persistState is called, but snapshot deduplication may skip appendEntry
      // since state hasn't changed since session_start. The key assertion is
      // that setModel was NOT called (router is not enabled).
    });
  });

  describe('persistState deduplication', () => {
    it('should only call appendEntry once when state has not changed between turn_end calls', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // Initialize with router enabled (default: model is router/balanced)
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Select router model to ensure routerEnabled=true
      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'router', id: 'balanced' } },
          mockCtx,
        );
      }

      // Clear mocks after initialization and model_select
      mockPi.appendEntry.mockClear();

      // Trigger turn_end — first call may persist if snapshot differs
      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterFirst = mockPi.appendEntry.mock.calls.length;

      // Trigger turn_end again — state is identical, snapshot dedup should skip
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterSecond = mockPi.appendEntry.mock.calls.length;

      // No additional appendEntry calls on the second turn_end
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  it('should write the module fallback on a before_provider_request capture and not poison it on stale ctx', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();
    const captureHandlers = eventListeners['before_provider_request'] || [];
    for (const handler of captureHandlers) {
      await handler({}, mockCtx);
    }
    expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);

    // Stale ctx after session replacement: ctx getters throw inside the try;
    // the fallback must keep the last good value (write stays in the try).
    const staleCtx = {
      get modelRegistry() {
        throw new Error(
          'This extension ctx is stale after session replacement',
        );
      },
      get cwd() {
        throw new Error(
          'This extension ctx is stale after session replacement',
        );
      },
    };
    for (const handler of captureHandlers) {
      handler({}, staleCtx);
    }
    expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);
  });

  it('should capture the registry on turn_start', async () => {
    routerExtension(mockPi);

    const turnStartHandlers = eventListeners['turn_start'] || [];
    expect(turnStartHandlers.length).toBeGreaterThan(0);

    // No session_start first: capture must land in a never-initialized closure.
    const mockCtx = buildMockCtx();
    for (const handler of turnStartHandlers) {
      await handler(
        { type: 'turn_start', turnIndex: 0, timestamp: Date.now() },
        mockCtx,
      );
    }
    expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);
  });
});
