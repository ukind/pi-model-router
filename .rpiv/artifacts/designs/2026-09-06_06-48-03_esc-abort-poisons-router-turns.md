---
date: 2026-09-06T06:48:03+0700
author: Yogiswara Utama
commit: 01d84ba7
branch: main
repository: pi-model-router
topic: "esc-abort-poisons-router-turns"
tags: [design, provider, abort-signal, terminal-events, e2e, rpc, extension-context, debug-instrumentation]
status: ready
parent: .rpiv/artifacts/research/2026-09-06_05-36-39_esc-abort-poisons-router-turns.md
last_updated: 2026-09-06T10:29:40+0700
last_updated_by: Yogiswara Utama
---

# Design: ESC-abort leg work — gate instrumentation, two-scenario RPC e2e, two-turn abort guard

## Summary

One ESC abort during a router-routed turn can leave later turns dead until `/reload` (research: `.rpiv/artifacts/research/2026-09-06_05-36-39_esc-abort-poisons-router-turns.md`). This design builds the evidence infrastructure the FRD requires before any fix: debug-gated one-line instrumentation at the four abort exits in `extensions/provider.ts`, a two-turn sticky-state regression guard in `extensions/provider.test.ts`, and a two-scenario RPC e2e harness (`scripts/e2e-esc-abort.mjs`) against real pi 0.84.3. Gating-logic behavior does not change; when debug is off, a taken abort exit costs one helper call plus its operand-string build, and the debug surface is never touched. The root-cause fix stays downstream of the evidence, per the FRD fix-layer decision.

## Requirements

- Leg 1: instrument the four abort exits (gate 1 `provider.ts:377-388`, gate 2 `:577-584`, gate 3 `:614-621`, gate 4 catch `:822-851`) with one debug-gated line per taken exit: gate id, each operand read separately, entry-time delivered-aborted vs aborted-mid-run, loop position (gate 2), error shape + phase marker (gate 4).
- Leg 2: scripted e2e repro under `scripts/` against real pi 0.84.3 (global install), RPC mode, sandboxed `PI_CODING_AGENT_DIR`; log discriminates the four failure shapes; asserts router-state persistence across turns.
- Leg 3: two-turn unit guard in `extensions/provider.test.ts`, run via `npm test`: turn A aborted mid-classifier; turn B with a fresh `AbortController` delegates and streams.
- If the e2e pins the mechanism inside pi: the log must carry enough to frame the upstream issue (that framing is a human task after evidence — not in this design's code).
- Constraint: terminal-aborted-event behavior must not regress (the d793dbde class).
- Constraint: gate instrumentation is zero-cost when debug is off.
- Non-goals (FRD-confirmed): full abort-path audit, further spinner-hang work, pi-core code changes from this repo.

## Current State Analysis

### What exists now

- `registerRouterProvider(pi, state, actions)` (`extensions/provider.ts:192-215`) receives a state facade; the facade (`extensions/index.ts:301-360`) exposes getters but has **no `debugEnabled`** — provider.ts cannot see the debug flag today.
- `debugEnabled` lives as a module-level `let` (`extensions/index.ts:43`), set by `reloadConfig` (`:232`), restored from persisted state (`:411`), toggled by `/router debug` (commands facade getter/setter `:513-516`), read by `recordDebugDecision` (`:132`) and the `session_start` notify guard (`:564`).
- The stream handler runs one fire-and-forget IIFE (`provider.ts:332`); four exits convert staleness/abort into terminal `error` events with `reason: "aborted"`. None records which operand tripped or when the abort arrived. There is no entry-time signal check.
- `runClassifier` (`extensions/routing.ts:698-787`) swallows all per-ref errors and returns `undefined` — a classifier-side abort never throws.
- `errorMessage: "Operation aborted"` is stamped by the interactive renderer on EVERY `stopReason === "aborted"` message (`dist/modes/interactive/interactive-mode.js:2656-2662`) — presentation-layer, zero exit information.
- Prior fix chain at this seam: `f67a7850` → `4ae87431` → `d793dbde` → `01d84ba7`; each shipped green tests and broke real pi within days. The prior plan deferred all live checks; the 01d84ba7 validation artifact has every manual ESC box unchecked.

### Key Discoveries

- **Timing pins the bug exit to the staleness class**: turns 3/4 aborted 7.3 s / 7.6 s after their prompts (≈ classifier latency), so the classifier ran fully and the exit fired in milliseconds after it — gate 1 on `isExtensionContextDead`, or the catch's stale-ctx arm. A pre-aborted signal would fast-fail in milliseconds (research §2 deduction c).
- **Precondition**: `pi.appendEntry` was already silently failing ~13 min before the ESC (`persistState` swallow, `extensions/index.ts:199-215`): six successful turns persisted zero `router-state` entries; subagent records (21:36/21:39) bracket the onset. Session replacement invalidated the captured `pi` bridge while per-event ctxs stayed live (research §3).
- **The strict recordDebugDecision guard would suppress the most important line**: gate 1 can fire BECAUSE `isExtensionContextDead` is true, and the flag can be set while the ctx still delivers (pi awaits `session_shutdown` handlers BEFORE invalidating the runner; `captureCtx` can set the flag conservatively). Hence the deviation decision below.
- **`getApiKeyAndHeaders` sits OUTSIDE the per-candidate try** (`provider.ts:605-611`; the try opens at `:641`) — a stale throw from the auth await reaches gate 4 and is indistinguishable from a post-classifier sync-step throw without an explicit phase marker.
- **Gate 4's abort arm also catches the rethrown delegation `lastError`** (the `throw lastError` at `provider.ts:829-834`): an AbortError swallowed by the per-candidate catch then rethrown re-enters the catch. `lastError !== undefined` discriminates it from a direct sync-step throw.
- **mockState is `any`** (`provider.test.ts:71`) — adding a required field to the provider's inline state type does not break the test file. Its `ui` mock defines ONLY `setHiddenThinkingLabel` (`:119-122`), so an ungated `ui.notify` would throw inside the IIFE — the debug guard is load-bearing. `mockState` has no `debugEnabled` key ⇒ falsy ⇒ existing tests pass unmodified.
- **The positive emission path of `recordDebugDecision` is untested today** (zero `router →` assertions in `index.test.ts`).
- **RPC surface verified against the global 0.84.3 install** (`C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent@0.84.3`): envelope is top-level `{"id", "type", ...}` (NOT method/params); commands include `prompt` (:298), `abort` (:329), `new_session` (:333), `get_state` (:344 → `{model, isStreaming, messageCount, ...}`), `set_model` (:364 → `session.setModel(model)` resolved from the available snapshot), `get_entries` (:502), `get_messages` (:533). Notify surfaces as `extension_ui_request {method:"notify", message, notifyType}` needing no reply; `select`/`confirm`/`input` dialogs DO need `extension_ui_response` replies or the session hangs.
- **`PI_CODING_AGENT_DIR` relocates everything** (pi `dist/config.js:420-426`): models.json, sessions, extensions dir, and the extension's global `model-router.json` (`extensions/config.ts:545`, `getAgentDir`). A minimal sandbox (models.json copy + generated model-router.json) is sufficient; the ollama-cloud API key is inline in the user's models.json so the copy carries auth (classifier auth flows via `modelRegistry.getApiKeyAndHeaders`, `routing.ts:714-715` — never from model-router.json).
- **RPC mode has no model-selection problem left**: `set_model` after spawn AND after `new_session` re-selects the router profile; `get_state.model.provider === 'router'` asserts it. The `--model` CLI flag also exists (`dist/cli/args.js:55-56`) but the harness does not depend on it.
- **No standalone-script precedent exists in this repo** (git history verified: zero first-party scripts/, tests/, or .mjs). The e2e sets precedent.

## Scope

### Building

- `readonly debugEnabled` on the provider state facade (inline type + index.ts getter).
- `debugAbort` emitter + entry-time signal snapshot + `classifierRan` flag + `iifePhase` marker + one line at each of the four abort exits (debug-gated, zero-cost when off, terminal-event contract untouched).
- Two-turn sticky-state guard test (one `it`, both turns, no mockState reset, `.at(-1)` indexing).
- Per-exit emission tests + debug-off no-throw test + dead-ctx swallow test.
- `scripts/e2e-esc-abort.mjs`: two scenarios (baseline abort | `new_session` replacement precondition), `set_model` selection, control-turn latency measurement, abort at half measured latency, post-abort probe turn, fresh-process recovery, `get_entries` persistence assertions, gate-line capture, plain-language report with interpretation table.
- README "For development" paragraph documenting the harness invocation.

### Not Building

- Any change to gating behavior or to the root cause (fixes land after the evidence, downstream of this design).
- pi-core changes; upstream issue automation (the report informs a manual filing).
- Full abort-path audit; further spinner-hang work.
- A ring-buffer/flush mechanism to recover dead-plane gate lines (advisor: session forensics already proves that signature; absence of a line is itself the discriminator).
- npm script wiring for the e2e (manual run only — network + real keys + live pi).
- Any persisted-schema change (gate lines are notify-only; `debugEnabled` is already in `RouterPersistedState`).

## Decisions

### D1: debugAbort guard deviates from the recordDebugDecision guard (advisor-resolved)

Ambiguity: emit through the strict `recordDebugDecision` guard (`debugEnabled && lastExtensionContext && !isExtensionContextDead`, `index.ts:132`) or drop the dead-flag check for the abort emitter?

Explored:
- Option A (drop dead-flag check + try/catch): gate-1-on-dead-flag can still emit when the ctx plane is still live (shutdown-race window — pi awaits `session_shutdown` handlers before invalidating the runner). Exactly the window this bug lives in; directly answers research Open Question 2.
- Option B (strict convention): identical output except dead-flag exits never emit; the line the leg-1 instrumentation exists to produce is structurally unobservable in the poison scenario.

Decision: **Option A**, per advisor. Two refinements adopted: (1) the try/catch is load-bearing under EITHER guard — TOCTOU (flag false, ctx dies before `ui.notify` runs) would otherwise skip the branch's `stream.push` and reclassify the exit through gate 4, where a non-stale/non-AbortError-shaped throw pushes `reason: 'error'` instead of `'aborted'` (the d793dbde regression class); (2) the deviation is documented at the site and scoped: this helper only — `recordDebugDecision`, `updateStatus`, and all other readers keep the strict guard. `debugEnabled` stays the first short-circuit check (mock-hazard + zero-cost-when-off preserved). Dead-ctx swallow test must assert the terminal event is still `reason: 'aborted'` from the ORIGINAL gate.

### D2: e2e as a first-party standalone script (developer-confirmed)

No standalone-script precedent existed. `scripts/e2e-esc-abort.mjs` (plain Node, spawns the global pi 0.84.3 in RPC mode, LF-JSONL over stdio), run manually, never wired into `npm test` (needs network + real keys + live pi), documented under README "For development".

### Q1: e2e includes the replacement-precondition probe as a second scenario (advisor-resolved)

Ambiguity: FRD-minimum phases only, or add `new_session` (replacement) probing?

Decision: **include**, structured as two scenarios (not interleaved phases) so router-state persistence counts stay interpretable: Scenario 1 baseline (control → abort mid-classifier → post-abort probe → fresh-process recovery); Scenario 2 precondition (fresh spawn → control → `new_session` → `set_model` → abort → probe). Blocking verification completed: `set_model` (`rpc-mode.js:364-370`) + `get_state` (`:344`) re-select and assert the router profile across spawns and replacements. Interpretation rows (advisor): `router[abort]` line present with `dead=true` ⇒ flag tripped while the ctx plane still delivered (OQ2: ctxs stayed live); turn aborted + no line ⇒ dead egress plane (disambiguate: debug was on per the readiness beacon).

### Gate-4 phase marker: explicit `iifePhase` string (evidence-based)

Derived flags would mislabel the auth-throw path: `getApiKeyAndHeaders` (`provider.ts:605`) sits outside the per-candidate try, so its stale throw reaches gate 4 looking like a sync-step throw. Explicit `iifePhase` ∈ {entry, classifier, post-classifier, auth, delegation}; a handful of string assignments per turn (two per candidate on the auth/delegation transitions) — negligible, and not operand reads (the zero-cost rule targets reads/emissions/allocations on the untaken path). The gate-4 line also carries `lastError !== undefined` to separate the rethrown-delegation path.

### Line format and transport

`router[abort] <gate id> <operands>` via `lastExtensionContext.ui.notify(..., 'info')` — the existing debug surface. Operands read only inside taken branches; emit happens between the trip and `stream.push`, before `stream.end()`; never `addEventListener('abort')`.

### Two-turn guard contract (research §9, verbatim)

One `it()`; turn A: mocked compat `streamSimple` yields one `text_delta`, awaits a deferred gate, then throws AbortError; a real `AbortController` aborts before release; gate 1 fires on the signal branch. Turn B: fresh controller, fresh `MockEventStream`, order-dispatching mock (instant classifier yield, then delegated `text_delta` + `done` with usage 0.0015). Assert turn B resolves done (not aborted), last compat call went to the delegated target, `signal === controllerB.signal`, no error events, `accumulatedCost === 0.0015`, `persistState` called twice. Nothing in `mockState` reset between turns (a reset would mask exactly the sticky-state bugs this exists to catch). Turn B's delegated call indexed with `mock.calls.at(-1)` (the file's `beforeEach` clears once per test, not per call).

### e2e harness mechanics (all verified against 0.84.3)

Sandbox = temp `PI_CODING_AGENT_DIR` with minimal contents: copied `models.json` (inline keys carry) + generated `model-router.json` (debug:true; classifierModel `{model: "ollama-cloud/nemotron-3-nano:30b", thinking: "high"}`; `candidateTimeoutMs: 120000`; profile tier target from required env var `PI_MODEL_ROUTER_E2E_TARGET`). Extension loaded via `pi --mode rpc -e <repo>/extensions/index.ts`, cwd = temp workspace. `set_model` → `get_state` assertion selects/verifies the router profile. Turn-end detection = `get_state` poll until `isStreaming === false` with `messageCount` advance. Abort timing = half the control turn's prompt→`router → `notify latency. Every `select`/`confirm`/`input` `extension_ui_request` gets an automatic `extension_ui_response` (else the session hangs). Exit 0 when every turn completed with an interpretable shape (poisoned OR healthy are both valid findings); exit 1 on harness/protocol failure.

## Architecture

### extensions/provider.ts:199-215, 332-860 — MODIFY

Inline state type: add `readonly debugEnabled: boolean`. IIFE: hoisted entry-time snapshot (`signalAbortedAtEntry`), `classifierRan` flag, `iifePhase` marker, hoisted `lastError` declaration (moved up from :521), `debugAbort` helper, four gate-line emissions (between trip and push). Terminal-event push/end pairs unchanged.

```
// ── Section A: inline state type (~line 199-215) — add ONE field, after
// `readonly isExtensionContextDead: boolean;` (~line 201):
    readonly lastExtensionContext: ExtensionContext | undefined;
    readonly isExtensionContextDead: boolean;
    readonly debugEnabled: boolean;                    // ← NEW
    selectedProfile: string | undefined;

// ── Section B: debug emitter — insert immediately BEFORE
// `pi.registerProvider('router', {` (line 301), inside registerRouterProvider:
  // Debug emitter for the four abort exits. Deliberate deviation from
  // recordDebugDecision's guard (index.ts:132): NO isExtensionContextDead
  // check. Gate 1 can fire BECAUSE the flag is set, and the flag can be set
  // while the ctx still delivers (pi awaits session_shutdown handlers before
  // invalidating the runner; captureCtx can set it conservatively) — those
  // lines are the point of this instrumentation. The try/catch is
  // load-bearing under either guard: a TOCTOU throw (flag false, ctx dies
  // before notify) would otherwise skip this branch's stream.push and
  // reclassify the exit through the catch below as reason:'error' instead
  // of 'aborted'. Scoped: this helper only — recordDebugDecision,
  // updateStatus, and every other reader keep the strict guard.
  const debugAbort = (line: string): void => {
    if (!state.debugEnabled || !state.lastExtensionContext) return;
    try {
      state.lastExtensionContext.ui.notify(`router[abort] ${line}`, 'info');
    } catch {
      // Dead egress plane. Best-effort only — the abort exit still runs.
    }
  };

// ── Section C: IIFE top — insert BETWEEN line 332 `(async () => {`
// and line 333 `try {` (declarations hoisted above try: the gate-4 catch
// at ~:835 is a SIBLING scope and reads iifePhase/lastError):
      (async () => {
        // Entry-time signal snapshot: the IIFE body runs synchronously to
        // the first await, so this read is the truth at delegation entry.
        const signalAbortedAtEntry = options?.signal?.aborted === true;
        let classifierRan = false;
        let iifePhase = 'entry';
        let lastError: unknown;

        try {

// ── Section C2: DELETION — remove the now-hoisted declaration at
// line 521 (`let lastError: unknown;`). The :520-522 group keeps
// skipReasons and success unchanged:
          const skipReasons: string[] = [];
          let success = false;

// ── Section D: classifier region (~lines 358-372) — phase + flag:
          let classifierResult: ClassifierResult | undefined;
          if (!pinnedTier && state.currentConfig.classifierModel) {
            const classifierRefs = [
              state.currentConfig.classifierModel.model,
              ...(state.currentConfig.classifierModel.fallbacks ?? []),
            ];
            iifePhase = 'classifier';                  // ← NEW
            classifierResult = await runClassifier(
              classifierRefs,
              modelRegistry,
              context,
              state.lastDecision?.phase,
              state.currentConfig.classifierModel.thinking,
              hasImageAttachment(context), // pass image-present flag
              options?.signal,
              state.currentConfig.candidateTimeoutMs,
            );
            classifierRan = true;                      // ← NEW
          }
          iifePhase = 'post-classifier';               // ← NEW

// ── Section E: Gate 1 (~lines 377-388) — emit as FIRST statement of
// the taken branch (push/end/return unchanged):
          if (state.isExtensionContextDead || options?.signal?.aborted) {
            debugAbort(
              `gate1 profile=${model.id} dead=${state.isExtensionContextDead} signal=${options?.signal?.aborted === true} entry=${signalAbortedAtEntry} classifierRan=${classifierRan}`,
            );
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: createAbortedMessage(model),
            });
            stream.end();
            return;
          }

// ── Section F: phase before the tier chain (~lines 514-515):
          // Cross-tier fallback loop
          iifePhase = 'delegation';                    // ← NEW
          const tierChain = buildDelegationTierChain(

// ── Section G: Gate 2 (~lines 577-584, candidate-loop top) — emit as
// FIRST statement of the taken branch:
              if (state.isExtensionContextDead || options?.signal?.aborted) {
                debugAbort(
                  `gate2 loop-top profile=${model.id} tier=${currentTier} candidate=${i + 1}/${modelsToTry.length} dead=${state.isExtensionContextDead} signal=${options?.signal?.aborted === true}`,
                );
                stream.push({
                  type: 'error',
                  reason: 'aborted',
                  error: createAbortedMessage(model),
                });
                stream.end();
                return;
              }

// ── Section H: auth phase + Gate 3 (~lines 603-621) — `iifePhase = 'auth'`
// immediately BEFORE the auth await; emit as FIRST statement of gate 3's
// taken branch; `iifePhase = 'delegation'` immediately after the if-block:
              iifePhase = 'auth';                      // ← NEW
              const auth =
                await modelRegistry.getApiKeyAndHeaders(
                  targetModel,
                );

              if (state.isExtensionContextDead || options?.signal?.aborted) {
                debugAbort(
                  `gate3 post-auth profile=${model.id} tier=${currentTier} model=${targetProvider}/${targetModelId} dead=${state.isExtensionContextDead} signal=${options?.signal?.aborted === true}`,
                );
                stream.push({
                  type: 'error',
                  reason: 'aborted',
                  error: createAbortedMessage(model),
                });
                stream.end();
                return;
              }
              iifePhase = 'delegation';                // ← NEW

// ── Section I: Gate 4 catch (~lines 835-852) — emit as FIRST statement
// of the benign branch (the else branch and the trailing stream.end()
// are unchanged):
          if (isStaleCtx || isAborted) {
            debugAbort(
              `gate4 catch profile=${model.id} stale=${isStaleCtx} abort=${isAborted} phase=${iifePhase} delegated=${lastError !== undefined} name=${error instanceof Error ? error.name : typeof error} msg=${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
            );
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: createAbortedMessage(model),
            });
          } else {
```

### extensions/index.ts:301-360 — MODIFY

Provider facade literal: add `get debugEnabled()` over the existing closure variable. Nothing else in index.ts changes.

```
// Provider facade literal (~lines 301-360) — add ONE getter after
// `get isExtensionContextDead()` (~lines 320-321):
          get isExtensionContextDead() {
            return isExtensionContextDead;
          },
          get debugEnabled() {
            return debugEnabled;
          },
```

### extensions/provider.test.ts — MODIFY

Slice 2 adds the two-turn guard `it()` inside the `session replacement gates (dead flag / abort)` describe (`:1062+`). Slice 3 adds a sibling describe for emission tests. Shared helpers (`MockEventStream`, `terminated`, deferred gates, `makeModel`/`makeContext`) reused.

```
    // Two-turn sticky-state guard (FRD acceptance core): one ESC abort
    // mid-classifier must not poison the NEXT turn. Both turns run through
    // the SAME captured provider options and the SAME mockState — no reset
    // between turns (a reset would mask exactly the sticky-state bugs this
    // exists to catch: sticky dead flag, cached/reused signal, one-shot
    // abort latch, delegation skip).
    it('should recover on the next turn after a mid-classifier abort', async () => {
      // Shared, configured ONCE: the classifier runs in both turns (no pin —
      // a pin would skip the classifier entirely, see provider.ts pre-decision).
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };

      registerRouterProvider(mockPi, mockState, mockActions);

      // ── Turn A stream
      const streamA = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        streamA as any,
      );

      let releaseClassifier = () => {};
      const classifierGate = new Promise<void>((resolve) => {
        releaseClassifier = resolve;
      });

      // Order-dispatching mock: call 1 = turn A classifier (gated, then
      // AbortError), call 2 = turn B classifier (instant), call 3 = turn B
      // delegation (done). Both classifier calls target gpt-4o-mini
      // (classifierModel.model, no fallbacks); the 'medium' yield is
      // unparseable (no 'tier:' line) so runClassifier returns undefined and
      // decideRouting's short-prompt branch picks 'low' (wordCount 1 <= 12),
      // which is unconfigured in this profile — resolveAvailableTier falls
      // up to 'medium', so the delegated target is gpt-4o-mini
      // deterministically.
      let compatCall = 0;
      vi.mocked(streamSimple).mockImplementation((() => {
        compatCall++;
        if (compatCall === 1) {
          return (async function* () {
            yield { type: 'text_delta', delta: 'medium' };
            await classifierGate;
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            throw abortError;
          })() as any;
        }
        if (compatCall === 2) {
          return (async function* () {
            yield { type: 'text_delta', delta: 'medium' };
          })() as any;
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'delegated answer' };
          yield {
            type: 'done',
            message: { usage: { cost: { total: 0.0015 } } },
          };
        })() as any;
      }) as any);

      // ── Turn A: user ESC lands while the classifier is in flight.
      const controllerA = new AbortController();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controllerA.signal,
      } as any);
      await sleep(50);
      // Classifier call in flight; nothing decided yet.
      expect(vi.mocked(streamSimple).mock.calls.length).toBe(1);
      expect(mockState.lastDecision).toBeUndefined();

      controllerA.abort(); // ESC: signal aborted BEFORE the classifier finishes
      releaseClassifier(); // classifier completes (runClassifier swallows the AbortError, returns undefined)
      await sleep(100);

      // Turn A exited at gate 1 on the signal branch: terminal aborted event,
      // NO delegated call, decision never recorded, state persisted once.
      const abortedEvent = streamA.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );
      expect(abortedEvent).toBeDefined();
      expect(await terminated(streamA)).toBe(true);
      expect(vi.mocked(streamSimple).mock.calls.length).toBe(1);
      expect(mockState.lastDecision).toBeUndefined();
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);

      // ── Turn B: SAME provider options, SAME mockState (no reset), fresh
      // controller and fresh stream — exactly what pi does on the next turn.
      const streamB = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        streamB as any,
      );
      const controllerB = new AbortController();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controllerB.signal,
      } as any);
      await sleep(100);

      // Turn B recovers: classifier runs, delegation streams to done.
      expect(
        streamB.events.find((e: any) => e.type === 'error'),
      ).toBeUndefined();
      const calls = vi.mocked(streamSimple).mock.calls;
      expect(calls.length).toBe(3); // A-classifier + B-classifier + B-delegate
      const delegateCall = calls[calls.length - 1];
      expect(delegateCall[0].id).toBe('gpt-4o-mini'); // delegated target
      expect((delegateCall[2] as any).signal).toBe(controllerB.signal); // fresh signal — NOT turn A's
      const doneMessage = await streamB.result();
      expect(doneMessage.usage.cost.total).toBe(0.0015); // resolved done, not aborted
      expect(await terminated(streamB)).toBe(true);
      expect(mockState.isExtensionContextDead).toBe(false); // no sticky flag write
      expect(mockState.accumulatedCost).toBe(0.0015); // turn A contributed nothing
      expect(mockActions.persistState).toHaveBeenCalledTimes(2); // exactly once per turn
    });
```

```
  // Slice 3: per-exit emission tests — sibling describe, inserted AFTER the
  // closing `});` of `describe('session replacement gates (dead flag / abort)')`,
  // inside the `registerRouterProvider` describe. Helpers are local per file
  // convention (the gates describe scopes its own; only MockEventStream is
  // module-level). Pure addition: the existing suites stay byte-identical.
  describe('abort-gate debug emission (router[abort] lines)', () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // Same contract mirror as the gates suite: true only when a terminal
    // event resolved result(). Races a timeout so a bare-end() regression
    // fails fast instead of stalling the suite.
    const terminated = (stream: MockEventStream, ms = 500) =>
      Promise.race([
        stream.result().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), ms),
        ),
      ]);

    const makeModel = () =>
      ({ id: 'balanced', api: 'router-api', provider: 'router' }) as any;
    const makeContext = () =>
      ({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    // Debug on + a notify spy as the emission surface. The default ui mock
    // (beforeEach, ~:119-122) has no notify — every emission test provides a
    // callable one so assertions can see (or prove the absence of) gate lines.
    const enableDebugEmission = (notifyImpl?: () => void) => {
      const notify = vi.fn(notifyImpl);
      mockState.debugEnabled = true;
      mockState.lastExtensionContext = {
        ui: { notify, setHiddenThinkingLabel: vi.fn() },
      };
      return notify;
    };
    const gateLines = (notify: ReturnType<typeof vi.fn>) =>
      notify.mock.calls
        .map((call: any) => String(call[0]))
        .filter((line: string) => line.startsWith('router[abort]'));
    const abortedEventOf = (stream: MockEventStream) =>
      stream.events.find(
        (e: any) => e.type === 'error' && e.reason === 'aborted',
      );

    it('emits one router[abort] gate1 line with the operand snapshot on a signal-aborted turn', async () => {
      const notify = enableDebugEmission();
      // Classifier configured: the instant compat mock completes it, so the
      // line pins the post-await classifierRan wiring (the flag is set only
      // after runClassifier resolves — provider.ts slice-1 section D).
      mockState.currentConfig.classifierModel = {
        model: 'openai/gpt-4o-mini',
        thinking: 'low',
      };
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );
      vi.mocked(streamSimple).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', delta: 'medium' };
        })() as any,
      );

      const controller = new AbortController();
      controller.abort(); // ESC before the turn starts: entry=true
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      // Exactly one gate line, through the info notify transport.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/^router\[abort\] gate1 /),
        'info',
      );
      const [line] = gateLines(notify);
      expect(line).toContain('profile=balanced');
      expect(line).toContain('dead=false');
      expect(line).toContain('signal=true');
      expect(line).toContain('entry=true');
      expect(line).toContain('classifierRan=true');
      // Turn still ends through the original gate-1 exit.
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate2 line when a replacement kill stops the candidate retry', async () => {
      const notify = enableDebugEmission();
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

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

      // Pin medium: [gpt-4o-mini, gemini-1.5-flash].
      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(50);
      expect(attempts).toEqual(['gpt-4o-mini']);

      // Replacement lands mid-stream: flag set, delegated stream aborted.
      mockState.isExtensionContextDead = true;
      releaseDelegated();
      await sleep(100);

      // The per-candidate catch swallows the AbortError (provider.ts:769-772);
      // the retry is stopped by the loop-top gate — exactly what emits here.
      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate2 loop-top');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('tier=medium');
      expect(line).toContain('candidate=2/2');
      expect(line).toContain('dead=true');
      expect(line).toContain('signal=false');
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(attempts).toEqual(['gpt-4o-mini']); // candidate 2 never opened
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate3 line when a replacement lands during the auth await', async () => {
      const notify = enableDebugEmission();
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

      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate3 post-auth');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('tier=medium');
      expect(line).toContain('model=openai/gpt-4o-mini');
      expect(line).toContain('dead=true');
      expect(line).toContain('signal=false');
      expect(vi.mocked(streamSimple)).not.toHaveBeenCalled();
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate4 line for a direct AbortError into the catch', async () => {
      const notify = enableDebugEmission();
      // AbortError thrown before the delegation loop (syncPiThinkingLevel
      // runs pre-chain at provider.ts:504): phase stays 'post-classifier'
      // and lastError is unset — delegated=false.
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
      await sleep(50);

      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate4 catch');
      expect(line).toContain('profile=balanced');
      expect(line).toContain('stale=false');
      expect(line).toContain('abort=true');
      expect(line).toContain('phase=post-classifier');
      expect(line).toContain('delegated=false');
      expect(line).toContain('name=AbortError');
      expect(line).toContain('msg=The operation was aborted');
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('emits router[abort] gate4 line with delegated=true when an exhausted chain rethrows a swallowed AbortError', async () => {
      const notify = enableDebugEmission();
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const attempts: string[] = [];
      vi.mocked(streamSimple).mockImplementation(((model: any) => {
        attempts.push(model.id);
        return (async function* () {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          throw abortError;
        })() as any;
      }) as any);

      mockState.pinnedTierByProfile['balanced'] = 'medium';

      registeredProviderOptions.streamSimple(makeModel(), makeContext());
      await sleep(100);

      // No abort state is set, so the loop-top gate lets every candidate
      // open; each candidate's AbortError is swallowed into lastError, the chain
      // exhausts, and `throw lastError` re-enters the catch (delegated=true
      // — the arm the poison research flagged as indistinguishable without
      // the phase/delegated markers).
      expect(attempts).toEqual([
        'gpt-4o-mini',
        'gemini-1.5-flash',
        // Up-chain: medium is not budget-capped, so after both medium
        // candidates throw, the chain reaches the configured high tier.
        'gpt-4o',
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      const [line] = gateLines(notify);
      expect(line).toContain('gate4 catch');
      expect(line).toContain('stale=false');
      expect(line).toContain('abort=true');
      expect(line).toContain('phase=delegation');
      expect(line).toContain('delegated=true');
      expect(line).toContain('name=AbortError');
      // Name-based classification keeps the rethrow benign — not reason:'error'.
      const errorEvent = stream.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.reason).toBe('aborted');
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('stays inert with debug off: no notify, terminal contract unchanged', async () => {
      // Explicit off (the default mockState omits the key — falsy — the
      // explicit flag documents the contract under test): the emitter must
      // short-circuit before touching ui, and the gate exit must behave
      // exactly as pre-instrumentation.
      mockState.debugEnabled = false;
      const notify = vi.fn();
      mockState.lastExtensionContext = {
        ui: { notify, setHiddenThinkingLabel: vi.fn() },
      };
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      controller.abort();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      expect(notify).not.toHaveBeenCalled();
      expect(abortedEventOf(stream)).toBeDefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });

    it('swallows a dead-egress notify throw: gate-1 classification survives, no gate-4 re-emit', async () => {
      // TOCTOU shape (D1): the guard passed (debug on, ctx present) but the
      // egress plane died before notify ran. The emitter's try/catch must
      // swallow so the ORIGINAL gate's push still lands — an escaping throw
      // would skip the branch's stream.push and reclassify through gate 4
      // as reason:'error' (the d793dbde regression class).
      const notify = enableDebugEmission(() => {
        throw new Error('egress plane dead');
      });
      registerRouterProvider(mockPi, mockState, mockActions);
      const stream = new MockEventStream();
      vi.mocked(createAssistantMessageEventStream).mockReturnValue(
        stream as any,
      );

      const controller = new AbortController();
      controller.abort();
      registeredProviderOptions.streamSimple(makeModel(), makeContext(), {
        signal: controller.signal,
      } as any);
      await sleep(50);

      // Gate 1 attempted its emit exactly once; the throw was contained. A
      // gate-4 reclassification would emit a second line (debug still on,
      // ctx still set), so call count 1 IS the no-reclassification proof.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(String(notify.mock.calls[0][0])).toMatch(
        /^router\[abort\] gate1 /,
      );
      expect(abortedEventOf(stream)).toBeDefined();
      expect(
        stream.events.find(
          (e: any) => e.type === 'error' && e.reason === 'error',
        ),
      ).toBeUndefined();
      expect(await terminated(stream)).toBe(true);
      expect(mockActions.persistState).toHaveBeenCalledTimes(1);
    });
  });
```

### scripts/e2e-esc-abort.mjs — NEW

Plain Node (no deps): sandbox setup, JSONL RPC client (request map, event log, dialog auto-reply), turn runner, two scenarios, report.

```
#!/usr/bin/env node
// ESC-abort poison e2e — two scenarios against the real global pi (RPC mode).
//
// Scenario 1 (baseline abort): control turn → abort at ~50% of the control
//   turn's latency (untargeted mid-turn window) → post-abort probe →
//   fresh-process recovery probe.
// Scenario 2 (replacement precondition): fresh spawn → control turn →
//   new_session → set_model → abort mid-turn → probe turn.
//
// Protocol facts (pi 0.84.3, dist/modes/rpc/rpc-mode.js): requests are
// {id, type, ...}; responses {id, type:'response', command, success, data?};
// session events stream through as-is; extension notify surfaces as
// extension_ui_request {method:'notify'} with NO reply needed, while
// select/confirm/input dialogs DO need extension_ui_response replies. The
// prompt command's response fires at preflight — turn completion is detected
// by get_state polling (isStreaming false + messageCount advanced).
//
// Sandbox: a temp PI_CODING_AGENT_DIR holding a copy of your models.json
// (inline API keys carry over) plus a generated model-router.json. Your real
// agent dir is read for models.json and nothing else; sessions live in the
// sandbox. The repo extension is loaded via -e <repo>/extensions/index.ts.
//
// Usage:
//   PI_MODEL_ROUTER_E2E_TARGET=x-ai/grok-4-fast node scripts/e2e-esc-abort.mjs
//   PI_MODEL_ROUTER_E2E_KEEP=1  → keep the sandbox directory for inspection.
// Exit 0: every turn completed with an interpretable shape (poisoned or
// healthy are both findings). Exit 1: harness/protocol failure.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_VERSION_PREFIX = '0.84.';
const CLASSIFIER_MODEL = 'ollama-cloud/nemotron-3-nano:30b';
const CANDIDATE_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = CANDIDATE_TIMEOUT_MS + 120_000;
const BEACON_TIMEOUT_MS = 60_000;
const RPC_SEND_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const PROMPT_CONTROL =
  'Summarize the tradeoffs between REST and GraphQL for a small team, then recommend one.';
const PROMPT_PROBE =
  'Name three practical benefits of writing automated tests, with one sentence each.';

const TARGET = process.env.PI_MODEL_ROUTER_E2E_TARGET;
if (!TARGET || !TARGET.includes('/')) {
  console.error(
    'PI_MODEL_ROUTER_E2E_TARGET must be set to a provider/model ref, e.g. x-ai/grok-4-fast',
  );
  process.exit(1);
}

const IS_WIN = process.platform === 'win32';
// Repo paths must not contain spaces: Windows spawns pi through cmd.exe
// (shell mode) and the args are passed unquoted.
const EXTENSION_ENTRY = fileURLToPath(
  new URL('../extensions/index.ts', import.meta.url),
);
const SOURCE_MODELS_JSON = join(homedir(), '.pi', 'agent', 'models.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── pi resolution + version-skew guard ─────────────────────────────────────
const piCommand = () => (IS_WIN ? 'pi.cmd' : 'pi');

const runPiCapture = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(piCommand(), args, { shell: IS_WIN });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });

// ── sandbox ────────────────────────────────────────────────────────────────
const makeSandbox = () => {
  if (!existsSync(SOURCE_MODELS_JSON)) {
    throw new Error(`models.json not found at ${SOURCE_MODELS_JSON}`);
  }
  const root = join(
    tmpdir(),
    `pi-router-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const agentDir = join(root, 'agentdir');
  const workspace = join(root, 'workspace');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  copyFileSync(SOURCE_MODELS_JSON, join(agentDir, 'models.json'));
  writeFileSync(
    join(agentDir, 'model-router.json'),
    JSON.stringify(
      {
        debug: true,
        classifierModel: { model: CLASSIFIER_MODEL, thinking: 'high' },
        candidateTimeoutMs: CANDIDATE_TIMEOUT_MS,
        // Every tier delegates to the same target so any routing outcome is
        // comparable across turns.
        profiles: {
          auto: {
            high: { model: TARGET },
            medium: { model: TARGET },
            low: { model: TARGET },
          },
        },
      },
      null,
      2,
    ),
  );
  return { root, agentDir, workspace };
};

// ── RPC client ─────────────────────────────────────────────────────────────
class RpcClient {
  constructor(agentDir, workspace) {
    this.pending = new Map();
    this.notifies = [];
    this.events = [];
    this.dialogs = [];
    this.uiRequests = [];
    this.closed = false;
    this.spawnError = null;
    this.child = spawn(
      piCommand(),
      ['--mode', 'rpc', '-e', EXTENSION_ENTRY],
      {
        cwd: workspace,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        shell: IS_WIN,
      },
    );
    this.exitPromise = new Promise((resolve) => {
      this.child.on('close', resolve);
    });
    this.child.on('error', (err) => {
      this.spawnError = err;
    });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) =>
      process.stderr.write(`[pi] ${chunk}`),
    );
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'response') {
      const settle = this.pending.get(msg.id);
      if (settle) {
        this.pending.delete(msg.id);
        settle(msg);
      }
      return;
    }
    if (msg.type === 'extension_ui_request') {
      if (msg.method === 'notify') {
        this.notifies.push({
          message: msg.message,
          notifyType: msg.notifyType,
        });
        return;
      }
      // select/confirm/input/editor need a reply or the session hangs;
      // cancelled resolves select/input/editor to undefined, confirm to
      // false. Fire-and-forget ui requests (setStatus, setTitle, setWidget,
      // set_editor_text) need no reply — counted, never answered.
      if (
        msg.method === 'select' ||
        msg.method === 'confirm' ||
        msg.method === 'input' ||
        msg.method === 'editor'
      ) {
        this.dialogs.push(msg.method);
        this.child.stdin.write(
          `${JSON.stringify({ type: 'extension_ui_response', id: msg.id, cancelled: true })}\n`,
        );
      } else {
        this.uiRequests.push(msg.method);
      }
      return;
    }
    this.events.push(msg);
  }

  send(type, extra = {}) {
    if (this.spawnError) throw this.spawnError;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`rpc send timeout: ${type}`));
        }
      }, RPC_SEND_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end(); // rpc-mode shuts down on stdin end
    const exited = await Promise.race([
      this.exitPromise,
      sleep(5_000).then(() => false),
    ]);
    if (exited === false && IS_WIN && this.child.pid) {
      // cmd.exe wrappers may not propagate signals on Windows — kill the tree.
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
      await Promise.race([this.exitPromise, sleep(3_000)]);
    }
  }
}

// ── session helpers ────────────────────────────────────────────────────────
const getState = async (rpc) => (await rpc.send('get_state')).data;

const beaconCount = (rpc) =>
  rpc.notifies.filter((n) =>
    n.message.startsWith('Router initialized with profiles:'),
  ).length;

const waitFor = async (label, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(POLL_MS);
  }
};

const selectRouter = async (rpc) => {
  const res = await rpc.send('set_model', {
    provider: 'router',
    modelId: 'auto',
  });
  if (!res.success) {
    throw new Error(
      `set_model router/auto failed: ${res.error} (extension did not register — check [pi] stderr above)`,
    );
  }
  const state = await getState(rpc);
  if (state.model?.provider !== 'router') {
    throw new Error(
      `get_state.model.provider=${state.model?.provider}, expected 'router'`,
    );
  }
};

const runTurn = async (rpc, label, promptText, { abortAfterMs } = {}) => {
  if (rpc.spawnError) throw rpc.spawnError;
  const notifyStart = rpc.notifies.length;
  const before = await getState(rpc);
  const count0 = before.messageCount;
  const tPrompt = Date.now();
  const promptRes = await rpc.send('prompt', { message: promptText });
  if (!promptRes.success) {
    throw new Error(`prompt rejected on ${label}: ${promptRes.error}`);
  }

  if (abortAfterMs !== undefined) {
    await sleep(abortAfterMs);
    const abortRes = await rpc.send('abort');
    if (!abortRes.success) {
      throw new Error(`abort failed on ${label}: ${abortRes.error}`);
    }
  }

  let decisionLatencyMs = null;
  const settle = await waitFor(
    `${label} settle`,
    async () => {
      if (decisionLatencyMs === null) {
        const arrived = rpc.notifies
          .slice(notifyStart)
          .some((n) => n.message.startsWith('router → '));
        if (arrived) decisionLatencyMs = Date.now() - tPrompt;
      }
      const s = await getState(rpc);
      // A turn adds the user message AND the assistant message. Requiring
      // both to have landed closes the race where only the user message is
      // in and the row would read the previous turn's assistant message.
      return !s.isStreaming && s.messageCount >= count0 + 2 ? s : null;
    },
    TURN_TIMEOUT_MS,
  );
  await sleep(300); // let message_end + persistence land

  const messages = (await rpc.send('get_messages')).data.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant');
  const entries = (await rpc.send('get_entries')).data.entries;
  const routerStateCount = entries.filter(
    (e) => e.type === 'custom' && e.customType === 'router-state',
  ).length;
  const turnNotifies = rpc.notifies
    .slice(notifyStart)
    .map((n) => n.message);
  return {
    label,
    provider: lastAssistant?.provider ?? null,
    stopReason: lastAssistant?.stopReason ?? null,
    cost: lastAssistant?.usage?.cost?.total ?? null,
    contentChars: (lastAssistant?.content ?? []).reduce(
      (sum, part) => sum + (part.type === 'text' ? part.text.length : 0),
      0,
    ),
    messageCount: settle.messageCount,
    routerStateCount,
    decisionLine: turnNotifies.find((m) => m.startsWith('router → ')) ?? null,
    gateLines: turnNotifies.filter((m) => m.startsWith('router[abort]')),
    decisionLatencyMs,
  };
};

const spawnRouted = async (sandbox) => {
  const rpc = new RpcClient(sandbox.agentDir, sandbox.workspace);
  await waitFor(
    'readiness beacon (Router initialized with profiles: …)',
    async () => {
      if (rpc.spawnError) throw rpc.spawnError;
      return beaconCount(rpc) > 0;
    },
    BEACON_TIMEOUT_MS,
  );
  await selectRouter(rpc);
  return rpc;
};

const scenarioBaseline = async (sandbox) => {
  const turns = [];
  const rpc = await spawnRouted(sandbox);
  try {
    turns.push(await runTurn(rpc, 'S1 control', PROMPT_CONTROL));
    // decisionLatencyMs is prompt → 'router → ' notify = FULL-turn latency
    // (that notify fires after the delegated stream resolves), so the abort
    // lands somewhere mid-turn — not pinned to the classifier phase.
    const abortDelay = Math.max(
      500,
      Math.floor((turns[0].decisionLatencyMs ?? 4_000) / 2),
    );
    turns.push(
      await runTurn(rpc, 'S1 abort (mid-turn)', PROMPT_CONTROL, {
        abortAfterMs: abortDelay,
      }),
    );
    turns.push(await runTurn(rpc, 'S1 probe (poisoned?)', PROMPT_PROBE));
  } finally {
    await rpc.close();
  }
  // Fresh-process recovery probe (same sandbox, new session): isolates any
  // poison to the previous process — mirrors the /reload workaround.
  const fresh = await spawnRouted(sandbox);
  try {
    turns.push(
      await runTurn(fresh, 'S1 recovery (fresh process)', PROMPT_PROBE),
    );
  } finally {
    await fresh.close();
  }
  return turns;
};

const scenarioReplacement = async (sandbox) => {
  const turns = [];
  const rpc = await spawnRouted(sandbox);
  try {
    turns.push(await runTurn(rpc, 'S2 control', PROMPT_CONTROL));
    const abortDelay = Math.max(
      500,
      Math.floor((turns[0].decisionLatencyMs ?? 4_000) / 2),
    );

    // The precondition under test: replace the session, like the subagent-era
    // replacement in the bug session, then re-select the router profile.
    const ns = await rpc.send('new_session');
    if (!ns.success) throw new Error(`new_session failed: ${ns.error}`);
    const beaconsBefore = beaconCount(rpc);
    await waitFor(
      'post-replacement beacon',
      async () => {
        if (rpc.spawnError) throw rpc.spawnError;
        return beaconCount(rpc) > beaconsBefore;
      },
      BEACON_TIMEOUT_MS,
    );
    await selectRouter(rpc);

    turns.push(
      await runTurn(rpc, 'S2 abort (post-replacement)', PROMPT_CONTROL, {
        abortAfterMs: abortDelay,
      }),
    );
    turns.push(await runTurn(rpc, 'S2 probe (poisoned?)', PROMPT_PROBE));
  } finally {
    await rpc.close();
  }
  return turns;
};

const INTERPRETATION = `Interpretation (research Open Questions 1-3; "gate line" = router[abort] … notify):
  OQ1 — which exit fired: a captured gate line names it directly.
    gate1 dead=true        ⇒ gate 1 tripped on the dead-flag operand.
    gate4 catch stale=true ⇒ the catch's stale-ctx arm (post-classifier sync step).
  OQ2 — what ESC added: abort turn shows a gate line ⇒ the notify plane was
    still alive after the abort (per-event ctxs stayed live). Abort turn ended
    aborted with NO gate line while the beacon proved debug on ⇒ the extension
    egress plane was already dead.
  OQ3 — what broke appendEntry: routerStateEntries stops advancing across
    healthy turns (per session) ⇒ the silent-persistence signature; inspect
    the sandbox session file when PI_MODEL_ROUTER_E2E_KEEP=1.
  Precondition: probe poisoned in S1 ⇒ a plain ESC abort suffices (pi bug).
    Probe poisoned only in S2 ⇒ replacement is the required precondition.
    Probe healthy in both ⇒ this harness cannot reach the wild signature; the
    two-turn unit guard + in-the-wild gate lines carry the rest.`;

const printReport = (turns) => {
  console.log('\n══════════ e2e report ══════════');
  for (const t of turns) {
    console.log(`\n${t.label}`);
    console.log(
      `  provider=${t.provider} stopReason=${t.stopReason} cost=${t.cost ?? '—'} contentChars=${t.contentChars}`,
    );
    console.log(
      `  routerStateEntries=${t.routerStateCount} decision=${t.decisionLine ?? '(none)'}`,
    );
    for (const line of t.gateLines) console.log(`  GATE LINE: ${line}`);
  }
  console.log(`\n${INTERPRETATION}`);
};

const main = async () => {
  let version;
  try {
    version = await runPiCapture(['--version']);
  } catch (err) {
    console.error(`pi not found on PATH (${err.message})`);
    process.exit(1);
  }
  if (!version.startsWith(PI_VERSION_PREFIX)) {
    console.error(
      `pi on PATH is "${version}" — this harness targets ${PI_VERSION_PREFIX}x`,
    );
    process.exit(1);
  }
  console.log(
    `pi ${version} OK; target=${TARGET}; classifier=${CLASSIFIER_MODEL}`,
  );

  const sandbox = makeSandbox();
  console.log(`sandbox: ${sandbox.root}`);
  const turns = [];
  let failed = false;
  try {
    turns.push(...(await scenarioBaseline(sandbox)));
    turns.push(...(await scenarioReplacement(sandbox)));
  } catch (err) {
    console.error(`\n[harness] ${err.message}`);
    failed = true;
  } finally {
    printReport(turns);
    if (process.env.PI_MODEL_ROUTER_E2E_KEEP) {
      console.log(`\nsandbox kept: ${sandbox.root}`);
    } else {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error(`[harness] unexpected: ${err?.stack ?? err}`);
  process.exit(1);
});
```

### README.md — MODIFY

Short paragraph under "### For development": invocation, required env var, what it does, expected runtime.

````
Run the ESC-abort e2e harness (needs `pi` 0.84.x on PATH, network access, and a reachable target model):

```bash
PI_MODEL_ROUTER_E2E_TARGET=x-ai/grok-4-fast node scripts/e2e-esc-abort.mjs
```

The harness spawns the global `pi` in RPC mode inside a sandboxed `PI_CODING_AGENT_DIR` (a copy of your `models.json` plus a generated `model-router.json` — your real agent dir, sessions, and config are never touched). It reproduces the abort-poison class two ways: a plain mid-turn abort (at ~50% of the control turn's latency — the window is untargeted), and an abort after a `new_session` replacement. For every turn it reports the terminal shape, any `router[abort]` gate-line evidence, and router-state persistence counts, then prints an interpretation table. `PI_MODEL_ROUTER_E2E_TARGET` (required) is the `provider/model` ref every tier delegates to. Set `PI_MODEL_ROUTER_E2E_KEEP=1` to keep the sandbox for inspection. Exit 0 means every turn completed with an interpretable shape; exit 1 means a harness/protocol failure. A full run takes roughly two to five minutes, depending on classifier and target-model latency.
````

## Slices

### Slice 1: debugEnabled facade + abort-gate instrumentation

**Files**: `extensions/provider.ts`, `extensions/index.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Tests pass (existing 8-test gate suite + `createAbortedMessage` unit stay green; instrumentation inert with debug off): `npm test`
- [ ] `grep -c "debugAbort" extensions/provider.ts` returns 5 (1 definition + 4 exit call sites)
- [ ] `grep -c "reason: 'aborted'" extensions/provider.ts` returns 4 (terminal-event contract untouched)
- [ ] `grep -c "get debugEnabled" extensions/index.ts` returns 2 (commands facade at HEAD `index.ts:513` + new provider facade getter)

#### Manual Verification:
- [ ] With debug on, a signal-aborted router turn notifies exactly one `router[abort] gate1 ...` line naming dead/signal/entry/classifierRan
- [ ] With debug off, no `router[abort]` lines appear and turn behavior is byte-identical to pre-slice behavior

### Slice 2: two-turn sticky-state guard (FRD acceptance core)

**Files**: `extensions/provider.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Targeted provider suite passes including the new guard: `npx vitest run extensions/provider.test.ts`
- [ ] Guard present exactly once: `grep -c "should recover on the next turn after a mid-classifier abort" extensions/provider.test.ts` returns 1
- [ ] Last-call indexing contract pinned: `grep -c "calls\[calls.length - 1\]" extensions/provider.test.ts` returns >= 1

#### Manual Verification:
- [ ] Sabotage check (signal reuse): scratch-edit extensions/provider.ts so the delegated call reuses a hoisted/cached signal instead of the current options — the new guard fails on `signal === controllerB.signal`; revert
- [ ] Sabotage check (sticky flag): scratch-edit the gate-1 exit in extensions/provider.ts to set `state.isExtensionContextDead = true` (cast as any) before returning — the new guard fails on turn B (aborted event appears); revert
- [ ] New test runtime stays well under vitest's 5s default timeout (three sleeps total ~250ms)

### Slice 3: per-exit emission tests

**Files**: `extensions/provider.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npm run tsc`
- [ ] Targeted provider suite passes with the new emission describe: `npx vitest run extensions/provider.test.ts`
- [ ] Emission suite present exactly once: `grep -c "abort-gate debug emission" extensions/provider.test.ts` returns 1
- [ ] All four exits asserted: `grep -cE "gate[1-4]" extensions/provider.test.ts` returns >= 6
- [ ] Debug-off contract pinned by name: `grep -c "stays inert with debug off" extensions/provider.test.ts` returns 1
- [ ] Dead-egress swallow contract pinned by name: `grep -c "swallows a dead-egress notify throw" extensions/provider.test.ts` returns 1

#### Manual Verification:
- [ ] Run the describe alone: `npx vitest run extensions/provider.test.ts -t "abort-gate debug emission"` — 7 tests pass
- [ ] `git diff extensions/provider.test.ts` shows only additions (slice-2 guard + this describe); the eight existing gate tests and all earlier tests stay byte-identical
- [ ] Operand coverage spot-check against the slice-1 Architecture fence formats (not the Desired End State examples): gate1 asserts dead/signal/entry/classifierRan, gate2 tier/candidate, gate3 model, gate4 phase/delegated/name/msg

### Slice 4: e2e harness + README

**Files**: `scripts/e2e-esc-abort.mjs`, `README.md`

#### Automated Verification:
- [ ] Baseline type check passes with the new script present: `npm run tsc`
- [ ] Baseline test suite passes: `npm test`
- [ ] Script parses: `node --check scripts/e2e-esc-abort.mjs` exits 0
- [ ] Gate-line contract captured: `grep -c "router\[abort\]" scripts/e2e-esc-abort.mjs` returns >= 1
- [ ] Version-skew guard present: `grep -c "0.84" scripts/e2e-esc-abort.mjs` returns >= 1
- [ ] Sandbox isolation pinned: `grep -c "PI_CODING_AGENT_DIR" scripts/e2e-esc-abort.mjs` returns >= 2
- [ ] Harness documented: `grep -c "PI_MODEL_ROUTER_E2E_TARGET" README.md` returns >= 1
- [ ] `errorMessage` never read as exit evidence (renderer-stamped, zero provenance): `grep -c "errorMessage" scripts/e2e-esc-abort.mjs` returns 0

#### Manual Verification:
- [ ] Fast fail without env: `node scripts/e2e-esc-abort.mjs` exits 1 with the usage message and creates no sandbox
- [ ] Full run: `PI_MODEL_ROUTER_E2E_TARGET=<cheap reachable provider/model> node scripts/e2e-esc-abort.mjs` prints all 7 turn rows + interpretation table, exits 0
- [ ] Every abort turn row shows either a captured `router[abort]` gate line or the report explains its absence (beacon proved debug on)
- [ ] With `PI_MODEL_ROUTER_E2E_KEEP=1`: kept sandbox contains `agentdir/models.json`, `agentdir/model-router.json` (debug true, classifier `ollama-cloud/nemotron-3-nano:30b`, all tiers → TARGET), and `agentdir/sessions/`
- [ ] Real agent dir untouched after a run: `~/.pi/agent/model-router.json` unchanged

## Desired End State

A developer reproducing the poison class sees, with debug on, one line per abort exit naming the gate and its operands, e.g.:

```
router[abort] gate1 profile=balanced dead=true signal=false entry=false classifierRan=true
router[abort] gate4 catch profile=balanced stale=true abort=false phase=post-classifier delegated=false name=Error msg=This extension ctx is stale after session replacement
```

The e2e run:

```
PI_MODEL_ROUTER_E2E_TARGET=x-ai/grok-4-fast node scripts/e2e-esc-abort.mjs
```

produces a per-turn report: control turn (delegated, router-state persisted), abort turn (terminal shape + any `router[abort]` line verbatim), probe turn (healthy vs poisoned), replacement scenario, recovery — with an interpretation table mapping observed shapes to research Open Questions 1–3.

The guard test fails if any of: sticky dead flag, cached/reused signal, one-shot abort latch, bare-`end()` terminal regression, or delegation skip ever reappear at the `streamSimple` seam.

## File Map

- `extensions/provider.ts`  # MODIFY — inline type field, debugAbort, snapshot/flag/phase, 4 gate lines
- `extensions/index.ts`  # MODIFY — one getter on the provider facade
- `extensions/provider.test.ts`  # MODIFY — two-turn guard (slice 2) + emission tests (slice 3)
- `scripts/e2e-esc-abort.mjs`  # NEW — two-scenario RPC e2e harness
- `README.md`  # MODIFY — dev-workflow paragraph for the harness

## Ordering Constraints

- Slice 1 before all others (facade field + emitter are the dependency; line format is the e2e's grep target).
- Slice 2 (guard) before Slice 3 (emission tests) — risk ordering: the FRD acceptance core locks first; both touch the same test file sequentially.
- Slice 4 last (greps slice 1's line format; baseline `npm run tsc` + `npm test` checks ride this slice).
- No parallelism — all four slices touch or depend on the provider seam.

## Verification Notes

- Existing gate suite must stay green untouched: eight tests at `provider.test.ts:1062-1394` + `createAbortedMessage` unit (`:156-164`). `mockState` omits `debugEnabled` ⇒ falsy ⇒ instrumentation inert in those tests (guard is load-bearing; the dead-ctx swallow test makes this contract explicit).
- Terminal-event contract: every abort exit must still push `{type:'error', reason:'aborted'} + end()`; `terminated(stream)` races a 500 ms timeout (d793dbde class). The dead-ctx swallow test asserts the ORIGINAL gate's classification survives an emit failure.
- Mock fidelity at the seam is the historical failure mode (bare `end()` hang; 0.80.1 mocks vs 0.84.3 runtime). Unit results are contract-shape checks only; the e2e targets the global install: `C:/nvm4w/nodejs/pi` — verified 0.84.3. Repo `node_modules/@earendil-works/*` are stale 0.80.1 — never cite.
- Version-skew guard for the e2e: resolve pi via `pi` on PATH and assert `--version` starts with `0.84.` before spawning (fail fast with the found version).
- `routing.test.ts` has no mock clearing — irrelevant to this design's files, but any future cross-file mock copying must re-check indexing.
- Prior plan debt this pays: live checks deferred at `.rpiv/artifacts/plans/2026-09-05_12-33-55_router-hang-terminal-events.md:747`; all manual ESC boxes unchecked in `.rpiv/artifacts/validation/2026-09-05_13-07-25_spinner-hang-dead-esc-terminal-events-signal-timeout-plumbing.md`.
- `errorMessage` on aborted messages is renderer-stamped (`interactive-mode.js:2656-2662`) — never read it as exit evidence in the e2e report or tests.
- RPC protocol cautions (verified): top-level `type` envelopes; `prompt`'s response fires early (preflight) — turn completion must be detected via `get_state` polling, not the prompt response; dialogs need `extension_ui_response` replies.

## Performance Considerations

- Debug off: a taken gate exit pays the `debugAbort` call and builds its operand string (4–6 template interpolations) before the helper's guard returns; `lastExtensionContext` and `ui` are never touched. Healthy turns take no gate exit, so the common path is untouched.
- `iifePhase`: a handful of string assignments per turn (two per candidate on the auth/delegation transitions) — negligible; justified under the phase-marker decision (not an operand read).
- No `addEventListener('abort')` (allocation + leak risk).
- e2e: manual-run only; no CI cost; single sandbox per run, cleaned up unless `PI_MODEL_ROUTER_E2E_KEEP` is set.

## Migration Notes

Not applicable — no persisted-schema change. `debugEnabled` is already part of `RouterPersistedState` (types.ts:128, state.ts:242); gate lines are notify-only; `scripts/` is outside the tsc `include` and vitest default globs.

## Pattern References

- `extensions/index.ts:128-156` — recordDebugDecision: the debug-surface guard pattern (strict form) and notify idiom the emitter deliberately diverges from (see D1).
- `extensions/provider.test.ts:7-58` — MockEventStream: the terminal-event contract mirror (bare `end()` does not resolve `result()`).
- `extensions/provider.test.ts:1062-1394` — gate suite: `terminated()` helper, deferred-gate idiom (`midStreamGate`/`authGate`/`classifierGate`), per-operand kill simulation.
- `extensions/routing.ts:698-787` — runClassifier: classifier calls flow through the same mocked compat `streamSimple`; per-ref swallow; `undefined` on exhaustion.
- `dist/modes/rpc/rpc-mode.js:292-344` (global 0.84.3) — envelope shape, `prompt`/`abort`/`new_session`/`get_state`/`set_model`.
- `extensions/config.ts:544-553` — loadRouterConfig: global (`getAgentDir`) + project merge; sandbox writes the global path only.

## Developer Context

**Q (Step 4 directional): gate-line emission guard — follow recordDebugDecision strictly, or drop the dead-flag check + add try/catch?**
A: Developer delegated to the advisor model. Advisor verdict: Option A (drop dead-flag check; try/catch mandatory under either guard — TOCTOU reclassification risk; document the deviation at the site, scoped to this helper; sharpen the dead-ctx swallow test to assert the original gate's `reason: 'aborted'` classification survives; e2e interpretation rows: line-with-dead=true ⇒ ctx plane stayed live, aborted-without-line ⇒ dead egress plane; no ring-buffer/flush). Evidence: `provider.ts:377-388` (gate 1 fires ON the flag), pi awaits `session_shutdown` handlers before invalidation.

**Q (Step 4 directional): e2e as first-party standalone script — direction?**
A: "Standalone, no npm wiring (Recommended)" — confirmed. `scripts/e2e-esc-abort.mjs`, manual run, README "For development" paragraph.

**Q (Step 4 genuine): include the replacement-precondition probe phase?**
A: Developer delegated to the advisor model. Advisor verdict: include, as a SECOND SCENARIO (not interleaved phases) to keep persistence counts interpretable; blocking verification required — completed: `set_model` (rpc-mode.js:364-370) + `get_state` (:344) re-select and assert the router profile across spawns and `new_session`; `--model` CLI flag exists (args.js:55-56) but is not depended on.

**Q (Step 4): design summary — proceed?**
A: "Proceed (Recommended)".

**Q (Step 5): decomposition — approve 4 slices (instrumentation → guard → emission tests → e2e+README)?**
A: "Approve (Recommended)".

**Q (plan Step 5 triage, 2026-09-06T10:29:40+0700): post-finalization plan-review findings — resolutions?**
A: 1 blocker applied via design edit: slice-3 gate-4-rethrow `attempts` now includes the up-chain `gpt-4o` candidate (`buildDelegationTierChain('medium', false)` = `['medium','low','high']`; mock `balanced.low` unconfigured, `balanced.high` = gpt-4o). 1 coverage concern applied: Slice 4 AV gains the `errorMessage` returns-0 grep. 2 suggestions applied: Summary/Performance zero-cost claim reworded (taken exit pays helper call + operand-string build); e2e abort labels/comments now say mid-turn/untargeted instead of mid-classifier.

## Design History

- Slice 1: debugEnabled facade + abort-gate instrumentation — approved as generated
- Slice 2: two-turn sticky-state guard — approved as generated
- Slice 3: per-exit emission tests — approved as generated (slice-verifier WARNING rider: Desired End State example synced to the slice-1 fence format so slice 4's e2e greps the fence shape)
- Slice 4: e2e harness + README — approved as generated (2 slice-verifier rounds: round 1 fixed README runtime clause, settle-predicate race (`messageCount >= count0 + 2`), dialog-reply scope; round 2 all-OK plus `editor` dialog reply arm added — rpc-mode.js:148-193 awaits `extension_ui_response` with no timeout)

## References

- Research: `.rpiv/artifacts/research/2026-09-06_05-36-39_esc-abort-poisons-router-turns.md` (parent; legs spec, forensics, mock/call-index contracts)
- Discover FRD: `.rpiv/artifacts/discover/2026-09-06_04-51-15_esc-abort-poisons-router-turns.md`
- Prior plan (same seam): `.rpiv/artifacts/plans/2026-09-05_12-33-55_router-hang-terminal-events.md`
- Prior validation (unchecked manual ESC boxes): `.rpiv/artifacts/validation/2026-09-05_13-07-25_spinner-hang-dead-esc-terminal-events-signal-timeout-plumbing.md`
- d793dbde root-cause table: `.rpiv/artifacts/solutions/2026-09-05_10-01-30_router-hang-esc-dead.md`
- Stale-ctx design (invalidation triggers): `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md`
- Global pi 0.84.3 dist citations verified live: `C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/{cli/args.js,modes/rpc/rpc-mode.js,config.js}`
- Bug session: `C:/Users/utama/.pi/agent/sessions/--H--fork-openshorts--/2026-09-05T21-29-51-693Z_01a0737a-534c-74a6-b05a-3faef8518d9d.jsonl`
