import { describe, it, expect, vi } from 'vitest';
import { registerCommands } from './commands';
import type {
  RouterConfig,
  RoutingDecision,
  RouterPinByProfile,
  RouterThinkingByProfile,
} from './types';

describe('commands.ts', () => {
  const buildMockPi = () => {
    let registeredCommand: any = null;
    return {
      registerCommand: (name: string, cmd: any) => {
        if (name === 'router') {
          registeredCommand = cmd;
        }
      },
      setModel: vi.fn().mockResolvedValue(true),
      getRegisteredCommand: () => registeredCommand,
    };
  };

  const buildMockCtx = () => ({
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    modelRegistry: {
      find: vi.fn().mockImplementation((provider: string, modelId: string) => {
        if (provider === 'router' || provider === 'openai') {
          return { provider, id: modelId };
        }
        return null;
      }),
    },
    model: { provider: 'router', id: 'balanced' },
  });

  const buildDefaultState = () => {
    const config: RouterConfig = {
      phaseBias: 0.5,
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
        cheap: {
          low: { model: 'openai/gpt-4o-micro' },
        },
      },
    };

    const lastDecision: RoutingDecision = {
      profile: 'balanced',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'openai',
      targetModelId: 'gpt-4o-mini',
      targetLabel: 'openai/gpt-4o-mini',
      reasoning: 'Default reasoning',
      thinking: 'medium',
      timestamp: Date.now(),
    };

    return {
      currentConfig: config,
      routerEnabled: true,
      selectedProfile: 'balanced',
      pinnedTierByProfile: {} as RouterPinByProfile,
      thinkingByProfile: {} as RouterThinkingByProfile,
      lastDecision,
      lastNonRouterModel: 'openai/gpt-4o',
      accumulatedCost: 0.05,
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [lastDecision],
      lastConfigWarnings: [],
    };
  };

  const buildMockActions = () => ({
    persistState: vi.fn(),
    updateStatus: vi.fn(),
    reloadConfig: vi.fn(),
    ensureValidActiveRouterProfile: vi.fn(),
    switchToRouterProfile: vi.fn().mockResolvedValue(true),
    syncPiThinkingLevel: vi.fn(),
  });

  describe('Registration & Subcommand Completion', () => {
    it('should register router command', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi as any, state as any, actions as any);
      expect(pi.getRegisteredCommand()).toBeDefined();
    });

    it('should autocomplete subcommands', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('');
      expect(completions).toBeDefined();
      const names = completions.map((c: any) => c.value);
      expect(names).toContain('status');
      expect(names).toContain('profile');
      expect(names).toContain('pin');
    });

    it('should autocomplete profile names', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('profile ');
      expect(completions).toBeDefined();
      const values = completions.map((c: any) => c.value);
      expect(values).toContain('profile balanced');
      expect(values).toContain('profile cheap');
    });

    it('should autocomplete pin arguments', () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      const completions = cmd.getArgumentCompletions('pin ');
      expect(completions).toBeDefined();
      const values = completions.map((c: any) => c.value);
      expect(values).toContain('pin auto');
      expect(values).toContain('pin high');
      expect(values).not.toContain('pin balanced');
    });
  });

  describe('Handler Subcommands', () => {
    it('should handle /router status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx as any);
      expect(ctx.ui.notify).toHaveBeenCalled();
      const notifyMessage = ctx.ui.notify.mock.calls[0][0];
      expect(notifyMessage).toContain('Model Router Status:');
      expect(notifyMessage).toContain('Selected profile: balanced');
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router profile switch', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('profile cheap', ctx as any);
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Switched to router profile'),
        'info',
      );
    });

    it('should handle /router pin', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin high', ctx as any);
      expect(state.pinnedTierByProfile.balanced).toBe('high');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Router pinned to high',
        'info',
      );

      // Clear pin
      await cmd.handler('pin auto', ctx as any);
      expect(state.pinnedTierByProfile.balanced).toBeUndefined();
    });

    it('should handle /router thinking', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('thinking high xhigh', ctx as any);
      expect(state.thinkingByProfile.balanced?.high).toBe('xhigh');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router disable', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx as any);
      expect(pi.setModel).toHaveBeenCalledWith({
        provider: 'openai',
        id: 'gpt-4o',
      });
      expect(state.routerEnabled).toBe(false);
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router fix', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix low', ctx as any);
      expect(state.pinnedTierByProfile.balanced).toBe('low');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('should handle /router widget toggles', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('widget on', ctx as any);
      expect(state.widgetEnabled).toBe(true);

      await cmd.handler('widget off', ctx as any);
      expect(state.widgetEnabled).toBe(false);
    });

    it('should handle /router debug history control', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug show', ctx as any);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Recent Routing Decisions'),
        'info',
      );

      await cmd.handler('debug clear', ctx as any);
      expect(state.debugHistory.length).toBe(0);
    });

    it('should handle /router reload config', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as any, state as any, actions as any);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('reload', ctx as any);
      expect(actions.reloadConfig).toHaveBeenCalledWith(ctx, {
        preserveDebug: true,
      });
      expect(actions.ensureValidActiveRouterProfile).toHaveBeenCalledWith(ctx);
    });
  });
});
