import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getUnsupportedTiers: () => [] as string[],
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
      appendEntry: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (!eventListeners[event]) {
          eventListeners[event] = [];
        }
        eventListeners[event].push(handler);
      }),
    };
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
});
