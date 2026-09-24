#!/usr/bin/env node
// Live work_type wire probe - one real POST to the TypeSafe (Jev) endpoint.
//
// Why: mocked suites hid wire-shape defects twice (940be7f5, a44baa28).
// The probe proves the live API accepts the work_type question schema and
// answers on-vocabulary with a numeric confidence. It gates commit 2 (the
// floor-gated merge lands only after this probe passes live).
//
// ponytail: plain Node cannot import the TS builders - the source uses
// extensionless './config' specifiers that ESM will not resolve. So this
// file carries its own copy of the question SCHEMA with compact criteria
// text. Content parity is pinned by routing.test.ts (66-token multiset +
// round-trip assertions) against the real builder. If the wire schema
// changes, change both.
//
// Usage:
//   PI_MODEL_ROUTER_PROBE=1 node scripts/probe-work-type.mjs ["turn text"]
// The key comes from <agent dir>/typesafe_api_key (one line) - the same
// file readTypesafeApiKeyFile reads (extensions/typesafe.ts).
// Exit 0: HTTP 200 + on-vocabulary answers.work_type.choice + numeric
// confidence. Exit 1: gate missing, key missing, transport failure, HTTP
// error, or an unusable answer (raw body printed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Env gate first (e2e-esc-abort.mjs:54-60 pattern): nothing loads - not
// even the peer package - until the operator opts into a live paid POST.
const GATE = process.env.PI_MODEL_ROUTER_PROBE;
if (GATE !== '1') {
  console.error(
    'PI_MODEL_ROUTER_PROBE=1 must be set - this probe makes one live paid POST.',
  );
  process.exit(1);
}

// Mirrors isRouterWorkType (extensions/config.ts): the four wire choices
// plus the tolerated literal 'unknown' (a live model may answer it on an
// ambiguous turn; the mapper maps it to medium).
const WORK_TYPES = [
  'planning',
  'implementation',
  'summary',
  'lookup',
  'unknown',
];

// Mirrors TYPESAFE_ENDPOINT / TYPESAFE_DEFAULT_MODEL (extensions/typesafe.ts).
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 30_000;
const DEFAULT_TURN = 'Where is the config loader defined in this repo?';

const fail = (message) => {
  console.error(`[probe] FAIL: ${message}`);
  process.exit(1);
};

const criterion = (covers, notFor, examples, keywords) => ({
  covers,
  not_for: notFor,
  examples,
  keywords,
});

// Same question set as buildTypesafeQuestions (extensions/typesafe.ts):
// one work_type choice plus the three noul signal questions (FR12).
const questions = {
  work_type: {
    type: 'choice',
    instructions: 'Which work type fits the latest request',
    criteria: {
      planning: criterion(
        'Design judgment, planning, tradeoff analysis, broad debugging, large refactors, codebase research; long detailed requests.',
        'Bounded edits with a known plan, routine implementation, tests and fixes, summaries, lookups.',
        'Design the migration plan; analyze why the build is slow; weigh two approaches.',
        ['plan', 'design', 'research', 'analyze', 'refactor'],
      ),
      implementation: criterion(
        'Hands-on implementation with a clear target: writing or editing code, fixes, tests, patches, continuing in-progress work.',
        'Open-ended design or research (planning); summaries and read-only lookups (summary or lookup).',
        'Implement the agreed change; fix this failing test; continue the work.',
        ['implement', 'fix', 'update', 'refactor', 'continue'],
      ),
      summary: criterion(
        'Short bounded low-effort outputs: summaries, recaps, formatting, renames, brief explanations.',
        'Anything that writes or changes code (implementation); read-only lookups (lookup); design work (planning).',
        'Summarize this diff; tl;dr of that document; reformat this file.',
        ['summarize', 'tl;dr', 'reformat', 'briefly'],
      ),
      lookup: criterion(
        'Read-only lookups that locate information: where something lives, which files match, quick factual checks.',
        'Requests that write or change anything (implementation); explanations and text transforms (summary).',
        'Where is the config loader defined; which file exports the map.',
        ['where is', 'which file', 'find', 'grep'],
      ),
    },
  },
  long_request: {
    type: 'noul',
    instructions:
      'Is the latest turn a long, detailed request (roughly 40+ words)?',
    criteria: {
      true: 'The turn is long and detailed: roughly 40 or more words, or several distinct requirements.',
      false: 'The turn is short: one simple ask, well under 40 words.',
    },
  },
  structured_request: {
    type: 'noul',
    instructions:
      'Does the latest turn span multiple lines in a structured or detailed way?',
    criteria: {
      true: 'The turn has 4 or more lines, or uses structure: steps, lists, code blocks.',
      false: 'The turn is a single line or one plain sentence.',
    },
  },
  implementation_context: {
    type: 'noul',
    instructions:
      'Does the recent history show active implementation work (tool results or code edits)?',
    criteria: {
      true: 'Recent history shows tool results, code edits, file writes, or test runs.',
      false: 'Recent history shows only questions, chat, or discussion.',
    },
  },
};

const main = async () => {
  const turn = process.argv[2] ?? DEFAULT_TURN;
  const state = {
    latest_turn: turn,
    recent_history: '',
    has_image: false,
  };

  // Dynamic on purpose: the gate check above must stay hermetic - a bare
  // `node scripts/probe-work-type.mjs` with no env prints usage and exits
  // without loading any package.
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const keyPath = join(getAgentDir(), 'typesafe_api_key');
  let apiKey = '';
  try {
    apiKey = readFileSync(keyPath, 'utf8').trim();
  } catch {
    // absent or unreadable - same as readTypesafeApiKeyFile returning undefined
  }
  if (!apiKey) fail(`no API key - expected one line in ${keyPath}`);

  console.log(`[probe] POST ${ENDPOINT} model=${MODEL}`);
  console.log(`[probe] turn: ${turn}`);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    fail(`transport failure: ${error.message}`);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    fail(`HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fail(`200-OK body is not JSON: ${rawBody.slice(0, 500)}`);
  }

  const answer = body?.answers?.work_type;
  const choice =
    typeof answer?.choice === 'string'
      ? answer.choice.trim().toLowerCase()
      : undefined;
  if (!choice || !WORK_TYPES.includes(choice)) {
    fail(
      `answers.work_type.choice not in vocabulary: ${JSON.stringify(answer ?? body).slice(0, 500)}`,
    );
  }
  if (
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence)
  ) {
    fail(
      `answers.work_type.confidence is not numeric: ${JSON.stringify(answer).slice(0, 500)}`,
    );
  }

  console.log(
    `[probe] OK: work_type=${choice} confidence=${answer.confidence.toFixed(2)}`,
  );
  console.log(`[probe] answers: ${JSON.stringify(body.answers)}`);
};

main().catch((error) => {
  console.error(`[probe] unexpected: ${error?.stack ?? error}`);
  process.exit(1);
});
