import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
// The criterion vocabulary (FR1/FR3)
export type RouterWorkType =
  | 'planning'
  | 'implementation'
  | 'summary'
  | 'lookup'
  | 'unknown';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RoutingRule {
  matches: string | string[];
  tier: RouterTier;
  reason?: string;
}

export interface ModelDefinition {
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
}

export type ClassifierBackend = 'chat' | 'typesafe';

export interface ClassifierConfig {
  model: string;
  /** Transport for the classifier call. The default is 'chat' (chat stream). */
  backend?: ClassifierBackend;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ClassifierFailureReason =
  | 'success'
  | 'unparseable'
  | 'json-invalid'
  | 'infra-failure';

export interface ClassifierPromptContext {
  promptText: string;
  historyText: string;
  toolResultCount: number;
  wordCount: number;
  multiLinePrompt: boolean;
  currentPhase?: RouterPhase;
  hasImage?: boolean;
}

export interface ClassifierResult {
  /** Absent when the classifier ran but answered unusably (failureReason !== 'success'). */
  tier?: RouterTier;
  /** Work type the classifier answered, pre-map. Absent on failure results. */
  workType?: RouterWorkType;
  confidence?: ConfidenceLevel;
  /** Numeric confidence in [0,1] as reported by the backend. The routing gates read this first. */
  confidenceNumeric?: number;
  reasoning: string;
  /** Raw answer snapshot; carries the unusable body for failure results. */
  rawText?: string;
  failureReason: ClassifierFailureReason;
}

export interface ClassifierCalibrationEntry {
  promptSummary: string;
  classifierTier: RouterTier;
  /** Work type the classifier answered for this calibrated turn, when known. */
  classifierCriterion?: RouterWorkType;
  finalTier: RouterTier;
  userCorrection?: boolean;
  timestamp: number;
}

export interface RoutedTierConfig {
  model: string;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  resolvedContextWindow?: number;
  resolvedMaxTokens?: number;
  resolvedThinkingLevels?: ThinkingLevel[];
}

export interface RouterProfile {
  high?: RoutedTierConfig;
  medium?: RoutedTierConfig;
  low?: RoutedTierConfig;
}

export interface RouterConfig {
  debug?: boolean;
  classifierModel?: ClassifierConfig;
  phaseBias?: number;
  maxSessionBudget?: number;
  stallTimeoutMs?: number;
  rules?: RoutingRule[];
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition>;
}

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  phase: RouterPhase;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
  thinking: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean;
  isFallback?: boolean;
  isBudgetForced?: boolean;
  isRuleMatched?: boolean;
  isPinned?: boolean;
  confidence?: ConfidenceLevel;
  /** Numeric classifier confidence when the backend reported one. */
  confidenceNumeric?: number;
  rawText?: string;
  failureReason?: ClassifierFailureReason;
  isVetoed?: boolean;
  vetoReason?: 'explicit-hint';
  classifierAttempted?: boolean;
  classifierTier?: RouterTier;
  classifierCriterion?: RouterWorkType;
  vetoOutcome?: 'classifier-wins' | 'veto-wins';
  vetoDisagreementMagnitude?: number;
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier;
  pinByProfile?: RouterPinByProfile;
  thinkingByProfile?: RouterThinkingByProfile;
  debugEnabled?: boolean;
  widgetEnabled?: boolean;
  debugHistory?: RoutingDecision[];
  lastDecision?: RoutingDecision;
  lastNonRouterModel?: string;
  accumulatedCost?: number;
  classifierCalibration?: ClassifierCalibrationEntry[];
  timestamp: number;
}

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
}

export interface ParsedConfigFile {
  config: Partial<RouterConfig>;
  warnings: string[];
}

export interface CustomSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface RouterDiagnosticEntry {
  type: 'registry-guard';
  provenance: 'none';
  pid: number;
  uptimeMs: number;
  argvFlags: string;
  detail: string;
}

/**
 * Minimal structural facade for pi's ModelRuntime as reached through the
 * model registry's `runtime` field. That field is not part of the public
 * registry type; this interface names the one member the router delegates
 * through for custom (non-builtin) api ids. Replaces the previous
 * `as unknown as` cast with a shape-checked read (see getRuntimeFacade in
 * provider.ts).
 */
export interface ModelRuntimeFacade {
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

/**
 * Raw-connection liveness for one stream — one delegated candidate or one
 * classifier ref. A response-body tap on the request's fetch calls advance()
 * for every chunk; observed turns true on the first chunk and stays true. The
 * stall watchdog reads it to tell a live quiet connection from a dead one:
 * without proof of liveness the deadline stays stallTimeoutMs.
 */
export interface StallActivity {
  /** True once a response-body chunk arrived. Sticky for the stream's life. */
  readonly observed: boolean;
  /** Report one response-body chunk. */
  advance: () => void;
  /** Register an advance listener; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Per-pull extension of a stream's stall deadline. backstopMs is supplied only
 * while no parsed event has arrived yet: once the tap has seen a chunk the
 * watchdog waits it, and re-arms on every later chunk. After the first parsed
 * event the caller omits it, so the deadline returns to stallTimeoutMs.
 */
export interface StallGrace {
  readonly activity: StallActivity;
  readonly backstopMs?: number;
}

/**
 * The stall verdict error. error.name === 'StallTimeoutError' is a wire
 * contract. condition names the measured silence source at the moment of the
 * verdict, so a false stall (live connection, no events) is distinguishable
 * from a real one (no bytes and no events at all). Absent on waits with no
 * stream, such as the auth fetch races.
 */
export interface StallTimeoutError extends Error {
  readonly condition?: string;
}
