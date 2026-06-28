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

### Basic Config Shape

```json
{
  "classifierModel": "google/gemini-flash-latest",
  "maxSessionBudget": 1.0,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "low" }
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

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
