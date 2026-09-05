---
date: 2026-09-05T12:33:55+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Spinner hang + dead ESC: terminal events + signal/timeout plumbing"
tags: [plan, provider, routing, abort, timeout]
status: ready
parent: .rpiv/artifacts/designs/2026-09-05_10-31-18_router-hang-terminal-events.md
phase_count: 4
phases:
  - { n: 1, title: "Config foundation — candidateTimeoutMs field", files: ["extensions/types.ts", "extensions/constants.ts", "extensions/config.ts", "extensions/config.test.ts"], depends_on: [] }
  - { n: 2, title: "Terminal events on silent exits — the ESC-dead fix", files: ["extensions/provider.ts", "extensions/provider.test.ts"], depends_on: [] }
  - { n: 3, title: "Classifier signal + timeoutMs plumbing", files: ["extensions/routing.ts", "extensions/provider.ts", "extensions/routing.test.ts"], depends_on: [1] }
  - { n: 4, title: "Delegation timeoutMs plumbing + project checks", files: ["extensions/provider.ts", "extensions/provider.test.ts"], depends_on: [1] }
last_updated: 2026-09-05T12:54:38+0700
last_updated_by: Yogiswara Utama
---

# Spinner hang + dead ESC: terminal events + signal/timeout plumbing — Implementation Plan

## Overview

This plan implements the fix for two symptoms introduced by commit `d793dbde`: the spinner hangs and ESC is dead because the router's custom provider ends streams bare (`stream.end()` with no terminal event) on cancel and kill paths, so pi's `EventStream.result()` never resolves. It also threads `signal` plus `candidateTimeoutMs` into the classifier and delegated candidate calls so a stalled provider costs at most 120 s instead of the 10-min SDK default.

The plan is phased 1:1 from the design's `## Slices` (slice-verifier guaranteed per-slice atomicity and criteria/code alignment). Code comes from the design's `## Architecture`; Success Criteria pass through verbatim from the design's `## Slices`.

Reference design: `.rpiv/artifacts/designs/2026-09-05_10-31-18_router-hang-terminal-events.md`

## Desired End State

From the user's perspective:
- Press ESC during a router turn → spinner clears within seconds, "Operation aborted" text.
- A stalled provider → spinner clears at most 120 s per candidate, then falls back.
- No spurious error toast on session replacement.

```typescript
// model-router.json — optional new field
{
  "candidateTimeoutMs": 60000,  // override the 120 s default
  "profiles": { ... }
}

// provider.ts — silent exits now push a terminal event
// Before (hangs pi):
//   if (state.isExtensionContextDead || options?.signal?.aborted) {
//     stream.end();
//     return;
//   }
// After (pi terminates cleanly):
//   if (state.isExtensionContextDead || options?.signal?.aborted) {
//     stream.push({ type: 'error', reason: 'aborted',
//       error: createAbortedMessage(model) });
//     stream.end();
//     return;
//   }

// routing.ts — runClassifier threads signal + timeoutMs
// const result = await runClassifier(
//   refs, registry, context, phase, thinking, hasImage,
//   options?.signal,                    // new — ESC kills the classifier fetch
//   state.currentConfig.candidateTimeoutMs,  // new — bounds the classifier wait
// );

// provider.ts — delegation sites merge timeoutMs
// streamSimple(targetModel, effectiveContext, {
//   ...delegationOptions,
//   apiKey, headers,
//   ...(candidateTimeoutMs ? { timeoutMs: candidateTimeoutMs } : {}),
//   ...(reasoning ? { reasoning } : {}),
// });
```

## What We're NOT Doing

- Option 3 (capture-contract repair: `turn_start` capture in `index.ts`, 2 s registry poll in the no-registry guard) — deferred. Track as follow-up if the no-registry error recurs after this fix ships.
- pi-core changes (extension-first constraint).
- `ModelRuntime` branch changes — exonerated: signal forwards correctly and the branch is unreachable for the live config (all models have compat entries).

## Phase 1: Config foundation — candidateTimeoutMs field

### Overview

Add the `candidateTimeoutMs` config field, its default constant, the normalize/merge wiring, and the config tests. This is the foundation Phases 3 and 4 read (`state.currentConfig.candidateTimeoutMs`). Phase 2 is self-contained and can run in parallel with this phase.

### Changes Required:

#### 1. RouterConfig type — add the optional field
**File**: `extensions/types.ts`
**Changes**: Add `candidateTimeoutMs?: number` to `RouterConfig` (after `maxSessionBudget`).

```typescript
export interface RouterConfig {
  debug?: boolean;
  classifierModel?: ClassifierConfig;
  phaseBias?: number;
  maxSessionBudget?: number;
  candidateTimeoutMs?: number;
  rules?: RoutingRule[];
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition>;
}
```

#### 2. Default timeout constant
**File**: `extensions/constants.ts`
**Changes**: Add `DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000`.

```typescript
export const MAX_DEBUG_HISTORY = 12;
export const MAX_CALIBRATION_ENTRIES = 5;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000;
```

#### 3. Config normalize + merge wiring
**File**: `extensions/config.ts`
**Changes**: Import the constant; add the merge line (`override ?? base`); add normalize validation (positive number, else default); add `candidateTimeoutMs` to the normalize return.

```typescript
// Section 1 — import (line 18, add DEFAULT_CANDIDATE_TIMEOUT_MS):
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
} from './constants';

// Section 2 — mergeConfig return (line ~141, add after maxSessionBudget):
  return {
    debug: override.debug ?? base.debug,
    classifierModel: mergeClassifier(
      base.classifierModel,
      override.classifierModel,
    ),
    phaseBias: override.phaseBias ?? base.phaseBias,
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    candidateTimeoutMs: override.candidateTimeoutMs ?? base.candidateTimeoutMs,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
    models: Object.keys(mergedModels).length > 0 ? mergedModels : undefined,
  };

// Section 3 — normalizeConfig validation (line ~424, add after maxSessionBudget block):
  const candidateTimeoutMs =
    typeof raw.candidateTimeoutMs === 'number' && raw.candidateTimeoutMs > 0
      ? raw.candidateTimeoutMs
      : DEFAULT_CANDIDATE_TIMEOUT_MS;

// Section 4 — normalizeConfig return (line ~528, add candidateTimeoutMs after maxSessionBudget):
    maxSessionBudget,
    candidateTimeoutMs,
    rules: rules.length > 0 ? rules : undefined,
```

#### 4. Config tests — normalize + merge + defaults
**File**: `extensions/config.test.ts`
**Changes**: Import the constant; add `candidateTimeoutMs` to the existing normalize test raw + assertion; add it to the existing merge test base + override + assertion; add two new tests for the default-when-absent and default-when-invalid paths.

```typescript
// Add import after types import (line ~27):
import { DEFAULT_CANDIDATE_TIMEOUT_MS } from './constants';

// Modify existing normalize test (line ~272): add candidateTimeoutMs to raw + assertion
    it('should normalize rules, profiles, phaseBias, budget, classifierModel', () => {
      const raw = {
        debug: true,
        phaseBias: 0.8,
        maxSessionBudget: 5.5,
        candidateTimeoutMs: 60000,
        classifierModel: 'gpt4',
        rules: [
          { matches: 'test', tier: 'high', reason: 'Rule reason' },
          { matches: ['foo', 'bar'], tier: 'low' },
        ],
        profiles: {
          balanced: {
            high: { model: 'google/gemini-2.5-pro' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(warnings).toEqual([]);
      expect(config.debug).toBe(true);
      expect(config.phaseBias).toBe(0.8);
      expect(config.maxSessionBudget).toBe(5.5);
      expect(config.candidateTimeoutMs).toBe(60000);
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.rules?.length).toBe(2);
      expect(config.profiles.balanced?.high?.model).toBe(
        'google/gemini-2.5-pro',
      );
    });

// Modify existing merge test (line ~146): add candidateTimeoutMs to base + override + assertion
    it('should merge profiles and models override', () => {
      const base: RouterConfig = {
        debug: false,
        candidateTimeoutMs: 90000,
        profiles: {
          balanced: {
            medium: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const override: Partial<RouterConfig> = {
        debug: true,
        candidateTimeoutMs: 60000,
        profiles: {
          balanced: {
            high: { model: 'openai/gpt-4o' },
          },
          cheap: {
            low: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          claude: { model: 'anthropic/claude-3.5-sonnet' },
        },
      };

      const merged = mergeConfig(base, override);
      expect(merged.debug).toBe(true);
      expect(merged.candidateTimeoutMs).toBe(60000);
      expect(merged.profiles.balanced.medium?.model).toBe('openai/gpt-4o-mini');
      expect(merged.profiles.balanced.high?.model).toBe('openai/gpt-4o');
      expect(merged.profiles.cheap?.low?.model).toBe('openai/gpt-4o-mini');
      expect(merged.models?.gpt4.model).toBe('openai/gpt-4o');
      expect(merged.models?.claude.model).toBe('anthropic/claude-3.5-sonnet');
    });

// Add two new tests in the normalizeConfig describe block:
    it('should default candidateTimeoutMs to DEFAULT_CANDIDATE_TIMEOUT_MS when absent', () => {
      const raw = {
        profiles: { balanced: { high: { model: 'openai/gpt-4o' } } },
      };
      const { config } = normalizeConfig(raw as unknown as RouterConfig);
      expect(config.candidateTimeoutMs).toBe(DEFAULT_CANDIDATE_TIMEOUT_MS);
    });

    it('should default candidateTimeoutMs when invalid (non-positive)', () => {
      const raw = {
        candidateTimeoutMs: -1,
        profiles: { balanced: { high: { model: 'openai/gpt-4o' } } },
      };
      const { config } = normalizeConfig(raw as unknown as RouterConfig);
      expect(config.candidateTimeoutMs).toBe(DEFAULT_CANDIDATE_TIMEOUT_MS);
    });
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] Grep confirms field wiring: `grep -r "candidateTimeoutMs" extensions/ | wc -l` returns >= 6

#### Manual Verification:
- [ ] `candidateTimeoutMs?: number` appears in RouterConfig interface (extensions/types.ts)
- [ ] `DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000` in extensions/constants.ts
- [ ] normalizeConfig returns DEFAULT_CANDIDATE_TIMEOUT_MS when candidateTimeoutMs absent
- [ ] mergeConfig: `override.candidateTimeoutMs ?? base.candidateTimeoutMs`

---

## Phase 2: Terminal events on silent exits — the ESC-dead fix

### Overview

Add `createAbortedMessage` (mirrors `createErrorMessage` with `stopReason:'aborted'`) and push a terminal `aborted` event before `stream.end()` on all four silent-exit sites (post-classifier, loop-top, post-auth, catch swallow). Add the `MockEventStream.result()` waiter so flipped tests detect a hang. Flip the 6 "silent end: no error event" assertions to assert a terminal `aborted` event. This is the core ESC-dead fix; it is self-contained and can run in parallel with Phase 1.

### Changes Required:

#### 1. createAbortedMessage helper + 4 terminal-event sites + catch swallow
**File**: `extensions/provider.ts`
**Changes**: Add `createAbortedMessage` after `createErrorMessage`. Replace the post-classifier gate, loop-top choke, and post-auth gate to push a terminal `aborted` event before `end()`. Replace the catch swallow to push `aborted` for stale-ctx/AbortError and `error` otherwise, before `end()`. The `finally { persistState() }` block is unchanged.

```typescript
// ── ADD after createErrorMessage (extensions/provider.ts, after the `};`
//    closing createErrorMessage, before the estimateTokens comment) ──
export const createAbortedMessage = (
  model: Model<Api>,
): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'aborted',
    timestamp: Date.now(),
  };
};

// ── REPLACE post-classifier gate (extensions/provider.ts:~350-356) ──
          // The classifier await can span a session replacement. Re-verify
          // liveness before any ctx-derived read below. Push a terminal
          // `aborted` event so pi's result() resolves (a bare end() hangs the
          // spinner); the finally still runs persistState.
          if (state.isExtensionContextDead || options?.signal?.aborted) {
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: createAbortedMessage(model),
            });
            stream.end();
            return;
          }

// ── REPLACE loop-top choke (extensions/provider.ts:~543-547) ──
              // Choke point: every tier transition and candidate retry
              // re-enters this loop top. After a replacement kill (dead
              // flag) or a user abort, stop the fallback chain with a
              // terminal `aborted` event so pi's result() resolves (a bare
              // end() hangs the spinner).
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                stream.push({
                  type: 'error',
                  reason: 'aborted',
                  error: createAbortedMessage(model),
                });
                stream.end();
                return;
              }

// ── REPLACE post-auth gate (extensions/provider.ts:~574-578) ──
              // The auth fetch awaited — a replacement can land mid-await.
              // Re-verify before opening the delegated stream, then push a
              // terminal `aborted` event so pi's result() resolves.
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                stream.push({
                  type: 'error',
                  reason: 'aborted',
                  error: createAbortedMessage(model),
                });
                stream.end();
                return;
              }

// ── REPLACE catch swallow (extensions/provider.ts:~771-786).
//    The `} finally { actions.persistState(); }` block that follows is
//    UNCHANGED — only the catch body through `stream.end();` is replaced. ──
        } catch (error) {
          // Benign termination: a session replacement killed this turn.
          // Branch 1 — stale ctx throw: pi's exact prefix. Branch 2 —
          // pi's abort: AbortError. Both push a terminal `aborted` event so
          // pi's EventStream.result() resolves — a bare end() hangs the
          // spinner (the d793dbde regression). pi renders "Operation aborted"
          // and never auto-retries (stopReason 'aborted'). Non-matching
          // errors still surface as genuine `error` events.
          const isStaleCtx =
            error instanceof Error &&
            error.message.startsWith(STALE_CTX_MESSAGE_PREFIX);
          const isAborted =
            error instanceof Error && error.name === 'AbortError';
          if (isStaleCtx || isAborted) {
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: createAbortedMessage(model),
            });
          } else {
            stream.push({
              type: 'error',
              reason: 'error',
              error: createErrorMessage(
                model,
                error instanceof Error ? error.message : String(error),
              ),
            });
          }
          stream.end();
```

#### 2. MockEventStream.result() waiter + flipped tests + createAbortedMessage test + terminated helper
**File**: `extensions/provider.test.ts`
**Changes**: Update the import to add `createAbortedMessage`. Replace `MockEventStream` with a version that exposes `result()` (resolves on a terminal `done`/`error` event, mirroring pi-ai `event-stream.js:17-36`). Add a `createAbortedMessage` describe block. Add the `terminated` helper inside the session-replacement-gates describe. Replace each of the 6 "no error event" assertions to assert a terminal `aborted` event plus `terminated(stream)`. The reload test (~line 1224) and the negative control ("API key revoked", ~line 1176) stay unchanged.

```typescript
// ── UPDATE import (extensions/provider.test.ts:2) ──
import { registerRouterProvider, createErrorMessage, createAbortedMessage } from './provider';

// ── REPLACE the MockEventStream class (extensions/provider.test.ts:~5-30) ──
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

// ── ADD a createAbortedMessage describe block after the createErrorMessage
//    describe (extensions/provider.test.ts, after the `should create a valid
//    error AssistantMessage` test) ──
  describe('createAbortedMessage', () => {
    it('should create a valid aborted AssistantMessage', () => {
      const model = { api: 'openai', provider: 'openai', id: 'gpt-4o' } as any;
      const msg = createAbortedMessage(model);
      expect(msg.role).toBe('assistant');
      expect(msg.stopReason).toBe('aborted');
      expect(msg.errorMessage).toBeUndefined();
    });
  });


// ── ADD the `terminated` helper inside describe('session replacement gates
//    (dead flag / abort)', () => {`, immediately after the `sleep` const
//    (extensions/provider.test.ts, ~line 1006) ──
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

// ── REPLACE each of the 6 assertions at lines 1053, 1096, 1134, 1155,
//    1271, 1294. The line to find is:
//      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
//    Replace it with:
      const abortedEvent = stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(stream)).toBe(true);
//    The 7th identical assertion at line 1224 (reload-case test, whose
//    delegated stream yields a `done` event) and the negative-control test
//    (~line 1176, "API key revoked") are NOT flipped — they stay as-is.
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run tsc`
- [x] Provider tests pass: `npx vitest run extensions/provider.test.ts`
- [x] `createAbortedMessage` defined and called: `grep -c "createAbortedMessage" extensions/provider.ts` returns >= 5
- [x] Each silent-exit `stream.end()` is preceded by an aborted push: `grep -n -B3 "stream.end()" extensions/provider.ts`
- [x] All 6 flipped tests assert aborted: `grep -c "reason === 'aborted'" extensions/provider.test.ts` returns >= 6
- [x] MockEventStream exposes result(): `grep -c "result()" extensions/provider.test.ts` returns >= 5

#### Manual Verification:
- [ ] ESC during a router turn clears the spinner within seconds and shows "Operation aborted" (no error toast)
- [ ] A session-replacement kill mid-turn clears the spinner (no permanent hang)
- [ ] `createAbortedMessage` returns `stopReason: 'aborted'` with `errorMessage` undefined
- [ ] The 4 silent-exit sites each push `{ type:'error', reason:'aborted', error: createAbortedMessage(model) }` before `stream.end()`
- [ ] The reload test (line ~1224) and negative control ("API key revoked", line ~1176) stay unchanged
- [ ] `persistState` still called on every flipped test (the `finally` block is intact)

---

## Phase 3: Classifier signal + timeoutMs plumbing

### Overview

Append `signal?: AbortSignal` and `timeoutMs?: number` to `runClassifier` (positional, matching the existing growth pattern). Thread both into the classifier `streamSimple` call. Update the provider call site to pass `options?.signal` and `state.currentConfig.candidateTimeoutMs`. Add a test asserting the plumbing. Depends on Phase 1 (the config field); merges into `provider.ts` (already modified by Phase 2 — shared-file ordering handled by the implement fanout).

### Changes Required:

#### 1. runClassifier signature + streamSimple options
**File**: `extensions/routing.ts`
**Changes**: Append `signal?: AbortSignal,` and `timeoutMs?: number,` to `runClassifier` before the return type. In the classifier `streamSimple` call, conditionally spread `signal` and `timeoutMs` alongside the existing `reasoningOption` spread.

```typescript
// ── REPLACE runClassifier signature (extensions/routing.ts:698-705) ──
export const runClassifier = async (
  refs: string[],
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  hasImage?: boolean,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ClassifierResult | undefined> => {

// ── REPLACE streamSimple call (extensions/routing.ts:746-750) ──
      const stream = streamSimple(model, classifierContext, {
        apiKey,
        headers,
        ...(reasoningOption ? { reasoning: reasoningOption } : {}),
        ...(signal ? { signal } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
```

#### 2. runClassifier call site — pass signal + candidateTimeoutMs
**File**: `extensions/provider.ts`
**Changes**: Replace the `runClassifier(...)` call to append `options?.signal` and `state.currentConfig.candidateTimeoutMs` as the last two args.

```typescript
// ── REPLACE runClassifier call site (extensions/provider.ts:~341-348) ──
            classifierResult = await runClassifier(
              classifierRefs,
              modelRegistry,
              context,
              state.lastDecision?.phase,
              state.currentConfig.classifierModel.thinking,
              hasImageAttachment(context),
              options?.signal,
              state.currentConfig.candidateTimeoutMs,
            );
```

#### 3. runClassifier signal/timeoutMs assertion test
**File**: `extensions/routing.test.ts`
**Changes**: Add a new test inside `describe('runClassifier', () => {...})`, after the "does NOT retry after content received" test, before the closing `});`. It passes an `AbortController` signal and `30_000`, then asserts both reach the `streamSimple` call options.

```typescript
// ── ADD a new test inside describe('runClassifier', () => { ... }),
//    after the "does NOT retry after content received" test, before the
//    closing `});` of that describe block (extensions/routing.test.ts) ──
    it('passes signal and timeoutMs to streamSimple', async () => {
      const mockStream = (async function* () {
        yield {
          type: 'text_delta',
          delta: 'Tier: high\nConfidence: high\nReasoning: Deep.',
        };
      })();
      vi.mocked(streamSimple).mockReturnValue(mockStream as any);

      const controller = new AbortController();
      await runClassifier(
        ['openai/gpt-4o'],
        mockRegistry,
        context,
        'planning',
        'high',
        false,
        controller.signal,
        30_000,
      );

      const callOptions = vi.mocked(streamSimple).mock.calls.at(-1)![2] as any;
      expect(callOptions.signal).toBe(controller.signal);
      expect(callOptions.timeoutMs).toBe(30_000);
    });
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run tsc`
- [x] Tests pass: `npm test`
- [x] runClassifier signature has both new params: `grep -cE "signal\?: AbortSignal|timeoutMs\?: number" extensions/routing.ts` returns >= 2
- [x] streamSimple options thread both: `grep -cE "signal \? \{ signal \}|timeoutMs \? \{ timeoutMs \}" extensions/routing.ts` returns >= 2
- [x] Call site passes candidateTimeoutMs: `grep -c "state.currentConfig.candidateTimeoutMs" extensions/provider.ts` returns >= 1
- [x] Test asserts the plumbing: `grep -c "callOptions.signal" extensions/routing.test.ts` returns >= 1

#### Manual Verification:
- [ ] `runClassifier` signature appends `signal?: AbortSignal,` and `timeoutMs?: number,` before the return type
- [ ] The `streamSimple(model, classifierContext, {...})` call conditionally spreads `signal` and `timeoutMs` alongside the existing `reasoningOption` spread
- [ ] The provider call site passes `options?.signal` and `state.currentConfig.candidateTimeoutMs` as the last two args to `runClassifier`
- [ ] Existing runClassifier tests (≤6 args) pass unchanged — no test asserts call shape
- [ ] New test asserts `callOptions.signal === controller.signal` and `callOptions.timeoutMs === 30_000`

---

## Phase 4: Delegation timeoutMs plumbing + project checks

### Overview

Merge `candidateTimeoutMs` into both `delegatedStream` branches (runtime + compat). Add the delegation timeout test. Run the full suite as the terminal whole-repo baseline. Depends on Phase 1 (config field); merges into `provider.ts` and `provider.test.ts` (shared-file ordering handled by the implement fanout — runs after Phases 2 and 3 on `provider.ts`).

### Changes Required:

#### 1. Delegation timeoutMs merge — both branches
**File**: `extensions/provider.ts`
**Changes**: After the `delegationOptions` destructure, read `const candidateTimeoutMs = state.currentConfig.candidateTimeoutMs;`. In both `delegatedStream` branches (runtime + compat), spread `...(candidateTimeoutMs ? { timeoutMs: candidateTimeoutMs } : {})` after `...delegationOptions` (compat: after `apiKey`/`headers`), before the `reasoning` spread.

```typescript
// ── REPLACE delegation options (extensions/provider.ts:~629-665, the
//    `const { reasoning: _piReasoning, ...delegationOptions }` destructure
//    through the `delegatedStream` ternary) ──
                const { reasoning: _piReasoning, ...delegationOptions } =
                  options ?? {};

                // Slice 1 config field: normalizeConfig guarantees a
                // positive number on the production path; the conditional
                // spread guards raw configs (tests, hand-built state) where
                // the field is absent.
                const candidateTimeoutMs =
                  state.currentConfig.candidateTimeoutMs;

                // Custom (non-builtin) api ids — e.g. cliproxyapi-codex-responses —
                // have no entry in compat's api-registry; compat streamSimple throws
                // "No API provider registered for api: ...". Delegate through pi's
                // ModelRuntime instead: provider-aware and resolves auth itself
                // (same path that makes direct selection work).
                // ponytail: runtime facade shape is untyped; guard + compat fallback
                // keeps behavior at least as good as before if pi changes internals.
                const hasCompatApi = Boolean(getApiProvider(targetModel.api));
                const registryRuntime = (
                  state.currentModelRegistry as unknown as {
                    runtime?: { streamSimple?: typeof streamSimple };
                  }
                )?.runtime;
                // ModelRuntime.streamSimple reads `this.prepareRequest`, so a
                // detached reference throws and silently demotes the model.
                const runtimeStreamSimple =
                  registryRuntime?.streamSimple?.bind(registryRuntime);

                const delegatedStream =
                  !hasCompatApi && runtimeStreamSimple
                    ? runtimeStreamSimple(targetModel, effectiveContext, {
                        ...delegationOptions,
                        ...(candidateTimeoutMs
                          ? { timeoutMs: candidateTimeoutMs }
                          : {}),
                        ...(delegatedReasoning
                          ? { reasoning: delegatedReasoning }
                          : {}),
                      })
                    : streamSimple(targetModel, effectiveContext, {
                        ...delegationOptions,
                        apiKey,
                        headers,
                        ...(candidateTimeoutMs
                          ? { timeoutMs: candidateTimeoutMs }
                          : {}),
                        ...(delegatedReasoning
                          ? { reasoning: delegatedReasoning }
                          : {}),
                      });
```

#### 2. Delegation timeout test
**File**: `extensions/provider.test.ts`
**Changes**: Add a test inside `describe('registerRouterProvider')`, directly after the `should delegate streams and accumulate cost on success` test, before `it('should try fallbacks if the primary model fails')`. Set `candidateTimeoutMs: 45000`, invoke the provider, and assert `callOptions.timeoutMs === 45000` on the compat `streamSimple` call.

```typescript
// ── ADD inside describe('registerRouterProvider'), directly after the
//    `should delegate streams and accumulate cost on success` test, before
//    `it('should try fallbacks if the primary model fails'`) ──
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
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run tsc`
- [x] Full test suite passes: `npm test` (terminal slice — whole-repo baseline)
- [x] Both delegation branches merge the timeout: `grep -c "timeoutMs: candidateTimeoutMs" extensions/provider.ts` returns >= 2
- [x] Timeout read from config: `grep -c "state.currentConfig.candidateTimeoutMs" extensions/provider.ts` returns >= 2
- [x] Delegation timeout test asserts the option: `grep -c "callOptions.timeoutMs" extensions/provider.test.ts` returns >= 1

#### Manual Verification:
- [ ] The delegation block defines `const candidateTimeoutMs = state.currentConfig.candidateTimeoutMs;` after the `delegationOptions` destructure
- [ ] Both `delegatedStream` branches (runtime + compat) spread `...(candidateTimeoutMs ? { timeoutMs: candidateTimeoutMs } : {})` after `...delegationOptions` (compat: after `apiKey`/`headers`), before the `reasoning` spread
- [ ] New test `should pass candidateTimeoutMs as timeoutMs to the delegated call` asserts `callOptions.timeoutMs === 45000` with config `candidateTimeoutMs: 45000`
- [ ] Configs without `candidateTimeoutMs` (all pre-existing tests) spread nothing — no delegation test changes
- [ ] Live check (pi 0.84.3, nvm install): set `candidateTimeoutMs` low (e.g. 5000) and use a stalling provider — the turn aborts at ~5 s and the fallback chain proceeds to the next candidate

---

## Testing Strategy

### Automated:
- `npm run tsc` — type checking (read-only, repo-wide; run by each phase).
- `npx vitest run extensions/provider.test.ts` — provider tests (Phase 2's scoped selection; read-only).
- `npm test` — full vitest suite (Phase 4 is the terminal slice that establishes the whole-repo baseline).
- Grep checks per phase (see each phase's Automated Verification) confirm structural wiring: field count, terminal-event sites, signature params, delegation branches.

### Manual Testing Steps:
1. Point the classifier at a slow model, press ESC during the wait, confirm the spinner clears and shows "Operation aborted".
2. `/router debug show` after a cancelled turn shows no stuck state.
3. Reload extensions mid-session, send a prompt, confirm no no-registry error (or only the deferred known one from Option 3).
4. Set `candidateTimeoutMs` low (e.g. 5000) in `model-router.json` against a stalling provider — the turn aborts at ~5 s and the fallback chain proceeds to the next candidate.
5. Verify signal/timeout behavior against the nvm install (`C:/Users/utama/AppData/Local/nvm/v24.14.0/`), not repo `node_modules` (pi 0.84.3 vs repo 0.80.1 drift; field names/types are identical in both).

## Performance Considerations

- `candidateTimeoutMs` default 120 s bounds the worst-case spinner from N×10 min to N×120 s (13 MEDIUM candidates → 26 min max instead of 130 min).
- The classifier call is lightweight (3-line response); 120 s is generous and unlikely to kill a healthy classifier.
- `timeoutMs` aborts the whole streaming request — a legitimate long generation that exceeds 120 s will time out and fall back to the next candidate. This is the accepted trade-off (configurable via `model-router.json`).
- The `result()` waiter adds negligible overhead to tests (one promise per stream).

## Migration Notes

No migration needed. `candidateTimeoutMs` is a new optional config field with a default. Existing `model-router.json` files without the field use the 120 s default. `RouterPersistedState` does not store config fields — config is loaded fresh each session.

## Developer Context

_Phase boundaries inherited 1:1 from the design's `## Slices`. provider.ts is modified by Phases 2, 3, and 4 (different regions); provider.test.ts by Phases 2 and 4. The implement fanout serializes shared-file phases in array order (2 → 3 → 4 on provider.ts). Step 4 review notes and post-write developer interactions land here._

_Step 5 triage (2026-09-05T12:54:38+0700): 1 blocker from artifact-code-reviewer applied; artifact-coverage-reviewer found zero findings. Phase 3's routing.test.ts test read `mock.calls[0][2]` — the first `streamSimple` call recorded in the file (routing.test.ts has no `beforeEach`/`vi.clearAllMocks()` and no vitest `clearMocks` config), not this test's call, so the signal/timeoutMs assertions failed deterministically. Fixed to `mock.calls.at(-1)![2]` in both the plan's Phase 3 code fence and the design's Architecture (root cause). provider.test.ts (Phase 4) keeps `[0]` because it clears mocks in `beforeEach`. No phase boundaries changed; `phases:` array unchanged. Status flipped to ready._

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 3 §3 (routing.test.ts) | extensions/routing.test.ts:15 | blocker | codebase-fit | `vi.mocked(streamSimple).mock.calls[0][2]` reads the first `streamSimple` call recorded in the file, not this test's call — routing.test.ts has no `beforeEach`/`vi.clearAllMocks()` and no vitest config sets `clearMocks`, so the calls from earlier `runClassifier` tests sit at lower indices; `callOptions.signal` resolves to `undefined`, so `expect(callOptions.signal).toBe(controller.signal)` and `expect(callOptions.timeoutMs).toBe(30_000)` fail deterministically. | Index the newest call — `const callOptions = vi.mocked(streamSimple).mock.calls.at(-1)![2] as any;` — or capture `mock.calls.length` before the await and index from that snapshot. | applied — plan Phase 3 code fence + design Architecture both patched to `mock.calls.at(-1)![2]` (indexes this test's call; provider.test.ts keeps `[0]` under its `beforeEach`/`vi.clearAllMocks()` precondition) |

_Coverage reviewer found zero findings — every enumerated verification intent (Verification Notes §1-§5, Pattern References, Developer Context confirms/ambiguities) landed on either a Success Criteria bullet or a visible code mirror._

## References

- Design: `.rpiv/artifacts/designs/2026-09-05_10-31-18_router-hang-terminal-events.md`
- Solutions (parent): `.rpiv/artifacts/solutions/2026-09-05_10-01-30_router-hang-esc-dead.md`
- `pi-ai/dist/utils/event-stream.js:17-36` — `result()` resolution rules.
- `pi-agent-core/dist/agent-loop.js:240` — the unresolvable await on bare end.
- `pi-ai/dist/providers/openai-completions.js:325-332` (0.84.3) — builtin abort event shape.
- `pi-coding-agent/dist/core/retry.js:166-173` — retry requires `stopReason === 'error'`.
- `pi-coding-agent/dist/modes/interactive/interactive-mode.js:2656-2663` — benign "Operation aborted" render.
- `pi-coding-agent/dist/core/agent-session.js:1963` — `session_start` skipped when no bindings (Option 3 edge).
- `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md` — prior design (locked silent-exit decision this fix supersedes).
- `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` — plan that introduced the silent exits.
