export const MAX_DEBUG_HISTORY = 12;
export const MAX_CALIBRATION_ENTRIES = 5;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
/** Numeric confidence floor for the classifier to override an explicit routing rule. */
export const CLASSIFIER_OVERRIDE_FLOOR = 0.85;
/** Numeric confidence floor for the classifier to survive an explicit-hint veto. */
export const CLASSIFIER_VETO_FLOOR = 0.85;
/** Numeric confidence floor below which a classifier answer degrades to heuristics. */
export const CLASSIFIER_DEGRADE_FLOOR = 0.5;
