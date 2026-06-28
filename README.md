# pi-model-router

Intelligent per-turn model router extension for the [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Automatically selects between high, medium, and low-tier LLMs based on task intent, session budget, context size, and custom rules — with automatic fallbacks and phase awareness.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Per-Turn Routing**: Intelligently chooses between `high`, `medium`, and `low` tiers for every turn based on task intent and complexity.
- **Task-Aware Heuristics**: Detects planning vs. implementation vs. lightweight tasks using keyword analysis, word count, and conversation history.
- **Advanced Controls**: Includes built-in support for:
  - **LLM Intent Classifier**: Optional LLM-based classifier runs before heuristics when no pin or rule matches, categorizing intent for more accurate tier selection.
  - **Custom Rules**: Define keyword-based tier overrides for specific patterns (e.g., `deploy` → `high`).
  - **Cost Budgeting**: Set a session spend limit; high tier downgrades to medium once exceeded. When the downgraded tier isn't configured, a lower tier is chosen before a higher one (no silent re-promotion past the cap).
  - **Fallback Chains**: Per-tier `fallbacks` retried first; if all in-tier models fail, the router degrades across tiers (high → medium → low) before throwing.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation work.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile.
- **Persistent State**: Pins, profiles, costs, and debug history are remembered across agent restarts and conversation branches.

## Installation

### As a user

Install from npm:

```bash
pi install npm:@yeliu84/pi-model-router
```

### For development

Clone this repo and install from source:

```bash
pi install .
```

Or load directly for one run:

```bash
pi -e ./extensions/index.ts
```

## Configuration

Copy the example config to one of:

- `~/.pi/agent/model-router.json` (Global)
- `.pi/model-router.json` (Project-specific)

Both files are **merged**: global config acts as the base, and project-specific config deep-merges on top (per-profile, per-tier, per-field). This lets a project add profiles or override individual tiers without rewriting the entire global config.

### Complete Config Example

This example demonstrates every supported field. All fields except `profiles` are optional — a minimal config only needs a profile with at least one tier.

```json
{
  "debug": false,
  "classifierModel": {
    "model": "google/gemini-flash-latest",
    "thinking": "low"
  },
  "phaseBias": 0.5,
  "maxSessionBudget": 1.0,
  "models": {
    "gpt-pro": {
      "model": "openai/gpt-5.4-pro",
      "contextWindow": 256000,
      "maxTokens": 64000,
      "reasoning": true,
      "thinkingLevels": ["high", "medium", "low"]
    },
    "flash": {
      "model": "google/gemini-flash-latest",
      "contextWindow": 1048576
    },
    "nano": {
      "model": "openai/gpt-5.4-nano",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoning": false
    }
  },
  "rules": [
    {
      "matches": ["deploy", "production", "release"],
      "tier": "high",
      "reason": "Safety check for production tasks"
    },
    { "matches": "changelog", "tier": "low" }
  ],
  "profiles": {
    "auto": {
      "high": {
        "model": "gpt-pro",
        "thinking": "high",
        "fallbacks": ["anthropic/claude-3-5-sonnet-20241022"]
      },
      "medium": {
        "model": "flash",
        "thinking": "medium",
        "contextWindow": 200000,
        "maxTokens": 16384
      },
      "low": {
        "model": "nano",
        "thinking": "low",
        "reasoning": false,
        "thinkingLevels": ["low"]
      }
    }
  }
}
```

**Key points about this example:**

- **`models`**: Defines reusable aliases (`gpt-pro`, `flash`, `nano`). Aliases can be referenced anywhere a model ref is accepted — in tier `model`, tier `fallbacks`, and `classifierModel`.
- **`classifierModel`**: Can be a plain string (`"flash"`) or an object with a `thinking` level. Here it uses the object form to set the classifier's reasoning level.
- **`rules`**: Each rule matches a string or array of strings (substring match, case-insensitive). When multiple rules match, the highest tier wins. Rules are skipped when a tier is pinned.
- **`profiles.auto.high`**: Uses the `gpt-pro` alias and defines a same-tier `fallbacks` chain to a different provider (Anthropic).
- **`profiles.auto.medium`**: Overrides the alias's resolved `contextWindow` and `maxTokens` at the tier level.
- **`profiles.auto.low`**: Explicitly sets `reasoning: false` and restricts `thinkingLevels` to `low` only.
- **Minimal config**: If you only need basic routing, a config like this is sufficient:
  ```json
  {
    "profiles": {
      "auto": {
        "high": { "model": "openai/gpt-5.4-pro" },
        "low": { "model": "openai/gpt-5.4-nano" }
      }
    }
  }
  ```

### Configuration Fields

| Field                    | Description                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classifierModel`        | (Optional) Model used to categorize intent. Accepts either a model ref / alias string (`"google/gemini-flash-latest"`) or an object `{ "model": "alias-or-ref", "thinking": "off\|minimal\|low\|medium\|high\|xhigh" }`. If omitted, fast heuristics are used.                                                        |
| `maxSessionBudget`       | (Optional) USD budget for the session. Forces a lower tier once exceeded; respects the available tiers (no silent re-promotion).                                                                                                                                                                                      |
| `phaseBias`              | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`.                                                                                                                                                                                                                                     |
| `rules`                  | List of custom keyword rules. Each rule: `{ "matches": "string\|string[]", "tier": "high\|medium\|low", "reason"?: "string" }`. When multiple rules match, the highest tier wins. Skipped when a tier is pinned.                                                                                                      |
| `models`                 | (Optional) Map of model aliases to definitions: `{ "alias": { "model": "provider/id", "contextWindow"?: number, "maxTokens"?: number, "reasoning"?: boolean, "thinkingLevels"?: ThinkingLevel[] } }`. Aliases are usable wherever a model ref string is accepted (tier `model`, tier `fallbacks`, `classifierModel`). |
| `profiles`               | Map of profile definitions, each containing optional `high`, `medium`, and `low` tiers (at least one required).                                                                                                                                                                                                       |
| `profiles.<name>.<tier>` | Tier config: `{ "model": "alias-or-ref", "thinking"?: ThinkingLevel, "fallbacks"?: string[], "contextWindow"?: number, "maxTokens"?: number, "reasoning"?: boolean, "thinkingLevels"?: ThinkingLevel[] }`. `fallbacks` are tried in order before cross-tier degradation.                                              |
| `debug`                  | (Optional) Boolean. When `true`, auto-enables turn-by-turn routing notifications on every startup (equivalent to persisting `/router debug on` across restarts). Default `false`.                                                                                                                                     |

Where `ThinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

## Commands

| Command                           | Description                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/router`                         | Show detailed status, current profile, spend, and settings.                                                         |
| `/router status`                  | Alias for `/router` (show current status).                                                                          |
| `/router profile [name]`          | Switch to a profile or list available ones (enables router if off).                                                 |
| `/router pin <t\|a>`              | Pin a tier (high/medium/low/auto) for the active profile.                                                           |
| `/router fix <tier>`              | Correct the _last_ decision and pin that tier for the current profile.                                              |
| `/router thinking <level>`        | Override thinking level for all tiers (e.g. `/router thinking xhigh`). Not all tier models may support every level. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`).                                      |
| `/router disable`                 | Disable the router and switch back to the last non-router model.                                                    |
| `/router widget <on\|off>`        | Toggle the persistent state widget (supports `toggle`).                                                             |
| `/router debug <on\|off>`         | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`).                                     |
| `/router reload`                  | Hot-reload the configuration JSON.                                                                                  |
| `/router help`                    | Show usage help for all subcommands.                                                                                |
| `/router <profile>`               | Shortcut to enable a profile directly (e.g. `/router auto`).                                                        |
| `/router ?`                       | Alias for `/router help`.                                                                                           |

## Advanced Behaviors

The router performs several automatic adjustments that are invisible during normal use but are worth knowing about:

### Same-Tier Fallback (e.g. quota / rate-limit hit)

Every tier accepts a `fallbacks` array. When the primary model for a tier **fails** (rate limit, quota exhaustion, timeout, network error, etc.), the router automatically tries each fallback model **at the same tier** before considering a cross-tier downgrade. This means you can pair models from different providers at the same quality level.

Example: if Anthropic Opus hits its limit, fall back to GPT-5.5 Pro — both at the `high` tier:

```json
"profiles": {
  "auto": {
    "high": {
      "model": "anthropic/claude-opus",
      "thinking": "high",
      "fallbacks": ["openai/gpt-5.5-pro", "google/gemini-pro-latest"]
    }
  }
}
```

The retry order is:

1. **In-tier fallbacks first** — primary model, then each entry in `fallbacks` (same tier).
2. **Cross-tier downgrade** — only if all in-tier models fail, the router drops to the next lower tier (`high` → `medium` → `low`) and repeats the process.

This applies to any failure that occurs **before or during** streaming, including missing API keys, model-not-found, and mid-stream errors (if no content was received yet).

### Custom & OpenAI-Compatible Providers

The router works with **any** provider registered in pi's model registry — not just the built-in ones. If you use a custom OpenAI-compatible provider (e.g. via pi's manifest/`auto` AI settings, a self-hosted endpoint, or a proxy gateway), simply reference it using its registered `provider/model` name in your tier configs:

```json
"profiles": {
  "auto": {
    "high": {
      "model": "my-proxy/llama-3.1-405b",
      "fallbacks": ["openai/gpt-5.5-pro"]
    },
    "low": { "model": "auto/llama-3.1-8b" }
  }
}
```

The router resolves providers dynamically through `modelRegistry.find(provider, modelId)` at runtime — it doesn't hardcode any provider list. This means:

- **Manifest-based providers** (e.g. `auto/...`, `my-proxy/...`) work the same as built-in providers like `openai` or `anthropic`.
- **API keys & auth** are handled automatically by the registry's `getApiKeyAndHeaders()`, so whatever credentials you've configured in pi for that provider apply transparently.
- **Capabilities** (context window, max tokens, reasoning support) are read from the registry, falling back to your `models` alias definitions or hardcoded defaults.
- **Fallback chains can mix providers freely** — e.g. a self-hosted Llama as primary with an OpenAI model as fallback at the same tier.

> **Note**: The only restriction is that you cannot point a tier's `model` or `fallbacks` back at the `router` provider itself (e.g. `router/auto`) — these are skipped to prevent infinite delegation loops.

### Image-Attachment Tier Promotion

If you attach an image and the routed tier's model (and all its fallbacks) does not support image input, the router **automatically promotes you to a higher tier** whose model does support images. This prevents errors when vision-capable models are only configured at higher tiers.

### Google Thought-Signature Continuation Guard

Google models with thinking/reasoning enabled require the **same model** to be used across a multi-turn tool-call sequence (the API rejects a "thought-signature replay" otherwise). The router detects these continuations and **reuses the exact same model** from the previous turn, overriding what the classifier or heuristics would have chosen. You may notice the model "sticks" during tool-heavy Google sessions — this is intentional.

### Automatic Context Truncation

The router reports the **maximum** context window and output token limit across all tiers to pi (so pi doesn't prematurely truncate). However, when the router delegates to a smaller-tier model, it **automatically truncates the conversation** to fit that model's context window. Truncation removes the oldest messages first while always preserving the system prompt and the latest user message.

### Turn-End Auto-Restore

If the router is enabled but a non-router model somehow got selected mid-conversation, the extension **automatically switches back** to the active router profile at the end of every turn.

### `reasoning` Defaults to `true`

When a model definition or tier config **omits** the `reasoning` field, the router **assumes the model supports reasoning**. Only an explicit `"reasoning": false` disables reasoning and restricts the available thinking levels.

### Configuration Warnings

If your config contains invalid entries (bad model refs, missing fields, invalid thinking levels, etc.), the router emits warnings at startup. These also appear in `/router status` output under a ⚠️ **Configuration Warnings** section.

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
