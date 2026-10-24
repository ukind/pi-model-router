# Tech Debt Audit — pi-model-router
Generated: 2026-09-20 (commit 762a7978, branch main)

## Executive summary

- **1 Critical, 5 High, 9 Medium, 16 Low** findings (31 total).
- **Largest debt concentration: `extensions/provider.ts`** — the entire per-turn delegation, fallback, truncation, abort, and cost state machine lives in one 744-line function (`registerRouterProvider`, provider.ts:157). Four of the top five findings are about function size and hand-rolled control flow, not logic errors.
- **The code is correct far more often than it is maintainable.** `tsc --noEmit` is clean, `npm audit` is clean, madge finds no circular deps, and the test suite (371 tests) is thorough on the modules it covers. The debt is structural: god functions, tripled hand-rolled abort wiring, and six modules on the per-turn hot path with zero direct tests.
- **The per-turn hot path has three hand-rolled copies of the same abort-composition pattern** (routing.ts:829, typesafe.ts:315, provider.ts:636) because pi-ai does not re-export `combineAbortSignals`. This is the highest-drift-risk item after the god functions.
- **Six of fifteen source modules have no test file**: `truncate.ts`, `typesafe.ts`, `watchdog.ts`, `messages.ts`, `keywords.ts`, `constants.ts`. Two of them (`truncate`, `watchdog`) run on every routed turn.
- **`truncateContext` is O(n²)** in conversation length (truncate.ts:58,67) — it re-tokenizes the entire message list on every eviction pass.
- Config normalization carries an **advisory-only `resolvedThinkingLevels` surface** that the runtime never reads (config.ts:250-260) — dead config that still ships in the type contract.
- Two genuinely dead export aliases in closure.ts:81,86 (`bumpClosureCapture`, `markClosureDead`) shadowed by the names actually used at closure.ts:190-191.
- No security vulnerabilities found. One data-flow caveat: the opt-in TypeSafe backend sends the last 6 messages of the conversation to a third-party endpoint (typesafe.ts:55-60).
- Documentation is accurate. `docs/ARCHITECTURE.md` matches the module layout exactly; the README matches behavior. This is rare and should be preserved.

## Architectural mental model

The extension is a **single-file-thick orchestration layer over pi's model lifecycle**. It registers a fake provider (`router`) whose `streamSimple` intercepts every turn, classifies the turn into a work type, maps that to a tier (`high`/`medium`/`low`), and delegates to a real model — retrying through per-tier `fallbacks` and cross-tier demotion on failure.

Control flow, as it actually is:

1. **index.ts** (698 lines, one closure at :43) owns ~20 mutable state variables and wires them into three sibling modules through getter-bag objects. Every pi event handler (`turn_start`, `session_start`, `model_select`, `turn_end`, `session_shutdown`) re-captures the extension context, because the ctx can die or be replaced mid-session.
2. **provider.ts** (901 lines) registers the provider and contains the delegation state machine: build tier chain → per-candidate auth race → abort composition → truncation → reasoning-level negotiation → compat-vs-runtime facade dispatch → stall-guarded stream → cost accumulation → cross-tier fallback mutation of the decision in place.
3. **routing.ts** (932 lines) holds the pure decision logic (`decideRouting`, heuristics, rule matching, veto floors) plus the chat-backend classifier call.
4. **closure.ts** is a process-global dispatcher that keeps one live closure per pi instance — the hardest-won code in the repo, fixing a phantom-abort race where in-process subagents re-register the provider and a dead session's closure serves the stream.
5. **config.ts** (762 lines) loads, deep-merges (global → project), and normalizes config; **typesafe.ts** is the alternate Jev classifier backend; **state.ts** validates persisted state per-field; **ui.ts**, **commands.ts**, **truncate.ts**, **watchdog.ts**, **messages.ts**, **keywords.ts** are small and focused.

The dominant characteristic is **defensive density**: nearly every non-trivial block carries a comment citing a pi internal line number or a past incident. This is a reaction to real fragility (the extension depends on pi internals that are not fully typed or re-exported), and it is the main reason the files are so large. The mental model in `docs/ARCHITECTURE.md` matches this exactly — no drift between the docs and reality.

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| F001 | Architectural decay | extensions/provider.ts:157 | Critical | L | `registerRouterProvider` is a 744-line function containing the entire delegation state machine: tier-chain construction, per-candidate auth racing, abort composition, truncation, reasoning negotiation, compat/runtime dispatch, stall guarding, cost accumulation, in-place cross-tier fallback mutation, and terminal error/abort shaping. Single largest debt in the repo. | Extract in order of cleanest seam: (1) `buildCandidateList` (tier chain + image filter + self-ref skip), (2) `authenticateCandidate` (auth race + abort re-check), (3) `delegateStream` (facade dispatch + stall guard + cost accumulation), (4) `handleFallbackMutation` (the in-place decision rewrite). Each is independently testable against the existing provider.test.ts mocks. |
| F002 | Architectural decay | extensions/commands.ts:36 | High | L | `registerCommands` is a 704-line function registering every `/router` subcommand plus its autocompletions inline. | Extract one factory per command (`makeStatusCommand`, `makePinCommand`, ...) into a `commands/` directory; keep `registerCommands` as the registration list only. commands.test.ts already exercises each command separately, so the refactor is mechanically verified. |
| F003 | Architectural decay | extensions/index.ts:43 | High | L | `routerExtension` is a 698-line closure holding ~20 mutable state variables (`routerEnabled`, `selectedProfile`, `pinnedTierByProfile`, `accumulatedCost`, `classifierCalibration`, ...) wired into provider/commands through three hand-built getter-bag objects. State ownership is invisible from the type system. | Introduce a `RouterState` class (or a `useState`-style holder) in a new module; replace the getter bags with the instance. Do this after F001/F002, since the bags exist to serve those two functions. |
| F004 | Architectural decay | extensions/routing.ts:495 | High | M | `decideRouting` takes 11 parameters, spans 228 lines, and mutates 12 `let` locals through a linear priority chain (pin → budget → rule → classifier → veto → heuristic). The parameter list grows on every feature addition. | Group the inputs into a `RoutingInput` interface (`context`, `profileName`, `profile`, `previousDecision`, `pinnedTier`, `thinkingOverrides`, `phaseBias`, `rules`, `isBudgetExceeded`, `classifierResult`, `ruleHit`). Then split the chain into named steps returning partial results; the priority order is the load-bearing part and should become visible structure, not comment headers. |
| F005 | Consistency rot | extensions/routing.ts:829, extensions/typesafe.ts:315, extensions/provider.ts:636 | High | M | The same hand-rolled "compose run signal + stall timer + detach in finally" pattern is written three times with drifting details: the classifier loop (routing.ts:829) uses `{ once: true }` on the listener, the typesafe loop (typesafe.ts:315) does not, and the provider loop (provider.ts:636) additionally re-checks the signal mid-await. All three exist because pi-ai ships `combineAbortSignals` in dist/utils but does not re-export it. | Extract a single `composeAbortWithStall(runSignal, timeoutMs)` helper into watchdog.ts returning `{ signal, abort, onStall }`. Verify the three call sites keep their intentional differences (mid-await re-check in provider) as explicit parameters. |
| F006 | Test debt | extensions/truncate.ts, extensions/typesafe.ts, extensions/watchdog.ts, extensions/messages.ts, extensions/keywords.ts, extensions/constants.ts | High | M | Six of fifteen source modules have no test file. Two are on the per-turn hot path: `truncateContext` (runs when the routed model's context window is smaller than the conversation) and `stallGuardedStream`/`raceStallTimeout` (wrap every classifier and delegated stream). `typesafe.ts` is the newest module and its wire-format mapping (`mapTypesafeResponse`, `readTypesafeSignals`) is only covered indirectly. | Add truncate.test.ts and watchdog.test.ts first — both are pure functions over fake streams/contexts. Then typesafe.test.ts with `fetch` mocked. messages/keywords/constants are trivial and can stay untested by choice. |
| F007 | Performance | extensions/truncate.ts:58,67 | Medium | S | `computeTokens` re-tokenizes the entire message list (plus system prompt) on every `while` iteration, and the loop evicts one message at a time — O(n²) in conversation length. Long conversations truncate slowly on every routed turn. | Compute a token total once, then subtract the evicted message's tokens per iteration. The toolCall/toolResult pair eviction needs the same incremental treatment. |
| F008 | Architectural decay | extensions/types.ts:113-140 | Medium | M | `RoutingDecision` carries 30 fields, 24 of them optional provenance flags (`isVetoed`, `vetoOutcome`, `vetoDisagreementMagnitude`, `classifierAttempted`, ...). index.ts:recordDebugDecision has to clone the decision before pushing to history because the cross-tier fallback branch mutates the live reference in place. | Split into `RoutingDecision` (the routing outcome: profile/tier/phase/target/thinking/timestamp) and a `DecisionProvenance` sub-object. The in-place mutation in provider.ts should then build a new provenance rather than rewrite fields. |
| F009 | Consistency rot | extensions/types.ts:62, extensions/constants.ts:30-45 | Medium | S | Two confidence vocabularies coexist: a `ConfidenceLevel` string and a numeric `confidenceNumeric` in [0,1], with three numeric floors (`CLASSIFIER_OVERRIDE_FLOOR`, `CLASSIFIER_VETO_FLOOR`, `CLASSIFIER_DEGRADE_FLOOR` — the first two are both 0.85). `toConfidenceLevel` derives the string from the number, and both ride on every result. | Keep only `confidenceNumeric` internally; derive the display string at the UI boundary (ui.ts). If the two 0.85 floors are meant to drift independently, name them for their role, not their mechanism. |
| F010 | Type & contract | extensions/config.ts:250-260 | Medium | S | `resolvedThinkingLevels` is normalized, validated, and stored on every tier config, and the doc block admits the runtime delegation gate never reads it — it consults `targetModel.reasoning` from the live registry instead. This is dead config surface in the published type contract. | Either delete it (the runtime gate is the truth) or wire the runtime gate to it. The comment says the wiring is "deferred" — if that deferral is permanent, delete. |
| F011 | Error handling | extensions/closure.ts:127,225,245, extensions/provider.ts:138,146 | Medium | S | Diagnostics use raw `console.error` with multi-line template strings. There is no level, no structure, and no way to silence them. `pi.appendEntry('router-diagnostic', ...)` is used for the registry-guard path only. | Route all five through one `logDiagnostic(level, entry)` helper in a shared module that writes to stderr in dev/`debug` mode and to `pi.appendEntry` otherwise. |
| F012 | Error handling | extensions/routing.ts:921 | Medium | S | The chat-classifier per-ref `catch (error)` block handles only `isStallTimeoutError`; every other failure (invalid ref, auth reject, stream throw) falls through to "try next ref" with no diagnostic recorded anywhere. A misconfigured classifier model fails silently into heuristics. | Record the failure on the returned failure-carrying result (the `failureReason: 'infra-failure'` shape already exists for the typesafe backend) or surface it through the existing `onStall`-style callback. |
| F013 | Test debt | extensions/provider.test.ts (1947 lines), extensions/routing.test.ts (2329 lines) | Medium | M | The two largest test files are bigger than the modules they cover. Both rebuild large mock harnesses (fake model registries, fake streams, fake extension contexts) per describe block. | Extract shared mock builders (`makeRegistry`, `makeDelegateStream`, `makeFakeCtx`) into a `test-helpers.ts`. This is a prerequisite for F001/F002 extraction being verifiable. |
| F014 | Dependency | package.json:31-35 | Medium | S | All four `@earendil-works/*` peer dependencies use the `*` range. Any breaking pi-core change silently flows in. | If the extension is expected to track pi closely, pin a caret range per release and test against it in CI (add a matrix job). If `*` is deliberate because pi pins the extension, document that in the README. |
| F015 | Security | extensions/typesafe.ts:55-60, 297 | Medium | S | The opt-in TypeSafe backend sends `latest_turn` plus `recent_history` (the last 6 messages, full text) to `https://api.typesafe.ai/v1/systemone`. This is a real third-party data flow that a user enables by configuring the backend; the README documents the key file but not the data egress. | State the data egress explicitly in the README's Jev section (what is sent, to whom, when). No code change needed — the behavior is correct for an opt-in classifier. |
| F016 | Architectural decay | extensions/closure.ts:81,86,190,191 | Low | S | `bumpClosureCapture` and `markClosureDead` are exported and never used; the aliases `notifyClosureCapture`/`notifyClosureShutdown` (closure.ts:190-191) are the names index.ts imports. Dead duplicate exports. | Delete the two primary exports and keep only the `notify*` names, or make the aliases the primaries. |
| F017 | Architectural decay | extensions/provider.ts:74-76 | Low | S | provider.ts re-exports `modelRegistryFallback`, `notifyClosureCapture`, `notifyClosureShutdown`, `createErrorMessage`, `createAbortedMessage` purely so test files can import them from `'./provider'`. The package's only public entry is `extensions/index.ts` (package.json:22), so this is a test-convenience layer that misrepresents module ownership. | Import the test files from the owning modules (`./closure`, `./messages`) and delete the re-export block. |
| F018 | Consistency rot | extensions/config.ts:124,136 | Low | S | `mergeTier` and `mergeClassifier` are the same field-spread merge written twice, with a comment on the second explaining it "mirrors" the first. | Replace `mergeClassifier` with a call to the generic merge (or a single `mergeShallow` used by both). |
| F019 | Consistency rot | extensions/config.ts:332,525 | Low | S | The fallback-validation loop (alias-resolve → `parseCanonicalModelRef` → warn-skip) is duplicated for tier fallbacks and classifier fallbacks. | Extract `resolveFallbackList(raw, models, warnings, label)`. |
| F020 | Type & contract | extensions/commands.test.ts:353,856 | Low | S | The only `as any` casts in the repo, violating the AGENTS.md "NEVER use `any`" mandate. Both cast a fake extension context. | Type the fake context as a partial with the fields the handler reads, or build it through a shared typed factory (see F013). |
| F021 | Type & contract | extensions/types.ts:196-201, extensions/provider.ts:696 | Low | S | `ModelRuntimeFacade` is a hand-written structural interface over pi's untyped `modelRegistry.runtime` field, with a shape-checking guard (`getRuntimeFacade`). The comment admits the shape is untyped. | Acceptable given pi does not publish the type; keep, but add a runtime version check so a pi internals change fails the guard loudly instead of silently falling back to compat. |
| F022 | Type & contract | extensions/types.ts:172-178 | Low | S | `CustomSessionEntry` is `{ type: string; customType?: string; data?: unknown }` — a loose bag cast to `CustomSessionEntry[]` at index.ts:restoreStateFromSession before the real validator runs. | Narrow `data` to `unknown` only at the boundary and type the entries as the discriminated union pi actually emits, or keep the cast but confine it to state.ts. |
| F023 | Test debt | .github/workflows/ci.yml:18, package.json:42 | Low | S | CI runs `npm test` but never `test:coverage`; no coverage threshold exists, so the F006 gaps are invisible to CI. | Add a coverage step with thresholds on the hot-path modules (provider, routing, truncate, watchdog) once F006 lands. |
| F024 | Performance | extensions/typesafe.ts:42,297 | Low | S | `readTypesafeApiKeyFile` does a synchronous `readFileSync` of the agent dir on every classifier call, with no caching. Small file, but it is a sync syscall per turn on the routing path. | Read once and cache with a mtime check, or read lazily and cache the result. |
| F025 | Performance | extensions/routing.ts:509,312 | Low | S | `getRecentConversationText(context, 6)` and `countToolResults` rebuild the full history text on every turn before the classifier decides; the magic number 6 is inline. | Hoist the window size to constants.ts as `CLASSIFIER_HISTORY_MESSAGES` and compute the history text once per turn, passing it to both consumers. |
| F026 | Performance | extensions/routing.ts:114-121 | Low | S | `wordBoundaryRegexCache` is an unbounded module-level `Map`. Keywords come from config, so a hostile config could grow it without limit. | Cap the map size (evict oldest beyond, say, 256 entries) or precompute per-config once at normalization time. |
| F027 | Error handling | extensions/config.ts:648,677,725 | Low | S | `resolveContextWindow`, `resolveMaxTokens`, and `tierSupportsReasoning` all `catch { /* ignore */ }` invalid model refs at runtime, while config normalization warns about the same refs at load time. The runtime path silently degrades to defaults. | Keep the swallow (the runtime path cannot warn) but log once per ref per session through the F011 diagnostic helper so a bad ref is traceable at runtime. |
| F028 | Documentation drift | README.md:144 vs extensions/config.ts:535-540 | Low | S | The README's `classifierModel` row lists `thinking` as a valid field without noting that config emits a warning when it is combined with the typesafe backend, because the field is a dead knob there. | Add one clause to the README row: `thinking` applies to the chat backend only. |
| F029 | Documentation drift | AGENTS.md "NEVER use any" vs commands.test.ts:353,856 | Low | S | The project mandate is violated by the only two casts in the repo. | Same fix as F020. |
| F030 | Dependency | package.json | Low | S | `npm audit` reports 0 vulnerabilities; no unused dependencies (depcheck clean apart from the knip false positives). | Nothing material. |
| F031 | Documentation drift | docs/ARCHITECTURE.md | Low | S | Considered flagging the module list as stale — it is not; it matches the post-extraction layout exactly. Listed to record the check. | Nothing material. |

## Top 5 — if you fix nothing else, fix these

**1. F001 — Decompose `registerRouterProvider` (provider.ts:157)**

The 744-line function is the single point where every routing, fallback, abort, and cost behavior intersects. Extract in four seams, each verifiable against the existing 40 provider tests:

```ts
// provider.ts — target shape
const buildCandidateList = (state, decision, profile, imageAttached): string[]   // tier chain + image filter + self-ref skip
const authenticateCandidate = async (modelRegistry, ref, signal, timeoutMs)       // raceStallTimeout + mid-await abort re-check
const delegateStream = async (targetModel, ctx, opts) => AsyncIterable           // facade dispatch + stall guard + cost accumulation
const applyFallbackOutcome = (decision, tier, modelRef) => RoutingDecision        // replaces the in-place mutation
```

Order matters: `buildCandidateList` and `authenticateCandidate` are pure-ish and come out cleanest; do `delegateStream` last because it carries the compat/runtime facade branch and the stall wiring that F005 also touches.

**2. F005 — One abort-composition helper in watchdog.ts**

Three sites currently hand-roll "run signal + stall timer + listener detach". Extract:

```ts
// watchdog.ts
export const composeAbortWithStall = (
  runSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void; stall: () => boolean } => { ... }
```

Then routing.ts:829, typesafe.ts:315, and provider.ts:636 each shrink by ~15 lines and stop drifting (the `{ once: true }` discrepancy is already a latent behavioral difference).

**3. F006 — Test `truncate.ts` and `watchdog.ts`**

Both run on every routed turn and neither has a test file. `truncateContext` has the trickiest contract in the repo (protect first message + last user message by role, evict toolCall/toolResult pairs together, best-effort when only protected messages remain) and it is exactly the code that will silently corrupt a long conversation. Write the tests first, then do F007 — the O(n²) fix is behavior-preserving only if the tests exist.

**4. F004 — Parameter-object `decideRouting`**

11 positional parameters is the smell; the 228-line body is the disease. Introduce `RoutingInput`, then split the priority chain into named steps. The chain order (pin → budget → rule → classifier → veto → heuristic) is the real contract — make it a sequence of small functions, each returning a partial outcome, so the next feature adds a step instead of another `let`.

**5. F003 — `RouterState` class in index.ts**

The getter-bag wiring between index.ts, provider.ts, and commands.ts exists only because state is 20 closure variables. A small state holder with typed access removes the bags, makes state ownership visible, and is the prerequisite for F008's provenance split landing cleanly.

## Quick wins

- [ ] F016: Delete dead exports `bumpClosureCapture` / `markClosureDead` (closure.ts:81,86) — 2 lines.
- [ ] F017: Delete the provider.ts:74-76 re-export block; fix the two test imports.
- [ ] F018: Replace `mergeClassifier` with the generic merge (config.ts:136).
- [ ] F019: Extract `resolveFallbackList` (config.ts:332,525).
- [ ] F028: Add the "chat backend only" clause for `classifierModel.thinking` in README.md:144.
- [ ] F025: Hoist the inline `6` to `CLASSIFIER_HISTORY_MESSAGES` (routing.ts:312).
- [ ] F023: Add `npm run test:coverage` to ci.yml.
- [ ] F020/F029: Remove the two `as any` casts (commands.test.ts:353,856).
- [ ] F024: Cache the typesafe API key read (typesafe.ts:42).

## Things that look bad but are actually fine

- **The eight `ponytail:` comments** (closure.ts:253, config.ts:751, index.ts:228, provider.ts:88,667,696,743, routing.ts:113) look like unresolved debt markers. Each is the opposite: a deliberate, investigated decision with the reason recorded (no registry = advertise images, because registration precedes `session_start`; the runtime facade cast, because pi does not publish the type). Deleting them would remove real documentation. Leave them.
- **`estimateTokens` at 3 chars/token** (truncate.ts:11) is a crude estimator, but the doc block records that the registry exposes no tokenizer and the ratio is deliberately pessimistic so truncation errs eager. Correct for its purpose.
- **`parseClassifierOutput` line-regex parsing of free-form LLM output** (routing.ts:704) looks fragile, and it is — but `failureReason: 'unparseable'` is a first-class result that `decideRouting` threads into the decision provenance (routing.ts:535), so a parse failure is visible rather than silent. The fragility is contained by design.
- **The huge incident-citation comment blocks in provider.ts and closure.ts** (phantom-abort, 2026-09-09) read as over-commented, but they cite pi internal line numbers (`agent-session.js:367-374`, `agent-loop.js:238`) that would be unrecoverable after the fact. This code depends on pi internals; the citations are load-bearing.
- **`createAbortedMessage` / `createErrorMessage` re-exports from provider.ts** (provider.ts:74-76) are a backward-compat surface — but only tests import them, so this is F017 (Low), not a compatibility constraint.
- **knip's 19 "unused exports"** are almost all false positives: `classifyByHeuristics`, `isLowConfidence`, `readTypesafeApiKeyFile`, `buildTypesafeQuestions`, `toConfidenceLevel`, `mapTypesafeResponse`, `estimateTokens`, `containsAnyWord`, and friends are all consumed internally or by tests (verified by grep). Only F016's two closure aliases are genuinely dead.
- **`runTypesafeClassifier` appears to ignore the configured model ref** — it does not; it uses `modelId || TYPESAFE_DEFAULT_MODEL` (typesafe.ts:344), so a configured `typesafe/jev-latest`-style ref is honored.
- **`decideRouting`'s flat priority chain with 12 `let` locals** is genuinely hard to read (F004), but the behavior is exhaustively pinned by 124 routing tests including the FR-numbered decision-table cases. The debt is maintainability, not correctness.

## Open questions for the maintainer

1. **`resolvedThinkingLevels` (F010)** — is the runtime gate supposed to eventually consult this config-derived set, or is it permanently advisory? If permanent, it should leave the type contract.
2. **`RoutingDecision` provenance sprawl (F008)** — is the 24-flag shape a deliberate observability surface (the debug widget reads all of it), or accretion? The answer decides whether F008 is a split or a documentation task.
3. **Untested modules (F006)** — is the absence of truncate/typesafe/watchdog test files a deliberate "covered indirectly" stance, or did they fall through? provider.test.ts does exercise truncation incidentally, but not the pair-eviction or protected-message rules.
4. **`*` peerDependency ranges (F014)** — deliberate (pi pins the extension version at install) or an unpinning oversight?
5. **`classifierCalibration` (`MAX_CALIBRATION_ENTRIES = 5`)** — the `/router fix` calibration path is wired through commands.ts and state.ts. Is it actively used, or is it a partially-built feature? If unused, it is dead state on the persisted shape.
6. **The two 0.85 confidence floors (F009)** — `CLASSIFIER_OVERRIDE_FLOOR` and `CLASSIFIER_VETO_FLOOR` are equal today. Intended to drift independently, or should they be one constant?
