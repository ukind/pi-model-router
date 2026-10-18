import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { RouterDiagnosticEntry } from './types';
import { MAX_CLOSURE_HANDLES } from './constants';
import { createErrorMessage } from './messages';

// ---------------------------------------------------------------------------
// Cross-session closure dispatcher (phantom-abort fix, 2026-09-09).
//
// Root cause it fixes: pi-ai compat's apiProviderRegistry is a PROCESS-GLOBAL
// map keyed by api id — `registerApiProvider` does `set(api, ...)` so the LAST
// registration wins for every session in the process. Every in-process
// subagent session re-executes the factory (pi caches the extension module per
// cwd) and re-registers 'router-local-api', so after any subagent spawn the
// child's closure served ALL router streams — including the parent session's.
// When pi-subagents' 10-minute cleanup timer evicted the child
// (AgentManager.cleanup → shutdownChildSession → session_shutdown), the child
// closure flipped its dead flag and the parent's in-flight turn hit the
// dead-ctx choke, which fabricated a USER-ABORT terminal (stopReason
// 'aborted' → pi UI renders "Operation aborted") with no Esc pressed. The five
// turns before it were also corrupted: silently routed by the child's stale
// state (tier low/flash, decisions persisted into the child's session file).
//
// Fix: register ONE stable module-level dispatcher as the compat streamSimple
// (re-registration overwrites it with an equivalent function — harmless), and
// have it resolve the serving closure per call. Every closure registers a
// handle; captureCtx (any event, on the CALLING session's runner) bumps the
// handle's capture sequence, so at dispatch time the freshest-live handle IS
// the calling session's closure — turn_start precedes the provider request on
// every turn (pi core agent-session.js:367-374).
//
// ponytail ceiling: with N agents turning CONCURRENTLY, a sibling's turn_start
// can land between this session's capture and its dispatch, so freshest-live
// can pick the sibling's closure. Consequence is degraded state attribution
// only — the dead-flag choke below is signal-only, so no cross-pick can ever
// fabricate an abort. True session-scoped dispatch needs a pi-core change
// (compat's registry is keyed by api id, not session).
// ---------------------------------------------------------------------------

const closureHandles = new Set<RouterClosureHandle>();

interface RouterClosureHandle {
  /** The per-closure streamSimple built by this factory run. */
  stream: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  /** Bumped by captureCtx on the owning session's every extension event. */
  captureSeq: number;
  /** session_shutdown fired on the owning session — removed from the set. */
  dead: boolean;
  /** For forensics: distinguishes closures in stderr/diagnostics. */
  label: string;
}

// One handle per factory run (per session that loaded this module), keyed by
// the per-instance ExtensionAPI object — stable for the closure's lifetime,
// rebuilt state bags are not. actions.registerRouterProvider() runs multiple
// times per closure (reloadConfig, switchToRouterProfile) and must reuse it.
const handleByPi = new WeakMap<ExtensionAPI, RouterClosureHandle>();

let closureCaptureSeq = 0;
let closureFactorySeq = 0;

type DispatchProvenance =
  | 'closure:fresh'
  | 'closure:live-fallback'
  | 'closure:dead-fallback';

export const bumpClosureCapture = (pi: ExtensionAPI): void => {
  const handle = handleByPi.get(pi);
  if (handle) handle.captureSeq = ++closureCaptureSeq;
};

export const markClosureDead = (pi: ExtensionAPI): void => {
  const handle = handleByPi.get(pi);
  if (!handle) return;
  handle.dead = true;
  closureHandles.delete(handle);
};

export const pickClosureHandle = ():
  | { handle: RouterClosureHandle; provenance: DispatchProvenance }
  | undefined => {
  let freshestLive: RouterClosureHandle | undefined;
  let anyLive: RouterClosureHandle | undefined;
  let mostRecentAny: RouterClosureHandle | undefined;
  for (const handle of closureHandles) {
    if (!mostRecentAny || handle.captureSeq > mostRecentAny.captureSeq)
      mostRecentAny = handle;
    if (handle.dead) continue;
    if (!anyLive) anyLive = handle;
    if (!freshestLive || handle.captureSeq > freshestLive.captureSeq)
      freshestLive = handle;
  }
  if (freshestLive) return { handle: freshestLive, provenance: 'closure:fresh' };
  if (anyLive) return { handle: anyLive, provenance: 'closure:live-fallback' };
  // Dead closure as last resort is safe: every ctx read in the stream path is
  // dead-guarded and persistState is try/catch — it streams end-to-end with
  // state writes no-oping. Availability beats a fabricated abort.
  if (mostRecentAny)
    return { handle: mostRecentAny, provenance: 'closure:dead-fallback' };
  return undefined;
};

let loggedDispatchProvenance = { last: '' };
const logDispatchProvenance = (
  provenance: DispatchProvenance,
  detail: string,
) => {
  // One deduped stderr line per distinct provenance class per module instance.
  // Frequent fresh picks stay silent; the degraded classes are the field signal.
  if (loggedDispatchProvenance.last === provenance) return;
  loggedDispatchProvenance.last = provenance;
  if (provenance === 'closure:fresh') return;
  console.error(
    `[pi-model-router] closure dispatcher: ${provenance} (${detail})`,
  );
};

export const dispatchRouterStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const picked = pickClosureHandle();
  if (!picked) {
    // Defensive: unreachable while the module that defines this dispatcher has
    // ever created a closure, and set-bounding drops only dead handles whose
    // replacement closure has already registered. Fail loud, never as abort.
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: 'error',
      reason: 'error',
      error: createErrorMessage(
        model,
        'Router provider has no session closure to serve this stream (all closures dead and none retained). This is a router extension bug — please report it.',
      ),
    });
    stream.end();
    return stream;
  }
  logDispatchProvenance(picked.provenance, `${picked.handle.label}`);
  return picked.handle.stream(model, context, options);
};

export const ensureClosureHandle = (
  pi: ExtensionAPI,
  stream: RouterClosureHandle['stream'],
  label: string,
): RouterClosureHandle => {
  let handle = handleByPi.get(pi);
  if (handle) {
    // actions.registerRouterProvider() re-runs per closure (reloadConfig,
    // switchToRouterProfile) — refresh the stream so a rebuilt state bag is
    // not served through a stale pre-reload one.
    handle.stream = stream;
    return handle;
  }
  handle = { stream, captureSeq: ++closureCaptureSeq, dead: false, label };
  handleByPi.set(pi, handle);
  closureHandles.add(handle);
  // Bound the set: reload/subagent churn can leave handles whose sessions were
  // torn down without an emitted shutdown. Drop dead ones beyond the cap —
  // a live handle is always kept.
  if (closureHandles.size > MAX_CLOSURE_HANDLES) {
    const dead = [...closureHandles].filter((h) => h.dead);
    while (dead.length > 0 && closureHandles.size > MAX_CLOSURE_HANDLES) {
      closureHandles.delete(dead.pop()!);
    }
  }
  return handle;
};

// Exported for index.ts: captureCtx calls this on EVERY delivered event so the
// calling session's closure is the freshest at dispatch time (turn_start
// precedes the provider request on every turn). session_shutdown calls the
// death marker so an evicted subagent's closure is never picked again.
export const notifyClosureCapture = bumpClosureCapture;
export const notifyClosureShutdown = markClosureDead;

// Module-level fallback registry. Pi caches the extension module per cwd
// (loader.js extensionCache): a second session created in this process from
// fresh services reuses the cached factory, producing a NEW closure over the
// SAME module instance — that closure can reach streamSimple with no captured
// registry, and this fallback covers it. In-process subagent sessions
// (pi-subagents createAgentSession) hit exactly this window: every child
// re-executes the factory and re-registers the provider into compat's
// process-global api map, so a stream can dispatch to a fresh closure that
// never received an extension event. /reload re-evaluates the module
// (resource-loader clearExtensionCache), so reload windows are covered by
// capture points (turn_start/session_start) instead; whatever remains is
// diagnosable via the guard diagnostic.
export const modelRegistryFallback: {
  current: ExtensionContext['modelRegistry'] | undefined;
} = { current: undefined };

const moduleLoadTimeMs = Date.now();

// Guard diagnostics: recovery (module fallback saved the stream) logs one
// deduped stderr line per module instance — frequent in aliased-closure
// windows, and the field signal that identifies which window fired. Failure
// (no capture anywhere in this module instance) also persists a
// `router-diagnostic` session entry via pi.appendEntry, which works without
// an extension ctx. Window discrimination at failure time: pid (parent vs
// child process), uptimeMs (near-zero = first-call window; large =
// partial-load), argvFlags (TUI vs print-mode flags — flags only, so no user
// prompt text is persisted; mode itself is unknowable without an extension
// ctx). (Architecture review L0-01.)
const loggedGuardRecovery = { moduleFallback: false };
const logGuardRecovery = () => {
  if (loggedGuardRecovery.moduleFallback) return;
  loggedGuardRecovery.moduleFallback = true;
  console.error(
    `[pi-model-router] registry guard: recovered via module fallback ` +
      `(pid=${process.pid}, uptimeMs=${Date.now() - moduleLoadTimeMs}). ` +
      `The serving closure never received an extension event; ` +
      `a prior closure's capture supplied the registry.`,
  );
};
const logGuardFailure = (pi: ExtensionAPI, detail: string) => {
  const diagnostic: RouterDiagnosticEntry = {
    type: 'registry-guard',
    provenance: 'none',
    pid: process.pid,
    uptimeMs: Date.now() - moduleLoadTimeMs,
    argvFlags: process.argv
      .slice(2)
      .filter((arg) => arg.startsWith('-'))
      .join(' ')
      .slice(0, 120),
    detail,
  };
  console.error(
    `[pi-model-router] registry guard FAILED: no closure capture and no ` +
      `module fallback (pid=${diagnostic.pid}, uptimeMs=${diagnostic.uptimeMs}, ` +
      `argvFlags=${diagnostic.argvFlags}, ${diagnostic.detail})`,
  );
  try {
    pi.appendEntry('router-diagnostic', diagnostic);
  } catch {
    // ponytail: appendEntry unavailable (pre-bind runtime) — stderr is the trace.
  }
};

// Exported for provider.ts's closure stream: the registry guard pair.
export const guardRecovery = logGuardRecovery;
export const guardFailure = logGuardFailure;
