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
import type {
  ClassifierPromptContext,
  ClassifierResult,
  ConfidenceLevel,
  RouterPhase,
  RouterTier,
} from './types';
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

export interface TypesafeCriterion {
  covers: string;
  not_for: string;
  examples: string;
  /**
   * The router's own hint/keyword vocabulary for this tier (routing.ts
   * explicitHighHints / explicitLowHints / planning / summary /
   * implementation / lookup keyword sets). Docs allow arrays in criteria
   * values; the eval (Follow-up 2) shows this array is the single largest
   * accuracy lever.
   */
  keywords: string[];
}

// Eval-v2 rubric (Follow-up 2): 19/19 on the labeled live eval, mean
// confidence 0.976. Enriched from the router's own keyword sets and phase
// semantics — do not trim the keywords arrays; they carry the accuracy.
const TIER_CRITERIA: Record<RouterTier, TypesafeCriterion> = {
  high: {
    covers:
      'Requests that need design judgment or broad analysis: planning, architecture, tradeoff analysis, migration strategy, comparing approaches, root-cause investigation, codebase research, and large multi-file refactors. Also long detailed multi-part requests (roughly 40 or more words) and requests asking for deep, thorough, careful, comprehensive, or best-quality work.',
    not_for:
      'Bounded edits with a known plan, routine implementation, focused single-file debugging, tests and fixes, summaries and formatting, and read-only lookups. A short fix or continue request is not high even when the project is complex.',
    examples:
      'Design the migration plan for the settings module; analyze why the build is slow across the codebase; weigh two persistence approaches; ultrathink: audit this service for correctness; research the auth flow and propose a redesign.',
    keywords: [
      'plan',
      'planning',
      'architecture',
      'design',
      'tradeoff',
      'trade-off',
      'research',
      'investigate',
      'root cause',
      'analyze',
      'analysis',
      'migration',
      'strategy',
      'compare',
      'options',
      'approach',
      'ultrathink',
      'think hard',
      'deep',
      'thoroughly',
      'comprehensive',
      'robust',
      'best',
      'highest quality',
      'step by step',
    ],
  },
  medium: {
    covers:
      'Hands-on implementation with a clear target: writing or editing code, fixing bugs, adding or updating tests, applying a patch, small-to-medium refactors, multi-file edits under an agreed plan, and continuing or resuming in-progress work. Also edits to project files such as readme, docs, or configuration as part of development work. The default for general coding requests and for image attachments during active coding.',
    not_for:
      'Open-ended design, planning, or research requests (high). Summaries, changelogs, formatting, renames, and read-only lookups (low).',
    examples:
      'Implement the agreed change in three files; fix this failing test; continue the work; add input validation and update its tests; refactor the config loader per the plan; update the readme to document the new flag.',
    keywords: [
      'implement',
      'code',
      'fix',
      'update',
      'edit',
      'write',
      'refactor',
      'add tests',
      'patch',
      'change',
      'apply',
      'continue',
      'resume',
      'make the changes',
      'go ahead',
    ],
  },
  low: {
    covers:
      'Short bounded low-effort outputs: summaries, recaps, changelogs, TL;DRs, brief explanations, formatting, renames, and small text transforms. Read-only lookups such as where something lives or which files match. Requests asking for fast, quick, cheap, brief, one-sentence, or one-line answers.',
    not_for:
      'Any request that writes or changes code, documentation, or configuration, however small (medium). Design, planning, and analysis work (high).',
    examples:
      'Summarize this diff; tl;dr of that document; reformat this file; rename this variable everywhere; where is the config loader defined; explain briefly what this function does.',
    keywords: [
      'summarize',
      'summary',
      'changelog',
      'recap',
      'tl;dr',
      'reformat',
      'format',
      'rename',
      'rewrite',
      'explain briefly',
      'where is',
      'which file',
      'show me',
      'list',
      'find',
      'grep',
      'fast',
      'cheap',
      'quick',
      'quickly',
      'brief',
      'briefly',
      'one sentence',
      'one line',
      'tiny',
      'small',
    ],
  },
};

/**
 * Jev-native request state: conversation content only — no output-format
 * instructions. Instructions live in the questions (docs: separate content
 * from questions).
 */
export interface TypesafeState {
  latest_turn: string;
  recent_history: string;
  current_phase?: RouterPhase;
  has_image: boolean;
}

/**
 * Pure: prompt context -> Jev-native state object. Consumes the shared
 * `buildClassifierPromptContext` seam; `has_image` travels as a named field
 * because Jev accepts text only (D7).
 */
export const buildTypesafeState = (
  ctx: ClassifierPromptContext,
): TypesafeState => ({
  latest_turn: ctx.promptText,
  recent_history: ctx.historyText,
  current_phase: ctx.currentPhase,
  has_image: ctx.hasImage ?? false,
});

export interface TypesafeNoulQuestion {
  type: 'noul';
  instructions: string;
  /** Documented Noul criteria: what a yes and a no mean (D13). */
  criteria: { true: string; false: string };
}

export interface TypesafeQuestions {
  tier: {
    type: 'choice';
    instructions: string;
    criteria: Record<RouterTier, TypesafeCriterion>;
  };
  long_request: TypesafeNoulQuestion;
  structured_request: TypesafeNoulQuestion;
  implementation_context: TypesafeNoulQuestion;
}

/**
 * Pure: the fixed question set for every typesafe turn — one tier choice
 * (contrastive criteria) plus three atomic signal questions (D5).
 */
export const buildTypesafeQuestions = (): TypesafeQuestions => ({
  tier: {
    type: 'choice',
    instructions: 'Which router tier fits the latest request',
    criteria: TIER_CRITERIA,
  },
  long_request: {
    type: 'noul',
    instructions:
      'Is the latest turn a long, detailed request (roughly 40+ words)?',
    criteria: {
      true: 'The latest turn is long and detailed: roughly 40 or more words, or several distinct requirements in one message.',
      false: 'The latest turn is short: one simple ask, well under 40 words.',
    },
  },
  structured_request: {
    type: 'noul',
    instructions:
      'Does the latest turn span multiple lines in a structured or detailed way?',
    criteria: {
      true: 'The latest turn has 4 or more lines, or uses structure: numbered steps, bullet lists, code blocks, or several distinct requirements.',
      false: 'The latest turn is a single line or one plain sentence with no structure.',
    },
  },
  implementation_context: {
    type: 'noul',
    instructions:
      'Does the recent history show active implementation work (tool results or code edits)?',
    criteria: {
      true: 'The recent history shows active implementation: tool results, code edits, file writes, or test runs.',
      false: 'The recent history shows no implementation work: only questions, chat, or discussion.',
    },
  },
});

/**
 * Map a Jev confidence (a number in [0,1]) to a router confidence level for
 * display. The routing gates use the numeric value with their own floors;
 * this bucket only feeds the word-shaped provenance surfaces (notify/widget).
 */
export const toConfidenceLevel = (confidence: unknown): ConfidenceLevel => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return 'medium';
  }
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
};

const SIGNAL_LABELS = {
  long_request: 'long request',
  structured_request: 'structured request',
  implementation_context: 'implementation context',
} as const;

/**
 * Pure: fold the atomic Noul signal answers into a short provenance suffix.
 * The signals are recorded only — they never change the routed tier (D9).
 * A Noul answer is the probability that the answer is yes; >= 0.5 reads
 * as present (D13).
 */
const readTypesafeSignals = (
  answers: Record<string, unknown> | undefined,
): string => {
  if (!answers) return '';
  const present: string[] = [];
  for (const [key, label] of Object.entries(SIGNAL_LABELS)) {
    const noul = (answers[key] as { noul?: unknown } | undefined)?.noul;
    if (typeof noul === 'number' && noul >= 0.5) present.push(label);
  }
  return present.length > 0 ? ` Signals: ${present.join(', ')}.` : '';
};

/**
 * Pure: response body -> ClassifierResult. Returns undefined when the body
 * carries no usable tier answer or no numeric confidence; the caller records
 * that as a 'json-invalid' failure instead of degrading silently (FR3/FR4).
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

  const confidenceNumeric = tierAnswer?.confidence;
  if (
    typeof confidenceNumeric !== 'number' ||
    Number.isNaN(confidenceNumeric) ||
    !Number.isFinite(confidenceNumeric)
  ) {
    return undefined;
  }

  const tier: RouterTier = tierRaw;
  return {
    tier,
    confidence: toConfidenceLevel(confidenceNumeric),
    confidenceNumeric,
    reasoning:
      `Jev classified the turn as ${tier} (confidence ${confidenceNumeric.toFixed(2)}).` +
      readTypesafeSignals(answers),
    rawText: JSON.stringify(answers),
    failureReason: 'success',
  };
};

export interface TypesafeClassifierOptions {
  state: TypesafeState;
  signal?: AbortSignal;
  timeoutMs: number;
  onStall?: (ref: string, ms: number) => void;
}

/**
 * Try each ref in order. The first usable answer wins. Failures are recorded
 * so the caller can distinguish "never ran" from "ran but unusable" (FR4): a
 * missing key, a pre-aborted signal, or an unusable ref keeps the result
 * undefined; a 200 response with no usable answer yields 'json-invalid'; an
 * HTTP error, transport failure, or stall yields 'infra-failure'.
 */
export const runTypesafeClassifier = async (
  refs: string[],
  options: TypesafeClassifierOptions,
): Promise<ClassifierResult | undefined> => {
  // The key comes from the agent dir file only.
  const apiKey = readTypesafeApiKeyFile();
  if (!apiKey) return undefined;

  let lastFailure: 'json-invalid' | 'infra-failure' | undefined;
  let lastRawBody: string | undefined;

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
          questions: buildTypesafeQuestions(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 401 / 429 / 5xx -> record, next ref, then heuristics.
        lastFailure = 'infra-failure';
        continue;
      }
      // Read the text first: a transport-level throw still reaches the outer
      // catch (infra-failure), while both unusable-200 shapes keep a snapshot
      // for /router fix calibration.
      const rawBodyText = await response.text();
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(rawBodyText);
      } catch {
        // A 200-OK body that is not JSON is an unusable answer, not a
        // transport failure (D10). The text is the snapshot.
        lastFailure = 'json-invalid';
        lastRawBody = rawBodyText;
        continue;
      }
      const result = mapTypesafeResponse(responseBody);
      if (result) return result;
      // Ran, answered unusably: record the body, then try the next ref.
      lastFailure = 'json-invalid';
      lastRawBody = rawBodyText;
    } catch (error) {
      // A mid-run abort means the turn was killed — not a classifier failure.
      if (options.signal?.aborted) return undefined;
      if (stalled) options.onStall?.(ref, options.timeoutMs);
      lastFailure = 'infra-failure';
      void error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', propagateAbort);
    }
  }

  if (lastFailure === 'json-invalid') {
    return {
      reasoning:
        'Jev answered but the response carried no usable tier and numeric confidence.',
      rawText: lastRawBody,
      failureReason: 'json-invalid',
    };
  }
  if (lastFailure === 'infra-failure') {
    return {
      reasoning:
        'Jev could not be reached (HTTP error, stall, or network failure).',
      failureReason: 'infra-failure',
    };
  }
  return undefined;
};
