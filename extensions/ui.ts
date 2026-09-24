import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RoutingDecision,
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterTier,
} from './types';

const getEffectiveThinking = (
  thinkingByProfile: RouterThinkingByProfile,
  profileName: string,
  decision: RoutingDecision,
) => thinkingByProfile[profileName]?.[decision.tier] ?? decision.thinking;

export const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isRuleMatched) flags.push('rule');
  if (decision.isClassifier) flags.push('classifier');
  if (decision.isVetoed) flags.push('vetoed');
  if (decision.isPinned) flags.push('pin');
  if (decision.classifierAttempted && !decision.isClassifier)
    flags.push('classifier-failed');
  return flags;
};

/**
 * Criterion suffix for tier displays: ` (lookup)` in `Route: low (lookup)`.
 * Empty when the decision carries no classifier criterion, so
 * criterion-free decisions render exactly as before (FR11). Pin and
 * pure-heuristic decisions never carry one. Rule-won, degraded, and
 * budget-forced decisions can carry one — the suffix is provenance of
 * what the classifier answered, not a source label.
 */
const formatCriterionSuffix = (decision: RoutingDecision): string =>
  decision.classifierCriterion ? ` (${decision.classifierCriterion})` : '';

export const formatDecision = (decision: RoutingDecision): string => {
  const confidence = decision.confidence ? ` {${decision.confidence}}` : '';
  return `${decision.profile}: ${decision.tier}${formatCriterionSuffix(decision)} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}] (${decision.reasoning})${confidence}`;
};

export const formatPinSummary = (
  pinnedTierByProfile: RouterPinByProfile,
): string => {
  const entries = Object.entries(pinnedTierByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tier]) => `${profile}:${tier}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatThinkingSummary = (
  thinkingByProfile: RouterThinkingByProfile,
): string => {
  const entries = Object.entries(thinkingByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tierMap]) => {
      const tiers = Object.entries(tierMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, level]) => `${tier}:${level}`);
      return `${profile}(${tiers.join(',')})`;
    });
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatModelRef = (ref: string | undefined): string => {
  return ref ?? 'none';
};

/**
 * Unified "may not support '<level>'" warning body for both the event-driven
 * (index.ts) and command-driven (commands.ts) thinking-override paths.
 * `scope` is 'all' for the shift+tab event path (which always targets every
 * tier) or a single tier name for `/router thinking <tier> <level>`.
 */
export const formatUnsupportedThinkingWarning = (
  scope: 'all' | RouterTier,
  level: ThinkingLevel,
  unsupported: string[],
): string =>
  `Router thinking (${scope}) set to ${level}. ` +
  `${unsupported.join(', ')} tier${unsupported.length > 1 ? 's' : ''} may not support '${level}'.`;

export const updateStatus = (
  ctx: ExtensionContext,
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  accumulatedCost: number,
  widgetEnabled: boolean,
  currentConfig: RouterConfig,
) => {
  const activeRouterProfile = routerEnabled ? selectedProfile : undefined;
  const statusProfile = selectedProfile ?? 'none';
  const activePin = selectedProfile
    ? pinnedTierByProfile[selectedProfile]
    : undefined;
  const pinLabel = activePin ? ` [pin:${activePin}]` : '';

  if (activeRouterProfile) {
    const matchesProfile =
      lastDecision && lastDecision.profile === activeRouterProfile;
    const matchesPin = activePin ? lastDecision?.tier === activePin : true;

    let statusText: string;
    if (lastDecision && matchesProfile && matchesPin) {
      const effectiveThinking = getEffectiveThinking(
        thinkingByProfile,
        activeRouterProfile,
        lastDecision,
      );
      statusText = `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier}${formatCriterionSuffix(lastDecision)} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`;
    } else {
      statusText = `router:${activeRouterProfile}${pinLabel} -> waiting`;
    }
    ctx.ui.setStatus('router', `🚥 ${statusText}`);
  } else {
    ctx.ui.setStatus('router', undefined);
  }

  if (!widgetEnabled) {
    ctx.ui.setWidget('router', undefined);
    return;
  }

  const widgetLines = [
    `Router: ${routerEnabled ? 'enabled' : 'disabled'}`,
    `Profile: ${statusProfile}${activeRouterProfile ? ' (active)' : ''}`,
    `Pin: ${activePin ?? 'auto'}`,
    `Cost: $${accumulatedCost.toFixed(4)}` +
      (currentConfig.maxSessionBudget
        ? ` / $${currentConfig.maxSessionBudget.toFixed(2)}`
        : ''),
  ];
  if (lastDecision && lastDecision.profile === statusProfile) {
    const effectiveThinking = getEffectiveThinking(
      thinkingByProfile,
      statusProfile,
      lastDecision,
    );
    const flags = getDecisionFlags(lastDecision);
    const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';

    widgetLines.push(
      `Route: ${lastDecision.tier}${formatCriterionSuffix(lastDecision)}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${effectiveThinking})`,
      `Phase: ${lastDecision.phase}`,
    );
  } else if (!routerEnabled && lastNonRouterModel) {
    widgetLines.push(`Fallback: ${lastNonRouterModel}`);
  }
  if (Object.keys(pinnedTierByProfile).length > 1) {
    widgetLines.push(`Pins: ${formatPinSummary(pinnedTierByProfile)}`);
  }
  ctx.ui.setWidget(
    'router',
    widgetLines.map((line) => ctx.ui.theme.fg('dim', line)),
  );
};
