---
date: 2026-09-05T10:31:18+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Spinner hang + dead ESC: terminal events + signal/timeout plumbing"
tags: [design, provider, routing, abort, timeout]
status: ready
parent: .rpiv/artifacts/solutions/2026-09-05_10-01-30_router-hang-esc-dead.md
last_updated: 2026-09-05T12:54:38+0700
last_updated_by: Yogiswara Utama
---

# Design: Spinner hang + dead ESC — terminal events + signal/timeout plumbing

## Summary

The router extension's custom provider ends streams bare (`stream.end()` with no terminal event) on cancel and kill paths. pi's `EventStream.result()` never resolves without a `done` or `error` event, so the spinner hangs and ESC is dead. The fix pushes a terminal `aborted` event on every silent exit (mirroring the builtin `openai-completions` abort shape), and threads `signal` plus `candidateTimeoutMs` into the classifier and delegated candidate calls so a stalled provider costs at most 120 s instead of the 10-min SDK default.

## Requirements

- ESC must cancel any in-flight router turn — the spinner clears within seconds.
- A stalled candidate model costs at most `candidateTimeoutMs`, then falls back.
- The router must not error with "no model registry" on requests that follow pi's real event order (deferred to Option 3; not in scope).
- Extension-first: no changes to pi core.
- The user runs pi 0.84.3; the repo pins 0.80.1 for type checks only. Behavior must be verified against the running install.

## Current State Analysis

### Key Discoveries

- **Silent exits end the stream bare.** Three guards plus a swallow path call `stream.end()` with no event: post-classifier (`extensions/provider.ts:354-356`), loop-top (`:545-547`), post-auth (`:576-578`), and the benign catch for `AbortError`/stale-ctx (`:772-786`). Added in commit `d793dbde`.
- **pi waits forever on a bare-ended stream.** `EventStream.result()` resolves only on a `done`/`error` event or `end(result)` (`pi-ai/dist/utils/event-stream.js:17-36`, identical in both installs). `agent-loop.js:240` does `await response.result()` → `isStreaming` stays true → spinner permanent, ESC signals an already-aborted controller.
- **`stopReason:'aborted'` vs `'error'` matters.** pi never auto-retries `aborted` (`retry.js:166-173` requires `stopReason === 'error'`) and renders it as benign "Operation aborted" text (`interactive-mode.js:2656-2663`). The builtin `openai-completions` pushes `stopReason:'aborted'` on abort (`0.84.3 openai-completions.js:325-332`).
- **`timeoutMs` maps to the OpenAI SDK `timeout`** option (`openai-completions.js:85`, both installs), which aborts the whole streaming request — not just the connection. A value too low kills legitimate long generations; too high leaves the spinner unbounded.
- **`signal` already flows through `delegationOptions`.** The destructure `const { reasoning: _piReasoning, ...delegationOptions } = options ?? {}` at `provider.ts:629-630` strips only `reasoning`; `signal` passes through to both delegation sites (`:652`, `:658`). `timeoutMs` is carried but never supplied by any caller.
- **`runClassifier` has one production caller** (`provider.ts:341-349`). Tests pass ≤7 positional args and never assert call args — trailing optional params are safe.
- **No prior spinner-hang fix exists** in git history. The `EventStream` terminal-event contract is documented only in pi-ai source.
- **The silent exits were a locked design decision** (`.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md`): "End a replacement-killed turn silently: no `type:'error'` event." The intent was no error toast on session replacement — that intent stays; the silent-event mechanism is reversed because it hangs the spinner.

## Scope

### Building

- Terminal `aborted` event on all four silent-exit sites in `provider.ts` (post-classifier, loop-top, post-auth, catch swallow).
- New `createAbortedMessage` helper in `provider.ts` (mirrors `createErrorMessage` with `stopReason:'aborted'`).
- `signal` + `timeoutMs` threaded into `runClassifier` (positional append) and the classifier `streamSimple` call.
- `candidateTimeoutMs` merged into both delegation sites (`provider.ts:652/:658`).
- New `RouterConfig.candidateTimeoutMs?: number` field with `DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000` constant.
- `MockEventStream.result()` waiter in `provider.test.ts` — flipped tests assert the stream terminates.
- Flipped test assertions: 6 "silent end: no error event" tests now assert a terminal `aborted` event.
- New tests: classifier receives `signal`/`timeoutMs`; delegated call receives `timeoutMs`; `candidateTimeoutMs` normalize/merge.

### Not Building

- Option 3 (capture-contract repair: `turn_start` capture in `index.ts`, 2 s registry poll in the no-registry guard) — deferred. Track as follow-up if the no-registry error recurs after this fix ships.
- pi-core changes (extension-first constraint).
- `ModelRuntime` branch changes — exonerated: signal forwards correctly (`model-runtime.js:429`, `:445-465`) and the branch is unreachable for the live config (all models have compat entries).

## Decisions

### D1: Benign exits push `stopReason:'aborted'`

**Explored:**
- Option A: `{ type:'error', reason:'aborted', error: createAbortedMessage(model) }` — mirrors builtin `openai-completions.js:325-332`. pi never auto-retries `aborted` (`retry.js:166-173`), renders benign "Operation aborted" text (`interactive-mode.js:2656-2663`), skips compaction (`agent-session.js:1565`).
- Option B: Reuse `createErrorMessage` verbatim (`stopReason:'error'`, `reason:'error'`) — the no-registry guard pattern (`provider.ts:296-311`). Simpler, but renders as a raw error banner (the toast `d793dbde` removed) and enters pi's auto-retry gate.

**Decision:** Option A — `stopReason:'aborted'`. Preserves the `d793dbde` intent (no error toast on session replacement) while fixing the hang. Genuine errors keep `stopReason:'error'`.

### D2: `runClassifier` appends `signal?`, `timeoutMs?` positionally

**Explored:**
- Option A: Append positionally — `runClassifier(refs, registry, ctx, phase?, thinking?, hasImage?, signal?, timeoutMs?)`. Matches the existing growth pattern (`hasImage` was appended the same way). No test churn (routing.test.ts calls use ≤7 args, none assert call shape).
- Option B: Refactor to options object — cleaner but rewrites all 7 existing call sites in routing.test.ts and the provider call.

**Decision:** Option A — positional append. One production caller (`provider.ts:341`), tests never assert call args.

### D3: One shared `candidateTimeoutMs` config field

**Explored:**
- Option A: `RouterConfig.candidateTimeoutMs?: number`, default 120_000 ms. Classifier refs and delegated candidates are both "candidates." One normalize/merge line, one knob.
- Option B: `classifierTimeoutMs` + `candidateTimeoutMs` — finer control at the cost of two types/normalize/merge/test footprints.

**Decision:** Option A — one shared field. The classifier call is lightweight (3-line response); 120 s is generous for it and bounds the spinner for delegated candidates.

### D4: Default 120 s when `candidateTimeoutMs` absent

**Explored:**
- 120 s: bounds the spinner to 2 min per candidate (5x better than current 10-min SDK default). Most coding generations complete under 2 min.
- 300 s: more headroom for long generations; still 2x better than current.
- No default (opt-in): the long-spinner complaint stays unbounded unless configured.

**Decision:** 120 s default (`DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000`). Matches the solutions artifact suggestion. Configurable via `model-router.json`.

### D5: `MockEventStream` gets a `result()` waiter

**Explored:**
- Option A: Add `result()` to `MockEventStream` that resolves when a `done`/`error` event is pushed (mirrors `event-stream.js:17-36`). Flipped tests assert the promise resolves — proving the turn terminates.
- Option B: Skip the waiter — flipped tests only assert an error event was pushed. Simpler, but cannot detect the hang (the exact gap that shipped `d793dbde`).

**Decision:** Option A — add the waiter. The precedent lesson from `d793dbde` is that mock tests cannot verify pi's real emission order without it.

### D6: Option 3 deferred

**Decision:** Defer the capture-contract repair (Option 3). The solutions artifact recommends "ship it only if the no-registry error recurs after Option 2." The poll is a workaround for a pi-core edge (`session_start` skipped when no bindings, `agent-session.js:1963`) and would add Medium risk to an otherwise Low-risk fix.

## Architecture

### extensions/types.ts:85-100 — MODIFY

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

### extensions/constants.ts:1-5 — MODIFY

```typescript
export const MAX_DEBUG_HISTORY = 12;
export const MAX_CALIBRATION_ENTRIES = 5;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000;
```

### extensions/config.ts:18, 115-144, 416-428, 525-528 — MODIFY

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

### extensions/config.test.ts — MODIFY
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

### extensions/provider.ts:52-80, 296-311, 354-356, 545-547, 576-578, 629-665, 771-786 — MODIFY

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

// ── REPLACE delegation options (extensions/provider.ts:~629-665, the
//    `const { reasoning: _piReasoning, ...delegationOptions }` destructure
//    through the `delegatedStream` ternary) — Slice 4 ──
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

### extensions/provider.test.ts:1-80, 1002-1300 — MODIFY

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


// ── ADD inside describe('registerRouterProvider'), directly after the
//    `should delegate streams and accumulate cost on success` test, before
//    `it('should try fallbacks if the primary model fails'`) — Slice 4 ──
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

### extensions/routing.ts:698-705, 746-750 — MODIFY

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

### extensions/routing.test.ts:899-1040 — MODIFY

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

## Slices

### Slice 1: Config foundation — candidateTimeoutMs field

**Files**: `extensions/types.ts`, `extensions/constants.ts`, `extensions/config.ts`, `extensions/config.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Tests pass: `npm test`
- [ ] Grep confirms field wiring: `grep -r "candidateTimeoutMs" extensions/ | wc -l` returns >= 6

#### Manual Verification:
- [ ] `candidateTimeoutMs?: number` appears in RouterConfig interface (extensions/types.ts)
- [ ] `DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000` in extensions/constants.ts
- [ ] normalizeConfig returns DEFAULT_CANDIDATE_TIMEOUT_MS when candidateTimeoutMs absent
- [ ] mergeConfig: `override.candidateTimeoutMs ?? base.candidateTimeoutMs`
### Slice 2: Terminal events on silent exits — the ESC-dead fix

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Provider tests pass: `npx vitest run extensions/provider.test.ts`
- [ ] `createAbortedMessage` defined and called: `grep -c "createAbortedMessage" extensions/provider.ts` returns >= 5
- [ ] Each silent-exit `stream.end()` is preceded by an aborted push: `grep -n -B3 "stream.end()" extensions/provider.ts`
- [ ] All 6 flipped tests assert aborted: `grep -c "reason === 'aborted'" extensions/provider.test.ts` returns >= 6
- [ ] MockEventStream exposes result(): `grep -c "result()" extensions/provider.test.ts` returns >= 5

#### Manual Verification:
- [ ] ESC during a router turn clears the spinner within seconds and shows "Operation aborted" (no error toast)
- [ ] A session-replacement kill mid-turn clears the spinner (no permanent hang)
- [ ] `createAbortedMessage` returns `stopReason: 'aborted'` with `errorMessage` undefined
- [ ] The 4 silent-exit sites each push `{ type:'error', reason:'aborted', error: createAbortedMessage(model) }` before `stream.end()`
- [ ] The reload test (line ~1224) and negative control ("API key revoked", line ~1176) stay unchanged
- [ ] `persistState` still called on every flipped test (the `finally` block is intact)
### Slice 3: Classifier signal + timeoutMs plumbing

**Files**: `extensions/routing.ts`, `extensions/provider.ts`, `extensions/routing.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Tests pass: `npm test`
- [ ] runClassifier signature has both new params: `grep -cE "signal\?: AbortSignal|timeoutMs\?: number" extensions/routing.ts` returns >= 2
- [ ] streamSimple options thread both: `grep -cE "signal \? \{ signal \}|timeoutMs \? \{ timeoutMs \}" extensions/routing.ts` returns >= 2
- [ ] Call site passes candidateTimeoutMs: `grep -c "state.currentConfig.candidateTimeoutMs" extensions/provider.ts` returns >= 1
- [ ] Test asserts the plumbing: `grep -c "callOptions.signal" extensions/routing.test.ts` returns >= 1

#### Manual Verification:
- [ ] `runClassifier` signature appends `signal?: AbortSignal,` and `timeoutMs?: number,` before the return type
- [ ] The `streamSimple(model, classifierContext, {...})` call conditionally spreads `signal` and `timeoutMs` alongside the existing `reasoningOption` spread
- [ ] The provider call site passes `options?.signal` and `state.currentConfig.candidateTimeoutMs` as the last two args to `runClassifier`
- [ ] Existing runClassifier tests (≤6 args) pass unchanged — no test asserts call shape
- [ ] New test asserts `callOptions.signal === controller.signal` and `callOptions.timeoutMs === 30_000`
### Slice 4: Delegation timeoutMs plumbing + project checks

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Full test suite passes: `npm test` (terminal slice — whole-repo baseline)
- [ ] Both delegation branches merge the timeout: `grep -c "timeoutMs: candidateTimeoutMs" extensions/provider.ts` returns >= 2
- [ ] Timeout read from config: `grep -c "state.currentConfig.candidateTimeoutMs" extensions/provider.ts` returns >= 2
- [ ] Delegation timeout test asserts the option: `grep -c "callOptions.timeoutMs" extensions/provider.test.ts` returns >= 1

#### Manual Verification:
- [ ] The delegation block defines `const candidateTimeoutMs = state.currentConfig.candidateTimeoutMs;` after the `delegationOptions` destructure
- [ ] Both `delegatedStream` branches (runtime + compat) spread `...(candidateTimeoutMs ? { timeoutMs: candidateTimeoutMs } : {})` after `...delegationOptions` (compat: after `apiKey`/`headers`), before the `reasoning` spread
- [ ] New test `should pass candidateTimeoutMs as timeoutMs to the delegated call` asserts `callOptions.timeoutMs === 45000` with config `candidateTimeoutMs: 45000`
- [ ] Configs without `candidateTimeoutMs` (all pre-existing tests) spread nothing — no delegation test changes
- [ ] Live check (pi 0.84.3, nvm install): set `candidateTimeoutMs` low (e.g. 5000) and use a stalling provider — the turn aborts at ~5 s and the fallback chain proceeds to the next candidate

## Desired End State

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

// From the user's perspective:
// - Press ESC during a router turn → spinner clears within seconds, "Operation aborted" text.
// - A stalled provider → spinner clears at most 120 s per candidate, then falls back.
// - No spurious error toast on session replacement.
```

## File Map

```
extensions/types.ts        # MODIFY — RouterConfig.candidateTimeoutMs?: number
extensions/constants.ts    # MODIFY — DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000
extensions/config.ts       # MODIFY — normalizeConfig validation + mergeConfig line
extensions/config.test.ts  # MODIFY — candidateTimeoutMs normalize + merge tests
extensions/provider.ts     # MODIFY — createAbortedMessage + 4 terminal events + timeoutMs merge
extensions/provider.test.ts # MODIFY — MockEventStream.result() + flip 6 assertions + timeout test
extensions/routing.ts      # MODIFY — runClassifier signature + streamSimple options
extensions/routing.test.ts  # MODIFY — classifier signal/timeoutMs assertion test
```

## Ordering Constraints

- Slice 1 (config foundation) must complete before Slices 3 and 4 (they read `state.currentConfig.candidateTimeoutMs`).
- Slice 2 (terminal events) is self-contained — can run in parallel with Slice 1.
- Slice 3 (classifier plumbing) depends on Slice 1 (config field) and merges into `provider.ts` (already modified by Slice 2).
- Slice 4 (delegation plumbing) depends on Slices 1 and 3, merges into `provider.ts` and `provider.test.ts`.

## Verification Notes

- **Test flips pin the old silent behavior.** Six tests assert "no error event" today (`provider.test.ts:1053, :1096, :1134, :1155, :1271, :1294`). Flip each to assert a terminal `aborted` event. Keep the negative control (`:1176` "API key revoked" — asserts error event exists).
- **The reload test (`:1224`) survives unchanged** — its stream yields a `done` event, so `result()` already resolves.
- **`persistState` assertions are orthogonal** — keep them on every flipped test to preserve the trade-off (state still persists on benign exit).
- **pi 0.84.3 vs repo 0.80.1 drift.** Verify signal/timeout behavior against the nvm install (`C:/Users/utama/AppData/Local/nvm/v24.14.0/`), not repo `node_modules`. Field names/types are identical in both (`signal?: AbortSignal`, `timeoutMs?: number`).
- **MockEventStream cannot see `result()` hangs today.** The new `result()` waiter closes this gap — the exact gap that shipped `d793dbde`.

## Performance Considerations

- `candidateTimeoutMs` default 120 s bounds the worst-case spinner from N×10 min to N×120 s (13 MEDIUM candidates → 26 min max instead of 130 min).
- The classifier call is lightweight (3-line response); 120 s is generous and unlikely to kill a healthy classifier.
- `timeoutMs` aborts the whole streaming request — a legitimate long generation that exceeds 120 s will time out and fall back to the next candidate. This is the accepted trade-off (configurable via `model-router.json`).
- The `result()` waiter adds negligible overhead to tests (one promise per stream).

## Migration Notes

No migration needed. `candidateTimeoutMs` is a new optional config field with a default. Existing `model-router.json` files without the field use the 120 s default. `RouterPersistedState` does not store config fields — config is loaded fresh each session.

## Pattern References

- `extensions/provider.ts:296-311` — no-registry guard: the existing terminal-event pattern (push error, then end).
- `pi-ai/dist/providers/openai-completions.js:325-332` (0.84.3) — builtin abort shape: `stopReason:'aborted'`, `reason:'aborted'`, push error, end.
- `extensions/config.ts:421-424, 141` — `maxSessionBudget` footprint: normalize validation + merge line (model for `candidateTimeoutMs`).
- `extensions/provider.test.ts:804-810` — no-registry test: the assertion shape for a terminal error event.
- `extensions/provider.test.ts:1058-1082` — abort test skeleton: `AbortController` + `signal` passed as third `streamSimple` arg.

## Developer Context

**Directional confirms (batched, Step 4):**
- Q: "runClassifier: append positionally or refactor to options object?" → A: "Append positionally (Recommended)" — matches existing growth pattern, no test churn.
- Q: "One shared candidateTimeoutMs field or two separate?" → A: "One shared field (Recommended)" — classifier and delegation are both "candidates," one knob.
- Q: "Add MockEventStream result() waiter?" → A: "Add result() waiter (Recommended)" — closes the gap that shipped d793dbde.

**Genuine ambiguities (one at a time, Step 4):**
- Q: "Benign-exit event shape: aborted or error?" → A: "aborted shape (Recommended)" — mirrors builtin, no auto-retry, benign UI. Evidence: `openai-completions.js:325-332`, `retry.js:166-173`, `interactive-mode.js:2656-2663`.
- Q: "Default candidateTimeoutMs: 120 s, 300 s, or opt-in?" → A: "120 s (Recommended)" — 5x better than current 10-min default; most generations complete. Evidence: `openai-completions.js:85` (whole-request abort).
- Q: "Option 3 (capture-contract repair) now or deferred?" → A: "Defer Option 3 (Recommended)" — matches solutions artifact; ship only if no-registry error recurs. Evidence: `agent-session.js:1963`.

## Design History

- Slice 1: Config foundation — candidateTimeoutMs field — approved as generated
- Slice 2: Terminal events on silent exits — the ESC-dead fix — approved as generated
- Slice 3: Classifier signal + timeoutMs plumbing — approved as generated
- Slice 4: Delegation timeoutMs plumbing + project checks — approved as generated
- Post-design fix (plan Step 5 triage, 2026-09-05T12:54:38+0700): the routing.test.ts classifier test now reads `vi.mocked(streamSimple).mock.calls.at(-1)![2]` instead of `[0]`. routing.test.ts has no `beforeEach`/`vi.clearAllMocks()` and no vitest `clearMocks` config, so `[0]` reads an earlier test's recorded `streamSimple` call (no signal/timeoutMs) and the assertions fail deterministically. Applied to the routing.test.ts Architecture block for consistency with the plan; provider.test.ts keeps `[0]` because it has a `beforeEach`/`vi.clearAllMocks()` precondition.

## References

- `.rpiv/artifacts/solutions/2026-09-05_10-01-30_router-hang-esc-dead.md` — solutions artifact (parent).
- `pi-ai/dist/utils/event-stream.js:17-36` — `result()` resolution rules.
- `pi-agent-core/dist/agent-loop.js:240` — the unresolvable await on bare end.
- `pi-ai/dist/providers/openai-completions.js:325-332` (0.84.3) — builtin abort event shape.
- `pi-coding-agent/dist/core/retry.js:166-173` — retry requires `stopReason === 'error'`.
- `pi-coding-agent/dist/modes/interactive/interactive-mode.js:2656-2663` — benign "Operation aborted" render.
- `pi-coding-agent/dist/core/agent-session.js:1963` — `session_start` skipped when no bindings (Option 3 edge).
- `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md` — prior design (locked silent-exit decision this fix supersedes).
- `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` — plan that introduced the silent exits.
