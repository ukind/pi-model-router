import { describe, it, expect, vi } from 'vitest';
import {
  extractTextFromContent,
  getLastUserText,
  getRecentConversationText,
  countToolResults,
  countWords,
  hasImageAttachment,
  phaseForTier,
  resolveAvailableTier,
  buildRoutingDecision,
  buildDelegationTierChain,
  decideRouting,
  parseClassifierOutput,
  runClassifier,
} from './routing';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message, UserMessage } from '@earendil-works/pi-ai';
import type { RouterProfile, RoutingRule, ClassifierResult } from './types';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

describe('routing.ts', () => {
  describe('extractTextFromContent', () => {
    it('should return string directly if content is string', () => {
      expect(extractTextFromContent('hello world')).toBe('hello world');
    });

    it('should extract text and toolCall parts from message structure', () => {
      const parts: Message['content'] = [
        { type: 'text' as const, text: 'some text' },
        { type: 'thinking' as const, thinking: 'some thought' },
        {
          type: 'toolCall' as const,
          id: 'call_1',
          name: 'write_file',
          arguments: { path: 'file.txt' },
        },
      ];
      const result = extractTextFromContent(parts);
      expect(result).toContain('some text');
      expect(result).toContain('some thought');
      expect(result).toContain('write_file {"path":"file.txt"}');
    });
  });

  describe('getLastUserText', () => {
    it('should return empty string if no messages', () => {
      const context: Context = { messages: [] };
      expect(getLastUserText(context)).toBe('');
    });

    it('should extract the last user message text', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'first user', timestamp: Date.now() },
          {
            role: 'assistant',
            content: 'assistant response',
            timestamp: Date.now(),
          } as unknown as Message,
          { role: 'user', content: 'second user', timestamp: Date.now() },
          {
            role: 'assistant',
            content: 'another assistant',
            timestamp: Date.now(),
          } as unknown as Message,
        ],
      };
      expect(getLastUserText(context)).toBe('second user');
    });
  });

  describe('getRecentConversationText', () => {
    it('should combine last N messages in lowercase', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'First', timestamp: Date.now() },
          { role: 'user', content: 'Second', timestamp: Date.now() },
          { role: 'user', content: 'Third', timestamp: Date.now() },
        ],
      };
      const result = getRecentConversationText(context, 2);
      expect(result).toBe('second\nthird');
    });
  });

  describe('countToolResults', () => {
    it('should count messages with role toolResult', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'hey', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: '1',
            toolName: 't',
            content: 'result 1',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
          { role: 'user', content: 'ok', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: '2',
            toolName: 't',
            content: 'result 2',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
        ],
      };
      expect(countToolResults(context)).toBe(2);
    });
  });

  describe('countWords', () => {
    it('should count words correctly', () => {
      expect(countWords('   one two   three\nfour ')).toBe(4);
      expect(countWords('')).toBe(0);
    });
  });

  describe('hasImageAttachment', () => {
    it('should return true if any message contains image part', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image' as const },
            ] as unknown as UserMessage['content'],
            timestamp: Date.now(),
          },
        ],
      };
      expect(hasImageAttachment(context)).toBe(true);
    });

    it('should return false if no image part exists', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'text message', timestamp: Date.now() },
        ],
      };
      expect(hasImageAttachment(context)).toBe(false);
    });
  });

  describe('phaseForTier', () => {
    it('should return correct phase for tier', () => {
      expect(phaseForTier('high')).toBe('planning');
      expect(phaseForTier('medium')).toBe('implementation');
      expect(phaseForTier('low')).toBe('lightweight');
    });
  });

  describe('resolveAvailableTier', () => {
    it('should return preferred if available', () => {
      expect(
        resolveAvailableTier(
          { high: { model: 'a' }, medium: { model: 'b' } },
          'high',
        ),
      ).toBe('high');
    });

    it('should fall up if preferred is unavailable', () => {
      expect(resolveAvailableTier({ high: { model: 'a' } }, 'low')).toBe(
        'high',
      );
    });

    it('should fall down if falling up finds nothing', () => {
      expect(resolveAvailableTier({ low: { model: 'a' } }, 'medium')).toBe(
        'low',
      );
    });
  });

  describe('buildRoutingDecision', () => {
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o-pro', thinking: 'high' },
    };

    it('should construct correct decision object', () => {
      const decision = buildRoutingDecision(
        'balanced',
        profile,
        'high',
        'planning',
        'Reasoning string',
      );
      expect(decision.profile).toBe('balanced');
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.targetProvider).toBe('openai');
      expect(decision.targetModelId).toBe('gpt-4o-pro');
      expect(decision.targetLabel).toBe('openai/gpt-4o-pro');
      expect(decision.thinking).toBe('high');
      expect(decision.reasoning).toBe('Reasoning string');
    });

    it('should throw if tier is not in profile', () => {
      expect(() =>
        buildRoutingDecision(
          'balanced',
          profile,
          'medium',
          'implementation',
          'Reason',
        ),
      ).toThrow();
    });
  });

  describe('decideRouting', () => {
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o', resolvedContextWindow: 100 },
      medium: { model: 'openai/gpt-4o-mini', resolvedContextWindow: 100 },
      low: { model: 'openai/gpt-4o-micro', resolvedContextWindow: 100 },
    };

    const rules: RoutingRule[] = [
      { matches: 'force-high', tier: 'high', reason: 'High rule' },
    ];

    it('should respect manual pinned tier', () => {
      const context: Context = {
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      };
      const decision = decideRouting(context, 'p', profile, undefined, 'high');
      expect(decision.tier).toBe('high');
      expect(decision.reasoning).toContain('Pinned to high tier');
    });

    it('should match custom rule first', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rules,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should match custom rule case-insensitively', () => {
      const rulesWithCapitalCase = [
        { matches: 'Force-High', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithCapitalCase,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should collect all matching rules and pick the highest tier', () => {
      const rulesWithMultipleMatches = [
        { matches: 'summary', tier: 'low' as const, reason: 'Low rule' },
        { matches: 'refactor', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please summarize the refactor',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithMultipleMatches,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toBe('High rule');
    });

    it('should route explicit high/low hints', () => {
      const contextHigh: Context = {
        messages: [
          {
            role: 'user',
            content: 'think hard step by step',
            timestamp: Date.now(),
          },
        ],
      };
      const decisionHigh = decideRouting(contextHigh, 'p', profile, undefined);
      expect(decisionHigh.tier).toBe('high');

      const contextLow: Context = {
        messages: [
          { role: 'user', content: 'fast summary', timestamp: Date.now() },
        ],
      };
      const decisionLow = decideRouting(contextLow, 'p', profile, undefined);
      expect(decisionLow.tier).toBe('low');
    });

    it('should downgrade high to medium if budget is exceeded', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'think hard', timestamp: Date.now() },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true,
      );
      expect(decision.tier).toBe('medium');
      expect(decision.isBudgetForced).toBe(true);
    });

    it('should mark isBudgetForced when tier is already low and budget is exceeded (Q3 floor)', () => {
      // Short prompt with no high-hint / implementation / planning / lookup
      // keywords. Falls through the heuristic to the `wordCount <= lowThreshold`
      // branch which picks tier='low'.
      const context: Context = {
        messages: [
          { role: 'user', content: 'hi there', timestamp: Date.now() },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true, // isBudgetExceeded
      );
      expect(decision.tier).toBe('low');
      expect(decision.isBudgetForced).toBe(true);
      expect(decision.reasoning).toContain('lowest tier');
      // Phase remains whatever the lightweight heuristic picked.
      expect(decision.phase).toBe('lightweight');
    });

    it('should maintain planning phase bias (stickiness)', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'how to design this',
            timestamp: Date.now(),
          },
          {
            role: 'user',
            content: 'we should design X',
            timestamp: Date.now(),
          },
          { role: 'user', content: 'why X?', timestamp: Date.now() },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'Initial plan',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
    });

    it('should keep planning phase bias when previous phase was planning, no tools, and word count > lowThreshold', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'what about this particular scenario that we discussed earlier today',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'Previous planning',
      );
      const decision = decideRouting(
        context,
        'p',
        profile,
        previous,
        undefined,
        undefined,
        0.5,
      );
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.reasoning).toContain('planning-phase bias');
    });

    it('should detect implementation from previous implementation phase', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'medium',
        'implementation',
        'Previous impl',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should detect implementation from toolResultCount > 0', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
          {
            role: 'toolResult',
            toolCallId: '1',
            toolName: 'read_file',
            content: 'file contents',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
          {
            role: 'user',
            content: 'looks good proceed',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should detect implementation from recent conversation containing plan:', () => {
      const context: Context = {
        messages: [
          {
            role: 'assistant',
            content: 'Plan:\n1. Do X\n2. Do Y',
            timestamp: Date.now(),
          } as unknown as Message,
          {
            role: 'user',
            content: 'sounds good lets go',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
    });

    it('should default to medium tier when no heuristic rules match for moderate-length prompts', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'i wonder about some random topic that doesnt match any particular keyword category here today now',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.reasoning).toContain('Defaulted to medium');
    });

    // --- Phase 3: veto gate + phase decoupling ---
    const classifierHigh = (): ClassifierResult => ({
      tier: 'high',
      confidence: 'high',
      reasoning: 'Architectural.',
      rawText: 'Tier: high',
      failureReason: 'success',
    });
    const classifierLow = (): ClassifierResult => ({
      tier: 'low',
      confidence: 'high',
      reasoning: 'Simple.',
      rawText: 'Tier: low',
      failureReason: 'success',
    });
    const classifierMedium = (): ClassifierResult => ({
      tier: 'medium',
      confidence: 'medium',
      reasoning: 'Normal coding.',
      rawText: 'Tier: medium',
      failureReason: 'success',
    });

    it('veto: ultrathink + classifier low → high, isVetoed true', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ultrathink this through',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierLow(),
      );
      expect(decision.tier).toBe('high');
      expect(decision.isVetoed).toBe(true);
      expect(decision.vetoReason).toBe('explicit-hint');
      expect(decision.reasoning).toContain('vetoed');
    });

    it('veto: fast + classifier high → low, isVetoed true', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'fast answer please',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierHigh(),
      );
      expect(decision.tier).toBe('low');
      expect(decision.isVetoed).toBe(true);
      expect(decision.vetoReason).toBe('explicit-hint');
    });

    it('no veto when classifier agrees with hint (high hint + classifier high)', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ultrathink the architecture',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierHigh(),
      );
      expect(decision.tier).toBe('high');
      expect(decision.isVetoed).toBeUndefined();
    });

    it('no veto when no explicit hint present', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'implement the feature',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierMedium(),
      );
      expect(decision.tier).toBe('medium');
      expect(decision.isVetoed).toBeUndefined();
    });

    it('phase: classifier medium during planning → phase stays planning', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'implement the feature now',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'Previous planning',
      );
      const decision = decideRouting(
        context,
        'p',
        profile,
        previous,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierMedium(),
      );
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('planning');
    });

    it('phase: falls back to phaseForTier when no previous decision', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'implement the feature now',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierMedium(),
      );
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
    });

    it('threads classifier provenance onto decision', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'implement the feature now',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        false,
        classifierMedium(),
      );
      expect(decision.confidence).toBe('medium');
      expect(decision.rawText).toBe('Tier: medium');
      expect(decision.failureReason).toBe('success');
      expect(decision.isClassifier).toBe(true);
    });

    describe('word-boundary veto', () => {
      it('does not false-veto high when "smallest" contains "small"', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content: 'smallest possible deployment footprint',
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(
          context,
          'p',
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          undefined,
          false,
          classifierHigh(),
        );
        expect(decision.tier).toBe('high');
        expect(decision.isVetoed).toBeUndefined();
      });

      it('matches phrase hints via substring fallback', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content: 'step by step please',
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(
          context,
          'p',
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          undefined,
          false,
          classifierLow(),
        );
        expect(decision.tier).toBe('high');
        expect(decision.isVetoed).toBe(true);
        expect(decision.vetoReason).toBe('explicit-hint');
      });
    });
  });

  describe('parseClassifierOutput', () => {
    it('parses clean 3-line format', () => {
      const result = parseClassifierOutput(
        'Tier: high\nConfidence: high\nReasoning: Needs deep reasoner.',
      );
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
      expect(result.reasoning).toBe('Needs deep reasoner.');
      expect(result.failureReason).toBe('success');
    });

    it('parses 2-line format (missing confidence) — defaults medium', () => {
      const result = parseClassifierOutput(
        'Tier: high\nReasoning: Complex task.',
      );
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('medium');
      expect(result.failureReason).toBe('success');
    });

    it('strips markdown bold (**Tier:**)', () => {
      const result = parseClassifierOutput(
        '**Tier:** high\n**Confidence:** high\n**Reasoning:** Deep.',
      );
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('high');
    });

    it('strips trailing punctuation (high.)', () => {
      const result = parseClassifierOutput('Tier: high.\nReasoning: Hard.');
      expect(result.tier).toBe('high');
    });

    it('handles multi-word tier (high priority → high)', () => {
      const result = parseClassifierOutput(
        'Tier: high priority\nReasoning: Architectural.',
      );
      expect(result.tier).toBe('high');
    });

    it('handles empty tier value (Tier:)', () => {
      const result = parseClassifierOutput('Tier: \nReasoning: none.');
      expect(result.failureReason).toBe('unparseable');
      expect(result.tier).toBeUndefined();
    });

    it('handles \\r\\n line endings', () => {
      const result = parseClassifierOutput(
        'Tier: high\r\nConfidence: low\r\nReasoning: Simple.',
      );
      expect(result.tier).toBe('high');
      expect(result.confidence).toBe('low');
    });

    it('handles partial final chunk (Tier: hi)', () => {
      const result = parseClassifierOutput('Tier: hi');
      expect(result.failureReason).toBe('unparseable');
    });

    it("preserves colons in reasoning (It's: complicated)", () => {
      const result = parseClassifierOutput(
        "Tier: medium\nReasoning: It's: complicated.",
      );
      expect(result.tier).toBe('medium');
      expect(result.reasoning).toBe("It's: complicated.");
    });

    it('returns unparseable for no tier line', () => {
      const result = parseClassifierOutput('Invalid response format');
      expect(result.failureReason).toBe('unparseable');
    });

    it('defaults confidence to medium on invalid value', () => {
      const result = parseClassifierOutput(
        'Tier: low\nConfidence: extreme\nReasoning: Fast.',
      );
      expect(result.confidence).toBe('medium');
      expect(result.tier).toBe('low');
    });
  });

  describe('runClassifier', () => {
    const mockRegistry = {
      find: (provider: string, modelId: string) => {
        if (
          provider === 'openai' &&
          (modelId === 'gpt-4o' || modelId === 'no-key-model')
        ) {
          return { provider, id: modelId, reasoning: true } as any;
        }
        if (provider === 'google' && modelId === 'gemini-flash') {
          return { provider, id: modelId, reasoning: false } as any;
        }
        return undefined;
      },
      getApiKeyAndHeaders: async (model: any) => {
        if (model.id === 'no-key-model') {
          return { ok: false, error: 'missing key' } as any;
        }
        return { ok: true as const, apiKey: 'test-key', headers: {} };
      },
    } as any;

    const context: Context = {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    };

    it('returns structured ClassifierResult from 3-line stream', async () => {
      const mockStream = (async function* () {
        yield {
          type: 'text_delta',
          delta: 'Tier: high\nConfidence: high\nReasoning: Deep.',
        };
      })();
      vi.mocked(streamSimple).mockReturnValue(mockStream as any);

      const result = await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
        'planning',
        'high',
      );
      expect(result).toEqual({
        tier: 'high',
        confidence: 'high',
        reasoning: 'Deep.',
        rawText: 'Tier: high\nConfidence: high\nReasoning: Deep.',
        failureReason: 'success',
      });
    });

    it('returns undefined when all refs fail (model-not-found)', async () => {
      const result = await runClassifier(
        ['openai/nonexistent'],
        mockRegistry,
        context,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when auth fails on all refs', async () => {
      const result = await runClassifier(
        ['openai/no-key-model'],
        mockRegistry,
        context,
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when stream yields unparseable output on all refs', async () => {
      const mockStream = (async function* () {
        yield { type: 'text_delta', delta: 'Garbage response' };
      })();
      vi.mocked(streamSimple).mockReturnValue(mockStream as any);
      const result = await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
      );
      expect(result).toBeUndefined();
    });

    it('retries next ref on infrastructure failure (first missing, second succeeds)', async () => {
      const mockStream = (async function* () {
        yield {
          type: 'text_delta',
          delta: 'Tier: low\nConfidence: high\nReasoning: Simple.',
        };
      })();
      vi.mocked(streamSimple).mockReturnValue(mockStream as any);
      const result = await runClassifier(
        ['openai/nonexistent', 'openai/gpt-4o'],
        mockRegistry,
        context,
      );
      expect(result?.tier).toBe('low');
      expect(result?.failureReason).toBe('success');
    });

    it('retries next ref on pre-content stream error', async () => {
      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation((() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield { type: 'error', error: { errorMessage: 'rate limited' } };
          })();
        }
        return (async function* () {
          yield {
            type: 'text_delta',
            delta: 'Tier: medium\nConfidence: medium\nReasoning: Normal.',
          };
        })();
      }) as any);
      const result = await runClassifier(
        ['openai/gpt-4o', 'google/gemini-flash'],
        mockRegistry,
        context,
      );
      expect(result?.tier).toBe('medium');
      expect(callCount).toBe(2);
    });

    it('does NOT retry after content received (mid-stream error — partial text parsed)', async () => {
      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation((() => {
        callCount++;
        return (async function* () {
          yield { type: 'text_delta', delta: 'Tier: high' };
          yield {
            type: 'error',
            error: { errorMessage: 'mid-stream failure' },
          };
        })();
      }) as any);
      const result = await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
      );
      expect(result?.tier).toBe('high');
      expect(callCount).toBe(1);
    });
  });

  describe('buildDelegationTierChain', () => {
    it('high, non-budget → [high, medium, low]', () => {
      expect(buildDelegationTierChain('high', false)).toEqual([
        'high',
        'medium',
        'low',
      ]);
    });

    it('high, budget → [high, medium, low]', () => {
      expect(buildDelegationTierChain('high', true)).toEqual([
        'high',
        'medium',
        'low',
      ]);
    });

    it('medium, non-budget → [medium, low, high]', () => {
      expect(buildDelegationTierChain('medium', false)).toEqual([
        'medium',
        'low',
        'high',
      ]);
    });

    it('medium, budget → [medium, low]', () => {
      expect(buildDelegationTierChain('medium', true)).toEqual([
        'medium',
        'low',
      ]);
    });

    it('low, non-budget → [low, medium, high]', () => {
      expect(buildDelegationTierChain('low', false)).toEqual([
        'low',
        'medium',
        'high',
      ]);
    });

    it('low, budget → [low]', () => {
      expect(buildDelegationTierChain('low', true)).toEqual(['low']);
    });
  });
});
