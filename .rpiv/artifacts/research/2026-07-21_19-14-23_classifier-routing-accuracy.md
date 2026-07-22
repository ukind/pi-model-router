---
date: 2026-07-21T19:14:23+0700
author: Yogiswara Utama
commit: e4b5601f
branch: main
repository: pi-model-router
topic: 'increase the accuration of decision making / routing if using classifier model in this project'
tags: [research, classifier, routing, accuracy, confidence, prompt-engineering]
status: ready
last_updated: 2026-07-21T19:14:23+0700
last_updated_by: Yogiswara Utama
---

# Research: Increase Classifier-Based Routing Accuracy

## Research Question

How to increase the accuracy of decision making / routing when using the classifier model in the pi-model-router project.

## Summary

The classifier path (`runClassifier` at `extensions/routing.ts:540`) has 10 distinct accuracy gaps spanning parser fragility, dead confidence signal, impoverished prompt context, invisible failure cascades, binary override gates, and no feedback loop from user corrections. The single highest-leverage improvement is extracting the inline prompt template into a `buildClassifierPrompt()` function that injects the signals the heuristic branch already uses (toolResultCount, wordCount, multiLinePrompt, phaseBias, budget context). This refactor is the prerequisite for all other improvements: few-shot calibration exemplars, budget-aware self-downgrade, and richer context injection.

## Detailed Findings

### 1. Parser Robustness — Regex Heuristics Are Fragile (`extensions/routing.ts:488-530`)

`parseClassifierOutput` uses line-scanning regex to extract `Tier:`, `Confidence:`, `Reasoning:` labels. Three robustness gaps:

- **Markdown code fences**: If the model wraps output in ```json, the backtick stripping (`stripMarkdown` at line 492) only removes inline backticks, not code-fence delimiters. Lines inside the fence (`{"tier": "high"}`) don't match `/^tier:\s\*/i`→`unparseable`.
- **Tier extraction**: `tierWord = tierRaw.split(/\s+/)[0].replace(/[.!;,]+$/, '')` at line 517 strips trailing punctuation but not parentheticals. `Tier: high-quality` → `isRouterTier('high-quality')` → `false` → `unparseable`.
- **Confidence default**: Missing `Confidence:` line silently defaults to `'medium'` (line 552), not `'low'`. A structurally valid but uncertain classifier response is treated as medium-trust.

**Impact**: An unparseable response at line 629 causes `runClassifier` to `return undefined`, falling through to the heuristic branch with zero classifier provenance. The caller cannot distinguish "model refused JSON" from "infra failed" because `ClassifierFailureReason` at `extensions/types.ts:71` is only `'success' | 'unparseable'`.

**Fix**: Switch to JSON-mode via `streamSimple` options (if supported). Extend `ClassifierFailureReason` to `'success' | 'unparseable' | 'json-refused' | 'json-invalid' | 'infra-failure'`.

### 2. Confidence Dead Lever — Parsed, Persisted, Never Consumed (`extensions/routing.ts:477`, `extensions/state.ts:53`, `extensions/index.ts:114-115`)

`ConfidenceLevel` (`'high' | 'medium' | 'low'` at `types.ts:70`) is:

1. Parsed from classifier output (`routing.ts:511`)
2. Threaded onto `decision.confidence` (`routing.ts:477`)
3. Sanitized by `isConfidenceLevel` (`state.ts:53`)
4. Surfaced only cosmetically in notification provenance (`index.ts:114-115`: `(confidence: ${decision.confidence})`)

**No code path reads `decision.confidence` to influence routing**. The veto gate at `routing.ts:336-351` fires unconditionally regardless of confidence. The heuristic fallback at `routing.ts:316` is never triggered by low confidence.

**Fix**: When `classifierResult.confidence === 'low'`, degrade to the heuristic branch. This requires a `classifierAttempted` flag (Q6) to preserve provenance. The veto gate should only override when `confidence !== 'high'`.

### 3. Veto Gate — Binary Override Regardless of Confidence (`extensions/routing.ts:336-351`)

The veto gate uses `containsAnyWord` (`routing.ts:97`) against `explicitHighHints` / `explicitLowHints` arrays (`routing.ts:247-271`). Any single keyword match forces a tier flip regardless of:

- Classifier confidence level
- Disagreement magnitude (1-tier vs 2-tier gap)
- Context (e.g., "small" in "smallest" is guarded by word-boundary regex, but "fast" in "fastest" is not — `fastest` contains `fast` as a substring, and `\bfast\b` matches `fastest` because `\b` is between `s` and `t`)

**Impact**: A user saying "fast" while asking a complex architectural question forces `'low'` tier, overriding a confident `'high'` classifier judgment.

**Fix**: Confidence-aware veto — only veto when `classifierResult.confidence !== 'high'`, or when the hint and classifier disagree by ≥2 tiers. Add `classifierTier`, `vetoOutcome`, `vetoDisagreementMagnitude` fields to `RoutingDecision` for provenance.

### 4. Classifier Context — ~50% of Heuristic Signals Missing (`extensions/routing.ts:572`)

The classifier prompt at `routing.ts:572` receives: `getLastUserText`, `getRecentConversationText(context, 4)` (hard-coded 4), `currentPhase`, `hasImage`. The heuristic branch at `routing.ts:316-460` additionally uses:

| Signal                | Heuristic                                | Classifier                 |
| --------------------- | ---------------------------------------- | -------------------------- |
| `toolResultCount`     | ✅ `toolResultCount > 0`                 | ❌ Not passed              |
| `wordCount`           | ✅ `wordCount >= highThreshold`          | ❌ Not passed              |
| `multiLinePrompt`     | ✅ `prompt.split('\n').length >= 4`      | ❌ Not passed              |
| `phaseBias` (numeric) | ✅ `phaseBias * 80` threshold adjustment | ❌ Only static prose hints |
| `isBudgetExceeded`    | ✅ Post-decision downgrade               | ❌ Not passed              |
| History window        | ✅ Default 6 messages                    | ❌ Hard-coded 4 messages   |

**Impact**: The classifier makes decisions with half the signal the heuristic branch has. It cannot distinguish "many tool results → active implementation" from "fresh conversation."

**Fix**: Extract `buildClassifierPrompt()` function in `routing.ts` that accepts a context-bundle object. Inject `toolResultCount`, `wordCount`, `multiLinePrompt`, `phaseBias`, `isBudgetExceeded`. Increase history window from 4 to 6 (matching heuristics). This is the **linchpin refactor** — Q4, Q8, and Q9 all depend on it.

### 5. Rule Gating — Rules Suppress Classifier Entirely (`extensions/provider.ts:311`)

At `provider.ts:311`, the classifier gate is `if (!pinnedTier && !ruleHit && state.currentConfig.classifierModel)`. Any keyword rule match — even a low-tier rule for "summarize" — suppresses the classifier entirely. The classifier never gets a chance to correct a stale or overly-broad rule.

**Impact**: A user saying "Summarize the tradeoffs of this architecture and propose a migration strategy" matches a `summarize → low` rule, routes to `'low'`, and the classifier never sees it.

**Fix**: Always run the classifier when `classifierModel` is configured. Add agreement-mode merge logic in `decideRouting` at `routing.ts:324-332`: when rule and classifier disagree, prefer the higher tier when classifier confidence is high; trust the rule when classifier confidence is low.

### 6. Failure Cascade — Invisible Fallback (`extensions/routing.ts:540-641`, `extensions/provider.ts:310-326`)

`runClassifier` returns `undefined` on:

- Model not found (`routing.ts:549`)
- Auth rejected (`routing.ts:552`)
- Stream error before content (`routing.ts:620`)
- Parse failure (`routing.ts:629` — note: hard return, not `continue`, so parse failure aborts all fallbacks)

The `undefined` flows into `decideRouting` as a falsy `classifierResult`, taking the heuristic branch. `isClassifier` stays `false`, `failureReason` is never set. The debug notification shows `[heuristic]` — indistinguishable from a system with no classifier configured.

**Impact**: A systematically failing classifier (e.g., misconfigured model, expired API key) produces zero user-visible signal. The user sees heuristic routing and assumes the classifier is working.

**Fix**: Add `classifierAttempted: boolean` and `classifierFailureReason: string` to `RoutingDecision` (`types.ts:98-104`). Set in `provider.ts:312-326` (the only place that knows whether the classifier was configured and invoked). Surface in debug notification (`index.ts:108-112`), widget flags (`ui.ts:22`), and debug history (`commands.ts:335-345`).

### 7. Thinking Level — High Reasoning Hurts Classification (`extensions/routing.ts:604-605`)

The thinking gate at `routing.ts:604` is `model.reasoning && thinking && thinking !== 'off'`. When enabled, the model generates chain-of-thought tokens that are:

- Sent as `thinking_delta` events (line 618)
- **Discarded** — only `text_delta` is accumulated into `fullText` (line 619)
- Paid for in latency and cost

For a three-choice classification task (`high`/`medium`/`low`), chain-of-thought is unnecessary. It can reduce accuracy via over-analysis and format drift.

**Fix**: Default classifier thinking to `'off'` for fast models. Add per-model thinking config to `ClassifierConfig`. Strengthen prompt to request terse single-line reasoning.

### 8. Feedback Loop — `/router fix` Is a Dead-End (`extensions/commands.ts:71, 432-440`)

The `fix` command sets `state.pinnedTierByProfile[profile] = tier`, which short-circuits `decideRouting` at `routing.ts:228`. The corrected decision is stored in `debugHistory` (capped at `MAX_DEBUG_HISTORY = 12` in `constants.ts`), but:

- The classifier prompt text is not preserved
- The user's correction is not associated with the original classifier input
- No calibration data is accumulated for future few-shot learning

**Impact**: Every user correction is a one-off pin. The classifier never learns from its mistakes.

**Fix**: Add `ClassifierCalibrationEntry` type and `classifierCalibration` field to `RouterPersistedState` (`types.ts:107-119`). Record `{promptSummary, classifierTier, finalTier, userCorrection}` at decision time and `/router fix` time. Inject misclassifications as few-shot exemplars into `buildClassifierPrompt()`. Requires the prompt builder refactor (Q4).

### 9. Budget — Post-Hoc Override Discards Classifier Reasoning (`extensions/routing.ts:296-314`)

The budget downgrade at `routing.ts:296-314` runs **after** the classifier already picked its tier. The classifier's `reasoning` is preserved as a parenthetical, but the phase is overwritten. The classifier has no budget awareness.

**Impact**: A classifier that correctly identifies a high-tier task is force-downgraded to `'medium'` with `phase: 'implementation'`, contradicting its analysis. The debug notification shows `source: 'budget'`, not `source: 'classifier'`, so calibration (Q8) cannot distinguish "classifier was wrong" from "classifier was right but budget overrode it."

**Fix**: Pass `isBudgetExceeded`, `accumulatedCost`, `maxSessionBudget` to `runClassifier` and inject into `buildClassifierPrompt()`. Let the classifier self-downgrade with budget context, preserving consistent phase reasoning. Requires the prompt builder refactor (Q4).

### 10. Latency — No Caching, No Continuation Fast-Path (`extensions/provider.ts:306`, `extensions/routing.ts:540`)

`runClassifier` is `await`-ed synchronously at `provider.ts:316`, blocking all downstream work. The classifier streams its full response before `decideRouting` runs. There is:

- No caching of classification results for semantically similar prompts
- No "skip classifier when previous turn's decision still applies" fast-path
- The sticky-phase logic at `routing.ts:417` exists only in the heuristic branch and is bypassed when the classifier is active

**Impact**: Every turn adds one full LLM round-trip (500ms–5s) when `classifierModel` is configured and no rule/pin pre-empts it.

**Fix**: Add a prompt-hash cache (`Map<string, ClassifierResult>`) in `provider.ts` state before line 311. Add a continuation fast-path: if the previous decision was classifier-made and the current prompt is a continuation (short, contains "continue"/"resume"/"go ahead"), reuse the previous tier without invoking the classifier.

## Code References

- `extensions/routing.ts:488-530` — `parseClassifierOutput`: fragile regex parser
- `extensions/routing.ts:540-641` — `runClassifier`: classifier invocation with fallback loop
- `extensions/routing.ts:572-600` — Inline classifier prompt template (needs extraction)
- `extensions/routing.ts:336-351` — Veto gate: binary override regardless of confidence
- `extensions/routing.ts:296-314` — Budget downgrade: post-hoc override discards classifier reasoning
- `extensions/routing.ts:475-479` — Provenance threading: confidence written but never read for logic
- `extensions/provider.ts:311` — Classifier gate: `!pinnedTier && !ruleHit` suppresses classifier on rule match
- `extensions/provider.ts:316` — `await runClassifier(...)`: synchronous blocking of target-model delegation
- `extensions/types.ts:70` — `ConfidenceLevel` type: parsed, persisted, cosmetic-only
- `extensions/types.ts:71` — `ClassifierFailureReason`: only `'success' | 'unparseable'`, no infra-failure
- `extensions/types.ts:75-82` — `ClassifierResult`: needs `classifierAttempted` and richer failure reasons
- `extensions/types.ts:92-104` — `RoutingDecision`: needs `classifierTier`, `vetoOutcome`, `classifierAttempted`
- `extensions/types.ts:107-119` — `RouterPersistedState`: needs `classifierCalibration` array
- `extensions/state.ts:53` — `isConfidenceLevel`: sanitizer for cosmetic-only field
- `extensions/index.ts:114-115` — Only consumer of `decision.confidence`: cosmetic notification string
- `extensions/commands.ts:432-440` — `handleFix`: sets pin, no calibration recording
- `extensions/ui.ts:22` — `getDecisionFlags`: no `classifier-failed` flag
- `extensions/config.ts:476-478` — `normalizeConfig`: classifier thinking validation

## Integration Points

### Inbound References

- `extensions/provider.ts:304-336` — Provider invokes `runClassifier` and passes result to `decideRouting`
- `extensions/index.ts:94-120` — Debug notification reads `decision.confidence` and `decision.isClassifier`
- `extensions/commands.ts:335-345` — `/router debug show` reads `debugHistory` for classifier provenance
- `extensions/ui.ts:22-30` — Widget reads `decision.isClassifier` and `decision.confidence` for display

### Outbound Dependencies

- `extensions/routing.ts:1` — `streamSimple` from `@earendil-works/pi-ai/compat`: classifier model invocation
- `extensions/routing.ts:553-555` — `modelRegistry.getApiKeyAndHeaders`: auth for classifier model
- `extensions/routing.ts:563` — `modelRegistry.find`: model capability resolution
- `extensions/config.ts:55` — `isRouterTier`: tier validation gate
- `extensions/config.ts:580-585` — `normalizeConfig`: classifier thinking normalization

### Infrastructure Wiring

- `extensions/provider.ts:160-178` — State object holds `pinnedTierByProfile`, `lastDecision`, `accumulatedCost`
- `extensions/state.ts:152` — `buildPersistedState`: serializes `debugHistory` and `lastDecision`
- `extensions/state.ts:110-130` — `sanitizeRoutingDecisionFields`: sanitizes classifier provenance fields
- `extensions/index.ts:38-55` — Extension lifecycle: state initialization and restoration

## Architecture Insights

1. **Gate order is a critical invariant**: Budget → Pin → Rules → Classifier → Heuristics → phaseBias. Every change to this order has produced defects (precedents `14466e2f`, `f873288a`). The classifier is currently gated _before_ `decideRouting` at `provider.ts:311`, but the budget downgrade happens _after_ the classifier picks its tier at `routing.ts:296-314` — an ordering inconsistency that causes the budget to override classifier reasoning.

2. **The `buildClassifierPrompt()` refactor is the linchpin**: Three improvements (Q4 signal injection, Q8 calibration exemplars, Q9 budget awareness) all require extracting the inline template at `routing.ts:572` into a dedicated function. Without this extraction, none of them have an insertion point.

3. **Confidence is the most underutilized signal**: Parsed, persisted, and displayed — but never used for decision logic. Wiring it into the veto gate, the rule merge, and the heuristic fallback would be the highest-ROI single change after the prompt builder refactor.

4. **Invisible failures erode trust silently**: A systematically failing classifier (expired API key, misconfigured model) produces zero user-visible signal. The `classifierAttempted` flag is essential for debuggability.

5. **No learning loop**: Every `/router fix` is a one-off pin. The classifier never improves from corrections. A calibration subsystem would close this loop.

## Precedents & Lessons

5 similar past changes analyzed.

### Precedent: Classifier Decision-Making Overhaul

**Commit(s)**: `f873288a` — "feat: overhaul classifier decision-making with veto gate, structured result, and provenance" (2026-07-04)
**Blast radius**: 6 files across routing/config/provider/index/ui layers

- `types.ts` — Added `ClassifierConfig.fallbacks`, `ClassifierResult`, `ClassifierFailureReason`, `ConfidenceLevel`, provenance fields
- `routing.ts` — `parseClassifierOutput`, `runClassifier` refs-array loop, veto gate + phase decoupling
- `provider.ts` — Build classifier refs from model + fallbacks

**Follow-up fixes**:

- `c028bcb9` — "fix: use structured flags and remove off short-circuit" (2026-07-05) — Replaced fragile `reasoning.includes('Pinned to')` string sniff with structured `isPinned`/`isFallback` flags
- `fb79faf7` — "fix: routing persistence, image gates, Google continuation, in-tier fallback mutation" (2026-07-19) — Narrowed `ClassifierFailureReason` to `success|unparseable`, added word-boundary keyword matching

**Takeaway**: Every structural change to the classifier pipeline produces 2–3 follow-up bugs in edge-case ordering. Plan for a follow-up fix commit.

### Precedent: Six Routing Defects Fix

**Commit(s)**: `14466e2f` — "fix: resolve six routing defects — classifier order, budget downgrade, cross-tier fallback, debug notify, isClassifier flag, README docs" (2026-06-28)
**Blast radius**: 7 files, real code in `provider.ts` (345 lines), `routing.ts` (126 lines)

- Fixed classifier order: pre-decision gate now checks `!pinnedTier && !ruleHit` before calling classifier
- Moved classifier invocation BEFORE `decideRouting`, passing result + ruleHit into it

**Takeaway**: The classifier was being invoked in the wrong order relative to rules and pins — fixing the order alone wasn't enough; it required a complete structural rethink 6 days later.

### Precedent: Classifier + Advanced Routing Controls (Initial Implementation)

**Commit(s)**: `4abdfb77`, `fafbc9fa`, `9d32fe1b` (2026-03-19)
**Blast radius**: Initially monolithic in `extensions/index.ts` (+427 lines)

**Follow-up fixes** (within weeks):

- `8202f2df` — Tier switching broke replay for Gemini
- `2ee4021c` — Status reporting wrong after classifier changes
- `91b80d00` — Race condition in state restoration
- `5ff2e8f9` — Classifier didn't account for image support
- `2d00526e` — Status line showed wrong model

**Takeaway**: The initial classifier implementation spawned a long tail of 5+ fixes over weeks — capacity reporting, image support, status races, and replay were all broken by tier-switching decisions.

### Precedent: "Evaluate All Rules" Rule-Matching Fix

**Commit(s)**: `a860f4e4` — "feat(routing): evaluate all rules and route to the highest matched tier" (2026-06-17)
**Blast radius**: 2 files (`routing.ts` +31/-7, `routing.test.ts` +29)

**Follow-up fixes**:

- `14466e2f` (2026-06-28) — Fixed rule vs. classifier ordering as a direct consequence of changed rule evaluation semantics

**Takeaway**: Changing how rules are evaluated (first-match → highest-match) silently changed classifier interaction — the classifier gate condition had to be rewritten because rule semantics changed.

### Precedent: Context Window Assumption Fix

**Commit(s)**: `0a9fcd5b` — "fix: resolve context window per-model instead of assuming high >= medium >= low" (2026-06-07)
**Blast radius**: Config + provider layers; removed `largeContextThreshold` entirely

**Takeaway**: Hardcoded assumptions about tier ordering (context window, capabilities) silently corrupt routing decisions — always resolve per-model.

### Composite Lessons

1. **Classifier ordering is the #1 source of bugs** — Every major change to the gate order (pin → rules → classifier → heuristics → phaseBias) produced immediate defects. Write exhaustive order-dependent tests (`14466e2f`, `f873288a`, `a860f4e4`).
2. **Every classifier change triggers 2–3 follow-up fixes within 1–2 weeks** — Budget downgrade bugs, `isClassifier` flag issues, pin/fallback detection regressions, and status line desync all recurred. Budget time for a follow-up.
3. **String sniffing is fragile; use structured flags** — The `reasoning.includes('Pinned to')` pattern broke immediately (`c028bcb9`). Any new routing accuracy feature should add structured fields to `RoutingDecision` rather than parsing reasoning text.
4. **Classifier output parsing needs extreme robustness** — `parseClassifierOutput` had to handle markdown fences, punctuation, case variations. If improving classifier accuracy involves changing the output format, expect parsing edge cases (`f873288a` added an 11-test suite just for parsing).
5. **Don't assume tier capabilities are ordered** — Context window, image support, and reasoning support are NOT guaranteed `high >= medium >= low`. Always resolve per-model (`0a9fcd5b`, `5ff2e8f9`).
6. **Provider-specific continuation guards break on tier switches** — Gemini's thought-signature continuation, Google continuation, and in-tier fallback mutation all required special-casing after classifier-driven tier changes (`fb79faf7`, `8202f2df`).

## Historical Context (from `.rpiv/artifacts/`)

- `docs/ARCHITECTURE.md` — Decision flow documents the gate order: Budget → Pin → Rules → Classifier → Heuristics → phaseBias. This order is a critical invariant.

## Developer Context

**Q (`extensions/routing.ts:572`): Found 2 competing approaches for improving classifier accuracy — prompt builder refactor vs confidence-aware decision logic vs structured output parser vs calibration feedback loop. Which is the priority?**
A: Prompt builder refactor (Recommended) — extract `buildClassifierPrompt()` to inject signals heuristics already use. Linchpin for all other improvements.

**Q (`extensions/routing.ts:571`): The classifier prompt uses a hard-coded 4-message history window. Heuristics use default 6. Should we increase it?**
A: Increase to 6 (Recommended) — match heuristic default. Low risk, small token cost increase.

**Q (`extensions/routing.ts:477`): The classifier's `confidence` field is parsed and persisted but never consumed for routing decisions. Should it be wired into decision logic?**
A: Yes, degrade to heuristics on low confidence (Recommended) — when classifier returns `confidence: 'low'`, fall through to heuristic branch. Preserve classifier provenance via `classifierAttempted` flag.

## Related Research

- (None yet — this is the first research artifact for this project)

## Open Questions

- How should the `buildClassifierPrompt()` function handle the `phaseBias` numeric value? Should it be rendered as prose ("bias toward planning phase") or as a numeric hint ("phaseBias=0.5")?
- Should the classifier-result cache (Q10) be persisted across sessions or only in-memory? In-memory is simpler but loses cache on agent relaunch.
- What is the optimal size for the calibration exemplar pool? Too few = no signal; too many = prompt bloat. Start with 3 most recent misclassifications.
