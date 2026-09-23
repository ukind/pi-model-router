import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPin = RouterTier | 'auto';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
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
  | 'json-refused'
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
  isBudgetExceeded?: boolean;
  phaseBias?: number;
}

export interface ClassifierResult {
  tier: RouterTier;
  confidence: ConfidenceLevel;
  reasoning: string;
  rawText: string;
  failureReason: ClassifierFailureReason;
}

export interface ClassifierCalibrationEntry {
  promptSummary: string;
  classifierTier: RouterTier;
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
  rawText?: string;
  failureReason?: ClassifierFailureReason;
  isVetoed?: boolean;
  vetoReason?: 'explicit-hint';
  classifierAttempted?: boolean;
  classifierTier?: RouterTier;
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
