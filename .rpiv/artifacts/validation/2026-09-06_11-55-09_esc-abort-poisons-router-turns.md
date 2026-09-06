---
template_version: 1
date: 2026-09-06T11:55:09+0700
author: Yogiswara Utama
commit: 01d84ba7
branch: main
repository: pi-model-router
topic: "Validation of esc-abort-poisons-router-turns"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-09-06_09-26-07_esc-abort-poisons-router-turns.md"
tags: [validation, provider, abort-signal, terminal-events, e2e, rpc, debug-instrumentation]
last_updated: 2026-09-06T11:55:09+0700
---

## Validation Report: esc-abort-poisons-router-turns

### Implementation Status

- ✓ Phase 1: debugEnabled facade + abort-gate instrumentation — Fully implemented
- ✓ Phase 2: two-turn sticky-state guard (FRD acceptance core) — Fully implemented
- ✓ Phase 3: per-exit emission tests — Fully implemented
- ✓ Phase 4: e2e harness + README — Fully implemented

The working tree contains exactly the plan's declared files: `extensions/provider.ts` (45+/1−), `extensions/index.ts` (3+/0−), `extensions/provider.test.ts` (459+/0−, additions only), `scripts/e2e-esc-abort.mjs` (new), `README.md` (8+/0−). The implement session also performed the Phase 2 sabotage checks and the Phase 3 targeted `-t` run (both checked in the plan; suite green after revert).

### Automated Verification Results

Evidence provenance: `npm`/`npx` do not resolve in this validation shell (nvm4w shim), so the plan's `npm run tsc` and `npm test` ran through their exact underlying scripts via node entrypoints: `node node_modules/typescript/bin/tsc --noEmit` and `node node_modules/vitest/vitest.mjs run`. Same toolchain, same flags.

- ✓ Type check (Phases 1–4): `npm run tsc` (as `tsc --noEmit`) — clean, exit 0
- ✓ Full suite (Phases 1, 4): `npm test` (as `vitest run`) — 7 files, 285/285 passed, exit 0
- ✓ Targeted suite (Phases 2–3): `npx vitest run extensions/provider.test.ts` (as `vitest run extensions/provider.test.ts`) — 37/37 passed, exit 0
- ✓ Script parses (Phase 4): `node --check scripts/e2e-esc-abort.mjs` — exit 0
- ✓ Gate count (Phase 1): `grep -c "debugAbort" extensions/provider.ts` — 5 (1 definition + 4 exits)
- ✓ Terminal contract (Phase 1): `grep -c "reason: 'aborted'" extensions/provider.ts` — 4
- ✓ Facade getters (Phase 1): `grep -c "get debugEnabled" extensions/index.ts` — 2 (commands facade :516 + provider facade :323)
- ✓ Guard present once (Phase 2): `grep -c "should recover on the next turn after a mid-classifier abort" extensions/provider.test.ts` — 1 (at :1400)
- ✓ Last-call pin (Phase 2): `grep -c "calls[calls.length - 1]" extensions/provider.test.ts` — 1 (≥ 1)
- ✓ Emission describe once (Phase 3): `grep -c "abort-gate debug emission" extensions/provider.test.ts` — 1 (at :1516)
- ✓ All exits asserted (Phase 3): `grep -cE "gate[1-4]" extensions/provider.test.ts` — 11 (≥ 6)
- ✓ Debug-off contract (Phase 3): `grep -c "stays inert with debug off" extensions/provider.test.ts` — 1
- ✓ Dead-egress contract (Phase 3): `grep -c "swallows a dead-egress notify throw" extensions/provider.test.ts` — 1
- ✓ Gate-line capture (Phase 4): `grep -c "router[abort]" scripts/e2e-esc-abort.mjs` — 2 (≥ 1)
- ✓ Version-skew guard (Phase 4): `grep -c "0.84" scripts/e2e-esc-abort.mjs` — 2 (≥ 1)
- ✓ Sandbox isolation (Phase 4): `grep -c "PI_CODING_AGENT_DIR" scripts/e2e-esc-abort.mjs` — 2 (≥ 2)
- ✓ README documents harness (Phase 4): `grep -c "PI_MODEL_ROUTER_E2E_TARGET" README.md` — 2 (≥ 1)
- ✓ Never-read rule (Phase 4): `grep -c "errorMessage" scripts/e2e-esc-abort.mjs` — 0
- ✓ No regressions detected — existing suites pass; the test file diff is additions-only (git numstat 459+/0−), so the eight existing gate tests stay byte-identical

### Code Review Findings

#### Matches Plan:

- `extensions/provider.ts:202` — inline state type gains `readonly debugEnabled: boolean` (Section A)
- `extensions/provider.ts:313` — `debugAbort` helper verbatim, with the deliberate guard-deviation comment at the site (Section B)
- `extensions/provider.ts:355-358` — IIFE hoists `signalAbortedAtEntry`, `classifierRan`, `iifePhase`, `lastError` above the `try` (Section C); the old `let lastError` declaration is removed (exactly one declaration remains)
- `extensions/provider.ts:401` — `classifierRan = true` after `runClassifier`; `iifePhase` transitions at classifier/post-classifier/delegation/auth (Section D, F, H — 5 assignments + the `let`)
- `extensions/provider.ts:411` — gate1 emission as first statement of the taken branch, operands dead/signal/entry/classifierRan (Section E)
- `extensions/provider.ts:612` — gate2 loop-top emission, operands tier/candidate/dead/signal (Section G)
- `extensions/provider.ts:642,653` — auth phase marker + gate3 post-auth emission, operands model/tier/dead/signal (Section H)
- `extensions/provider.ts:878` — gate4 catch emission as first statement of the benign branch, operands stale/abort/phase/delegated/name/msg (Section I)
- `extensions/index.ts:323` — provider facade `get debugEnabled()` over the closure variable; nothing else changed in the file
- `extensions/provider.test.ts:1400` — two-turn sticky-state guard inside the gates describe, same `mockState`, no reset between turns
- `extensions/provider.test.ts:1516` — sibling emission describe with the seven tests (gate1, gate2, gate3, gate4-direct, gate4-rethrown, debug-off inert, dead-egress swallow)
- `scripts/e2e-esc-abort.mjs` — standalone RPC harness: sandbox `PI_CODING_AGENT_DIR`, version-skew guard on `0.84.`, two scenarios, interpretation table, `errorMessage` never read
- `README.md:43-50` — "For development" harness paragraph, verbatim per the plan fence

#### Deviations from Plan:

- `extensions/provider.test.ts:1840` — the dead-egress test reads `(notify.mock.calls[0] as any[])[0]` where the plan fence wrote `notify.mock.calls[0][0]`. The fenced form does not compile: `vi.fn()` with a zero-arg implementation types `mock.calls` as an empty tuple, so tsc raises TS2493. The shipped cast uses the file's existing idiom (`extensions/provider.test.ts:231` uses `mock.calls[0][2] as any`). Plan-fence defect, implementation is the improvement; tests and tsc pass with it. Non-blocking.
- `extensions/provider.ts` — the `// ← NEW` markers in the Phase 1 fences do not appear in shipped code (0 occurrences). They are design-diff annotations, not code, so omission is correct. Cosmetic, non-blocking.

#### Pattern Conformance:

- ✓ Test structure follows file conventions: per-describe local helpers (`sleep`, `terminated`, `makeModel`, `makeContext`), module-level `MockEventStream`, `as any` mock casts consistent with the existing suites
- ✓ `debugAbort` follows the file's arrow-function style; the guard deviation is documented inline, as the plan requires
- ✓ Drift greps clean: no "zero-cost" claims in `extensions/provider.ts` or `README.md`; the harness labels use "mid-turn" (not "mid-classifier"); one `lastError` declaration
- Minor observation: `scripts/` is a new directory with no sibling precedent; plain Node with zero dependencies matches the plan's "no deps" constraint — acceptable variation, not a deviation

#### Potential Issues:

- Working tree carries `pi-session-*.html` churn outside the plan's write-set: the tracked `pi-session-2026-07-22T23-42-23-….html` is deleted, and two untracked dumps from the 2026-09-05 sessions exist (mtimes 2026-09-06 04:48/05:09 +0700 — before the 09:26 plan). These are pi session-record artifacts, not the run's writes. No action required; exclude them from the upcoming commits.

### Manual Testing Required:

1. Phase 1 debug surface (live, interactive):
   - [ ] With debug on, a signal-aborted router turn notifies exactly one `router[abort] gate1 ...` line naming dead/signal/entry/classifierRan
   - [ ] With debug off, no `router[abort]` lines appear and turn behavior is byte-identical to pre-slice behavior
2. Phase 4 e2e (live: network + real keys + pi 0.84.x on PATH):
   - [ ] `PI_MODEL_ROUTER_E2E_TARGET=<cheap reachable provider/model> node scripts/e2e-esc-abort.mjs` prints all 7 turn rows + interpretation table, exits 0
   - [ ] Every abort turn row shows either a captured `router[abort]` gate line or the report explains its absence (beacon proved debug on)
   - [ ] With `PI_MODEL_ROUTER_E2E_KEEP=1`: kept sandbox contains `agentdir/models.json`, `agentdir/model-router.json` (debug true, classifier `ollama-cloud/nemotron-3-nano:30b`, all tiers → TARGET), and `agentdir/sessions/`
   - [ ] Real agent dir untouched after a run: `~/.pi/agent/model-router.json` unchanged

These six boxes are live-only by design. They are homework for the developer, not blockers: the Phase 1 debug-on path is covered at the unit seam by the emission suite, and the fast-fail contract (`node scripts/e2e-esc-abort.mjs` exits 1 without the env var) was verified during implement.

### Recommendations:

- Ready to commit — implementation is complete and validated.
- Keep the `pi-session-*.html` files out of the atomic commits (see Potential Issues).
- Run the live e2e when a target model is at hand; its output feeds the downstream root-cause fix and does not gate this evidence infrastructure.
