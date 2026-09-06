---
date: 2026-09-06T04:51:15+0700
author: Yogiswara Utama
commit: 01d84ba7
branch: main
repository: pi-model-router
topic: "ESC abort poisons subsequent router turns until /reload"
tags: [intent, frd, provider, abort-signal, terminal-events]
status: ready
last_updated: 2026-09-06T04:51:15+0700
last_updated_by: Yogiswara Utama
---

# FRD: ESC abort poisons subsequent router turns until /reload

## Summary

One ESC abort during a router-routed turn leaves the router provider dead. Every later turn fails with "Operation aborted" and zero content. Only `/reload` recovers. The work: instrument the abort gates, reproduce against real pi 0.84.3, pin the poisoned-state mechanism, and add a two-turn regression guard in `extensions/provider.test.ts`.

## Problem & Intent

User's words: "after latest commit or changes, there is this bug 'Operation aborted' after i accendatly pres esc … i can not resume, need call /reload from pi then it can again."

Intent pick: **Maintainer confidence**. Success means the maintainer understands why abort poisons the router, and a regression test stops terminal-event handling from breaking silently again.

Session evidence (JSONL, `--H--fork-openshorts--`, 2026-09-05): ESC at 21:47:47 aborts turn 2. Two later "resume" turns (21:47:56, 21:48:18) each run ~7.5 s, then return `stopReason: "aborted"`, `errorMessage: "Operation aborted"`, provider `router/auto`, empty content, zero usage. `/reload` at 21:49:46 fixes it. The ~7.5 s equals classifier latency (`ollama-cloud/nemotron-3-nano:30b`, thinking high).

## Goals

- Pin why turns 3 and 4 aborted mid-run after one ESC: which gate fired and which operand tripped it.
- Make every abort gate observable: gate id, operand, entry-time vs mid-run abort.
- Add a permanent two-turn regression guard at the `streamSimple` seam.
- If the mechanism lands pi-side, document it and file an upstream pi issue.

## Non-Goals

- Full audit of every abort/terminal-event path across the extension (declined in the intent answer).
- Further spinner-hang work. Commit 01d84ba7 fixed it.
- Landing pi-core code changes from this repo. Upstream filing only.

## Functional Requirements

1. The system SHALL emit, when debug is on, one debug line per abort exit in `extensions/provider.ts` (gates at lines 379, 577, 614 and the catch branch): gate id, operand (`options.signal.aborted` vs `isExtensionContextDead`), and entry-time-delivered-aborted vs aborted-mid-run.
2. The system SHALL provide a scripted e2e repro against real pi 0.84.3 with the router active: abort turn A mid-classifier, send turn B, assert turn B delegates. The run log SHALL report which gate and operand fired.
3. The extension SHALL pass a two-turn unit test in `extensions/provider.test.ts`: turn A aborted mid-classifier, turn B invoked with a fresh `AbortController`, turn B delegates and streams normally.
4. If the e2e repro pins the mechanism inside pi 0.84.3, the maintainer SHALL document the pinned mechanism and file an upstream pi issue; the router keeps the guard test from requirement 3.
5. The investigation SHALL record the located mechanism (or the strongest remaining hypothesis with evidence) for the abort state that killed turns 3 and 4.

## Non-Functional Requirements

- **Reliability**: Aborted exits keep pushing terminal `aborted` error events so pi's `EventStream.result()` resolves. The spinner-hang fix from 01d84ba7 must not regress.
- **Performance**: Gate instrumentation is zero-cost when debug is off. No logging, no extra allocation on the hot path.
- **Security**: No new trust boundary. No requirement.

## Constraints & Assumptions

- Extension-first mandate (`AGENTS.md`): no pi core changes from this repo.
- pi runtime pinned at 0.84.3 (global install, dist mtime 2026-08-28). No version drift: the source read is the failing runtime.
- Verified baseline: the router persists nothing across turns. `state.ts` holds no signal; the dead flag clears on every live capture (`extensions/index.ts:64-95`); the retry controller clears in `finally` and its signal never enters provider options (pi `agent-session.js:2250-2253`).
- Classifier latency ~7.5 s shapes repro timing (abort must land mid-classifier).
- Test runner: `npm test` (`vitest run`, vitest ^4.1.9).
- The probe read the actual source at HEAD 01d84ba7. Graph index metadata predates the commit, so source reads, not graph queries, ground the file:line claims here.

## Acceptance Criteria

- [ ] `npm test` exits 0 and includes the new two-turn test in `extensions/provider.test.ts`.
- [ ] The e2e repro script exists under `scripts/` or `tests/e2e/`. Its log shows turn A aborted and turn B delegated — or shows the pinned gate and operand, with an upstream issue link when the mechanism is pi-side.
- [ ] With debug on, an aborted turn emits the gate/operand/timing line on the debug surface.
- [ ] With debug off, the abort path emits no debug output, and `npm test` still passes.
- [ ] Existing provider tests stay green: aborted exits still push terminal `aborted` events.

## Recommended Approach

Sequence three legs in order: (1) instrument the abort gates in `extensions/provider.ts` with debug-scoped operand logging; (2) scripted e2e repro against real pi 0.84.3 aborting mid-classifier; (3) two-turn unit guard at the `streamSimple` seam in `extensions/provider.test.ts`. If leg 2 pins the mechanism inside pi, file upstream and keep the guard.

## Decisions

### Working diagnosis: post-classifier gate
**Question**: Which exit produced the "Operation aborted" turns?
**Recommended**: Gate at `extensions/provider.ts:379`, right after the classifier await.
**Chosen**: Most-probable exit: `provider.ts:379`. Router pushed the terminal event (proven by message shape). The operand that tripped it is unproven.
**Rationale**: evidence: session JSONL message shape matches `createAbortedMessage` (`extensions/provider.ts:76-96`); ~7.5 s delay equals classifier latency; catch branch and gates 577/614 excluded by timing. Confirmed via advisor (user delegation).

### Evidence baseline: ownership
**Question**: Does the router persist poisoned abort state across turns?
**Recommended**: No — the poison crosses the pi-runtime boundary.
**Chosen**: Router persistence ruled out (verified). The pi-side mechanism is unlocated. Pinning it is an in-scope work item, not a settled fact.
**Rationale**: evidence: no signal stored anywhere (`extensions/routing.ts:752`, `extensions/state.ts`), dead flag clears per turn (`extensions/index.ts:64-95`), pi 0.84.3 has no version drift, retry-latch ruled out. Confirmed via advisor (user delegation).

### Acceptance shape: three legs
**Question**: What is the acceptance core?
**Recommended**: Instrument → live repro → unit guard.
**Chosen**: Three-legged acceptance. A mocked-controller unit test alone would pass today without reproducing the bug.
**Rationale**: The poison enters through the real pi runtime; only a live repro discriminates. Confirmed via advisor (user delegation).

### Fix layer
**Question**: Where does the fix land — router-only hardening, pi root-cause first, or both?
**Recommended**: Both, sequenced.
**Chosen**: Both, sequenced: instrument router gates first, live-repro against pi 0.84.3; if the mechanism lands pi-side, document and file upstream; keep the router guard test.
**Rationale**: Optimizes root-cause closure (stated intent) while the sequence keeps extension-first compliance. Confirmed via advisor (user delegation).

### Non-goals
**Question**: Confirm the three exclusions?
**Chosen**: Full abort-path audit, further spinner-hang work, and pi-core code changes from this repo are all out of scope.
**Rationale**: Audit declined in intent answer; spinner-hang fixed by 01d84ba7; extension-first mandate.

### Non-functional requirements
**Question**: Confirm both constraints?
**Chosen**: (1) Terminal-aborted-event behavior must not regress. (2) Gate instrumentation is zero-cost when debug is off.
**Rationale**: Protects the 01d84ba7 fix; keeps hot path clean.

### Unit guard shape
**Question**: Two-turn test in `extensions/provider.test.ts`, run via `npm test`?
**Chosen**: Confirmed. Turn A aborted mid-classifier; turn B with a fresh `AbortController` delegates and streams.
**Rationale**: Fails on any layer that lets one abort poison the next turn.

### Live repro mechanism
**Question**: Scripted e2e or manual checklist?
**Chosen**: Scripted e2e under `scripts/` or `tests/e2e/`, against real pi 0.84.3.
**Rationale**: Repeatable; settles which operand fires and whether pi delivers a pre-aborted signal.

### Instrumentation scope
**Question**: What do the gates emit when debug is on?
**Chosen**: One line per abort exit: gate id, operand, entry-time delivered-aborted vs aborted-mid-run. Existing debug surface. Zero-cost when off.
**Rationale**: Cheapest step that converts the hypothesis into a diagnosis.

## Open Questions

None. No item was deferred. The unlocated pi-side mechanism is in scope as Functional Requirement 5.

## Suggested Follow-ups

- Entry-time signal check at `streamSimple` start, before the classifier await — candidate hardening beyond current scope (`extensions/provider.ts` delegation entry).
- If the repro pins pi: upstream issue on the `AgentSession.abort()` → `waitForIdle()` path (pi `agent-session.js:1171-1175`).
- Classifier latency (~7.5 s, `nemotron-3-nano:30b` thinking high) adds latency to every routed turn — separate optimization, unrelated to this bug.

## References

- `pi-session-2026-09-05T21-29-51-693Z_01a0737a-534c-74a6-b05a-3faef8518d9d.html` (repo root, user-supplied)
- `C:\Users\utama\.pi\agent\sessions\--H--fork-openshorts--\2026-09-05T21-29-51-693Z_01a0737a-534c-74a6-b05a-3faef8518d9d.jsonl` (raw session)
- Commit `01d84ba7` — "fix: resolve abort spinner hang with terminal aborted events and candidate timeout"
- `.rpiv/artifacts/plans/2026-09-05_12-33-55_router-hang-terminal-events.md` (prior plan, same seam)
- pi core 0.84.3 dist: `agent.js`, `agent-loop.js`, `agent-session.js`, `runner.js` (global install)
