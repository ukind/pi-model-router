---
date: 2026-09-06T05:36:39+0700
author: Yogiswara Utama
commit: 01d84ba7
branch: main
repository: pi-model-router
topic: "ESC abort poisons subsequent router turns until /reload"
tags: [research, codebase, provider, abort-signal, terminal-events, extension-context]
status: ready
last_updated: 2026-09-06T05:36:39+0700
last_updated_by: Yogiswara Utama
---

# Research: ESC abort poisons subsequent router turns until /reload

## Research Question

Chained from `.rpiv/artifacts/discover/2026-09-06_04-51-15_esc-abort-poisons-router-turns.md`. One ESC abort during a router-routed turn leaves the router provider dead: every later turn returns `stopReason: "aborted"`, `errorMessage: "Operation aborted"`, empty content, zero usage, until `/reload`. Sequence three legs: (1) instrument the abort gates in `extensions/provider.ts` with debug-scoped operand logging; (2) scripted e2e repro against real pi 0.84.3 aborting mid-classifier; (3) two-turn unit guard at the `streamSimple` seam in `extensions/provider.test.ts`. If leg 2 pins the mechanism inside pi, file upstream and keep the guard.

## Summary

- **Proximate mechanism pinned to one discrimination step.** Turns 3 and 4 of the bug session aborted in the milliseconds *after* a fully-completed classifier run (7.3 s and 7.6 s after their prompts ≈ classifier latency), through an extension-staleness exit — either gate 1 (`extensions/provider.ts:379-385`) on the `state.isExtensionContextDead` operand, or the catch branch's stale-ctx arm (`extensions/provider.ts:822-851`) triggered by a stale `pi.*`/ctx call in the post-classifier sync steps. Both produce byte-identical terminal events. The signal operand is excluded by timing (a pre-aborted signal fast-fails the classifier in milliseconds; nothing aborted turns 3/4), and pi's plumbing provably caches no signal across turns.
- **Precondition discovered (new finding).** The extension's `pi` bridge was already failing silently 13 minutes before the ESC: `pi.appendEntry` threw (swallowed by `persistState`'s catch, `extensions/index.ts:199`) from 21:34:43 until `/reload`, so six successful delegated turns (21:40:57–21:47:39) persisted zero `router-state` entries and the post-reload restore landed on 21:34-era state. The failure window opens exactly when subagent records appear in the session file (21:36:08, 21:39:56). This is the signature of a session replacement invalidating the extension's captured runtime (`dist/core/agent-session.js:2146`, `dispose()` at `:570`, `dist/core/extensions/runner.js:352-357`) while per-event ctxs stayed live. ESC is the trigger; the mid-session replacement is the loaded precondition.
- **The FRD's gate-379 pin rationale is invalidated.** `errorMessage: "Operation aborted"` is written by the interactive-mode renderer onto EVERY `stopReason === "aborted"` message (`dist/modes/interactive/interactive-mode.js:2656-2662`), before persistence, regardless of which exit fired. The field carries zero exit information. Gate 379 remains the most probable exit by timing, not by the message-shape argument.
- **Recovery path confirmed.** `/reload` emits `session_shutdown {reason:"reload"}`, invalidates the old runner, rebuilds the extension runtime, and emits `session_start` (`dist/core/agent-session.js` `reload()` at ~:2141-2163) — fresh captures, dead flag cleared, state restored from the last persisted `router-state` entry.
- Legs 1–3 of the FRD are fully specified by this research: gate-line design (entry snapshot + operand split), an RPC-mode e2e whose log discriminates the four failure shapes, and the two-turn unit test with its exact mock/call-index/assertion contract.

## Detailed Findings

### 1. The four abort exits and what each can express

`streamSimple` is registered via `pi.registerProvider('router', ...)` (`extensions/provider.ts:306-310`) and runs its whole turn in one fire-and-forget async IIFE (`extensions/provider.ts:332`, return at `:860`). Four exits convert staleness/abort into a terminal `error` event with `reason: "aborted"`:

- **Gate 1 — post-classifier** (`extensions/provider.ts:379-385`): the only await between IIFE entry and this gate is the classifier call (`:363-372`); when the classifier is skipped the path is fully synchronous. With an entry-time signal snapshot plus a classifier-ran flag, this gate resolves "aborted before entry" vs "aborted during the classifier await" exactly — no other exit can.
- **Gate 2 — candidate-loop-top** (`extensions/provider.ts:577-584`): runs once per candidate iteration; the per-candidate catch (`:799-801`) swallows delegated-stream AbortErrors into `lastError`, so this gate is what terminates retries. Needs loop position (tier, candidate index) in its log line.
- **Gate 3 — post-auth** (`extensions/provider.ts:614-621`): last check before the delegated stream opens; proves the abort preempted stream creation (asserted by the existing test at `extensions/provider.test.ts:1213`).
- **Gate 4 — IIFE catch** (`extensions/provider.ts:822-851`): classifies by error shape, never reads the operands. Stale-ctx arm matches pi's exact prefix (`extensions/provider.ts:49-50`); abort arm matches `error.name === 'AbortError'` (`:833-834`). An `AbortError` reaches it only from code outside the per-candidate try — e.g. `actions.syncPiThinkingLevel` (proven by the test at `extensions/provider.test.ts:1367-1394`).

None of the four records which operand tripped or when the abort arrived, and there is **no entry-time signal check anywhere** in the handler. An entry-time abort *is* caught (gate 1 fires) but is temporally invisible: "aborted before entry" and "aborted during classification" emit identical output.

### 2. Session forensics — the bug timeline (from the raw JSONL)

Source: `C:/Users/utama/.pi/agent/sessions/--H--fork-openshorts--/2026-09-05T21-29-51-693Z_01a0737a-534c-74a6-b05a-3faef8518d9d.jsonl` (54 entries; 7 `router-state`; 3 aborted assistant messages; 11 successful delegated turns).

| Time | Event | Evidence |
|---|---|---|
| 21:34:43.563 | last `router-state` before the bug (dbgHist=4) | RS entry #5 |
| 21:36:08 / 21:39:56 | **subagent records** (custom/subagents:record) | entries 23-24 |
| 21:40:57–21:47:39 | six successful delegated turns — **zero persisted state** | no RS entries; `appendEntry` silently throwing |
| ~21:47:40 | ESC'd turn is a tool-loop continuation (no user prompt in file) | no USER entry 21:47:39→21:47:47 |
| 21:47:47.380 | abort lands instantly (signal fast-fail) | aborted msg, `provider=router/auto` |
| 21:47:56.932 → 21:48:04.203 | "resume" → abort after **7.3 s** | aborted msg, contentParts=0, tok=0 |
| 21:48:18.562 → 21:48:26.124 | "resume" → abort after **7.6 s** | same shape |
| 21:49:46.018-019 | `/reload`: model_change + RS #6 restoring **21:34-era state** (`decidedAt=21:34:14`) | entries 47-49 |
| 21:49:55.453 → 21:50:47.974 | "resume" succeeds | RS #7, delegated message |

Deductions: (a) 7.3/7.6 s ≈ classifier latency ⇒ the classifier ran fully, then the exit fired within milliseconds; (b) `contentParts=0`/`tok=0` ⇒ `createAbortedMessage` (`extensions/provider.ts:76-96`), not pi's `handleRunFailure` (which emits one empty text block); (c) a pre-aborted signal would fast-fail the classifier in ms ⇒ the signal operand is excluded ⇒ the exit fired on the staleness class; (d) `runClassifier` swallows all per-ref errors (`extensions/routing.ts:780-783`) and returns `undefined` (`:785-786`), so a classifier-side abort never throws — the exit must be an operand check or a sync-step throw after the await.

### 3. The precondition: mid-session replacement broke the `pi` bridge

- `persistState` calls `pi.appendEntry('router-state', state)` inside a swallowing try/catch (`extensions/index.ts:199-205`). Six successful turns mutated `debugHistory` (pushed unconditionally at `extensions/index.ts:131`) yet wrote nothing ⇒ `appendEntry` threw from 21:34:43 until `/reload`.
- pi invalidates extension runtimes on session replacement/reload: `dispose()` calls `_extensionRunner.invalidate("This extension ctx is stale after session replacement or reload…")` (`dist/core/agent-session.js:570`), and `reload()` does `oldRunner.invalidate()` after emitting `session_shutdown{reason:"reload"}` (`dist/core/agent-session.js:2141-2163`). `runner.invalidate()` sets a permanent `staleMessage` and `assertActive()` throws from then on (`dist/core/extensions/runner.js:352-361`).
- A replacement that invalidated the extension's *captured* `pi` (appendEntry path) while per-event ctxs stayed live explains the exact 21:35–21:47 signature: delegation healthy (gates pass, flag clear) + persistence dead. The subagent records at 21:36/21:39 bracket the breakage onset.
- What ESC added is the remaining discrimination: either post-abort event ctxs started throwing in `captureCtx` (`extensions/index.ts:64-95` latch), or a post-classifier sync call on a dead ctx/`pi` (`syncPiThinkingLevel` `extensions/provider.ts:488` → `pi.setThinkingLevel` ungated; `updateStatus` `:510`; `setHiddenThinkingLabel` `:659-671` flag-gated) threw the stale-prefix error into the catch arm. Leg 1's gate line splits these; leg 2 reproduces.

### 4. "Operation aborted" errorMessage provenance

The string is produced at exactly one assistant-message site: the interactive-mode renderer, on `message_end`, when `stopReason === "aborted"` and `retryAttempt === 0` — `this.streamingMessage.errorMessage = "Operation aborted"` (`dist/modes/interactive/interactive-mode.js:2656-2662`). It is written synchronously during the session's `_emit`, BEFORE `sessionManager.appendMessage` persists (`dist/core/agent-session.js:369-381`), and it overwrites any existing `errorMessage`. Consequences: (a) every router abort exit — gates and catch — yields the same JSONL field; (b) `errorMessage` cannot discriminate exits; (c) the FRD's elimination ("message shape matches createAbortedMessage ⇒ gate 379") was unsound — gate 379 stays most-probable on timing alone. Other occurrences of the string (tool results at `agent-loop.js:415,434`; tool `execute()` throws) never touch assistant messages.

### 5. ESC abort path vs `session.abort()`

ESC flows `defaultEditor.onEscape` → `restoreQueuedMessagesToEditor({abort:true})` → `this.agent.abort()` directly (`dist/modes/interactive/interactive-mode.js:2258-2261`, `:3584-3603`) — bypassing `AgentSession.abort()` (`dist/core/agent-session.js:1171-1175`), which additionally calls `abortRetry()` and **awaits `waitForIdle()`**. The retry controller (`agent-session.js:2236-2262`) clears in its own `finally` and guards only the backoff sleep — excluded as a latch. `session.abort()`'s idle-wait transitively covers the router's fire-and-forget IIFE; ESC's direct call does not — the unwind continues in background. ESC also clears steering/follow-up queues (`agent-session.js:1144-1154`). A prompt submitted inside the settle window would be steered into the dying run; the bug session's 9.5 s gap rules that out for turn 3. Timeline also rules out turn-2 IIFE overlap: the ESC'd classifier fetch carried `options.signal` (`extensions/routing.ts:752`), fast-failed, and the IIFE's `finally` ran `persistState` long before turn 3.

### 6. pi signal-path audit and copy authority

- Every run gets a fresh `AbortController` (`packages/agent/src/agent.ts:491` at tag v0.84.3; runtime bundle `chunk-E5KXRMZK.js:825:37790`), passed by reference through five layers — loop options (`agent-loop.js:194-198`), SDK streamFn closure (`dist/core/sdk.js:185-207`), `ModelRuntime.prepareRequest` (signal survives the options spread, `dist/core/model-runtime.js:433-449`), composed provider (`dist/core/provider-composer.js:309-311`) — to the router's `streamSimple`. **No layer caches, reuses, or leaks a signal across turns.**
- Four copies of the Agent code exist on this machine; only the bundle runs. **The repo's `node_modules/@earendil-works/*` are stale 0.80.1 leftovers** (repo `package.json` declares no deps on them) — do not cite; their line numbers are ~20 off and one guard (`reset()`) is absent. Actionable citations: src paths at tag `v0.84.3` (e.g. `packages/agent/src/agent.ts:486-525`), or the shipped npm dist (`PIROOT/node_modules/@earendil-works/pi-agent-core@0.84.3/dist/agent.js:326-371`). Bundle citations are corroboration only (chunk renames every release).

### 7. `runClassifier` under mid-flight abort

Signal is threaded `options?.signal` → `runClassifier(...)` (`extensions/provider.ts:370`) → conditional spread into the classifier's stream options (`extensions/routing.ts:752-753`). pi-ai's implementations reject an aborted fetch immediately and reclassify it as a terminal `error` event with `stopReason: "aborted"` (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:111`, `:346-347`, `:368-374`). `runClassifier` catches everything per-ref (`extensions/routing.ts:780-783`), advances through refs, and returns `undefined` on exhaustion (`:785-786`) — an abort never propagates as a throw. No closures, timers, or pending promises survive that could touch the next turn's state; the classifier context is a fresh object (`:733-740`). Confirmed by the existing test driving a deferred generator (`extensions/provider.test.ts:1318-1365`).

### 8. e2e repro design (RPC mode, real pi 0.84.3)

- **Surface**: `pi --mode rpc` (`dist/cli/args.js:40`); LF-JSONL stdin; responses + full session-event stream + `extension_ui_request` (including the router's debug `notify`, `dist/modes/rpc/rpc-mode.js:87-96`) on stdout. `prompt` (`:298-320`), `abort` (`:329-332`, `await session.abort()`), `get_state`/`get_entries`/`get_messages` for read-back.
- **Fidelity**: RPC abort reaches the identical operand (same controller → same signal) as ESC; the deltas (abortRetry no-op, awaited idle) are harmless for this bug. `--print`/`--mode json` are single-shot and cannot do prompt→abort→prompt; PTY ESC automation adds timing noise. RPC is the harness.
- **Discriminators per turn**: `message_end.message.provider === "router"` ⇒ router-synthesized terminal; real provider id ⇒ delegation succeeded. Gate identity: gate 1 leaves `router-state.lastDecision` unchanged (it returns before `state.lastDecision = decision` at `extensions/provider.ts:501`); gates 2/3 and the catch update it. Deltas-present ⇒ delegation had opened. `queue_update`/prompt-error text ⇒ never-delegated sub-shapes. One `router → …` notify (`extensions/index.ts:151-154`) marks each successful turn; `Router initialized with profiles: …` on `session_start` is the readiness beacon.
- **Timing**: sandbox `PI_CODING_AGENT_DIR` with a copy of the agent dir + this extension + `model-router.json` (`debug:true`, classifier = the same ollama-cloud `nemotron-3-nano:30b` thinking high per developer choice, `candidateTimeoutMs: 120000`, one cheap reachable target). Run a control turn first; abort turn A at half the measured classifier latency. Decision from checkpoint below.
- **Recovery control**: repeat turn B after a fresh-process restart or `/router reload` to mirror the user's workaround.

### 9. Two-turn unit guard design (`extensions/provider.test.ts`)

- Turn A: mock compat `streamSimple` to yield one `text_delta`, await a deferred gate, then throw `AbortError` — `runClassifier` swallows it and returns `undefined`; the test aborts a real `AbortController`; gate 1 fires on the signal branch (`extensions/provider.ts:379`), currently untested. Assert `terminated(streamA)`, terminal `{type:'error', reason:'aborted'}`, `result()` resolving to the aborted message, and exactly one classifier call.
- Turn B: fresh `AbortController`, fresh `MockEventStream`, order-dispatching mock (instant classifier yield `'Tier: high…'`, then delegated `text_delta` + `done` with usage). Assert: `result()` resolves to the done message (usage `0.0015`) — discriminates `done` from `error`; last compat call went to the delegated target (`gpt-4o`, not classifier `gpt-4o-mini`); `signal === controllerB.signal` forwarded; no error events; `accumulatedCost === 0.0015`; `persistState` called twice.
- **Indexing**: both turns live in one `it`, so the compat mock records A-classifier `[0]`, B-classifier `[1]`, B-delegated `[2]` — index turn B's delegated call with `mock.calls.at(-1)`, never `[0]` (the file's `beforeEach` clears once per test, not per call).
- **Reset nothing in `mockState` between turns** — a test that resets fields masks exactly the sticky-state bugs it exists to catch. Turn A (signal abort) leaves `isExtensionContextDead` false, `lastDecision` undefined, `accumulatedCost` 0 naturally.
- **Caught failure modes**: sticky dead flag, cached/reused signal, one-shot abort latch, terminal-event regression (bare `end()` — the d793dbde class, caught by `terminated()`'s 500 ms race), delegation skip. **Structurally invisible** (by design): pi-side poison (the test *is* the host), persisted-state round-trip poison (`persistState` is a no-op `vi.fn()`), `lastDecision` poison (turn A returns before `:501`).

### 10. Instrumentation design (leg 1)

- One line per abort exit, inside the taken branch, between the trip and `stream.push`: gate id, each operand read separately inside the branch (`state.isExtensionContextDead`, `options?.signal?.aborted`), entry-time snapshot (`const signalAbortedAtEntry = options?.signal?.aborted === true` at IIFE top, `extensions/provider.ts:333` — the body runs synchronously to the first await, so the read is entry-time truth), classifier-ran flag, loop position for gate 2, error shape + phase marker for gate 4.
- **Zero-cost when debug off**: keep the single boolean as the branch condition; read operands only inside the taken branch (gate 2 runs per candidate iteration — do not add evaluations to the untaken path); check the cheap `debugEnabled` flag first so `state.lastExtensionContext` is never read when off; emit before `stream.end()`; never `addEventListener('abort')` (allocates, can leak).
- **Wiring gap**: `provider.ts` cannot see `debugEnabled` today — the state facade (`extensions/index.ts:304-349`, type at `extensions/provider.ts:195-207`) must expose `readonly debugEnabled: boolean`. The test harness's `mockState` omits it ⇒ falsy ⇒ existing tests pass unmodified. `mockState.lastExtensionContext.ui` defines only `setHiddenThinkingLabel` (`extensions/provider.test.ts:121-125`) — an ungated `ui.notify` would throw inside the IIFE and fake a terminal event, so the guard is load-bearing.
- **Tests that must stay green**: the eight-test gate suite at `extensions/provider.test.ts:1062-1394` (mid-turn replacement `:1082-1131`, signal-only retry stop `:1133-1178`, auth-await death `:1180-1220`, stale-ctx throw `:1222-1246`, negative control `:1248-1267`, killed-stream success `:1269-1317` incl. `recordDebugDecision` exactly once at `:1314`, classifier-await death `:1319-1365`, catch AbortError `:1367-1394`) plus the `createAbortedMessage` unit at `:156-164`.

## Code References

- `extensions/provider.ts:306-333` — provider registration, invariant guard, IIFE entry (entry-snapshot site)
- `extensions/provider.ts:363-385` — classifier await and Gate 1
- `extensions/provider.ts:488,510` — ungated `syncPiThinkingLevel` / flag-gated `updateStatus` (post-classifier sync steps)
- `extensions/provider.ts:577-584` — Gate 2 (candidate-loop top)
- `extensions/provider.ts:614-621` — Gate 3 (post-auth)
- `extensions/provider.ts:659-671,692-698,711-735` — delegation open (hidden-thinking label, runtime facade binding, option spread)
- `extensions/provider.ts:76-96` — `createAbortedMessage` (no `errorMessage`)
- `extensions/provider.ts:822-860` — Gate 4 catch, `finally` persistState
- `extensions/routing.ts:698-787` — `runClassifier` (signal spread `:752-753`, swallow `:780-783`, `undefined` return `:785-786`)
- `extensions/index.ts:64-95` — dead-flag lifecycle + `captureCtx`
- `extensions/index.ts:128-156` — `recordDebugDecision` (debug-surface guard pattern, `:132`)
- `extensions/index.ts:199-205` — `persistState` swallowing `appendEntry` throws
- `extensions/index.ts:304-349` — state facade (missing `debugEnabled`)
- `extensions/provider.test.ts:7-58` — `MockEventStream` (terminal-event contract mirror)
- `extensions/provider.test.ts:1062-1394` — gate test suite (8 tests)
- `extensions/routing.test.ts:1044-1068` — classifier signal pass-through (`.at(-1)` indexing; no mock clearing in that file)
- `dist/modes/interactive/interactive-mode.js:2258-2261,2656-2662,3584-3603` — ESC wiring, "Operation aborted" renderer write, abort call
- `dist/core/agent-session.js:369-381,570,1144-1154,1171-1181,2141-2163,2236-2262` — persistence order, `dispose()` invalidation, queue clear, abort/waitForIdle, `reload()`, retry controller
- `dist/core/extensions/runner.js:352-361` — `invalidate()`/`assertActive()` semantics
- `packages/agent/src/agent.ts:486-525` (tag v0.84.3) — `runWithLifecycle` fresh controller, `handleRunFailure`
- `packages/agent/src/agent-loop.ts:193-197,308-312` — aborted handling, signal pass
- Bug session: `C:/Users/utama/.pi/agent/sessions/--H--fork-openshorts--/2026-09-05T21-29-51-693Z_01a0737a-534c-74a6-b05a-3faef8518d9d.jsonl`

## Integration Points

### Inbound References
- pi → router `streamSimple`: composed provider dispatches on `model.api === extension.api` (`dist/core/provider-composer.js:309-311`), receiving the same options object carrying the per-run signal
- pi events → router handlers: `before_provider_request` (capture anchor, `extensions/index.ts:547-549`), `session_shutdown` (death anchor, `:556-558`), `session_start`/`model_select`/`turn_end`/`thinking_level_select` (`:560+`)
- interactive-mode renderer → persisted messages: stamps `errorMessage` on every aborted `message_end` before `sessionManager.appendMessage` (`dist/core/agent-session.js:369-381`)

### Outbound Dependencies
- `@earendil-works/pi-ai` — `createAssistantMessageEventStream` (terminal-event resolution, `dist/utils/event-stream.js:17-36`), compat `streamSimple` (classifier + delegation)
- pi `ModelRuntime` facade — `registryRuntime.streamSimple.bind(registryRuntime)` for custom-api targets (`extensions/provider.ts:692-698`); reads `this.prepareRequest`
- classifier model — ollama-cloud `nemotron-3-nano:30b` (thinking high, ~7.5 s), configurable via `model-router.json` (`extensions/config.ts:544-546`, agentDir follows `PI_CODING_AGENT_DIR`)

### Infrastructure Wiring
- Debug surface: `debugEnabled && lastExtensionContext && !isExtensionContextDead` → `ctx.ui.notify` (`extensions/index.ts:132,151-154`); in RPC mode surfaces as `extension_ui_request method:"notify"` (`dist/modes/rpc/rpc-mode.js:87-96`)
- State persistence: `pi.appendEntry('router-state', state)` from stream `finally` (`extensions/provider.ts:855-857`) and `turn_end` (`extensions/index.ts:616`); restored via `ctx.sessionManager.getBranch()` (`extensions/index.ts` `restoreStateFromSessionInner`)
- Test runner: `npm test` (vitest ^4.1.9, `vitest run`)

## Architecture Insights

- The router's terminal-event contract is three-layered (type protocol → `EventStream.result()` resolution → `MockEventStream` mirror); every abort exit's push-then-end pair exists because bare `end()` hangs the spinner (d793dbde).
- The extension runs on two state planes that can diverge: the captured `pi`/runtime bridge (appendEntry, setThinkingLevel) and per-event ctxs (registry, ui). The bug session shows the first plane dead for 13 minutes while the second stayed live; the ESC flipped the second plane too. Any staleness model that treats "the extension ctx" as one thing will mis-predict here.
- `errorMessage` on aborted messages is presentation-layer, not provenance — downstream artifacts must not read it as exit evidence.
- pi's invalidation surface is exactly: `dispose()` (newSession/fork/switchSession/reload replacements) and `reload()`'s old-runner kill. There is no abort-linked invalidation in the source — so if the e2e shows post-ESC ctx staleness, that is a genuine pi bug worth the upstream issue; if it shows nothing, the poison required the subagent-era replacement as precondition, and the upstream framing changes.

## Precedents & Lessons

5 similar past changes analyzed.

### Precedent: terminal aborted events + candidate timeout (the immediate predecessor)
**Commit(s)**: `01d84ba7` — "fix: resolve abort spinner hang with terminal aborted events and candidate timeout" (2026-09-05)
**Blast radius**: 13 files, +2194/−15 across 4 layers (provider, routing, config/types/constants, tests)
**Follow-up fixes**: none yet — this research IS the follow-up (the bug under investigation appeared post-fix)
**Lessons from docs**: `.rpiv/artifacts/validation/2026-09-05_13-07-25_spinner-hang-dead-esc-terminal-events-signal-timeout-plumbing.md` — all four manual ESC/replacement/reload checks were unchecked at commit time
**Takeaway**: the commit added the very gates now implicated; it shipped on automated checks alone.

### Precedent: dead-flag gates whose passing tests hid a production hang
**Commit(s)**: `d793dbde` — "fix: dead-flag gate stale extension ctx after session replacement" (2026-09-04)
**Blast radius**: 16 files, +5517/−18
**Follow-up fixes**: `01d84ba7` (1 day later) — bare `stream.end()` never resolves `EventStream.result()`
**Takeaway**: mock fidelity at the streamSimple/EventStream seam is the difference between a passing test and a shipped hang.

### Precedent: capture-on-every-event + `before_provider_request` anchor
**Commit(s)**: `4ae87431` — "fix: refresh runtime captures on every event and hoist provider registry guard" (2026-08-29)
**Blast radius**: 4 files, +124/−14
**Follow-up fixes**: `d793dbde` (5 days later)
**Takeaway**: the two gate operands (`signal.aborted`, `isExtensionContextDead`) were both born here; `/reload` appearing in the invalidation-trigger list of the later stale-ctx design matches this bug's recovery path.

### Precedent: delegation-path pair (detached binding, silent fallback masking)
**Commit(s)**: `524afdec` (2026-08-27), `cdcfe2eb` — "bind ModelRuntime.streamSimple when delegating custom-api models" (2026-08-30)
**Blast radius**: 2 files, then 1 file
**Takeaway**: deferred execution (`lazyStream`) plus fallback loops swallow the real error — instrument at the gate site, not post-loop.

### Precedent: ancestor stale-ctx guard
**Commit(s)**: `f67a7850` — "fix: guard persistState against stale ctx after session reload" (2026-07-23)
**Blast radius**: `extensions/index.ts` +9
**Takeaway**: four fixes in four months at this seam, one theme — async turns outlive the ExtensionContext they captured.

### Composite Lessons
- Same seam, four-fix chain: every prior fix shipped green tests and broke real pi within days — always mock/env fidelity (bare `end()`, 0.80.1 mocks vs 0.84.3 runtime), never covered logic (`f67a7850` → `4ae87431` → `d793dbde` → `01d84ba7`).
- Version skew is live: repo `node_modules` pins pi-agent-core 0.80.1 while the user runs 0.84.3 — e2e must target the global install; unit results are contract-shape checks only.
- The two-turn guard must reuse the `result()`-waiter mock and index turn B with `.at(-1)`; `routing.test.ts` has no mock clearing.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-09-06_04-51-15_esc-abort-poisons-router-turns.md` — FRD for this bug (session evidence, decisions, three-legged acceptance)
- `.rpiv/artifacts/plans/2026-09-05_12-33-55_router-hang-terminal-events.md` — prior plan at the same seam (terminal aborted events)
- `.rpiv/artifacts/validation/2026-09-05_13-07-25_spinner-hang-dead-esc-terminal-events-signal-timeout-plumbing.md` — 01d84ba7 validation, manual ESC checks unchecked
- `.rpiv/artifacts/solutions/2026-09-05_10-01-30_router-hang-esc-dead.md` — d793dbde root-cause table
- `.rpiv/artifacts/designs/2026-09-04_12-54-17_stale-ctx-session-replacement.md` — stale-ctx design (invalidation-trigger list)
- `.rpiv/artifacts/research/2026-08-30_08-33-23_router-no-model-registry.md` — registry-guard thread

## Developer Context

**Q (discover: Working diagnosis: post-classifier gate): Which exit produced the "Operation aborted" turns?**
A: Most-probable exit: `provider.ts:379`. Router pushed the terminal event (proven by message shape). The operand that tripped it is unproven. — *Research update: message-shape argument invalidated (renderer artifact); timing now carries the pin; exit is gate 1 or the stale catch arm, both staleness-class.*

**Q (discover: Evidence baseline: ownership): Does the router persist poisoned abort state across turns?**
A: Router persistence ruled out (verified). The pi-side mechanism is unlocated. Pinning it is an in-scope work item, not a settled fact.

**Q (discover: Acceptance shape: three legs): What is the acceptance core?**
A: Three-legged acceptance. A mocked-controller unit test alone would pass today without reproducing the bug.

**Q (discover: Fix layer): Where does the fix land — router-only hardening, pi root-cause first, or both?**
A: Both, sequenced: instrument router gates first, live-repro against pi 0.84.3; if the mechanism lands pi-side, document and file upstream; keep the router guard test.

**Q (discover: Non-goals): Confirm the three exclusions?**
A: Full abort-path audit, further spinner-hang work, and pi-core code changes from this repo are all out of scope.

**Q (discover: Non-functional requirements): Confirm both constraints?**
A: (1) Terminal-aborted-event behavior must not regress. (2) Gate instrumentation is zero-cost when debug is off.

**Q (discover: Unit guard shape): Two-turn test in `extensions/provider.test.ts`, run via `npm test`?**
A: Confirmed. Turn A aborted mid-classifier; turn B with a fresh `AbortController` delegates and streams.

**Q (discover: Live repro mechanism): Scripted e2e or manual checklist?**
A: Scripted e2e under `scripts/` or `tests/e2e/`, against real pi 0.84.3.

**Q (discover: Instrumentation scope): What do the gates emit when debug is on?**
A: One line per abort exit: gate id, operand, entry-time delivered-aborted vs aborted-mid-run. Existing debug surface. Zero-cost when off.

**Q (research checkpoint, session forensics): Did anything session-level happen between ~21:34 and ~21:41 (fork, /switch, compaction, resume, second window)?**
A: "Nothing I recall" — the `appendEntry` failure has no user-visible trigger; the subagent records (21:36/21:39) are the only activity in the window. The e2e should assert router-state persistence across its turns.

**Q (research checkpoint, repro config): Which classifier model for the sandboxed e2e?**
A: Same ollama-cloud classifier (`nemotron-3-nano:30b`, thinking high) — identical field conditions; needs the API key in the sandbox env.

## Related Research

- None in `.rpiv/artifacts/research/` beyond the registry-guard thread listed in Historical Context.

## Open Questions

None. No item was deferred. The unlocated pi-side mechanism is in scope as Functional Requirement 5. *(verbatim from the discover FRD)*

New, unresolved by this research (leg 1/2 discriminators, in FRD scope):
1. Which exact exit fired on turns 3/4 — gate 1 on the dead flag, or the catch's stale-ctx arm from a post-classifier sync call (`syncPiThinkingLevel`/`updateStatus`/`setHiddenThinkingLabel`). The instrumented gate line names it.
2. What ESC added to the already-half-broken bridge: do post-ESC event ctxs throw in `captureCtx`, or does `before_provider_request` stop delivering live ctxs? No abort-linked invalidation exists in pi 0.84.3 source — if the e2e reproduces it, that is the upstream pi issue; if not, the subagent-era replacement was a required precondition.
3. What exactly broke `pi.appendEntry` at 21:34:43 (user recalls no session-level action; subagent records are the only marker).
