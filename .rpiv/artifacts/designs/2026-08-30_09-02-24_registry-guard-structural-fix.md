---
date: 2026-08-30T09:02:24+0700
author: Yogiswara Utama
commit: 4ae87431
branch: main
repository: pi-model-router
topic: "Router registry guard — structural fix at guard time (module fallback + turn_start capture + diagnostics)"
tags: [design, provider, ctx-lifecycle, registry-guard, regression-test]
status: in-progress
parent: .rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md
last_updated: 2026-08-30T09:02:24+0700
last_updated_by: Yogiswara Utama
---

# Design: Router Registry Guard — Structural Fix

## Summary

The guard at `extensions/provider.ts:290-303` fails intermittently because no pi event reliably precedes a custom provider's own `streamSimple`: `before_provider_request` fires only inside the delegated inner concrete-model request, so a closure whose session never delivered `session_start`/`turn_start`/`model_select`/`turn_end`/`thinking_level_select` reaches the guard with `currentModelRegistry === undefined`. The fix resolves the registry at guard time from a module-level fallback (`modelRegistryFallback`) that every `captureCtx` writes and that survives closure re-execution within the same module instance, writes the resolved registry back into closure state so all downstream consumers see it, adds `turn_start` as an additional capture anchor (emitted per-turn before each stream in every mode), and records diagnostics: deduped stderr on recovery, stderr plus a `router-diagnostic` session entry on failure. A deterministic regression test drives the real `ExtensionRunner` + `bindCore` flush + real compat api-map dispatch with `session_start` deliberately omitted.

## Requirements

- Eliminate the intermittent `Router provider has no model registry: no ctx was captured before this stream` error in every locally fixable window: a second in-process session built over the cached extension module (module fallback covers it), and normal turns after `/reload` or session replacement (`turn_start` captures before each turn's stream). Residual windows — a reload-aliased stream issued before `session_start`, partial factory load, a never-bound SDK host's first stream, and compaction/branch-summary as the first call of an uncaptured closure — remain fail-loud, now with a `router-diagnostic` entry (previously: silent recurring field error).
- Fix must be structural at guard time: resolve the registry from a source that does not depend on `before_provider_request` firing before the router's own `streamSimple` (it never does — research artifact Summary).
- All consumers of the registry inside the stream body (image-capability filter, `resolveContextWindow`, `modelRegistry.find`, `getApiKeyAndHeaders`) must see the resolved registry, not `undefined`.
- Diagnostics must record capture provenance so the field question "which window fired" (research Open Questions #3) is answerable: recovery path (fallback saved the stream) logs deduped stderr; failure path (registry still undefined) logs stderr and persists a `router-diagnostic` entry via `pi.appendEntry`.
- Deterministic regression test built on the real `ExtensionRunner`, `createExtensionRuntime`, real `ModelRegistry`, and real compat api-map dispatch — the test the architecture review mandated and was never written (`streamSimple` succeeds when `before_provider_request` fired but `session_start` did not).
- Correct the false anchor comments at `extensions/index.ts:521-529` and `extensions/provider.ts:283-289`.

## Current State Analysis

`captureCtx` (`extensions/index.ts:70-79`) is invoked by five event handlers (`before_provider_request`, `session_start`, `model_select`, `turn_end`, `thinking_level_select`) and writes three closure variables: `lastExtensionContext`, `currentModelRegistry`, `currentCwd`. The guard reads `state.currentModelRegistry` (live getter into the closure, `extensions/index.ts:297-302`) synchronously before the first `await`.

Pi internals (verified against installed `@earendil-works/pi-coding-agent`):

- A `router/*` request dispatches: `agent-loop` → sdk `streamFn` (`sdk.js:176-198`) → compat `streamSimple` (`compat.js:170-176`, `shouldUseBuiltinModels` false for `router/*`) → the router's registered `streamSimple` closure directly. No hook runs in between.
- `before_provider_request` is emitted from `onPayload` (`sdk.js:200-205`), which only builtin pi-ai API implementations call while building an HTTP payload. The router forwards `onPayload` into the delegated inner call (`extensions/provider.ts:597-628`), so the hook fires after the guard has run.
- The compat api map is process-global (`compat.js:62-71`); the last closure registered for `router-local-api` wins. `AgentSession.reload()` calls `resetApiProviders()` then re-registers the fresh closure (`agent-session.js:1949-1968`), and emits `session_start` only when `hasBindings` is true.
- Factory re-execution vs module identity: a second in-process session from fresh services (new `DefaultResourceLoader`, same cwd) hits the extension factory cache → NEW closure over the SAME module instance (`loader.js:105-118, 290-317, 339-354`). Session replacement (newSession/fork/resume) reuses the same services and extension objects — same closures, state persists. `/reload` is different: `resource-loader.js:218-221` calls `clearExtensionCache()` → generation bump → `jiti` re-evaluates the module with `moduleCache: false` (`loader.js:107-110, 301-303`) → fresh module instance, fallback lost. Coverage follows: module fallback = second-in-process-session window; `turn_start` = reload/replacement normal turns; everything else = diagnostics.
- `turn_start` is emitted through the extension runner with a fresh ctx at the start of every turn, before that turn's provider request, in every mode (`agent-session.js:367-374` → `runner.emit` → `createContext`). It fires even when `session_start` was never emitted.
- `ModelRegistry` holds no session reference and has no invalidation; a stale-but-present registry cannot produce the guard error (research "Ruled-out hypotheses").
- Subagents (pi-subagents) are child processes; the parent-TUI surface is explained by in-process factory re-execution windows (reload, session replacement, api-map aliasing), not by the children.

### Key Discoveries

- `extensions/provider.ts:290-303` — guard fires when the serving closure never captured; `captureCtx` can never unset the registry, so the error proves zero successful captures in that closure.
- `extensions/provider.ts:305+` — the stream body snapshots `state.currentModelRegistry!` once but also reads `state.currentModelRegistry?.find` in the image-promotion filter (~line 505-520) and passes `state.currentModelRegistry` to `resolveContextWindow` (~line 530) and the image-capable model filter (~line 610). A guard that recovers without write-back leaves these reads broken (image filtering would skip every model).
- `extensions/index.ts:297-302` — the state bag exposes `currentModelRegistry` as a getter only; write-back requires a setter.
- `node_modules/.../runner.js:184-203` — `bindCore` flushes `pendingProviderRegistrations` into `this.modelRegistry` and installs the closure into compat's process-global api map. This is the deterministic reproduction lever for the test.
- Package-root exports confirmed for the test: `ExtensionRunner`, `createExtensionRuntime`, `loadExtensionFromFactory`, `ModelRegistry`, `AuthStorage`, `createEventBus` (`dist/index.js`).
- `loadRouterConfig` (`extensions/config.ts:537-553`) reads `~/.pi/agent/model-router.json` (machine-dependent) — the regression test must mock `./config` exactly as `extensions/index.test.ts:3-44` does.
- Existing test `extensions/provider.test.ts:788-813` asserts the guard error text `'no model registry'` and no-persist on the failure path — message text must stay stable.

## Scope

### Building

- `extensions/provider.ts`: exported `modelRegistryFallback` holder; guard resolves `closure ?? fallback`, writes back into closure state; deduped stderr diagnostics on recovery; stderr + `pi.appendEntry('router-diagnostic', …)` on failure; corrected invariant comment.
- `extensions/types.ts`: `RouterDiagnosticEntry` interface (additive; failure-entry payload).
- `extensions/index.ts`: setter for `currentModelRegistry` in the provider state bag; `captureCtx` writes `modelRegistryFallback.current` (single getter read); both false-anchor comments corrected (captureCtx docstring, registration anchor); `turn_start` capture handler added in Slice 2.
- `extensions/provider.test.ts`: fallback-recovery test (closure undefined, fallback set → delegation proceeds); failure-path test unchanged and still green.
- `extensions/index.test.ts`: captureCtx-writes-fallback + no-poison-on-stale-ctx test (Slice 1); `turn_start` handler registration test (Slice 2).
- `extensions/registry-guard.test.ts` (NEW): deterministic regression test on the real `ExtensionRunner` + real compat dispatch — positive recovery scenario (factory re-execution, no events on the second closure) and negative control (zero events ever → guard error).

### Not Building

- Removal of the dead `runtime?.streamSimple` branch (`extensions/provider.ts:607-613`) — separate defect class (custom-api delegation), deferred.
- Dead-ctx crash hardening for `lastExtensionContext` consumers (`extensions/provider.ts:465-466, 587-594`) — torn-write defect, deferred.
- `captureCtx` in `commands.ts` handlers — harmless today.
- Upstream pi change (pre-dispatch hook for custom providers, or a ctx passed into provider `streamSimple`) — optional parallel action, not code in this repo.
- Any change to the user-facing guard error message text (tests pin `'no model registry'`).

## Decisions

### D1: Guard resolves registry from a module-level fallback, then writes back

**Ambiguity**: The capture contract cannot hold (no pi event precedes the router's own `streamSimple`). The registry must be resolved at guard time from a source independent of event delivery to the serving closure.

**Explored**:
- Option A: module-level `modelRegistryFallback` written by every `captureCtx` (any closure instance in the same module instance). Covers the second-in-process-session window: a new closure over the cached module (`loader.js:105-118, 339-354`) — fresh closure state, shared module state. `/reload` re-evaluates the module (`resource-loader.js:218-221` → `clearExtensionCache` → `loader.js:107-110`), so reload windows are covered by capture points (`turn_start`, Slice 2) instead; cross-cwd re-instantiation and pre-`session_start` reload-aliased streams are not covered (residual, diagnosable via `router-diagnostic`).
- Option B: synthesize a ctx delivery by calling `options.onPayload` at `streamSimple` entry. Rejected: double-emits `before_provider_request` (the delegated inner call forwards the same callback), feeds other extensions a synthetic payload — observable event-sequence corruption.
- Option C: thread a local registry through the stream body without write-back. Rejected: leaves `state.currentModelRegistry?.find` reads (image filter, `resolveContextWindow`) seeing `undefined` — image-attached streams would skip every model. Write-back fixes all consumers through the one place they route (the state bag), root-cause style.

**Decision**: Option A + write-back. `captureCtx` writes both closure state and `modelRegistryFallback.current`; the guard resolves `state.currentModelRegistry ?? modelRegistryFallback.current`, and on fallback recovery assigns the result back into `state.currentModelRegistry` (new setter). Evidence: `extensions/index.ts:70-79, 297-302`; `extensions/provider.ts:290-303`; verified module-cache semantics `loader.js:105-118, 290-317`; confirmed at checkpoint (directional confirm #1 — Follow).

### D2: `turn_start` added as a capture point

`turn_start` (`agent-session.js:367-374`) is emitted through the runner with a fresh ctx at the start of every turn, before that turn's provider request, in every mode — including tool-continuation turns (`before_agent_start` fires only per prompt). It fires even when `session_start` was skipped (reload-without-bindings), making the serving closure's own registry exact rather than relying on the fallback. Three lines beside the five existing capture sites, same pattern. Deferred consideration of `before_agent_start`: strictly weaker coverage, not added.

### D3: Diagnostics — stderr deduped on recovery, `router-diagnostic` entry + stderr on failure

Recovery (fallback saved the stream) is expected to be frequent in aliased windows: one deduped stderr line per module instance (boolean latch — reshape to a set when a second provenance exists; the latch is deliberately private, no test depends on stderr), nothing persisted (preserves L1-03 "no garbage entries on the guard path" for the common case). Failure (registry still undefined after fallback — the field bug class recurring) is rare and high-value: stderr line plus `pi.appendEntry('router-diagnostic', …)` with `{ provenance, pid, uptimeMs, argvFlags, detail }`. `argvFlags` filters `process.argv` to `-`-prefixed flags (truncated to 120 chars) so no user prompt text reaches stderr or the session file; mode is unknowable at guard time (no ctx), and pid + uptimeMs + argvFlags substitute for it. `pi` is in scope in `registerRouterProvider`; `appendEntry` works without a ctx. The entry type is additive; `router-state` consumers filter by `customType === 'router-state'` and are unaffected. Confirmed at checkpoint (directional confirm #3).

### D4: Guard error message text unchanged

`extensions/provider.test.ts:788-813` pins `'no model registry'`. The message still names a real defect class (zero captures ever in this module instance). Provenance detail lives in stderr + the diagnostic entry, not the user-facing message.

### D5: Regression test drives the real `ExtensionRunner` and real compat dispatch

The mandated repro is "factory → `bindCore` flush → first `streamSimple` with `session_start` omitted". Build it from package-root exports: `createExtensionRuntime` + `loadExtensionFromFactory(routerExtension, …)` + `new ExtensionRunner([ext], runtime, cwd, smStub, registry)` + `runner.bindCore(actionsStub, contextActionsStub)` (flush) + real compat `streamSimple` dispatch. Mock only `./config` (machine-dependent global config file; same mock shape as `extensions/index.test.ts:3-44`). Success path registers a fake provider (`registry.registerProvider`) whose `streamSimple` stub yields `text_delta` + `done`, so the assertion is end-to-end: the delegated content arrives and no error event is pushed. Negative control runs first (module fallback still undefined → guard error fires), documenting the residual window.

### D6: Tight scope (deferred secondary defects)

Dead `runtime?.streamSimple` branch removal, dead-ctx hardening for `lastExtensionContext` consumers, `commands.ts` capture, upstream pi issue — all deferred. Confirmed at checkpoint (directional confirm #2).

## Architecture

### extensions/provider.ts — MODIFY

One-line purpose: module fallback holder + self-healing guard + diagnostics.

```typescript
// === Import change ===
// `RouterDiagnosticEntry` added to the existing `import type { ... } from './types'` block.

// === Module-level additions (directly after the imports, before createErrorMessage) ===
// Module-level fallback registry. Pi caches the extension module per cwd
// (loader.js extensionCache): a second session created in this process from
// fresh services reuses the cached factory, producing a NEW closure over the
// SAME module instance — that closure can reach streamSimple with no captured
// registry, and this fallback covers it. /reload re-evaluates the module
// (resource-loader clearExtensionCache), so reload windows are covered by
// capture points (turn_start/session_start) instead; whatever remains is
// diagnosable via the guard diagnostic.
export const modelRegistryFallback: {
  current: ExtensionContext['modelRegistry'] | undefined;
} = { current: undefined };

const moduleLoadTimeMs = Date.now();

// Guard diagnostics: recovery (module fallback saved the stream) logs one
// deduped stderr line per module instance — frequent in aliased-closure
// windows, and the field signal that identifies which window fired. Failure
// (no capture anywhere in this module instance) also persists a
// `router-diagnostic` session entry via pi.appendEntry, which works without
// an extension ctx. Window discrimination at failure time: pid (parent vs
// child process), uptimeMs (near-zero = first-call window; large =
// partial-load), argvFlags (TUI vs print-mode flags — flags only, so no user
// prompt text is persisted; mode itself is unknowable without an extension
// ctx). (Architecture review L0-01.)
const loggedGuardRecovery = { moduleFallback: false };
const logGuardRecovery = () => {
  if (loggedGuardRecovery.moduleFallback) return;
  loggedGuardRecovery.moduleFallback = true;
  console.error(
    `[pi-model-router] registry guard: recovered via module fallback ` +
      `(pid=${process.pid}, uptimeMs=${Date.now() - moduleLoadTimeMs}). ` +
      `The serving closure never received an extension event; ` +
      `a prior closure's capture supplied the registry.`,
  );
};
const logGuardFailure = (pi: ExtensionAPI, detail: string) => {
  const diagnostic: RouterDiagnosticEntry = {
    type: 'registry-guard',
    provenance: 'none',
    pid: process.pid,
    uptimeMs: Date.now() - moduleLoadTimeMs,
    argvFlags: process.argv
      .slice(2)
      .filter((arg) => arg.startsWith('-'))
      .join(' ')
      .slice(0, 120),
    detail,
  };
  console.error(
    `[pi-model-router] registry guard FAILED: no closure capture and no ` +
      `module fallback (pid=${diagnostic.pid}, uptimeMs=${diagnostic.uptimeMs}, ` +
      `argvFlags=${diagnostic.argvFlags}, ${diagnostic.detail})`,
  );
  try {
    pi.appendEntry('router-diagnostic', diagnostic);
  } catch {
    // ponytail: appendEntry unavailable (pre-bind runtime) — stderr is the trace.
  }
};

// === registerRouterProvider: state param type ===
// `readonly currentModelRegistry: ... | undefined;` → `currentModelRegistry:
// ... | undefined;` (writable — the guard writes back through the state bag).

// === Guard (replaces the invariant-guard comment at :284-289 and the if-block at :290-301) ===
      // Registry guard. No pi event is guaranteed to precede a custom
      // provider's own streamSimple: before_provider_request fires from
      // onPayload inside the delegated inner request (after this guard), and
      // session_start is delivered by bindExtensions or a bindings-present
      // reload — paths that skip or delay both leave the closure uncaptured.
      // Resolution order: this closure's capture, else the module fallback
      // (written by any closure's captureCtx — survives closure re-execution
      // on the cached module), written back so every later consumer in this
      // stream (image filters, resolveContextWindow, find/auth) sees it.
      // Both undefined = no capture ever happened in this module instance —
      // fail loudly WITHOUT persisting state (nothing meaningful exists to
      // persist) and record a `router-diagnostic` entry. (L1-01/L1-03/L0-01.)
      if (!state.currentModelRegistry && !modelRegistryFallback.current) {
        logGuardFailure(pi, `api=${model.api} profile=${model.id}`);
        stream.push({
          type: 'error',
          reason: 'error',
          error: createErrorMessage(
            model,
            'Router provider has no model registry: no ctx was captured before this stream. This is a router extension bug — please report it.',
          ),
        });
        stream.end();
        return stream;
      }
      if (!state.currentModelRegistry) {
        state.currentModelRegistry = modelRegistryFallback.current;
        logGuardRecovery();
      }
// Everything after is unchanged; the IIFE's `const modelRegistry =
// state.currentModelRegistry!;` snapshot now sees the healed value.
```

### extensions/index.ts — MODIFY

One-line purpose: state-bag setter, captureCtx writes fallback, `turn_start` capture, corrected comments.

```typescript
// === Import change ===
import { registerRouterProvider, modelRegistryFallback } from './provider';

// === captureCtx (docstring at :61-69 replaced together with the body) ===
// Refresh the long-lived runtime captures (registry, cwd, last ctx) from
// the delivered ExtensionContext. A delivered ctx goes stale after any
// session replacement (pi invalidates captured runners on newSession /
// fork / switchSession / reload), so this must run on EVERY event, above
// any behavioral early-return gates. No pi event is guaranteed to precede
// a custom provider's own streamSimple — capture here is best-effort
// freshness; the provider's guard falls back to the module-level registry
// when a closure never received an event. (Architecture review L0-01/
// L0-02/L0-04.)
const captureCtx = (ctx: ExtensionContext) => {
  try {
    lastExtensionContext = ctx;
    // Read the getter once: a ctx that goes stale between two reads would
    // otherwise populate closure state but not the module fallback.
    const registry = ctx.modelRegistry;
    currentModelRegistry = registry;
    // Module-level fallback: survives closure re-execution over the cached
    // module, so a fresh closure that never received an event can still
    // resolve a registry at guard time.
    modelRegistryFallback.current = registry;
    currentCwd = ctx.cwd;
  } catch {
    // Stale ctx after session replacement — ctx getters throw. Keep the
    // last captured values; the next event delivers a fresh ctx.
  }
};

// === Registration anchor comment (index.ts:521-526, the false "Capture contract anchor" claim) → replaced by ===
// Capture points: every handler below runs captureCtx first. No single
// event is guaranteed to precede the router's own streamSimple (compaction
// and branch-summary call the stream function directly; before_provider_request
// fires only inside the delegated inner request) — the provider's guard
// falls back to the module-level registry when this closure never received
// an event. (L0-01.)

// === State bag (after the existing get currentModelRegistry()) ===
set currentModelRegistry(v) {
  currentModelRegistry = v;
},

// === Slice 2 addition: turn_start capture handler (inserted directly after
// the pi.on('before_provider_request', ...) registration — positionally; HEAD
// line numbers shift +~10 after the Slice-1 edits above this point) ===
// turn_start fires through the runner at the start of every turn, before
// that turn's provider request (AgentSession._emitExtensionEvent →
// runner.emit → createContext, agent-session.js:367-374) — including sessions
// that never emitted session_start (reload without bindings). It is the
// strongest per-turn capture anchor: it makes the serving closure's registry
// exact instead of relying on the module fallback. Pure capture — no
// behavioral gating (contrast model_select, whose isInitialized early-return
// runs AFTER its captureCtx call; turn_start must not gate at all). (L0-01.)
pi.on('turn_start', (_event, ctx) => {
  captureCtx(ctx);
});
```

### extensions/types.ts — MODIFY

One-line purpose: `RouterDiagnosticEntry` — additive failure-entry payload.

```typescript
export interface RouterDiagnosticEntry {
  type: 'registry-guard';
  provenance: 'none';
  pid: number;
  uptimeMs: number;
  argvFlags: string;
  detail: string;
}
```

### extensions/provider.test.ts — MODIFY

One-line purpose: fallback-recovery test; failure-path test kept green.

```typescript
// === Import change ===
import {
  registerRouterProvider,
  createErrorMessage,
  modelRegistryFallback,
} from './provider';

// === describe-scope declaration (beside the existing lets) ===
let mockRegistry: any;

// === beforeEach (:57-120) changes ===
// `const mockRegistry = {` → `mockRegistry = {` (assignment to the hoisted let)
// one line added at the end of beforeEach:
modelRegistryFallback.current = undefined;

// === New test (inserted after 'should push error event when currentModelRegistry is undefined') ===
it('should recover via module fallback when the closure never captured a registry', async () => {
  // Simulate a captureCtx from ANOTHER closure instance of the same
  // module (factory re-execution): module fallback set, this closure's
  // registry undefined.
  modelRegistryFallback.current = mockRegistry;
  mockState.currentModelRegistry = undefined;
  registerRouterProvider(mockPi, mockState, mockActions);
  const stream = new MockEventStream();
  vi.mocked(createAssistantMessageEventStream).mockReturnValue(
    stream as any,
  );

  vi.mocked(streamSimple).mockReturnValue(
    (async function* () {
      yield { type: 'text_delta', delta: 'fallback registry answer' };
      yield {
        type: 'done',
        message: { usage: { cost: { total: 0.001 } } },
      };
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

  // Guard recovered: delegation ran and the closure state was healed
  // (write-back through the state bag's new setter in production; plain
  // property here).
  expect(vi.mocked(streamSimple)).toHaveBeenCalled();
  expect(mockState.selectedProfile).toBe('balanced');
  expect(mockState.currentModelRegistry).toBe(mockRegistry);
  const errorEvent = stream.events.find((e: any) => e.type === 'error');
  expect(errorEvent).toBeUndefined();
});
```

### extensions/index.test.ts — MODIFY

One-line purpose: `turn_start` registration test; captureCtx-writes-fallback test.

```typescript
// === Import addition ===
import { modelRegistryFallback } from './provider';

// === beforeEach (:51-66): one line added just before the closing `});` ===
modelRegistryFallback.current = undefined;

// === New test (declaration-order independent given the reset) ===
it('should write the module fallback on a before_provider_request capture and not poison it on stale ctx', async () => {
  routerExtension(mockPi);

  const mockCtx = buildMockCtx();
  const captureHandlers = eventListeners['before_provider_request'] || [];
  for (const handler of captureHandlers) {
    await handler({}, mockCtx);
  }
  expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);

  // Stale ctx after session replacement: ctx getters throw inside the try;
  // the fallback must keep the last good value (write stays in the try).
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
  for (const handler of captureHandlers) {
    handler({}, staleCtx);
  }
  expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);
});

// === Slice 2 addition: turn_start capture test ===
it('should capture the registry on turn_start', async () => {
  routerExtension(mockPi);

  const turnStartHandlers = eventListeners['turn_start'] || [];
  expect(turnStartHandlers.length).toBeGreaterThan(0);

  // No session_start first: capture must land in a never-initialized closure.
  const mockCtx = buildMockCtx();
  for (const handler of turnStartHandlers) {
    await handler(
      { type: 'turn_start', turnIndex: 0, timestamp: Date.now() },
      mockCtx,
    );
  }
  expect(modelRegistryFallback.current).toBe(mockCtx.modelRegistry);
});
```

### extensions/registry-guard.test.ts — NEW

One-line purpose: deterministic regression test on real `ExtensionRunner` + real compat dispatch.

```typescript
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthStorage,
  DefaultResourceLoader,
  ExtensionRunner,
  InMemoryAuthStorageBackend,
  ModelRegistry,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { streamSimple as compatStreamSimple } from '@earendil-works/pi-ai/compat';
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai';

// Drives the REAL ordering end to end: DefaultResourceLoader (factory cache
// via loadExtensionsCached) → ExtensionRunner.bindCore flush → real compat
// api-map dispatch → the router's own streamSimple, with session_start
// deliberately omitted. The review-mandated repro, on real machinery.
//
// Hermeticity (no vi.mock — the extension loads through pi's jiti, whose
// module graph vitest cannot mock): PI_CODING_AGENT_DIR points getAgentDir()
// at an empty tmp dir, and the router profile is written to that dir's
// model-router.json — the GLOBAL config path, read at factory time. The
// project path (process.cwd()/.pi/model-router.json) is never relied on
// (index.ts seeds currentCwd = process.cwd() at factory time).
// Per-test tmp dirs also rotate the extension factory cache (cwd change →
// clearExtensionCache → fresh module instance per test), so no cross-test
// module state.

const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';
const EXTENSION_PATH = fileURLToPath(new URL('./index.ts', import.meta.url));

type ExtensionsResult = ReturnType<DefaultResourceLoader['getExtensions']>;
type RouterErrorEvent = Extract<AssistantMessageEvent, { type: 'error' }>;
type ProviderConfig = Parameters<ModelRegistry['registerProvider']>[1];

const registerFakeProvider = (registry: ModelRegistry) => {
  const fakeStreamSimple = async function* () {
    yield { type: 'text_delta' as const, delta: 'routed-ok' };
    yield {
      type: 'done' as const,
      message: { usage: { cost: { total: 0 } }, stopReason: 'stop' },
    };
  };
  registry.registerProvider('fake-provider', {
    baseUrl: 'fake://local',
    apiKey: 'fake-key',
    api: 'fake-api',
    models: [{ id: 'tiny' }],
    streamSimple: fakeStreamSimple,
  } as unknown as ProviderConfig);
};

// A "world" = tmp agent dir (holds the router profile as the GLOBAL config)
// + tmp cwd (rotates the factory cache) + shared in-memory registry. Loading
// two extensions-results over ONE world is the second-in-process-session
// scenario: the second loader hits the factory cache (same cwd) and gets a
// NEW closure over the SAME module instance.
const worlds: Array<{ cwd: string; agentDir: string }> = [];
const buildWorld = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-guard-cwd-'));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pi-router-guard-agent-'),
  );
  process.env[ENV_AGENT_DIR] = agentDir;
  fs.writeFileSync(
    path.join(agentDir, 'model-router.json'),
    JSON.stringify({
      profiles: {
        balanced: {
          high: { model: 'fake-provider/tiny' },
          medium: { model: 'fake-provider/tiny' },
          low: { model: 'fake-provider/tiny' },
        },
      },
    }),
  );
  const registry = ModelRegistry.inMemory(
    AuthStorage.fromStorage(new InMemoryAuthStorageBackend()),
  );
  registerFakeProvider(registry);
  const world = { cwd, agentDir, registry };
  worlds.push(world);
  return world;
};

const loadExtensionsFor = async (world: {
  cwd: string;
  agentDir: string;
}): Promise<ExtensionsResult> => {
  const settingsManager = SettingsManager.create(world.cwd, world.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: world.cwd,
    agentDir: world.agentDir,
    settingsManager,
    additionalExtensionPaths: [EXTENSION_PATH],
  });
  await loader.reload();
  return loader.getExtensions();
};

const bindRunner = (
  world: { cwd: string; registry: ModelRegistry },
  extensionsResult: ExtensionsResult,
) => {
  const appendEntry = vi.fn();
  const runner = new ExtensionRunner(
    extensionsResult.extensions,
    extensionsResult.runtime,
    world.cwd,
    // sessionManager: no handler on this code path reads it.
    {} as ConstructorParameters<typeof ExtensionRunner>[3],
    world.registry,
  );
  runner.bindCore(
    {
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry,
      setSessionName: vi.fn(),
      getSessionName: vi.fn(),
      setLabel: vi.fn(),
      getActiveTools: vi.fn(),
      getAllTools: vi.fn(),
      setActiveTools: vi.fn(),
      refreshTools: vi.fn(),
      getCommands: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      getThinkingLevel: vi.fn(),
      setThinkingLevel: vi.fn(),
    },
    {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => '',
      getSystemPromptOptions: () => ({ cwd: world.cwd }),
    },
  );
  return { runner, appendEntry };
};

const routerModel = (registry: ModelRegistry) => {
  const model = registry.find('router', 'balanced');
  expect(model).toBeDefined();
  return model!;
};

const collectStream = async (
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const errorEvents = (events: AssistantMessageEvent[]): RouterErrorEvent[] =>
  events.filter((e): e is RouterErrorEvent => e.type === 'error');

const streamContext = () => ({ messages: [] }) as unknown as Context;

describe('registry guard regression (real resource loader + runner + compat dispatch)', () => {
  let previousAgentDir: string | undefined;
  let consoleErrorSpy: Mock;

  beforeAll(() => {
    previousAgentDir = process.env[ENV_AGENT_DIR];
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousAgentDir;
    for (const world of worlds) {
      fs.rmSync(world.cwd, { recursive: true, force: true });
      fs.rmSync(world.agentDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes the guard error and a router-diagnostic entry when no capture ever happened', async () => {
    const world = buildWorld();
    const { appendEntry } = bindRunner(world, await loadExtensionsFor(world));
    // NO events delivered — the residual-window negative control.

    const events = await collectStream(
      compatStreamSimple(routerModel(world.registry), streamContext()),
    );

    const errors = errorEvents(events);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].error.errorMessage).toContain('no model registry');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('registry guard FAILED'),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      'router-diagnostic',
      expect.objectContaining({ type: 'registry-guard' }),
    );
  });

  it('recovers via the module fallback when the serving closure never received an event', async () => {
    const world = buildWorld();

    // Session 1: factory executes (closure C1, fresh module instance), the
    // flush registers it, and ONE capture event lands — session_start is
    // deliberately omitted (the review-mandated ordering).
    const first = bindRunner(world, await loadExtensionsFor(world));
    await first.runner.emitBeforeProviderRequest({});

    // Session 2 over the same world: the loader hits the factory cache → a
    // NEW closure over the SAME module instance; the flush OVERWRITES the
    // compat api-map entry. ZERO events reach this closure.
    bindRunner(world, await loadExtensionsFor(world));

    // The stream dispatches through compat to the LAST registered closure,
    // which never captured. The guard must recover via the module fallback
    // (written by C1's capture, shared through the cached module) and
    // delegate end-to-end through the fake provider. The write-back also
    // runs against the REAL state bag — a getter-only bag would throw.
    const events = await collectStream(
      compatStreamSimple(routerModel(world.registry), streamContext()),
    );

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(errorEvents(events).length).toBe(0);
  });

  it('captures on turn_start through the real runner emit path', async () => {
    const world = buildWorld();
    const { runner } = bindRunner(world, await loadExtensionsFor(world));

    await runner.emit({ type: 'turn_start', turnIndex: 0, timestamp: 0 });

    const events = await collectStream(
      compatStreamSimple(routerModel(world.registry), streamContext()),
    );
    expect(errorEvents(events).length).toBe(0);
  });
});
```

## Slices

### Slice 1: Self-healing guard + module fallback + diagnostics

**Files**: `extensions/provider.ts`, `extensions/index.ts`, `extensions/types.ts`, `extensions/provider.test.ts`, `extensions/index.test.ts`

#### Automated Verification:
- [ ] Type checking passes (this slice owns all type-surface changes): `npx tsc --noEmit`
- [ ] Provider suite passes: `npx vitest run extensions/provider.test.ts` (incl. recovery test; `'should push error event when currentModelRegistry is undefined'` stays green: `'no model registry'` + `persistState` not called)
- [ ] Orchestrator suite passes: `npx vitest run extensions/index.test.ts` (incl. fallback write/no-poison test; stale-ctx capture test stays green)
- [ ] `grep -n "modelRegistryFallback" extensions/provider.ts extensions/index.ts` returns holder + guard read + captureCtx write
- [ ] `grep -n "set currentModelRegistry" extensions/index.ts` returns the new setter

#### Manual Verification:
- [ ] Fallback write inside `captureCtx`'s try with a single getter read — a stale ctx keeps the last good fallback value (no-poison test)
- [ ] Guard logic + write-back verified on plain mock state; production bag wiring exercised end-to-end by the terminal slice's live-runner test (a getter-only bag would throw TypeError at write-back in strict mode)

### Slice 2: turn_start capture point

**Files**: `extensions/index.ts`, `extensions/index.test.ts`

#### Automated Verification:
- [ ] Orchestrator suite passes: `npx vitest run extensions/index.test.ts` (incl. the turn_start capture test)
- [ ] `grep -n "turn_start" extensions/index.ts` returns the new `pi.on('turn_start', ...)` handler
- [ ] Type checking passes: `npx tsc --noEmit` (handler signature matches pi's `TurnStartEvent` overload, `core/extensions/types.d.ts:520-524, 833`)

#### Manual Verification:
- [ ] The turn_start handler is a pure `captureCtx` call with no behavioral gating — it fires even in never-initialized closures (contrast `model_select`, whose `isInitialized` early-return runs AFTER its capture call; turn_start must not gate at all)

### Slice 3: Deterministic regression test on real ExtensionRunner

**Files**: `extensions/registry-guard.test.ts`

#### Automated Verification:
- [ ] (filled in Step 6.4)

#### Manual Verification:
- [ ] (filled in Step 6.4)

## Desired End State

A router stream that arrives at a closure which never received any event still delegates successfully whenever any closure in the module ever captured a registry:

```typescript
// extensions/provider.ts — guard, after the fix
if (!state.currentModelRegistry && !modelRegistryFallback.current) {
  // stderr + pi.appendEntry('router-diagnostic', { provenance: 'none', ... })
  stream.push({ type: 'error', reason: 'error', error: createErrorMessage(model, 'Router provider has no model registry: …') });
  stream.end();
  return stream;
}
if (!state.currentModelRegistry) {
  state.currentModelRegistry = modelRegistryFallback.current; // write-back self-heal
  // one deduped stderr line: provenance 'module-fallback'
}
const modelRegistry = state.currentModelRegistry!;
```

Locally fixable windows stop producing the error: a second in-process session over the cached module recovers via the fallback; every normal turn — including after `/reload` without bindings — captures on `turn_start` before its stream. If a residual window fires (reload-aliased stream before `session_start`, partial factory load, never-bound SDK host, compaction-first), the turn still fails loud, but the session JSONL now contains a `router-diagnostic` entry with provenance, pid, uptime, and argv flags — answering research Open Question #3 from the session file alone.

## File Map

- extensions/provider.ts  # MODIFY — module fallback holder, self-healing guard, diagnostics, corrected invariant comment
- extensions/index.ts  # MODIFY — state-bag setter, captureCtx fallback write (single getter read), both false-anchor comments corrected (Slice 1), turn_start capture handler (Slice 2)
- extensions/types.ts  # MODIFY — RouterDiagnosticEntry interface (additive)
- extensions/provider.test.ts  # MODIFY — fallback-recovery test + fallback reset in beforeEach
- extensions/index.test.ts  # MODIFY — captureCtx-writes-fallback/no-poison test (Slice 1), turn_start registration test (Slice 2), fallback reset in beforeEach
- extensions/registry-guard.test.ts  # NEW — deterministic regression test (real ExtensionRunner + real compat)

## Ordering Constraints

- Slice 1 before Slice 2: the `turn_start` handler writes the fallback that Slice 1 introduces.
- Slice 3 last: it exercises the end-to-end behavior of Slices 1+2 and carries the baseline checks (`npm run tsc`, `npm test`).
- Slices are strictly sequential; no parallelism.

## Verification Notes

- Known risk: the guard error text is pinned by `extensions/provider.test.ts:788-813` (`'no model registry'`) — do not reword the message.
- Known risk: `modelRegistryFallback` is module state shared across tests in one file; tests that rely on its initial `undefined` must run before tests that set it, or reset it explicitly. The new regression test's negative control runs first in the file.
- Precedent lesson (research): every prior fix asserted an invariant in prose that no test observed — the regression test must drive the real ordering (factory → bindCore flush → streamSimple, no session_start), not a mock of it.
- Precedent lesson (research): `captureCtx`'s empty catch repeats the `f67a7850` blind-swallow pattern — do not extend the catch to swallow fallback writes; the fallback write stays inside the `try` so a stale ctx cannot poison it.
- Verify with: `npm run tsc` and `npm test` (terminal slice); `grep -n "turn_start" extensions/index.ts` returns the new handler; `grep -n "modelRegistryFallback" extensions/provider.ts extensions/index.ts` returns holder + write + read sites.

## Performance Considerations

- Guard adds one `??` check per router stream — negligible.
- Diagnostics: recovery logging deduped per provenance per process (Set lookup); failure path does one `appendEntry` per occurrence (rare by construction).
- No new allocations on the hot path; the fallback holder is a single shared object reference.

## Migration Notes

No persisted-schema migration. `router-diagnostic` is a new additive custom entry type; existing consumers filter entries by `customType === 'router-state'` and ignore it. `isRouterPersistedState` rejects unknown shapes. Rollback is a straight revert of the five modified files (`provider.ts`, `index.ts`, `types.ts`, `provider.test.ts`, `index.test.ts`) plus deletion of the new test file.

## Pattern References

- `extensions/index.ts:521-596` — the five existing `pi.on(... captureCtx)` capture sites; the `turn_start` handler follows this pattern exactly.
- `extensions/index.ts:297-302` — the live-getter state bag handed to `registerRouterProvider`; the new setter mirrors the existing get/set pairs (`selectedProfile`, `routerEnabled`).
- `extensions/index.test.ts:3-44` — the `vi.mock('./config', …)` shape the regression test reuses.
- `extensions/provider.test.ts:788-813` — the failure-path test whose assertions must stay green.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:184-203` — `bindCore` flush, the reproduction lever for the regression test.

## Developer Context

**Q (`extensions/provider.ts:290-303`): Confirm the fix direction — module fallback + write-back + `turn_start` capture?**
A: Follow capture pattern (Recommended) — approved 2026-08-30. Guard resolves `closure ?? moduleFallback`, writes back via a new state-bag setter so image-filter and `resolveContextWindow` reads also see the registry.

**Q (scope): Tight scope with the four secondary defects deferred?**
A: Tight scope (Recommended) — approved 2026-08-30. Deferred: dead `runtime?.streamSimple` branch, dead-ctx hardening, `commands.ts` capture, upstream pi issue.

**Q (diagnostics): `router-diagnostic` session entry on the failure path + deduped stderr on recovery?**
A: Failure entry + stderr (Recommended) — approved 2026-08-30.

**Q (decomposition): 3 slices (guard/fallback → turn_start → regression test)?**
A: Approve — 2026-08-30.

**Micro-checkpoint Slice 1 (`extensions/provider.ts:284-301`, `extensions/index.ts:61-69,297-302`): Approve self-healing guard + module fallback + diagnostics?**
A: Approve — 2026-08-30. Slice-verifier ran 4 rounds; all violations fixed or ratified: (1) state-bag test redesigned (bag is module-local, not in `pi.registerProvider` options); (2) `argvFlags` flags-only — no user prompt text persisted; (3) citation anchors corrected (`index.test.ts:51-66`, `provider.test.ts:57-120`/`:82`, guard block `provider.ts:290-301`); (4) anchor-comment correction moved into Slice 1 (no cross-slice comment contradiction); (5) coverage corrected against `resource-loader.js:218-221` (`/reload` clears the extension cache → module re-evaluation → fallback lost there; fallback's window = second in-process session over the cached module; session replacement reuses closures). By-design ratifications: private recovery-log latch (no test depends on stderr); slice-1 recovery test hand-assigns the fallback (cross-closure survival proven by Slice 3's live two-runner scenario).

**Micro-checkpoint Slice 2 (index.ts, after the before_provider_request registration): Approve the turn_start capture handler?**
A: Approve — 2026-08-30. One verifier round: Decisions OK; anchor-drift (HEAD line numbers invalid post-Slice-1) fixed with positional citations; manual-bullet contradiction reworded (turn_start gates nothing, contrast model_select's gating-after-capture); handler comment now cites its source (`agent-session.js:367-374`) instead of asserting the invariant bare — Slice 3 additionally delivers capture events through the real `runner.emit` path.

Inherited from research (fixed decisions, not re-asked): structural fix at guard time plus deterministic regression test plus the diagnostic logging the review's L0-01 callout mandates; diagnose-only and upstream-only were considered and rejected as the sole path.

## Design History

- Slice 1: Self-healing guard + module fallback + diagnostics — approved as generated (4 slice-verifier rounds; coverage claims corrected against `resource-loader.js:218-221`: /reload re-evaluates the module, fallback covers the second-in-process-session window, anchor-comment correction moved here from Slice 2)
- Slice 2: turn_start capture point — approved as generated (1 verifier round; HEAD-line anchors replaced with positional citations, comment claims source-grounded)
- Slice 3: Deterministic regression test on real ExtensionRunner — pending

## References

- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — parent research artifact (root-cause analysis, trigger windows, precedent lessons)
- `.rpiv/artifacts/architecture-reviews/pi-model-router_root-cause-router-not-initialized.md` — the architecture review whose Phase 1 landed as `4ae87431` and whose L0-01 callout mandates the diagnostics and the regression test
- `.rpiv/workflows/runs/2026-08-30_08-33-21-99c1.jsonl` — field refutation ~8h after `4ae87431`
