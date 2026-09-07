---
date: 2026-07-13T19:15:32+0700
author: Yogiswara Utama
commit: c028bcb9
branch: main
repository: pi-model-router
topic: 'AI-slop & bad-design audit of the pi-model-router extension'
tags: [research, ai-slop, code-quality, refactor, extensions]
status: ready
last_updated: 2026-07-13T19:15:32+0700
last_updated_by: Yogiswara Utama
---

# Research: AI-slop & bad-design audit of the pi-model-router extension

## Research Question

> de ai-slop codebase. find any bad design or ai slop generated code

Identify concrete AI-slop signatures and bad-design patterns in the `pi-model-router` extension source, classify them, and recommend concrete fixes. The extension is a pi-coding-agent extension that registers a custom logical "router" model provider that delegates to underlying models based on heuristics, keyword rules, an optional LLM classifier, and per-profile pin/thinking overrides.

## Summary

The codebase (~4,000 production lines across 8 source files plus 8 test files) is functionally complete but carries multiple unmistakable AI-generated code signatures: 11 LLM-session breadcrumb comments (6 `// ponytail:` + 5 `Decision N` references to a non-existent decision log), a 30-property getter/setter proxy that replaces a class, two `setTimeout(resolve, 50)` race-condition workarounds for registry eventual consistency, a 380-line async IIFE that mutates a `RoutingDecision` object across four phases, an 11-parameter `decideRouting` function with six hardcoded keyword arrays re-allocated on every call, a `wordBoundaryRegexCache` Map that grows unboundedly with no clear API, and four duplicated mutation+persist+warn call sites for the same pin/thinking operation.

The patterns are layered on a defensible architectural idea (rule > classifier > keyword-ladder > budget cap), but the execution is sloppy. Severity is mixed: some smells (the `setTimeout` races, the unbounded cache, the LLM breadcrumbs) are real maintenance hazards; others (the proxy pattern, the in-function keyword arrays) are stylistic debt that works but bloats the surface. The fixes are mostly local: extract a `setPinForProfile` / `setThinkingForProfile` pair, replace the proxy with a class, atomize `RoutingDecision` construction, clear the regex cache on config reload, strip the `// ponytail:` and `Decision N` comments, and replace the timeouts with a registry-ready signal or a poll loop with backoff.

## Detailed Findings

### Smell 1 — Hardcoded keyword arrays inside `decideRouting` body

- **Where**: `extensions/routing.ts:225-307` — six arrays (`explicitHighHints`, `explicitLowHints`, `planningKeywords`, `summaryKeywords`, `implementationKeywords`, `lookupKeywords`) are declared **inside** `decideRouting`'s body and re-allocated on every call
- **Why bad**: Not in `extensions/constants.ts:1-3` (which exists and would be the natural home). Not user-configurable. Not exported. Users cannot inspect or override them, and there is no debug introspection to determine which array fired (the `heuristic` source in `index.ts:110` is opaque). The 11-parameter signature at `routing.ts:207-217` is a related symptom
- **Verdict**: AI-slop. The arrays should be in `constants.ts` (cheap) or in a `RouterConfig.keywords` field (lets users add/remove), not reallocated per call
- **Fix**: Move the six arrays to `constants.ts` as exported consts. Add a `keywords?` field to `RouterConfig` so users can extend/supplement them. The `decision` debug event should record which array matched (e.g. `decision.matchedHint: 'plan' | 'fast' | null`)

### Smell 2 — `wordBoundaryRegexCache` is unbounded, never cleared, never exposed

- **Where**: `extensions/routing.ts:80` — `const wordBoundaryRegexCache = new Map<string, RegExp>();`
- **Why bad**: Module-level closure. Populated by `wordBoundaryRegex(keyword)` at `routing.ts:82-89` on every unique `RoutingRule.matches` keyword. After `/router reload` (`commands.ts:505-510`), old keywords remain cached. No `clearWordBoundaryCache` export exists. Cache is read only at `routing.ts:192` inside `matchHighestTierRule`
- **Verdict**: Real AI-slop. Low memory cost in practice, but a correctness landmine if the cache is ever read for any other purpose (debug introspection, validation)
- **Fix**: Either clear in `reloadConfig` action at `index.ts:170-187`, or bound the cache with an LRU (e.g. cap at 256 entries). The cleaner fix: drop the cache entirely and rebuild the regex per call — `containsAnyWord` is called at most once per `decideRouting` invocation, and modern V8 makes small `RegExp` construction cheap. Measure first, optimize only if hot

### Smell 3 — Asymmetric substring vs word-boundary matching

- **Where**: `extensions/routing.ts:75-77` (substring `containsAny`) vs `routing.ts:90-93` (word-boundary `containsAnyWord`)
- **Why bad**: `containsAny` is used in 8 sites in the keyword ladder (`routing.ts:333,334,365,370,375,380,391,397`) and the classifier veto. `containsAnyWord` is used in exactly **1** site (`routing.ts:192`) for user rules. Concrete false positives: `"fast"` matches `"breakfast"`, `"fastidious"`, `"outfast"`; `"brief"` matches `"debriefing"`; `"plan"` matches `"plane"`, `"planet"`, `"explanation"`, `"complain"`; `"code"` matches `"encode"`, `"decode"`, `"barcode"`; `"list"` matches `"playlist"`, `"blacklist"`. The veto at `routing.ts:334` is the most damaging — a classifier that picked `medium` is forced to `low` because the prompt contains "fast" inside an unrelated word
- **Verdict**: Unambiguous bad design. The two helpers exist in the same file, look superficially equivalent, and have different semantics that the user cannot tell apart from call sites
- **Fix**: Pick one. Recommendation: word-boundary for everything, with explicit multi-word phrase support (the existing arrays already include `"step by step"`, `"one line"`, `"add tests"`, `"go ahead"`, `"make the changes"` which the word-boundary regex handles). If substring is intentional for the hint lists, rename to `containsAnySubstring` and document the asymmetry

### Smell 4 — `decideRouting` 11-parameter signature

- **Where**: `extensions/routing.ts:207-217`
- **Why bad**: Eleven positional parameters; `ruleHit` and `classifierResult` are pre-computed by the caller (`provider.ts:307-323`) but are also independently computable inside `decideRouting` via `matchHighestTierRule` and `runClassifier`. The contract is muddy: who owns the classifier call? Both paths exist
- **Verdict**: Code smell. Not catastrophic but the function should take a single `RoutingContext` object
- **Fix**: Bundle the inputs into a `RoutingContext` type in `types.ts`. Move `matchHighestTierRule` and `runClassifier` calls back inside `decideRouting` if the latency is acceptable, or keep them external and document the contract. Either way: drop the 11-positional-args pattern

### Smell 5 — Non-atomic `RoutingDecision` construction

- **Where**: `extensions/routing.ts:149-181` (`buildRoutingDecision`) constructs 9 of 19 fields. Caller at `routing.ts:462-478` then bolts on `isRuleMatched`, `isPinned`, `isBudgetForced`, plus conditional classifier provenance (5 more fields). The same bolt-on pattern is repeated at `extensions/provider.ts:409-430` for image-promoted decisions
- **Why bad**: The `RoutingDecision` interface at `extensions/types.ts:77-95` declares 10 optional fields, but `isRuleMatched`, `isPinned`, and `isBudgetForced` are **always** assigned at `routing.ts:462-464`. TypeScript treats them as optional, so every consumer either defensively checks `undefined` or assumes presence. The pattern must be kept in sync across 3 sites: `routing.ts:462-464`, `routing.ts:470-477`, and `provider.ts:409-430`
- **Verdict**: Genuine bad design. The 19-field object is a constructor call hiding behind a helper. The Google continuation guard at `provider.ts:355-370` uses spread to produce a new object, which is the correct pattern; the bolt-on pattern is the regression
- **Fix**: Pass all provenance fields as named parameters to `buildRoutingDecision` (or rename it to `createRoutingDecision` and inline). Eliminate the post-hoc `decision.field = value` lines. Make `isRuleMatched`, `isPinned`, `isBudgetForced` required (non-optional) in the type since they are always populated. Keep the truly-conditional ones (classifier fields) optional

### Smell 6 — 380-line async IIFE in `streamSimple` mutates `decision` in place

- **Where**: `extensions/provider.ts:256-640` — the `streamSimple` body is a 380-line async IIFE that mutates a single `decision` object through 4 phases: initial routing (`provider.ts:306`), Google continuation guard (`provider.ts:355-370`), image promotion (`provider.ts:375-430`), cross-tier fallback (`provider.ts:515-530`)
- **Why bad**: The mutation is the design — each phase reads `decision.tier` and produces a new `decision` (or mutates it). The phases are not independently testable. The cross-tier fallback loop at `provider.ts:460` re-truncates context per tier using that tier's own `resolveContextWindow` (`provider.ts:531-535`), so a 200k `high` tier and a 1M `low` tier can each re-truncate the original context. `effectiveContext` is reset to `context` at `provider.ts:529` (not the previous tier's truncated context), so the per-tier re-truncation is independent
- **Verdict**: Real AI-slop signature. The function works but is unmaintainable. Phase extraction is non-trivial because each phase reads the previous mutation
- **Fix**: Extract each phase into a pure function that takes the current `decision` and returns a new `decision`: `applyGoogleGuard(decision, ctx)`, `applyImagePromotion(decision, profile, ctx)`, `applyCrossTierFallback(decision, profile, ctx)`. The cross-tier fallback can use a separate `streamWithFallback(context, tier, model, options)` that owns its own context truncation. This also makes each phase unit-testable

### Smell 7 — `truncateContext` is O(n²) with magic-number token estimator

- **Where**: `extensions/provider.ts:73` — `Math.ceil(text.length / 3)`. `extensions/provider.ts:78-145` — the function uses `messages.shift()` (O(n)) inside a while loop (O(n)) and splices orphaned toolResults (O(n)). Token count is recomputed via `messages.reduce()` on every iteration
- **Why bad**: The 3-chars-per-token ratio is described in the comment as "conservative" but is not calibrated to any specific tokenizer — it overestimates for English (~4 chars/token GPT, ~3.5 Claude) and underestimates for CJK (~1-1.5 chars/token). The O(n²) is fixable in 10 lines: maintain a running token sum, subtract on eviction, and pre-compute a `toolCallId → index` map for the toolResult cleanup
- **Verdict**: Bad design. The conservative-by-overestimating claim is true for English, false for CJK. The O(n²) is a perf hazard if the conversation grows long and context is repeatedly truncated across fallback tiers
- **Fix**: Maintain a running token sum incrementally. Build a `Set<string>` of `toolCallId`s that have been removed and skip them. The 3-chars-per-token heuristic is acceptable for English — leave it but add a comment naming the calibration (or use the upstream `tiktoken` library if it is already a dependency)

### Smell 8 — `setTimeout(resolve, 50)` race conditions × 2 + 13 in tests

- **Where**: `extensions/index.ts:224` (`switchToRouterProfile`), `extensions/index.ts:311` (`restoreStateFromSession`). `provider.test.ts` uses `setTimeout(resolve, 100)` in 13 instances
- **Why bad**: Both production sites are documented as "Give the registry a moment to synchronize." The `pi.registerProvider()` API (`provider.ts:185`) is fire-and-forget — no callback, no promise, no event. 50ms is a guess. The tests double it to 100ms, which is a tacit admission that 50ms is borderline
- **Failure mode**: If the registry takes >50ms, `ctx.modelRegistry.find('router', profileName)` returns `undefined`, the user sees a notification (not an error, a notification) and `routerEnabled` is set to `false` (`index.ts:350`). The router is **permanently disabled** for the session — there is no retry. The persisted state (pins, thinking, debug history) is loaded but inert
- **Verdict**: AI-slop. The pattern is a classic "works on my machine" fix. The tests doubling the delay confirm the value is arbitrary
- **Fix**: Poll `ctx.modelRegistry.find()` in a retry loop with exponential backoff (e.g. 10ms → 20ms → 50ms → 100ms, cap at 500ms / 5 attempts). If still not found, then disable. Better: check whether `pi` exposes a registry ready event and subscribe to it. The 13 test-side timeouts should also be replaced with explicit waits on a resolved promise

### Smell 9 — Getter/setter proxy replacing a class

- **Where**: `extensions/index.ts:196-235` (provider proxy), `extensions/index.ts:258-280` (commands proxy). Together: ~30 properties defined as manual `get`/`set` accessors to bridge closure-scoped `let` variables into child modules
- **Why bad**: The pattern replaces what would be a `class RouterState` with ~15 fields and ~10 methods. The `actions` object at `index.ts:105-155` is a separate layer of the same anti-pattern. The result is ~80 lines of proxy boilerplate. Two proxies duplicate slightly different subsets of the same state — a class would expose all fields uniformly
- **Inconsistency**: `pinnedTierByProfile` and `thinkingByProfile` are passed as **direct object references** at `index.ts:271-272` and `index.ts:299-300`, not through getters. This means a future refactor that reassigns `pinnedTierByProfile = {}` would break child modules silently. The in-place `delete` loop at `index.ts:300-305` is a band-aid: `// Clear in-place to keep references intact` at `index.ts:299` explicitly acknowledges the debt
- **Concurrency**: The `delete` loop at `index.ts:300-305` is synchronous with no `await` between it and the subsequent `Object.assign` at `index.ts:313`, so it is currently safe under Node's single-threaded event loop. But this is a fragile-by-convention guarantee — any future `await` inserted between the clear and repopulate would create a race
- **Verdict**: Unnecessary complexity. The 50ms `setTimeout` at `index.ts:311` (Q8) creates an `await` gap immediately before the `delete` loop, during which a `streamSimple` call from another event could read stale pin state
- **Fix**: Convert the closure to a class. `class RouterExtensionContext { currentConfig; currentModelRegistry; routerEnabled; pinnedTierByProfile; ... }`. Pass the instance to both `registerRouterProvider` and `registerCommands`. Eliminate the proxy objects and the `actions` indirection. The `actions` become instance methods

### Smell 10 — LLM-session breadcrumb comments (6 × `ponytail:` + 5 × `Decision N`)

- **Where**:
  - `// ponytail:` at `routing.ts:79,627`; `config.ts:690`; `provider.ts:228,543,591`
  - `// Decision 1` at `routing.ts:332`; `// Decision 6` at `routing.ts:345`; `// Decision 9` at `config.ts:683,691` (referenced twice in 8 lines); `// Decision 10` at `index.ts:98`
- **Why bad**: The `// ponytail:` prefix is a session marker from an AI assistant (the convention is not documented in `AGENTS.md` or `README.md`). The `Decision N` references point to a non-existent decision log — a grep for `ADR` / `DECISIONS` / `decision.log` returns zero results. The `getUnsupportedTiers` docblock at `config.ts:660-688` is 28 lines of comment for a 12-line function, with meta-commentary like `// The level === 'off' short-circuit was removed (Decision 9)` that documents the AI's process rather than the code's behavior
- **Verdict**: Definitive AI-slop. 11 orphaned artifacts across 4 files, referencing unreachable context. The comments themselves range from redundant (`routing.ts:79` restates the next two lines) to genuinely useful (`provider.ts:543` documents a real cross-package type inconsistency), but none benefit from the `ponytail:` prefix
- **Fix**: Strip `// ponytail:` from all 6 sites. The 5 `Decision N` references should be either: (a) replaced with links to actual issue-tracker entries, (b) replaced with `// NOTE:` + a one-sentence behavioral rationale, or (c) removed entirely. The 28-line `getUnsupportedTiers` docblock should be cut to ~6 lines: describe the registry gate, the resolution chain, and the registry-miss semantics. Drop the "mirrors `provider.ts`" coupling

### Smell 11 — Duplicated mutation+persist+warn pattern across 4 sites

- **Where**:
  - `handlePin` at `commands.ts:265-278` — `state.pinnedTierByProfile[currentProfile] = nextTier; actions.persistState(); actions.updateStatus(ctx);` (no warning)
  - `handleThinking` at `commands.ts:349-385` — full mutation + persist + update + `syncPiThinkingLevel` + `getUnsupportedTiers` warning
  - `handleFix` at `commands.ts:442-448` — `state.pinnedTierByProfile[state.lastDecision.profile] = tier; actions.persistState(); actions.updateStatus(ctx);` (no warning)
  - `thinking_level_select` handler at `index.ts:507-533` — mirrors the all-tiers branch of `handleThinking` almost exactly
- **Why bad**: The pattern `mutate state → persistState() → updateStatus(ctx) → optionally warn` appears 4 times with near-identical warning logic. The `index.ts:521-530` block and `commands.ts:376-385` block differ only in the level source (UI event vs. parsed command arg) and the scope label (`'all'` vs. concrete tier)
- **Verdict**: Real abstraction gap. The `state` proxy at `index.ts:402-445` already exposes `thinkingByProfile` as a mutable reference, so a shared helper could be called from both sites through the same `actions` object. The `actions` object already contains `persistState` and `updateStatus` — the exact calls that would go into the shared helper
- **Fix**: Extract two helpers into a new `extensions/state-mutators.ts` (or as methods on the class proposed in Smell 9):
  - `setPinForProfile(profile, tier)` — encapsulates set/delete logic from `handlePin` + `handleFix` + `persistState` + `updateStatus`
  - `setThinkingForProfile(profile, tierOrAll, level)` — encapsulates the tier-loop + single-tier assignment + empty-object cleanup + `persistState` + `updateStatus` + `syncPiThinkingLevel` + `getUnsupportedTiers` warning
  - All 4 call sites collapse to one or two lines each. The warning logic stops being duplicated

### Smell 12 — `handlePin` and `handleFix` mutate different profiles silently

- **Where**: `commands.ts:267` pins `state.pinnedTierByProfile[currentProfile]`; `commands.ts:442` pins `state.pinnedTierByProfile[state.lastDecision.profile]`
- **Why bad**: These look like they do the same thing but pin different profiles. If the user switched profiles between routing and `/router fix`, the fix pins the wrong profile. The notification at `commands.ts:445-447` only names the pinned profile, not the active one, so the user has no way to know which profile was affected
- **Verdict**: Latent footgun. Not currently a bug because the fix command usually runs immediately after a routed turn, but the design is fragile
- **Fix**: Either disallow `/router fix` when `lastDecision.profile !== selectedProfile` (warn the user), or always pin the active profile (drop the `lastDecision.profile` reference). The unified `setPinForProfile` helper from Smell 11 would centralize the policy

## Code References

- `extensions/routing.ts:75-77` — `containsAny` substring helper (8 call sites)
- `extensions/routing.ts:80-89` — `wordBoundaryRegexCache` module-level Map + `wordBoundaryRegex`
- `extensions/routing.ts:90-93` — `containsAnyWord` word-boundary helper (1 call site at line 192)
- `extensions/routing.ts:130-181` — `buildRoutingDecision` constructs 9 of 19 fields
- `extensions/routing.ts:192` — only consumer of `containsAnyWord` (in `matchHighestTierRule`)
- `extensions/routing.ts:207-217` — `decideRouting` 11-parameter signature
- `extensions/routing.ts:225-307` — six hardcoded keyword arrays re-allocated per call
- `extensions/routing.ts:332` — `// Decision 1` classifier-veto comment
- `extensions/routing.ts:345` — `// Decision 6` phase-decoupling comment
- `extensions/routing.ts:382-396` — post-hoc `decision.field = value` bolt-on
- `extensions/routing.ts:462-478` — caller-side bolt-on for provenance fields
- `extensions/routing.ts:627` — `// ponytail:` infra-failure catch comment
- `extensions/provider.ts:60` — `estimateTokens` 3-chars-per-token magic number
- `extensions/provider.ts:65-145` — `truncateContext` O(n²) loop with toolResult splice
- `extensions/provider.ts:185` — `pi.registerProvider('router', ...)` fire-and-forget
- `extensions/provider.ts:228` — `// ponytail:` registry-image advertisement comment
- `extensions/provider.ts:256-640` — 380-line `streamSimple` async IIFE (4 mutation phases)
- `extensions/provider.ts:355-370` — Google continuation guard (uses spread — the correct pattern)
- `extensions/provider.ts:375-430` — image-attachment tier promotion (uses bolt-on — the wrong pattern)
- `extensions/provider.ts:409-430` — second `decision.field = value` site (must stay in sync with `routing.ts:462`)
- `extensions/provider.ts:515-530` — cross-tier fallback mutates `decision` in place
- `extensions/provider.ts:529` — `effectiveContext = context` reset (per-tier re-truncation)
- `extensions/provider.ts:531-535` — `resolveContextWindow` called per fallback tier
- `extensions/provider.ts:543` — `// ponytail:` runtime-guard type narrowing
- `extensions/provider.ts:591` — `// ponytail:` partial-stream cost comment
- `extensions/index.ts:50-51` — `pinnedTierByProfile` and `thinkingByProfile` declared
- `extensions/index.ts:98` — `// Decision 10` structured isPinned comment
- `extensions/index.ts:105-155` — `actions` object closure wrapping
- `extensions/index.ts:196-235` — `registerRouterProvider` state proxy (~14 properties)
- `extensions/index.ts:224` — first `setTimeout(resolve, 50)` race
- `extensions/index.ts:258-280` — `registerCommands` state proxy (~14 properties)
- `extensions/index.ts:299-305` — in-place `delete` loop with self-acknowledged comment
- `extensions/index.ts:311` — second `setTimeout(resolve, 50)` race
- `extensions/index.ts:402-445` — second `actions`/proxy object passed to `registerCommands`
- `extensions/index.ts:507-533` — `thinking_level_select` handler (duplicates `handleThinking`)
- `extensions/commands.ts:232-281` — `handlePin` (mutates `currentProfile`)
- `extensions/commands.ts:288-370` — `handleThinking` (all-tiers + single-tier branches)
- `extensions/commands.ts:362-364` — empty-object cleanup after thinking override
- `extensions/commands.ts:371-380` — `handleFix` (mutates `lastDecision.profile`)
- `extensions/commands.ts:376-385` — `getUnsupportedTiers` warning block
- `extensions/commands.ts:443` — `switch` dispatch for 10 subcommands
- `extensions/commands.ts:497-510` — `handleReload`
- `extensions/commands.ts:505` — `actions.reloadConfig(ctx, { preserveDebug: true })`
- `extensions/config.ts:393-409` — `loadRouterConfig` (does not clear regex cache)
- `extensions/config.ts:604-622` — `resolveContextWindow` (4-tier resolution chain)
- `extensions/config.ts:660-700` — `getUnsupportedTiers` 28-line docblock + 12-line body
- `extensions/config.ts:683,691` — `// Decision 9` references (duplicated within 8 lines)
- `extensions/config.ts:690` — `// ponytail:` registry short-circuit comment
- `extensions/types.ts:11-15` — `RoutingRule` interface
- `extensions/types.ts:66-89` — `RoutingDecision` interface (10 optional fields, 3 are always populated)
- `extensions/constants.ts:1-3` — only 3 constants exported; the 6 keyword arrays should live here
- `provider.test.ts` — 13 × `setTimeout(resolve, 100)` (test-side delay doubling)

## Integration Points

### Inbound References

- `extensions/index.ts:30-33` — closure-scoped `let` declarations for all 15+ state variables
- `extensions/index.ts:131-141` — `registerRouterProvider` is called from `actions.reloadConfig`
- `extensions/index.ts:196-235` — provider state proxy wiring
- `extensions/index.ts:258-280` — commands state proxy wiring
- `extensions/commands.ts:44-80` — `registerCommands` consumes the `state` + `actions` shapes
- `extensions/provider.ts:152-168` — `registerRouterProvider` declares the 10-field state + 5-callback actions shape

### Outbound Dependencies

- `@earendil-works/pi-ai` — provides `Model`, `Context`, `streamSimple`, `AssistantMessageEventStream`, `ThinkingLevel`
- `@earendil-works/pi-coding-agent` — provides `ExtensionAPI`, `ExtensionContext`, `modelRegistry`
- `@earendil-works/pi-agent-core` — provides `ThinkingLevel` (includes `'off'`)
- `node:fs` (`existsSync`, `readFileSync`), `node:path` (`join`) — config loading in `config.ts:1-2`
- `getAgentDir` from `@earendil-works/pi-coding-agent` — global config path

### Infrastructure Wiring

- `extensions/index.ts:131-141` — `actions.reloadConfig` → `loadRouterConfig` + `registerRouterProvider`
- `extensions/index.ts:155-170` — `registerRouterProvider` re-registration guard via `lastRegisteredModels`
- `extensions/index.ts:283-365` — `restoreStateFromSession` lifecycle (called from `session_start` event)
- `extensions/index.ts:367-388` — `model_select` event handler (router enable/disable)
- `extensions/index.ts:390-400` — `turn_end` event handler (re-restore router model)
- `extensions/index.ts:402-445` — `thinking_level_select` event handler (all-tiers override)
- `extensions/commands.ts:443-540` — `switch` dispatch for 10 subcommands
- `provider.ts:185` — `pi.registerProvider('router', ...)` — the fire-and-forget call that the 50ms timeouts try to race against

## Architecture Insights

1. **State lives in closures, not in instances.** The 15+ `let` variables at `extensions/index.ts:30-33` are bridged to two child modules via getter/setter proxies. This is the single most expensive design choice in the codebase — it forces the inconsistent mutation model (proxied primitives + shared-by-ref objects), the in-place `delete` workaround, the `actions` indirection layer, and the duplicated mutation+persist+warn pattern.

2. **`RoutingDecision` is a 19-field bag assembled in three places.** `buildRoutingDecision` at `routing.ts:149-181` constructs 9 fields. Caller at `routing.ts:462-478` adds 3. The image-promotion block at `provider.ts:409-430` carries forward 8. The Google guard at `provider.ts:355-370` uses object spread (the right pattern). The three sites must be kept in sync manually.

3. **The tier-selection precedence is intentional and defensible.** Pin > rule > classifier > classifier-veto > keyword-ladder > budget-cap. The architectural shape is sound; the implementation noise is in the keyword ladders (hardcoded + substring) and the post-hoc field assignment.

4. **The `setTimeout(50)` pattern is the clearest AI-slop signal.** It is duplicated (twice in production, 13 times in tests), undocumented (no rationale for 50 vs 100), and has no recovery path. The tests doubling the value is a tacit admission.

5. **The `// ponytail:` and `Decision N` comments are session breadcrumbs.** The "ponytail:" prefix is a non-standard convention (not in `AGENTS.md`, not in `README.md`). The `Decision N` references point to a decision log that does not exist. Both should be stripped or replaced with standard `// NOTE:` comments.

6. **The `wordBoundaryRegexCache` is a micro-optimization that backfired.** A module-level `Map` to avoid recompiling per-call regex. The cost of `new RegExp(\b${escaped}\b, 'i')` is negligible compared to the routing logic that uses it, and the cache creates a liveness problem on config reload. The honest fix is to remove the cache.

## Precedents & Lessons

0 similar past changes analyzed. No prior research, design, or blueprint artifacts exist in `.rpiv/artifacts/` (the directory was not present before this run). No `ADR` / `DECISIONS` / decision log file exists in the repository despite the 5 `Decision N` code comments referencing one.

### Composite Lessons

- The `// ponytail:` and `Decision N` comment pattern is a strong tell for AI-generated code. A future audit of any code that has both an unreferenced "decision log" and a non-standard session-marker comment prefix should treat both as cleanup candidates
- The 11-parameter function + 15-injection-point function pair (`decideRouting` + `registerRouterProvider`) is a near-deterministic AI signature. A natural-language input has 11+ distinct fields to express; a human-written wrapper would either (a) bundle them into a context object or (b) split them into multiple functions
- The `setTimeout(50)` + `setTimeout(100)` in tests pattern is another tell: it means the author could not find a deterministic completion signal and guessed
- A 28-line docblock for a 12-line function is a meta-commentary smell — comments about why code was changed belong in a commit message, not in the file

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/` does not exist yet in this repository. This is the first artifact

## Developer Context

**Q (`extensions/provider.ts:531-535`): The 3-chars-per-token estimator is uncalibrated and the O(n²) `truncateContext` runs once per fallback tier. Is the cost measurable in a real session, or is this theoretical?**
A: pending

**Q (`extensions/routing.ts:225-307`): The 6 keyword arrays are re-allocated on every `decideRouting` call. Hot path? Or one-shot per turn?**
A: pending

**Q (`extensions/index.ts:224,311`): Is there a real-world `pi.registerProvider` "ready" signal the 50ms timeouts are trying to race against, or are they guessing?**
A: pending

**Q (`extensions/commands.ts:232-281` vs `commands.ts:371-380`): Should `handleFix` pin the active profile (drop `lastDecision.profile` reference) or warn when it differs?**
A: pending

**Q (`extensions/routing.ts:80`): Is the `wordBoundaryRegexCache` measurable in CPU/memory in a long-running session, or theory?**
A: pending

## Related Research

- None (first research artifact for this repo)

## Open Questions

- Is the per-tier re-truncation in `provider.ts:529-535` measurably expensive in real sessions, or is it a theoretical concern?
- Does `pi` expose a registry ready event/signal that would replace the 50ms `setTimeout` guesses at `index.ts:224,311`?
- What is the 90th/99th percentile latency of `pi.registerProvider` + `modelRegistry.find` in production? (Affects whether the timeouts are even close to sufficient)
- Are there any tests for the `containsAny` vs `containsAnyWord` semantic difference, or is the divergence untested?
- The `wordBoundaryRegexCache` is unbounded — is there an upper bound on the number of distinct `RoutingRule.matches` keywords a user might reasonably configure? (Affects whether the cache is even worth keeping)
