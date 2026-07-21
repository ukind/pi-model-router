import type {
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
  ClassifierCalibrationEntry,
} from './types';
import {
  isRouterTier,
  isThinkingLevel,
  isObjectRecord,
  isRouterPhase,
} from './config';

const isValidPinByProfile = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  for (const tier of Object.values(value)) {
    if (tier !== undefined && !isRouterTier(tier)) return false;
  }
  return true;
};

const isValidThinkingByProfile = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  for (const tierMap of Object.values(value)) {
    if (tierMap === undefined) continue;
    if (!isObjectRecord(tierMap)) return false;
    for (const level of Object.values(tierMap)) {
      if (level !== undefined && !isThinkingLevel(level)) return false;
    }
  }
  return true;
};

const isOptionalBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

const isOptionalString = (v: unknown): v is string => typeof v === 'string';

const isConfidenceLevel = (
  v: unknown,
): v is NonNullable<RoutingDecision['confidence']> =>
  v === 'high' || v === 'medium' || v === 'low';

const isVetoReason = (
  v: unknown,
): v is NonNullable<RoutingDecision['vetoReason']> => v === 'explicit-hint';

const isFailureReason = (
  v: unknown,
): v is NonNullable<RoutingDecision['failureReason']> =>
  v === 'success' ||
  v === 'unparseable' ||
  v === 'json-refused' ||
  v === 'json-invalid' ||
  v === 'infra-failure';

/**
 * Per-field sanitizer for a persisted `RoutingDecision`.
 *
 * Required fields (`profile`, `tier`, `timestamp`) reject-whole — returns
 * `undefined` if any are bad. The 6 non-optional RoutingDecision fields
 * declared in `types.ts:70-79` (`phase`, `targetProvider`, `targetModelId`,
 * `targetLabel`, `reasoning`, `thinking`) are defaulted when invalid so the
 * returned value always satisfies the interface (string → `''`, phase →
 * `'implementation'`, thinking → `'medium'`). The 10 optional fields (6
 * boolean flags + 4 classifier/veto provenance) are dropped if invalid.
 */
export const sanitizeRoutingDecisionFields = (
  value: unknown,
): RoutingDecision | undefined => {
  if (!isObjectRecord(value)) return undefined;
  if (typeof value.profile !== 'string') return undefined;
  if (typeof value.tier !== 'string' || !isRouterTier(value.tier)) {
    return undefined;
  }
  if (typeof value.timestamp !== 'number') return undefined;

  // Defaults for ALL 6 non-optional RoutingDecision fields beyond the 3
  // required ones; the interface (types.ts:70-79) makes them required, so
  // we must satisfy the literal type. Invalid values get safe defaults;
  // the 10 optional fields are dropped (not set) if invalid.
  const phase = isRouterPhase(value.phase) ? value.phase : 'implementation';
  const targetProvider = isOptionalString(value.targetProvider)
    ? value.targetProvider
    : '';
  const targetModelId = isOptionalString(value.targetModelId)
    ? value.targetModelId
    : '';
  const targetLabel = isOptionalString(value.targetLabel)
    ? value.targetLabel
    : '';
  const reasoning = isOptionalString(value.reasoning) ? value.reasoning : '';
  const thinking = isThinkingLevel(value.thinking) ? value.thinking : 'medium';
  const out: RoutingDecision = {
    profile: value.profile,
    tier: value.tier,
    timestamp: value.timestamp,
    phase,
    targetProvider,
    targetModelId,
    targetLabel,
    reasoning,
    thinking,
  };
  if (isOptionalBoolean(value.isClassifier)) {
    out.isClassifier = value.isClassifier;
  }
  if (isOptionalBoolean(value.isFallback)) {
    out.isFallback = value.isFallback;
  }
  if (isOptionalBoolean(value.isBudgetForced)) {
    out.isBudgetForced = value.isBudgetForced;
  }
  if (isOptionalBoolean(value.isRuleMatched)) {
    out.isRuleMatched = value.isRuleMatched;
  }
  if (isOptionalBoolean(value.isPinned)) {
    out.isPinned = value.isPinned;
  }
  if (isOptionalBoolean(value.isVetoed)) {
    out.isVetoed = value.isVetoed;
  }
  if (isVetoReason(value.vetoReason)) {
    out.vetoReason = value.vetoReason;
  }
  if (isConfidenceLevel(value.confidence)) {
    out.confidence = value.confidence;
  }
  if (isOptionalString(value.rawText)) {
    out.rawText = value.rawText;
  }
  if (isFailureReason(value.failureReason)) {
    out.failureReason = value.failureReason;
  }
  if (isOptionalBoolean(value.classifierAttempted)) {
    out.classifierAttempted = value.classifierAttempted;
  }
  if (isRouterTier(value.classifierTier)) {
    out.classifierTier = value.classifierTier;
  }
  if (
    value.vetoOutcome === 'classifier-wins' ||
    value.vetoOutcome === 'veto-wins'
  ) {
    out.vetoOutcome = value.vetoOutcome;
  }
  if (typeof value.vetoDisagreementMagnitude === 'number') {
    out.vetoDisagreementMagnitude = value.vetoDisagreementMagnitude;
  }
  return out;
};

/**
 * Required-field check used inside `isRouterPersistedState`.
 * Returns true iff the value is an object AND its three required fields
 * are present and well-typed. Optional fields are not checked here — the
 * consumer runs `sanitizeRoutingDecisionFields` to strip bad optional
 * fields without rejecting the whole state.
 */
const hasValidRequiredDecisionFields = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  if (typeof value.profile !== 'string') return false;
  if (typeof value.tier !== 'string' || !isRouterTier(value.tier)) return false;
  if (typeof value.timestamp !== 'number') return false;
  return true;
};

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (!isObjectRecord(value)) return false;
  const v = value;
  // Required core (existing)
  if (typeof v.enabled !== 'boolean') return false;
  if (typeof v.selectedProfile !== 'string') return false;
  if (typeof v.timestamp !== 'number') return false;
  // Optional fields: validate-if-present (mirrors config.ts:285-289 pattern)
  if (v.accumulatedCost !== undefined) {
    if (
      typeof v.accumulatedCost !== 'number' ||
      Number.isNaN(v.accumulatedCost) ||
      !Number.isFinite(v.accumulatedCost)
    ) {
      return false;
    }
  }
  if (v.pinByProfile !== undefined && !isValidPinByProfile(v.pinByProfile))
    return false;
  if (
    v.thinkingByProfile !== undefined &&
    !isValidThinkingByProfile(v.thinkingByProfile)
  )
    return false;
  if (v.pinTier !== undefined && !isRouterTier(v.pinTier)) return false;
  if (
    v.lastDecision !== undefined &&
    !hasValidRequiredDecisionFields(v.lastDecision)
  ) {
    return false;
  }
  if (v.debugEnabled !== undefined && typeof v.debugEnabled !== 'boolean')
    return false;
  if (v.widgetEnabled !== undefined && typeof v.widgetEnabled !== 'boolean')
    return false;
  if (
    v.lastNonRouterModel !== undefined &&
    typeof v.lastNonRouterModel !== 'string'
  )
    return false;
  if (v.classifierCalibration !== undefined) {
    if (!Array.isArray(v.classifierCalibration)) return false;
    for (const entry of v.classifierCalibration) {
      if (!isObjectRecord(entry)) return false;
      if (typeof entry.promptSummary !== 'string') return false;
      if (!isRouterTier(entry.classifierTier)) return false;
      if (!isRouterTier(entry.finalTier)) return false;
      if (typeof entry.timestamp !== 'number') return false;
    }
  }
  return true;
};

export const buildPersistedState = (
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  debugEnabled: boolean,
  widgetEnabled: boolean,
  debugHistory: RoutingDecision[],
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  accumulatedCost: number,
  classifierCalibration: ClassifierCalibrationEntry[],
): RouterPersistedState => {
  return {
    enabled: routerEnabled,
    selectedProfile: selectedProfile ?? '',
    pinTier: selectedProfile ? pinnedTierByProfile[selectedProfile] : undefined,
    pinByProfile: { ...pinnedTierByProfile },
    thinkingByProfile: { ...thinkingByProfile },
    debugEnabled,
    widgetEnabled,
    debugHistory,
    lastDecision,
    lastNonRouterModel,
    accumulatedCost,
    classifierCalibration,
    timestamp: Date.now(),
  };
};
