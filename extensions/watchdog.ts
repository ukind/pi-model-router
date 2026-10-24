/**
 * Stall-watchdog primitives shared by the provider turn loop (delegated
 * stream + auth) and runClassifier (classifier stream + auth).
 *
 * A wait counts as stalled when no progress arrives within `timeoutMs`.
 * Stalls throw a StallTimeoutError-named error so the existing
 * exception-driven fallback chains advance; aborts throw AbortError-named
 * errors so benign-abort classification stays intact.
 *
 * A wait can also carry a StallGrace. Once the raw connection proves it is
 * live (one response-body chunk), the deadline becomes `backstopMs` and every
 * later chunk re-arms it; a connection that never sent a chunk keeps
 * `timeoutMs`, so a dead upstream still advances the chain without delay.
 * `createTrackingFetch` is what reports those chunks.
 */
import type { FetchFunction } from '@earendil-works/pi-ai';
import type { StallActivity, StallGrace, StallTimeoutError } from './types';

const CONNECTION_SILENT = 'connection silent';
const STREAM_SILENT = 'stream silent';

/**
 * Build the stall verdict, named so the fallback chains can classify it.
 * `condition` names what was silent when the timer fired and is appended only
 * for a wait that carried a liveness source (`grace`), so a false stall (live
 * connection, no parsed event) is distinguishable from a real one.
 */
export const createStallTimeoutError = (
  timeoutMs: number,
  what: string,
  condition?: string,
): StallTimeoutError => {
  const error: StallTimeoutError = new Error(
    `${what} stalled after ${timeoutMs}ms with no progress` +
      (condition === undefined ? '' : ` (${condition})`),
  );
  error.name = 'StallTimeoutError';
  if (condition !== undefined) Object.assign(error, { condition });
  return error;
};

export const isStallTimeoutError = (
  error: unknown,
): error is StallTimeoutError =>
  error instanceof Error && error.name === 'StallTimeoutError';

/**
 * Liveness record for one tapped stream. `advance()` reports one response-body
 * chunk, `observed` is sticky, and `subscribe` registers an advance listener
 * and returns the unsubscribe function. The tracker holds one boolean and one
 * listener set, and a wait that unsubscribes on settle leaves nothing behind.
 */
export const createActivityTracker = (): StallActivity => {
  const listeners = new Set<() => void>();
  let observed = false;
  return {
    get observed(): boolean {
      return observed;
    },
    advance: (): void => {
      observed = true;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * Wrap a fetch so every response-body chunk reports liveness to `activity`.
 *
 * The tap is per request, never global: the caller hands the wrapped fetch to
 * the adapter on the delegated options object, so only the tapped stream
 * reports progress. A response with no body crosses the tap untouched, and
 * otherwise only the body is wrapped — status, status text, and headers carry
 * over, which is every field the pi-ai adapters read. The wrapper reads
 * upstream only while a consumer read is pending (zero high-water mark), so it
 * holds no chunk of its own, and it forwards cancellation to the upstream
 * reader, so backpressure and teardown behave exactly as before.
 *
 * The request itself is not activity: `advance()` runs only when a body chunk
 * arrives, so a connection that accepts the request and then sends nothing
 * keeps the plain stall deadline.
 */
export const createTrackingFetch = (
  activity: StallActivity,
  base: FetchFunction,
): FetchFunction => {
  return async (input, init) => {
    const response = await base(input, init);
    const body = response.body;
    if (body === null) return response;
    const reader = body.getReader();
    const tracked = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          // A resolved read proves the connection is producing, even when the
          // chunk carries no bytes.
          activity.advance();
          controller.enqueue(chunk.value);
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    // Status, status text, and headers carry over from the upstream response.
    return new Response(tracked, response);
  };
};

/**
 * Race `promise` against an inactivity timer and an abort signal.
 * Losing branches clear the timer and detach the listener, so an
 * abandoned promise never produces an unhandled rejection (safe for
 * total functions like ModelRegistry.getApiKeyAndHeaders).
 *
 * With `grace`, the deadline is `grace.backstopMs` instead of `timeoutMs`
 * whenever the connection has proved itself live: either it sent a chunk
 * before this wait was armed, or it sends one while the wait is armed. Every
 * later chunk re-arms the same timer, and the verdict path is unchanged.
 */
export const raceStallTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  what = 'Operation',
  grace?: StallGrace,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }
    // A live connection waits the backstop; a silent one keeps timeoutMs.
    const liveDelayMs = grace?.backstopMs ?? timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };
    const arm = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        reject(
          createStallTimeoutError(
            delayMs,
            what,
            grace === undefined
              ? undefined
              : grace.activity.observed
                ? CONNECTION_SILENT
                : STREAM_SILENT,
          ),
        );
      }, delayMs);
    };
    if (grace !== undefined) {
      unsubscribe = grace.activity.subscribe(() => {
        arm(liveDelayMs);
      });
    }
    arm(grace?.activity.observed ? liveDelayMs : timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (reason) => {
        cleanup();
        reject(reason);
      },
    );
  });
};

/**
 * Wrap an async iterable with a per-event inactivity watchdog.
 * Every yielded event resets the timer; silence for `timeoutMs` invokes
 * `onStall` (cancel the underlying transport) and then throws
 * StallTimeoutError. Abort of `signal` throws an AbortError-named error.
 *
 * `grace` carries the backstop only until the first parsed event: one event
 * proves the stream itself is alive, so from then on `timeoutMs` is the whole
 * deadline and the activity signal only re-arms it.
 */
export const stallGuardedStream = async function* <T>(
  stream: AsyncIterable<T>,
  timeoutMs: number,
  onStall?: () => void,
  signal?: AbortSignal,
  what = 'Stream',
  grace?: StallGrace,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const eventClockGrace: StallGrace | undefined = grace
    ? { activity: grace.activity }
    : undefined;
  let sawEvent = false;
  while (true) {
    let result: IteratorResult<T>;
    try {
      result = await raceStallTimeout(
        iterator.next(),
        timeoutMs,
        signal,
        what,
        sawEvent ? eventClockGrace : grace,
      );
    } catch (error) {
      if (isStallTimeoutError(error)) onStall?.();
      throw error;
    }
    if (result.done) return result.value;
    sawEvent = true;
    yield result.value;
  }
};
