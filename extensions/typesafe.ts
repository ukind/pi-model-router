/**
 * TypeSafe (Jev / System One) classifier backend.
 *
 * The call is not chat-shaped. One POST returns typed answers. The `tier`
 * question asks for one of the three router criteria, so the answer maps to a
 * tier directly and no output parser is needed.
 * Contract: https://docs.typesafe.ai/introduction/quickstart
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ClassifierResult, ConfidenceLevel, RouterTier } from './types';
import { isRouterTier, parseCanonicalModelRef } from './config';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const TYPESAFE_API_KEY_FILE = 'typesafe_api_key';

/**
 * Read the key from the agent dir file. The file holds the key on one line.
 * An absent, empty, or unreadable file returns undefined, so the caller skips
 * the request and the heuristics run.
 */
export const readTypesafeApiKeyFile = (): string | undefined => {
  try {
    const key = readFileSync(
      join(getAgentDir(), TYPESAFE_API_KEY_FILE),
      'utf8',
    ).trim();
    return key || undefined;
  } catch {
    return undefined;
  }
};

const TIER_CRITERIA = {
  high: 'Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.',
  medium:
    'Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests and fixes.',
  low: 'Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.',
} as const;

/**
 * Map the Jev confidence (a number in [0,1]) to a router confidence level.
 * An absent or invalid value stays 'medium', as parseClassifierOutput does
 * (routing.ts:678).
 */
export const toConfidenceLevel = (confidence: unknown): ConfidenceLevel => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return 'medium';
  }
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
};

/**
 * Pure: response body -> ClassifierResult. Returns undefined when the body
 * carries no usable tier answer, so the heuristics take over.
 */
export const mapTypesafeResponse = (
  body: unknown,
): ClassifierResult | undefined => {
  const answers = (body as { answers?: Record<string, unknown> } | null)
    ?.answers;
  const tierAnswer = answers?.tier as
    | { type?: string; choice?: unknown; confidence?: unknown }
    | undefined;
  const choice = tierAnswer?.choice;
  if (typeof choice !== 'string') return undefined;
  const tierRaw = choice.trim().toLowerCase();
  if (!isRouterTier(tierRaw)) return undefined;

  const tier: RouterTier = tierRaw;
  const confidence = toConfidenceLevel(tierAnswer?.confidence);
  return {
    tier,
    confidence,
    reasoning: `Jev classified the turn as ${tier} (confidence ${confidence}).`,
    rawText: JSON.stringify(answers),
    failureReason: 'success',
  };
};

export interface TypesafeClassifierOptions {
  state: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onStall?: (ref: string, ms: number) => void;
}

/**
 * Try each ref in order. The first usable answer wins. Every failure —
 * missing key, bad ref, HTTP error, stall, abort — returns undefined, so the
 * caller's heuristics run and no error reaches the turn.
 */
export const runTypesafeClassifier = async (
  refs: string[],
  options: TypesafeClassifierOptions,
): Promise<ClassifierResult | undefined> => {
  // The key comes from the agent dir file only.
  const apiKey = readTypesafeApiKeyFile();
  if (!apiKey) return undefined;

  for (const ref of refs) {
    if (options.signal?.aborted) return undefined;

    let modelId: string;
    try {
      modelId = parseCanonicalModelRef(ref).modelId;
    } catch {
      continue; // a bare "jev-latest" has no provider slash — config.ts:152
    }

    // Manual abort composition, the same pattern as the chat ref loop
    // (routing.ts:826). A stall aborts the fetch and reports through onStall.
    const controller = new AbortController();
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, options.timeoutMs);
    const propagateAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', propagateAbort, { once: true });
    }

    try {
      const response = await fetch(TYPESAFE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: options.state,
          model: modelId || TYPESAFE_DEFAULT_MODEL,
          questions: {
            tier: {
              type: 'choice',
              instructions: 'Which router tier fits the latest request',
              criteria: TIER_CRITERIA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) continue; // 401 / 429 / 5xx -> next ref, then heuristics
      const responseBody: unknown = await response.json();
      const result = mapTypesafeResponse(responseBody);
      if (result) return result;
    } catch (error) {
      if (stalled) options.onStall?.(ref, options.timeoutMs);
      void error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', propagateAbort);
    }
  }
  return undefined;
};
