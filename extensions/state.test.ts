import { describe, it, expect } from 'vitest';
import { isRouterPersistedState, buildPersistedState } from './state';
import type { RoutingDecision } from './types';

describe('state.ts', () => {
  describe('isRouterPersistedState', () => {
    it('should return false for non-objects or null', () => {
      expect(isRouterPersistedState(null)).toBe(false);
      expect(isRouterPersistedState('string')).toBe(false);
      expect(isRouterPersistedState(123)).toBe(false);
    });

    it('should return false if required properties are missing or wrong type', () => {
      expect(isRouterPersistedState({ enabled: true })).toBe(false);
      expect(
        isRouterPersistedState({
          enabled: 'yes',
          selectedProfile: 'p',
          timestamp: 123,
        }),
      ).toBe(false);
    });

    it('should return true for valid persisted state objects', () => {
      const state = {
        enabled: true,
        selectedProfile: 'balanced',
        timestamp: Date.now(),
      };
      expect(isRouterPersistedState(state)).toBe(true);
    });

    it('should reject invalid pinByProfile values', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          pinByProfile: { p: 'ultra' },
        }),
      ).toBe(false);
    });

    it('should reject NaN accumulatedCost', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          accumulatedCost: NaN,
        }),
      ).toBe(false);
    });

    it('should reject Infinity accumulatedCost', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          accumulatedCost: Infinity,
        }),
      ).toBe(false);
    });

    it('should accept state without accumulatedCost (undefined is valid)', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
        }),
      ).toBe(true);
    });

    it('should accept valid state with all optional fields', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          pinByProfile: { p: 'high' },
          thinkingByProfile: { p: { high: 'xhigh' } },
          pinTier: 'high',
          debugEnabled: true,
          widgetEnabled: false,
          lastNonRouterModel: 'openai/gpt-4o',
          accumulatedCost: 0.5,
          lastDecision: {
            profile: 'x',
            tier: 'high',
            timestamp: 1,
          },
        }),
      ).toBe(true);
    });

    it('should reject invalid thinkingByProfile inner level', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          thinkingByProfile: { p: { high: 'super-high' } },
        }),
      ).toBe(false);
    });

    it('should reject invalid pinTier', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          pinTier: 'ultra',
        }),
      ).toBe(false);
    });

    it('should reject invalid lastDecision shape', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          lastDecision: { profile: 'x' },
        }),
      ).toBe(false);
    });
  });

  describe('buildPersistedState', () => {
    it('should build a state object matching the interface requirements', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Rules matched',
        thinking: 'high',
        timestamp: Date.now(),
      };

      const state = buildPersistedState(
        true,
        'balanced',
        { balanced: 'high' },
        { balanced: { high: 'xhigh' } },
        true,
        false,
        [decision],
        decision,
        'openai/gpt-4o',
        0.0045,
      );

      expect(state.enabled).toBe(true);
      expect(state.selectedProfile).toBe('balanced');
      expect(state.pinTier).toBe('high');
      expect(state.pinByProfile).toEqual({ balanced: 'high' });
      expect(state.thinkingByProfile).toEqual({ balanced: { high: 'xhigh' } });
      expect(state.debugEnabled).toBe(true);
      expect(state.widgetEnabled).toBe(false);
      expect(state.debugHistory).toEqual([decision]);
      expect(state.lastPhase).toBe('planning');
      expect(state.lastDecision).toEqual(decision);
      expect(state.lastNonRouterModel).toBe('openai/gpt-4o');
      expect(state.accumulatedCost).toBe(0.0045);
      expect(state.timestamp).toBeGreaterThan(0);
    });

    it('should handle undefined selectedProfile', () => {
      const state = buildPersistedState(
        false,
        undefined,
        {},
        {},
        false,
        false,
        [],
        undefined,
        undefined,
        0,
      );
      expect(state.selectedProfile).toBe('');
      expect(state.pinTier).toBeUndefined();
    });
  });
});
