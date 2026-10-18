/**
 * Shared keyword and hint vocabulary (F009). Single source for the routing
 * heuristics (routing.ts) and the TypeSafe wire criteria (typesafe.ts).
 * Content parity is pinned by routing.test.ts's HEAD keyword multiset
 * assertion — do not change a token without updating both consumers' tests.
 */

export const explicitHighHints = [
  'best',
  'deep',
  'deeply',
  'carefully',
  'thoroughly',
  'robust',
  'comprehensive',
  'step by step',
  'think hard',
  'highest quality',
  'ultrathink',
];

export const explicitLowHints = [
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
];

export const planningKeywords = [
  'plan',
  'planning',
  'architecture',
  'architect',
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
];

export const summaryKeywords = [
  'summarize',
  'summary',
  'changelog',
  'rewrite',
  'reformat',
  'format',
  'rename',
  'explain briefly',
  'recap',
  'tl;dr',
];

export const implementationKeywords = [
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
];

export const lookupKeywords = [
  'where is',
  'which file',
  'show me',
  'list',
  'what files',
  'find',
  'grep',
];

/**
 * Jev wire-criteria compositions (typesafe.ts). NOT the raw routing lists:
 * the Jev work_type criteria were authored as trimmed subsets, and the
 * 66-token wire multiset assertion in routing.test.ts pins the exact
 * content. planning omits 'architect' (routing), 'deeply' and 'carefully'
 * (high hints); lookup omits 'what files'. implementation and summary are
 * the shared lists verbatim (implementation as-is; summary plus the low
 * hints).
 */
export const jevPlanningKeywords = [
  ...planningKeywords.filter((k) => k !== 'architect'),
  ...explicitHighHints.filter((k) => k !== 'deeply' && k !== 'carefully'),
];

export const jevLookupKeywords = lookupKeywords.filter(
  (k) => k !== 'what files',
);
