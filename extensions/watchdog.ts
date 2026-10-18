/**
 * Stall-watchdog primitives shared by the provider turn loop (delegated
 * stream + auth) and runClassifier (classifier stream + auth).
 *
 * A wait counts as stalled when no progress arrives within `timeoutMs`.
 * Stalls throw a StallTimeoutError-named error so the existing
 * exception-driven fallback chains advance; aborts throw AbortError-named
 * errors so benign-abort classification stays intact.
 */
export const createStallTimeoutError = (
  timeoutMs: number,
  what: string,
): Error => {
  const error = new Error(
    `${what} stalled after ${timeoutMs}ms with no progress`,
  );
  error.name = 'StallTimeoutError';
  return error;
};

export const isStallTimeoutError = (
  error: unknown,
): error is Error =>
  error instanceof Error && error.name === 'StallTimeoutError';

/**
 * Race `promise` against an inactivity timer and an abort signal.
 * Losing branches clear the timer and detach the listener, so an
 * abandoned promise never produces an unhandled rejection (safe for
 * total functions like ModelRegistry.getApiKeyAndHeaders).
 */
export const raceStallTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  what = 'Operation',
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(createStallTimeoutError(timeoutMs, what));
    }, timeoutMs);
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
 */
export const stallGuardedStream = async function* <T>(
  stream: AsyncIterable<T>,
  timeoutMs: number,
  onStall?: () => void,
  signal?: AbortSignal,
  what = 'Stream',
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    let result: IteratorResult<T>;
    try {
      result = await raceStallTimeout(
        iterator.next(),
        timeoutMs,
        signal,
        what,
      );
    } catch (error) {
      if (isStallTimeoutError(error)) onStall?.();
      throw error;
    }
    if (result.done) return result.value;
    yield result.value;
  }
};
