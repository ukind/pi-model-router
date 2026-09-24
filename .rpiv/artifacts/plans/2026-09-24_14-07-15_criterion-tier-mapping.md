---
date: 2026-09-24T14:07:15+0700
author: Yogiswara Utama
commit: c58c7454
branch: main
repository: pi-model-router
topic: "Criterion-driven tier classification"
tags: [plan, routing, classifier, work-type, staged-rework]
status: ready
parent: ".rpiv/artifacts/designs/2026-09-24_10-33-41_criterion-tier-mapping.md"
phase_count: 8
phases:
  - { n: 1, title: "Vocabulary foundation", files: [extensions/types.ts, extensions/config.ts, extensions/config.test.ts, extensions/index.test.ts], depends_on: [] }
  - { n: 2, title: "Jev backend", files: [extensions/typesafe.ts, extensions/routing.test.ts, extensions/provider.test.ts], depends_on: [1] }
  - { n: 3, title: "Chat backend", files: [extensions/routing.ts, extensions/routing.test.ts], depends_on: [1, 2] }
  - { n: 4, title: "Provenance + state tolerance", files: [extensions/routing.ts, extensions/provider.ts, extensions/commands.ts, extensions/state.ts, extensions/state.test.ts, extensions/provider.test.ts, extensions/index.test.ts], depends_on: [1, 2, 3] }
  - { n: 5, title: "Live probe", files: [scripts/probe-work-type.mjs], depends_on: [1, 2] }
  - { n: 6, title: "Floor-gated merge", files: [extensions/routing.ts, extensions/constants.ts, extensions/routing.test.ts], depends_on: [4, 5] }
  - { n: 7, title: "Heuristic classify + nudge", files: [extensions/routing.ts, extensions/routing.test.ts], depends_on: [6] }
  - { n: 8, title: "Criterion wording", files: [extensions/index.ts, extensions/ui.ts, extensions/ui.test.ts], depends_on: [7] }
last_updated: 2026-09-24T14:07:15+0700
last_updated_by: Yogiswara Utama
---

# Criterion-driven tier classification Implementation Plan

## Overview

Phased implementation of the criterion-driven tier classification design: both classifier backends (Jev/typesafe and chat) answer a `RouterWorkType` (`planning`, `implementation`, `summary`, `lookup`); one shared `WORK_TYPE_TO_TIER` map converts the answer before any tier-keyed consumer runs. Confidence now means certainty of the work-type classification.

Phases 1-4 form commit 1 (vocabulary + wires + provenance; routing outcomes identical to HEAD). Phase 5 is the env-gated live probe that gates commit 2. Phases 6-8 are commit 2 (floor-gated merge, heuristic split, criterion wording). Phase boundaries inherit the design's `## Slices` 1:1.

## Desired End State

A read-only turn routes to the low tier with high confidence:

```typescript
const result = await runClassifier(['typesafe/jev-latest'], registry, context, undefined, undefined, undefined, undefined, undefined, undefined, 'typesafe');
// result.workType === 'lookup'; result.tier === 'low'; result.confidenceNumeric === 0.97
const decision = decideRouting(context, 'p', profile, undefined, undefined, undefined, undefined, undefined, undefined, result, ruleHitMedium);
// decision.tier === 'low' (FR4: pulled below the medium rule)
// decision.confidence === 'high'; decision.classifierCriterion === 'lookup'
```

Status line shows `Route: low (lookup)`; `/router fix high` records `classifierCriterion: 'lookup'` on the calibration entry; an old tier-only `router-state` restores pins and calibration unchanged.

## What We're NOT Doing

- Criterion-native downstream re-key (Option 3 — rejected: `thinkingByProfile` stranding, `matchesPin` breakage, whole-state reject, pin/phase collision).
- `/router pin`, `/router fix`, `/router thinking` CLI vocabulary changes (stay tier-keyed).
- `vetoDisagreementMagnitude` redefinition (kept as post-map tier distance, zero textual edits).
- Widget redesign beyond the additive criterion display.
- README / `model-router.example.json` rewrites beyond what the FRD lists.

---

## Phase 1: Vocabulary foundation

### Overview
RouterWorkType vocabulary lands: union in `types.ts`, values array, deterministic map, and literal-comparison guard in `config.ts`. `config.test.ts` gains guard tests using phase-collision-safe words. The `index.test.ts` config mock gains the three new exports. No behavior change.

### Changes Required:

#### 1. `extensions/types.ts`
**File**: `extensions/types.ts`
**Changes**: RouterWorkType union + optional provenance fields (`ClassifierResult.workType?`, `RoutingDecision.classifierCriterion?`, `ClassifierCalibrationEntry.classifierCriterion?`)

```typescript
// After RouterPhase (types.ts:5) — the criterion vocabulary (FR1/FR3)
export type RouterWorkType =
  | 'planning'
  | 'implementation'
  | 'summary'
  | 'lookup'
  | 'unknown';

// ClassifierResult — insert after `tier?: RouterTier;`
  /** Work type the classifier answered, pre-map. Absent on failure results. */
  workType?: RouterWorkType;

// ClassifierCalibrationEntry — insert after `finalTier: RouterTier;`
  /** Work type the classifier answered for this calibrated turn, when known. */
  classifierCriterion?: RouterWorkType;

// RoutingDecision — insert after `classifierTier?: RouterTier;`
  classifierCriterion?: RouterWorkType;
```

#### 2. `extensions/config.ts`
**File**: `extensions/config.ts`
**Changes**: `ROUTER_WORK_TYPES`, `WORK_TYPE_TO_TIER`, `isRouterWorkType` beside `ROUTER_TIERS`

```typescript
// Type-import list (config.ts:5-16) gains RouterWorkType, between
// RouterPhase and RoutingRule:
//   RouterTier,
//   RouterPhase,
//   RouterWorkType,
//   RoutingRule,

// After ROUTER_TIERS (config.ts:23)
export const ROUTER_WORK_TYPES = [
  'planning',
  'implementation',
  'summary',
  'lookup',
  'unknown',
] as const;

/**
 * Deterministic criterion-to-tier map (FR3). The tier follows from the work
 * type; the confidence floors measure certainty of the work type, never of
 * the tier. `unknown` never crosses the Jev wire — it is the local fallback.
 */
export const WORK_TYPE_TO_TIER: Record<RouterWorkType, RouterTier> = {
  planning: 'high',
  implementation: 'medium',
  summary: 'low',
  lookup: 'low',
  unknown: 'medium',
};

// After isRouterPhase (config.ts:52-53) — literal-comparison guard,
// the same idiom as isRouterTier / isRouterPhase
export const isRouterWorkType = (value: unknown): value is RouterWorkType =>
  value === 'planning' ||
  value === 'implementation' ||
  value === 'summary' ||
  value === 'lookup' ||
  value === 'unknown';
```

#### 3. `extensions/config.test.ts`
**File**: `extensions/config.test.ts`
**Changes**: guard tests using `'lookup'`/`'summary'` (phase-collision safe)

```typescript
// Import list gains: ROUTER_WORK_TYPES, WORK_TYPE_TO_TIER, isRouterWorkType
// (the suite imports the real ./config module — config.test.ts:2-20).

// New describe beside the isRouterTier tests (~config.test.ts:91-96)
describe('isRouterWorkType / WORK_TYPE_TO_TIER / ROUTER_WORK_TYPES', () => {
  it('accepts the five work types', () => {
    for (const wt of ROUTER_WORK_TYPES) {
      expect(isRouterWorkType(wt)).toBe(true);
    }
  });
  it('rejects tier words and non-vocabulary strings', () => {
    // 'planning'/'implementation' also satisfy isRouterPhase — the tier-word
    // rejections prove THIS guard fired, not the phase guard.
    expect(isRouterWorkType('high')).toBe(false);
    expect(isRouterWorkType('medium')).toBe(false);
    expect(isRouterWorkType('low')).toBe(false);
    expect(isRouterWorkType('lightweight')).toBe(false);
    expect(isRouterWorkType('scan_read')).toBe(false);
    expect(isRouterWorkType(undefined)).toBe(false);
  });
  it('maps every work type to the fixed tier targets (FR3)', () => {
    expect(WORK_TYPE_TO_TIER.planning).toBe('high');
    expect(WORK_TYPE_TO_TIER.implementation).toBe('medium');
    expect(WORK_TYPE_TO_TIER.summary).toBe('low');
    expect(WORK_TYPE_TO_TIER.lookup).toBe('low');
    expect(WORK_TYPE_TO_TIER.unknown).toBe('medium');
  });
});
```

#### 4. `extensions/index.test.ts`
**File**: `extensions/index.test.ts`
**Changes**: config mock factory gains the three new exports (`ROUTER_WORK_TYPES`, `WORK_TYPE_TO_TIER`, `isRouterWorkType`)

```typescript
// Slice 1 — config mock factory (index.test.ts:5-46) gains the trio.
// The mock hand-enumerates every ./config symbol the static graph imports.
  ROUTER_TIERS: ['high', 'medium', 'low'] as const,
  ROUTER_WORK_TYPES: [
    'planning',
    'implementation',
    'summary',
    'lookup',
    'unknown',
  ] as const,
  WORK_TYPE_TO_TIER: {
    planning: 'high',
    implementation: 'medium',
    summary: 'low',
    lookup: 'low',
    unknown: 'medium',
  },
  isRouterTier: (v: unknown) => v === 'high' || v === 'medium' || v === 'low',
  isRouterWorkType: (v: unknown) =>
    v === 'planning' ||
    v === 'implementation' ||
    v === 'summary' ||
    v === 'lookup' ||
    v === 'unknown',
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Union exported: `grep -n "export type RouterWorkType" extensions/types.ts` returns the declaration
- [x] Map + guard exported: `grep -c "WORK_TYPE_TO_TIER\|isRouterWorkType\|ROUTER_WORK_TYPES" extensions/config.ts` returns >= 3
- [x] Mock extended: `grep -n "isRouterWorkType" extensions/index.test.ts` returns the mock entry

#### Manual Verification:
- [ ] `extensions/types.ts` still imports only `ThinkingLevel` from `@earendil-works/pi-agent-core` (no module cycle introduced)

---

## Phase 2: Jev backend

### Overview
`TIER_CRITERIA` becomes `WORK_TYPE_CRITERIA` (4 keys, 66-token keyword multiset preserved); the question key becomes `work_type` (`unknown` never crosses the wire); the mapper validates with `isRouterWorkType` and converts through `WORK_TYPE_TO_TIER`. The `routing.test.ts` Jev block flips and pins the token parity.

### Changes Required:

#### 1. `extensions/typesafe.ts`
**File**: `extensions/typesafe.ts`
**Changes**: 4-key criteria, `work_type` key, mapper conversion

```typescript
// — Header doc comment (replaces lines 1-10)
/**
 * TypeSafe (Jev / System One) classifier backend.
 *
 * The call is not chat-shaped. One POST returns typed answers. The
 * `work_type` question asks for one of the four router work types; the
 * mapper converts the answer to a tier through WORK_TYPE_TO_TIER, so no
 * output parser is needed.
 * Contract: https://docs.typesafe.ai/introduction/quickstart
 */

// — Imports: RouterTier and isRouterTier drop out (no remaining use);
//   RouterWorkType, isRouterWorkType, and WORK_TYPE_TO_TIER join.
import type {
  ClassifierPromptContext,
  ClassifierResult,
  ConfidenceLevel,
  RouterPhase,
  RouterWorkType,
} from './types';
import {
  isRouterWorkType,
  parseCanonicalModelRef,
  WORK_TYPE_TO_TIER,
} from './config';

// — TypesafeCriterion JSDoc: "for this tier" becomes "for this work type"
  /**
   * The router's own hint/keyword vocabulary for this work type (routing.ts
   * explicitHighHints / explicitLowHints / planning / summary /
   * implementation / lookup keyword sets). Docs allow arrays in criteria
   * values; the eval (Follow-up 2) shows this array is the single largest
   * accuracy lever.
   */

// — Replaces TIER_CRITERIA entirely: wire vocabulary type + 4-key record.
/** The answer vocabulary on the wire: `unknown` never crosses it (FR7). */
type WireWorkType = Exclude<RouterWorkType, 'unknown'>;

// Eval-v2 rubric (Follow-up 2): 19/19 on the labeled live eval, mean
// confidence 0.976. Re-keyed from tiers to work types; the 66-token keyword
// multiset is preserved exactly (parity-pinned in routing.test.ts).
// Do not trim the keywords arrays; they carry the accuracy.
const WORK_TYPE_CRITERIA: Record<WireWorkType, TypesafeCriterion> = {
  planning: {
    covers:
      'Requests that need design judgment or broad analysis: planning, architecture, tradeoff analysis, migration strategy, comparing approaches, root-cause investigation, codebase research, and large multi-file refactors. Also long detailed multi-part requests (roughly 40 or more words) and requests asking for deep, thorough, careful, comprehensive, or best-quality work.',
    not_for:
      'Bounded edits with a known plan, routine implementation, focused single-file debugging, tests and fixes, summaries and formatting, and read-only lookups. A short fix or continue request is not planning even when the project is complex.',
    examples:
      'Design the migration plan for the settings module; analyze why the build is slow across the codebase; weigh two persistence approaches; ultrathink: audit this service for correctness; research the auth flow and propose a redesign.',
    keywords: [
      'plan',
      'planning',
      'architecture',
      'design',
      'tradeoff',
      'trade-off',
      'research',
      'investigate',
      'root cause',
      'analyze',
      'analysis',
      'migration',
      'strategy',
      'compare',
      'options',
      'approach',
      'ultrathink',
      'think hard',
      'deep',
      'thoroughly',
      'comprehensive',
      'robust',
      'best',
      'highest quality',
      'step by step',
    ],
  },
  implementation: {
    covers:
      'Hands-on implementation with a clear target: writing or editing code, fixing bugs, adding or updating tests, applying a patch, small-to-medium refactors, multi-file edits under an agreed plan, and continuing or resuming in-progress work. Also edits to project files such as readme, docs, or configuration as part of development work. The default for general coding requests and for image attachments during active coding.',
    not_for:
      'Open-ended design, planning, or research requests (planning). Summaries, changelogs, formatting, renames, and read-only lookups (summary or lookup).',
    examples:
      'Implement the agreed change in three files; fix this failing test; continue the work; add input validation and update its tests; refactor the config loader per the plan; update the readme to document the new flag.',
    keywords: [
      'implement',
      'code',
      'fix',
      'update',
      'edit',
      'write',
      'refactor',
      'add tests',
      'patch',
      'change',
      'apply',
      'continue',
      'resume',
      'make the changes',
      'go ahead',
    ],
  },
  summary: {
    covers:
      'Short bounded low-effort outputs: summaries, recaps, changelogs, TL;DRs, brief explanations, formatting, renames, and small text transforms. Requests asking for fast, quick, cheap, brief, one-sentence, or one-line answers.',
    not_for:
      'Any request that writes or changes code, documentation, or configuration, however small (implementation). Read-only lookups that only locate information (lookup). Design, planning, and analysis work (planning).',
    examples:
      'Summarize this diff; tl;dr of that document; reformat this file; rename this variable everywhere; explain briefly what this function does.',
    keywords: [
      'summarize',
      'summary',
      'changelog',
      'recap',
      'tl;dr',
      'reformat',
      'format',
      'rename',
      'rewrite',
      'explain briefly',
      'fast',
      'cheap',
      'quick',
      'quickly',
      'brief',
      'briefly',
      'one sentence',
      'one line',
      'tiny',
      'small',
    ],
  },
  lookup: {
    covers:
      'Read-only lookups: where something lives, which files match a pattern, and quick factual checks against the codebase or conversation. The answer locates information and adds no new text beyond it.',
    not_for:
      'Any request that writes or changes code, documentation, or configuration (implementation). Explanations, summaries, and text transforms (summary). Design, planning, and analysis work (planning).',
    examples:
      'Where is the config loader defined; which file exports the map; show me the models that match.',
    keywords: ['where is', 'which file', 'show me', 'list', 'find', 'grep'],
  },
};

// — TypesafeQuestions: the `tier` key becomes `work_type`
export interface TypesafeQuestions {
  work_type: {
    type: 'choice';
    instructions: string;
    criteria: Record<WireWorkType, TypesafeCriterion>;
  };
  long_request: TypesafeNoulQuestion;
  structured_request: TypesafeNoulQuestion;
  implementation_context: TypesafeNoulQuestion;
}

// — buildTypesafeQuestions: the work_type entry (noul questions unchanged)
/**
 * Pure: the fixed question set for every typesafe turn — one work-type
 * choice (contrastive criteria) plus three atomic signal questions (D5).
 */
export const buildTypesafeQuestions = (): TypesafeQuestions => ({
  work_type: {
    type: 'choice',
    instructions: 'Which work type fits the latest request',
    criteria: WORK_TYPE_CRITERIA,
  },
  long_request: {
    type: 'noul',
    instructions:
      'Is the latest turn a long, detailed request (roughly 40+ words)?',
    criteria: {
      true: 'The latest turn is long and detailed: roughly 40 or more words, or several distinct requirements in one message.',
      false: 'The latest turn is short: one simple ask, well under 40 words.',
    },
  },
  structured_request: {
    type: 'noul',
    instructions:
      'Does the latest turn span multiple lines in a structured or detailed way?',
    criteria: {
      true: 'The latest turn has 4 or more lines, or uses structure: numbered steps, bullet lists, code blocks, or several distinct requirements.',
      false: 'The latest turn is a single line or one plain sentence with no structure.',
    },
  },
  implementation_context: {
    type: 'noul',
    instructions:
      'Does the recent history show active implementation work (tool results or code edits)?',
    criteria: {
      true: 'The recent history shows active implementation: tool results, code edits, file writes, or test runs.',
      false: 'The recent history shows no implementation work: only questions, chat, or discussion.',
    },
  },
});

// — mapTypesafeResponse: reads answers.work_type, validates with
//   isRouterWorkType (a literal 'unknown' passes and maps to medium),
//   converts through the map. The result keeps tier (post-map) and gains
//   workType.
/**
 * Pure: response body -> ClassifierResult. Returns undefined when the body
 * carries no usable work-type answer or no numeric confidence; the caller
 * records that as a 'json-invalid' failure instead of degrading silently
 * (FR3/FR4).
 */
export const mapTypesafeResponse = (
  body: unknown,
): ClassifierResult | undefined => {
  const answers = (body as { answers?: Record<string, unknown> } | null)
    ?.answers;
  const workTypeAnswer = answers?.work_type as
    | { type?: string; choice?: unknown; confidence?: unknown }
    | undefined;
  const choice = workTypeAnswer?.choice;
  if (typeof choice !== 'string') return undefined;
  const workTypeRaw = choice.trim().toLowerCase();
  if (!isRouterWorkType(workTypeRaw)) return undefined;

  const confidenceNumeric = workTypeAnswer?.confidence;
  if (
    typeof confidenceNumeric !== 'number' ||
    Number.isNaN(confidenceNumeric) ||
    !Number.isFinite(confidenceNumeric)
  ) {
    return undefined;
  }

  const workType: RouterWorkType = workTypeRaw;
  const tier = WORK_TYPE_TO_TIER[workType];
  return {
    tier,
    workType,
    confidence: toConfidenceLevel(confidenceNumeric),
    confidenceNumeric,
    reasoning:
      `Jev classified the turn as ${workType} (${tier} tier, confidence ${confidenceNumeric.toFixed(2)}).` +
      readTypesafeSignals(answers),
    rawText: JSON.stringify(answers),
    failureReason: 'success',
  };
};

// — runTypesafeClassifier tail: the json-invalid wording only
      reasoning:
        'Jev answered but the response carried no usable work type and numeric confidence.',
```

#### 2. `extensions/routing.test.ts`
**File**: `extensions/routing.test.ts`
**Changes**: Jev block flip + `HEAD_KEYWORD_TOKENS` parity test

```typescript
// Slice 2 fills the Jev block (okBody wire key, criteria loop, parity test).
// Slice 3 flips the parser block, the chat block, and the
// buildClassifierPrompt assertions. FR4 acceptance and precedence pins land
// with Slices 6 and 7.

// — describe('typesafe (Jev) backend'): the okBody helper flips its wire key
      const okBody = (choice: string, confidence: number) => {
        const body = JSON.stringify({
          answers: { work_type: { type: 'choice', choice, confidence } },
        });
        return {
          ok: true,
          text: async () => body,
          json: async () => JSON.parse(body),
        };
      };

// — Beside okBody: the HEAD multiset the rework must preserve
      // HEAD's TIER_CRITERIA held 66 keyword tokens (high 25, medium 15,
      // low 26). The work-type re-key must preserve the multiset exactly.
      const HEAD_KEYWORD_TOKENS = [
        // high -> planning (16 planning words + 9 high-hint words)
        'plan', 'planning', 'architecture', 'design', 'tradeoff',
        'trade-off', 'research', 'investigate', 'root cause', 'analyze',
        'analysis', 'migration', 'strategy', 'compare', 'options',
        'approach', 'ultrathink', 'think hard', 'deep', 'thoroughly',
        'comprehensive', 'robust', 'best', 'highest quality', 'step by step',
        // medium -> implementation (unchanged 15)
        'implement', 'code', 'fix', 'update', 'edit', 'write', 'refactor',
        'add tests', 'patch', 'change', 'apply', 'continue', 'resume',
        'make the changes', 'go ahead',
        // low -> summary (10 summary words + 10 low-hint words)
        'summarize', 'summary', 'changelog', 'recap', 'tl;dr', 'reformat',
        'format', 'rename', 'rewrite', 'explain briefly', 'fast', 'cheap',
        'quick', 'quickly', 'brief', 'briefly', 'one sentence', 'one line',
        'tiny', 'small',
        // low -> lookup (6 pure search words)
        'where is', 'which file', 'show me', 'list', 'find', 'grep',
      ];

// — Replaces 'maps a Jev choice answer to a router tier'
      it('maps a Jev work_type answer to a router tier through the shared map', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('planning', 0.92),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.workType).toBe('planning');
        expect(result?.tier).toBe('high');
        expect(result?.confidence).toBe('high');
        expect(result?.failureReason).toBe('success');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.typesafe.ai/v1/systemone');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(String(init.body));
        expect(sent.model).toBe('jev-latest');
        expect(sent.questions.work_type.type).toBe('choice'); // FR7 round-trip
      });

// — Inside 'sends a Jev-native request...': the four-key criteria loop
//   replaces the three-tier loop; the keywords.length > 10 assertion is
//   deleted (the parity test replaces it).
        // FR2: contrastive criteria, identical field names across work types.
        for (const workType of [
          'planning',
          'implementation',
          'summary',
          'lookup',
        ] as const) {
          expect(
            Object.keys(sent.questions.work_type.criteria[workType]),
          ).toEqual(['covers', 'not_for', 'examples', 'keywords']);
        }
        expect(Object.keys(sent.questions.work_type.criteria)).toEqual([
          'planning',
          'implementation',
          'summary',
          'lookup',
        ]);
        expect(sent.questions.work_type.type).toBe('choice');

// — New test: the fixed map targets (FR3/FR7)
      it('maps every wire work type to its fixed tier target (FR3/FR7)', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const cases = [
          ['planning', 'high'],
          ['implementation', 'medium'],
          ['summary', 'low'],
          ['lookup', 'low'],
        ] as const;
        for (const [workType, tier] of cases) {
          vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, _init: RequestInit) =>
              okBody(workType, 0.9),
            ),
          );
          const result = await runJev(['typesafe/jev-latest']);
          expect(result?.workType).toBe(workType);
          expect(result?.tier).toBe(tier);
        }
      });

// — New test: the literal-'unknown' ratification point
      it('accepts a literal unknown answer and maps it to medium', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) =>
            okBody('unknown', 0.9),
          ),
        );
        const result = await runJev(['typesafe/jev-latest']);
        expect(result?.workType).toBe('unknown');
        expect(result?.tier).toBe('medium');
        expect(result?.failureReason).toBe('success');
      });

// — New test: the 66-token multiset parity guard
      it('preserves the HEAD keyword multiset across the four criteria (66 tokens)', async () => {
        vi.mocked(readFileSync).mockReturnValue('test-key\n');
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('planning', 0.92),
        );
        vi.stubGlobal('fetch', fetchMock);

        await runJev(['typesafe/jev-latest']);

        const [, init] = fetchMock.mock.calls[0];
        const sent = JSON.parse(String(init.body));
        const sentTokens = (
          ['planning', 'implementation', 'summary', 'lookup'] as const
        ).flatMap(
          (k) => sent.questions.work_type.criteria[k].keywords as string[],
        );
        expect(sentTokens).toHaveLength(66);
        expect([...sentTokens].sort()).toEqual([...HEAD_KEYWORD_TOKENS].sort());
      });

// — Mechanical flips inside the Jev block (semantics unchanged):
//   * 'maps Jev confidence through the high/medium/low thresholds':
//       okBody('medium', confidence) -> okBody('implementation', confidence)
//   * 'maps a Jev answer to tier, numeric confidence, and the display word':
//       okBody('medium', 0.72) -> okBody('implementation', 0.72)
//       + expect(result?.workType).toBe('implementation');
//   * 'records an unusable answer as json-invalid': the choice stays
//       'gigantic'; add expect(result?.workType).toBeUndefined();
//   * 'treats a non-numeric confidence as a recorded failure (FR3)':
//       answers.tier -> answers.work_type; choice 'high' -> 'planning'
//   * 'notes the atomic signal answers in the reasoning':
//       answers.tier -> answers.work_type; choice 'high' -> 'planning'
//   * okBody('high', 0.9) -> okBody('planning', 0.9) in: the HTTP-failure
//       second response, the no-key test, the skips-ref test, the
//       aborted-signal test, the key-file test, and the empty-key-file test.
//       Tier assertions stay 'high' (they read the mapped tier).
```


#### 3. `extensions/provider.test.ts`
**File**: `extensions/provider.test.ts`
**Changes**: two mechanical Jev fetch-stub wire flips (`answers.tier` → `answers.work_type`); assertions unchanged (they read the mapped tier)

```typescript
// — Mechanical wire flips (commit-1 greenness): the two Jev fetch stubs
//   still use the `answers.tier` key that Slice 2's mapper removed.
//   * 'should run the classifier through the Jev backend when configured'
//     (provider.test.ts:1573):
//       answers: { tier: { type: 'choice', choice: 'high', confidence: 0.95 } }
//     becomes
//       answers: { work_type: { type: 'choice', choice: 'planning', confidence: 0.95 } }
//     The `expect(mockState.lastDecision?.tier).toBe('high')` assertion
//     stays — it reads the mapped tier.
//   * 'should keep a Jev failure visible in the decision provenance'
//     (:1617-1618): `tier` key -> `work_type`; choice 'gigantic' and all
//     expectations unchanged (unusable answer stays json-invalid).
```

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Old tier constant gone: `grep -c "TIER_CRITERIA" extensions/typesafe.ts` returns 0
- [x] Wire key flipped end to end: `grep -n "answers?.work_type" extensions/typesafe.ts` returns the mapper read, and `grep -c "work_type" extensions/typesafe.ts` returns >= 4
- [x] FR7 round-trip pinned: `grep -n "sent.questions.work_type.type" extensions/routing.test.ts` returns the assertion
- [x] Token parity pinned: `grep -c "HEAD_KEYWORD_TOKENS" extensions/routing.test.ts` returns >= 2
- [x] No tier words left in criteria prose: `grep -nE "\((high|medium|low)\)" extensions/typesafe.ts` returns 0

#### Manual Verification:
- [ ] The four `keywords` arrays hold the 25/15/20/6 split and the parity test holds the 66-token multiset equal to HEAD
- [ ] `extensions/routing.ts` stays untouched by this slice (commit-1 greenness: the chat backend is still tier-shaped)

---

## Phase 3: Chat backend

### Overview
The chat wire pair flips together: `buildClassifierPrompt` offers four work-type choices, `parseClassifierOutput` reads `Work type:`, and `runClassifier` converts through the shared map at the chat return. The `decideRouting` body stays untouched — commit-1 greenness.

### Changes Required:

#### 1. `extensions/routing.ts`
**File**: `extensions/routing.ts`
**Changes**: chat prompt/parser rework + chat-return conversion (FR6/FR2)

```typescript
// Slice 3 delivers the chat wire pair and the chat-return conversion.
// Slice 4 adds the `classifierCriterion` provenance writes; Slice 6 replaces
// the merge gate at `tierRank` with the floor-gated differs test; Slice 7
// splits the heuristic branch into classify + nudge.

// — Type imports (routing.ts:6-16): RouterWorkType joins after RouterProfile.
import type {
  ClassifierBackend,
  RouterTier,
  RouterPhase,
  RouterProfile,
  RouterWorkType,
  RoutingDecision,
  RoutingRule,
  RouterThinkingByTier,
  ClassifierResult,
  ClassifierFailureReason,
  ConfidenceLevel,
  ClassifierPromptContext,
} from './types';

// — Value imports: isRouterTier drops (its only use was the tier parser);
//   the work-type guard and the shared map join (Slice 1 exports).
import {
  parseCanonicalModelRef,
  isRouterWorkType,
  ROUTER_TIERS,
  WORK_TYPE_TO_TIER,
} from './config';

// — buildClassifierPrompt: full replacement. The chat wire pair flips to
//   work types (FR6). The four descriptions mirror the Jev
//   WORK_TYPE_CRITERIA semantics, so both backends classify one vocabulary.
export const buildClassifierPrompt = (ctx: ClassifierPromptContext): string => {
  const lines: string[] = [
    'You are a model router classifier. Your job is to categorize the user\'s latest request into one of four work types: "planning", "implementation", "summary", or "lookup".',
    '',
    'Work types:',
    '- planning: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.',
    '- implementation: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.',
    '- summary: Summaries, changelogs, formatting, quick explanations, small bounded text transforms.',
    '- lookup: Read-only lookups that locate information and add no new text beyond it.',
    '',
  ];

  if (ctx.currentPhase) {
    lines.push(`Current conversation phase: ${ctx.currentPhase}`);
    lines.push('');
  }

  lines.push('Recent history:');
  lines.push(ctx.historyText);
  lines.push('');
  lines.push('Latest user message:');
  lines.push(ctx.promptText);
  lines.push('');

  if (ctx.hasImage) {
    lines.push(
      'Note: The user has attached an image. Bias toward "planning" or "implementation" as the models for "summary" and "lookup" may not support vision capabilities.',
    );
    lines.push('');
  }

  if (ctx.toolResultCount > 0) {
    lines.push(
      `Note: The conversation has ${ctx.toolResultCount} tool result(s), indicating active implementation work.`,
    );
    lines.push('');
  }

  if (ctx.wordCount >= 40) {
    lines.push(
      "Note: The user's message is long and detailed, suggesting a complex request.",
    );
    lines.push('');
  }

  if (ctx.multiLinePrompt) {
    lines.push(
      "Note: The user's message spans multiple lines, suggesting a structured or detailed request.",
    );
    lines.push('');
  }

  lines.push('Return your decision in exactly three lines:');
  lines.push('Work type: [planning|implementation|summary|lookup]');
  lines.push('Confidence: [high|medium|low]');
  lines.push('Reasoning: [one short sentence]');
  lines.push('');

  if (ctx.currentPhase === 'planning') {
    lines.push(
      'Consider that the conversation is currently in a planning phase. Bias toward "planning" unless the request is clearly a simple implementation or summary.',
    );
  }
  if (ctx.currentPhase === 'implementation') {
    lines.push(
      'Consider that the conversation is currently in an implementation phase. Bias toward "implementation" unless the request is clearly planning or a simple summary.',
    );
  }

  return lines.join('\n');
};

// — parseClassifierOutput: full replacement. The work-type word is pre-map;
//   runClassifier converts it through WORK_TYPE_TO_TIER at the return,
//   mirroring the Jev mapper. Unparseable answers stay 'unparseable' and
//   degrade upstream.
export const parseClassifierOutput = (
  rawText: string,
): {
  workType?: RouterWorkType;
  confidence: ConfidenceLevel;
  reasoning: string;
  failureReason: ClassifierFailureReason;
} => {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  const stripMarkdown = (line: string): string =>
    line
      .replace(/^[\s*#>`]*/, '')
      .replace(/[*`]/g, '')
      .trim();

  const lines = normalized.split('\n').map(stripMarkdown);
  const workTypeLine = lines.find((l) => /^work type:\s*/i.test(l));
  const confidenceLine = lines.find((l) => /^confidence:\s*/i.test(l));
  const reasoningLine = lines.find((l) => /^reasoning:\s*/i.test(l));

  if (!workTypeLine) {
    return {
      confidence: 'medium',
      reasoning: '',
      failureReason: 'unparseable',
    };
  }

  const workTypeRaw = workTypeLine
    .replace(/^work type:\s*/i, '')
    .trim()
    .toLowerCase();
  const workTypeWord = workTypeRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '');
  if (!isRouterWorkType(workTypeWord)) {
    return {
      confidence: 'medium',
      reasoning: '',
      failureReason: 'unparseable',
    };
  }

  let confidence: ConfidenceLevel = 'medium';
  if (confidenceLine) {
    const confRaw = confidenceLine
      .replace(/^confidence:\s*/i, '')
      .trim()
      .toLowerCase();
    const confWord = confRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '');
    if (confWord === 'high' || confWord === 'medium' || confWord === 'low') {
      confidence = confWord;
    }
  }

  let reasoning = 'Classifier decision.';
  if (reasoningLine) {
    const reasoningText = reasoningLine.replace(/^reasoning:\s*/i, '');
    if (reasoningText.trim()) reasoning = reasoningText.trim();
  }

  return {
    workType: workTypeWord,
    confidence,
    reasoning,
    failureReason: 'success',
  };
};

// — runClassifier: the chat tail (inside the refs loop, after the stream
//   accumulates fullText). Chat-return conversion (FR2): the map runs before
//   any tier-keyed consumer sees the answer.
      const parsed = parseClassifierOutput(fullText);
      if (parsed.failureReason === 'unparseable') {
        return undefined;
      }

      const workType = parsed.workType!;
      return {
        tier: WORK_TYPE_TO_TIER[workType],
        workType,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        rawText: fullText,
        failureReason: 'success',
      };
```

#### 2. `extensions/routing.test.ts`
**File**: `extensions/routing.test.ts`
**Changes**: parser block, chat block, and `buildClassifierPrompt` flips

```typescript
// — Slice 3: describe('parseClassifierOutput') — full replacement.
//   The parser flips to the work-type wire; the old tier wire and a literal
//   'unknown' answer both get pinned.
  describe('parseClassifierOutput', () => {
    it('parses clean 3-line format', () => {
      const result = parseClassifierOutput(
        'Work type: planning\nConfidence: high\nReasoning: Needs deep reasoner.',
      );
      expect(result.workType).toBe('planning');
      expect(result.confidence).toBe('high');
      expect(result.reasoning).toBe('Needs deep reasoner.');
      expect(result.failureReason).toBe('success');
    });

    it('parses 2-line format (missing confidence) — defaults medium', () => {
      const result = parseClassifierOutput(
        'Work type: planning\nReasoning: Complex task.',
      );
      expect(result.workType).toBe('planning');
      expect(result.confidence).toBe('medium');
      expect(result.failureReason).toBe('success');
    });

    it('strips markdown bold (**Work type:**)', () => {
      const result = parseClassifierOutput(
        '**Work type:** planning\n**Confidence:** high\n**Reasoning:** Deep.',
      );
      expect(result.workType).toBe('planning');
      expect(result.confidence).toBe('high');
    });

    it('strips trailing punctuation (planning.)', () => {
      const result = parseClassifierOutput(
        'Work type: planning.\nReasoning: Hard.',
      );
      expect(result.workType).toBe('planning');
    });

    it('handles multi-word answer (planning priority → planning)', () => {
      const result = parseClassifierOutput(
        'Work type: planning priority\nReasoning: Architectural.',
      );
      expect(result.workType).toBe('planning');
    });

    it('handles empty work-type value (Work type:)', () => {
      const result = parseClassifierOutput('Work type: \nReasoning: none.');
      expect(result.failureReason).toBe('unparseable');
      expect(result.workType).toBeUndefined();
    });

    it('handles \\r\\n line endings', () => {
      const result = parseClassifierOutput(
        'Work type: planning\r\nConfidence: low\r\nReasoning: Simple.',
      );
      expect(result.workType).toBe('planning');
      expect(result.confidence).toBe('low');
    });

    it('handles partial final chunk (Work type: plan)', () => {
      const result = parseClassifierOutput('Work type: plan');
      expect(result.failureReason).toBe('unparseable');
    });

    it("preserves colons in reasoning (It's: complicated)", () => {
      const result = parseClassifierOutput(
        "Work type: implementation\nReasoning: It's: complicated.",
      );
      expect(result.workType).toBe('implementation');
      expect(result.reasoning).toBe("It's: complicated.");
    });

    it('returns unparseable for no work-type line', () => {
      const result = parseClassifierOutput('Invalid response format');
      expect(result.failureReason).toBe('unparseable');
    });

    it('returns unparseable for the old tier wire (Tier: high)', () => {
      const result = parseClassifierOutput(
        'Tier: high\nConfidence: high\nReasoning: Deep.',
      );
      expect(result.failureReason).toBe('unparseable');
      expect(result.workType).toBeUndefined();
    });

    it('accepts a literal unknown answer (guard passes, FR7 parity with Jev)', () => {
      const result = parseClassifierOutput(
        'Work type: unknown\nReasoning: Ambiguous.',
      );
      expect(result.workType).toBe('unknown');
      expect(result.failureReason).toBe('success');
    });

    it('defaults confidence to medium on invalid value', () => {
      const result = parseClassifierOutput(
        'Work type: lookup\nConfidence: extreme\nReasoning: Fast.',
      );
      expect(result.confidence).toBe('medium');
      expect(result.workType).toBe('lookup');
    });
  });

// — Slice 3: describe('runClassifier') chat block — targeted flips.
//   * 'returns structured ClassifierResult from 3-line stream': the stream
//       delta becomes 'Work type: planning\nConfidence: high\nReasoning: Deep.'
//       and the exact-equality expectation gains the mapped fields:
//         expect(result).toEqual({
//           tier: 'high',
//           workType: 'planning',
//           confidence: 'high',
//           reasoning: 'Deep.',
//           rawText: 'Work type: planning\nConfidence: high\nReasoning: Deep.',
//           failureReason: 'success',
//         });
//   * 'retries next ref on infrastructure failure': delta
//       'Work type: lookup\nConfidence: high\nReasoning: Simple.'
//       -> expect(result?.tier).toBe('low')
//   * 'retries next ref on pre-content stream error': delta
//       'Work type: implementation\nConfidence: medium\nReasoning: Normal.'
//       -> expect(result?.tier).toBe('medium')
//   * 'does NOT retry after content received (mid-stream error ...)': first
//       delta 'Work type: planning' -> expect(result?.tier).toBe('high')
//   * 'retries next ref on classifier stream stall': second stream delta
//       'Work type: implementation\nConfidence: medium\nReasoning: Normal.'
//       -> expect(result?.tier).toBe('medium')

//   New tests (after 'returns structured ClassifierResult from 3-line stream'):
    it('maps an unknown chat answer to the medium tier through the shared map', async () => {
      const mockStream = (async function* () {
        yield {
          type: 'text_delta',
          delta: 'Work type: unknown\nConfidence: high\nReasoning: Ambiguous.',
        };
      })();
      vi.mocked(streamSimple).mockReturnValue(mockStream as any);
      const result = await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
      );
      expect(result?.workType).toBe('unknown');
      expect(result?.tier).toBe('medium');
      expect(result?.failureReason).toBe('success');
    });

    it('returns undefined when the stream answers on the old tier wire', async () => {
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
      );
      expect(result).toBeUndefined();
    });

// — Slice 3: describe('buildClassifierPrompt') — targeted flips.
//   * 'returns exactly three output lines instruction':
//       expect(prompt).toContain('Work type: [planning|implementation|summary|lookup]');
//       expect(prompt).toContain('Confidence: [high|medium|low]');
//       expect(prompt).toContain('Reasoning: [one short sentence]');
//       expect(prompt).not.toContain('Tier: [high|medium|low]');
//   New test:
    it('offers the four work-type choices, not tiers', () => {
      const prompt = buildClassifierPrompt({
        promptText: 'test',
        historyText: '',
        toolResultCount: 0,
        wordCount: 1,
        multiLinePrompt: false,
      });
      expect(prompt).toContain('- planning:');
      expect(prompt).toContain('- implementation:');
      expect(prompt).toContain('- summary:');
      expect(prompt).toContain('- lookup:');
      expect(prompt).not.toContain('- high:');
      expect(prompt).not.toContain('- medium:');
      expect(prompt).not.toContain('- low:');
    });
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Wire pair flipped together: `grep -ci "work type" extensions/routing.ts` returns >= 4
- [x] Tier wire gone from the chat pair: `grep -c "isRouterTier" extensions/routing.ts` returns 0, and `grep -c "tierLine" extensions/routing.ts` returns 0
- [x] Conversion at the chat return: `grep -Fn "WORK_TYPE_TO_TIER[workType]" extensions/routing.ts` returns the conversion line
- [x] Old-wire rejection pinned: `grep -n "old tier wire" extensions/routing.test.ts` returns the test
- [x] Parser flip pinned: `grep -c "Work type:" extensions/routing.test.ts` returns >= 12

#### Manual Verification:
- [ ] `decideRouting` body stays untouched by this slice (commit-1 greenness): `grep -n "tierRank" extensions/routing.ts` returns only `matchHighestTierRule`'s internal rank and the rule-merge rank
- [ ] `extensions/typesafe.ts` stays untouched by this slice (Slice 2 remains as locked)

---

## Phase 4: Provenance + state tolerance

### Overview
`classifierCriterion` threads through the routing writes and decision build, the provider promotion rebuild, the `/router fix` writer, the persisted-state sanitizer, and the calibration validator. State tolerates old tier-only shapes (FR9). This phase completes commit 1 — outcomes stay identical to HEAD.

### Changes Required:

#### 1. `extensions/routing.ts`
**File**: `extensions/routing.ts`
**Changes**: `classifierCriterion` provenance writes inside `decideRouting`

```typescript
// — Slice 4: classifierCriterion provenance thread inside decideRouting.
//   Commit-1 greenness: the criterion is write-only provenance; every gate
//   still reads the post-map tier, so outcomes stay identical to Slice 3.

// Local declarations (beside the classifierTier declaration)
  let classifierAttempted = false;
  let classifierTier: RouterTier | undefined;
  let classifierCriterion: RouterWorkType | undefined;

// Rule + classifier merge branch: the criterion lands beside the
// classifierTier write (after `classifierAttempted = true;`)
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      classifierCriterion = usableResult.workType;

// Classifier-only branch: the same pairing beside the second
// classifierTier write
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      classifierCriterion = usableResult.workType;

// Decision build: the guarded copy beside the classifierTier copy
  if (classifierTier) {
    decision.classifierTier = classifierTier;
  }
  if (classifierCriterion) {
    decision.classifierCriterion = classifierCriterion;
  }
```

#### 2. `extensions/provider.ts`
**File**: `extensions/provider.ts`
**Changes**: promotion criterion copy

```typescript
// — Promotion rebuild: the guarded criterion copy lands beside the
//   classifierTier copy (provider.ts:757-759). Truthy guard mirrors the
//   classifierTier template; absent stays absent.
                if (decision.classifierTier) {
                  promotedDecision.classifierTier = decision.classifierTier;
                }
                if (decision.classifierCriterion) {
                  promotedDecision.classifierCriterion =
                    decision.classifierCriterion;
                }
```

#### 3. `extensions/commands.ts`
**File**: `extensions/commands.ts`
**Changes**: fix-writer criterion copy

```typescript
// — handleFix calibration entry: the criterion copy is guarded, never
//   defaulted — nothing is always-present to fall back to.
      const entry: ClassifierCalibrationEntry = {
        promptSummary: state.lastDecision.rawText?.slice(0, 100) ?? '',
        classifierTier:
          state.lastDecision.classifierTier ?? state.lastDecision.tier,
        finalTier: tier as RouterTier,
        userCorrection: true,
        timestamp: Date.now(),
      };
      if (state.lastDecision.classifierCriterion) {
        entry.classifierCriterion = state.lastDecision.classifierCriterion;
      }
```

#### 4. `extensions/state.ts`
**File**: `extensions/state.ts`
**Changes**: sanitizer branch, validator line, doc fix

```typescript
// — Imports: the work-type guard joins the config value imports.
import {
  isRouterTier,
  isThinkingLevel,
  isObjectRecord,
  isRouterPhase,
  isRouterWorkType,
} from './config';

// — Sanitizer doc comment (replaces the stale block at state.ts:54-61; the
//   old text cited `types.ts:70-79` and wrong optional-field counts)
/**
 * Per-field sanitizer for a persisted `RoutingDecision`.
 *
 * Required fields (`profile`, `tier`, `timestamp`) reject-whole — returns
 * `undefined` if any are bad. The 6 non-optional RoutingDecision fields
 * (`phase`, `targetProvider`, `targetModelId`, `targetLabel`, `reasoning`,
 * `thinking`) are defaulted when invalid so the returned value always
 * satisfies the interface (string → `''`, phase → `'implementation'`,
 * thinking → `'medium'`). The 16 optional fields (6 boolean flags + 10
 * classifier/veto provenance, including `classifierCriterion`) are dropped
 * if invalid.
 */

// — In-function comment (replaces the stale twin at state.ts:78-81)
  // Defaults for ALL 6 non-optional RoutingDecision fields beyond the 3
  // required ones; the interface makes them required, so we must satisfy
  // the literal type. Invalid values get safe defaults; the 16 optional
  // fields are dropped (not set) if invalid.

// — Sanitizer body: the criterion branch lands after the classifierTier
//   branch (state.ts:145-147) — without it, reload silently strips the
//   criterion from every persisted decision.
  if (isRouterTier(value.classifierTier)) {
    out.classifierTier = value.classifierTier;
  }
  if (isRouterWorkType(value.classifierCriterion)) {
    out.classifierCriterion = value.classifierCriterion;
  }

// — isRouterPersistedState calibration loop: validate-if-present (FR9).
//   Old tier-only entries skip the check entirely.
    for (const entry of v.classifierCalibration) {
      if (!isObjectRecord(entry)) return false;
      if (typeof entry.promptSummary !== 'string') return false;
      if (!isRouterTier(entry.classifierTier)) return false;
      if (!isRouterTier(entry.finalTier)) return false;
      if (typeof entry.timestamp !== 'number') return false;
      if (
        entry.classifierCriterion !== undefined &&
        !isRouterWorkType(entry.classifierCriterion)
      )
        return false;
    }
```

#### 5. `extensions/state.test.ts`
**File**: `extensions/state.test.ts`
**Changes**: dual-shape matrix

```typescript
// — Inside describe('sanitizeRoutingDecisionFields'), after the
//   'drops invalid confidence / vetoReason / failureReason' test:

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

// — Inside describe('isRouterPersistedState'), after the
//   'should ACCEPT lastDecision with bad optional fields' test:

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
```

#### 6. `extensions/provider.test.ts`
**File**: `extensions/provider.test.ts`
**Changes**: promotion preservation

```typescript
// — New test directly after 'should force higher tier if current tier does
//   not support image attachments' (:565-622). Jev-backed classifier so the
//   decision carries the criterion BEFORE the promotion rebuild runs.
    it('preserves classifierCriterion through the image promotion rebuild', async () => {
      // Jev classifier: implementation (medium) at 0.92 confidence — the
      // classifier branch wins, so the pre-promotion decision carries
      // classifierCriterion 'implementation'.
      mockState.currentConfig.classifierModel = {
        backend: 'typesafe',
        model: 'typesafe/jev-latest',
      };
      vi.mocked(readFileSync).mockReturnValue('test-key\n');
      const body = JSON.stringify({
        answers: {
          work_type: {
            type: 'choice',
            choice: 'implementation',
            confidence: 0.92,
          },
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

      // Medium tier model and fallback lack image support; high tier supports.
      mockState.currentModelRegistry.find = (
        provider: string,
        modelId: string,
      ) => {
        if (modelId === 'gpt-4o') {
          return { provider, id: modelId, input: ['text', 'image'] };
        }
        return { provider, id: modelId, input: ['text'] };
      };

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
      // The criterion rode the promotion rebuild (FR11).
      expect(mockState.lastDecision.classifierCriterion).toBe('implementation');
      expect(mockState.lastDecision.classifierTier).toBe('medium');
      expect(mockState.lastDecision.isClassifier).toBe(true);
    });
```

#### 7. `extensions/index.test.ts`
**File**: `extensions/index.test.ts`
**Changes**: old tier-only restore test + `/router fix` criterion write

```typescript
// — Inside describe('restoreStateFromSession edge cases'), after the
//   'should sync thinking level when lastDecision exists on successful
//   restore' test:

    it('should restore an old tier-only state unchanged (no criterion fields)', async () => {
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
            classifierCalibration: [
              {
                promptSummary: 'old turn',
                classifierTier: 'medium',
                finalTier: 'low',
                userCorrection: true,
                timestamp: 1,
              },
            ],
            lastDecision: {
              profile: 'balanced',
              tier: 'medium' as const,
              phase: 'implementation' as const,
              targetProvider: 'openai',
              targetModelId: 'gpt-4o-mini',
              targetLabel: 'openai/gpt-4o-mini',
              reasoning: 'Classifier: old tier-shaped answer.',
              thinking: 'medium' as const,
              timestamp: 1,
              isClassifier: true,
              classifierAttempted: true,
              classifierTier: 'medium' as const,
            },
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // The old shape validates, restores, and re-persists without gaining
      // or losing fields (FR9 dual-shape tolerance).
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          classifierCalibration: [
            expect.objectContaining({
              classifierTier: 'medium',
              finalTier: 'low',
            }),
          ],
          lastDecision: expect.objectContaining({
            classifierTier: 'medium',
          }),
        }),
      );
      // objectContaining treats an `undefined` sample as a key-presence
      // check — pin absence with `in` instead.
      const persisted = mockPi.appendEntry.mock.calls.at(-1)?.[1] as {
        lastDecision?: Record<string, unknown>;
      };
      expect('classifierCriterion' in (persisted?.lastDecision ?? {})).toBe(
        false,
      );
    });

    it('should copy classifierCriterion onto the /router fix calibration entry', async () => {
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
            lastDecision: {
              profile: 'balanced',
              tier: 'low' as const,
              phase: 'lightweight' as const,
              targetProvider: 'openai',
              targetModelId: 'gpt-4o-mini',
              targetLabel: 'openai/gpt-4o-mini',
              reasoning: 'Classifier: read-only lookup.',
              thinking: 'low' as const,
              timestamp: Date.now(),
              isClassifier: true,
              classifierAttempted: true,
              classifierTier: 'low' as const,
              classifierCriterion: 'lookup' as const,
            },
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      const routerCommand = mockPi.registerCommand.mock.calls[0][1];
      await routerCommand.handler('fix high', mockCtx);

      // The restored criterion survived sanitizeRoutingDecisionFields AND
      // rode the fix writer onto the calibration entry (FR9 + FR11).
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          pinByProfile: expect.objectContaining({ balanced: 'high' }),
          classifierCalibration: [
            expect.objectContaining({
              classifierTier: 'low',
              classifierCriterion: 'lookup',
              finalTier: 'high',
              userCorrection: true,
            }),
          ],
        }),
      );
    });
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Routing thread complete: `grep -c "classifierCriterion" extensions/routing.ts` returns >= 5
- [x] Promotion copy: `grep -n "promotedDecision.classifierCriterion" extensions/provider.ts` returns the guarded copy
- [x] Fix-writer copy: `grep -n "entry.classifierCriterion" extensions/commands.ts` returns the guarded copy
- [x] Sanitizer + validator wired: `grep -c "isRouterWorkType" extensions/state.ts` returns >= 3
- [x] Dual-shape matrix: `grep -c "classifierCriterion" extensions/state.test.ts` returns >= 6
- [x] Promotion preservation pinned: `grep -n "classifierCriterion" extensions/provider.test.ts` returns the assertion, and `grep -c "answers: { tier:" extensions/provider.test.ts` returns 0 (Jev stubs flipped)
- [x] Restore + fix pinned: `grep -c "classifierCriterion" extensions/index.test.ts` returns >= 3
- [x] Exact-equality audit: `grep -n "toEqual({" extensions/index.test.ts` shows no exact-equality router-state/lastDecision site (any surfaced site switches to `objectContaining` in Phase 4 §7)

#### Manual Verification:
- [ ] Old tier-only `router-state` entries restore unchanged — no criterion appears on the restored decision or calibration entries (dual-shape matrix)
- [ ] The promotion rebuild preserves `classifierCriterion` with the same guard shape as `classifierTier` (`provider.ts:757-759` template)
- [ ] `decideRouting` outcomes stay identical to HEAD for identical inputs (commit-1 greenness): every gate reads post-map `tier`, the criterion is write-only provenance

---

## Phase 5: Live probe

### Overview
New env-gated `scripts/probe-work-type.mjs` makes one live POST to the TypeSafe endpoint and asserts HTTP 200, an on-vocabulary `answers.work_type.choice`, and a numeric confidence. Hermetic without the env gate. The live pass gates Phase 6.

### Changes Required:

#### 1. `scripts/probe-work-type.mjs`
**File**: `scripts/probe-work-type.mjs`
**Changes**: env-gated live `work_type` POST probe (NEW file)

```javascript
#!/usr/bin/env node
// Live work_type wire probe - one real POST to the TypeSafe (Jev) endpoint.
//
// Why: mocked suites hid wire-shape defects twice (940be7f5, a44baa28).
// The probe proves the live API accepts the work_type question schema and
// answers on-vocabulary with a numeric confidence. It gates commit 2 (the
// floor-gated merge lands only after this probe passes live).
//
// ponytail: plain Node cannot import the TS builders - the source uses
// extensionless './config' specifiers that ESM will not resolve. So this
// file carries its own copy of the question SCHEMA with compact criteria
// text. Content parity is pinned by routing.test.ts (66-token multiset +
// round-trip assertions) against the real builder. If the wire schema
// changes, change both.
//
// Usage:
//   PI_MODEL_ROUTER_PROBE=1 node scripts/probe-work-type.mjs ["turn text"]
// The key comes from <agent dir>/typesafe_api_key (one line) - the same
// file readTypesafeApiKeyFile reads (extensions/typesafe.ts).
// Exit 0: HTTP 200 + on-vocabulary answers.work_type.choice + numeric
// confidence. Exit 1: gate missing, key missing, transport failure, HTTP
// error, or an unusable answer (raw body printed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Env gate first (e2e-esc-abort.mjs:54-60 pattern): nothing loads - not
// even the peer package - until the operator opts into a live paid POST.
const GATE = process.env.PI_MODEL_ROUTER_PROBE;
if (GATE !== '1') {
  console.error(
    'PI_MODEL_ROUTER_PROBE=1 must be set - this probe makes one live paid POST.',
  );
  process.exit(1);
}

// Mirrors isRouterWorkType (extensions/config.ts): the four wire choices
// plus the tolerated literal 'unknown' (a live model may answer it on an
// ambiguous turn; the mapper maps it to medium).
const WORK_TYPES = [
  'planning',
  'implementation',
  'summary',
  'lookup',
  'unknown',
];

// Mirrors TYPESAFE_ENDPOINT / TYPESAFE_DEFAULT_MODEL (extensions/typesafe.ts).
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 30_000;
const DEFAULT_TURN = 'Where is the config loader defined in this repo?';

const fail = (message) => {
  console.error(`[probe] FAIL: ${message}`);
  process.exit(1);
};

const criterion = (covers, notFor, examples, keywords) => ({
  covers,
  not_for: notFor,
  examples,
  keywords,
});

// Same question set as buildTypesafeQuestions (extensions/typesafe.ts):
// one work_type choice plus the three noul signal questions (FR12).
const questions = {
  work_type: {
    type: 'choice',
    instructions: 'Which work type fits the latest request',
    criteria: {
      planning: criterion(
        'Design judgment, planning, tradeoff analysis, broad debugging, large refactors, codebase research; long detailed requests.',
        'Bounded edits with a known plan, routine implementation, tests and fixes, summaries, lookups.',
        'Design the migration plan; analyze why the build is slow; weigh two approaches.',
        ['plan', 'design', 'research', 'analyze', 'refactor'],
      ),
      implementation: criterion(
        'Hands-on implementation with a clear target: writing or editing code, fixes, tests, patches, continuing in-progress work.',
        'Open-ended design or research (planning); summaries and read-only lookups (summary or lookup).',
        'Implement the agreed change; fix this failing test; continue the work.',
        ['implement', 'fix', 'update', 'refactor', 'continue'],
      ),
      summary: criterion(
        'Short bounded low-effort outputs: summaries, recaps, formatting, renames, brief explanations.',
        'Anything that writes or changes code (implementation); read-only lookups (lookup); design work (planning).',
        'Summarize this diff; tl;dr of that document; reformat this file.',
        ['summarize', 'tl;dr', 'reformat', 'briefly'],
      ),
      lookup: criterion(
        'Read-only lookups that locate information: where something lives, which files match, quick factual checks.',
        'Requests that write or change anything (implementation); explanations and text transforms (summary).',
        'Where is the config loader defined; which file exports the map.',
        ['where is', 'which file', 'find', 'grep'],
      ),
    },
  },
  long_request: {
    type: 'noul',
    instructions:
      'Is the latest turn a long, detailed request (roughly 40+ words)?',
    criteria: {
      true: 'The turn is long and detailed: roughly 40 or more words, or several distinct requirements.',
      false: 'The turn is short: one simple ask, well under 40 words.',
    },
  },
  structured_request: {
    type: 'noul',
    instructions:
      'Does the latest turn span multiple lines in a structured or detailed way?',
    criteria: {
      true: 'The turn has 4 or more lines, or uses structure: steps, lists, code blocks.',
      false: 'The turn is a single line or one plain sentence.',
    },
  },
  implementation_context: {
    type: 'noul',
    instructions:
      'Does the recent history show active implementation work (tool results or code edits)?',
    criteria: {
      true: 'Recent history shows tool results, code edits, file writes, or test runs.',
      false: 'Recent history shows only questions, chat, or discussion.',
    },
  },
};

const main = async () => {
  const turn = process.argv[2] ?? DEFAULT_TURN;
  const state = {
    latest_turn: turn,
    recent_history: '',
    has_image: false,
  };

  // Dynamic on purpose: the gate check above must stay hermetic - a bare
  // `node scripts/probe-work-type.mjs` with no env prints usage and exits
  // without loading any package.
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const keyPath = join(getAgentDir(), 'typesafe_api_key');
  let apiKey = '';
  try {
    apiKey = readFileSync(keyPath, 'utf8').trim();
  } catch {
    // absent or unreadable - same as readTypesafeApiKeyFile returning undefined
  }
  if (!apiKey) fail(`no API key - expected one line in ${keyPath}`);

  console.log(`[probe] POST ${ENDPOINT} model=${MODEL}`);
  console.log(`[probe] turn: ${turn}`);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    fail(`transport failure: ${error.message}`);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fail(`200-OK body is not JSON: ${rawBody.slice(0, 500)}`);
  }

  const answer = body?.answers?.work_type;
  const choice =
    typeof answer?.choice === 'string'
      ? answer.choice.trim().toLowerCase()
      : undefined;
  if (!choice || !WORK_TYPES.includes(choice)) {
    fail(
      `answers.work_type.choice not in vocabulary: ${JSON.stringify(answer ?? body).slice(0, 500)}`,
    );
  }
  if (
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence)
  ) {
    fail(
      `answers.work_type.confidence is not numeric: ${JSON.stringify(answer).slice(0, 500)}`,
    );
  }

  console.log(
    `[probe] OK: work_type=${choice} confidence=${answer.confidence.toFixed(2)}`,
  );
  console.log(`[probe] answers: ${JSON.stringify(body.answers)}`);
};

main().catch((error) => {
  console.error(`[probe] unexpected: ${error?.stack ?? error}`);
  process.exit(1);
});
```


### Success Criteria:

#### Automated Verification:
- [x] Gate refusal is hermetic: `node scripts/probe-work-type.mjs` (env unset) exits 1 and prints the `PI_MODEL_ROUTER_PROBE` usage line
- [ ] Live probe passes: `PI_MODEL_ROUTER_PROBE=1 node scripts/probe-work-type.mjs` exits 0 - HTTP 200, `answers.work_type.choice` in vocabulary, numeric confidence
- [x] Wire schema present: `grep -c "work_type" scripts/probe-work-type.mjs` returns >= 5
- [x] Fail-fast paths wired: `grep -c "process.exit(1)" scripts/probe-work-type.mjs` returns >= 3

#### Manual Verification:
- [ ] Question schema matches the extension request shape: `work_type` choice question + the three noul questions, criterion fields `covers`/`not_for`/`examples`/`keywords`; criteria text is deliberately compact - content parity stays pinned by the routing.test.ts 66-token multiset test against the real `buildTypesafeQuestions`
- [ ] A failed probe prints its cause for diagnosis: the expected key file path, the HTTP status with raw body, or the off-vocabulary answer
- [ ] The probe is a repo dev tool only - `scripts/` is outside package.json `files`, so nothing ships to npm
- [ ] A small live chat-backend sample ran (~5 turns through `runClassifier`'s work-type prompt); the unparseable rate was recorded (Testing Strategy §6)

---

## Phase 6: Floor-gated merge

### Overview
The rule + classifier merge loses its local `tierRank`: the classifier displaces the rule when certainty clears `CLASSIFIER_OVERRIDE_FLOOR` and the mapped tier differs — above or below (FR4). Floors stay 0.85/0.85/0.5; only the JSDoc meaning changes (FR5).

### Changes Required:

#### 1. `extensions/routing.ts`
**File**: `extensions/routing.ts`
**Changes**: floor-gated differs merge replacing the `tierRank` comparison

```typescript
// — Slice 6: floor-gated differs merge (FR4). The rule + classifier branch
//   loses its local tierRank; the classifier displaces the rule when its
//   certainty clears CLASSIFIER_OVERRIDE_FLOOR and its mapped tier differs
//   from the rule's tier — above or below. matchHighestTierRule's internal
//   rank survives: it ranks rules against rules.

// Rule + classifier merge branch (inside decideRouting) — full replacement:
    if (ruleMatch && usableResult) {
      // Rule + classifier both present: merge logic. The classifier
      // displaces the rule when its certainty clears the override floor
      // (numeric first; word fallback keeps the chat path identical) and
      // its mapped tier differs from the rule's tier — above or below (FR4).
      classifierAttempted = true;
      classifierTier = usableResult.tier;
      classifierCriterion = usableResult.workType;
      if (
        isHighConfidence(usableResult, CLASSIFIER_OVERRIDE_FLOOR) &&
        usableResult.tier !== ruleMatch.tier
      ) {
        isClassifier = true;
        tier = usableResult.tier;
        phase = previousDecision?.phase ?? phaseForTier(tier);
        reasoning = `Classifier: ${usableResult.reasoning} (merged: classifier high-confidence preferred over rule)`;
        vetoOutcome = 'classifier-wins';
      } else {
        tier = ruleMatch.tier;
        phase = phaseForTier(tier);
        reasoning = ruleMatch.reasoning;
        isRuleMatched = true;
        // vetoOutcome left undefined — rule won, no veto occurred
      }
    } else if (ruleMatch) {
```

#### 2. `extensions/constants.ts`
**File**: `extensions/constants.ts`
**Changes**: floors JSDoc reworded to criterion certainty

```typescript
// Floors stay 0.85/0.85/0.5 (FR5). Only the JSDoc meaning changes: the
// number now measures certainty of the work-type classification (FR4).
/**
 * Numeric certainty floor for the classifier answer to displace a matched
 * rule. At or above it, the mapped tier wins whenever it differs from the
 * rule's tier — above or below.
 */
export const CLASSIFIER_OVERRIDE_FLOOR = 0.85;
/**
 * Numeric certainty floor for the classifier answer to survive an
 * explicit-hint veto. Below it, the hint overrides the mapped tier.
 */
export const CLASSIFIER_VETO_FLOOR = 0.85;
/**
 * Numeric certainty floor below which a classifier answer degrades to
 * heuristics.
 */
export const CLASSIFIER_DEGRADE_FLOOR = 0.5;
```

#### 3. `extensions/routing.test.ts`
**File**: `extensions/routing.test.ts`
**Changes**: FR4 acceptance + boundary tests

```typescript
// — Slice 6: FR4 floor-gated differs merge. The rank comparison is gone;
//   a high-certainty answer pulls the tier below the rule too.

// Import additions at the top of the file:
//   the './types' type-import list gains RouterWorkType
//   new value import: import { WORK_TYPE_TO_TIER } from './config';

// New describe, placed inside describe('decideRouting'), directly after
// the 'numeric confidence floors (additive seam)' describe:
    describe('FR4 floor-gated differs merge', () => {
      const criterion = (
        workType: RouterWorkType,
        n: number,
      ): ClassifierResult => ({
        tier: WORK_TYPE_TO_TIER[workType],
        workType,
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
      const mergeCtx = (): Context => ({
        messages: [
          { role: 'user', content: 'continue the work', timestamp: Date.now() },
        ],
      });

      it('FR4: lookup at 0.86 pulls below the medium rule', () => {
        const decision = decideRouting(
          mergeCtx(), 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          criterion('lookup', 0.86),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('low');
        expect(decision.isClassifier).toBe(true);
        expect(decision.isRuleMatched).toBeFalsy();
        expect(decision.confidence).toBe('high');
        expect(decision.classifierTier).toBe('low');
        expect(decision.classifierCriterion).toBe('lookup');
        expect(decision.vetoOutcome).toBe('classifier-wins');
      });

      it('FR4 boundary: lookup at exactly 0.85 clears the floor and wins', () => {
        const decision = decideRouting(
          mergeCtx(), 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          criterion('lookup', 0.85),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('low');
        expect(decision.isClassifier).toBe(true);
      });

      it('FR4 under-floor: lookup at 0.84 loses to the rule', () => {
        const decision = decideRouting(
          mergeCtx(), 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          criterion('lookup', 0.84),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('medium');
        expect(decision.isRuleMatched).toBe(true);
        expect(decision.isClassifier).toBeFalsy();
        expect(decision.classifierAttempted).toBe(true);
        expect(decision.classifierCriterion).toBe('lookup');
      });

      it('FR4 equal-tier: certainty alone does not displace an equal rule', () => {
        const decision = decideRouting(
          mergeCtx(), 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          criterion('implementation', 0.9),
          ruleHitMedium,
        );
        expect(decision.tier).toBe('medium');
        expect(decision.isRuleMatched).toBe(true);
        expect(decision.isClassifier).toBeFalsy();
      });

      it('FR4 word fallback (chat path): high-confidence low answer pulls below the rule', () => {
        const decision = decideRouting(
          mergeCtx(), 'p', profile, undefined,
          undefined, undefined, undefined, undefined, undefined,
          {
            tier: 'low',
            workType: 'lookup',
            confidence: 'high',
            reasoning: 'Simple lookup.',
            rawText: 'Work type: lookup',
            failureReason: 'success',
          },
          ruleHitMedium,
        );
        expect(decision.tier).toBe('low');
        expect(decision.isClassifier).toBe(true);
        expect(decision.confidenceNumeric).toBeUndefined();
      });
    });
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Differs gate in place: `grep -Fn "usableResult.tier !== ruleMatch.tier" extensions/routing.ts` returns the merge gate line
- [x] Rank comparison gone from the merge gate: `grep -c "const tierRank" extensions/routing.ts` returns 1 (the `matchHighestTierRule` internal rank only)
- [x] FR4 acceptance pinned: `grep -n "pulls below the medium rule" extensions/routing.test.ts` returns the 0.86 test
- [x] FR4 boundaries pinned: `grep -cE "exactly 0.85 clears the floor|0.84 loses to the rule" extensions/routing.test.ts` returns >= 2
- [x] Floor values unchanged: `grep -cE "CLASSIFIER_OVERRIDE_FLOOR = 0.85|CLASSIFIER_VETO_FLOOR = 0.85|CLASSIFIER_DEGRADE_FLOOR = 0.5" extensions/constants.ts` returns 3

#### Manual Verification:
- [ ] Ordering gate held: the live probe passed before this slice lands (`PI_MODEL_ROUTER_PROBE=1 node scripts/probe-work-type.mjs` exits 0)
- [ ] Floors stay 0.85/0.85/0.5 — only the JSDoc meaning changed (FR5)
- [ ] The three pre-existing upward merge tests stay green unchanged — the differs test only adds the pull-below direction

---

## Phase 7: Heuristic classify + nudge

### Overview
The heuristic branch classifies a work type through the existing keyword sets, applies the nudges in work-type space, then converts once through the shared map (FR8). Arm precedence is unchanged from HEAD and pinned by tests. `unknown` keeps the medium default, the previous phase, and the default reasoning (FR1).

### Changes Required:

#### 1. `extensions/routing.ts`
**File**: `extensions/routing.ts`
**Changes**: heuristic classify + nudge split (full branch replacement)

```typescript
// — Slice 7: heuristic classify + nudge (FR8). The heuristic branch stops
//   picking a tier directly: it classifies a work type through the existing
//   keyword sets, applies the nudges in work-type space, then converts once
//   through WORK_TYPE_TO_TIER — equivalent to the decision's post-map tier
//   nudges because the map is deterministic and nothing downstream reads
//   the heuristic work type. Arm precedence is unchanged from HEAD — hints
//   preempt keywords, summary beats complexity, phase-bias/tool/short arms
//   fire only when no keyword arm matched. 'unknown' keeps the medium
//   default, the previous phase, and the default reasoning (FR1). No import
//   changes: Slice 3 already imported RouterWorkType and WORK_TYPE_TO_TIER.

// Full replacement of the heuristic branch (the
// `if (!isClassifier && !ruleMatch && !pinnedTier)` block inside
// decideRouting):
    if (!isClassifier && !ruleMatch && !pinnedTier) {
      // Heuristic branch (also reached on low-confidence degrade)
      const highThreshold = Math.max(
        40,
        120 - (previousDecision?.phase === 'planning' ? phaseBias * 80 : 0),
      );
      const lowThreshold = Math.max(
        4,
        12 -
          (previousDecision?.phase === 'implementation' ||
          previousDecision?.phase === 'planning'
            ? phaseBias * 8
            : 0),
      );

      // Step 1 — classify: keyword arms only (hints preempt, summary beats
      // planning). Complexity signals are nudges, not classify arms. Every
      // non-unknown arm pairs its work type with the HEAD reasoning string,
      // so outcomes stay identical for identical inputs.
      let workType: RouterWorkType = 'unknown';
      let heuristicReasoning = reasoning;

      if (containsAnyWord(prompt, explicitHighHints)) {
        workType = 'planning';
        heuristicReasoning =
          'Detected an explicit request for deeper or higher-quality reasoning.';
      } else if (containsAnyWord(prompt, explicitLowHints)) {
        workType = 'summary';
        heuristicReasoning =
          'Detected an explicit request for a faster or lighter response.';
      } else if (containsAnyWord(prompt, summaryKeywords)) {
        workType = 'summary';
        heuristicReasoning =
          'Detected summary or lightweight transformation keywords.';
      } else if (
        containsAnyWord(prompt, planningKeywords) ||
        prompt.startsWith('why ')
      ) {
        workType = 'planning';
        heuristicReasoning =
          previousDecision?.phase === 'planning'
            ? 'Continued planning phase based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      } else if (containsAnyWord(prompt, implementationKeywords)) {
        workType = 'implementation';
        heuristicReasoning =
          'Detected implementation-oriented work with bounded execution scope.';
      } else if (
        containsAnyWord(prompt, lookupKeywords) &&
        wordCount <= 24 &&
        toolResultCount === 0
      ) {
        workType = 'lookup';
        heuristicReasoning = 'Detected a short read-only lookup request.';
      }

      // Step 2 — complexity nudge (the raise): a long or multi-line turn
      // raises every classification except summary (HEAD arm order: the
      // complexity arm sat below summary, above implementation/lookup) and
      // except planning (nothing to raise; high-hint planning keeps its own
      // reasoning string).
      if (
        (wordCount >= highThreshold || multiLinePrompt) &&
        workType !== 'summary' &&
        workType !== 'planning'
      ) {
        workType = 'planning';
        heuristicReasoning =
          previousDecision?.phase === 'planning'
            ? 'Continued planning phase based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      }

      // Step 3 — unknown-only nudges, in HEAD order: phase bias, then
      // tool/plan context, then shortness. These never displace a keyword
      // classification.
      if (workType === 'unknown') {
        if (
          previousDecision?.phase === 'planning' &&
          toolResultCount === 0 &&
          wordCount > lowThreshold
        ) {
          workType = 'planning';
          heuristicReasoning =
            'Kept the planning-phase bias because the conversation still looks exploratory.';
        } else if (
          toolResultCount > 0 ||
          previousDecision?.phase === 'implementation' ||
          recentConversation.includes('plan:')
        ) {
          workType = 'implementation';
          heuristicReasoning =
            'Detected active implementation work from prior tools or recent plan execution context.';
        } else if (wordCount <= lowThreshold) {
          workType = 'summary';
          heuristicReasoning = 'Detected a short bounded request.';
        }
      }

      // Step 4 — convert through the shared map and apply (FR8). The
      // 'unknown' path keeps tier medium, the previous phase, and the
      // default reasoning — heuristicReasoning still holds it (FR1).
      if (workType !== 'unknown') {
        tier = WORK_TYPE_TO_TIER[workType];
        phase = phaseForTier(tier);
      }
      reasoning = heuristicReasoning;
    }
```

#### 2. `extensions/routing.test.ts`
**File**: `extensions/routing.test.ts`
**Changes**: FR8 precedence pins

```typescript
// — Slice 7: describe('FR8 heuristic classify + nudge') — new block inside
//   describe('decideRouting'), placed directly after the 'FR4 floor-gated
//   differs merge' describe. Pins the arm precedence the classify + nudge
//   split must preserve. No import changes: decideRouting,
//   buildRoutingDecision, and countWords are already imported.
    describe('FR8 heuristic classify + nudge', () => {
      // Single-line filler (space-joined, so multiLinePrompt stays false;
      // no keyword from any heuristic set). highThreshold is 120 with no
      // previous decision, so the block repeats 3x: 124 words seeded.
      const longWords = (seed: string): string =>
        [
          seed,
          ...Array.from({ length: 3 }, () => [
            'i wonder about some random topic that doesnt match any particular',
            'keyword category here today now plus more filler words that keep',
            'going well past the forty word threshold for complexity detection',
            'purposes entirely and safely still further along today now',
          ]).flat(),
        ].join(' ');

      it('FR8: summary beats complexity — a long summarize request stays low', () => {
        const content = longWords('summarize');
        expect(countWords(content)).toBeGreaterThanOrEqual(120);
        const context: Context = {
          messages: [{ role: 'user', content, timestamp: Date.now() }],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('low');
        expect(decision.phase).toBe('lightweight');
        expect(decision.reasoning).toBe(
          'Detected summary or lightweight transformation keywords.',
        );
      });

      it('FR8: complexity raises an implementation prompt to planning', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content: longWords('fix'),
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('high');
        expect(decision.phase).toBe('planning');
        expect(decision.reasoning).toContain('high-complexity');
      });

      it('FR8: complexity raises a multi-line lookup to planning', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content:
                'where is the config\nplease tell me the location\nof the loader module\nin this repository',
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('high');
        expect(decision.phase).toBe('planning');
      });

      it('FR8: a short read-only lookup maps to low', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content: 'where is the config loader defined',
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('low');
        expect(decision.phase).toBe('lightweight');
        expect(decision.reasoning).toBe(
          'Detected a short read-only lookup request.',
        );
      });

      it('FR8: an unknown long prompt maps to planning through the complexity nudge', () => {
        const context: Context = {
          messages: [
            {
              role: 'user',
              content: longWords('hello'),
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('high');
        expect(decision.phase).toBe('planning');
        expect(decision.reasoning).toContain('high-complexity');
      });

      it('FR8: an unknown short prompt maps to summary through the short nudge', () => {
        const context: Context = {
          messages: [
            { role: 'user', content: 'hi there', timestamp: Date.now() },
          ],
        };
        const decision = decideRouting(context, 'p', profile, undefined);
        expect(decision.tier).toBe('low');
        expect(decision.phase).toBe('lightweight');
        expect(decision.reasoning).toBe('Detected a short bounded request.');
      });

      it('FR8: an unknown prompt with no nudge keeps medium, the previous phase, and the default reasoning', () => {
        const previous = buildRoutingDecision(
          'p',
          profile,
          'low',
          'lightweight',
          'Previous lightweight',
        );
        const context: Context = {
          messages: [
            {
              role: 'user',
              content:
                'i wonder about some random topic that doesnt match anything here today now',
              timestamp: Date.now(),
            },
          ],
        };
        const decision = decideRouting(context, 'p', profile, previous);
        expect(decision.tier).toBe('medium');
        expect(decision.phase).toBe('lightweight');
        expect(decision.reasoning).toContain('Defaulted to medium');
      });
    });
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Classify seed present: `grep -n "let workType: RouterWorkType = 'unknown'" extensions/routing.ts` returns the heuristic classify declaration
- [x] Heuristic conversion through the shared map: `grep -Fc "WORK_TYPE_TO_TIER[workType]" extensions/routing.ts` returns >= 2 (the Slice 3 chat return + the heuristic convert)
- [x] Complexity skip + raise pinned: `grep -cE "beats complexity|complexity raises" extensions/routing.test.ts` returns >= 3
- [x] Precedence pins present: `grep -c "FR8:" extensions/routing.test.ts` returns >= 7
- [x] HEAD reasoning strings preserved: `grep -cE "Detected a short bounded request\.|Detected a short read-only lookup request\." extensions/routing.ts` returns 2
- [x] Merge gate untouched: `grep -c "const tierRank" extensions/routing.ts` returns 1 (Slice 6 invariant holds)

#### Manual Verification:
- [ ] Heuristic outcomes identical to HEAD for identical inputs — precedence: hints -> summary -> planning/`why ` -> implementation -> gated lookup -> complexity nudge -> unknown-only nudges (phase-bias -> tool/plan -> short)
- [ ] `unknown` keeps tier medium, the previous decision's phase, and the default reasoning (FR1 ambiguous -> medium)
- [ ] The Jev backend, chat wire pair, and merge gate stay untouched (Slices 2, 3, 6 remain as locked)

---

## Phase 8: Criterion wording

### Overview
The criterion appears on the notify provenance suffix, `formatDecision`, the status line, and the widget Route line through the shared `formatCriterionSuffix` helper (FR11). Criterion-free decisions render byte-identical to HEAD.

### Changes Required:

#### 1. `extensions/index.ts`
**File**: `extensions/index.ts`
**Changes**: notify criterion wording

```typescript
// — recordDebugDecision: the notify provenance suffix names the criterion
//   (FR11). Same gate as the confidence suffix — the criterion rides the
//   classifier-source branch only, so rule/pin/heuristic notifies render
//   exactly as before.
      const criterion =
        decision.isClassifier && decision.classifierCriterion
          ? `${decision.classifierCriterion}, `
          : '';
      const provenance =
        decision.isClassifier && decision.confidenceNumeric !== undefined
          ? ` (${criterion}confidence: ${decision.confidenceNumeric.toFixed(2)})`
          : decision.isClassifier && decision.confidence
            ? ` (${criterion}confidence: ${decision.confidence})`
            : '';
      // notify call line unchanged — provenance now carries the criterion:
      // `router → openai/gpt-4o-mini [low, classifier] (lookup, confidence: 0.97)`
```

#### 2. `extensions/ui.ts`
**File**: `extensions/ui.ts`
**Changes**: `formatCriterionSuffix` + `formatDecision`/status/widget criterion display

```typescript
// — After getDecisionFlags (closes ui.ts:28), before formatDecision
//   (opens ui.ts:30): the criterion suffix helper (FR11). Module-local —
//   three tier displays share it (formatDecision :30-33, status :107,
//   widget Route :139-141).
/**
 * Criterion suffix for tier displays: ` (lookup)` in `Route: low (lookup)`.
 * Empty when the decision carries no classifier criterion, so
 * criterion-free decisions render exactly as before (FR11). Pin and
 * pure-heuristic decisions never carry one. Rule-won, degraded, and
 * budget-forced decisions can carry one — the suffix is provenance of
 * what the classifier answered, not a source label.
 */
const formatCriterionSuffix = (decision: RoutingDecision): string =>
  decision.classifierCriterion ? ` (${decision.classifierCriterion})` : '';

// — formatDecision: the tier gains the criterion suffix
export const formatDecision = (decision: RoutingDecision): string => {
  const confidence = decision.confidence ? ` {${decision.confidence}}` : '';
  return `${decision.profile}: ${decision.tier}${formatCriterionSuffix(decision)} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}] (${decision.reasoning})${confidence}`;
};

// — updateStatus, status-text branch (matchesProfile && matchesPin):
//   the tier gains the criterion suffix
      statusText = `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier}${formatCriterionSuffix(lastDecision)} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`;

// — updateStatus, widget Route line: criterion suffix before the flags
    widgetLines.push(
      `Route: ${lastDecision.tier}${formatCriterionSuffix(lastDecision)}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`,
      `Phase: ${lastDecision.phase}`,
    );
```

#### 3. `extensions/ui.test.ts`
**File**: `extensions/ui.test.ts`
**Changes**: wording tests

```typescript
// — Inside describe('formatDecision'), after the existing test:
    it('should append the classifier criterion after the tier when present', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Exploratory prompts',
        thinking: 'high',
        timestamp: Date.now(),
        classifierCriterion: 'planning',
      };
      const formatted = formatDecision(decision);
      expect(formatted).toBe(
        'balanced: high (planning) -> google/gemini-2.5-pro [high] (Exploratory prompts)',
      );
    });

// — Inside describe('updateStatus'), after the pins test:
    it('should show the criterion in the status line and widget Route line', () => {
      const ctx = buildMockCtx() as any;
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'low',
        phase: 'lightweight',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o-mini',
        targetLabel: 'openai/gpt-4o-mini',
        reasoning: 'Classifier: read-only lookup.',
        thinking: 'low',
        timestamp: Date.now(),
        isClassifier: true,
        classifierAttempted: true,
        classifierTier: 'low',
        classifierCriterion: 'lookup',
        confidence: 'high',
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        true,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> low (lookup) -> openai/gpt-4o-mini (low)',
      );

      const widgetCalls = ctx.ui.setWidget.mock.calls[0];
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain(
        '[dim]Route: low (lookup) [classifier] -> openai/gpt-4o-mini (low)[/dim]',
      );
    });

    it('should show the criterion beside a rule-won route as provenance', () => {
      const ctx = buildMockCtx() as any;
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o-mini',
        targetLabel: 'openai/gpt-4o-mini',
        reasoning: 'rule medium',
        thinking: 'medium',
        timestamp: Date.now(),
        isRuleMatched: true,
        classifierAttempted: true,
        classifierTier: 'low',
        classifierCriterion: 'lookup',
      };

      updateStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        true,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> medium (lookup) -> openai/gpt-4o-mini (medium)',
      );
      const widgetCalls = ctx.ui.setWidget.mock.calls[0];
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain(
        '[dim]Route: medium (lookup) [rule,classifier-failed] -> openai/gpt-4o-mini (medium)[/dim]',
      );
    });
```


### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `npm test`
- [x] Type check passes: `npm run tsc`
- [x] Suffix helper wired: `grep -c "formatCriterionSuffix" extensions/ui.ts` returns >= 4 (definition + formatDecision + status line + widget Route)
- [x] Notify provenance interpolates the criterion: `grep -c "criterion}confidence" extensions/index.ts` returns >= 2 (both suffix branches)
- [x] Widget wording pinned: `grep -n "Route: low (lookup)" extensions/ui.test.ts` returns the assertion
- [x] Status wording pinned: `grep -c "low (lookup)" extensions/ui.test.ts` returns >= 2
- [x] Rule-won provenance pinned: `grep -n "medium (lookup)" extensions/ui.test.ts` returns the assertion
- [x] formatDecision suffix pinned: `grep -n "high (planning)" extensions/ui.test.ts` returns the assertion

#### Manual Verification:
- [ ] Old criterion-free decisions render byte-identical to HEAD — the pre-existing exact-string assertions in ui.test.ts stay green unchanged
- [ ] The suffix appears if and only if `classifierCriterion` is present. Pin and pure-heuristic decisions never show one. Rule-won, degraded (`routing.ts:507-515`), and budget-forced (`routing.ts:645-664`) decisions can show one — the suffix is provenance of the classifier answer, not a source label
- [ ] `/router debug` history lines show the criterion through `formatDecision` (`commands.ts:27,498` — no commands.ts edit in this slice)

---

## Testing Strategy

### Automated:
- `npm test` (vitest run) and `npm run tsc` exit 0 after every phase that touches code — run after commit-1 phases (1-4) and again after commit-2 phases (6-8)
- Per-phase greps listed in each phase's `#### Automated Verification:` block

### Manual Testing Steps:
1. `npm test` (vitest run) and `npm run tsc` exit 0 after every slice that touches code; run after commit-1 slices and again after commit-2 slices.
2. FR4 acceptance: `criterion('lookup', 0.86)` + a medium rule → low tier, confidence high; boundary 0.85 wins; 0.84 under-floor loses to the rule.
3. Acceptance grep for the banned comparison must be scoped: `grep -n "tierRank" extensions/routing.ts` returns only `matchHighestTierRule`'s internal rank (`:296`/`:302`), never a `usableResult.tier` comparison.
4. Guard tests use `'lookup'`/`'summary'` — `'planning'`/`'implementation'` also satisfy `isRouterPhase` and cannot prove the guard fired.
5. Live probe (not mockable, proven twice): `node scripts/probe-work-type.mjs` with the env gate set; asserts HTTP 200, `answers.work_type.choice` in vocabulary, numeric confidence.
6. Chat-backend reliability on work-type words is unmeasured; keep the unparseable → `undefined` taxonomy and budget a small live sample.
7. Follow-up fix within days is the historical norm (3 of 4 reworks) — the staged shape keeps its blast radius small.
8. `index.test.ts` uses `toHaveBeenCalledWith('router-state', expect.objectContaining(...))` at several sites — new optional fields ride `objectContaining`; exact-equality assertions (if any surface) must switch to `objectContaining`.
9. Two validation artifacts (one per commit) match the repo's plan → validate → commit cadence.

## Performance Considerations

No additional model call per turn: one POST (typesafe) or one stream (chat), same as today. `WORK_TYPE_TO_TIER` lookup is O(1). Keyword scans unchanged. Probe script runs out-of-band only.

## Migration Notes

Persisted state is additive-only: new fields optional, validate-if-present in `isRouterPersistedState`, drop-if-invalid in `sanitizeRoutingDecisionFields`. Old tier-only `router-state` entries and calibration entries restore unchanged. One invalid calibration entry still rejects the whole state — the new line adds no required field, so old sessions are safe. Rollback: revert commit 2, then commit 1; persisted entries written by the new code validate under the old validators (extra fields tolerated by the per-field allow-list).

## Developer Context

- Step 5 triage was delegated by the developer to the advisor model (rpiv-advisor); resolutions follow advisor guidance. Static confirmation ran before the blocker apply: `grep` found the stale `answers.tier` stubs at `extensions/provider.test.ts:1573` and `:1617` only (routing.test.ts `Tier:` strings belong to Phase 3's replaced blocks; routing.ts `tierLine` belongs to Phase 3's parser replacement).
- Design follow-up (blocker row): add `extensions/provider.test.ts` to design Slice 2's file list — the design artifact was not edited in this session.
- Row 5 (validation artifacts): two validation artifacts, one per commit, remain a validate-stage obligation (`.rpiv/artifacts/validations/`), not a phase gate.
- Transcription repair (row 2): a chunked-read defect duplicated one guard line and dropped the design's last References bullet during Step 3; both repaired and all 25 code fences verified verbatim against the design.

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 2 §1 (typesafe.ts) | extensions/provider.test.ts:1573 | blocker | actionability | Phase 2 flips the mapper to read `answers?.work_type`, but the two provider.test.ts Jev fetch stubs still send `answers: { tier: { type: 'choice', choice: 'high', confidence: 0.95 } }` and are only flipped in Phase 4 §6, so Phase 2's own success criterion `npm test` fails — `should run the classifier through the Jev backend when configured` (provider.test.ts:1605-1607) gets a `json-invalid` fallback (heuristic branch), breaking `expect(...isClassifier).toBe(true)`, `expect(...tier).toBe('high')`, and `delegated).toEqual(['gpt-4o'])` | Move the two mechanical provider.test.ts wire flips (Phase 4 §6's first bullet) into Phase 2 §2 so the wire key and its stubs flip in the same phase | applied (plan-local; design follow-up: `.rpiv/artifacts/designs/2026-09-24_10-33-41_criterion-tier-mapping.md` — add `extensions/provider.test.ts` to Slice 2's file list) |
| code | Phase 2 §1 (typesafe.ts) | <n/a> | suggestion | code-quality | `mapTypesafeResponse`'s confidence guard duplicates the condition — `typeof confidenceNumeric !== 'number' \|\| typeof confidenceNumeric !== 'number' \|\|` — the second line is dead (HEAD has the check once) | Delete the duplicated `typeof confidenceNumeric !== 'number' \|\|` line, restoring the HEAD three-clause guard | applied (transcription repair; plan realigned verbatim to design) |
| coverage | ## Testing Strategy §6 | <n/a> | concern | verification-coverage | Note "Chat-backend reliability on work-type words is unmeasured; … budget a small live sample" — no Success Criteria bullet (Phase 5's probe and all live-verification bullets cover only the Jev/typesafe endpoint; nothing exercises the chat work-type wire live) and no code mirror (no probe/test samples the chat backend) | Add a `#### Manual Verification:` bullet under Phase 5: run a small live chat-backend sample (e.g. 5 turns through `runClassifier`'s work-type prompt) and record the unparseable rate, or add a `--chat` mode to `scripts/probe-work-type.mjs` gated the same way | applied (Manual Verification bullet added under Phase 5; no probe code change) |
| coverage | ## Testing Strategy §8 | <n/a> | concern | verification-coverage | Note "exact-equality assertions (if any surface) must switch to `objectContaining`" — no criteria bullet audits `index.test.ts` for exact-equality router-state/lastDecision assertions (Phase 4 bullets only grep-count `classifierCriterion`), and the Phase 4 §7 slice mirrors only new tests already using the idiom; no existing-site audit or switch shown | Add a Phase 4 `#### Automated Verification:` bullet auditing for the shape, e.g. `grep -nE "toEqual\(\{|toHaveBeenCalledWith\('router-state', \{" extensions/index.test.ts` returns only `objectContaining` sites, and switch any surfaced exact-equality site in Phase 4 §7 | applied (Phase 4 Automated bullet added; reviewer's BRE-fragile dual-pattern grep replaced with the fixed form) |
| coverage | ## Testing Strategy §9 | <n/a> | suggestion | verification-coverage | Note "Two validation artifacts (one per commit) match the repo's plan → validate → commit cadence" — no Success Criteria bullet in any phase names a validation artifact and no code mirror exists (process obligation) | Add a `#### Manual Verification:` bullet under Phase 4 ("commit 1 validation artifact written") and under Phase 8 ("commit 2 validation artifact written") naming the `.rpiv/artifacts/validations/` path | dismissed: validate-stage pipeline obligation, not an implementable phase gate; recorded in Developer Context |

## References

- Design: `.rpiv/artifacts/designs/2026-09-24_10-33-41_criterion-tier-mapping.md`
- `.rpiv/artifacts/solutions/2026-09-24_10-13-40_criterion-tier-mapping.md` — selected approach (Option 2)
- `.rpiv/artifacts/research/2026-09-24_09-37-49_criterion-tier-mapping.md` — research spec (checkpoint decisions)
- `.rpiv/artifacts/discover/2026-09-24_09-09-17_criterion-tier-mapping.md` — FRD
- `.rpiv/artifacts/validation/2026-09-24_08-09-01_jev-classifier-aligned-to-the-documented-typesafe-system-one-contract.md` — wire-shape defect evidence + probe prescription
- `extensions/a44baa28` (git) — closest single-commit analog
