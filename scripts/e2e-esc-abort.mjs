#!/usr/bin/env node
// ESC-abort poison e2e — two scenarios against the real global pi (RPC mode).
//
// Scenario 1 (baseline abort): control turn → abort at ~50% of the control
//   turn's latency (untargeted mid-turn window) → post-abort probe →
//   fresh-process recovery probe.
// Scenario 2 (replacement precondition): fresh spawn → control turn →
//   new_session → set_model → abort mid-turn → probe turn.
//
// Protocol facts (pi 0.84.3, dist/modes/rpc/rpc-mode.js): requests are
// {id, type, ...}; responses {id, type:'response', command, success, data?};
// session events stream through as-is; extension notify surfaces as
// extension_ui_request {method:'notify'} with NO reply needed, while
// select/confirm/input dialogs DO need extension_ui_response replies. The
// prompt command's response fires at preflight — turn completion is detected
// by get_state polling (isStreaming false + messageCount advanced).
//
// Sandbox: a temp PI_CODING_AGENT_DIR holding a copy of your models.json
// (inline API keys carry over) plus a generated model-router.json. Your real
// agent dir is read for models.json and nothing else; sessions live in the
// sandbox. The repo extension is loaded via -e <repo>/extensions/index.ts.
//
// Usage:
//   PI_MODEL_ROUTER_E2E_TARGET=x-ai/grok-4-fast node scripts/e2e-esc-abort.mjs
//   PI_MODEL_ROUTER_E2E_KEEP=1  → keep the sandbox directory for inspection.
// Exit 0: every turn completed with an interpretable shape (poisoned or
// healthy are both findings). Exit 1: harness/protocol failure.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_VERSION_PREFIX = '0.84.';
const CLASSIFIER_MODEL = 'ollama-cloud/nemotron-3-nano:30b';
const CANDIDATE_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = CANDIDATE_TIMEOUT_MS + 120_000;
const BEACON_TIMEOUT_MS = 60_000;
const RPC_SEND_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const PROMPT_CONTROL =
  'Summarize the tradeoffs between REST and GraphQL for a small team, then recommend one.';
const PROMPT_PROBE =
  'Name three practical benefits of writing automated tests, with one sentence each.';

const TARGET = process.env.PI_MODEL_ROUTER_E2E_TARGET;
if (!TARGET || !TARGET.includes('/')) {
  console.error(
    'PI_MODEL_ROUTER_E2E_TARGET must be set to a provider/model ref, e.g. x-ai/grok-4-fast',
  );
  process.exit(1);
}

const IS_WIN = process.platform === 'win32';
// Repo paths must not contain spaces: Windows spawns pi through cmd.exe
// (shell mode) and the args are passed unquoted.
const EXTENSION_ENTRY = fileURLToPath(
  new URL('../extensions/index.ts', import.meta.url),
);
const SOURCE_MODELS_JSON = join(homedir(), '.pi', 'agent', 'models.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── pi resolution + version-skew guard ─────────────────────────────────────
const piCommand = () => (IS_WIN ? 'pi.cmd' : 'pi');

const runPiCapture = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(piCommand(), args, { shell: IS_WIN });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });

// ── sandbox ────────────────────────────────────────────────────────────────
const makeSandbox = () => {
  if (!existsSync(SOURCE_MODELS_JSON)) {
    throw new Error(`models.json not found at ${SOURCE_MODELS_JSON}`);
  }
  const root = join(
    tmpdir(),
    `pi-router-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const agentDir = join(root, 'agentdir');
  const workspace = join(root, 'workspace');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  copyFileSync(SOURCE_MODELS_JSON, join(agentDir, 'models.json'));
  writeFileSync(
    join(agentDir, 'model-router.json'),
    JSON.stringify(
      {
        debug: true,
        classifierModel: { model: CLASSIFIER_MODEL, thinking: 'high' },
        candidateTimeoutMs: CANDIDATE_TIMEOUT_MS,
        // Every tier delegates to the same target so any routing outcome is
        // comparable across turns.
        profiles: {
          auto: {
            high: { model: TARGET },
            medium: { model: TARGET },
            low: { model: TARGET },
          },
        },
      },
      null,
      2,
    ),
  );
  return { root, agentDir, workspace };
};

// ── RPC client ─────────────────────────────────────────────────────────────
class RpcClient {
  constructor(agentDir, workspace) {
    this.pending = new Map();
    this.notifies = [];
    this.events = [];
    this.dialogs = [];
    this.uiRequests = [];
    this.closed = false;
    this.spawnError = null;
    this.child = spawn(
      piCommand(),
      ['--mode', 'rpc', '-e', EXTENSION_ENTRY],
      {
        cwd: workspace,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        shell: IS_WIN,
      },
    );
    this.exitPromise = new Promise((resolve) => {
      this.child.on('close', resolve);
    });
    this.child.on('error', (err) => {
      this.spawnError = err;
    });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) =>
      process.stderr.write(`[pi] ${chunk}`),
    );
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'response') {
      const settle = this.pending.get(msg.id);
      if (settle) {
        this.pending.delete(msg.id);
        settle(msg);
      }
      return;
    }
    if (msg.type === 'extension_ui_request') {
      if (msg.method === 'notify') {
        this.notifies.push({
          message: msg.message,
          notifyType: msg.notifyType,
        });
        return;
      }
      // select/confirm/input/editor need a reply or the session hangs;
      // cancelled resolves select/input/editor to undefined, confirm to
      // false. Fire-and-forget ui requests (setStatus, setTitle, setWidget,
      // set_editor_text) need no reply — counted, never answered.
      if (
        msg.method === 'select' ||
        msg.method === 'confirm' ||
        msg.method === 'input' ||
        msg.method === 'editor'
      ) {
        this.dialogs.push(msg.method);
        this.child.stdin.write(
          `${JSON.stringify({ type: 'extension_ui_response', id: msg.id, cancelled: true })}\n`,
        );
      } else {
        this.uiRequests.push(msg.method);
      }
      return;
    }
    this.events.push(msg);
  }

  send(type, extra = {}) {
    if (this.spawnError) throw this.spawnError;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`rpc send timeout: ${type}`));
        }
      }, RPC_SEND_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end(); // rpc-mode shuts down on stdin end
    const exited = await Promise.race([
      this.exitPromise,
      sleep(5_000).then(() => false),
    ]);
    if (exited === false && IS_WIN && this.child.pid) {
      // cmd.exe wrappers may not propagate signals on Windows — kill the tree.
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
      await Promise.race([this.exitPromise, sleep(3_000)]);
    }
  }
}

// ── session helpers ────────────────────────────────────────────────────────
const getState = async (rpc) => (await rpc.send('get_state')).data;

const beaconCount = (rpc) =>
  rpc.notifies.filter((n) =>
    n.message.startsWith('Router initialized with profiles:'),
  ).length;

const waitFor = async (label, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(POLL_MS);
  }
};

const selectRouter = async (rpc) => {
  const res = await rpc.send('set_model', {
    provider: 'router',
    modelId: 'auto',
  });
  if (!res.success) {
    throw new Error(
      `set_model router/auto failed: ${res.error} (extension did not register — check [pi] stderr above)`,
    );
  }
  const state = await getState(rpc);
  if (state.model?.provider !== 'router') {
    throw new Error(
      `get_state.model.provider=${state.model?.provider}, expected 'router'`,
    );
  }
};

const runTurn = async (rpc, label, promptText, { abortAfterMs } = {}) => {
  if (rpc.spawnError) throw rpc.spawnError;
  const notifyStart = rpc.notifies.length;
  const before = await getState(rpc);
  const count0 = before.messageCount;
  const tPrompt = Date.now();
  const promptRes = await rpc.send('prompt', { message: promptText });
  if (!promptRes.success) {
    throw new Error(`prompt rejected on ${label}: ${promptRes.error}`);
  }

  if (abortAfterMs !== undefined) {
    await sleep(abortAfterMs);
    const abortRes = await rpc.send('abort');
    if (!abortRes.success) {
      throw new Error(`abort failed on ${label}: ${abortRes.error}`);
    }
  }

  let decisionLatencyMs = null;
  const settle = await waitFor(
    `${label} settle`,
    async () => {
      if (decisionLatencyMs === null) {
        const arrived = rpc.notifies
          .slice(notifyStart)
          .some((n) => n.message.startsWith('router → '));
        if (arrived) decisionLatencyMs = Date.now() - tPrompt;
      }
      const s = await getState(rpc);
      // A turn adds the user message AND the assistant message. Requiring
      // both to have landed closes the race where only the user message is
      // in and the row would read the previous turn's assistant message.
      return !s.isStreaming && s.messageCount >= count0 + 2 ? s : null;
    },
    TURN_TIMEOUT_MS,
  );
  await sleep(300); // let message_end + persistence land

  const messages = (await rpc.send('get_messages')).data.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant');
  const entries = (await rpc.send('get_entries')).data.entries;
  const routerStateCount = entries.filter(
    (e) => e.type === 'custom' && e.customType === 'router-state',
  ).length;
  const turnNotifies = rpc.notifies
    .slice(notifyStart)
    .map((n) => n.message);
  return {
    label,
    provider: lastAssistant?.provider ?? null,
    stopReason: lastAssistant?.stopReason ?? null,
    cost: lastAssistant?.usage?.cost?.total ?? null,
    contentChars: (lastAssistant?.content ?? []).reduce(
      (sum, part) => sum + (part.type === 'text' ? part.text.length : 0),
      0,
    ),
    messageCount: settle.messageCount,
    routerStateCount,
    decisionLine: turnNotifies.find((m) => m.startsWith('router → ')) ?? null,
    gateLines: turnNotifies.filter((m) => m.startsWith('router[abort]')),
    decisionLatencyMs,
  };
};

const spawnRouted = async (sandbox) => {
  const rpc = new RpcClient(sandbox.agentDir, sandbox.workspace);
  await waitFor(
    'readiness beacon (Router initialized with profiles: …)',
    async () => {
      if (rpc.spawnError) throw rpc.spawnError;
      return beaconCount(rpc) > 0;
    },
    BEACON_TIMEOUT_MS,
  );
  await selectRouter(rpc);
  return rpc;
};

const scenarioBaseline = async (sandbox) => {
  const turns = [];
  const rpc = await spawnRouted(sandbox);
  try {
    turns.push(await runTurn(rpc, 'S1 control', PROMPT_CONTROL));
    // decisionLatencyMs is prompt → 'router → ' notify = FULL-turn latency
    // (that notify fires after the delegated stream resolves), so the abort
    // lands somewhere mid-turn — not pinned to the classifier phase.
    const abortDelay = Math.max(
      500,
      Math.floor((turns[0].decisionLatencyMs ?? 4_000) / 2),
    );
    turns.push(
      await runTurn(rpc, 'S1 abort (mid-turn)', PROMPT_CONTROL, {
        abortAfterMs: abortDelay,
      }),
    );
    turns.push(await runTurn(rpc, 'S1 probe (poisoned?)', PROMPT_PROBE));
  } finally {
    await rpc.close();
  }
  // Fresh-process recovery probe (same sandbox, new session): isolates any
  // poison to the previous process — mirrors the /reload workaround.
  const fresh = await spawnRouted(sandbox);
  try {
    turns.push(
      await runTurn(fresh, 'S1 recovery (fresh process)', PROMPT_PROBE),
    );
  } finally {
    await fresh.close();
  }
  return turns;
};

const scenarioReplacement = async (sandbox) => {
  const turns = [];
  const rpc = await spawnRouted(sandbox);
  try {
    turns.push(await runTurn(rpc, 'S2 control', PROMPT_CONTROL));
    const abortDelay = Math.max(
      500,
      Math.floor((turns[0].decisionLatencyMs ?? 4_000) / 2),
    );

    // The precondition under test: replace the session, like the subagent-era
    // replacement in the bug session, then re-select the router profile.
    const ns = await rpc.send('new_session');
    if (!ns.success) throw new Error(`new_session failed: ${ns.error}`);
    const beaconsBefore = beaconCount(rpc);
    await waitFor(
      'post-replacement beacon',
      async () => {
        if (rpc.spawnError) throw rpc.spawnError;
        return beaconCount(rpc) > beaconsBefore;
      },
      BEACON_TIMEOUT_MS,
    );
    await selectRouter(rpc);

    turns.push(
      await runTurn(rpc, 'S2 abort (post-replacement)', PROMPT_CONTROL, {
        abortAfterMs: abortDelay,
      }),
    );
    turns.push(await runTurn(rpc, 'S2 probe (poisoned?)', PROMPT_PROBE));
  } finally {
    await rpc.close();
  }
  return turns;
};

const INTERPRETATION = `Interpretation (research Open Questions 1-3; "gate line" = router[abort] … notify):
  OQ1 — which exit fired: a captured gate line names it directly.
    gate1 dead=true        ⇒ gate 1 tripped on the dead-flag operand.
    gate4 catch stale=true ⇒ the catch's stale-ctx arm (post-classifier sync step).
  OQ2 — what ESC added: abort turn shows a gate line ⇒ the notify plane was
    still alive after the abort (per-event ctxs stayed live). Abort turn ended
    aborted with NO gate line while the beacon proved debug on ⇒ the extension
    egress plane was already dead.
  OQ3 — what broke appendEntry: routerStateEntries stops advancing across
    healthy turns (per session) ⇒ the silent-persistence signature; inspect
    the sandbox session file when PI_MODEL_ROUTER_E2E_KEEP=1.
  Precondition: probe poisoned in S1 ⇒ a plain ESC abort suffices (pi bug).
    Probe poisoned only in S2 ⇒ replacement is the required precondition.
    Probe healthy in both ⇒ this harness cannot reach the wild signature; the
    two-turn unit guard + in-the-wild gate lines carry the rest.`;

const printReport = (turns) => {
  console.log('\n══════════ e2e report ══════════');
  for (const t of turns) {
    console.log(`\n${t.label}`);
    console.log(
      `  provider=${t.provider} stopReason=${t.stopReason} cost=${t.cost ?? '—'} contentChars=${t.contentChars}`,
    );
    console.log(
      `  routerStateEntries=${t.routerStateCount} decision=${t.decisionLine ?? '(none)'}`,
    );
    for (const line of t.gateLines) console.log(`  GATE LINE: ${line}`);
  }
  console.log(`\n${INTERPRETATION}`);
};

const main = async () => {
  let version;
  try {
    version = await runPiCapture(['--version']);
  } catch (err) {
    console.error(`pi not found on PATH (${err.message})`);
    process.exit(1);
  }
  if (!version.startsWith(PI_VERSION_PREFIX)) {
    console.error(
      `pi on PATH is "${version}" — this harness targets ${PI_VERSION_PREFIX}x`,
    );
    process.exit(1);
  }
  console.log(
    `pi ${version} OK; target=${TARGET}; classifier=${CLASSIFIER_MODEL}`,
  );

  const sandbox = makeSandbox();
  console.log(`sandbox: ${sandbox.root}`);
  const turns = [];
  let failed = false;
  try {
    turns.push(...(await scenarioBaseline(sandbox)));
    turns.push(...(await scenarioReplacement(sandbox)));
  } catch (err) {
    console.error(`\n[harness] ${err.message}`);
    failed = true;
  } finally {
    printReport(turns);
    if (process.env.PI_MODEL_ROUTER_E2E_KEEP) {
      console.log(`\nsandbox kept: ${sandbox.root}`);
    } else {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error(`[harness] unexpected: ${err?.stack ?? err}`);
  process.exit(1);
});
