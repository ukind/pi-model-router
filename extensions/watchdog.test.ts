import { describe, it, expect, vi } from 'vitest';
import type { FetchFunction } from '@earendil-works/pi-ai';
import type { StallActivity } from './types';
import {
  createActivityTracker,
  createTrackingFetch,
  createStallTimeoutError,
  isStallTimeoutError,
  raceStallTimeout,
  stallGuardedStream,
} from './watchdog';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const neverSettles = () => new Promise<void>(() => {});

const settleTag = (promise: Promise<unknown>) =>
  promise.then(
    () => 'settled',
    () => 'settled',
  );

const encode = new TextEncoder();

const chunkedResponse = (chunks: string[], init?: ResponseInit): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) controller.enqueue(encode.encode(chunk));
        controller.close();
      },
    }),
    init,
  );

describe('createActivityTracker', () => {
  it('starts unobserved and turns observed on the first advance', () => {
    const tracker = createActivityTracker();
    expect(tracker.observed).toBe(false);
    tracker.advance();
    expect(tracker.observed).toBe(true);
  });

  it('notifies listeners per advance and stops after unsubscribe', () => {
    const tracker = createActivityTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    tracker.advance();
    tracker.advance();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    tracker.advance();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('createStallTimeoutError', () => {
  it('keeps the untapped wording when no condition is given', () => {
    const error = createStallTimeoutError(1500, 'auth for a/b');
    expect(error.message).toBe(
      'auth for a/b stalled after 1500ms with no progress',
    );
    expect(error.name).toBe('StallTimeoutError');
    expect(error.condition).toBeUndefined();
  });

  it('appends the measured condition when the wait carried a liveness source', () => {
    const error = createStallTimeoutError(
      600_000,
      'Stream',
      'connection silent',
    );
    expect(error.message).toBe(
      'Stream stalled after 600000ms with no progress (connection silent)',
    );
    expect(isStallTimeoutError(error)).toBe(true);
    expect(isStallTimeoutError(error) && error.condition).toBe(
      'connection silent',
    );
  });
});

describe('raceStallTimeout with grace', () => {
  it('keeps the timeout deadline when the connection never sent a chunk', async () => {
    const tracker = createActivityTracker();
    const stall = raceStallTimeout(neverSettles(), 30, undefined, 'test', {
      activity: tracker,
      backstopMs: 400,
    });
    const outcome = await Promise.race([
      settleTag(stall),
      sleep(150).then(() => 'waiting'),
    ]);
    expect(outcome).toBe('settled');
    await expect(stall).rejects.toMatchObject({
      name: 'StallTimeoutError',
      condition: 'stream silent',
    });
  });

  it('waits the backstop once a chunk proved the connection live', async () => {
    const tracker = createActivityTracker();
    tracker.advance();
    const stall = raceStallTimeout(neverSettles(), 20, undefined, 'test', {
      activity: tracker,
      backstopMs: 120,
    });
    const outcome = await Promise.race([
      settleTag(stall),
      sleep(60).then(() => 'waiting'),
    ]);
    expect(outcome).toBe('waiting');
    await expect(stall).rejects.toMatchObject({
      name: 'StallTimeoutError',
      condition: 'connection silent',
    });
  });

  // Discriminating reset test: per-gap 8ms stays under the 60ms timer, but
  // 10 x 8ms = 80ms cumulative exceeds it — with the re-arm deleted the timer
  // fires mid-drive and the settle wins the race.
  it('re-arms the deadline on every chunk', async () => {
    const tracker = createActivityTracker();
    const stall = raceStallTimeout(neverSettles(), 60, undefined, 'test', {
      activity: tracker,
    });
    const drive = (async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(8);
        tracker.advance();
      }
    })();
    const outcome = await Promise.race([
      settleTag(stall),
      drive.then(() => sleep(15)).then(() => 'waiting'),
    ]);
    expect(outcome).toBe('waiting');
    await expect(stall).rejects.toMatchObject({ name: 'StallTimeoutError' });
  });

  // Discriminating leak test: the counted decorator keeps its own listener
  // tally, so deleting cleanup()'s unsubscribe leaves `live` at 1 and fails.
  it('detaches its tracker listener when the wait settles', async () => {
    const tracker = createActivityTracker();
    let live = 0;
    const counted: StallActivity = {
      get observed(): boolean {
        return tracker.observed;
      },
      advance: (): void => tracker.advance(),
      subscribe: (listener: () => void): (() => void) => {
        live += 1;
        const unsubscribe = tracker.subscribe(listener);
        return () => {
          live -= 1;
          unsubscribe();
        };
      },
    };
    const stall = raceStallTimeout(neverSettles(), 20, undefined, 'test', {
      activity: counted,
    });
    expect(live).toBe(1); // the wait attached to the tracker
    await expect(stall).rejects.toMatchObject({ name: 'StallTimeoutError' });
    expect(live).toBe(0); // and detached on settle
  });

  // Discriminating upgrade test: the wait is armed with the 30ms timeout (no
  // chunk yet); the chunk at 10ms must replace that deadline with the 150ms
  // backstop, so the verdict cannot land before the 70ms probe. Re-arming with
  // timeoutMs instead settles the race at 40ms and fails this test.
  it('upgrades to the backstop when the first chunk arrives during the wait', async () => {
    const tracker = createActivityTracker();
    const stall = raceStallTimeout(neverSettles(), 30, undefined, 'test', {
      activity: tracker,
      backstopMs: 150,
    });
    const drive = (async () => {
      await sleep(10);
      tracker.advance();
    })();
    const outcome = await Promise.race([
      settleTag(stall),
      drive.then(() => sleep(60)).then(() => 'waiting'),
    ]);
    expect(outcome).toBe('waiting');
    await expect(stall).rejects.toMatchObject({
      name: 'StallTimeoutError',
      condition: 'connection silent',
    });
  });
});

describe('stallGuardedStream with grace', () => {
  it('uses the backstop until the first event, then the per-event timeout', async () => {
    const tracker = createActivityTracker();
    const source = async function* () {
      tracker.advance(); // the tap forwards the first response-body chunk
      await sleep(120); // 4x the 30ms event clock, under the 600ms backstop
      yield 'first';
      await neverSettles(); // silence after the first event
    };
    const events: string[] = [];
    let failure: unknown;
    const consume = (async () => {
      try {
        for await (const event of stallGuardedStream(
          source(),
          30,
          undefined,
          undefined,
          'test',
          { activity: tracker, backstopMs: 600 },
        )) {
          events.push(event as string);
        }
      } catch (error) {
        failure = error;
      }
    })();
    const outcome = await Promise.race([
      consume.then(() => 'settled'),
      sleep(300).then(() => 'waiting'),
    ]);
    expect(events).toEqual(['first']);
    expect(outcome).toBe('settled');
    await consume;
    expect(failure).toMatchObject({
      name: 'StallTimeoutError',
      condition: 'connection silent',
    });
  });

  it('keeps the per-event timeout when grace carries no backstop', async () => {
    const tracker = createActivityTracker();
    tracker.advance();
    const source = async function* () {
      yield 'first';
      await neverSettles();
    };
    let failure: unknown;
    const consume = async () => {
      try {
        for await (const event of stallGuardedStream(
          source(),
          20,
          undefined,
          undefined,
          'test',
          { activity: tracker },
        )) {
          void event;
        }
      } catch (error) {
        failure = error;
      }
    };
    await consume();
    expect(isStallTimeoutError(failure)).toBe(true);
    if (isStallTimeoutError(failure)) {
      expect(failure.condition).toBe('connection silent');
    }
  });

  it('keeps the untapped wording when no grace is supplied', async () => {
    const source = async function* () {
      yield 'first';
      await neverSettles();
    };
    let failure: unknown;
    const consume = async () => {
      try {
        for await (const event of stallGuardedStream(
          source(),
          15,
          undefined,
          undefined,
          'test',
        )) {
          void event;
        }
      } catch (error) {
        failure = error;
      }
    };
    await consume();
    expect(isStallTimeoutError(failure)).toBe(true);
    if (isStallTimeoutError(failure)) {
      expect(failure.message).toBe('test stalled after 15ms with no progress');
      expect(failure.condition).toBeUndefined();
    }
  });
});

describe('createTrackingFetch', () => {
  it('does not count the request itself as activity', async () => {
    const tracker = createActivityTracker();
    const base: FetchFunction = vi.fn(async () => chunkedResponse(['alpha']));
    const tapped = createTrackingFetch(tracker, base);
    const response = await tapped('https://api.test/v1');
    expect(response.status).toBe(200);
    expect(tracker.observed).toBe(false); // nothing read from the body yet
    expect(await response.text()).toBe('alpha');
    expect(tracker.observed).toBe(true);
  });

  // Discriminating per-chunk test: two upstream chunks must produce two
  // advances. A tap that advances once per response leaves this at 1.
  it('reports one advance per response-body chunk', async () => {
    const tracker = createActivityTracker();
    const advance = vi.spyOn(tracker, 'advance');
    const base: FetchFunction = vi.fn(async () =>
      chunkedResponse(['alpha', 'beta']),
    );
    const tapped = createTrackingFetch(tracker, base);
    const response = await tapped('https://api.test/v1');
    expect(await response.text()).toBe('alphabeta');
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it('carries status, status text, and headers onto the wrapped response', async () => {
    const base: FetchFunction = vi.fn(async () =>
      chunkedResponse(['alpha'], {
        status: 201,
        statusText: 'Created',
        headers: { 'x-router-test': 'kept' },
      }),
    );
    const tapped = createTrackingFetch(createActivityTracker(), base);
    const response = await tapped('https://api.test/v1');
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('x-router-test')).toBe('kept');
  });

  // Identity, not equality: a bodyless response must not be re-wrapped, and
  // `new Response(body, { status: 204 })` throws on the null-body status.
  it('returns the upstream response unchanged when it has no body', async () => {
    const original = new Response(null, { status: 204 });
    const base: FetchFunction = vi.fn(async () => original);
    const tapped = createTrackingFetch(createActivityTracker(), base);
    expect(await tapped('https://api.test/v1')).toBe(original);
  });

  it('forwards the request and its options untouched', async () => {
    const base: FetchFunction = vi.fn(async () => chunkedResponse(['alpha']));
    const tapped = createTrackingFetch(createActivityTracker(), base);
    const init: RequestInit = { method: 'POST', headers: { 'x-api-key': 'k' } };
    await tapped('https://api.test/v1', init);
    expect(base).toHaveBeenCalledWith('https://api.test/v1', init);
  });

  // Discriminating demand test: with the default one-chunk buffer the wrapper
  // reads the next chunk as soon as the first read settles, so `pulls` reaches
  // 2 while no consumer read is pending.
  it('reads upstream only while a consumer read is pending', async () => {
    let pulls = 0;
    const base: FetchFunction = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull: (controller) => {
                pulls += 1;
                controller.enqueue(encode.encode('alpha'));
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const tapped = createTrackingFetch(createActivityTracker(), base);
    const response = await tapped('https://api.test/v1');
    const body = response.body;
    if (body === null) throw new Error('the tapped response has no body');
    const reader = body.getReader();
    await reader.read();
    await sleep(20);
    expect(pulls).toBe(1);
    await reader.cancel();
  });

  it('forwards consumer cancellation to the upstream reader', async () => {
    let cancelled: unknown = 'not cancelled';
    const base: FetchFunction = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
            cancel: (reason) => {
              cancelled = reason;
            },
          }),
        ),
    );
    const tapped = createTrackingFetch(createActivityTracker(), base);
    const response = await tapped('https://api.test/v1');
    const body = response.body;
    if (body === null) throw new Error('the tapped response has no body');
    await body.getReader().cancel('router teardown');
    expect(cancelled).toBe('router teardown');
  });

  it('propagates an upstream read failure to the consumer', async () => {
    const base: FetchFunction = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => controller.error(new Error('socket reset')),
          }),
        ),
    );
    const tapped = createTrackingFetch(createActivityTracker(), base);
    const response = await tapped('https://api.test/v1');
    await expect(response.text()).rejects.toThrow('socket reset');
  });
});
