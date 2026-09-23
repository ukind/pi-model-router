---
date: 2026-09-23T16:05:45+0700
topic: "add Jev (typesafe.ai System One) as the model classifier backend"
tags: [acceptance]
status: ready
item_count: 6
items:
  - id: a1
    statement: "The router accepts Jev (typesafe.ai) as the configured model classifier backend."
    command: "npx vitest run extensions/config.test.ts"
    expect: "The config suite exits 0 and a Jev classifier configuration loads without a warning."
  - id: a2
    statement: "The Jev backend sends classification requests to the documented System One endpoint with the jev-latest model."
    command: "grep -rFq \"api.typesafe.ai/v1/systemone\" extensions/ && grep -rFq \"jev-latest\" extensions/"
    expect: "The extension source targets the documented endpoint and model id."
  - id: a3
    statement: "The classifier authenticates with the API key from the goal, read from configuration or the environment and not from source."
    command: "grep -rFq \"TYPESAFE_API_KEY\" extensions/ && ! grep -rEq \"apikey_[0-9a-f]{16,}\" extensions/ README.md model-router.example.json docs/"
    expect: "The key comes from an environment or config source, and no key literal is present in source or documentation."
  - id: a4
    statement: "A Jev answer resolves to tier high, medium, or low for the turn."
    command: "npx vitest run extensions/routing.test.ts"
    expect: "The classifier suite exits 0 and maps a Jev answer to a router tier."
  - id: a5
    statement: "The router runs the Jev classifier for a turn when Jev is the configured backend."
    command: "npx vitest run extensions/provider.test.ts"
    expect: "The provider suite exits 0 and the classifier runs against the configured Jev backend."
  - id: a6
    statement: "The example configuration and the README show how to select the Jev classifier backend."
    command: "grep -rFiq \"jev\" model-router.example.json && grep -rFiq \"jev\" README.md"
    expect: "Both files name the Jev classifier backend."
---

# Acceptance Inventory: Add Jev (typesafe.ai System One) as the Model Classifier

Derived from the verbatim goal (`.rpiv/artifacts/goal/goal-2026-09-23T08-52-03-414Z.md`). The
goal is one line: add Jev from typesafe.ai for the model classifier, with an API key. Items
enumerate that ask. The evidence commands are future-tense. Validate runs them against the
finished tree.

## Items

### a1: The router accepts Jev (typesafe.ai) as the configured model classifier backend.
**Evidence**: `npx vitest run extensions/config.test.ts` — The config suite exits 0 and a Jev classifier configuration loads without a warning.

### a2: The Jev backend sends classification requests to the documented System One endpoint with the `jev-latest` model.
**Evidence**: `grep -rFq "api.typesafe.ai/v1/systemone" extensions/ && grep -rFq "jev-latest" extensions/` — The extension source targets the documented endpoint and model id.

### a3: The classifier authenticates with the API key from the goal, read from configuration or the environment and not from source.
**Evidence**: `grep -rFq "TYPESAFE_API_KEY" extensions/ && ! grep -rEq "apikey_[0-9a-f]{16,}" extensions/ README.md model-router.example.json docs/` — The key comes from an environment or config source, and no key literal is present in source or documentation.

### a4: A Jev answer resolves to tier `high`, `medium`, or `low` for the turn.
**Evidence**: `npx vitest run extensions/routing.test.ts` — The classifier suite exits 0 and maps a Jev answer to a router tier.

### a5: The router runs the Jev classifier for a turn when Jev is the configured backend.
**Evidence**: `npx vitest run extensions/provider.test.ts` — The provider suite exits 0 and the classifier runs against the configured Jev backend.

### a6: The example configuration and the README show how to select the Jev classifier backend.
**Evidence**: `grep -rFiq "jev" model-router.example.json && grep -rFiq "jev" README.md` — Both files name the Jev classifier backend.
