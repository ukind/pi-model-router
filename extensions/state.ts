import type {
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
  RouterPersistedState,
} from './types';
import { isRouterTier, isThinkingLevel, isObjectRecord } from './config';

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

const isValidRoutingDecision = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.profile === 'string' &&
    typeof value.tier === 'string' &&
    isRouterTier(value.tier) &&
    typeof value.timestamp === 'number'
  );
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
  if (v.lastDecision !== undefined && !isValidRoutingDecision(v.lastDecision))
    return false;
  if (v.debugEnabled !== undefined && typeof v.debugEnabled !== 'boolean')
    return false;
  if (v.widgetEnabled !== undefined && typeof v.widgetEnabled !== 'boolean')
    return false;
  if (
    v.lastNonRouterModel !== undefined &&
    typeof v.lastNonRouterModel !== 'string'
  )
    return false;
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
    lastPhase: lastDecision?.phase,
    lastDecision,
    lastNonRouterModel,
    accumulatedCost,
    timestamp: Date.now(),
  };
};
