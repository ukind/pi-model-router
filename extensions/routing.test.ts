import { describe, it, expect, vi, afterEach } from 'vitest';
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
  buildClassifierPrompt,
  decideRouting,
  parseClassifierOutput,
  runClassifier,
  raceStallTimeout,
  stallGuardedStream,
} from './routing';
import { readFileSync } from 'node:fs';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message, UserMessage } from '@earendil-works/pi-ai';
import type {
  RouterProfile,
  RoutingRule,
  RouterTier,
  ClassifierResult,
} from './types';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

// The Jev key can come from a file in the agent dir. Stub the fs read, so the
// harness stays hermetic on a machine that holds a real key file.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT: typesafe_api_key');
  }),
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

    describe('numeric confidence floors (additive seam)', () => {
      const numeric = (tier: RouterTier, n: number): ClassifierResult => ({
        tier,
        confidence: n >= 0.8 ? 'high' : n >= 0.5 ? 'medium' : 'low',
        confidenceNumeric: n,
        reasoning: 'Jev classified.',
        rawText: 'answers',
        failureReason: 'success',
      });
      const ruleHitMedium = {
        tier: 'medium' as RouterTier,
        reasoning: 'rule medium',
      };

      it('rule merge: numeric 0.86 clears the override floor and wins over the rule', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'continue the work', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('high', 0.86),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('high');
        expect(decision.isClassifier).toBe(true);
        expect(decision.isRuleMatched).toBeFalsy();
        expect(decision.confidenceNumeric).toBe(0.86);
      });

      it('rule merge: numeric 0.84 stays under the override floor — the rule wins', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'continue the work', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('high', 0.84),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('medium');
        expect(decision.isRuleMatched).toBe(true);
        expect(decision.isClassifier).toBeFalsy();
      });

      it('rule merge: numeric exactly 0.85 clears the override floor (boundary)', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'continue the work', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('high', 0.85),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('high');
        expect(decision.isClassifier).toBe(true);
      });

      it('veto: numeric 0.86 survives the explicit high hint', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'ultrathink this through', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('low', 0.86),
        );
        expect(decision.tier).toBe('low');
        expect(decision.isVetoed).toBeFalsy();
        expect(decision.vetoOutcome).toBe('classifier-wins');
      });

      it('veto: numeric 0.84 is suppressed by the explicit high hint', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'ultrathink this through', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('low', 0.84),
        );
        expect(decision.tier).toBe('high');
        expect(decision.isVetoed).toBe(true);
        expect(decision.vetoReason).toBe('explicit-hint');
      });

      it('veto: numeric exactly 0.85 survives the explicit high hint (boundary)', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'ultrathink this through', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('low', 0.85),
        );
        expect(decision.tier).toBe('low');
        expect(decision.isVetoed).toBeFalsy();
      });

      it('degrade: numeric 0.49 falls back to heuristics with attempted provenance', () => {
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
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('high', 0.49),
        );
        expect(decision.isClassifier).toBeFalsy();
        expect(decision.classifierAttempted).toBe(true);
        expect(decision.confidenceNumeric).toBe(0.49);
      });

      it('degrade: numeric 0.5 is used (floor boundary)', () => {
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
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          numeric('high', 0.5),
        );
        expect(decision.isClassifier).toBe(true);
      });

      it('failure result: json-invalid degrades to heuristics with attempted provenance', () => {
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
        const failure: ClassifierResult = {
          reasoning: 'Jev answered but the response carried no usable tier/confidence.',
          rawText: '{"answers":{}}',
          failureReason: 'json-invalid',
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          failure,
        );
        expect(decision.classifierAttempted).toBe(true);
        expect(decision.isClassifier).toBeFalsy();
        expect(decision.failureReason).toBe('json-invalid');
        expect(decision.confidence).toBeUndefined();
      });

      it('word fallback: absent numeric keeps the word branch (chat path)', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'continue the work', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(
          context, 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          {
            tier: 'high',
            confidence: 'high',
            reasoning: 'A.',
            rawText: 't',
            failureReason: 'success',
          },
          ruleHitMedium,
        );
        expect(decision.tier).toBe('high');
        expect(decision.isClassifier).toBe(true);
        expect(decision.confidenceNumeric).toBeUndefined();
      });
    });;

    it('veto: ultrathink + classifier low (high confidence) → classifier wins (confidence-aware veto)', () => {
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
      expect(decision.tier).toBe('low');
      expect(decision.isVetoed).toBeUndefined();
      expect(decision.classifierAttempted).toBe(true);
      expect(decision.classifierTier).toBe('low');
      expect(decision.vetoOutcome).toBe('classifier-wins');
    });

    it('veto: fast + classifier high (high confidence) → classifier wins (confidence-aware veto)', () => {
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
      expect(decision.tier).toBe('high');
      expect(decision.isVetoed).toBeUndefined();
      expect(decision.classifierAttempted).toBe(true);
      expect(decision.classifierTier).toBe('high');
      expect(decision.vetoOutcome).toBe('classifier-wins');
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

      it('matches phrase hints via substring fallback (classifier high confidence wins)', () => {
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
        expect(decision.tier).toBe('low');
        expect(decision.isVetoed).toBeUndefined();
        expect(decision.classifierAttempted).toBe(true);
        expect(decision.classifierTier).toBe('low');
        expect(decision.vetoOutcome).toBe('classifier-wins');
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

    it('retries next ref on classifier stream stall', async () => {
      let callCount = 0;
      vi.mocked(streamSimple).mockImplementation((() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            await new Promise<void>(() => {}); // stall — never yields
          })() as any;
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
        undefined,
        undefined,
        undefined,
        undefined,
        15,
      );
      expect(result?.tier).toBe('medium');
      expect(callCount).toBe(2);
    });

    it('returns undefined when all refs stall', async () => {
      const onStall = vi.fn();
      vi.mocked(streamSimple).mockImplementation((() => {
        return (async function* () {
          await new Promise<void>(() => {});
        })() as any;
      }) as any);
      const result = await runClassifier(
        ['openai/gpt-4o', 'google/gemini-flash'],
        mockRegistry,
        context,
        undefined,
        undefined,
        undefined,
        undefined,
        15,
        onStall,
      );
      expect(result).toBeUndefined();
      expect(onStall).toHaveBeenCalledTimes(2);
    });

    it('returns undefined immediately when the signal is pre-aborted', async () => {
      // The shared streamSimple mock accumulates call history across tests
      // (no clearMocks in this file) — clear it so not.toHaveBeenCalled is
      // meaningful.
      vi.mocked(streamSimple).mockClear();
      const controller = new AbortController();
      controller.abort();
      const result = await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
      expect(result).toBeUndefined();
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
    });

    describe('typesafe (Jev) backend', () => {
      const typesafeContext: Context = {
        messages: [
          {
            role: 'user',
            content: 'design the migration',
            timestamp: Date.now(),
          },
        ],
      };

      const okBody = (choice: string, confidence: number) => {
        const body = JSON.stringify({
          answers: { tier: { type: 'choice', choice, confidence } },
        });
        return {
          ok: true,
          text: async () => body,
          json: async () => JSON.parse(body),
        };
      };

      const runJev = (refs: string[], signal?: AbortSignal) =>
        runClassifier(
          refs,
          mockRegistry,
          typesafeContext,
          undefined,
          undefined,
          undefined,
          signal,
          undefined,
          undefined,
          'typesafe',
        );

      afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(readFileSync).mockImplementation(() => {
          throw new Error('ENOENT: typesafe_api_key');
        });
      });

      it('maps a Jev choice answer to a router tier', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.92),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.tier).toBe('high');
        expect(result?.confidence).toBe('high');
        expect(result?.failureReason).toBe('success');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.typesafe.ai/v1/systemone');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(String(init.body));
        expect(sent.model).toBe('jev-latest');
        expect(sent.questions.tier.type).toBe('choice');
      });

      it('sends a Jev-native request: structured state, contrastive criteria, signal questions, no chat directive', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.92),
        );
        vi.stubGlobal('fetch', fetchMock);

        await runJev(['typesafe/jev-latest']);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.typesafe.ai/v1/systemone');
        const sent = JSON.parse(String(init.body));
        // FR1: state is structured content with named fields — not a prompt.
        expect(typeof sent.state).toBe('object');
        expect(sent.state.latest_turn).toBe('design the migration');
        expect(typeof sent.state.recent_history).toBe('string');
        expect(sent.state.has_image).toBe(false);
        expect(sent.state.current_phase).toBeUndefined();
        // No chat-format directive anywhere in the body.
        expect(JSON.stringify(sent)).not.toContain('Return your decision');
        // FR2: contrastive criteria, identical field names across tiers.
        for (const tier of ['high', 'medium', 'low'] as const) {
          expect(Object.keys(sent.questions.tier.criteria[tier])).toEqual([
            'covers',
            'not_for',
            'examples',
            'keywords',
          ]);
          expect(
            sent.questions.tier.criteria[tier].keywords.length,
          ).toBeGreaterThan(10);
        }
        expect(sent.questions.tier.type).toBe('choice');
        // FR2/D13: atomic Noul signal questions ride the same POST.
        expect(sent.questions.long_request.type).toBe('noul');
        expect(Object.keys(sent.questions.long_request.criteria)).toEqual([
          'true',
          'false',
        ]);
        expect(sent.questions.structured_request.type).toBe('noul');
        expect(sent.questions.implementation_context.type).toBe('noul');
      });

      it('maps Jev confidence through the high/medium/low thresholds', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const cases = [
          [0.8, 'high'],
          [0.79, 'medium'],
          [0.5, 'medium'],
          [0.2, 'low'],
        ] as const;
        for (const [confidence, expected] of cases) {
          vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, _init: RequestInit) =>
              okBody('medium', confidence),
            ),
          );
          const result = await runJev(['typesafe/jev-latest']);
          expect(result?.confidence).toBe(expected);
        }
      });

      it('maps a Jev answer to tier, numeric confidence, and the display word', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => okBody('medium', 0.72)),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.tier).toBe('medium');
        expect(result?.confidenceNumeric).toBe(0.72);
        expect(result?.confidence).toBe('medium');
        expect(result?.failureReason).toBe('success');
      });

      it('records an unusable answer as json-invalid with the body snapshot', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => okBody('gigantic', 0.9)),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.failureReason).toBe('json-invalid');
        expect(result?.tier).toBeUndefined();
        expect(result?.rawText).toContain('gigantic');
      });

      it('treats a non-numeric confidence as a recorded failure (FR3)', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const body = JSON.stringify({
          answers: {
            tier: { type: 'choice', choice: 'high', confidence: 'high' },
          },
        });
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: true,
            text: async () => body,
            json: async () => JSON.parse(body),
          })),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.failureReason).toBe('json-invalid');
        expect(result?.confidenceNumeric).toBeUndefined();
      });

      it('treats a 200 body that is not JSON as json-invalid, not infra-failure', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: true,
            text: async () => '<html>proxy error</html>',
          })),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.failureReason).toBe('json-invalid');
        expect(result?.rawText).toBe('<html>proxy error</html>');
      });

      it('records an HTTP failure as infra-failure and keeps trying the next ref', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => '',
          })
          .mockResolvedValueOnce(okBody('high', 0.9));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['typesafe/first', 'typesafe/jev-latest']);
        expect(result?.failureReason).toBe('success');
        expect(result?.tier).toBe('high');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('records a transport failure as infra-failure', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('network down');
          }),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.failureReason).toBe('infra-failure');
      });

      it('returns undefined when no key is present (never ran)', async () => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('reports a stall through onStall and records infra-failure', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const onStall = vi.fn();
        const fetchMock = vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              // Never resolves on its own; the stall timer aborts the fetch.
              init.signal?.addEventListener('abort', () =>
                reject(new Error('The operation was aborted')),
              );
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runClassifier(
          ['typesafe/jev-latest'],
          mockRegistry,
          typesafeContext,
          undefined,
          undefined,
          undefined,
          undefined,
          15,
          onStall,
          'typesafe',
        );
        expect(onStall).toHaveBeenCalledTimes(1);
        expect(onStall).toHaveBeenCalledWith('typesafe/jev-latest', 15);
        expect(result?.failureReason).toBe('infra-failure');
      });

      it('notes the atomic signal answers in the reasoning (provenance only)', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const body = JSON.stringify({
          answers: {
            tier: { type: 'choice', choice: 'high', confidence: 0.91 },
            long_request: { type: 'noul', noul: 0.91 },
            structured_request: { type: 'noul', noul: 0.88 },
            implementation_context: { type: 'noul', noul: 0.2 },
          },
        });
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: true,
            text: async () => body,
            json: async () => JSON.parse(body),
          })),
        );

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.tier).toBe('high');
        expect(result?.reasoning).toContain('long request');
        expect(result?.reasoning).toContain('structured request');
        expect(result?.reasoning).not.toContain('implementation context');
      });

      it('skips a ref without a provider slash and tries the next ref', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['jev-latest', 'typesafe/jev-latest']);
        expect(result?.tier).toBe('high');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('returns undefined on an aborted signal without calling fetch', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(
          ['typesafe/jev-latest'],
          AbortSignal.abort(),
        );
        expect(result).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('reads the key from the agent dir key file', async () => {
        vi.mocked(readFileSync).mockReturnValue('file-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.tier).toBe('high');
        const init = fetchMock.mock.calls[0][1] as RequestInit & {
          headers: Record<string, string>;
        };
        expect(init.headers.Authorization).toBe('Bearer file-key');
      });

      it('returns undefined when the key file holds no key', async () => {
        vi.mocked(readFileSync).mockReturnValue('\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('watchdog helpers', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it('raceStallTimeout resolves a fast promise', async () => {
      const result = await raceStallTimeout(
        Promise.resolve('ok'),
        25,
        undefined,
        'test',
      );
      expect(result).toBe('ok');
    });

    it('raceStallTimeout rejects with StallTimeoutError on silence', async () => {
      await expect(
        raceStallTimeout(new Promise<void>(() => {}), 15, undefined, 'test'),
      ).rejects.toMatchObject({ name: 'StallTimeoutError' });
    });

    it('raceStallTimeout rejects with AbortError when the signal pre-fires', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        raceStallTimeout(Promise.resolve('ok'), 1000, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    // Discriminating reset test: per-gap 8ms stays under the 60ms timer,
    // but 10 x 8ms = 80ms cumulative exceeds it — with the per-event reset
    // deleted (timer armed once) the timer fires mid-stream and this fails.
    it('stallGuardedStream passes events and resets the timer per event', async () => {
      const events: string[] = [];
      const source = async function* () {
        for (let i = 0; i < 10; i++) {
          await sleep(8);
          yield `event-${i}`;
        }
      };
      for await (const event of stallGuardedStream(
        source(),
        60,
        undefined,
        undefined,
        'test',
      )) {
        events.push(event as string);
      }
      expect(events).toHaveLength(10);
    });

    it('stallGuardedStream calls onStall then throws on silence', async () => {
      let stalled = false;
      const source = async function* () {
        yield 'first';
        await new Promise<void>(() => {}); // never yields again
      };
      const consume = async () => {
        for await (const event of stallGuardedStream(
          source(),
          15,
          () => {
            stalled = true;
          },
          undefined,
          'test',
        )) {
          void event;
        }
      };
      await expect(consume()).rejects.toMatchObject({
        name: 'StallTimeoutError',
      });
      await sleep(80);
      expect(stalled).toBe(true);
    });

    it('stallGuardedStream throws AbortError when the signal fires mid-stream', async () => {
      const controller = new AbortController();
      const source = async function* () {
        yield 'first';
        await new Promise<void>(() => {});
      };
      const consume = async () => {
        for await (const event of stallGuardedStream(
          source(),
          1000,
          undefined,
          controller.signal,
        )) {
          void event;
        }
      };
      const pending = consume();
      await sleep(10);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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

  describe('buildClassifierPrompt', () => {
    it('includes the prompt text', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'refactor the auth module',
        historyText: '',
        toolResultCount: 0,
        wordCount: 4,
        multiLinePrompt: false,
      });
      expect(prompt).toContain('refactor the auth module');
    });

    it('includes phase context when provided', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'design the new API',
        historyText: '',
        toolResultCount: 0,
        wordCount: 5,
        multiLinePrompt: false,
        currentPhase: 'planning',
      });
      expect(prompt).toContain('Current conversation phase: planning');
      expect(prompt).toContain('planning phase');
    });

    it('includes image note when hasImage is true', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'what is this',
        historyText: '',
        toolResultCount: 0,
        wordCount: 3,
        multiLinePrompt: false,
        hasImage: true,
      });
      expect(prompt).toContain('attached an image');
    });

    it('omits image note when hasImage is false', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'what is this',
        historyText: '',
        toolResultCount: 0,
        wordCount: 3,
        multiLinePrompt: false,
        hasImage: false,
      });
      expect(prompt).not.toContain('attached an image');
    });

    it('includes tool result count when > 0', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'continue',
        historyText: '',
        toolResultCount: 3,
        wordCount: 1,
        multiLinePrompt: false,
      });
      expect(prompt).toContain('3 tool result');
    });

    it('includes word count note when >= 40', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'a'.repeat(200),
        historyText: '',
        toolResultCount: 0,
        wordCount: 40,
        multiLinePrompt: false,
      });
      expect(prompt).toContain('long and detailed');
    });

    it('includes multi-line note when multiLinePrompt is true', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'line1\nline2\nline3\nline4',
        historyText: '',
        toolResultCount: 0,
        wordCount: 4,
        multiLinePrompt: true,
      });
      expect(prompt).toContain('multiple lines');
    });

    it('returns exactly three output lines instruction', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'test',
        historyText: '',
        toolResultCount: 0,
        wordCount: 1,
        multiLinePrompt: false,
      });
      expect(prompt).toContain('Tier: [high|medium|low]');
      expect(prompt).toContain('Confidence: [high|medium|low]');
      expect(prompt).toContain('Reasoning: [one short sentence]');
    });
  });
});
