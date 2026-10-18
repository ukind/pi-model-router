export const MAX_DEBUG_HISTORY = 12;
export const MAX_CALIBRATION_ENTRIES = 5;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
/**
 * Cap on retained closure handles in the cross-session dispatcher
 * (closure.ts). Reload/subagent churn can leave handles whose sessions
 * were torn down without a shutdown event; the set is bounded by dropping
 * dead handles beyond this cap — a live handle is always kept.
 */
export const MAX_CLOSURE_HANDLES = 8;
/**
 * Numeric certainty floor for the classifier answer to displace a matched
 * rule. At or above it, the mapped tier wins whenever it differs from the
 * rule's tier — above or below.
 */
export const CLASSIFIER_OVERRIDE_FLOOR = 0.85;
/**
 * Numeric certainty floor for the classifier answer to survive an
 * explicit-hint veto. Below it, the hint overrides the mapped tier.
 */
export const CLASSIFIER_VETO_FLOOR = 0.85;
/**
 * Numeric certainty floor below which a classifier answer degrades to
 * heuristics.
 */
export const CLASSIFIER_DEGRADE_FLOOR = 0.5;
