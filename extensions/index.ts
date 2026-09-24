import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RouterPersistedState,
  RoutingDecision,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterTier,
  CustomSessionEntry,
  ClassifierCalibrationEntry,
} from './types';
import {
  loadRouterConfig,
  profileNames,
  resolveProfileName,
  parseCanonicalModelRef,
  ROUTER_TIERS,
  getUnsupportedTiers,
} from './config';
import { MAX_DEBUG_HISTORY, MAX_CALIBRATION_ENTRIES } from './constants';
import {
  isRouterPersistedState,
  sanitizeRoutingDecisionFields,
  buildPersistedState,
} from './state';
import {
  updateStatus,
  formatModelRef,
  formatUnsupportedThinkingWarning,
} from './ui';
import { registerCommands } from './commands';
import {
  registerRouterProvider,
  modelRegistryFallback,
  notifyClosureCapture,
  notifyClosureShutdown,
} from './provider';

const routerExtension = (pi: ExtensionAPI) => {
  let currentConfig: RouterConfig = { profiles: {} };
  let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  let currentCwd = process.cwd();
  let lastDecision: RoutingDecision | undefined;
  let debugEnabled = false;
  let routerEnabled = false;
  let selectedProfile: string | undefined;
  let widgetEnabled = false;
  let lastRegisteredModels = '';
  const pinnedTierByProfile: RouterPinByProfile = {};
  const thinkingByProfile: RouterThinkingByProfile = {};
  let debugHistory: RoutingDecision[] = [];
  let lastNonRouterModel: string | undefined;
  let accumulatedCost = 0;
  let classifierCalibration: ClassifierCalibrationEntry[] = [];
  let lastExtensionContext: ExtensionContext | undefined;
  let lastConfigWarnings: string[] = [];
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;
  let isInternalModelSwitch = false;
  let isInternalThinkingChange = false;

  // Dead-flag gate: true while the captured ExtensionContext is known dead
  // (session_shutdown fired or a capture went stale). Cleared on the next
  // live capture. Runtime-only — never part of RouterPersistedState.
  let isExtensionContextDead = false;

  // Refresh the long-lived runtime captures (registry, cwd, last ctx) from
  // the delivered ExtensionContext. A delivered ctx goes stale after any
  // session replacement (pi invalidates captured runners on newSession /
  // fork / switchSession / reload), so this must run on EVERY event, above
  // any behavioral early-return gates. No pi event is guaranteed to precede
  // a custom provider's own streamSimple — capture here is best-effort
  // freshness; the provider's guard falls back to the module-level registry
  // when a closure never received an event. (Architecture review L0-01/
  // L0-02/L0-04.)
  const captureCtx = (ctx: ExtensionContext) => {
    try {
      // A successful read below proves the ctx is alive — clear the flag.
      isExtensionContextDead = false;
      lastExtensionContext = ctx;
      // Read the getter once: a ctx that goes stale between two reads would
      // otherwise populate closure state but not the module fallback.
      const registry = ctx.modelRegistry;
      currentModelRegistry = registry;
      // Module-level fallback: survives closure re-execution over the cached
      // module, so a fresh closure that never received an event can still
      // resolve a registry at guard time.
      modelRegistryFallback.current = registry;
      currentCwd = ctx.cwd;
      // Closure dispatcher: mark THIS session's closure as the freshest, so
      // the next router stream dispatch (this turn's provider request —
      // turn_start precedes it on every turn) resolves to it instead of a
      // sibling in-process subagent closure that re-registered the provider
      // later. (2026-09-09 phantom-abort fix.)
      notifyClosureCapture(pi);
    } catch {
      isExtensionContextDead = true;
      // Stale ctx after session replacement — ctx getters throw. Keep the
      // last captured values; the next event delivers a fresh ctx.
      // NOTE: `lastExtensionContext` may already hold the dead ctx here
      // (assigned before the throwing getter read) while the flag is set —
      // every reader must check `isExtensionContextDead` first.
      // (Comment amended by plan review, Step 5 S1; code order kept verbatim
      // from the design — reorder only via a /skill:design follow-up.)
    }
  };
  const setModelInternally = async (
    model: NonNullable<ExtensionContext['model']>,
  ) => {
    isInternalModelSwitch = true;
    try {
      return await pi.setModel(model);
    } finally {
      isInternalModelSwitch = false;
    }
  };

  const setThinkingLevelInternally = (level: ThinkingLevel) => {
    isInternalThinkingChange = true;
    try {
      pi.setThinkingLevel(level);
    } finally {
      isInternalThinkingChange = false;
    }
  };

  const getPinnedTierForProfile = (
    profileName: string,
  ): RouterTier | undefined => pinnedTierByProfile[profileName];

  const setPinnedTierForProfile = (
    profileName: string,
    tier: RouterTier | undefined,
  ) => {
    if (tier) {
      pinnedTierByProfile[profileName] = tier;
    } else {
      delete pinnedTierByProfile[profileName];
    }
  };

  const recordDebugDecision = (decision: RoutingDecision) => {
    // Clone before pushing — the cross-tier fallback branch mutates the live
    // `decision` reference in place.
    debugHistory = [...debugHistory, { ...decision }].slice(-MAX_DEBUG_HISTORY);
    if (debugEnabled && lastExtensionContext && !isExtensionContextDead) {
      // Priority order for the notification source label;
      // `getDecisionFlags` (ui.ts) accumulates all applicable flags into an
      // array for the widget — it is not a priority selector. The two
      // consumers intentionally diverge: the chain is single-winner
      // (one canonical source label per decision), the flag list is
      // exhaustive provenance (all applicable flags for the widget).
      let source: string;
      if (decision.isBudgetForced) source = 'budget';
      else if (decision.isVetoed) source = 'vetoed';
      else if (decision.isClassifier) source = 'classifier';
      else if (decision.isRuleMatched) source = 'rule';
      else if (decision.isFallback) source = 'fallback';
      else if (decision.isPinned) source = 'pin';
      else source = 'heuristic';
      const criterion =
        decision.isClassifier && decision.classifierCriterion
          ? `${decision.classifierCriterion}, `
          : '';
      const provenance =
        decision.isClassifier && decision.confidenceNumeric !== undefined
          ? ` (${criterion}confidence: ${decision.confidenceNumeric.toFixed(2)})`
          : decision.isClassifier && decision.confidence
            ? ` (${criterion}confidence: ${decision.confidence})`
            : '';
      // notify call line unchanged — provenance now carries the criterion:
      // `router → openai/gpt-4o-mini [low, classifier] (lookup, confidence: 0.97)`
      lastExtensionContext.ui.notify(
        `router → ${decision.targetProvider}/${decision.targetModelId} [${decision.tier}, ${source}]${provenance}`,
        'info',
      );
    }
  };

  const getThinkingOverride = (profileName: string, tier: RouterTier) => {
    return thinkingByProfile[profileName]?.[tier];
  };

  const clearDebugHistory = () => {
    debugHistory = [];
  };

  const persistState = () => {
    const state = buildPersistedState(
      routerEnabled,
      selectedProfile,
      pinnedTierByProfile,
      thinkingByProfile,
      debugEnabled,
      widgetEnabled,
      debugHistory,
      lastDecision,
      lastNonRouterModel,
      accumulatedCost,
      classifierCalibration,
    );
    const snapshot = JSON.stringify({
      ...state,
      timestamp: 0,
      lastDecision: state.lastDecision
        ? { ...state.lastDecision, timestamp: 0 }
        : undefined,
      debugHistory: state.debugHistory?.map((decision) => ({
        ...decision,
        timestamp: 0,
      })),
      classifierCalibration: state.classifierCalibration?.map((entry) => ({
        ...entry,
        timestamp: 0,
      })),
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    try {
      pi.appendEntry('router-state', state);
      lastPersistedSnapshot = snapshot;
    } catch {
      // ponytail: context stale after session replacement/reload.
      // State persistence to dead session — no-op.
    }
  };

  const actions = {
    persistState,
    syncPiThinkingLevel: setThinkingLevelInternally,
    clearDebugHistory,
    updateStatus: (ctx: ExtensionContext) =>
      updateStatus(
        ctx,
        routerEnabled,
        selectedProfile,
        pinnedTierByProfile,
        thinkingByProfile,
        lastDecision,
        lastNonRouterModel,
        accumulatedCost,
        widgetEnabled,
        currentConfig,
      ),
    reloadConfig: (
      ctx?: ExtensionContext,
      options?: { preserveDebug?: boolean },
    ) => {
      const loaded = loadRouterConfig(currentCwd);
      currentConfig = loaded.config;
      lastConfigWarnings = loaded.warnings;
      if (!options?.preserveDebug) {
        debugEnabled = currentConfig.debug ?? false;
      }
      selectedProfile = resolveProfileName(currentConfig, selectedProfile);
      actions.registerRouterProvider();
      if (ctx) {
        actions.updateStatus(ctx);
        if (lastConfigWarnings.length > 0) {
          ctx.ui.notify(
            `Router Configuration Warnings:\n${lastConfigWarnings.join('\n')}`,
            'warning',
          );
        }
      }
    },
    ensureValidActiveRouterProfile: async (ctx: ExtensionContext) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (currentConfig.profiles[ctx.model.id]) {
        selectedProfile = ctx.model.id;
        routerEnabled = true;
        return;
      }

      // The active router model's profile no longer exists in config
      ctx.ui.notify(
        `Router profile "${ctx.model.id}" is no longer configured.`,
        'warning',
      );
      routerEnabled = false;
      selectedProfile = undefined;
    },
    switchToRouterProfile: async (
      profileName: string,
      ctx: ExtensionContext,
      strict = true,
    ) => {
      if (!currentConfig.profiles[profileName]) {
        if (strict) {
          ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        }
        return false;
      }

      // Ensure the provider is registered with current capacities for this profile
      actions.registerRouterProvider();
      const routerModel = ctx.modelRegistry.find('router', profileName);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await setModelInternally(routerModel);
      if (!success) {
        if (!isExtensionContextDead) {
          ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        }
        return false;
      }
      selectedProfile = profileName;
      routerEnabled = true;
      persistState();
      if (!isExtensionContextDead) {
        actions.updateStatus(ctx);
      }
      return true;
    },
    registerRouterProvider: () => {
      registerRouterProvider(
        pi,
        {
          get lastRegisteredModels() {
            return lastRegisteredModels;
          },
          set lastRegisteredModels(v) {
            lastRegisteredModels = v;
          },
          get currentConfig() {
            return currentConfig;
          },
          get currentModelRegistry() {
            return currentModelRegistry;
          },
          set currentModelRegistry(v) {
            currentModelRegistry = v;
          },
          get lastExtensionContext() {
            return lastExtensionContext;
          },
          get isExtensionContextDead() {
            return isExtensionContextDead;
          },
          get selectedProfile() {
            return selectedProfile;
          },
          set selectedProfile(v) {
            selectedProfile = v;
          },
          get routerEnabled() {
            return routerEnabled;
          },
          set routerEnabled(v) {
            routerEnabled = v;
          },
          get lastDecision() {
            return lastDecision;
          },
          set lastDecision(v) {
            lastDecision = v;
          },
          thinkingByProfile,
          pinnedTierByProfile,
          get accumulatedCost() {
            return accumulatedCost;
          },
          set accumulatedCost(v) {
            accumulatedCost = v;
          },
        },
        {
          persistState,
          recordDebugDecision,
          getThinkingOverride,
          updateStatus: actions.updateStatus,
          syncPiThinkingLevel: setThinkingLevelInternally,
        },
      );
    },
  };

  actions.reloadConfig();

  const restoreStateFromSessionInner = async (ctx: ExtensionContext) => {
    actions.reloadConfig(ctx);

    routerEnabled = ctx.model?.provider === 'router';
    selectedProfile =
      ctx.model?.provider === 'router'
        ? resolveProfileName(currentConfig, ctx.model.id)
        : resolveProfileName(currentConfig, selectedProfile);
    // Clear in-place to keep references intact
    for (const key of Object.keys(pinnedTierByProfile)) {
      delete pinnedTierByProfile[key];
    }
    for (const key of Object.keys(thinkingByProfile)) {
      delete thinkingByProfile[key];
    }
    widgetEnabled = false;
    debugHistory = [];
    accumulatedCost = 0;
    lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : lastNonRouterModel;
    lastDecision = undefined;

    const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
    const savedState = entries
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'router-state',
      )
      .map((entry) => entry.data)
      .findLast((data) => isRouterPersistedState(data));

    if (isRouterPersistedState(savedState)) {
      selectedProfile = resolveProfileName(
        currentConfig,
        savedState.selectedProfile,
      );
      routerEnabled = savedState.enabled;
      if (savedState.pinByProfile) {
        Object.assign(pinnedTierByProfile, savedState.pinByProfile);
      }
      if (savedState.thinkingByProfile) {
        Object.assign(thinkingByProfile, savedState.thinkingByProfile);
      }
      if (savedState.pinTier && selectedProfile) {
        pinnedTierByProfile[selectedProfile] = savedState.pinTier;
      }
      debugEnabled = savedState.debugEnabled ?? debugEnabled;
      widgetEnabled = savedState.widgetEnabled ?? widgetEnabled;
      debugHistory = savedState.debugHistory
        ? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY)
        : [];
      lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
      accumulatedCost = savedState.accumulatedCost ?? 0;
      classifierCalibration = savedState.classifierCalibration
        ? [...savedState.classifierCalibration].slice(-MAX_CALIBRATION_ENTRIES)
        : [];
      // Q2: per-field sanitize — strip invalid optional fields, keep required.
      // If required fields were bad, isRouterPersistedState already rejected
      // the state and the consumer is skipped. `savedState.lastDecision` here
      // is guaranteed to be a valid object with valid required fields.
      lastDecision = sanitizeRoutingDecisionFields(savedState.lastDecision);
    }

    await actions.ensureValidActiveRouterProfile(ctx);

    if (routerEnabled && selectedProfile) {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await setModelInternally(routerModel);
        if (!success) {
          ctx.ui.notify(
            `Failed to restore router/${selectedProfile} after relaunch.`,
            'warning',
          );
          routerEnabled = false;
        } else if (lastDecision) {
          // Sync pi's thinking level display with the router's last decision
          setThinkingLevelInternally(lastDecision.thinking);
        }
      } else {
        ctx.ui.notify(
          `Unable to restore router/${selectedProfile}; model is unavailable.`,
          'warning',
        );
        routerEnabled = false;
        ctx.ui.setHiddenThinkingLabel?.();
      }
    } else {
      ctx.ui.setHiddenThinkingLabel?.();
    }

    persistState();
    actions.updateStatus(ctx);
  };

  // Full state restore is guarded: captureCtx (invoked by every event
  // handler above) has already secured the registry, so a failed restore
  // must not leave the router unusable — surface it and continue.
  // (Architecture review L0-03.)
  const restoreStateFromSession = async (ctx: ExtensionContext) => {
    try {
      await restoreStateFromSessionInner(ctx);
    } catch (error) {
      try {
        ctx.ui.notify(
          `Router state restore failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warning',
        );
      } catch {
        // stale ctx after session replacement — cannot notify
      }
    }
  };

  registerCommands(
    pi,
    {
      get currentConfig() {
        return currentConfig;
      },
      get routerEnabled() {
        return routerEnabled;
      },
      set routerEnabled(v) {
        routerEnabled = v;
      },
      get selectedProfile() {
        return selectedProfile;
      },
      set selectedProfile(v) {
        selectedProfile = v;
      },
      pinnedTierByProfile,
      thinkingByProfile,
      get lastDecision() {
        return lastDecision;
      },
      get lastNonRouterModel() {
        return lastNonRouterModel;
      },
      set lastNonRouterModel(v) {
        lastNonRouterModel = v;
      },
      get accumulatedCost() {
        return accumulatedCost;
      },
      get debugEnabled() {
        return debugEnabled;
      },
      set debugEnabled(v) {
        debugEnabled = v;
      },
      get widgetEnabled() {
        return widgetEnabled;
      },
      set widgetEnabled(v) {
        widgetEnabled = v;
      },
      get debugHistory() {
        return debugHistory;
      },
      get classifierCalibration() {
        return classifierCalibration;
      },
      set classifierCalibration(v) {
        classifierCalibration = v;
      },
      get lastConfigWarnings() {
        return lastConfigWarnings;
      },
    },
    actions,
  );

  // Capture points: every handler below runs captureCtx first. No single
  // event is guaranteed to precede the router's own streamSimple (compaction
  // and branch-summary call the stream function directly; before_provider_request
  // fires only inside the delegated inner request) — the provider's guard
  // falls back to the module-level registry when this closure never received
  // an event. (L0-01.)
  pi.on('before_provider_request', (_event, ctx) => {
    captureCtx(ctx);
  });

  // turn_start fires through the runner at the start of every turn, before
  // that turn's provider request (AgentSession._emitExtensionEvent →
  // runner.emit → createContext, agent-session.js:367-374) — including sessions
  // that never emitted session_start (reload without bindings). It is the
  // strongest per-turn capture anchor: it makes the serving closure's registry
  // exact instead of relying on the module fallback. Pure capture — no
  // behavioral gating (contrast model_select, whose isInitialized early-return
  // runs AFTER its captureCtx call; turn_start must not gate at all). (L0-01.)
  pi.on('turn_start', (_event, ctx) => {
    captureCtx(ctx);
  });

  // Death anchor: pi emits `session_shutdown` and awaits every handler
  // BEFORE it invalidates the ctx (pi core/agent-session-runtime.js
  // teardownCurrent). Flip the flag here so in-flight turns gate ctx reads
  // before the ctx dies. Pi skips the emit when no handler is registered —
  // registering here activates the path.
  pi.on('session_shutdown', () => {
    isExtensionContextDead = true;
    // Remove this closure from the module dispatcher so later router streams
    // (from OTHER sessions still alive in this process — e.g. the parent
    // after an in-process subagent is evicted by pi-subagents' 10-minute
    // cleanup timer) never resolve to a dead closure again.
    notifyClosureShutdown(pi);
  });

  pi.on('session_start', async (_event, ctx) => {
    captureCtx(ctx);
    isInitialized = true;
    await restoreStateFromSession(ctx);
    if (debugEnabled && !isExtensionContextDead) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`,
        'info',
      );
    }
  });

  pi.on('model_select', async (event, ctx) => {
    captureCtx(ctx);
    if (!isInitialized || isInternalModelSwitch) return;
    if (event.model.provider === 'router') {
      const profileName = resolveProfileName(currentConfig, event.model.id);
      if (!profileName) {
        ctx.ui.notify(`Unknown router profile: ${event.model.id}`, 'error');
        return;
      }

      // If the selected model has stale capacities (e.g. from the initial registration),
      // re-apply the model from the registry to force a TUI refresh.
      const registryModel = ctx.modelRegistry.find('router', profileName);
      if (
        registryModel &&
        (registryModel.contextWindow !== event.model.contextWindow ||
          registryModel.maxTokens !== event.model.maxTokens)
      ) {
        await setModelInternally(registryModel);
      }

      routerEnabled = true;
      selectedProfile = profileName;
    } else {
      routerEnabled = false;
      lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      if (!isExtensionContextDead) {
        ctx.ui.setHiddenThinkingLabel?.();
      }
    }
    persistState();
    if (!isExtensionContextDead) {
      actions.updateStatus(ctx);
    }
  });

  pi.on('turn_end', async (_event, ctx) => {
    captureCtx(ctx);
    if (routerEnabled && selectedProfile && ctx.model?.provider !== 'router') {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        await setModelInternally(routerModel);
      }
    }
    persistState();
    if (!isExtensionContextDead) {
      actions.updateStatus(ctx);
    }
  });

  pi.on('thinking_level_select', (event, ctx) => {
    captureCtx(ctx);
    if (!isInitialized || !routerEnabled || !selectedProfile) return;
    if (isInternalThinkingChange) return;

    // User changed pi's thinking level (e.g. via shift+tab).
    // Apply as an all-tier thinking override for the active router profile.
    if (!thinkingByProfile[selectedProfile]) {
      thinkingByProfile[selectedProfile] = {};
    }
    for (const t of ROUTER_TIERS) {
      thinkingByProfile[selectedProfile]![t] = event.level;
    }
    persistState();
    actions.updateStatus(ctx);
    if (event.level !== 'off') {
      const unsupported = getUnsupportedTiers(
        currentConfig.profiles[selectedProfile],
        ctx.modelRegistry,
      );
      if (unsupported.length > 0) {
        ctx.ui.notify(
          formatUnsupportedThinkingWarning('all', event.level, unsupported),
          'warning',
        );
      }
    }
  });
};

export default routerExtension;
