import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RouterProfile,
  RoutedTierConfig,
  ConfigLoadResult,
  ParsedConfigFile,
  RouterTier,
  RoutingRule,
  ModelDefinition,
} from './types';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './constants';

export const ROUTER_TIERS = ['high', 'medium', 'low'] as const;

export const FALLBACK_CONFIG: RouterConfig = {
  defaultProfile: 'auto',
  debug: false,
  profiles: {
    auto: {
      high: { model: 'openai/gpt-5.4-pro', thinking: 'off' },
      medium: { model: 'google/gemini-flash-latest', thinking: 'off' },
      low: { model: 'openai/gpt-5.4-nano', thinking: 'off' },
    },
  },
};

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];
export const ROUTER_PIN_VALUES = ['auto', 'high', 'medium', 'low'] as const;

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);

export const isRouterTier = (value: unknown): value is RouterTier =>
  value === 'high' || value === 'medium' || value === 'low';

export const parseConfigFile = (path: string): ParsedConfigFile => {
  if (!existsSync(path)) {
    return { config: {}, warnings: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isObjectRecord(parsed)) {
      return {
        config: {},
        warnings: [`Ignored router config at ${path}: expected a JSON object.`],
      };
    }
    return { config: parsed as Partial<RouterConfig>, warnings: [] };
  } catch (error) {
    return {
      config: {},
      warnings: [
        `Failed to parse router config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
};

/**
 * Resolve a model reference: if it matches a key in the models map,
 * return the canonical ref and definition; otherwise treat it as a
 * canonical "provider/model" ref.
 */
export const resolveModelRef = (
  ref: string,
  models: Record<string, ModelDefinition> | undefined,
): { canonicalRef: string; definition?: ModelDefinition } => {
  const definition = models?.[ref];
  if (definition) {
    return { canonicalRef: definition.model, definition };
  }
  return { canonicalRef: ref };
};

export const mergeConfig = (
  base: RouterConfig,
  override: Partial<RouterConfig>,
): RouterConfig => {
  const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
  for (const [name, profile] of Object.entries(override.profiles ?? {})) {
    const existing = mergedProfiles[name];
    const nextProfile = profile as Partial<RouterProfile>;
    mergedProfiles[name] = {
      high: {
        ...(existing?.high ?? FALLBACK_CONFIG.profiles.auto.high),
        ...(nextProfile.high ?? {}),
      },
      medium: {
        ...(existing?.medium ?? FALLBACK_CONFIG.profiles.auto.medium),
        ...(nextProfile.medium ?? {}),
      },
      low: {
        ...(existing?.low ?? FALLBACK_CONFIG.profiles.auto.low),
        ...(nextProfile.low ?? {}),
      },
    };
  }

  const mergedModels: Record<string, ModelDefinition> = {
    ...(base.models ?? {}),
    ...(override.models ?? {}),
  };

  return {
    defaultProfile: override.defaultProfile ?? base.defaultProfile,
    debug: override.debug ?? base.debug,
    classifierModel: override.classifierModel ?? base.classifierModel,
    phaseBias: override.phaseBias ?? base.phaseBias,
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
    models: Object.keys(mergedModels).length > 0 ? mergedModels : undefined,
  };
};

export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string } => {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  return { provider, modelId };
};

/**
 * Validate and normalize the models map from config.
 */
export const normalizeModelsMap = (
  raw: Record<string, unknown> | undefined,
  warnings: string[],
): Record<string, ModelDefinition> => {
  const result: Record<string, ModelDefinition> = {};
  if (!raw || !isObjectRecord(raw)) return result;

  for (const [alias, entry] of Object.entries(raw)) {
    if (!isObjectRecord(entry)) {
      warnings.push(`Ignored invalid model definition "${alias}": expected an object.`);
      continue;
    }

    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model) {
      warnings.push(`Model definition "${alias}" is missing the "model" field. Skipped.`);
      continue;
    }

    try {
      parseCanonicalModelRef(model);
    } catch (error) {
      warnings.push(
        `Model definition "${alias}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const contextWindow =
      typeof entry.contextWindow === 'number' && entry.contextWindow > 0
        ? entry.contextWindow
        : undefined;
    if (entry.contextWindow !== undefined && !contextWindow) {
      warnings.push(
        `Model definition "${alias}" has invalid contextWindow. Ignored.`,
      );
    }

    const maxOutputTokens =
      typeof entry.maxOutputTokens === 'number' && entry.maxOutputTokens > 0
        ? entry.maxOutputTokens
        : undefined;
    if (entry.maxOutputTokens !== undefined && !maxOutputTokens) {
      warnings.push(
        `Model definition "${alias}" has invalid maxOutputTokens. Ignored.`,
      );
    }

    result[alias] = { model, contextWindow, maxOutputTokens };
  }

  return result;
};

export const normalizeTierConfig = (
  value: unknown,
  fallback: RoutedTierConfig,
  profileName: string,
  tier: RouterTier,
  warnings: string[],
  models?: Record<string, ModelDefinition>,
): RoutedTierConfig => {
  if (!isObjectRecord(value)) {
    warnings.push(
      `Profile "${profileName}" has invalid ${tier} tier config. Falling back to ${fallback.model}.`,
    );
    return { ...fallback };
  }

  const rawModel = typeof value.model === 'string' ? value.model.trim() : '';
  let parsedModel = fallback.model;
  let aliasDefinition: ModelDefinition | undefined;

  if (!rawModel) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier is missing a model. Falling back to ${fallback.model}.`,
    );
  } else {
    // Try to resolve as an alias first
    const resolved = resolveModelRef(rawModel, models);
    aliasDefinition = resolved.definition;
    try {
      parseCanonicalModelRef(resolved.canonicalRef);
      parsedModel = resolved.canonicalRef;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const thinking = isThinkingLevel(value.thinking)
    ? value.thinking
    : fallback.thinking;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid thinking level. Falling back to ${fallback.thinking ?? 'medium'}.`,
    );
  }

  let fallbacks: string[] | undefined = undefined;
  if (Array.isArray(value.fallbacks)) {
    fallbacks = [];
    for (const f of value.fallbacks) {
      if (typeof f === 'string') {
        // Resolve aliases in fallbacks too
        const resolvedFallback = resolveModelRef(f, models);
        try {
          parseCanonicalModelRef(resolvedFallback.canonicalRef);
          fallbacks.push(resolvedFallback.canonicalRef);
        } catch (error) {
          warnings.push(
            `Invalid fallback model "${f}" in profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  // Resolve contextWindow: tier config > alias > hardcoded default
  const tierContextWindow =
    typeof value.contextWindow === 'number' && value.contextWindow > 0
      ? value.contextWindow
      : undefined;
  const resolvedContextWindow =
    tierContextWindow ?? aliasDefinition?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

  // Resolve maxOutputTokens: tier config > alias > hardcoded default
  const tierMaxOutputTokens =
    typeof value.maxOutputTokens === 'number' && value.maxOutputTokens > 0
      ? value.maxOutputTokens
      : undefined;
  const resolvedMaxOutputTokens =
    tierMaxOutputTokens ?? aliasDefinition?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    model: parsedModel,
    thinking,
    fallbacks,
    contextWindow: tierContextWindow,
    maxOutputTokens: tierMaxOutputTokens,
    resolvedContextWindow,
    resolvedMaxOutputTokens,
  };
};

export const normalizeConfig = (raw: RouterConfig): ConfigLoadResult => {
  const warnings: string[] = [];

  // Normalize models map first so aliases are available during tier normalization
  const normalizedModels = normalizeModelsMap(
    raw.models as Record<string, unknown> | undefined,
    warnings,
  );
  const hasModels = Object.keys(normalizedModels).length > 0;

  const normalizedProfiles: Record<string, RouterProfile> = {};
  const fallbackAuto = FALLBACK_CONFIG.profiles.auto;

  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    normalizedProfiles[name] = {
      high: normalizeTierConfig(
        profile?.high,
        fallbackAuto.high,
        name,
        'high',
        warnings,
        hasModels ? normalizedModels : undefined,
      ),
      medium: normalizeTierConfig(
        profile?.medium,
        fallbackAuto.medium,
        name,
        'medium',
        warnings,
        hasModels ? normalizedModels : undefined,
      ),
      low: normalizeTierConfig(
        profile?.low,
        fallbackAuto.low,
        name,
        'low',
        warnings,
        hasModels ? normalizedModels : undefined,
      ),
    };
  }

  if (Object.keys(normalizedProfiles).length === 0) {
    normalizedProfiles.auto = fallbackAuto;
    warnings.push(
      'No valid router profiles found. Falling back to the built-in auto profile.',
    );
  }

  let defaultProfile =
    typeof raw.defaultProfile === 'string' && raw.defaultProfile.trim()
      ? raw.defaultProfile.trim()
      : undefined;
  if (!defaultProfile || !normalizedProfiles[defaultProfile]) {
    const fallbackProfile = normalizedProfiles[
      FALLBACK_CONFIG.defaultProfile ?? 'auto'
    ]
      ? (FALLBACK_CONFIG.defaultProfile ?? 'auto')
      : Object.keys(normalizedProfiles).sort()[0];
    if (defaultProfile && !normalizedProfiles[defaultProfile]) {
      warnings.push(
        `Default router profile "${defaultProfile}" was not found. Falling back to "${fallbackProfile}".`,
      );
    }
    defaultProfile = fallbackProfile;
  }

  const phaseBias =
    typeof raw.phaseBias === 'number'
      ? Math.max(0, Math.min(1, raw.phaseBias))
      : 0.5;

  const maxSessionBudget =
    typeof raw.maxSessionBudget === 'number' && raw.maxSessionBudget > 0
      ? raw.maxSessionBudget
      : undefined;

  const rules: RoutingRule[] = [];
  if (Array.isArray(raw.rules)) {
    for (const rule of raw.rules) {
      if (isObjectRecord(rule)) {
        const matches = rule.matches;
        const tier = rule.tier;
        if (
          (typeof matches === 'string' || Array.isArray(matches)) &&
          isRouterTier(tier)
        ) {
          rules.push({
            matches,
            tier,
            reason: typeof rule.reason === 'string' ? rule.reason : undefined,
          });
        } else {
          warnings.push(
            `Ignored invalid routing rule: ${JSON.stringify(rule)}`,
          );
        }
      }
    }
  }

  // Resolve classifierModel alias
  let classifierModel =
    typeof raw.classifierModel === 'string'
      ? raw.classifierModel.trim()
      : undefined;
  if (classifierModel) {
    const resolved = resolveModelRef(
      classifierModel,
      hasModels ? normalizedModels : undefined,
    );
    try {
      parseCanonicalModelRef(resolved.canonicalRef);
      classifierModel = resolved.canonicalRef;
    } catch (error) {
      warnings.push(
        `Invalid classifierModel: ${error instanceof Error ? error.message : String(error)}`,
      );
      classifierModel = undefined;
    }
  }

  return {
    config: {
      defaultProfile,
      debug: typeof raw.debug === 'boolean' ? raw.debug : false,
      classifierModel,
      phaseBias,
      maxSessionBudget,
      rules: rules.length > 0 ? rules : undefined,
      profiles: normalizedProfiles,
      models: hasModels ? normalizedModels : undefined,
    },
    warnings,
  };
};

export const loadRouterConfig = (cwd: string): ConfigLoadResult => {
  const globalPath = join(getAgentDir(), 'model-router.json');
  const projectPath = join(cwd, '.pi', 'model-router.json');
  const globalResult = parseConfigFile(globalPath);
  const projectResult = parseConfigFile(projectPath);
  const merged = mergeConfig(
    mergeConfig(FALLBACK_CONFIG, globalResult.config),
    projectResult.config,
  );
  const normalized = normalizeConfig(merged);
  return {
    config: normalized.config,
    warnings: [
      ...globalResult.warnings,
      ...projectResult.warnings,
      ...normalized.warnings,
    ],
  };
};

export const profileNames = (config: RouterConfig): string[] => {
  return Object.keys(config.profiles).sort();
};

export const resolveProfileName = (
  config: RouterConfig,
  requested?: string,
): string => {
  if (requested && config.profiles[requested]) {
    return requested;
  }
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return config.defaultProfile;
  }
  return profileNames(config)[0] ?? 'auto';
};

/**
 * Resolve the effective context window for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveContextWindow = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.contextWindow) return registryModel.contextWindow;
    } catch { /* ignore */ }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
  return tierConfig.resolvedContextWindow ?? DEFAULT_CONTEXT_WINDOW;
};

/**
 * Resolve the effective max output tokens for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveMaxOutputTokens = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.maxTokens) return registryModel.maxTokens;
    } catch { /* ignore */ }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
  return tierConfig.resolvedMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
};
