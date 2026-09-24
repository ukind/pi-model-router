import { describe, it, expect } from 'vitest';
import {
  isRouterPersistedState,
  sanitizeRoutingDecisionFields,
  buildPersistedState,
} from './state';
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

    it('should still reject lastDecision with bad required fields', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          lastDecision: { profile: 'x' }, // missing tier + timestamp
        }),
      ).toBe(false);
    });

    it('should ACCEPT lastDecision with bad optional fields (per-field drop)', () => {
      // Q2: a corrupt optional flag no longer discards the whole state.
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          lastDecision: {
            profile: 'x',
            tier: 'high',
            timestamp: 1,
            isPinned: 'yes', // invalid type — sanitizer will strip
            phase: 'running', // invalid — sanitizer will default to 'implementation'
          },
        }),
      ).toBe(true);
    });

    it('accepts calibration entries carrying a valid classifierCriterion', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          classifierCalibration: [
            {
              promptSummary: 'where is the config loader defined',
              classifierTier: 'low',
              classifierCriterion: 'lookup',
              finalTier: 'low',
              userCorrection: true,
              timestamp: 1,
            },
          ],
        }),
      ).toBe(true);
    });

    it('rejects calibration entries with an invalid classifierCriterion', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          classifierCalibration: [
            {
              promptSummary: 'bad shape',
              classifierTier: 'medium',
              classifierCriterion: 'gigantic',
              finalTier: 'high',
              userCorrection: true,
              timestamp: 1,
            },
          ],
        }),
      ).toBe(false);
    });

    it('accepts old tier-only calibration entries (no criterion)', () => {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'x',
          timestamp: 1,
          classifierCalibration: [
            {
              promptSummary: 'old turn',
              classifierTier: 'medium',
              finalTier: 'low',
              userCorrection: true,
              timestamp: 1,
            },
          ],
        }),
      ).toBe(true);
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
        [],
      );

      expect(state.enabled).toBe(true);
      expect(state.selectedProfile).toBe('balanced');
      expect(state.pinTier).toBe('high');
      expect(state.pinByProfile).toEqual({ balanced: 'high' });
      expect(state.thinkingByProfile).toEqual({ balanced: { high: 'xhigh' } });
      expect(state.debugEnabled).toBe(true);
      expect(state.widgetEnabled).toBe(false);
      expect(state.debugHistory).toEqual([decision]);
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
        [],
      );
      expect(state.selectedProfile).toBe('');
      expect(state.pinTier).toBeUndefined();
    });
  });

  describe('sanitizeRoutingDecisionFields', () => {
    const minimal = {
      profile: 'balanced',
      tier: 'high' as const,
      timestamp: 1700000000000,
    };

    it('accepts a minimal decision (only required fields)', () => {
      const out = sanitizeRoutingDecisionFields(minimal);
      expect(out).toBeDefined();
      expect(out?.profile).toBe('balanced');
      expect(out?.tier).toBe('high');
      expect(out?.timestamp).toBe(1700000000000);
      expect(out?.phase).toBe('implementation');
      expect(out?.targetProvider).toBe('');
      expect(out?.targetModelId).toBe('');
      expect(out?.targetLabel).toBe('');
      expect(out?.reasoning).toBe('');
      expect(out?.thinking).toBe('medium');
    });

    it('preserves all valid optional fields', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        phase: 'planning',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o',
        targetLabel: 'openai/gpt-4o',
        reasoning: 'rules matched',
        thinking: 'high',
        isClassifier: true,
        isFallback: false,
        isBudgetForced: false,
        isRuleMatched: true,
        isPinned: false,
        isVetoed: false,
        vetoReason: 'explicit-hint',
        confidence: 'high',
        confidenceNumeric: 0.87,
        rawText: 'tier: high',
        failureReason: 'success',
      });
      expect(out?.phase).toBe('planning');
      expect(out?.thinking).toBe('high');
      expect(out?.isClassifier).toBe(true);
      expect(out?.isRuleMatched).toBe(true);
      expect(out?.vetoReason).toBe('explicit-hint');
      expect(out?.confidence).toBe('high');
      expect(out?.confidenceNumeric).toBe(0.87);
      expect(out?.rawText).toBe('tier: high');
      expect(out?.failureReason).toBe('success');
    });

    it('drops invalid confidenceNumeric but keeps a valid one', () => {
      const nan = sanitizeRoutingDecisionFields({
        ...minimal,
        confidenceNumeric: Number.NaN,
      });
      expect(nan?.confidenceNumeric).toBeUndefined();

      const infinity = sanitizeRoutingDecisionFields({
        ...minimal,
        confidenceNumeric: Number.POSITIVE_INFINITY,
      });
      expect(infinity?.confidenceNumeric).toBeUndefined();

      const wrongType = sanitizeRoutingDecisionFields({
        ...minimal,
        confidenceNumeric: '0.9',
      });
      expect(wrongType?.confidenceNumeric).toBeUndefined();

      const valid = sanitizeRoutingDecisionFields({
        ...minimal,
        confidenceNumeric: 0.87,
      });
      expect(valid?.confidenceNumeric).toBe(0.87);
    });

    it('drops invalid boolean flags but keeps the rest', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        isPinned: 'yes', // not a boolean
        isClassifier: 1, // not a boolean
        isBudgetForced: true, // valid
      });
      expect(out?.isPinned).toBeUndefined();
      expect(out?.isClassifier).toBeUndefined();
      expect(out?.isBudgetForced).toBe(true);
    });

    it('defaults invalid string fields to "" but keeps the rest', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        targetProvider: 123, // not a string
        targetLabel: 'openai/gpt-4o', // valid
        reasoning: null, // not a string
      });
      expect(out?.targetProvider).toBe('');
      expect(out?.targetLabel).toBe('openai/gpt-4o');
      expect(out?.reasoning).toBe('');
    });

    it('defaults invalid phase to "implementation" and invalid thinking to "medium"', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        phase: 'running',
        thinking: 'super-high',
      });
      expect(out?.phase).toBe('implementation');
      expect(out?.thinking).toBe('medium');
    });

    it('rejects (returns undefined) when profile is missing', () => {
      expect(
        sanitizeRoutingDecisionFields({ tier: 'high', timestamp: 1 }),
      ).toBeUndefined();
    });

    it('rejects (returns undefined) when tier is invalid', () => {
      expect(
        sanitizeRoutingDecisionFields({
          profile: 'x',
          tier: 'ultra',
          timestamp: 1,
        }),
      ).toBeUndefined();
    });

    it('rejects (returns undefined) when timestamp is not a number', () => {
      expect(
        sanitizeRoutingDecisionFields({
          profile: 'x',
          tier: 'high',
          timestamp: '1',
        }),
      ).toBeUndefined();
    });

    it('rejects (returns undefined) when value is not an object', () => {
      expect(sanitizeRoutingDecisionFields('nope')).toBeUndefined();
      expect(sanitizeRoutingDecisionFields(null)).toBeUndefined();
      expect(sanitizeRoutingDecisionFields(undefined)).toBeUndefined();
    });

    it('drops invalid confidence / vetoReason / failureReason but keeps the rest', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        confidence: 'super-high', // invalid
        vetoReason: 'something-else', // invalid
        failureReason: 'crashed', // invalid
      });
      expect(out?.confidence).toBeUndefined();
      expect(out?.vetoReason).toBeUndefined();
      expect(out?.failureReason).toBeUndefined();
    });

    it('preserves a valid classifierCriterion and drops an invalid one', () => {
      const valid = sanitizeRoutingDecisionFields({
        ...minimal,
        classifierCriterion: 'lookup',
      });
      expect(valid?.classifierCriterion).toBe('lookup');

      const invalid = sanitizeRoutingDecisionFields({
        ...minimal,
        classifierCriterion: 'gigantic',
      });
      expect(invalid?.classifierCriterion).toBeUndefined();
      expect(invalid?.tier).toBe('high'); // the rest of the decision survives
    });

    it('keeps old tier-only decisions unchanged (no criterion field)', () => {
      const out = sanitizeRoutingDecisionFields({
        ...minimal,
        classifierTier: 'high',
      });
      expect(out?.classifierTier).toBe('high');
      expect(out?.classifierCriterion).toBeUndefined();
    });
  });
});
