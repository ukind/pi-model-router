---
date: 2026-09-07T12:21:08+0700
author: Yogiswara Utama
commit: d793dbde
branch: main
repository: pi-model-router
topic: "Router stall watchdog — timeout, fallback on silence, Esc abort"
tags: [plan, provider, routing, classifier, stall, fallback, abort, config, watchdog]
status: ready
parent: .rpiv/artifacts/research/2026-09-07_11-07-29_router-stall-fallback-abort.md
phase_count: 5
phases:
  - { n: 1, title: Config knob stallTimeoutMs }
  - { n: 2, title: Watchdog helper in routing.ts }
  - { n: 3, title: Aborted terminal-event contract }
  - { n: 4, title: Delegated wait sites }
  - { n: 5, title: Classifier threading }
unresolved_phase_count: 0
last_updated: 2026-09-07T12:21:08+0700
last_updated_by: Yogiswara Utama
---

# Router Stall Watchdog Implementation Plan

## Overview

Every external wait in the router's per-turn path gets an inactivity watchdog: a per-event-reset `Promise.race` against a stall timer and the abort signal, hosted as shared helpers in `routing.ts`. A stall throws a name-discriminated `StallTimeoutError` that rides the existing exception-driven fallback chain (next model, then cross-tier) — no new advance machinery. Esc-aborted turns end with a builtin-provider-shaped `stopReason:'aborted'` terminal event instead of a bare `stream.end()`, so pi's agent loop always resolves and never wedges. A single `stallTimeoutMs` config knob (default 90000) bounds all four wait sites.

## Requirements

- Zero stream events for `stallTimeoutMs` counts as a stall; every yielded event resets the timer (FRD req 1).
- Main-model stream stall → cancel the stalled stream, continue the existing fallback chain exactly as a thrown error does today (FRD req 2).
- Classifier stall → next classifier fallback ref; all refs stalled/failed → heuristic routing; the turn never blocks on the classifier (FRD req 3).
- `options.signal` reaches the classifier `streamSimple` and is raced against every await in the per-turn path; on abort the router stream ends with a `stopReason:'aborted'` terminal event, no error surfaced (FRD req 4, amended by research: bare `end()` parks `agent-loop.js:238` forever).
- `getApiKeyAndHeaders` bounded by the same stall timeout; on timeout, skip to the next candidate instead of hanging (FRD req 5).
- Every stall-triggered fallback pushes one short user-visible line (`ui.notify(..., 'warning')`) — main model AND classifier stalls — and records the stall in decision reasoning / debug history (FRD req 6, classifier-note scope confirmed at checkpoint).
- `stallTimeoutMs` optional top-level config key; absent or invalid → 90000 after normalization (FRD req 7).
- `npm run tsc` and the extension test suite pass with no regressions to existing fallback/error tests.

## Current State Analysis

Four unbounded waits exist in the per-turn `streamSimple` IIFE (`provider.ts:310-789`):

1. **Classifier await** `provider.ts:341-348` → `runClassifier` (`routing.ts:698-783`), whose stream open at `routing.ts:746-750` passes **no signal** — the primary hang from the field session.
2. **Classifier auth fetch** `routing.ts:712-713`.
3. **Delegated auth fetch** `provider.ts:569-572` (outside the per-candidate `try` at `:591`).
4. **Delegated stream** `for await` at `provider.ts:668-695` (signal already forwarded via `delegationOptions`, but silence never errors).

The fallback machinery is complete and needs no changes: thrown errors land in `catch (err) { lastError = err; }` (`provider.ts:743-745`) → next candidate/tier; `decision.isFallback` mutation blocks at `:698-733` run on success; exhaustion throws at `:748-757`. The classifier needs zero advance code (its catch at `routing.ts:777-780` converts any failure into next-ref → `undefined` → heuristics).

A fifth, platform-level defect compounds the hang: any quiet stream termination (`stream.end()` without a terminal event) parks pi's agent loop forever — `agent-loop.js:238` awaits `response.result()`, which bare `end()` never resolves. All three router choke points (`:354-357`, `:545-548`, `:576-579`) and the benign-abort catch (`:770-786`) call bare `end()` today.

### Key Discoveries

- `mergeConfig` (`config.ts:114-146`) returns an explicit object literal listing exactly seven fields — a top-level key absent from that literal is silently discarded before `normalizeConfig` sees it. `stallTimeoutMs` needs one merge line mirroring `maxSessionBudget` at `:141` or the knob is dead on every load path.
- `EventStream.push` of a `done`/`error` event resolves `finalResultPromise` (`event-stream.js:16-33`); bare `end()` never does. Builtin providers convert aborts into `{ type: 'error', reason: 'aborted', error: <AssistantMessage stopReason:'aborted'> }` + `end()` (verified `openai-completions.js:361-376`). The TUI renders `stopReason === 'aborted'` benignly as "Operation aborted" (`interactive-mode.js:2297-2306`).
- `ModelRegistry.getApiKeyAndHeaders` is a total function (any throw → `{ ok: false, error }`), internally bounded ≈73 s worst case — safe to `Promise.race`-abandon, never rejects unhandled.
- `routing.ts` has no config or ctx access (zero `currentConfig` references) — the timeout value and UI notes must arrive as parameters/callbacks.
- Error discrimination convention is name assignment: `error.name === 'AbortError'` (`provider.ts:774-775`), created the same way in tests (`provider.test.ts:1032-1033`). No `class X extends Error` anywhere.
- `provider.ts` already imports 12 symbols from `routing.ts`; hosting the shared watchdog helpers in `routing.ts` keeps the dependency graph one-way (checkpoint decision).
- `MockEventStream` (`provider.test.ts:8-40`) has no `result()` contract — it cannot catch the bare-`end()` wedge class; assertions are event-based.
- Config reaches `provider.ts` via live getters (`index.ts:311-313`), so a per-turn `state.currentConfig.stallTimeoutMs` read sees `/router reload`.
- `sanitizeRoutingDecisionFields` (`state.ts:68-152`) restores `lastDecision` field-by-field and drops unknown fields (while `debugHistory` restore is unsanitized) — a new decision field would vanish from `lastDecision` but survive in history; reasoning-string provenance avoids the asymmetry entirely.

## Desired End State

Config (`model-router.json`):

```json
{
  "classifierModel": "flash",
  "stallTimeoutMs": 90000,
  "profiles": { "...": "..." }
}
```

Behavior, main-model stall (user's view):

```
> build the feature
⠂ Working...
⚠ router: glm-5.3 stalled after 90000ms with no progress — trying next
... glm-5.3-flash streams the answer ...
```

Behavior, Esc during a stalled turn:

- The turn ends immediately. The UI shows "Operation aborted". The run is not
  stuck at "Working...", no `/quit` needed, no error surfaced.

Behavior, classifier stall:

```
⚠ classifier flash stalled (90s) — trying next ref
router routes via heuristics; the turn completes normally
```

Total stall (every candidate stalls):

- One warning line per stall, then an error event naming the stall:
  `All candidates stalled (90000ms)` — surfaced like today's total failure.

## What We're NOT Doing

- Redoing the lost 2026-08-31 `isCrossApiToolContinuation` cross-API fix (separate change; `git log -S` empty, only the Google-only guard at `provider.ts:373-399` exists).
- Upstream fixes: `~/.pi/auth.json` cross-instance lock redesign, zai-paas stall behavior, pi-claude-bridge fail-loudly patch (carried as follow-ups in research).
- Any pi-core / `pi-ai` modification — extension-only.
- A new `RoutingDecision` field (reasoning-string provenance chosen; sanitizer asymmetry + five consumer touch points).
- `ui.setWorkingMessage` relabel during retry windows; `pi-ai` `timeoutMs` total-request ceiling on the classifier call (watchdog covers both waits already).
- Changes to tier routing logic, classifier prompt, or classifier accuracy.
- New module `extensions/watchdog.ts` (checkpoint: avoid; helpers live in `routing.ts`).
- A stall watchdog on waits outside the per-turn path (init, restore, command handlers) — those are not the hang class from the field session.

## Decisions

### Helper home — routing.ts exports, no new module
**Ambiguity**: New `extensions/watchdog.ts` module vs no new file. Developer rejected the new module (checkpoint). Hosting in `provider.ts` would create the repo's first `provider ↔ routing` cycle. **Decision**: host `raceStallTimeout`, `stallGuardedStream`, `createStallTimeoutError`, `isStallTimeoutError` in `routing.ts` (exported); `provider.ts` imports them alongside its existing 9 routing imports (`provider.ts:32-43`). One-way deps, one shared implementation.

### Stall error discrimination — name assignment

**Decision**: `createStallTimeoutError(ms, what)` returns `new Error(...)` with `.name = 'StallTimeoutError'`; `isStallTimeoutError` matches by name. Modeled after the `AbortError` idiom (`provider.ts:775-776`, test creation `provider.test.ts:1032-1033`). The stall leg must NOT be `AbortError`-named (it must surface as a real error on total exhaustion); the abort leg must be `AbortError`-named (benign classification).

### Delegated-stream stall — throw inside the per-candidate try
**Decision**: `stallGuardedStream` wraps the delegated stream; on stall it calls the `onStall` callback (abort the per-candidate controller) then throws `StallTimeoutError` from inside the `try` at `provider.ts:591` → existing catch `:742-744` advances → success-path mutation blocks fire unchanged. A `break` would falsely mark the stalled candidate successful. Per-candidate `AbortController` composed with `options?.signal` MANUALLY (one `addEventListener` + `finally` cleanup) — pi-ai ships `combineAbortSignals` only as `dist/utils/abort-signals.js`, unreachable through the package exports map (`.` / `./compat` / `./providers/*` / `./api/*` / `./oauth` / `./bedrock-provider` only; root does not re-export). The composed signal overrides the spread's user signal in both delegation branches. Amended at Phase 4 lock.

### Post-content stall — retry next model
**Inherited** (research checkpoint). The partial may hold an unclosed tool call; pi's agent loop replaces `partialMessage` in place (`agent-loop.js:204-221`), so the successor's stream supersedes the forwarded partial.

### Auth stall — advance idiom, not raw throw
**Decision**: The delegated auth await sits outside the `try`; a stall there becomes `lastError = stallError; continue;` (the `:580-587` idiom); an abort there performs the aborted-end + return (a hung auth starves the `:576` choke). The classifier auth await sits inside the per-ref `try` — a race rejection lands in the existing catch (`routing.ts:777-780`) → next ref; abort → loop-top check → `return undefined`.

### Aborted turns — builtin-shaped terminal event everywhere
**Inherited** (research checkpoint; shape verified against dist). `createAbortedMessage(model)` (sibling of `createErrorMessage`, `stopReason: 'aborted'`); push `{ type: 'error', reason: 'aborted', error: <aborted message> }` then `end()`. Applied to: the three choke points (`:354-357`, `:545-548`, `:576-579`) and the benign-abort/stale-ctx catch suppression (`:770-786`). Push order matters: `push()` no-ops after `end()` (`event-stream.js:16-18`).

### Stall visibility — warning notes, main model AND classifier
**Inherited + checkpoint**. `ui.notify(message, 'warning')` always appends (`'info'`/showStatus dedups — `interactive-mode.js:2499-2515`), exactly right for multi-stall chains. Main-model stalls notify from the provider IIFE (direct `state.lastExtensionContext.ui` access is established — `setHiddenThinkingLabel` precedent `provider.ts:616-627`, gated on `!isExtensionContextDead`). Classifier stalls notify via an `onStall` callback threaded into `runClassifier` (keeps `routing.ts` ctx-free). Wording is generic (`<label> stalled (Ns) — trying next model`) because the next candidate is not yet chosen at detection time and may be skipped.

### Provenance — reasoning-string only
**Inherited** (research checkpoint). Stall events append to `decision.reasoning` on the success path (`[stall fallbacks: ...]`), so `recordDebugDecision` history, `/router status`, and the widget all show it with zero new fields. On total failure the detection-time note is the only provenance — which is why notes are `'warning'`, not debug-gated.

### Config knob — optional, always-concrete after normalize
**Decision**: `stallTimeoutMs?: number` on `RouterConfig` (after `maxSessionBudget`, `types.ts:89`); `DEFAULT_STALL_TIMEOUT_MS = 90_000` in `constants.ts` (numeric-underscore style); one merge line in `mergeConfig` (`override.stallTimeoutMs ?? base.stallTimeoutMs`); normalize gate `typeof === 'number' && v > 0 ? v : DEFAULT_STALL_TIMEOUT_MS` emitted always-concrete; runtime read `state.currentConfig.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS` per turn (the `??` guards pre-normalize placeholder configs and test literals — precedent `index.ts:232`). `Infinity` passes the gate (watchdog disabled) — same hole as `maxSessionBudget` at `config.ts:422`, accepted by FRD wording.

### Timer reset set — any yielded event
**Decision**: the shared guard resets on every yielded event (connection-inactivity semantics: trip only on true silence), used uniformly at both stream sites. The FRD's four-content-event enumeration is the conservative subset; any-event is strictly safer against false stalls. `contentReceived` logic (`provider.ts:687-694`) is unchanged and independent.

## Phase 1: Config knob stallTimeoutMs

### Overview
Foundation slice: the `stallTimeoutMs` config field, default constant, merge-whitelist line, normalization gate, docs, and config tests. Depends on nothing.

### Changes Required:

#### 1. extensions/types.ts:89
**File**: extensions/types.ts
**Changes**: MODIFY — add optional `stallTimeoutMs?: number` to `RouterConfig` after `maxSessionBudget`

```ts
  maxSessionBudget?: number;
  stallTimeoutMs?: number;
```

#### 2. extensions/constants.ts:5
**File**: extensions/constants.ts
**Changes**: MODIFY — add `DEFAULT_STALL_TIMEOUT_MS = 90_000`

```ts
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
```

#### 3. extensions/config.ts:141
**File**: extensions/config.ts
**Changes**: MODIFY — mergeConfig whitelist line (after `maxSessionBudget`), normalize gate (after the `maxSessionBudget` block), return-literal field (after `maxSessionBudget`)

```ts
// (a) extend the existing constants import
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STALL_TIMEOUT_MS,
} from './constants';

// (b) mergeConfig return literal — add after maxSessionBudget:
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    stallTimeoutMs: override.stallTimeoutMs ?? base.stallTimeoutMs,

// (c) normalizeConfig — add after the maxSessionBudget block:
  const stallTimeoutMs =
    typeof raw.stallTimeoutMs === 'number' && raw.stallTimeoutMs > 0
      ? raw.stallTimeoutMs
      : DEFAULT_STALL_TIMEOUT_MS;

// (d) normalizeConfig return literal — add after maxSessionBudget:
      maxSessionBudget,
      stallTimeoutMs,
```

#### 4. model-router.example.json:5
**File**: model-router.example.json
**Changes**: MODIFY — add `"stallTimeoutMs": 90000` after `"maxSessionBudget"`

```json
  "maxSessionBudget": 1.0,
  "stallTimeoutMs": 90000,
```

#### 5. README.md:64
**File**: README.md
**Changes**: MODIFY — add `stallTimeoutMs` to the complete-config example JSON (line 64 area) and a Configuration Fields table row after `maxSessionBudget` (line 142)

```markdown
# Complete Config Example (~line 64) — add after the maxSessionBudget line:
  "stallTimeoutMs": 90000,

# Configuration Fields table (~line 142) — add row after maxSessionBudget:
| `stallTimeoutMs`         | (Optional) Inactivity timeout in milliseconds for every external wait in the per-turn path (classifier stream, delegated model stream, auth fetch). Zero stream events for this long counts as a stall: the stalled model is cancelled and the next fallback model is tried. Default `90000`. |
```

#### 6. extensions/config.test.ts:271
**File**: extensions/config.test.ts
**Changes**: MODIFY — new tests in `normalizeConfig` describe (absent → 90000, invalid → 90000) and a merge-line detector in `loadRouterConfig` (valid value 30000 survives the merge; absent and invalid both converge on 90000 so the detector must use a valid value)

```ts
// vi.mock('node:fs') readFileSync — GLOBAL fixture branch gains stallTimeoutMs:
      return JSON.stringify({
        debug: true,
        stallTimeoutMs: 30000,
        profiles: {
          globalProfile: {
            medium: { model: 'openai/gpt-4o' },
          },
        },
      });

// describe('normalizeConfig') — add after the existing
// 'should normalize rules, profiles, phaseBias, budget, classifierModel' test:
    it('should default stallTimeoutMs to 90000 when absent', () => {
      const { config } = normalizeConfig({ profiles: {} } as RouterConfig);
      expect(config.stallTimeoutMs).toBe(90000);
    });

    it('should normalize invalid stallTimeoutMs to 90000', () => {
      const { config } = normalizeConfig({
        stallTimeoutMs: -5,
        profiles: {},
      } as unknown as RouterConfig);
      expect(config.stallTimeoutMs).toBe(90000);
    });

    it('should keep a valid stallTimeoutMs', () => {
      const { config } = normalizeConfig({
        stallTimeoutMs: 30000,
        profiles: {},
      } as RouterConfig);
      expect(config.stallTimeoutMs).toBe(30000);
    });

// describe('loadRouterConfig') — add after the existing merge test:
    it('should carry stallTimeoutMs through the merge whitelist', () => {
      const { config } = loadRouterConfig('/path/exists');
      expect(config.stallTimeoutMs).toBe(30000);
    });
```

### Success Criteria:

#### Automated Verification:
- [x] Config tests pass: `npx vitest run extensions/config.test.ts`
- [x] Full type check passes: `npm run tsc`
- [x] Merge-whitelist detector passes: `npx vitest run extensions/config.test.ts -t "merge whitelist"`
- [x] Knob flow present: `grep -c "stallTimeoutMs" extensions/config.ts` returns >= 3
- [x] Full suite green: `npx vitest run`

#### Manual Verification:
- [ ] `model-router.example.json` parses as valid JSON; the new key sits directly after `maxSessionBudget`
- [ ] README Configuration Fields table renders the `stallTimeoutMs` row after `maxSessionBudget`

## Phase 2: Watchdog helper in routing.ts

### Overview
The shared inactivity-watchdog primitives, hosted in routing.ts. Depends on nothing; can run in parallel with Phase 1 and Phase 3.

### Changes Required:

#### 1. extensions/routing.ts:698
**File**: extensions/routing.ts
**Changes**: MODIFY — add before `runClassifier`: `createStallTimeoutError`, `isStallTimeoutError`, `raceStallTimeout` (single-await race: timer + abort vs promise, no unhandled rejections), `stallGuardedStream` (per-event-reset async-generator wrapper with `onStall` callback)

```ts
/**
 * Stall-watchdog primitives shared by the provider turn loop (delegated
 * stream + auth) and runClassifier (classifier stream + auth).
 *
 * A wait counts as stalled when no progress arrives within `timeoutMs`.
 * Stalls throw a StallTimeoutError-named error so the existing
 * exception-driven fallback chains advance; aborts throw AbortError-named
 * errors so benign-abort classification stays intact.
 */
export const createStallTimeoutError = (
  timeoutMs: number,
  what: string,
): Error => {
  const error = new Error(
    `${what} stalled after ${timeoutMs}ms with no progress`,
  );
  error.name = 'StallTimeoutError';
  return error;
};

export const isStallTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'StallTimeoutError';

/**
 * Race `promise` against an inactivity timer and an abort signal.
 * Losing branches clear the timer and detach the listener, so an
 * abandoned promise never produces an unhandled rejection (safe for
 * total functions like ModelRegistry.getApiKeyAndHeaders).
 */
export const raceStallTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  what = 'Operation',
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(createStallTimeoutError(timeoutMs, what));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (reason) => {
        cleanup();
        reject(reason);
      },
    );
  });
};

/**
 * Wrap an async iterable with a per-event inactivity watchdog.
 * Every yielded event resets the timer; silence for `timeoutMs` invokes
 * `onStall` (cancel the underlying transport) and then throws
 * StallTimeoutError. Abort of `signal` throws an AbortError-named error.
 */
export const stallGuardedStream = async function* <T>(
  stream: AsyncIterable<T>,
  timeoutMs: number,
  onStall?: () => void,
  signal?: AbortSignal,
  what = 'Stream',
): AsyncGenerator<T> => {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    let result: IteratorResult<T>;
    try {
      result = await raceStallTimeout(
        iterator.next(),
        timeoutMs,
        signal,
        what,
      );
    } catch (error) {
      if (isStallTimeoutError(error)) onStall?.();
      throw error;
    }
    if (result.done) return result.value;
    yield result.value;
  }
};
```

#### 2. extensions/routing.test.ts:1043
**File**: extensions/routing.test.ts
**Changes**: MODIFY — new `describe('watchdog helpers')`: fast promise resolves; silence rejects `StallTimeoutError`; multi-event stream passes with per-event reset; pre-aborted signal rejects `AbortError`-named error; `onStall` invoked before throw

```ts
// (a) import block — add to the './routing' import list:
  raceStallTimeout,
  stallGuardedStream,

// (b) new describe INSIDE describe('routing.ts'), placed after the
// runClassifier describe closes (~line 1043):
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
```

### Success Criteria:

#### Automated Verification:
- [x] Watchdog unit tests pass: `npx vitest run extensions/routing.test.ts -t "watchdog helpers"`
- [x] Existing classifier suite unregressed: `npx vitest run extensions/routing.test.ts`
- [x] Type check passes: `npm run tsc`
- [x] Both helper exports present: `grep -cE "export const (raceStallTimeout|stallGuardedStream)" extensions/routing.ts` returns exactly 2
- [x] No fake timers introduced: `grep -rn "useFakeTimers" extensions/ | wc -l` returns 0
- [x] Full suite green: `npx vitest run`

#### Manual Verification:
- [x] No unhandled-rejection warnings in vitest output for the watchdog tests (abandoned never-yielding promises stay silent)

## Phase 3: Aborted terminal-event contract

### Overview
Every quiet exit ends with a builtin-provider-shaped aborted terminal event instead of bare `end()`, so pi's agent loop always resolves. Depends on nothing; can run in parallel with Phases 1-2.

### Changes Required:

#### 1. extensions/provider.ts:51
**File**: extensions/provider.ts
**Changes**: MODIFY — add `createAbortedMessage(model)` beside `createErrorMessage` (`stopReason: 'aborted'`, no `errorMessage`); add `pushAbortedEnd(stream, model)` helper (push `{type:'error', reason:'aborted', error}` then `end()`); replace the three bare `stream.end(); return;` choke sites (`:354-357`, `:545-548`, `:576-579`) and the benign-abort/stale-ctx suppression in the outer catch (`:770-786`) with the helper

```ts
// (a) beside createErrorMessage (~:51) — mirrors it exactly, stopReason 'aborted', no errorMessage:
export const createAbortedMessage = (model: Model<Api>): AssistantMessage => {
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

// (b) module helper after createAbortedMessage:
const pushAbortedEnd = (
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): void => {
  // Push BEFORE end(): a done/error event — not a bare end() — is what
  // resolves pi's response.result() (event-stream.js isComplete). Bare
  // end() parks agent-loop.js:238 forever ("Working..." wedge).
  stream.push({
    type: 'error',
    reason: 'aborted',
    error: createAbortedMessage(model),
  });
  stream.end();
};

// (c) THREE choke sites — post-classifier (:354), loop-top (:545),
// post-auth (:576). Indentation varies per site; each
// `stream.end(); return;` becomes:
            pushAbortedEnd(stream, model);
            return;

// (d) outer catch (:770-786) — real-error branch keeps its end() inside the if;
// suppression branch becomes the aborted terminal event:
          if (!isStaleCtx && !isAborted) {
            stream.push({
              type: 'error',
              reason: 'error',
              error: createErrorMessage(
                model,
                error instanceof Error ? error.message : String(error),
              ),
            });
            stream.end();
          } else {
            // Stale ctx / user abort: end with the builtin-shaped aborted
            // terminal event. Harmless on the stale-ctx path (session
            // discarded); mandatory on the user-abort path (pi wedges on a
            // bare end()).
            pushAbortedEnd(stream, model);
          }

// UNCHANGED (both already resolve result()): registry-guard early return
// (:297-308 — pushes a REAL error event before its bare end()) and the
// success path (:694 forwards the delegated done event, then bare end() :765).
```

#### 2. extensions/provider.test.ts:1011
**Changes**: MODIFY — the SIX quiet-exit tests ('mid-turn replacement' :1053, 'only the abort signal fires' :1096, 'auth await death' :1134, 'stale-ctx benign' :1138/:1155 — renamed ': aborted terminal event', 'classifier await death' :1271, 'pi abort benign' :1294 — renamed likewise) now assert the aborted terminal event instead of "no error event". Title-anchored — do NOT line-anchored-apply: :1188 is inside the UNTOUCHED reload-case test. Unchanged: negative control (reason 'error') and reload case (success → done event).

```ts
// In SIX tests (title-anchored — see the Changes line above), replace:
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
// with:
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(terminalEvent.error.stopReason).toBe('aborted');

// The two renamed tests:
//   'should classify a stale-ctx throw as benign: no error event, still persists'
//     → 'should classify a stale-ctx throw as benign: aborted terminal event, still persists'
//   'should classify pi abort (AbortError) as benign: no error event'
//     → 'should classify pi abort (AbortError) as benign: aborted terminal event'
//
// UNCHANGED — do not touch:
//   'should still surface a non-matching live error (negative control)'
//     (real error still pushes reason: 'error'; assertion at :1176 stands)
//   'should keep gated ctx reads and still record the decision when a killed
//    stream completes (reload case)' (~:1188, assertion :1224)
//     (success path: delegated done event resolves result(); no aborted event)
```

### Success Criteria:

#### Automated Verification:
- [x] Provider suite passes with updated expectations: `npx vitest run extensions/provider.test.ts`
- [x] Full type check passes: `npm run tsc`
- [x] Helper wired at all exits: `grep -c "pushAbortedEnd" extensions/provider.ts` returns >= 5 (1 definition + 4 call sites)
- [x] Bare end() only on already-resolving paths: `grep -c "stream.end()" extensions/provider.ts` returns exactly 4 (registry guard :306, success path :765, real-error branch of the catch, pushAbortedEnd internal)
- [x] Full suite green: `npx vitest run`
#### Manual Verification:
- [ ] Terminal-event shape parity with builtins: `grep -n "reason: output.stopReason" node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
- [ ] Esc mid-router-stream in a live pi session: UI shows "Operation aborted"; the next prompt works (no "Agent is already processing" wedge)

## Phase 4: Delegated wait sites

### Overview
Watchdog wiring for the delegated auth fetch and delegated stream in provider.ts: stall → existing fallback advance + warning note; abort → aborted terminal exit. Depends on Phases 1-3 (config knob, helpers, aborted-end shape).

### Changes Required:

#### 1. extensions/provider.ts:341
**File**: extensions/provider.ts
**Changes**: MODIFY — per-turn `stallTimeoutMs` read near the classifier gate; race the auth await at `:569-572` (stall → `lastError` + warning note + `continue`; abort → `pushAbortedEnd` + return); per-candidate `AbortController` + `combineAbortSignals` into `delegationOptions` with `cleanup` in a per-candidate `finally`; `stallGuardedStream` around the delegated stream with `onStall` aborting the controller; collect stall labels and append `[stall fallbacks: ...]` to `decision.reasoning` on the success path

```ts
// (a) imports — add to existing blocks:
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STALL_TIMEOUT_MS } from './constants';
  // './routing' import block gains:
  raceStallTimeout,
  stallGuardedStream,
  isStallTimeoutError,

// (b) per-turn reads + note helper, right before the `// Pre-decision:` comment:
          const stallTimeoutMs =
            state.currentConfig.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

          const notifyStall = (message: string) => {
            if (state.lastExtensionContext && !state.isExtensionContextDead) {
              state.lastExtensionContext.ui.notify(
                `router: ${message} — trying next`,
                'warning',
              );
            }
          };

// (c) near `let lastError: unknown;`:
          const stallFallbacks: string[] = [];

// (d) auth race — REPLACES the bare `const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);`:
              const authResult = await raceStallTimeout(
                modelRegistry.getApiKeyAndHeaders(targetModel),
                stallTimeoutMs,
                options?.signal,
                `auth for ${modelRef}`,
              ).then(
                (value) => ({ ok: true as const, value }),
                (reason) => ({ ok: false as const, reason }),
              );
              if (!authResult.ok) {
                lastError = authResult.reason;
                if (isStallTimeoutError(authResult.reason)) {
                  stallFallbacks.push(authResult.reason.message);
                  notifyStall(authResult.reason.message);
                }
                continue;
                // abort: next loop-top choke (Phase 3) does pushAbortedEnd + return;
                // as-last-candidate: throw lastError → outer catch isAborted → pushAbortedEnd
              }
              const auth = authResult.value;

// (e) per-candidate kill switch — top of the per-candidate try, before the destructure:
// (e) per-candidate kill switch — immediately BEFORE the per-candidate try
// (declarations must be visible to the sibling finally in (h)):
                // On stall we abort this controller to error the in-flight
                // SSE read. Compose the run signal + kill switch manually —
                // pi-ai ships combineAbortSignals in dist/utils but does NOT
                // re-export it (blocked by the package exports map).
                const candidateAbort = new AbortController();
                const runSignal = options?.signal;
                const propagateAbort = () =
                  candidateAbort.abort(runSignal?.reason);
                if (runSignal?.aborted) {
                  candidateAbort.abort();
                } else if (runSignal) {
                  runSignal.addEventListener('abort', propagateAbort, {
                    once: true,
                  });
                }

// (f) BOTH delegation branches (runtime + compat) gain, AFTER their `...delegationOptions` spread:
                        signal: candidateAbort.signal,

// (g) delegated stream guard — the bare `for await (const event of delegatedStream) {` becomes:
                for await (const event of stallGuardedStream(
                  delegatedStream,
                  stallTimeoutMs,
                  () => candidateAbort.abort(),
                  candidateAbort.signal,
                  modelRef,
                )) {

// (h) catch + finally:
              } catch (err) {
                lastError = err;
                if (isStallTimeoutError(err)) {
                  stallFallbacks.push(err.message);
                  notifyStall(err.message);
                }
              } finally {
                runSignal?.removeEventListener('abort', propagateAbort);
              }

// (i) reasoning enrichment — immediately before `break outer;`:
                if (stallFallbacks.length > 0) {
                  decision.reasoning =
                    `Recovered from ${stallFallbacks.length} stall(s): ${stallFallbacks.join('; ')}. ` +
                    `(Original: ${decision.reasoning})`;
                }
                break outer;
```

#### 2. extensions/provider.test.ts:1276
**File**: extensions/provider.test.ts
**Changes**: MODIFY — new tests: never-yielding delegated stream falls back at injected `stallTimeoutMs` (fallback streams, `isFallback` true, warning note pushed, reasoning contains stall); never-resolving `getApiKeyAndHeaders` → next candidate; abort during a stalled stream → aborted terminal event, no fallback retry (discriminated from the stall test by the AbortController)

```ts
// THREE new tests appended after the 'should classify pi abort (AbortError)...' test
// (same nesting). All three begin with:
      mockState.lastExtensionContext.ui.notify = vi.fn();

    it('should fall back when the delegated stream stalls silently', async () => {
      mockState.currentConfig.stallTimeoutMs = 20;

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        if (model.id === 'gpt-4o-mini') {
          // Primary streams nothing — pure silence.
          return (async function* () {
            await new Promise<void>(() => {});
          })() as any;
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      expect(attempts).toEqual(['gpt-4o-mini', 'gemini-1.5-flash']);
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockState.lastDecision.reasoning).toContain('stalled');
      expect(mockState.lastExtensionContext.ui.notify).toHaveBeenCalled();
    });

    it('should fall back when the auth fetch stalls', async () => {
      mockState.currentConfig.stallTimeoutMs = 20;
      let authCalls = 0;
      mockState.currentModelRegistry.getApiKeyAndHeaders = async () => {
        authCalls++;
        if (authCalls === 1) {
          // First candidate's auth hangs — never resolves, never rejects.
          await new Promise<void>(() => {});
        }
        return { ok: true, apiKey: 'key', headers: {} };
      };
      // NO AbortController — an aborted signal would take the silent-exit
      // branch instead of fallback (discriminator).

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'fallback answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.001 } } },
          };
        })() as any,
      );

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      expect(authCalls).toBeGreaterThanOrEqual(2);
      expect(mockState.lastDecision.isFallback).toBe(true);
      expect(mockState.lastExtensionContext.ui.notify).toHaveBeenCalled();
    });

    it('should abort (not fall back) when the signal fires during a stalled stream', async () => {
      const controller = new AbortController();

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      mockState.lastExtensionContext.ui.notify = vi.fn();
      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'partial' };
          await new Promise<void>(() => {}); // silence
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);
      controller.abort();
      await sleep(100);

      expect(attempts).toEqual(['gpt-4o-mini']);
      const terminalEvent = stream.events.find((e: any) => e.type === 'error');
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent.reason).toBe('aborted');
      expect(mockState.lastExtensionContext.ui.notify).not.toHaveBeenCalled();
    });
```

### Success Criteria:

#### Automated Verification:
- [x] Stall tests pass: `npx vitest run extensions/provider.test.ts -t "stall"`
- [x] Full provider suite: `npx vitest run extensions/provider.test.ts`
- [x] Type check: `npm run tsc`
- [x] Kill switch wired: `grep -c "candidateAbort" extensions/provider.ts` returns >= 5
- [x] Full suite green: `npx vitest run`

#### Manual Verification:
- [ ] Live: point a profile at a stalling endpoint (accept-and-never-respond listener) — the turn falls back within `stallTimeoutMs` with a warning line; Esc during the stall aborts immediately
- [ ] No unhandled-rejection warnings in `npx vitest run extensions/provider.test.ts` output (the never-resolving auth-stall promise stays silent)

## Phase 5: Classifier threading

### Overview
Signal + timeout + onStall threaded into `runClassifier`; classifier auth and stream guarded; provider call site wired. Terminal phase — carries the full-suite baseline checks. Depends on Phases 1-3; the provider call site sits on Phase 3's choke shape and reuses Phase 4's note pattern.

### Changes Required:

#### 1. extensions/routing.ts:698
**File**: extensions/routing.ts
**Changes**: MODIFY — `runClassifier` gains trailing optional `signal?: AbortSignal`, `stallTimeoutMs?: number`, `onStall?: (ref: string, ms: number) => void`; loop-top abort check (`if (signal?.aborted) return undefined;`); auth await raced via `raceStallTimeout`; per-ref `AbortController` (run-abort propagation + stall kill) whose signal feeds the classifier `streamSimple` call; `for await` wrapped in `stallGuardedStream` whose onStall aborts the controller — the caller's `onStall` callback (warning note) fires from the per-ref catch

```ts
// (a) add import:
import { DEFAULT_STALL_TIMEOUT_MS } from './constants';

// (b) runClassifier signature + loop-top abort (replaces :698-706):
export const runClassifier = async (
  refs: string[],
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  hasImage?: boolean,
  signal?: AbortSignal,
  stallTimeoutMs?: number,
  onStall?: (ref: string, ms: number) => void,
): Promise<ClassifierResult | undefined> => {
  const timeoutMs = stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  for (const ref of refs) {
    if (signal?.aborted) {
      return undefined;
    }

// (c) auth await raced — replaces the bare `const auth = await modelRegistry.getApiKeyAndHeaders(model);`:
      const auth = await raceStallTimeout(
        modelRegistry.getApiKeyAndHeaders(model),
        timeoutMs,
        signal,
        `classifier auth for ${ref}`,
      );

// (d) per-ref kill switch + classifier stream open; for-await wrapped
// (a stall aborts the controller, killing the in-flight classifier request —
// same manual composition as the delegated path; notify stays in the catch):
      const refAbort = new AbortController();
      const propagateRefAbort = () => refAbort.abort(signal?.reason);
      if (signal?.aborted) {
        refAbort.abort();
      } else if (signal) {
        signal.addEventListener('abort', propagateRefAbort, { once: true });
      }
      const stream = streamSimple(model, classifierContext, {
        apiKey,
        headers,
        signal: refAbort.signal,
        ...(reasoningOption ? { reasoning: reasoningOption } : {}),
      });
      let fullText = '';
      let contentReceived = false;
      for await (const event of stallGuardedStream(
        stream,
        timeoutMs,
        () => refAbort.abort(),
        refAbort.signal,
        `classifier ${ref}`,
      )) {

// (e) per-ref catch extended + run-listener cleanup (was `void error;` only):
    } catch (error) {
      // Infra failure (invalid ref / auth reject / stall / stream threw) —
      // try next ref. Stall additionally notifies via the caller's callback.
      if (isStallTimeoutError(error)) {
        onStall?.(ref, timeoutMs);
      }
      void error;
    } finally {
      signal?.removeEventListener('abort', propagateRefAbort);
    }
```

#### 2. extensions/provider.ts:341
**File**: extensions/provider.ts
**Changes**: MODIFY — the `runClassifier` call passes `options?.signal`, the per-turn `stallTimeoutMs`, and an `onStall` callback that pushes the classifier warning note (gated on `state.lastExtensionContext && !state.isExtensionContextDead`)

```ts
// the runClassifier call (:341-348) — three trailing args added:
            classifierResult = await runClassifier(
              classifierRefs,
              modelRegistry,
              context,
              state.lastDecision?.phase,
              state.currentConfig.classifierModel.thinking,
              hasImageAttachment(context), // pass image-present flag
              options?.signal,
              stallTimeoutMs,
              (ref, ms) => {
                notifyStall(`classifier ${ref} stalled after ${ms}ms`);
              },
            );
```

#### 3. extensions/routing.test.ts:998
**File**: extensions/routing.test.ts
**Changes**: MODIFY — new tests: classifier stream stall → next ref succeeds; all refs stall → `undefined`; pre-aborted signal → immediate `undefined` with no stream open

```ts
// three tests INSIDE the runClassifier describe (after 'does NOT retry after
// content received'; arg positions 7/8/9 are signal/stallTimeoutMs/onStall):
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
```

#### 4. extensions/provider.test.ts:1231
**File**: extensions/provider.test.ts
**Changes**: MODIFY — provider-level test: classifier stalls (refs disjoint from tier candidates) → heuristic routing, turn completes, no error event, stall note observed on the ctx UI mock

```ts
// one test appended after the Phase-4 tests (same nesting; `sleep` is in scope
// there — provider.test.ts:1003). No pin: pinning skips the classifier
// (provider.ts:336) and this test must exercise it.
    it('should degrade to heuristics when the classifier stalls', async () => {
      mockState.currentConfig.classifierModel = {
        model: 'openai/classifier-only',
        fallbacks: [],
      };
      mockState.currentConfig.stallTimeoutMs = 20;

      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      mockState.lastExtensionContext.ui.notify = vi.fn();

      const delegated: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        if (model.id === 'classifier-only') {
          return (async function* () {
            await new Promise<void>(() => {}); // classifier stall
          })() as any;
        }
        delegated.push(model.id);
        return (async function* () {
          yield { type: 'text_delta', delta: 'heuristic answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0005 } } },
          };
        })() as any;
      }) as any);

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(150);

      // classifier stalled → undefined → heuristics ('hello' → low tier →
      // falls up to medium — no low tier in the mock config) → delegated stream
      expect(delegated).toEqual(['gpt-4o-mini']);
      expect(stream.events.find((e: any) => e.type === 'error')).toBeUndefined();
      expect(
        mockState.lastExtensionContext.ui.notify,
      ).toHaveBeenCalledWith(
        expect.stringContaining('classifier'),
        'warning',
      );
      expect(mockActions.persistState).toHaveBeenCalled();
    });
```

### Success Criteria:

#### Automated Verification:
- [x] Stall tests pass: `npx vitest run extensions/routing.test.ts extensions/provider.test.ts -t "stall"`
- [x] Full suite green: `npx vitest run`
- [x] Type check: `npm run tsc`
- [x] Build: `npm run build`

#### Manual Verification:
- [ ] Esc during a classifier stall aborts immediately (no wedge, no `/quit`)
- [ ] After a stall fallback, `/router status` Reason shows the stall recovery text

## Ordering Constraints

- Phase 1 (config), Phase 2 (helpers), Phase 3 (terminal event) are mutually independent — any order, parallelizable.
- Phase 4 requires 1 (reads `stallTimeoutMs`), 2 (imports the helpers), 3 (aborted-end shape for the auth-abort leg).
- Phase 5 requires 1, 2, 3 (call site sits on the `:354` choke shape); its note callback reuses Phase 4's note pattern but is independent of Phase 4's code.
- Within each phase, file changes are one atomic change set applied on top of the previous phases.

## Verification Notes

- **Merge whitelist trap**: a missing `mergeConfig` line silently kills the knob on every load path (`config.ts:134-145`). The only test that can catch it is a valid value (e.g. 30000) asserted through `loadRouterConfig` — absent and invalid both normalize to 90000, so an invalid-value end-to-end test cannot detect the missing line.
- **Push-before-end**: `EventStream.push()` no-ops after `end()` (`event-stream.js:16-18`) — every aborted exit must push the terminal event first, then end.
- **Unhandled rejections**: abandoned auth promises must stay pending-and-resolving (total function); gate promises in tests get `resolve()` only, never `reject()`; timers must be cleared on every race exit.
- **Timing**: real timers everywhere; injected `stallTimeoutMs` of 15-25 ms into `mockState.currentConfig`; sleeps ≥ 5× the timeout (flake lesson from dead-flag validation). No `vi.useFakeTimers` (zero usage in the suite; it would break the file-wide sleep idiom).
- **Pin discipline**: pinning skips the classifier (`provider.ts:336`) — classifier tests must NOT pin; stream/auth stall tests pin medium (default mock config has no `low` tier).
- **Abort vs stall discrimination**: the auth-stall test must use NO AbortController (an aborted signal takes the silent-exit branch instead of fallback); the abort test uses the controller + gate idiom (`provider.test.ts:1058-1099`).
- **Mock role split**: `MockEventStream` mocks only the outer router stream; classifier + delegated streams come from the mocked compat `streamSimple` — a "fake stream that emits no events" is a never-yielding async generator from that mock.
- **Classifier refs disjoint from tier candidates** in the provider-level classifier test (single compat mock cannot otherwise tell classifier calls from delegation calls).
- **Total-failure provenance**: `recordDebugDecision` runs only on success — the detection-time warning note is the only provenance on total failure; never debug-gate it.
- Baseline: `npm run tsc` and `npx vitest run` green before and after each phase.

## Performance Considerations

- Zero added latency on healthy streams: one `setTimeout`/`clearTimeout` pair per yielded event — sub-microsecond timer churn, no extra network calls.
- Abandoned auth promises resolve harmlessly in the background (total function, no rejection) — bounded memory, no leak path.
- `combineAbortSignals` with a single live signal returns that signal directly with a no-op cleanup (verified `abort-signals.js`) — no listener overhead on the common one-signal path; the per-candidate listener set is torn down in `finally`.
- The per-turn config read is a property access on a live getter — no allocation beyond the race promises.

## Migration Notes

No persisted-schema change. `stallTimeoutMs` is optional; existing configs behave identically (absent → 90000 everywhere after normalization). No rollback strategy needed beyond reverting the change set.

## Pattern References

- `extensions/provider.ts:717-733` — in-tier fallback mutation block; a stall-triggered advance rides it unchanged (`isFallback`, label rewrite, reasoning wrap).
- `extensions/provider.ts:49-51, 770-786` — error classification + benign suppression idiom; the aborted terminal event replaces the suppression's bare `end()`.
- `extensions/routing.ts:777-780` — per-ref catch advance (`void error`) that the classifier stall inherits.
- `extensions/config.ts:141, 421-424` — merge line + scalar normalize gate precedents (`maxSessionBudget`).
- `extensions/index.ts:151-155` — `ui.notify` mid-turn precedent (source-label chain).
- `extensions/provider.ts:616-627` — direct `state.lastExtensionContext.ui` access precedent, gated on the dead flag.
- `extensions/provider.test.ts:1058-1099` — AbortController test idiom (controller passed via options, mid-stream abort, no-retry assertion). The deferred-gate idiom at `:1011-1049` is used by existing tests only; new stall tests deliberately use fixed sleeps instead.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:361-376` — the exact aborted terminal-event shape being mirrored.
- `node_modules/@earendil-works/pi-ai/dist/utils/abort-signals.js:1-33` — `combineAbortSignals` contract. SUPERSEDED at Phase 4 lock: unreachable through the pi-ai exports map (root does not re-export; no `./dist/*` subpath) — signals compose manually instead. Kept as the reference for WHAT the manual composition replicates (listener + once + cleanup semantics).

## Developer Context

**Inherited research checkpoint decisions** (research artifact Developer Context — never re-ask):
- Fix scope: all four defect-class parts (classifier hang, silent-stall→no-fallback, auth-fetch hang, Esc-cancels-everything).
- Stall timeout: 90 s, one config knob `stallTimeoutMs`.
- Stall visibility: one-line note in chat.
- Classifier stall: next ref → built-in rules.
- Desired outcome: "It never hangs, It recovers itself, Esc always works".
- Post-content stall: retry with the next model (partial superseded in place).
- Esc-aborted turns: push `stopReason:'aborted'` terminal event like builtin providers; fix the three quiet-exit choke points to the same shape.
- Stall note style: `'warning'` (info/showStatus dedups consecutive lines).

**This session's checkpoint (blueprint Step 4)**:
- Q (module split): "About to follow one-module-per-concern across new file extensions/watchdog.ts — confirm, or moving off?" → **Avoid new module** (developer). Promoted to genuine ambiguity on the cycle concern (provider↔routing), re-asked with alternatives in view: **Host in routing.ts** (developer) — one-way deps, `provider.ts:33-45` import precedent.
- Q (classifier stall note): "Should a classifier stall also push a user note, given existing classifier infra-failures are silent (`routing.ts:777-780`) but the cdcfe2eb lesson argues visibility?" → **Warning note too** (developer). Implemented as an `onStall` callback threaded from provider (routing.ts stays ctx-free).
- Design summary confirmed: Proceed.
- Decomposition (5 slices) confirmed: Approve.

## Plan History

- Phase 1: Config knob stallTimeoutMs — approved as generated
- Phase 2: Watchdog helper in routing.ts — approved as generated
- Phase 3: Aborted terminal-event contract — approved as generated (2 slice-verifier prose violations ratified: test citations title-anchored, end() count corrected to 4)
- Phase 4: Delegated wait sites — approved as generated (Decisions amended: combineAbortSignals unreachable via exports map → manual signal composition)
- Phase 5: Classifier threading — approved as generated

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| -------- | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| code     | Phase 4 fence, test C | provider.test.ts:1011-1013 | blocker | actionability | Test 'should abort (not fall back) when the signal fires during a stalled stream' references `stream.events` but never declares `stream` (no `new MockEventStream()` + no `mockReturnValue`) — TS2304, and runtime would throw | Add the two missing mock-setup lines | applied: stream declaration + mockReturnValue + notify mock added to test C |
| code     | Phase 4 fence, (e)+(h) | provider.ts:591 | blocker | code-quality | `candidateAbort`/`runSignal`/`propagateAbort` declared inside the per-candidate `try` but referenced in the sibling `finally` — not visible (TS2304) | Move the declarations before the `try` | applied: (e) placement comment now says immediately BEFORE the try; declarations visible to (h)'s finally |
| code     | Phase 5 fence, (d) | routing.ts:753-761 | concern | codebase-fit | Classifier stall never cancels the stalled stream: guard `onStall` undefined + no per-ref controller — the abandoned `streamSimple` request keeps streaming (connection + token burn); contradicts Phase 1 README text and the delegated path's cancel behavior | Add a per-ref controller aborted in the stall path | applied: per-ref refAbort controller (run-abort propagation + stall kill) feeds stream options and the guard; listener cleaned in the per-ref finally |
| coverage | Verification Notes, Baseline | <n/a> | concern | verification-coverage | Full `npx vitest run` only in Phase 5 SC; Phases 1-4 scoped suites let cross-file regressions hide; 'green before each phase' enforced by no bullet | Add `npx vitest run` to every phase's Automated Verification | applied: full-suite bullet added to Phases 1-4 Automated Verification |
| coverage | Verification Notes, Unhandled rejections | <n/a> | suggestion | verification-coverage | Gate discipline (resolve-only) has no visible mirror; unhandled-rejection watch scoped to watchdog tests only, not provider.test.ts where the never-resolving auth test lives | Watch provider.test.ts output too, or show gate code | applied: Phase 4 Manual gains a provider.test.ts unhandled-rejection watch bullet |
| coverage | Verification Notes, Timing | <n/a> | suggestion | verification-coverage | No SC pins the no-fake-timers / ≥5×-sleep discipline | Add a grep guard for `vi.useFakeTimers` absence | applied: Phase 2 Automated gains `grep -rn "useFakeTimers" extensions/ \| wc -l` returns 0 |
| coverage | Pattern References, abort-signals.js | <n/a> | suggestion | verification-coverage | Stale precedent: entry still cites the `combineAbortSignals` contract the plan history declares unreachable | Annotate or delete the entry | applied: entry annotated SUPERSEDED with the exports-map reason and kept as the semantic reference |
| coverage | Pattern References, provider.test.ts idioms | <n/a> | suggestion | verification-coverage | Deferred-gate idiom cited but mirrored by no new test (Phase 4-5 use sleep polling) | Drop the deferred-gate half or show gate code | applied: entry rewritten to AbortController-only with a note that deferred-gate stays an existing-test idiom |
| code     | Decisions, Helper home | provider.ts:32-43 | suggestion | accuracy | 'imports 12 symbols from routing.ts' — actual count is 9 | Correct the count | applied: corrected to 9 with the provider.ts:32-43 citation |
| code     | Phase 2 heading | routing.ts:698 | suggestion | accuracy | Insertion anchor `:695` off by 3 (runClassifier starts :698) | Fix to :698 | applied: heading now extensions/routing.ts:698 |
| code     | Phase 2 test heading | routing.test.ts:1043 | suggestion | accuracy | 'describe closes ~1048' off by ~5 (closes ~1043) | Fix to ~1043 | applied: heading now extensions/routing.test.ts:1043; fence comment ~1043 |
| code     | Phase 4 heading | provider.test.ts:1276 | suggestion | accuracy | Header anchor `:130` stale — tests actually append at :1276 | Fix to :1276 | applied: heading now extensions/provider.test.ts:1276 |
| code     | Desired End State | — | suggestion | accuracy | Mockup wording `⚠ glm-5.3 stalled (90s) — trying next model` diverges from implemented note copy `router: <what> stalled after 90000ms with no progress — trying next` | Align the mockup or the copy | applied: mockup aligned to the implemented note copy |
| code     | various | provider.ts:743/775/687 | suggestion | accuracy | Off-by-one line citations (`:742-744`→743-745, `:774-775`→775-776, `:688-692`→687-694); nothing applied line-anchored at these sites | Cosmetic; optional touch-up | applied: all three citations corrected in Current State + Decisions |

_Tally at triage: 2 blockers, 2 concerns, 10 suggestions._


## References

- Research: `.rpiv/artifacts/research/2026-09-07_11-07-29_router-stall-fallback-abort.md` (parent)
- FRD: `.rpiv/artifacts/discover/2026-09-07_10-47-10_router-stall-fallback-abort.md`
- Prior landed plan (HEAD): `.rpiv/artifacts/plans/2026-09-04_16-30-24_stale-ctx-dead-flag-gates.md` → commit `d793dbde`
- Hung session evidence: `pi-session-2026-09-07T03-22-05-586Z_*.html` (last entry toolResult 03:39:02, cwd `H:\tuntun\aop`)
