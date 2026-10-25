# extensions/ — Router Extension Layer

## Responsibility
The entire product: a per-turn model router loaded by the pi host as an extension. One factory `(pi: ExtensionAPI) => void` in `index.ts` wires config, routing, stream delegation, watchdogs, UI, commands, and persistence.

## Dependencies
- **@earendil-works/pi-coding-agent**: host contract (`ExtensionAPI`, `getAgentDir()`) — shapes every event handler and the entry factory
- **@earendil-works/pi-ai (+ /compat)**: `streamSimple`, `createAssistantMessageEventStream` — shapes the delegation transport and stream invariants
- **@earendil-works/pi-agent-core / pi-tui**: types only (`ThinkingLevel`, `AutocompleteItem`)

## Consumers
- **pi host**: loads `extensions/index.ts` via the `pi.extensions` manifest key through jiti; the factory is cached per cwd (why closure.ts exists)
- **vitest**: imports the same sources via co-located `*.test.ts` files

## Module Structure
```
extensions/
├── index.ts                            # Orchestrator: owns ALL mutable state; registers pi events; builds the bags
├── provider.ts                         # router provider + delegation turn loop + fallback chain (+ legacy re-exports)
├── routing.ts                          # Pure decision logic: budget → pin → rules → classifier → heuristics (+ watchdog shim)
├── config.ts, state.ts, constants.ts   # Config pipeline; persisted-state guards; tunables
├── types.ts, keywords.ts               # Shared contracts + keyword vocabulary (leaf modules, no internal imports)
├── commands.ts, ui.ts                  # /router subcommands + pure formatting (no ambient state reads)
└── watchdog.ts, closure.ts, messages.ts, truncate.ts, typesafe.ts   # Reliability: stall race, closure dispatch, terminals, truncation, Jev backend
```

## Factory-Closure State Bags (index → submodules; submodules never import index)
```typescript
registerCommands(pi, {  // every mutable let lives in the factory closure; submodules receive bags
  get currentConfig() { return currentConfig; },   // readonly in the consumer type = no setter passed
  set routerEnabled(v) { routerEnabled = v; },     // setter only where mutation is allowed
  pinnedTierByProfile,                             // by reference — mutated in place, never reassigned
}, { persistState, updateStatus, switchToRouterProfile });  // actions bag: named mutation sequences
// Consumer side (commands.ts): dependencies are explicit structural parameters, not imports.
```

## Session Lifecycle (captureCtx dead-flag + cross-session closure dispatch)
```typescript
// Every pi handler calls captureCtx(ctx) FIRST, before any behavioral gate:
const captureCtx = (ctx: ExtensionContext) => {
  try { isExtensionContextDead = false; lastExtensionContext = ctx;
        modelRegistryFallback.current = ctx.modelRegistry;  // read the getter ONCE; notifyClosureCapture(pi); }
  catch { isExtensionContextDead = true; } };  // stale ctx getters throw
// Every ctx read is guarded: if (lastExtensionContext && !isExtensionContextDead) ...
// persistState() to a dead session is a silent no-op. pi caches the module per cwd, so each
// session re-runs the factory and overwrites the compat provider entry (last registration wins);
// the fix is ONE stable dispatcher registered once per process:
pi.registerProvider('router', { ..., streamSimple: dispatchRouterStream });
// closure.ts reuses one handle per ExtensionAPI (WeakMap); picks per call:
// freshest live > any live > most recent dead — availability beats a fabricated abort.
```

## Stall-Guarded Stream (named-error wire contract)
```typescript
// watchdog.ts: every external wait races an inactivity timer and the abort signal.
for await (const event of stallGuardedStream(delegatedStream, stallTimeoutMs,
  () => candidateAbort.abort(),          // onStall: kill THIS candidate only
  candidateAbort.signal, modelRef,
  { activity, backstopMs: DEFAULT_STALL_BACKSTOP_MS },  // ceiling before the first parsed event
)) { /* forward events, accumulate cost */ }
// Classification is by NAME: isStallTimeoutError = e.name === 'StallTimeoutError'; chains treat stalls like any candidate failure.
```

## Stream Termination Contract (signal-only abort + push-before-end)
```typescript
const isAborted = error.name === 'AbortError' && Boolean(options?.signal?.aborted);  // ONLY the stream's own run signal counts as a user abort
if (!isStaleCtx && !isAborted) {
  stream.push({ type: 'error', reason: 'error', error: createErrorMessage(model, msg) });
  stream.end();
} else {
  pushAbortedEnd(stream, model);  // INVARIANT: push a done/error event BEFORE end() —
}                                 // a bare end() parks pi's agent loop forever.
```

## Tiered Fallback Chain (down-then-nearest-up; down-only under budget)
```typescript
buildDelegationTierChain('high', false);  // routing.ts — pure chain builder  // ['high','medium','low','medium','high']
buildDelegationTierChain('high', true);   // ['high','medium','low'] — budget: no upward escape
// provider.ts loop: tier model → in-tier fallbacks → next tier. Every failure appends to
// lastError/skipReasons/stallFallbacks; the live decision is MUTATED to reflect what actually
// streamed (isFallback, reasoning) so history and widgets stay truthful.
```

## Config Pipeline (parse → merge → normalize → warn)
```typescript
// Global ~/.pi/agent/model-router.json is the base; project .pi/model-router.json deep-merges
// per-profile/per-tier/per-field. normalizeConfig validates every field:
typeof x === 'number' && x > 0 ? x : DEFAULT   // scalars: fall back + push a warning
Math.max(0, Math.min(1, raw))                  // ranges: clamp; every rejected or accepted-but-ignored value warns — never silent
```

## Architectural Boundaries
- **NO submodule imports of index** — state flows through bags; keeps the import graph acyclic
- **NO process-global mutable state outside closure.ts** — quarantined there with explicit accessors
- **NO new imports via the compat shims** — import watchdog/messages/closure from their own modules; provider.ts/routing.ts re-exports are legacy test-compat only
- **NO `any`, no `function` statements, no inline `import()`** — AGENTS.md coding standards
- **NO tier pointing at `router/*`** — self-delegation loop guard
- **Guard-fails-loud**: invariant violations push an error terminal ("router extension bug — please report it"), never a silent end

<important if="you are adding a /router subcommand">
## Adding a /router Subcommand
1. `commands.ts` → `SUBCOMMAND_DETAILS`: add `{ name, desc, longDesc }` — help text and top-level completions come free.
2. Enum args: add a `getXxxCompletions(args)` helper filtering a shared vocabulary constant (from `config.ts`, e.g. `ROUTER_PIN_VALUES`); add a `case` in `getArgumentCompletions` re-prefixed as `xxx ${c.value}` so values complete the whole line.
3. Handler shape: usage guard first (`ctx.ui.notify('Usage: /router xxx …', 'error')` + return) → zero-args form prints current value + usage (info) → validate enums against `config.ts` constants → mutate `state.*` (maps in place) → epilogue triple: `actions.persistState(); actions.updateStatus(ctx); ctx.ui.notify(…, 'info')`.
4. Add `case 'xxx'` to the handler switch; decide whether it joins the `default:` profile-name fallback or stays reserved.
5. Display element: add a pure `formatXxx` in `ui.ts` (returns string, `'none'` for empty, deterministic sort) and wire into `updateStatus`.
6. New state visible to commands: add the field to BOTH bag sides — the type in `commands.ts` (mark `readonly` if read-only) and the getter/setter literal in `index.ts`.
7. Test in `commands.test.ts`: capture `pi.registerCommand`, drive the handler/completions directly, assert notify + mutations + `persistState`.
</important>

<important if="you are adding a config field">
## Adding a Config Field
Reference implementations: `stallTimeoutMs` (scalar + default), `phaseBias` (clamped), `classifierModel.backend` (enum + dead-knob warning), `models` (map).
1. `types.ts`: optional field on `RouterConfig` + doc comment; derived values go in the normalized type (`resolved*` convention).
2. `constants.ts`: default + floors/caps as named exports — never inline literals.
3. `mergeConfig`: scalars `override.x ?? base.x`; nested objects get a `mergeXxx` helper (per-field spread); arrays flat-replace with a comment stating the semantics.
4. `normalizeConfig`: validate (typeof guard → DEFAULT, clamp ranges, `isXxx` enum guards) and push a warning for EVERY rejected or accepted-but-ignored value; set the field explicitly (`undefined` = not configured).
5. Consumers read with `?? DEFAULT` at the read site; include in the `modelsKey` fingerprint if it changes the advertised model set.
6. If persisted: add to `RouterPersistedState`, validate in `isRouterPersistedState` (reject `NaN`/`Infinity`), reset in `restoreStateFromSessionInner`.
7. `README.md`: JSON example block + field table row; update `model-router.example.json` if it belongs there.
8. Tests (`config.test.ts`): valid passes; wrong type warns + defaults; invalid enum warns; project-over-global merge precedence; boundaries (0, negative, NaN). Persisted fields: round-trip tests in `state.test.ts`.
</important>

<important if="you are adding a module to the orchestrator">
## Adding a Module to the Orchestrator
1. Create `xxx.ts`; import `types`/`constants`/`config` freely — never `index`.
2. State ownership: pure helpers take everything as parameters; orchestrator state → state bag + actions bag; genuinely process-wide → module-level with explicit, test-resettable accessors (see `modelRegistryFallback`, closure handles).
3. Wire in `index.ts`: add `let` declarations near the top with a purpose comment; build getter/setter pairs; if on the per-turn path, hook capture integration (`notifyClosureCapture`); dead-guard every pi API call.
4. Ordering: if it must run before `pi.registerProvider` (like `ensureClosureHandle`), order it and comment why.
5. Extracting code from an existing module? Add a re-export shim there with the surface-stability comment; new callers import the new home directly.
6. Open the module with its invariant contract in a header comment (see `watchdog.ts`, `closure.ts`: what it guarantees, what breaks if misused).
7. Co-located `xxx.test.ts`; run `npx tsc --noEmit` + `npm test`; verify registry-guard paths still fire in order.
</important>

<important if="you are adding a fallback or error path">
## Adding a Fallback or Error Path
1. Classify the path first — exactly one of: candidate failure (throw; chain continues) / skipped candidate (`skipReasons.push` + continue) / stall (`StallTimeoutError` → `stallFallbacks` + dead-guarded notify) / user abort (ONLY `options?.signal?.aborted` → `pushAbortedEnd` at the nearest choke point) / terminal bug guard (error terminal "router extension bug — please report it").
2. Reuse `createErrorMessage`/`createAbortedMessage`/`pushAbortedEnd` — a new factory only for a genuinely new terminal shape; keep the zero-usage block and push-before-end.
3. Thread provenance: append to `decision.reasoning` (`(Original: …)` style) or set `failureReason`/flags; record in `stallFallbacks`/`skipReasons` so the exhausted-chain error names every candidate.
4. Mid-chain user notices are dead-guarded (`lastExtensionContext && !isExtensionContextDead`), shape `router: <what> — trying next` as warning.
5. Exhausted chain throws `lastError || new Error(skipReasons.length ? '…skipped: …' : '…failed.')`; the outer catch classifies error-vs-aborted.
6. Test in `provider.test.ts`: fail the mock stream per candidate; assert chain advancement, decision mutation (`isFallback`, reasoning), and the exact terminal (`stopReason: 'error'` vs `'aborted'`).
</important>

<important if="you are adding a keyword group">
## Adding a Keyword Group
1. `keywords.ts`: raw lowercase array; multi-word phrases = substring match; single words get cached `\b` regexes via `containsAnyWord` — the only matcher; extend it, never call sites.
2. `classifyByHeuristics` arm — order matters (hints preempt; summary beats planning; lookup gated on `wordCount <= 24 && toolResultCount === 0`); every non-unknown arm pairs its work type with a stable reasoning string (parity: identical inputs → identical outcomes).
3. Check interactions: complexity raise exempts `summary`/`planning`; unknown-only nudges never displace a keyword classification.
4. Jev wire: extend `TypesafeCriterion.keywords` via explicit composition in `keywords.ts` — do NOT edit `WORK_TYPE_CRITERIA` tokens directly (the 66-token wire multiset is parity-pinned).
5. Tests (`routing.test.ts`): multiset parity assertions (HEAD + wire), arm precedence pinned, non-match falls through, `decideRouting` → tier mapping still holds (`unknown` → medium, stickiness intact).
</important>

<important if="you are writing or modifying tests for this layer">
## Testing Conventions
- Co-located `module.test.ts` (stripped at publish via the `files` whitelist); one `describe` per module, nested per concern.
- Mock the HOST platform, never your own modules: `vi.mock('node:fs')`, `vi.mock('@earendil-works/pi-coding-agent')`. pi loads the extension through jiti, whose module graph vitest cannot mock — own-module mocks do not survive real loads.
- Known gap: `typesafe.ts` is the only non-trivial module without a co-located test (parse/failure/abort paths untested; the probe script covers only the wire schema and costs a paid call). Mocking `globalThis.fetch` is consistent with house style.
- Coverage gates (40% lines/statements, 30% branches/functions) apply to `provider.ts` + `routing.ts` only, under `npm run test:coverage` — a local gate, not CI.
</important>

<important if="you are adding a cross-session, loader, or registration-ordering invariant test">
## Adding a Guard Test
Follow `extensions/registry-guard.test.ts` (orphan test, no source twin) — only for bugs that live BETWEEN modules or inside pi's loader (factory caching, module identity, dual registration, closure resolution); if host-API mocks can exercise the logic, it belongs in a co-located `module.test.ts` instead.
1. Real machinery, ZERO `vi.mock`: `DefaultResourceLoader` → `ExtensionRunner.bindCore` → real compat dispatch.
2. Hermeticity via env, not mocks: redirect `PI_CODING_AGENT_DIR` to a tmp agent dir; a fresh tmp cwd per test rotates the factory cache → fresh module instance.
3. Dual fake-provider registration: `ModelRegistry` (outer dispatch) AND compat `registerApiProvider` (inner delegated call).
4. Triple shape: negative control (guard error + `router-diagnostic` entry) / recovery (module-level fallback) / happy path (capture via real `runner.emit`).
5. Hygiene: restore env in `afterAll`, spy `console.error`, `vi.restoreAllMocks()`, remove tmp dirs recursively.
</important>
