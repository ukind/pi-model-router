---
template_version: 2
date: 2026-07-18T19:08:10+0700
author: Yogiswara Utama
repository: pi-model-router
branch: main
commit: c028bcb9d95d43dc9219fe3b1530c1b5bf4f5c13
review_type: commit
scope: 'fix: use structured flags and remove off short-circuit'
scope_strategy: working-tree
in_scope_files_count: 9
status: ready
severity: { critical: 3, important: 3, suggestion: 6 }
verification: { verified: 12, weakened: 0, falsified: 0 }
blockers_count: 6
tags:
  [code-review, routing, provider, state-persistence, classifier, pin-fallback]
---

# Code Review — c028bcb9 "fix: use structured flags and remove off short-circuit"

**Commit:** `c028bcb9` · **Status:** `ready` · **Findings:** 3🔴 · 3🟡 · 6🔵 · **Verification:** 12✓ / 0− / 0✗

## Top Blockers

1. **I1** — Budget downgrade (`routing.ts:432-445`) silently undefeated by image-promotion (`provider.ts:386-405`); `isBudgetForced` carried onto a decision whose tier has been escalated past the cap.
2. **I2** — Google thought-signature guard's `!pinnedTier` skip (`provider.ts:344`) assumes pinned tier pins the model; image-promotion walks `tiersToTry` without consulting `pinnedTier`; `isPinned` is carried onto a decision whose tier was promoted.
3. **I3** — `getUnsupportedTiers` (`config.ts:687-705`) accepts `level: ThinkingLevel` but its body never reads `level`; both production callers (`index.ts:518`, `commands.ts:370`) pre-filter `'off'`, so the removed `level === 'off'` short-circuit is unreachable outside `config.test.ts:559`.

---

## Legend

```text
Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss
ID prefix   I interaction   Q quality   S security   G gap
Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)
Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]
```

---

## 🔴 Critical

### I1 🔴 Budget downgrade silently undefeated by image-promotion `[cascade: silent-stranded-state for isBudgetForced]`

**Where**

- `extensions/routing.ts:432-445` — budget downgrade (`high→medium`, `medium→low`) sets `isBudgetForced = true`
- `extensions/provider.ts:386-405` — image-promotion builds `tiersToTry` from `decision.tier` without consulting `isBudgetExceeded`
- `extensions/provider.ts:417` — `promotedDecision.isBudgetForced = decision.isBudgetForced;`
- `extensions/provider.ts:449` — `const tierChain = buildDelegationTierChain(decision.tier, isBudgetExceeded);`

**Code**

```ts
// routing.ts:432-445
if (isBudgetExceeded && tier === 'high') {
  tier = 'medium';
  phase = 'implementation';
  reasoning = `Budget exceeded. Downgraded from high to medium tier. (Original: ${reasoning})`;
  isBudgetForced = true;
} else if (isBudgetExceeded && tier === 'medium') {
  tier = 'low';
  // ...
  isBudgetForced = true;
}

// provider.ts:386-405
const tiersToTry: RouterTier[] =
  decision.tier === 'low'
    ? ['medium', 'high']
    : decision.tier === 'medium'
      ? ['high']
      : [];

// provider.ts:417
promotedDecision.isBudgetForced = decision.isBudgetForced;
```

**Why**
`routing.ts` enforces a budget by demoting the tier and flagging the decision; `provider.ts` then promotes the tier back up if the downgraded tier's models don't support images, but never re-checks `isBudgetExceeded`. The `isBudgetForced` flag is carried onto the promoted decision, so the UI/notify still says "budget" while the actual cost incurred is the high tier the budget was meant to block. The two layers' assumptions about the executing tier contradict.

**Fix**
In `provider.ts:386-405`, consult `isBudgetExceeded` (or the captured `isBudgetExceeded` snapshot at line 300) before building `tiersToTry`; if budget is forced, restrict promotion to the same tier or below.

**Alt**
Skip image-promotion when `isBudgetForced` is true and surface a notification that image support is dropped to honor the cap.

---

### I2 🔴 Google thought-signature guard bypassed via pin + image-promotion

**Where**

- `extensions/routing.ts:325` — `isPinned = true;`
- `extensions/provider.ts:344` — `!pinnedTier && // skip guard when user pinned a tier`
- `extensions/provider.ts:386-405` — image-promotion `tiersToTry` does not consult `pinnedTier`
- `extensions/provider.ts:417-425` — `promotedDecision.isPinned = decision.isPinned;`

**Code**

```ts
// provider.ts:344
const isGoogleThinkingToolContinuation =
    !pinnedTier && // skip guard when user pinned a tier
    lastMessage?.role === 'toolResult' &&
    previousDecision?.profile === model.id &&
    previousDecision.targetProvider === 'google' &&

// provider.ts:417
// Carry forward provenance (modeled after routing.ts).
promotedDecision.isPinned = decision.isPinned;
```

**Why**
The guard's purpose is to prevent `previousDecision.targetLabel !== decision.targetLabel` from causing a thought-signature replay error. The skip-condition `!pinnedTier` assumes pinning a tier pins the model. Image-promotion at `provider.ts:386-405` walks `tiersToTry` without consulting `pinnedTier`; if the pinned-low tier's models don't support images, the decision lands on a different tier. The new `isPinned` flag is carried onto the promoted decision at line 417, so the consumer in `index.ts:103` will still label the source as `'pin'`, masking the fact that the pinned model was not the one that actually executed.

**Fix**
In `provider.ts:386-405`, consult `pinnedTier` (already read at `provider.ts:298`) before building `tiersToTry`; if pinned, restrict promotion to the pinned tier. OR remove the `!pinnedTier` skip from the Google guard and instead check `previousDecision.targetLabel === decision.targetLabel` regardless of pin state.

**Alt**
Document explicitly that pin only pins the _decision's tier_; if image-promotion overrides, the new flag should be `isPinned = false` to surface the substitution.

---

### I3 🔴 `getUnsupportedTiers` accepts `level` that no caller can rely on `[cascade: silent-stranded-state for getUnsupportedTiers('off')]`

**Where**

- `extensions/config.ts:687` — `level: ThinkingLevel,` parameter
- `extensions/config.ts:692` — `if (!modelRegistry) return [];` (removed `level === 'off'` short-circuit)
- `extensions/config.ts:693-704` — function body never references `level`
- `extensions/index.ts:518` — `if (event.level !== 'off') { ... getUnsupportedTiers(...) ... }`
- `extensions/commands.ts:370` — `if (nextLevel && nextLevel !== 'off') { ... getUnsupportedTiers(...) ... }`
- `extensions/config.test.ts:559` — only path that exercises `'off'` after the change

**Code**

```ts
// config.ts:687
export const getUnsupportedTiers = (
  profile: RouterProfile,
  level: ThinkingLevel,
  modelRegistry?: ExtensionContext['modelRegistry'],
): string[] => {

// config.ts:692
if (!modelRegistry) return [];

// index.ts:518
if (event.level !== 'off') {
  const unsupported = getUnsupportedTiers(
    currentConfig.profiles[selectedProfile],
    event.level,
    ctx.modelRegistry,
  );
```

**Why**
The removed `level === 'off'` short-circuit (Decision 9) is documented as "callers warn even for 'off' when tiers lack reasoning." Both production callers pre-filter `'off'` before calling, so the new behavior is unreachable in production. The function body at `config.ts:693-704` does not read `level` at all — the parameter is dead in the implementation. The only path that exercises the new behavior is `config.test.ts:559`, which asserts behavior production cannot reach. This is a stranded-state cascade: the predicate admits `'off'`, no event fires for `'off'`, and every consumer filter excludes `'off'`.

**Fix**
Either (a) restore the `level === 'off'` short-circuit at `config.ts:692` to match the caller contracts, OR (b) remove the `'off'` filter from both production callers (`index.ts:518`, `commands.ts:370`) so the new behavior actually fires — and update `commands.ts:369` to drop the "skip for 'off' and 'auto'" comment. Pick one. Don't leave both.

**Alt**
Drop the `level` parameter from `getUnsupportedTiers` if it has no semantic effect, and have callers compose the level check themselves.

---

## 🟡 Important

### Q1 🟡 Pin/notification chain ordering contradicts `getDecisionFlags` `[precedent-weighted]`

**Where**

- `extensions/index.ts:99-107` — single-winner source chain
- `extensions/ui.ts:19-26` — `getDecisionFlags` multi-flag accumulator

**Code**

```ts
// index.ts:99-107
if (decision.isBudgetForced) source = 'budget';
else if (decision.isClassifier) source = 'classifier';
else if (decision.isRuleMatched) source = 'rule';
else if (decision.isFallback) source = 'fallback';
else if (decision.isPinned) source = 'pin';
else source = 'heuristic';

// ui.ts:19-26
export const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isRuleMatched) flags.push('rule');
  if (decision.isClassifier) flags.push('classifier');
  if (decision.isVetoed) flags.push('vetoed');
  if (decision.isPinned) flags.push('pin');
  return flags;
};
```

**Why**
Two consumers of the same `lastDecision` produce inconsistent output. The chain orders `isBudgetForced → isClassifier → isRuleMatched → isFallback → isPinned` and silently drops `isVetoed`; the flag list orders `isFallback → isBudgetForced → isRuleMatched → isClassifier → isVetoed → isPinned` and surfaces all flags. A vetoed classifier decision shows `'classifier'` in the notification but `[fallback?, budget-limit?, rule?, classifier, vetoed, pin?]` in the widget. The comment at `index.ts:96-97` claims `getDecisionFlags` "is not a priority selector" but the chain below it is exactly that.

**Fix**
Either unify the two consumers (use `getDecisionFlags` and join the array for the notification, or accept the inconsistency and document it), and add `isVetoed` to the chain at `index.ts:103-107`.

---

### Q2 🟡 `isValidRoutingDecision` validator too narrow; all-or-nothing rejection discards `enabled`/`selectedProfile`/`accumulatedCost` `[precedent-weighted]`

**Where**

- `extensions/state.ts:29-36` — validator narrows to `profile`/`tier`/`timestamp` only
- `extensions/state.ts:66` — all-or-nothing rejection
- `extensions/types.ts:84` — `isPinned?: boolean;` (not enumerated)
- `extensions/types.ts:73-74` — `phase` and `targetProvider` (not enumerated)

**Code**

```ts
// state.ts:29-36
const isValidRoutingDecision = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.profile === 'string' &&
    typeof value.tier === 'string' &&
    isRouterTier(value.tier) &&
    typeof value.timestamp === 'number'
  );
};

// state.ts:66
if (v.lastDecision !== undefined && !isValidRoutingDecision(v.lastDecision))
```

**Why**
The validator doesn't check `isPinned`/`phase`/`targetProvider`, so a corrupted restored `lastDecision` flows unvalidated into `provider.ts:323` (`previousDecision` for `decideRouting`) and `provider.ts:341-343` (Google guard's `previousDecision.targetProvider`/`targetLabel` checks). A restored `isPinned: "yes"` (non-boolean) passes the validator and is treated as truthy at `index.ts:103` and `ui.ts:24`. The all-or-nothing rejection at line 66 discards the entire persisted state (including `enabled`, `selectedProfile`, `accumulatedCost`) if any of `profile`/`tier`/`timestamp` is invalid.

**Fix**
Add per-field validation in `isValidRoutingDecision` for `isPinned`/`phase`/`targetProvider` (and ideally the rest of the optional `RoutingDecision` fields). Replace the all-or-nothing reject with per-field drop: reject only the `lastDecision`, keep `enabled`/`selectedProfile`/`accumulatedCost` from the persisted state.

---

### Q3 🟡 Budget downgrade else-if chain caps at one step `[precedent-weighted]`

**Where**

- `extensions/routing.ts:435` — `if (isBudgetExceeded && tier === 'high')` (high → medium)
- `extensions/routing.ts:440` — `} else if (isBudgetExceeded && tier === 'medium') {` (medium → low)
- `extensions/routing.ts` (no branch for `'low'`) — no further downgrade step

**Code**

```ts
// routing.ts:435
if (isBudgetExceeded && tier === 'high') {
  tier = 'medium';
  // ...
} else if (isBudgetExceeded && tier === 'medium') {
  tier = 'low';
  // ...
}
```

**Why**
If the original decision was `tier = 'low'`, the chain does nothing — `isBudgetForced` is never set, and execution proceeds at the requested tier regardless of budget. This is correct for `low` (nothing below), but the code path is silent: a user with exceeded budget who requests a `'low'` decision never sees a budget-forced notification.

**Fix**
Either explicitly handle `tier === 'low' && isBudgetExceeded` (e.g. surface a "budget exceeded; cannot downgrade further" warning and refuse), or document that `'low'` is the floor and no warning is needed.

---

## 🔵 Suggestions

### Q4 🔵 `wordBoundaryRegexCache` module-level Map grows unboundedly

**Where**

- `extensions/routing.ts:76` — `const wordBoundaryRegexCache = new Map<string, RegExp>();`
- `extensions/routing.ts:86` — `wordBoundaryRegexCache.set(keyword, r);` (no eviction)

**Fix**
Use an LRU bound (e.g. `@sindresorhus/lru-cache` or a simple size cap), or compute the regex on demand without caching if config reload is rare.

---

### Q5 🔵 `containsAnyWord` `\b` boundary fails for non-word edge characters

**Where**

- `extensions/routing.ts:84` — `r = new RegExp(\`\\b${escaped}\\b\`, 'i');`
- `extensions/routing.ts:88` — `export const containsAnyWord = ...`

**Fix**
Validate rule keywords at config load time (reject those ending in non-word chars) or strip the `\b` anchors and use a custom token boundary check.

---

### Q6 🔵 `buildDelegationTierChain` non-budget order is down-then-up, opposite of peer `resolveAvailableTier`

**Where**

- `extensions/routing.ts:110-122` — `buildDelegationTierChain` (down-then-up: `downOrder.slice(idx + 1).concat(downOrder.slice(0, idx).reverse())`)
- `extensions/routing.ts:122-155` — `resolveAvailableTier` (up-then-down: iterates `i++` then `i--`)

**Fix**
Align the two helpers to the same tier-preference order; document the rationale if they must differ.

---

### Q7 🔵 `extractToolCallIds` only scans `messages`, not `latestMessage`

**Where**

- `extensions/provider.ts:95` — `latestMessage` popped
- `extensions/provider.ts:120` — `const toolCallIds = new Set(extractToolCallIds(evicted));`
- `extensions/provider.ts:138` — `const finalMessages: Message[] = [...messages, latestMessage];`

**Fix**
Scan `latestMessage` for tool calls before re-appending, or skip the eviction for the last message and let the next turn's natural pruning handle it.

---

### Q8 🔵 `profileSupportsImages` no-registry fallback silently advertises `image` input

**Where**

- `extensions/provider.ts:230` — `if (!registry) return true;`

**Fix**
Default to `false` when registry is missing (opt-in requires registry presence), or return `undefined` and have the model-registration surface handle absence explicitly.

---

### Q9 🔵 Partial-stream cost recording silently drops cost when `usage.cost.total` is falsy

**Where**

- `extensions/provider.ts:609-611` — `if (partialUsage?.cost?.total) { ... }`

**Fix**
Always log the missing-cost event (even as `0`) so the cost trace is complete; treat missing as a separate signal from `0`.

---

## 💭 Discussion

### A1 💭 `getDecisionFlags` vs. single-winner chain: architectural question

**Where**

- `extensions/index.ts:96-97` — comment claiming `getDecisionFlags` "is not a priority selector"
- `extensions/index.ts:99-107` — priority chain immediately below

**Why**
The codebase has two consumers for the same `lastDecision` and they don't agree on presentation. Is the goal "one canonical source label per decision" (then unify on the chain) or "all applicable flags per decision" (then unify on the flag list)? The commit doesn't resolve this. Worth a design conversation before adding more flags.

---

## Impact

| Consumer                                              | Change                                                                                    | Findings   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `extensions/index.ts:99-107` (notify)                 | New `isPinned`/`isFallback` branches added; chain order contradicts `getDecisionFlags`    | Q1         |
| `extensions/ui.ts:19-26` (`getDecisionFlags`)         | Multi-flag accumulator; ordering and completeness now diverges from notify chain          | Q1         |
| `extensions/index.ts:103-104` (debug source)          | Source label cascades from `isFallback`/`isPinned` carry-forward from `provider.ts:417`   | I1, I2, Q1 |
| `extensions/index.ts:245-246` (provider registration) | `registerRouterProvider` now consumes `promotedDecision.isPinned`/`isBudgetForced`        | I1, I2     |
| `extensions/index.ts:282` (state restore)             | Restored `lastDecision` rehydrates with unvalidated `isPinned`/`phase`/`targetProvider`   | Q2         |
| `extensions/index.ts:518` (thinking warning)          | Pre-filters `'off'`, making `getUnsupportedTiers` `'off'` path unreachable                | I3         |
| `extensions/commands.ts:370` (command warning)        | Pre-filters `'off'` and `undefined`, same unreachable path                                | I3         |
| `extensions/provider.ts:298` (pinnedTier read)        | `pinnedTier` consulted only by Google guard (line 344), not by image-promotion (line 386) | I2         |
| `extensions/provider.ts:417` (carry-forward)          | Three new provenance flags carried onto promoted decision                                 | I1, I2     |
| `extensions/provider.ts:449` (delegation chain)       | `buildDelegationTierChain` consumes pre-await `isBudgetExceeded` snapshot                 | I1         |

---

## Precedents

| Commit                               | Subject                                                                                                                                  | Follow-ups                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f873288a`                           | feat: overhaul classifier decision-making with veto gate, structured result, and provenance                                              | `c028bcb9` (this commit, **next day**) — replaced fragile string sniff with structured flags; 2026-07-13 audit (`research/2026-07-13_19-15-32_ai-slop-codebase-audit.md`) flagged the bolt-on `isPinned`/`isRuleMatched`/`isBudgetForced` pattern and the image-promotion sync site as defects |
| `14466e2f`                           | fix: resolve six routing defects — classifier order, budget downgrade, cross-tier fallback, debug notify, isClassifier flag, README docs | `6cd0516a` (2026-06-30, **2 days**) — warnings computed from static config disagreed with the live model registry; 9 files touched                                                                                                                                                             |
| `06e376fb` / `66a35192` / `0e72c05a` | thinking-level capability reporting (three strikes: hardcoded false → missing xhigh → stale-config warnings)                             | `6cd0516a` (2026-06-30) — thinking warning still wrong vs. live registry                                                                                                                                                                                                                       |
| `97a51fd1` / `150af71c` / `7addc29f` | router-'off' state semantics (statusline needed 3 attempts)                                                                              | n/a — pattern warning: 'off' semantics never survive first contact                                                                                                                                                                                                                             |
| `d3756ce7`                           | fix: resolve reference breaking of pin state                                                                                             | n/a — pattern warning: mutating shared decision/pin state objects by reference broke pin state before                                                                                                                                                                                          |

**Recurring lessons (most → least frequent)**

1. **Feature-then-fix cadence is ~1–2 days on routing/provider code** — every significant change to `routing.ts`/`provider.ts` (`f873288a`, `14466e2f`, `66a35192`, `2c478988`) produced a follow-up fix within 48 hours. The 2026-07-13 audit confirms c028bcb9 has latent defects (optional-but-always-set flags, 3-site sync burden). Reviewer should assume latent defects in this commit too.
2. **Warning/capability logic must consult the live registry, not static config** — broken 3× (`06e376fb`, `0e72c05a`, `6cd0516a`); `getUnsupportedTiers` (changed by this commit) sits exactly on that fault line.
3. **'off' semantics never survive first contact** — router-off statusline needed 3 attempts; removing the `'off'` short-circuit in warnings deserves explicit test coverage for the "user deliberately set off" case (which is exactly what I3 reports as unreachable).
4. **Prefer new-object construction (spread) over bolt-on field mutation for `RoutingDecision`** — the reference-mutation style caused the pin-state bug (`d3756ce7`); c028bcb9's image-promotion field-copying at `provider.ts:417-425` repeats the risky mutation style.
5. **Strip process breadcrumbs** — "Decision 9/10" references in commit message and code point to a decision log that doesn't exist in the repo (the audit counted 11 such orphaned artifacts across 4 files).

---

## Recommendation

| #   | ID  | Action                                                                                                                         | Alt / Note                                                                                                                |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | I1  | In `provider.ts:386-405`, consult `isBudgetExceeded` before building `tiersToTry`; restrict promotion when budget-forced.      | Drop image-promotion when `isBudgetForced` is true and notify the user.                                                   |
| 2   | I2  | In `provider.ts:386-405`, consult `pinnedTier` before promotion; OR remove `!pinnedTier` skip from the Google guard.           | If pin only pins the _tier_, document that image-promotion overrides and set `isPinned = false` on the promoted decision. |
| 3   | I3  | Pick one: restore the `level === 'off'` short-circuit, OR remove the `'off'` filter from `index.ts:518` and `commands.ts:370`. | Drop the `level` parameter entirely if it has no semantic effect.                                                         |
| 4   | Q1  | Unify the notify chain (`index.ts:99-107`) and `getDecisionFlags` (`ui.ts:19-26`) — same source list, same ordering.           | At minimum, add `isVetoed` to the chain.                                                                                  |
| 5   | Q2  | Add per-field validation in `isValidRoutingDecision`; replace the all-or-nothing reject at `state.ts:66` with per-field drop.  | Reject only the corrupted `lastDecision`, preserve `enabled`/`selectedProfile`/`accumulatedCost`.                         |
| 6   | Q3  | Handle `tier === 'low' && isBudgetExceeded` explicitly — refuse + warn, or document that `'low'` is the floor.                 | —                                                                                                                         |
| 7   | Q4  | Bound `wordBoundaryRegexCache` (LRU or size cap), or compute on demand.                                                        | —                                                                                                                         |
| 8   | Q5  | Validate rule keywords at config load; or use a custom token boundary check without `\b` anchors.                              | —                                                                                                                         |
| 9   | Q6  | Align `buildDelegationTierChain` order with `resolveAvailableTier`.                                                            | Document the divergence if they must differ.                                                                              |
| 10  | Q7  | Scan `latestMessage` for tool calls before re-appending at `provider.ts:138`.                                                  | Skip eviction for the last message.                                                                                       |
| 11  | Q8  | Default `profileSupportsImages` to `false` when registry is missing.                                                           | —                                                                                                                         |
| 12  | Q9  | Always log missing cost as `0` (or a separate "missing" signal) so the cost trace is complete.                                 | —                                                                                                                         |
