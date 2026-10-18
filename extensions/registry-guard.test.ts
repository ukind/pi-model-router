import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { registerApiProvider } from '@earendil-works/pi-ai/compat';
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai';

// pi-coding-agent 1.3.0 layout: pi-ai is hoisted (no nested copy inside
// pi-coding-agent), and providers registered via ModelRegistry.registerProvider
// dispatch through ModelRuntime's provider-composer (extension.streamSimple),
// not through compat's process-global api-map. The outer dispatch below
// therefore goes through the registry itself. The fake api is additionally
// registered into compat so the router's delegated inner call (compat
// streamSimple in provider.ts) resolves it.

// Drives the REAL ordering end to end: DefaultResourceLoader (factory cache
// via loadExtensionsCached) → ExtensionRunner.bindCore flush → real compat
// api-map dispatch → the router's own streamSimple, with session_start
// deliberately omitted. The review-mandated repro, on real machinery.
//
// Hermeticity (no vi.mock — the extension loads through pi's jiti, whose
// module graph vitest cannot mock): PI_CODING_AGENT_DIR points getAgentDir()
// at an empty tmp dir, and the router profile is written to that dir's
// model-router.json — the GLOBAL config path, read at factory time. The
// project path (process.cwd()/.pi/model-router.json) is never relied on
// (index.ts seeds currentCwd = process.cwd() at factory time).
// Per-test tmp dirs also rotate the extension factory cache (cwd change →
// clearExtensionCache → fresh module instance per test), so no cross-test
// module state.

const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';
const EXTENSION_PATH = fileURLToPath(new URL('./index.ts', import.meta.url));

type ExtensionsResult = ReturnType<DefaultResourceLoader['getExtensions']>;
type RouterErrorEvent = Extract<AssistantMessageEvent, { type: 'error' }>;
type ProviderConfig = Parameters<ModelRegistry['registerProvider']>[1];

const fakeStreamSimple = async function* () {
  yield { type: 'text_delta' as const, delta: 'routed-ok' };
  yield {
    type: 'done' as const,
    message: { usage: { cost: { total: 0 } }, stopReason: 'stop' },
  };
};

const registerFakeProvider = (registry: ModelRegistry) => {
  registry.registerProvider('fake-provider', {
    baseUrl: 'fake://local',
    apiKey: 'fake-key',
    api: 'fake-api',
    models: [{ id: 'tiny' }],
    streamSimple: fakeStreamSimple,
  } as unknown as ProviderConfig);
  // The router's delegated inner call resolves through the extension's own
  // hoisted compat instance (see the dual-instance note above), so the fake
  // api must be registered there too.
  registerApiProvider(
    {
      api: 'fake-api',
      stream: fakeStreamSimple,
      streamSimple: fakeStreamSimple,
    } as unknown as Parameters<typeof registerApiProvider>[0],
    'test:fake-provider',
  );
};

// A "world" = tmp agent dir (holds the router profile as the GLOBAL config)
// + tmp cwd (rotates the factory cache) + shared in-memory registry. Loading
// two extensions-results over ONE world is the second-in-process-session
// scenario: the second loader hits the factory cache (same cwd) and gets a
// NEW closure over the SAME module instance.
const worlds: Array<{ cwd: string; agentDir: string }> = [];
const buildWorld = async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-guard-cwd-'));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pi-router-guard-agent-'),
  );
  process.env[ENV_AGENT_DIR] = agentDir;
  fs.writeFileSync(
    path.join(agentDir, 'model-router.json'),
    JSON.stringify({
      profiles: {
        balanced: {
          high: { model: 'fake-provider/tiny' },
          medium: { model: 'fake-provider/tiny' },
          low: { model: 'fake-provider/tiny' },
        },
      },
    }),
  );
  // pi-coding-agent 1.3.0 removed ModelRegistry.inMemory and the
  // AuthStorage exports; ModelRuntime.create with modelsPath: null and no
  // refresh stays hermetic (in-memory models store, agentDir-scoped auth).
  const registry = new ModelRegistry(
    await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null }),
  );
  registerFakeProvider(registry);
  const world = { cwd, agentDir, registry };
  worlds.push(world);
  return world;
};

const loadExtensionsFor = async (world: {
  cwd: string;
  agentDir: string;
}): Promise<ExtensionsResult> => {
  const settingsManager = SettingsManager.create(world.cwd, world.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: world.cwd,
    agentDir: world.agentDir,
    settingsManager,
    additionalExtensionPaths: [EXTENSION_PATH],
  });
  await loader.reload();
  return loader.getExtensions();
};

const bindRunner = (
  world: { cwd: string; registry: ModelRegistry },
  extensionsResult: ExtensionsResult,
) => {
  const appendEntry = vi.fn();
  const runner = new ExtensionRunner(
    extensionsResult.extensions,
    extensionsResult.runtime,
    world.cwd,
    // sessionManager: no handler on this code path reads it.
    {} as ConstructorParameters<typeof ExtensionRunner>[3],
    world.registry,
  );
  runner.bindCore(
    {
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry,
      setSessionName: vi.fn(),
      getSessionName: vi.fn(),
      setLabel: vi.fn(),
      getActiveTools: vi.fn(),
      getAllTools: vi.fn(),
      getSettings: vi.fn(),
      setActiveTools: vi.fn(),
      refreshTools: vi.fn(),
      getCommands: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      getThinkingLevel: vi.fn(),
      setThinkingLevel: vi.fn(),
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => '',
      getSystemPromptOptions: () => ({ cwd: world.cwd }),
    },
  );
  return { runner, appendEntry };
};

const routerModel = (registry: ModelRegistry) => {
  const model = registry.find('router', 'balanced');
  expect(model).toBeDefined();
  return model!;
};

const collectStream = async (
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const errorEvents = (events: AssistantMessageEvent[]): RouterErrorEvent[] =>
  events.filter((e): e is RouterErrorEvent => e.type === 'error');

const streamContext = () => ({ messages: [] }) as unknown as Context;

describe('registry guard regression (real resource loader + runner + compat dispatch)', () => {
  let previousAgentDir: string | undefined;
  let consoleErrorSpy: Mock;

  beforeAll(() => {
    previousAgentDir = process.env[ENV_AGENT_DIR];
  });

  afterAll(() => {
    if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousAgentDir;
    for (const world of worlds) {
      fs.rmSync(world.cwd, { recursive: true, force: true });
      fs.rmSync(world.agentDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes the guard error and a router-diagnostic entry when no capture ever happened', async () => {
    const world = await buildWorld();
    const { appendEntry } = bindRunner(world, await loadExtensionsFor(world));
    // NO events delivered — the residual-window negative control.

    const events = await collectStream(
      world.registry.streamSimple(routerModel(world.registry), streamContext()),
    );

    const errors = errorEvents(events);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].error.errorMessage).toContain('no model registry');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('registry guard FAILED'),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      'router-diagnostic',
      expect.objectContaining({ type: 'registry-guard' }),
    );
  });

  it('recovers via the module fallback when the serving closure never received an event', async () => {
    const world = await buildWorld();

    // Session 1: factory executes (closure C1, fresh module instance), the
    // flush registers it, and ONE capture event lands — session_start is
    // deliberately omitted (the review-mandated ordering).
    const first = bindRunner(world, await loadExtensionsFor(world));
    await first.runner.emitBeforeProviderRequest({});

    // Session 2 over the same world: the loader hits the factory cache → a
    // NEW closure over the SAME module instance; the flush OVERWRITES the
    // compat api-map entry. ZERO events reach this closure.
    bindRunner(world, await loadExtensionsFor(world));

    // The stream dispatches through the registry to the LAST registered
    // closure, which never captured. The guard must recover via the module
    // fallback
    // (written by C1's capture, shared through the cached module) and
    // delegate end-to-end through the fake provider. The write-back also
    // runs against the REAL state bag — a getter-only bag would throw.
    const events = await collectStream(
      world.registry.streamSimple(routerModel(world.registry), streamContext()),
    );

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(errorEvents(events).length).toBe(0);
  });

  it('captures on turn_start through the real runner emit path', async () => {
    const world = await buildWorld();
    const { runner } = bindRunner(world, await loadExtensionsFor(world));

    await runner.emit({ type: 'turn_start', turnIndex: 0, timestamp: 0 });

    const events = await collectStream(
      world.registry.streamSimple(routerModel(world.registry), streamContext()),
    );
    expect(errorEvents(events).length).toBe(0);
  });
});