---
date: 2026-09-23T16:09:03+0700
author: Yogiswara Utama
commit: 1673674c
branch: main
repository: pi-model-router
topic: "add Jev (typesafe.ai System One) as the model classifier backend"
tags: [plan]
status: ready
phase_count: 1
phases:
  - { n: 1, title: "Jev (TypeSafe System One) classifier backend", files: [extensions/typesafe.ts, extensions/types.ts, extensions/config.ts, extensions/routing.ts, extensions/provider.ts, extensions/routing.test.ts, extensions/config.test.ts, extensions/provider.test.ts, model-router.example.json, README.md], depends_on: [] }
acceptance:
  - { id: a1, disposition: implemented, phase: 1 }
  - { id: a2, disposition: implemented, phase: 1 }
  - { id: a3, disposition: implemented, phase: 1 }
  - { id: a4, disposition: implemented, phase: 1 }
  - { id: a5, disposition: implemented, phase: 1 }
  - { id: a6, disposition: implemented, phase: 1 }
last_updated: 2026-09-23T16:09:03+0700
---

# Jev (TypeSafe System One) Classifier Backend Implementation Plan

## Overview

This plan adds Jev (typesafe.ai System One) as a second model classifier backend. The router
keeps the existing chat classifier as the default. A new `backend: "typesafe"` config field
selects one structured POST to the System One endpoint. The tier question asks for one of the
three router criteria, so the answer maps to a tier directly and no output parser is needed.
The API key comes from `TYPESAFE_API_KEY` in the environment.

Grounding: `.rpiv/artifacts/research/2026-09-23_16-05-23_jev-typesafe-classifier.md`. The
vendor contract came from a fresh fetch of `https://docs.typesafe.ai/introduction/quickstart`
on 2026-09-23. One contract fact differs from the research summary: `questions` is a JSON
object keyed by question name, not an array. The `choice` question shape is
`{ type, instructions, criteria }`, where `criteria` maps each key to a description and the
answer `choice` is one of those keys.

## Out of Scope

- The literal API key value in the goal file — deferred: the key is read at runtime from
  `TYPESAFE_API_KEY`. Acceptance item a3 rejects a key literal anywhere in source or docs.

## Phase 1: Jev (TypeSafe System One) classifier backend

### Overview

This phase adds the TypeSafe transport module, the config field, the `runClassifier` backend
branch, the provider argument, the tests, and the documentation.

### Changes Required:

#### 1. extensions/typesafe.ts
**File**: `extensions/typesafe.ts`
**Changes**: NEW — the TypeSafe (Jev) classifier transport: one typed POST, a pure answer
mapper, and a per-ref loop.

```ts
/**
 * TypeSafe (Jev / System One) classifier backend.
 *
 * The call is not chat-shaped. One POST returns typed answers. The `tier`
 * question asks for one of the three router criteria, so the answer maps to a
 * tier directly and no output parser is needed.
 * Contract: https://docs.typesafe.ai/introduction/quickstart
 */
import type { ClassifierResult, ConfidenceLevel, RouterTier } from './types';
import { isRouterTier, parseCanonicalModelRef } from './config';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY';

const TIER_CRITERIA = {
  high: 'Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.',
  medium: 'Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests and fixes.',
  low: 'Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.',
} as const;

/**
 * Map the Jev confidence (a number in [0,1]) to a router confidence level.
 * An absent or invalid value stays 'medium', as parseClassifierOutput does
 * (routing.ts:678).
 */
export const toConfidenceLevel = (confidence: unknown): ConfidenceLevel => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return 'medium';
  }
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
};

/**
 * Pure: response body -> ClassifierResult. Returns undefined when the body
 * carries no usable tier answer, so the heuristics take over.
 */
export const mapTypesafeResponse = (
  body: unknown,
): ClassifierResult | undefined => {
  const answers = (body as { answers?: Record<string, unknown> } | null)
    ?.answers;
  const tierAnswer = answers?.tier as
    | { type?: string; choice?: unknown; confidence?: unknown }
    | undefined;
  const choice = tierAnswer?.choice;
  if (typeof choice !== 'string') return undefined;
  const tierRaw = choice.trim().toLowerCase();
  if (!isRouterTier(tierRaw)) return undefined;

  const tier: RouterTier = tierRaw;
  const confidence = toConfidenceLevel(tierAnswer?.confidence);
  return {
    tier,
    confidence,
    reasoning: `Jev classified the turn as ${tier} (confidence ${confidence}).`,
    rawText: JSON.stringify(answers),
    failureReason: 'success',
  };
};

export interface TypesafeClassifierOptions {
  state: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onStall?: (ref: string, ms: number) => void;
}

/**
 * Try each ref in order. The first usable answer wins. Every failure —
 * missing key, bad ref, HTTP error, stall, abort — returns undefined, so the
 * caller's heuristics run and no error reaches the turn.
 */
export const runTypesafeClassifier = async (
  refs: string[],
  options: TypesafeClassifierOptions,
): Promise<ClassifierResult | undefined> => {
  const apiKey = process.env[TYPESAFE_API_KEY_ENV];
  if (!apiKey) return undefined;

  for (const ref of refs) {
    if (options.signal?.aborted) return undefined;

    let modelId: string;
    try {
      modelId = parseCanonicalModelRef(ref).modelId;
    } catch {
      continue; // a bare "jev-latest" has no provider slash — config.ts:152
    }

    // Manual abort composition, the same pattern as the chat ref loop
    // (routing.ts:826). A stall aborts the fetch and reports through onStall.
    const controller = new AbortController();
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, options.timeoutMs);
    const propagateAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', propagateAbort, { once: true });
    }

    try {
      const response = await fetch(TYPESAFE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: options.state,
          model: modelId || TYPESAFE_DEFAULT_MODEL,
          questions: {
            tier: {
              type: 'choice',
              instructions: 'Which router tier fits the latest request',
              criteria: TIER_CRITERIA,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) continue; // 401 / 429 / 5xx -> next ref, then heuristics
      const responseBody: unknown = await response.json();
      const result = mapTypesafeResponse(responseBody);
      if (result) return result;
    } catch (error) {
      if (stalled) options.onStall?.(ref, options.timeoutMs);
      void error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', propagateAbort);
    }
  }
  return undefined;
};
```

Note: `fetch` and `Response` come from the default DOM lib of `tsconfig.json` (`target:
"ESNext"`, no explicit `lib`). Node 24 provides the runtime. `process.env` is already used
in the extension (`extensions/provider.ts`), so node types are present.

#### 2. extensions/types.ts
**File**: `extensions/types.ts`
**Changes**: MODIFY — add the backend discriminator to the classifier config (line 24).

```ts
export type ClassifierBackend = 'chat' | 'typesafe';

export interface ClassifierConfig {
  model: string;
  /** Transport for the classifier call. The default is 'chat' (chat stream). */
  backend?: ClassifierBackend;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
}
```

#### 3. extensions/config.ts
**File**: `extensions/config.ts`
**Changes**: MODIFY — read and validate `backend` in the classifier object branch (around
line 512, after the fallbacks block). An unknown value warns and falls back to the chat
transport, the same rule the `thinking` level uses (config.ts:485).

```ts
          }
          if (classifierFallbacks.length === 0) classifierFallbacks = undefined;
        }
        // Backend selector. An unknown value warns and falls back to the chat
        // transport, the same rule the thinking level uses above.
        const backend =
          rawClassifier.backend === 'typesafe' ? 'typesafe' : undefined;
        if (
          rawClassifier.backend !== undefined &&
          rawClassifier.backend !== 'chat' &&
          rawClassifier.backend !== 'typesafe'
        ) {
          warnings.push(
            `classifierModel has invalid backend "${String(rawClassifier.backend)}". Ignored.`,
          );
        }
        classifierModel = {
          model: resolved.canonicalRef,
          backend,
          thinking,
          fallbacks: classifierFallbacks,
        };
```

`mergeClassifier` (config.ts:107) spreads `{ ...base, ...next }`, so the new field merges with
no further change. The string-form branch (config.ts:468) stays as it is.

#### 4. extensions/routing.ts
**File**: `extensions/routing.ts`
**Changes**: MODIFY — extract the prompt-context assembly, add the backend branch, and add
the optional `backend` parameter.

Import the new module and the type (after the `DEFAULT_STALL_TIMEOUT_MS` import, routing.ts:18,
and inside the existing type-import block):

```ts
import { runTypesafeClassifier } from './typesafe';
```
```ts
import type {
  ClassifierBackend,
  RouterTier,
  /* ...the remaining existing members... */
} from './types';
```

Add the shared context builder directly after `buildClassifierPrompt` (routing.ts:192-260,
before `export const matchHighestTierRule`):

```ts
/**
 * Assemble the classifier prompt context from a conversation. Pure — no I/O.
 * Shared by the chat backend and the TypeSafe backend.
 */
export const buildClassifierPromptContext = (
  context: Context,
  currentPhase?: RouterPhase,
  hasImage?: boolean,
): ClassifierPromptContext => {
  const promptText = getLastUserText(context);
  return {
    promptText,
    historyText: getRecentConversationText(context, 6),
    toolResultCount: countToolResults(context),
    wordCount: countWords(promptText),
    multiLinePrompt: promptText.split('\n').length >= 4,
    currentPhase,
    hasImage,
  };
};
```

Replace the inline assembly inside `runClassifier` (routing.ts:847-862) with a call to the
helper:

```ts
      const classifierCtx = buildClassifierPromptContext(
        context,
        currentPhase,
        hasImage,
      );
      const classifierPrompt = buildClassifierPrompt(classifierCtx);
```

Add the parameter and the branch at the top of `runClassifier` (routing.ts:803-815):

```ts
  onStall?: (ref: string, ms: number) => void,
  backend: ClassifierBackend = 'chat',
): Promise<ClassifierResult | undefined> => {
  const timeoutMs = stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  // TypeSafe (Jev) backend: one structured POST, no chat stream, no registry.
  // The state carries the classifier prompt. The tier question asks for one of
  // the three router criteria, so the answer needs no parser.
  if (backend === 'typesafe') {
    return runTypesafeClassifier(refs, {
      state: buildClassifierPrompt(
        buildClassifierPromptContext(context, currentPhase, hasImage),
      ),
      signal,
      timeoutMs,
      onStall,
    });
  }
```

The branch is inert when `backend` is absent, so the existing chat path and its tests do not
change.

#### 5. extensions/provider.ts
**File**: `extensions/provider.ts`
**Changes**: MODIFY — pass the configured backend to the classifier call (provider.ts:628-647).
Add one argument after the `onStall` callback:

```ts
              (ref, ms) => {
                notifyStall(`classifier ${ref} stalled after ${ms}ms`);
              },
              state.currentConfig.classifierModel.backend,
            );
```

#### 6. extensions/routing.test.ts
**File**: `extensions/routing.test.ts`
**Changes**: MODIFY — add `afterEach` to the vitest import (line 1) and add a nested
`describe` block at the end of `describe('runClassifier')`, which reuses its `mockRegistry`.

```ts
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

      const okBody = (choice: string, confidence: number) => ({
        ok: true,
        json: async () => ({
          answers: { tier: { type: 'choice', choice, confidence } },
        }),
      });

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
        delete process.env.TYPESAFE_API_KEY;
      });

      it('maps a Jev choice answer to a router tier', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
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

      it('maps Jev confidence through the high/medium/low thresholds', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
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

      it('returns undefined on a missing key, an unusable answer, or a failure', async () => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);
        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();

        process.env.TYPESAFE_API_KEY = 'test-key';
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) =>
            okBody('gigantic', 0.9),
          ),
        );
        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();

        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => ({
            ok: false,
            status: 401,
            json: async () => ({}),
          })),
        );
        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();

        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, _init: RequestInit) => {
            throw new Error('network down');
          }),
        );
        expect(await runJev(['typesafe/jev-latest'])).toBeUndefined();
      });

      it('skips a ref without a provider slash and tries the next ref', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
          okBody('high', 0.9),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await runJev(['jev-latest', 'typesafe/jev-latest']);
        expect(result?.tier).toBe('high');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('returns undefined on an aborted signal without calling fetch', async () => {
        process.env.TYPESAFE_API_KEY = 'test-key';
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
    });
```

#### 7. extensions/config.test.ts
**File**: `extensions/config.test.ts`
**Changes**: MODIFY — add two cases to
`describe('normalizeConfig – classifier config variants')` (config.test.ts:585).

```ts
    it('should normalize a typesafe (Jev) classifier backend without warnings', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { backend: 'typesafe', model: 'typesafe/jev-latest' },
      };
      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(config.classifierModel?.backend).toBe('typesafe');
      expect(config.classifierModel?.model).toBe('typesafe/jev-latest');
      expect(warnings).toEqual([]);
    });

    it('should warn and ignore an unknown classifier backend', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { backend: 'watson', model: 'openai/gpt-4o' },
      };
      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(config.classifierModel?.backend).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('invalid backend');
    });
```

#### 8. extensions/provider.test.ts
**File**: `extensions/provider.test.ts`
**Changes**: MODIFY — add `afterEach` to the vitest import (line 1), add a global cleanup
after the existing `beforeEach` block, and add one test next to the other classifier tests.

Cleanup, directly after the `beforeEach(...)` block:

```ts
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });
```

The test (add after `'should degrade to heuristics when the classifier stalls'`):

```ts
    it('should run the classifier through the Jev backend when configured', async () => {
      mockState.currentConfig.classifierModel = {
        backend: 'typesafe',
        model: 'typesafe/jev-latest',
      };
      process.env.TYPESAFE_API_KEY = 'test-key';
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: true,
        json: async () => ({
          answers: { tier: { type: 'choice', choice: 'high', confidence: 0.95 } },
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const delegated: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        delegated.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      // The Jev answer reached decideRouting: the classifier branch won.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockState.lastDecision?.isClassifier).toBe(true);
      expect(mockState.lastDecision?.tier).toBe('high');
      expect(delegated).toEqual(['gpt-4o']); // the mock's high tier model
    });
```

The mock registry holds no `typesafe` provider, so a chat-backend call for this ref would
find no model and leave `isClassifier` false. A true value proves the TypeSafe path ran.

#### 9. model-router.example.json
**File**: `model-router.example.json`
**Changes**: MODIFY — select the Jev backend in the example (line 3).

```json
  "classifierModel": { "backend": "typesafe", "model": "typesafe/jev-latest" },
```

#### 10. README.md
**File**: `README.md`
**Changes**: MODIFY — document the backend field (field table, line 142), the example key
point (line 120), and add a short setup block after the field table.

Field table row (line 142):

```markdown
| `classifierModel`        | (Optional) Model used to categorize intent. Accepts either a model ref / alias string (`"google/gemini-flash-latest"`) or an object `{ "model": "alias-or-ref", "backend"?: "chat"\|"typesafe", "thinking"?: "off\|minimal\|low\|medium\|high\|xhigh" }`. The default backend is `"chat"`. The `"typesafe"` backend calls Jev (typesafe.ai System One) and reads the API key from `TYPESAFE_API_KEY`. If omitted, fast heuristics are used. |
```

Key-points bullet (line 120):

```markdown
- **`classifierModel`**: Can be a plain string (`"flash"`) or an object. The object form sets
  the `thinking` level for the chat backend. The `"typesafe"` backend uses Jev instead, for
  example `{ "backend": "typesafe", "model": "typesafe/jev-latest" }`.
```

Setup block, after the configuration-field table (after the `ThinkingLevel` line):

````markdown
### Jev (TypeSafe) classifier

The `"typesafe"` backend sends one POST to `https://api.typesafe.ai/v1/systemone`. Jev
answers the `tier` question with `high`, `medium`, or `low`, and the router uses that tier
for the turn.

Export the key before you start pi:

```bash
export TYPESAFE_API_KEY=<your-api-key>
```

Select the backend in the configuration:

```json
{
  "classifierModel": { "backend": "typesafe", "model": "typesafe/jev-latest" }
}
```

If the key is absent, or the request fails, or the answer carries no usable tier, the router
falls back to the fast heuristics for that turn. The turn never fails.
````

### Success Criteria:

#### Automated Verification:
- [x] `npx tsc --noEmit` exits 0 (whole tree, read-only).
- [x] `npx vitest run extensions/routing.test.ts extensions/config.test.ts extensions/provider.test.ts` exits 0.
- [x] `grep -rFq "api.typesafe.ai/v1/systemone" extensions/ && grep -rFq "jev-latest" extensions/ && grep -rFq "TYPESAFE_API_KEY" extensions/` exits 0.
- [x] `! grep -rEq "apikey_[0-9a-f]{16,}" extensions/ README.md model-router.example.json docs/` exits 0.
- [x] `grep -rFiq "jev" model-router.example.json && grep -rFiq "jev" README.md` exits 0.

#### Manual Verification:
- [ ] Set `TYPESAFE_API_KEY`, select the Jev backend, and run one turn. The routing notification shows the classifier tier and its confidence.
- [ ] Unset `TYPESAFE_API_KEY` and run one turn. The turn completes on the heuristics with no error notification.
- [ ] Use a wrong key and run one turn. The HTTP 401 falls through to the heuristics, and the turn completes.

### Reconciliation Log (2026-09-23T10:05:22.053Z)
Applied 0 directive(s); 0 finding(s); verdict: pass.
