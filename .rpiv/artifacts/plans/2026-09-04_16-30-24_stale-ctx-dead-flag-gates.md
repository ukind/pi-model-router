---
date: 2026-09-04T16:30:24+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Dead-flag gate for stale extension ctx after session replacement"
tags: [plan, provider, stale-ctx, session-lifecycle, dead-flag]
status: ready
parent: .rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md
phase_count: 3
phases:
  - { n: 1, title: "Flag core — runtime latch + session_shutdown wiring", files: [extensions/index.ts, extensions/provider.ts, extensions/index.test.ts], depends_on: [] }
  - { n: 2, title: "Provider stream gates — silent dead/aborted turn", files: [extensions/provider.ts, extensions/provider.test.ts], depends_on: [1] }
  - { n: 3, title: "Orestrator gates — ctx-safe handler tails", files: [extensions/index.ts, extensions/index.test.ts], depends_on: [1] }
last_updated: 2026-09-04T16:53:51+0700
last_updated_note: "Step 5 triage complete — 6 reviewer findings all applied (documentation/comment mirrors only; code fences kept verbatim from design; no boundary changes); status ready"
last_updated_by: Yogiswara Utama
---

# Dead-flag gate for stale extension ctx after session replacement — Implementation Plan

## Overview

Pi invalidates the extension ctx on every session replacement (newSession, fork, switchSession, import, quit, reload). The router extension holds one captured ctx (`lastExtensionContext`) across a long-lived provider stream; stale reads throw and surface as user-visible errors. This plan implements the design's dead-flag gate: one runtime boolean `isExtensionContextDead` in the orchestrator closure, set by a new `session_shutdown` handler and by the `captureCtx` stale catch, cleared on the next live capture. The provider reads it through the existing getter bridge, gates every ctx-derived read, re-verifies liveness after each await boundary, stops post-abort tier retries, and classifies stale/AbortError throws in the stream catch as benign silent termination.

Phase boundaries are inherited 1:1 from the design's `## Slices` (slice-verifier validated each slice's atomicity and criteria/code alignment at design Step 6.2). Success Criteria pass through verbatim.

Design: `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md`

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

## What We're NOT Doing

- No `withSession` restructure — the router never initiates a replacement (hard).
- No persistence flush in `session_shutdown` — the killed stream is still mid-flight; fork/new never read the old file (hard, locked).
- No wrapper/proxy layer around ctx (rejected Option 2).
- No structural registry fix — `modelRegistryFallback`/`turn_start` capture from the 2026-08-30 design stay unbuilt.
- No changes to `extensions/ui.ts`, `extensions/state.ts`, `extensions/types.ts` — the flag is runtime-only.
- No changes to `extensions/commands.ts` — command ctx is fresh per invocation, but the stale mechanism is NOT unreachable there across internal awaits: `handleDisable` (commands.ts:410-418) and the `handleThinking` tail keep unguarded await-then-notify/read shapes, and gating `switchToRouterProfile` (a command-path action, gated in index.ts) itself proves death during an internal await is reachable from command handlers. These tails stay ungated in this plan — accepted gap (see the residual command-path bullet above); route the design-level fix through `/skill:design`.
- Residual delivered-dead sync window in `model_select`'s router branch: the early `ctx.ui.notify('Unknown router profile: …')` (index.ts:541-544) runs after `captureCtx` may have flagged a delivered-dead ctx and stays ungated — same class as the `thinking_level_select` sync window; self-heals on the next live capture. Documented, not gated (Plan Review suggestion 3); the new stale model_select test exercises only the else branch.
- No gating of the sync `thinking_level_select` body — no internal await means no widened race window (delivered-dead sync window pre-exists and self-heals on the next live capture).
- Residual command-path gap (accepted, design follow-up): `handleProfile`'s post-await success notify (`commands.ts:224-227`, after `switchToRouterProfile` returns) stays ungated — a mid-switch session replacement can still surface the stale error via `/router profile`. Phase 3's first tail test asserts that notify fires against a mock ctx that stays live; in a real dead ctx the same notify throws. The flag is not plumbed into `commands.ts` in this plan; route the design-level fix through `/skill:design` (see Plan Review concern 1).

---

## Phase 1: Flag core — runtime latch + session_shutdown wiring

### Overview

Delivers the foundation: the `isExtensionContextDead` boolean beside the sibling latches, set/clear wired into `captureCtx`, the sixth `session_shutdown` handler (flag-only, never touches ctx), the getter bridge entry, the `readonly isExtensionContextDead` field on the provider state type, and 2 flag-core tests (registration + lifecycle smoke with recovery). No consumer gates yet — the flag exists and is observable, nothing reads it. This is the only phase that touches all three of its files' shared surfaces; Phases 2 and 3 build their gates on top of it.

### Changes Required:

#### 1. Orchestrator flag core
**File**: `extensions/index.ts`
**Changes**: Flag declaration beside the sibling latches; `captureCtx` rewritten with set/clear points (existing contract comment preserved verbatim); new sixth handler registered after the `before_provider_request` block; getter bridge entry inside the `registerRouterProvider` state object after `get lastExtensionContext()`.

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
      // NOTE: `lastExtensionContext` may already hold the dead ctx here
      // (assigned before the throwing getter read) while the flag is set —
      // every reader must check `isExtensionContextDead` first.
      // (Comment amended by plan review, Step 5 S1; code order kept verbatim
      // from the design — reorder only via a /skill:design follow-up.)
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
```

#### 2. Provider state-type field
**File**: `extensions/provider.ts`
**Changes**: One new `readonly` field on the provider state type, inserted after `readonly lastExtensionContext`. No consumer reads it in this phase.

```ts
// HUNK 1 — state param type (Slice 1): insert after
// `readonly lastExtensionContext: ExtensionContext | undefined;` (provider.ts:172)
    readonly isExtensionContextDead: boolean;
```

#### 3. Flag-core tests
**File**: `extensions/index.test.ts`
**Changes**: New describe block after the test ending at index.test.ts:146, inside the outer `describe('index.ts (orchestrator)')`: registration assertion + lifecycle smoke (shutdown → stale captures → recovery on the next live event).

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
```

### Success Criteria:

#### Automated Verification:
- [x] Targeted suite passes: `npx vitest run extensions/index.test.ts` (includes the 2 new flag-core tests)
- [x] `grep -c "session_shutdown" extensions/index.ts` returns >= 2 (comment + registration survived)
- [x] `grep -n "isExtensionContextDead" extensions/provider.ts extensions/index.ts` shows the type field + flag + getter (>= 3 matches)

#### Manual Verification:
- [ ] Load the extension in pi (`router/auto`) — behavior unchanged (flag exists, no consumer gates in this slice)

---

## Phase 2: Provider stream gates — silent dead/aborted turn

### Overview

Turns the flag into behavior in the provider stream: the exact stale-message-prefix constant, liveness/abort re-verification after the classifier await and after the auth await, the inner-loop-top choke point that stops post-abort tier retries, the three extended ctx gates (`:465`, `:587`, `:703`), and the benign 2-branch classification in the IIFE catch. Includes the acceptance-bar mid-turn deferred-gate suite (the suite's one new test construct) plus 7 further gate tests. `extensions/provider.ts` is rewritten whole from the Phase-1-applied state (merged code fences, per design's Ordering Constraints).

### Changes Required:

#### 1. Provider stream gates
**File**: `extensions/provider.ts`
**Changes**: Module constant `STALE_CTX_MESSAGE_PREFIX`; post-classifier re-verification; ctx gate at `:465`; inner-loop-top choke; post-auth re-verification; ctx gates at `:587` and `:703`; benign classification rewriting the IIFE catch.

```ts
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

#### 2. Mid-turn gate test suite
**File**: `extensions/provider.test.ts`
**Changes**: `mockState` beforeEach gains the flag field; new describe block after the 'should throw enriched error when all candidates are silently skipped' test, before that describe closes — 8 tests covering mid-turn replacement, abort-only signal, auth-await death, stale classification, non-matching negative control, reload completion, classifier-await death, AbortError-in-catch.

```ts
// HUNK A — beforeEach mockState: add the flag field (models the Slice 1
// bridge getter's live read), insert after the lastExtensionContext block
      isExtensionContextDead: false,

// HUNK B — new describe block: insert inside describe('registerRouterProvider'),
// after the 'should throw enriched error when all candidates are silently
// skipped' test (ends provider.test.ts:999), before that describe closes
  describe('session replacement gates (dead flag / abort)', () => {
    const sleep = (ms: number) =
      new Promise((resolve) => setTimeout(resolve, ms));

    const makeModel = () =
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =
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

### Success Criteria:

#### Automated Verification:
- [x] Targeted suite passes: `npx vitest run extensions/provider.test.ts` (8 new gate tests + existing suite green)
- [x] `grep -c "isExtensionContextDead" extensions/provider.ts` returns >= 6
- [x] `grep -Fc "signal?.aborted" extensions/provider.ts` returns 3
- [ ] `grep -Fc "This extension ctx is stale after session replacement" extensions/provider.ts` returns exactly 1 (single constant, no inline copies)
- [x] `grep -Fc "This extension ctx is stale after session replacement" extensions/provider.ts` returns exactly 1 (single constant, no inline copies)
#### Manual Verification:
- [ ] Dev session (Slices 1+2 applied): mid-stream `/new` on a `router/auto` turn — no provider error surface, turn ends silently; `index.ts:536-584` tails stay ungated until Slice 3

---

## Phase 3: Orestrator gates — ctx-safe handler tails

### Overview

Gates the orchestrator's ctx-derived reads: the `recordDebugDecision` notify condition (history push stays ungated — restore reads it), and the four handler tails that touch ctx after an internal await (`switchToRouterProfile`, `session_start` debug notify, `model_select` tail, `turn_end` status). `persistState` calls stay ungated (they swallow stale internally). 6 tail-gate tests plus the terminal whole-suite gate. `extensions/index.ts` and `extensions/index.test.ts` are rewritten whole from the Phase-1-applied state (merged code fences, per design's Ordering Constraints).

### Changes Required:

#### 1. Orchestrator gates
**File**: `extensions/index.ts`
**Changes**: `recordDebugDecision` notify condition extension; two `switchToRouterProfile` tail gates; `session_start` debug-notify gate; two `model_select` tail gates; `turn_end` status gate.

```ts
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

#### 2. Tail-gating tests
**File**: `extensions/index.test.ts`
**Changes**: New describe block directly after the flag-core describe from Phase 1, inside the outer describe — 6 tests covering the switch-profile tails (success + failed), session_start restore death, stale model_select tail, capacity-refresh death, and turn_end restore death.

```ts
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

### Success Criteria:

#### Automated Verification:
- [x] Targeted suite passes: `npx vitest run extensions/index.test.ts` (6 new tail-gate tests + Slice 1 flag-core tests + existing suite green)
- [x] Full baseline green (terminal slice): `npm run tsc && npm test`
- [x] `grep -c "isExtensionContextDead" extensions/index.ts` returns >= 12
- [x] `grep -n "lastExtensionContext && !isExtensionContextDead" extensions/index.ts` shows the extended recordDebugDecision condition

#### Manual Verification:
- [ ] Dev session (all slices applied): mid-stream `/new`, `/fork`, session switch, and reload on a `router/auto` turn — no error surface, silent turn end
- [ ] After each replacement path, the status line updates again on the next turn (flag recovery via live capture)

---

## Testing Strategy

### Automated:
- Phase 1: `npx vitest run extensions/index.test.ts` — targeted orchestrator suite with the 2 new flag-core tests
- Phase 2: `npx vitest run extensions/provider.test.ts` — targeted provider suite with the 8 new gate tests
- Phase 3 (terminal): `npm run tsc && npm test` — full type-check + suite green over all applied phases
- Grep-based structural checks per phase (see each phase's Automated Verification)
- Flake surface: the Phase 2 deferred-gate tests are the suite's first timing-race assertions — `sleep(50)`/`sleep(100)` settles before assertions like `expect(attempts).toEqual(['gpt-4o-mini'])` assume mocked generators registered in time. Consistent with the suite's existing fixed-settle style, but if loaded CI flakes, introduce a poll-until helper for those four assertions (design follow-up; Plan Review suggestion 2).
- Accepted trade-off (research-bounded, design Verification Note 5): the killed turn loses its final persist delta (`lastDecision` / `accumulatedCost`) — the `persistState` swallow is deliberate; do NOT add flush/retry machinery. The "persistState called" assertions in the Phase 2 tests assert exactly that silent no-op; re-open the decision only via `/skill:design`.

### Manual Testing Steps:
1. Dev session with Phases 1+2 applied: mid-stream `/new` on a `router/auto` turn — no provider error surface, turn ends silently.
2. Dev session with all phases applied: mid-stream `/new`, `/fork`, a session switch, and a reload — no error surface, silent turn end.
3. After each replacement path, confirm the status line updates again on the next turn (flag recovery via live capture).
4. On pi upgrade, verify the `session_shutdown` emit contract still awaits every handler before invalidation (pi core `agent-session-runtime.js` ordering) — pi hooks are not stable API; commit `2b8e6862` removed 2 of 5 event names in one minor bump.
5. The existing fallback tests pass no signal (`streamSimple(model, context)`) — abort checks are opt-in via `options.signal`; the existing retry test (`provider.test.ts:174-217`) stays as the negative control.

## Performance Considerations

- One boolean read per gate; classification runs only on the catch path. No hot-path cost.
- The loop choke SAVES work post-abort: skips credential fetches (`getApiKeyAndHeaders`) and delegated-stream opens for every remaining candidate.
- No allocation on the gate path; the benign exit reuses the existing `stream.end()`.

## Migration Notes

Not applicable — runtime-only flag, nothing persisted, no schema change. The flag must never enter `RouterPersistedState` (hard constraint): a persisted `true` would disable the new instance's UI forever.

## Developer Context

- Step 4 code review: the first artifact-code-reviewer pass verified all source anchors but failed to emit its findings table; the rows below come from a retry pass. The artifact-coverage-reviewer succeeded first pass.
- Step 4 code review unavailable-note: n/a — retry succeeded; both reviewers' findings present.

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source   | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| -------- | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- | ---------- |
| code | Phase 3, HUNK 6 + test 'should skip ctx reads in the switchToRouterProfile tail…' | commands.ts:222-227 (handleProfile success notify) | concern | codebase-fit | The plan gates `switchToRouterProfile`'s tails because death can land during `await setModelInternally` (index.ts:273) — but the caller's own post-await ctx read is left ungated: `handleProfile` does `ctx.ui.notify('Switched to router profile: …')` (commands.ts:224-227) after `switchToRouterProfile` returns, on the same possibly-dead ctx. Phase 3 test 1 asserts this ungated notify fires (`toHaveBeenCalledWith('Switched to router profile: balanced')`), enshrining the residual stale-throw path in a test. A mid-switch `/new` therefore still surfaces a user-visible stale error via `/router profile`, contradicting the design requirement "Remove the user-visible stale error on every replacement path." | Either gate the command-path tail too (same `!isExtensionContextDead` check around handleProfile's success notify, or have handleProfile rely on the gated `updateStatus`), or explicitly record this residual path as an accepted gap in "What We're NOT Doing" — the current rationale ("command ctx is fresh per invocation") is contradicted by gating `switchToRouterProfile` itself, which is a command-path action. | applied: residual command-path notify documented as an accepted gap in "What We're NOT Doing"; test code left verbatim from design; design-level fix routed to a `/skill:design` follow-up (plan-local, option b of the skill's code-finding caveat) |
| code | Phase 3, "What We're NOT Doing" (commands.ts exclusion) | commands.ts:410-418 (handleDisable), handleThinking tail | concern | completeness | The commands.ts exclusion says the stale mechanism is "unreachable there," yet the same await-then-ctx-read shape the plan gates in index.ts exists inside commands.ts: `handleDisable` awaits `pi.setModel` (:410) then reads `ctx.ui.notify`/`actions.updateStatus` (:412-418); `switchToRouterProfile` being gated at all proves death during an internal await is reachable from a command handler. These tails stay unguarded and can reject with the stale throw. | Extend the same `!isExtensionContextDead` gates to the commands.ts await-then-notify tails, or amend the exclusion note to justify why those specific awaits are considered unreachable (currently the stated rationale doesn't hold across an internal await). | applied: exclusion bullet amended to accurately describe the residual unguarded commands.ts awaits (handleDisable :410-418, handleThinking tail) and to cite the gating of switchToRouterProfile as proof of reachability; documentation-only, no scope change |
| code | Phase 1, HUNK 2 (captureCtx rewrite) | index.ts:70-79 | suggestion | code-quality | HUNK 2 assigns `lastExtensionContext = ctx` before `ctx.modelRegistry` throws, so after a stale capture `lastExtensionContext` points at the dead ctx while the hunk comment says "Keep the last captured values." The flag covers all current readers, but the dead pointer contradicting the comment is a trap for future ungated readers (the plan's own gates only protect because they check `!isExtensionContextDead`). | Reorder so getter reads land in locals first and the captures are assigned only on success (assignment order then proves liveness), or amend the comment to state `lastExtensionContext` may hold the dead ctx while the flag is set. | applied: in-fence comment amended to state lastExtensionContext may hold the dead ctx while the flag is set and that every reader must check the flag first; code order kept verbatim from the design (reorder routed to /skill:design follow-up) |
| code | Phase 2, tests (mid-turn, classifier-await, auth-await, reload) | provider.test.ts (new describe) | suggestion | actionability | The deferred-gate tests assert on fixed real-timer sleeps — e.g. `expect(attempts).toEqual(['gpt-4o-mini'])` at 50ms assumes the classifier's mocked `streamSimple` call has registered, and the reload test assumes primary failure + fallback-stream open complete within 50ms of the flag being set. Consistent with the suite's existing fixed-settle style, but these are the suite's first timing-race assertions and can flake on loaded CI. | Consider a small poll-until helper (or `vi.useFakeTimers` with manual advancement) for the four timing-dependent assertions instead of bare `sleep(50)`/`sleep(100)`. | applied: design-authored sleeps kept verbatim (consistent with the suite's fixed-settle style); flake surface documented under Testing Strategy → Automated with a poll-until-helper escape hatch for CI flake (design follow-up) |
| code | Phase 3, "What We're NOT Doing" / HUNK 8 | index.ts:541-544 (model_select router-branch early notify) | suggestion | completeness | The model_select gates cover only the two tails (`:569`/`:572`), but the router branch's synchronous `ctx.ui.notify('Unknown router profile: …')` also runs after `captureCtx` may have flagged a delivered-dead ctx — the same delivered-dead sync window the plan documents (and declines to gate) only for `thinking_level_select`. The new stale model_select test exercises only the else branch, so this window is untested and can throw. | Either gate the early notify with the same flag or add it to the "NOT Doing" note alongside `thinking_level_select` so the residual sync window is documented rather than implicit. | applied: residual delivered-dead sync window documented in "What We're NOT Doing" alongside the thinking_level_select bullet, noting the stale model_select test covers only the else branch; no scope change |
| coverage | missing | <n/a> | suggestion | verification-coverage | Design Verification Note 5 (accepted killed-turn persist-delta loss: `lastDecision` and `accumulatedCost` deltas from the dead turn are swallowed by `persistState`'s stale catch and never retried) has no mirror anywhere in the plan. The plan's nearest text states the mechanism but never the accepted data-loss trade-off; a validator/implementer may flag the "persistState called" assertions as under-asserting and "fix" the swallow, re-opening the FRD decision; the deliberate silent delta loss is invisible to readers of the plan alone. | Add one line to "What We're NOT Doing" or Testing Strategy mirroring the design note verbatim in intent, e.g. "Accepted trade-off (research-bounded): the killed turn loses its final persist delta (`lastDecision` / `accumulatedCost`) — the swallow is deliberate, do not add flush/retry machinery." No test change required. | applied: accepted-trade-off mirror added under Testing Strategy → Automated, framed as guidance so validators/implementers do not "fix" the deliberate swallow |

_Reviewer audit notes (non-finding): all Phase 1/2/3 source anchors verified at the stated locations (index.ts:59/70-79/119/273-281/300-302/527-529/534-540/561-572/580-584; provider.ts:46/172/465/526/548/587/703/730-739); test-insertion anchors verified (index.test.ts:146; provider.test.ts:999 with describe closing at :1000); mock surfaces all exist (`mockPi.registerCommand.mock.calls[0][1]` is the sole `router` command, `mockPi.setModel`, `eventListeners`, `MockEventStream`, `mockState.pinnedTierByProfile`, `currentModelRegistry.getApiKeyAndHeaders` overridable, `syncPiThinkingLevel`/`recordDebugDecision`/`persistState` in `mockActions`); the classifier-await test premise holds (`runClassifier` calls the same mocked compat `streamSimple`, routing.ts:746); `updateStatus` reaches `ctx.ui.setStatus` (ui.ts:111/113). Grep thresholds plausibly hold: provider.ts `isExtensionContextDead` = 8 ≥ 6; `signal?.aborted` = 3; stale prefix = exactly 1; index.ts `isExtensionContextDead` = 12 ≥ 12 — exactly at threshold, no slack; `session_shutdown` = 2._

## References

- Design: `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md`
- Solution: `.rpiv/artifacts/solutions/2026-09-04_12-25-31_stale-ctx-session-replacement.md`
- Research: `.rpiv/artifacts/research/2026-09-04_10-46-35_stale-ctx-session-replacement.md`
- FRD: `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md`

- Design: `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md`
- Solution: `.rpiv/artifacts/solutions/2026-09-04_12-25-31_stale-ctx-session-replacement.md`
- Research: `.rpiv/artifacts/research/2026-09-04_10-46-35_stale-ctx-session-replacement.md`
- FRD: `.rpiv/artifacts/discover/2026-09-04_10-32-21_stale-ctx-session-replacement.md`
