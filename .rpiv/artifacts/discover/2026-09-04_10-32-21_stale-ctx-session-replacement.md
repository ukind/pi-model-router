---
date: 2026-09-04T10:32:21+0700
author: Yogiswara Utama
commit: cdcfe2eb
branch: main
repository: pi-model-router
topic: "Fix stale extension ctx after session replacement in router provider"
tags: [intent, frd, provider, index, ui, session-lifecycle]
status: ready
last_updated: 2026-09-04T10:32:21+0700
last_updated_by: Yogiswara Utama
---

# FRD: Fix stale extension ctx after session replacement in router provider

## Summary

When model `router/auto` is active and the session is replaced mid-turn (`newSession` / `fork` / `switchSession` / `reload`), the old extension instance's in-flight provider stream dereferences captured ctx handles (modelRegistry, ui) and surfaces pi's "This extension ctx is stale after session replacement or reload" error to the user. The fix extends the existing event-driven `captureCtx` design with a `session_shutdown` invalidation flag: the old instance's delegated stream and UI paths check liveness around awaits and terminate silently instead of throwing.

## Problem & Intent

Developer's report (verbatim): "when using model auto, from current project, it shows error: Error: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload(). need find the solution"

Intent (developer's framing): Maintainer of this repo — success means the extension never touches a stale ctx across every pi session API.

## Goals

- No code path in the extension dereferences a stale ctx/registry after any session replacement (newSession, fork, switchSession, reload)
- No user-visible "stale extension ctx" error while using `router/auto`
- A regression test that simulates session replacement mid-turn and proves the invariant
- Zero behavior change on the normal (non-replacement) routing path

## Non-Goals

- No pi core changes (extension-first mandate)
- No `withSession` restructure — the router never initiates a replacement, so there is no call site for it
- No rewrite of the provider delegation architecture — guard additions only
- No persistence queue or re-persist mechanism for dead sessions (silent no-op stays)

## Functional Requirements

1. The extension SHALL register a `session_shutdown` handler that marks the old session's runtime captures (`lastExtensionContext`, `currentModelRegistry`, `currentCwd` — `extensions/index.ts:40,54-55`) invalid.
2. The delegated provider stream (IIFE at `extensions/provider.ts:303`) SHALL check session liveness before/after awaits at `extensions/provider.ts:308, 466, 536, 548, 587-594, 704` and terminate silently when the session is dead.
3. Stale-ctx throws caught at `extensions/provider.ts:733` SHALL be classified as benign termination, not emitted as `type:'error'` assistant events.
4. The `recordDebugDecision` notify path (`extensions/index.ts:138`, called from `extensions/provider.ts:727`) SHALL NOT dereference a dead ctx.
5. `pi.appendEntry` stale-throw SHALL remain a silent no-op (`extensions/index.ts:187-191`).
6. A regression test SHALL simulate session replacement mid-turn and assert that no error event surfaces and no stale handle is dereferenced.

## Non-Functional Requirements

- **Performance**: flag checks only on the routing hot path — no added latency, no extra event work per turn
- **Reliability**: graceful degradation on every replacement path; no unhandled promise rejections from the old instance
- **UX / Accessibility**: silent end of replacement-killed turns; session-replacement feedback is pi's own UI surface, not the router's
- **Security**: no new data flows or inputs (n/a)

## Constraints & Assumptions

- Extension-first: all changes inside `extensions/*.ts`, no pi core modifications (repo AGENTS.md)
- TypeScript strict; never `any`; arrow functions; static top-level imports (repo AGENTS.md)
- State persistence stays on the `pi.appendEntry('router-state', …)` pattern (repo AGENTS.md)
- **Assumption (research to verify):** `session_shutdown` fires before the old runtime teardown on every replacement path (`docs/extensions.md:516-521, 1247` of the local pi install) — i.e., the dead-flag is set before the in-flight stream's next stale deref in practice
- **Assumption (research to verify):** pi does not abort in-flight provider streams on replacement (observed: the stream kept running and hit the stale registry). If pi does pass an abort signal, the guards must compose with it
- pi API reference: `@earendil-works/pi-coding-agent` local docs (`extensions.md` — session replacement lifecycle, `withSession`, `session_shutdown`)

## Acceptance Criteria

- [ ] Repo test run (e.g. `npm test`) exits 0 including the new mid-turn replacement regression test
- [ ] New test asserts: a stale registry read during the delegated stream emits no `type:'error'` event and the stream ends cleanly
- [ ] Manual, `router/auto` active, fork mid-turn (`/fork`) → no "stale extension ctx" error; routing works in the forked session
- [ ] Manual, `router/auto` active, switch session mid-turn → same
- [ ] Manual, `router/auto` active, `/reload` mid-turn → same
- [ ] `git diff --name-only` for the fix touches only files under `extensions/`

## Recommended Approach

Extend the existing `captureCtx` event-driven design (`extensions/index.ts:70-77`) with a `session_shutdown` dead-flag; guard the delegated stream's ctx-derived reads (`extensions/provider.ts:308,466,536,548,587,704`) and reclassify stale throws at `extensions/provider.ts:733` as benign silent termination; keep the `appendEntry` swallow (`extensions/index.ts:187-191`); add a mid-turn replacement regression test in `extensions/`.

## Decisions

### Fix scope — all stale seams, not just the reported path
**Question**: Pre-resolved from codebase evidence — confirmed in Step 4: "the visible error comes from the delegated stream's registry snapshot (provider.ts:308), but 4 more stale-read sites exist. Keep full-seam scope, or narrow?"
**Recommended**: Keep: fix all seams
**Chosen**: Keep: fix all seams
**Rationale**: matches the stated intent "never touches a stale ctx across every pi session API"; evidence: `extensions/provider.ts:308,536,548` (primary registry snapshot), `extensions/provider.ts:466,587-594,704` and `extensions/index.ts:138` (secondary stale reads) + confirmed

### Architecture — session_shutdown invalidation
**Question**: Grounded shape: how should the extension stop touching stale ctx after session replacement? (withSession is only for code that initiates the replacement — this extension never does.)
**Recommended**: Shutdown invalidation — keep `captureCtx`, add `session_shutdown` dead-flag, stream checks around awaits, benign classification of stale throws
**Chosen**: Shutdown invalidation
**Rationale**: `withSession` exists only as an option on `ctx.newSession`/`fork`/`switchSession` (pi `docs/extensions.md:1136-1215`), which this extension never calls; `session_shutdown` is the old-instance lifecycle hook (`docs/extensions.md:516-521,1247`) — smallest correct fix at the mechanism level. Initially answered "find out what is the best"; resolved via pi docs evidence and re-ask.

### Persistence — keep silent no-op swallow
**Question**: How should router-state persistence behave when the session dies mid-turn — keep the silent no-op swallow, or add a best-effort flush in session_shutdown?
**Recommended**: Keep silent no-op
**Chosen**: Keep silent no-op
**Rationale**: loss is bounded to the final turn's snapshot delta; the rebound extension instance restores state from the session file (`extensions/index.ts:531-541`); zero new mechanism. Initially answered "find out what is the best"; resolved via grounded re-ask.

### Regression test — add mid-turn replacement test
**Question**: Pre-resolved from codebase evidence — confirmed in Step 4: "extensions/ has 6 co-located *.test.ts suites, but none simulate session replacement mid-turn. Add one as the acceptance bar?"
**Recommended**: Add: mid-turn replacement test
**Chosen**: Add: mid-turn replacement test
**Rationale**: no existing suite covers the lifecycle race; gives the acceptance criteria an observable, re-runnable bar + confirmed

### Killed-turn UX — silent termination, no router notice
**Question**: Pre-resolved from codebase evidence — inherited via the architecture option text the developer selected ("provider stream … ends silently; stale-classified throws become benign termination, not type:'error'")
**Recommended**: n/a — folded into architecture choice
**Chosen**: Silent end of replacement-killed turns
**Rationale**: mechanically forced as well — the old instance has no safe channel to notify through (any ui emit goes via the dead ctx or lands in the dead session); replacement feedback is pi's own UI surface

## Open Questions

- None — all interview branches were resolved. Research should verify the two assumptions listed under Constraints & Assumptions (shutdown-event ordering vs. in-flight deref; pi abort behavior on replacement).

## Suggested Follow-ups

- `captureCtx`'s inner try/catch keeps the last captured values when ctx getters throw (`extensions/index.ts:75-77`) — belt-and-suspenders that the dead-flag should make unreachable; a cleanup pass could replace it with an explicit invalidation, but it is not required for this fix

## References

- Input: free-text error report (quoted verbatim in Problem & Intent)
- pi extension API docs (local install): `C:\Users\utama\AppData\Local\nvm\v24.14.0\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md` — Session replacement lifecycle and footguns; `ctx.newSession`/`fork`/`switchSession` options; `session_shutdown`
- Repo: `docs/ARCHITECTURE.md`, `extensions/index.ts`, `extensions/provider.ts`, `extensions/ui.ts`, `extensions/state.ts`
