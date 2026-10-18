import { describe, it, expect } from 'vitest';
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  ensureClosureHandle,
  pickClosureHandle,
  notifyClosureCapture,
  notifyClosureShutdown,
} from './closure';

const makeStream = (label: string) =>
  (
    _model: Model<Api>,
    _context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    throw new Error(`unexpected dispatch of ${label}`);
  };

describe('closure dispatcher invariants (F025)', () => {
  it('two closures register and dispatch resolves to the freshest', () => {
    const piA = {} as ExtensionAPI;
    const piB = {} as ExtensionAPI;

    const handleA = ensureClosureHandle(piA, makeStream('a'), 'a');
    notifyClosureCapture(piA);

    const handleB = ensureClosureHandle(piB, makeStream('b'), 'b');
    notifyClosureCapture(piB);

    // B captured last — it is the freshest live handle.
    expect(pickClosureHandle()?.handle).toBe(handleB);

    // A re-captures and becomes the freshest again.
    notifyClosureCapture(piA);
    expect(pickClosureHandle()?.handle).toBe(handleA);
    expect(handleA.dead).toBe(false);
    expect(handleB.dead).toBe(false);
  });

  it('an evicted closure is never picked while a live one remains', () => {
    const piA = {} as ExtensionAPI;
    const piB = {} as ExtensionAPI;

    const handleA = ensureClosureHandle(piA, makeStream('a'), 'a');
    notifyClosureCapture(piA);
    const handleB = ensureClosureHandle(piB, makeStream('b'), 'b');
    notifyClosureCapture(piB);

    // Evict B (session_shutdown on the child closure).
    notifyClosureShutdown(piB);
    expect(handleB.dead).toBe(true);

    // The dead-fallback classes only fire when NO live handle exists.
    expect(pickClosureHandle()?.handle).toBe(handleA);
    expect(pickClosureHandle()?.provenance).toBe('closure:fresh');
  });
});
