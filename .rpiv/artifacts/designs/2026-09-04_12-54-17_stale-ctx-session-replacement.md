---
date: 2026-09-04T12:54:17+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Dead-flag gate for stale extension ctx after session replacement"
tags: [design, provider, stale-ctx, session-lifecycle, dead-flag]
status: ready
parent: .rpiv/artifacts/solutions/2026-09-04_12-25-31_stale-ctx-session-replacement.md
last_updated: 2026-09-04T12:54:17+0700
last_updated_by: Yogiswara Utama
---

# Design: Dead-flag gate for stale extension ctx after session replacement

## Summary

Pi invalidates the extension ctx on every session replacement (newSession, fork, switchSession, import, quit, reload). The router extension holds one captured ctx (`lastExtensionContext`) across a long-lived provider stream; stale reads throw and surface as user-visible errors. The fix: one runtime boolean `isExtensionContextDead` in the orchestrator closure, set by a new `session_shutdown` handler and by the `captureCtx` stale catch, cleared on the next live capture. The provider reads it through the existing getter bridge, gates every ctx-derived read, re-verifies liveness after each await boundary, stops post-abort tier retries, and classifies stale/AbortError throws in the stream catch as benign silent termination.

## Requirements

- Remove the user-visible stale error on every replacement path: new, fork, switch, import, quit, reload (locked: full-seam scope).
- End a replacement-killed turn silently: no `type:'error'` event, `stream.end()` still called, `persistState` still runs (locked).
- Stop post-abort tier retries with early `options.signal?.aborted` checks (locked).
- Gate the handler tails that touch ctx after an internal await (locked): `switchToRouterProfile` (:275-281), `session_start` (:536-540), `model_select` (:569-572), `turn_end` (:584).
- Mid-turn replacement regression test is the acceptance bar.
- The flag must never enter `RouterPersistedState` (hard constraint).

## Current State Analysis

Five `pi.on` handlers live in `extensions/index.ts:527-614`; each starts with `captureCtx(ctx)` (:70-79), which swallows stale throws and keeps the last captured values. The provider stream IIFE (`extensions/provider.ts:303-742`) reads `state.lastExtensionContext` at :465, :587-594, :703-704 and calls `pi`-backed actions (:463 `syncPiThinkingLevel`, :727 `recordDebugDecision`); a stale throw at any of these either kills the turn through the IIFE catch (:730-739, pushes `type:'error'`) or burns the fallback chain (per-candidate catch :707 swallows and retries).

### Key Discoveries

- Stale mechanics (verified in pi 0.80.1 runtime): the stale check lives on **ctx getters** (`runner.js:425-461`) and on **`pi.*` actions** (`loader.js:174-287`, `assertActive`); the raw `ModelRegistry` has NO stale check (`model-registry.js:497-536`) — registry snapshot reads never throw stale.
- `session_shutdown` is emitted and every handler is AWAITED before ctx invalidation (`agent-session-runtime.js:100-106`; `runner.js:50-57`) — flag-before-death ordering is safe by construction. Pi skips the emit when no handler is registered; registration activates the path.
- `session_shutdown` is registered nowhere in the repo today (verified by grep).
- `options.signal` is never read today (`SimpleStreamOptions.signal?: AbortSignal` exists in pi-ai types, `types.d.ts:47`); `options` is destructured once at `provider.ts:597-598`.
- `recordDebugDecision`'s history push (`index.ts:118`) must stay ungated — restore reads it at `index.ts:393-394` (solutions: locked).
- Complete `lastExtensionContext` reader inventory: `index.ts:119, :138, :300-301` (getter); `provider.ts:465-466, :587, :589, :593, :703-704`. Nothing outside these two files reads it (commands.ts confirmed clean — command ctx is fresh per invocation).
- Precedent lessons: `f67a7850` (blind swallow at write site — class recurred), `4ae87431` (captureCtx + hoisted guard), `cdcfe2eb` (silencing live-candidate errors is wrong — benign branch must classify only provably-dead conditions), `2b8e6862` (upstream removed 2 of 5 event names in one bump — keep both flag-set points, clear via live capture).
- Test constructs: no deferred/manual promise gate exists in the suite (17 fixed 100ms settles); stale ctx is simulated with throwing getters (`index.test.ts:126-133`); the mid-turn test must introduce the deferred gate as its one new construct.

## Scope

### Building

- `isExtensionContextDead` closure boolean: set in `captureCtx` catch + `session_shutdown` handler, cleared at the top of a live capture.
- `readonly isExtensionContextDead` on the provider state type + getter bridge entry.
- Provider gates: post-classifier-await re-verification (:334), post-auth-await re-verification (:548), inner-loop-top choke (:526), extended ctx gates (:465, :587, :703), benign 2-branch classification in the IIFE catch (:730).
- Orchestrator gates: `recordDebugDecision` condition extension (:119), four handler-tail gates.
- Regression tests: session_shutdown registration, flag lifecycle smoke, mid-turn deferred-gate suite, benign classification, abort-stops-retries, auth-await death, non-matching error still surfaces, tail gating.

### Not Building

- No `withSession` restructure — the router never initiates a replacement (hard).
- No persistence flush in `session_shutdown` — the killed stream is still mid-flight; fork/new never read the old file (hard, locked).
- No wrapper/proxy layer around ctx (rejected Option 2).
- No structural registry fix — `modelRegistryFallback`/`turn_start` capture from the 2026-08-30 design stay unbuilt.
- No changes to `extensions/ui.ts`, `extensions/state.ts`, `extensions/types.ts` — the flag is runtime-only.
- No changes to `extensions/commands.ts` — command ctx is fresh per invocation; the stale mechanism is unreachable there.
- No gating of the sync `thinking_level_select` body — no internal await means no widened race window (delivered-dead sync window pre-exists and self-heals on the next live capture).

## Decisions

### Exit shape at new early-exit sites — Direct return (developer, Step 4)

Each early-exit site (post-classifier :334, post-auth :548, loop-top choke :526) does `stream.end(); return;`. The IIFE `finally` (:740) still runs `persistState`. No sentinel vocabulary, no fabricated error objects. Model: early-return guard shape at `provider.ts:284-302`. The IIFE catch (:730) keeps exactly two benign branches: stale-message prefix + `AbortError` name.

### Flag name and placement — `isExtensionContextDead` (simple)

Declared beside the sibling latches (`index.ts:57-59`). Name matches the pi error-message vocabulary ("This extension ctx is stale..."). Level-triggered like `isInitialized` — no try/finally scoping. Exposed through the existing getter bridge (`index.ts:300-302` slot-in) and typed `readonly` on the provider state (`provider.ts:172` area).

### Benign classification — 2 branches, prefix + name (locked from research)

`staleMessage` prefix `'This extension ctx is stale after session replacement'` (exact, proven by `index.test.ts:126-133` fixture) plus `error.name === 'AbortError'`. Non-matching errors still push `type:'error'` — the classification must never mask a live candidate failure (`cdcfe2eb` lesson). Prefix drift in pi degrades to the visible error path (fails loud).

### Post-abort retry stop — inner-loop-top choke point (locked direction, placement chosen)

One check at the top of the inner model loop (`provider.ts:526`), before the parse at :528: `if (state.isExtensionContextDead || options?.signal?.aborted) { stream.end(); return; }`. Every tier transition and candidate retry passes through the inner-loop top, so one check covers both loops. Synchronous code between the check and the auth await (:548) cannot yield, so no abort can land in that gap; the post-auth re-verification covers the await window itself.

### Registry snapshot reads stay ungated (simple)

`modelRegistry.find` / `getApiKeyAndHeaders` on the captured raw registry never throw stale (verified: no `assertActive` in `ModelRegistry`). Gates re-anchor to ctx-derived reads and `pi.*` actions only.

## Architecture

### extensions/index.ts — MODIFY

Flag declaration + captureCtx set/clear + session_shutdown handler + getter bridge + recordDebugDecision gate + four tail gates.

```ts
// HUNK 1 — flag declaration: after `let isInternalThinkingChange = false;` (index.ts:59)
  // Dead-flag gate: true while the captured ExtensionContext is known dead
  // (session_shutdown fired or a capture went stale). Cleared on the next
  // live capture. Runtime-only — never part of RouterPersistedState.
  let isExtensionContextDead = false;

// HUNK 2 — captureCtx: replaces index.ts:70-79 (set/clear points; existing
// contract comment preserved verbatim)
  const captureCtx = (ctx: ExtensionContext) => {
    try {
      // A successful read below proves the ctx is alive — clear the flag.
      isExtensionContextDead = false;
      lastExtensionContext = ctx;
      currentModelRegistry = ctx.modelRegistry;
      currentCwd = ctx.cwd;
    } catch {
      isExtensionContextDead = true;
      // Stale ctx after session replacement — ctx getters throw. Keep the
      // last captured values; the next event delivers a fresh ctx.
    }
  };

// HUNK 3 — sixth handler: after the before_provider_request block (index.ts:527-529)
  // Death anchor: pi emits `session_shutdown` and awaits every handler
  // BEFORE it invalidates the ctx (pi core/agent-session-runtime.js
  // teardownCurrent). Flip the flag here so in-flight turns gate ctx reads
  // before the ctx dies. Pi skips the emit when no handler is registered —
  // registering here activates the path.
  pi.on('session_shutdown', () => {
    isExtensionContextDead = true;
  });

// HUNK 4 — getter bridge: inside the registerRouterProvider state object,
// after `get lastExtensionContext()` (index.ts:300-302)
          get isExtensionContextDead() {
            return isExtensionContextDead;
          },

// HUNK 5 — recordDebugDecision notify gate: extends the condition at
// index.ts:119. The history push at :118 stays ungated — restore reads
// debugHistory at index.ts:393-394. Only the ctx-derived ui.notify reads
// the possibly-dead ctx.
    if (debugEnabled && lastExtensionContext && !isExtensionContextDead) {

// HUNK 6 — switchToRouterProfile tail gates (:275, :281): death can land
// during `await setModelInternally` (:273). State sets (:278-279) and
// persistState (:280, swallows stale internally at :185-191) stay ungated;
// gate only the two ctx-derived reads.
      const success = await setModelInternally(routerModel);
      if (!success) {
        if (!isExtensionContextDead) {
          ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        }
        return false;
      }
      selectedProfile = profileName;
      routerEnabled = true;
      persistState();
      if (!isExtensionContextDead) {
        actions.updateStatus(ctx);
      }
      return true;

// HUNK 7 — session_start tail gate (:535-540): restoreStateFromSession
// already self-catches (:447-459); the debug notify is the only unguarded
// ctx read after the restore await (:534).
    await restoreStateFromSession(ctx);
    if (debugEnabled && !isExtensionContextDead) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`,
        'info',
      );
    }
  });

// HUNK 8 — model_select tail gates (:569, :572): the flag can be set by a
// stale delivered ctx (captureCtx catch) or by death during the
// capacity-refresh await (:561). persistState (:571) stays ungated.
    } else {
      routerEnabled = false;
      lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      if (!isExtensionContextDead) {
        ctx.ui.setHiddenThinkingLabel?.();
      }
    }
    persistState();
    if (!isExtensionContextDead) {
      actions.updateStatus(ctx);
    }
  });

// HUNK 9 — turn_end tail gate (:584): death can land during the
// `await setModelInternally` restore (:580). persistState (:583) stays
// ungated — it swallows stale internally (:185-191).
    persistState();
    if (!isExtensionContextDead) {
      actions.updateStatus(ctx);
    }
  });
```

### extensions/provider.ts — MODIFY

State-type field + post-await re-verifications + loop choke + ctx gates + benign catch classification.

```ts
// HUNK 1 — state param type (Slice 1): insert after
// `readonly lastExtensionContext: ExtensionContext | undefined;` (provider.ts:172)
    readonly isExtensionContextDead: boolean;

// HUNK 2 — module constant: insert immediately before
// `export const createErrorMessage` (provider.ts:46)
// Exact pi stale-ctx message prefix (ctx getters throw with this prefix in
// pi core). Benign classification matches it exactly; pi drift degrades to
// the visible error path (fails loud).
const STALE_CTX_MESSAGE_PREFIX =
  'This extension ctx is stale after session replacement';

// HUNK 3 — post-classifier re-verification: insert after the classifier
// block closes (~:343, after the `classifierResult = await runClassifier(...)`
// if-block), before `let decision: RoutingDecision = decideRouting(`
          // The classifier await can span a session replacement. Re-verify
          // liveness before any ctx-derived read below: direct return keeps
          // the finally-running persistState and surfaces no error event.
          if (state.isExtensionContextDead || options?.signal?.aborted) {
            stream.end();
            return;
          }

// HUNK 4 — ctx gate at :465-466 (replaces the condition line)
          if (state.lastExtensionContext && !state.isExtensionContextDead) {
            actions.updateStatus(state.lastExtensionContext);
          }

// HUNK 5 — inner-loop-top choke at :526 (insert as the FIRST statement of
// the inner `for (let i = 0; i < modelsToTry.length; i++)` body, before
// `const modelRef = modelsToTry[i];`)
            for (let i = 0; i < modelsToTry.length; i++) {
              // Choke point: every tier transition and candidate retry
              // re-enters this loop top. After a replacement kill (dead
              // flag) or a user abort, stop the fallback chain silently.
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                stream.end();
                return;
              }
              const modelRef = modelsToTry[i];

// HUNK 6 — post-auth re-verification: insert immediately after
// `const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);` (:548)
              // The auth fetch awaited — a replacement can land mid-await.
              // Re-verify before opening the delegated stream.
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                stream.end();
                return;
              }

// HUNK 7 — ctx gate at :587 (replaces the condition line)
                if (
                  state.lastExtensionContext &&
                  !state.isExtensionContextDead
                ) {

// HUNK 8 — ctx gate at :703 (replaces the condition line)
                if (
                  state.lastExtensionContext &&
                  !state.isExtensionContextDead &&
                  decision.isFallback
                ) {

// HUNK 9 — benign classification: rewrites the IIFE catch (:730-739)
        } catch (error) {
          // Benign termination: a session replacement killed this turn.
          // Branch 1 — stale ctx throw: pi's exact prefix. Branch 2 —
          // pi's abort: AbortError. Neither is a router failure, so no
          // error event is pushed. Non-matching errors still surface.
          const isStaleCtx =
            error instanceof Error &&
            error.message.startsWith(STALE_CTX_MESSAGE_PREFIX);
          const isAborted =
            error instanceof Error && error.name === 'AbortError';
          if (!isStaleCtx && !isAborted) {
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
        } finally {
```

### extensions/index.test.ts — MODIFY

Registration + lifecycle smoke tests (Slice 1), tail-gating tests (Slice 3).

```ts
// New describe block: insert after the test ending at index.test.ts:146
// ('should wire before_provider_request capture that survives stale ctx'),
// inside the outer describe('index.ts (orchestrator)').
  describe('session_shutdown dead-flag gate (flag core)', () => {
    it('should register a session_shutdown handler', () => {
      routerExtension(mockPi);
      expect(mockPi.on).toHaveBeenCalledWith(
        'session_shutdown',
        expect.any(Function),
      );
    });

    it('should survive shutdown + stale captures and recover on the next live event', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      // session_shutdown fires before ctx invalidation — the handler must
      // not touch ctx (flag-only), so it cannot throw.
      const shutdownHandlers = eventListeners['session_shutdown'] || [];
      for (const handler of shutdownHandlers) {
        handler({}, mockCtx);
      }

      // A stale delivered ctx sets the flag via the captureCtx catch; the
      // swallow contract (index.test.ts:126-133) still holds.
      const staleCtx = {
        get modelRegistry() {
          throw new Error(
            'This extension ctx is stale after session replacement',
          );
        },
        get cwd() {
          throw new Error(
            'This extension ctx is stale after session replacement',
          );
        },
      };
      const captureHandlers = eventListeners['before_provider_request'] || [];
      for (const handler of captureHandlers) {
        handler({}, staleCtx);
      }

      // Recovery: the next live event (session_start with a fresh ctx)
      // completes a full restore — the flag cleared via live capture and
      // the extension stays fully functional.
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    });
  });

// HUNK B — tail-gating tests (Slice 3): insert directly after the flag-core
// describe above, inside the outer describe('index.ts (orchestrator)').
  describe('session_shutdown dead-flag gate (handler tails)', () => {
    const STALE_MESSAGE =
      'This extension ctx is stale after session replacement';

    const fireShutdown = () => {
      for (const handler of eventListeners['session_shutdown'] || []) {
        handler();
      }
    };

    it('should skip ctx reads in the switchToRouterProfile tail when the session dies during the model switch', async () => {
      routerExtension(mockPi);

      // Entry: the real /router command handler → handleProfile →
      // actions.switchToRouterProfile (commands.ts:222).
      const routerCommand = mockPi.registerCommand.mock.calls[0][1];
      const mockCtx = buildMockCtx();

      // Death lands during `await setModelInternally` (index.ts:273).
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      await routerCommand.handler('profile balanced', mockCtx);

      // Tail ran past the gates: persist happened, but the ctx-derived
      // status update was skipped (index.ts:281 gate).
      expect(mockPi.appendEntry).toHaveBeenCalled();
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        'Switched to router profile: balanced',
        'info',
      );
    });

    it('should skip the failure notify when the session dies during a failed model switch', async () => {
      routerExtension(mockPi);

      const routerCommand = mockPi.registerCommand.mock.calls[0][1];
      const mockCtx = buildMockCtx();

      // Death lands mid-switch AND the switch fails → the :275 gate must
      // skip the error notify; the command surfaces nothing either.
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return false;
      });

      await routerCommand.handler('profile balanced', mockCtx);

      // switchToRouterProfile returned false; handleProfile's success
      // notify did not fire; the router's own failure notify was gated.
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });

    it('should skip the session_start debug notify when the session dies during restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => {
        // Death lands mid-restore (index.ts:534).
        fireShutdown();
        return [
          {
            type: 'custom',
            customType: 'router-state',
            data: {
              enabled: true,
              selectedProfile: 'balanced',
              pinByProfile: {},
              thinkingByProfile: {},
              debugEnabled: true,
              timestamp: Date.now(),
            },
          },
        ];
      };

      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // Restore completed (mock ctx stays live) but the debug notify at
      // index.ts:535-540 was gated — no 'Router initialized' toast.
      expect(mockCtx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('Router initialized'),
        'info',
      );
    });

    it('should survive a stale delivered ctx in the model_select tail and still persist', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      mockCtx.ui.setStatus.mockClear();

      // Delivered-dead ctx: every getter throws (real dead-ctx shape —
      // pi runner.js ctx getters all throw after invalidation).
      const staleCtx = {
        get modelRegistry() {
          throw new Error(STALE_MESSAGE);
        },
        get cwd() {
          throw new Error(STALE_MESSAGE);
        },
        get ui() {
          throw new Error(STALE_MESSAGE);
        },
      };

      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        // Without the :569/:572 gates this rejects (ui getter throws);
        // with them the handler completes and still persists.
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          staleCtx,
        );
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
          lastNonRouterModel: 'anthropic/claude-3-5-sonnet',
        }),
      );
    });

    it('should skip the model_select status update when the session dies during the capacity refresh', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }
      mockCtx.ui.setStatus.mockClear();

      // Event model carries capacities that differ from the registry model
      // (undefined) → the capacity-refresh await at index.ts:561 runs.
      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      const modelSelectHandlers = eventListeners['model_select'] || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          {
            model: {
              provider: 'router',
              id: 'balanced',
              contextWindow: 999999,
              maxTokens: 9999,
            },
          },
          mockCtx,
        );
      }

      // Router branch completed (state already matched → persist may
      // dedupe), but the :572 gate skipped the status update.
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });

    it('should skip the turn_end status update when the session dies during the model restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners['session_start'] || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      // routerEnabled=true + non-router active model → turn_end restores
      // via `await setModelInternally` (index.ts:580).
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };
      mockCtx.ui.setStatus.mockClear();

      mockPi.setModel = vi.fn(async () => {
        fireShutdown();
        return true;
      });

      const turnEndHandlers = eventListeners['turn_end'] || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }

      // persistState ran (snapshot may dedupe — enabled state unchanged);
      // the ctx-derived status update at index.ts:584 was skipped.
      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });
  });
```
### extensions/provider.test.ts — MODIFY

Mid-turn deferred-gate suite, benign classification, abort-stops-retries, auth-await death, non-matching error.

```ts
// HUNK A — beforeEach mockState: add the flag field (models the Slice 1
// bridge getter's live read), insert after the lastExtensionContext block
      isExtensionContextDead: false,

// HUNK B — new describe block: insert inside describe('registerRouterProvider'),
// after the 'should throw enriched error when all candidates are silently
// skipped' test (ends provider.test.ts:999), before that describe closes
  describe('session replacement gates (dead flag / abort)', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const makeModel = () =>
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =>
      ({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    it('should end a mid-turn replacement silently and stop fallback retries', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      // Deferred gate (the suite's one new construct): the delegated stream
      // blocks mid-stream until the test simulates the replacement kill.
      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await midStreamGate;
          // pi aborts the underlying provider stream on session replacement.
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      // Pin medium: [gpt-4o-mini, gemini-1.5-flash] — the retry that must
      // NOT happen after the kill.
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']);

      // Session replacement: session_shutdown fired (flag set, Slice 1) and
      // the underlying stream aborted.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // Silent end: no error event, no fallback retry, state persisted.
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should stop candidate retries when only the abort signal fires', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await midStreamGate;
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      // Dead flag stays false: only the signal proves the choke's second
      // branch (user stop, not replacement).
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      controller.abort();
      releaseDelegated();
      await sleep(100);

      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should exit silently when the session dies during the auth await', async () => {
      let releaseAuth = () => {};
      const authGate = new Promise<void>((resolve) => {
        releaseAuth = resolve;
      });
      mockState.currentModelRegistry.getApiKeyAndHeaders = async () => {
        await authGate;
        return { ok: true, apiKey: 'key', headers: {} };
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'never reached' };
        })() as any,
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // Replacement lands while the auth fetch is in flight.
      mockState.isExtensionContextDead = true;
      releaseAuth();
      await sleep(100);

      // Post-auth gate fired: no delegated stream opened, silent end.
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify a stale-ctx throw as benign: no error event, still persists', async () => {
      // A pi-backed action throws pi's exact stale message mid-IIFE.
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        throw new Error(
          'This extension ctx is stale after session replacement',
        );
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should still surface a non-matching live error (negative control)', async () => {
      // Same throw site, wrong message: the classification must not mask a
      // live candidate failure (cdcfe2eb lesson).
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        throw new Error('API key revoked');
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.errorMessage).toContain('API key revoked');
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should keep gated ctx reads and still record the decision when a killed stream completes (reload case)', async () => {
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let releaseDelegated = () => {};
      const midStreamGate = new Promise<void>((resolve) => {
        releaseDelegated = resolve;
      });

      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        if (model.id === 'gpt-4o-mini') {
          // Primary fails normally (pre-kill) — the in-tier fallback opens.
          return (async function* () {
            throw new Error('primary failed');
          })() as any;
        }
        return (async function* () {
          // Fallback streams past the kill: on reload the delegated stream
          // runs to completion with the flag already set.
          yield { type: 'text_delta', delta: 'fallback answer' };
          await midStreamGate;
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);

      // Replacement fires mid-stream; the running stream completes anyway.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // Silent, decision recorded, ctx-derived status update gated.
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(mockActions.recordDebugDecision).toHaveBeenCalledTimes(1);
      expect(mockActions.updateStatus).toHaveBeenCalledTimes(1); // pre-loop only
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should exit silently when the session dies during the classifier await', async () => {
      // No pin + a configured classifier: the classifier call flows through
      // the mocked compat streamSimple (routing.ts:746) — the same
      // deferred-gate construct, no new mock surface.
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      let releaseClassifier = () => {};
      const classifierGate = new Promise<void>((resolve) => {
        releaseClassifier = resolve;
      });

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'medium' };
          await classifierGate;
          yield { type: 'text_delta', delta: 'medium' };
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']); // classifier call in flight

      // Replacement lands mid-classifier.
      mockState.isExtensionContextDead = true;
      releaseClassifier();
      await sleep(100);

      // Post-classifier gate fired: silent end, no delegated stream opened.
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(attempts).toEqual(['gpt-4o-mini']);
      expect(mockActions.persistState).toHaveBeenCalled();
    });

    it('should classify pi abort (AbortError) as benign: no error event', async () => {
      // AbortError thrown straight into the IIFE catch (not swallowed by
      // the per-candidate catch) — proves the catch's second branch.
      mockActions.syncPiThinkingLevel = vi.fn(() => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(mockActions.persistState).toHaveBeenCalled();
    });
  });
```

## Slices

### Slice 1: Flag core — runtime latch + session_shutdown wiring

**Files**: `extensions/index.ts`, `extensions/provider.ts`, `extensions/index.test.ts`

#### Automated Verification:
- [ ] Targeted suite passes: `npx vitest run extensions/index.test.ts` (includes the 2 new flag-core tests)
- [ ] `grep -c "session_shutdown" extensions/index.ts` returns >= 2 (comment + registration survived)
- [ ] `grep -n "isExtensionContextDead" extensions/provider.ts extensions/index.ts` shows the type field + flag + getter (>= 3 matches)

#### Manual Verification:
- [ ] Load the extension in pi (`router/auto`) — behavior unchanged (flag exists, no consumer gates in this slice)

### Slice 2: Provider stream gates — silent dead/aborted turn

**Files**: `extensions/provider.ts`, `extensions/provider.test.ts`

#### Automated Verification:
- [ ] Targeted suite passes: `npx vitest run extensions/provider.test.ts` (8 new gate tests + existing suite green)
- [ ] `grep -c "isExtensionContextDead" extensions/provider.ts` returns >= 6
- [ ] `grep -Fc "signal?.aborted" extensions/provider.ts` returns 3
- [ ] `grep -Fc "This extension ctx is stale after session replacement" extensions/provider.ts` returns exactly 1 (single constant, no inline copies)

#### Manual Verification:
- [ ] Dev session (Slices 1+2 applied): mid-stream `/new` on a `router/auto` turn — no provider error surface, turn ends silently; `index.ts:536-584` tails stay ungated until Slice 3

### Slice 3: Orchestrator gates — ctx-safe handler tails

**Files**: `extensions/index.ts`, `extensions/index.test.ts`

#### Automated Verification:
- [ ] Targeted suite passes: `npx vitest run extensions/index.test.ts` (6 new tail-gate tests + Slice 1 flag-core tests + existing suite green)
- [ ] Full baseline green (terminal slice): `npm run tsc && npm test`
- [ ] `grep -c "isExtensionContextDead" extensions/index.ts` returns >= 12
- [ ] `grep -n "lastExtensionContext && !isExtensionContextDead" extensions/index.ts` shows the extended recordDebugDecision condition

#### Manual Verification:
- [ ] Dev session (all slices applied): mid-stream `/new`, `/fork`, session switch, and reload on a `router/auto` turn — no error surface, silent turn end
- [ ] After each replacement path, the status line updates again on the next turn (flag recovery via live capture)

## Desired End State

A mid-stream session replacement ends the turn silently and the next live event fully restores behavior:

```ts
// User runs /new while router/auto streams → no error surface:
// - stream catch classifies the stale throw → benign → stream.end(), no error event
// - persistState runs (finally), swallowed if the session is already dead
// - fallback chain does NOT retry the next tier (signal aborted / flag set)
// Next turn: pi delivers a fresh ctx → before_provider_request → captureCtx
// clears the flag → status line updates again.
```

Manual acceptance: run pi with `router/auto`, start a generation, run `/new` mid-stream — no error surface, silent turn end, status line updates on the next turn. Repeat with `/fork`, a session switch, and a reload.

## File Map

```text
extensions/index.ts          # MODIFY — flag latch, captureCtx set/clear, session_shutdown handler, getter bridge, recordDebugDecision gate, four tail gates
extensions/provider.ts       # MODIFY — state-type field, post-await re-verifications, loop choke, ctx gates, benign catch classification
extensions/index.test.ts     # MODIFY — registration + lifecycle smoke tests, tail-gating tests
extensions/provider.test.ts  # MODIFY — mid-turn deferred-gate suite, benign classification, abort/retry tests
```

## Ordering Constraints

- Slice 1 first (foundation: the flag and its type must exist before any consumer).
- Slices 2 and 3 both depend on Slice 1 only; they are independent of each other but run sequentially (Slice 2 before Slice 3 keeps the acceptance-bar mid-turn test earliest).
- Within each file, merged code fences are rewritten whole when a later slice touches the same file (index.ts, index.test.ts in Slice 3; provider.ts in Slice 2).

## Verification Notes

- Risk: pi hook instability — commit `2b8e6862` removed 2 of 5 event names in one minor bump. Check: `grep -c "session_shutdown" extensions/index.ts` returns >= 2 (comment + registration). Verify the emit contract on pi upgrade (agent-session-runtime.js ordering).
- Risk: message-prefix drift in pi. Check: benign branch matches the exact prefix `'This extension ctx is stale after session replacement'`; a mismatch MUST degrade to the visible error path (asserted by the non-matching-error test).
- Risk: mock tests cannot verify pi's real emission order. Manual gate: the four manual checks in Desired End State (new, fork, switch, reload mid-stream).
- Existing fallback tests pass no signal (`streamSimple(model, context)`) — abort checks are opt-in via `options.signal`; the existing retry test (`provider.test.ts:174-217`) stays as the negative control.
- The killed turn loses its final persist delta (`lastDecision`/`accumulatedCost` deltas) — accepted trade-off (research-bounded loss).
- On reload the delegated stream runs to completion with gated UI reads; the status line freezes for that turn and recovers on the next live capture — accepted trade-off.

## Performance Considerations

- One boolean read per gate; classification runs only on the catch path. No hot-path cost.
- The loop choke SAVES work post-abort: skips credential fetches (`getApiKeyAndHeaders`) and delegated-stream opens for every remaining candidate.
- No allocation on the gate path; the benign exit reuses the existing `stream.end()`.

## Migration Notes

Not applicable — runtime-only flag, nothing persisted, no schema change.

## Pattern References

- `extensions/index.ts:57-59` — boolean latch declarations (slot for the new flag).
- `extensions/index.ts:70-79` — `captureCtx` (set/clear points).
- `extensions/index.ts:521-529` — sync comment-first lifecycle handler (model for `session_shutdown`).
- `extensions/index.ts:284-338` — getter bridge (slot beside `lastExtensionContext`).
- `extensions/provider.ts:166-190` — provider state type (slot beside `readonly lastExtensionContext`).
- `extensions/provider.ts:284-302` — hoisted early-return guard (model for silent exits).
- `extensions/provider.ts:730-743` — IIFE catch + finally (classification site).
- `extensions/index.test.ts:109-146` — throwing-getter stale ctx fixture + listener-map driving.
- `extensions/provider.test.ts:788-813, :998` — early-return guard test + `not.toHaveBeenCalled` assertion.
- `extensions/provider.test.ts:182-197` — per-model throwing generator (abort-retry test shape).

## Developer Context

- Q (Step 4, exit shape): "How should the new early-exit sites end a dead/aborted turn?" — evidence `provider.ts:334, :548, :526`, contract "no error event, stream.end(), persistState via finally :740". **Decision: Direct return** — `stream.end(); return;` at each site; catch keeps 2 benign branches.
- Inherited from research checkpoint (never re-ask): full-seam scope; `session_shutdown` invalidation point; benign classification requirement; abort-signal checks; handler-tail gating; silent persist no-op; flag excluded from persisted state.
- Solutions artifact: "Requires user input: None. All branches resolved in the research checkpoint." — confirmed; only the exit-shape mechanism was unpinned.
- Slice 1 micro-checkpoint (6.3): approved as generated. slice-verifier (6.2): Decisions OK, Cross-slice OK, Research 2 WARNINGs ratified — (1) artifact citation corrected to `index.test.ts:126-133` (stale fixture location); (2) flag-value observability deliberately deferred to Slice 2/3 consumers — the state bridge is not reachable from `mockPi.registerProvider` calls (registerProvider receives provider options, not the getters object), so the Slice 1 smoke test asserts recovery behavior (`setStatus` after a fresh `session_start`), not the flag value.
- Slice 2 micro-checkpoint (6.3): approved as generated. slice-verifier (6.2): Decisions OK, Cross-slice OK, Research 4 WARNINGs — (1) post-classifier gate untested → closed via classifier-await test (classifierModel flows through the mocked compat streamSimple, routing.ts:746 — no second mock construct); (2) AbortError catch branch untested → closed via syncPiThinkingLevel AbortError throw straight into the IIFE catch; (3) :465/:587 skip-gate dead branches unreachable (HUNK 3 precedes :465 sync; HUNK 6 precedes :587 with no await between) → ratified by developer as locked defense-in-depth; (4) fence anchor :996→:999 fixed.

- Slice 3 micro-checkpoint (6.3): approved as generated. slice-verifier (6.2): Decisions OK, Cross-slice OK, Research 4 WARNINGs — (1) HUNK 8 comment anchor :562→:561 fixed; (2) HUNK 7 comment anchor :446-459→:447-459 fixed; (3) grep-count breakdown annotation dropped (threshold >= 12 holds); (4) untested gate branches :275 failed-switch notify + model_select :561-await death closed via +2 tests rather than ratified.
## Design History

- Slice 1: Flag core — approved as generated
- Slice 2: Provider stream gates — revised then approved: slice-verifier coverage warnings closed (+2 tests: classifier-await death, AbortError-in-catch; anchor :996→:999); structurally-unreachable :465/:587 skip-gate branches ratified as defense-in-depth
- Slice 3: Orchestrator gates — approved as generated: slice-verifier Decisions OK, Cross-slice OK; 4 Research WARNINGs closed (+2 tests: :275 failed-switch gate, model_select :561-await death; comment anchors :561/:447-459 corrected; grep-count annotation simplified)
## References

- `.rpiv/artifacts/solutions/2026-09-04_12-25-31_stale-ctx-session-replacement.md` — input solution (Option 1 selected, all constraints).
- `.rpiv/artifacts/research/2026-09-04_10-46-35_stale-ctx-session-replacement.md` — seam census, lifecycle ground truth, locked decisions.
- `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md` — FRD.
- Commits: `f67a7850` (persistState stale swallow), `4ae87431` (captureCtx + hoisted guard), `cdcfe2eb` (delegation bridge bind), `2b8e6862` (pi 0.65.0 removed session_switch/session_fork).
- pi runtime: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js:100-106` (session_shutdown awaited before dispose), `dist/core/extensions/runner.js:425-461` (ctx getter stale check), `dist/core/model-registry.js:497-536` (no stale check).
