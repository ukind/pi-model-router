# Architecture: Pi Model Router Extension

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Core Concepts

### 1. Profiles & Tiers

The router is organized into **Profiles** (e.g., `balanced`, `cheap`, `deep`). Each profile defines up to three **Tiers** (at least one required):

- **High**: Reserved for architecture, design, complex debugging, and planning. Uses high-reasoning models.
- **Medium**: The default for standard implementation, multi-file edits, and focused fixes.
- **Low**: Used for summaries, changelogs, formatting, and simple read-only lookups.

### 2. Custom Provider Implementation

The extension uses `pi.registerProvider` to hook into the `pi` model lifecycle. This ensures that the selected model in the `pi` footer remains stable (e.g., `router/balanced`) while the underlying model changes transparently turn-by-turn via the `streamSimple` interception.

## Routing Decision Flow

For every request sent to a `router/*` model, the following logic is executed:

1. **Budget Check**: If a `maxSessionBudget` is configured and the session spend exceeds it, the router automatically downgrades `high` tier requests to `medium`.
2. **Manual Pin**: If the user has pinned a tier via `/router pin` or `/router fix`, that tier is used.
3. **Custom Rules**: Keyword-based rules defined in the config are checked against the user prompt.
4. **LLM Classifier (Optional)**: If `classifierModel` is configured, a fast LLM is called to categorize the user's intent.
5. **Heuristics (Fallback)**: If the classifier is off or fails, a fast local heuristic (keyword/length/tool-use analysis) is used.
6. **Biased Stickiness**: The `phaseBias` setting modulates thresholds to keep the router in a consistent phase (e.g., staying in `high` tier during a multi-turn planning session).

## Module Architecture

The extension is modularized for maintainability:

- `extensions/index.ts`: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- `extensions/provider.ts`: Implements the `router` provider and the delegation/retry loop.
- `extensions/closure.ts`: Cross-session closure dispatcher and registry guard (phantom-abort fix).
- `extensions/messages.ts`: Error and aborted terminal message factories.
- `extensions/truncate.ts`: Token estimation and context truncation.
- `extensions/routing.ts`: Core decision logic, heuristics, and the LLM classifier.
- `extensions/watchdog.ts`: Stall-watchdog primitives shared by the provider and the classifier. One activity tracker and one fetch tap per stream report raw connection liveness, and the per-pull timer re-arms on both bytes and parsed events.
- `extensions/keywords.ts`: Single source of the keyword and hint vocabulary.
- `extensions/config.ts`: Loads, merges, and normalizes the JSON configuration.
- `extensions/commands.ts`: Registers all `/router` subcommands and their autocompletions.
- `extensions/ui.ts`: Manages the status line and the optional state widget.
- `extensions/state.ts`: Handles session-persisted state and snapshots.
- `extensions/typesafe.ts`: TypeSafe (Jev) classifier backend.
- `extensions/types.ts`: Centralized interface and type definitions.
- `extensions/constants.ts`: Shared constants (limits, defaults, classifier floors).

## State & Persistence

The router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches.
- Track accumulated session costs safely.

## Reliability: Fallback Chains

Each tier in a profile can define an optional `fallbacks` list. If the primary model fails (e.g., due to rate limits or provider downtime), the router automatically retries the next model in the chain before surfacing an error to the user.

### Stall Watchdog: Two Signals

Every external wait (delegated stream, classifier stream, auth fetch) races a per-pull inactivity timer and an abort signal. `stallGuardedStream` pulls one value at a time, and `raceStallTimeout` arms the timer for each pull. Expiry rejects a named `StallTimeoutError`, which the fallback chains treat like any other failure. The typesafe classifier backend is the exception: its wait races its own plain `setTimeout` and records an infra failure, never a `StallTimeoutError`.

Two signals reset the clock:

- **Parsed events**: every value the guarded stream yields re-arms the next pull at `stallTimeoutMs`.
- **Raw connection bytes**: `createTrackingFetch` wraps the request's `fetch` per candidate and reports every response-body chunk to an activity tracker. The wrapper rebuilds only the body; status, headers, backpressure, and cancellation pass through.

Before the first parsed event, a connection that has sent one chunk waits `DEFAULT_STALL_BACKSTOP_MS` (600 000 ms) instead. Every later chunk re-arms that timer. Before any chunk, and after the first parsed event, the deadline is `stallTimeoutMs`. The verdict carries a condition string, and the notify line appends it. The condition is `connection silent` when the connection sent at least one chunk before the verdict, and `stream silent` when it sent none. The adapters in `NO_CUSTOM_FETCH_APIS` (`google-generative-ai`, `google-vertex`) reject a custom fetch, so they run untapped: their deadline stays `stallTimeoutMs`.

The delegated options object keeps the caller's `reasoning` value unless the router's effective thinking level is `off`, so a missing registry reasoning flag no longer turns thinking off.
