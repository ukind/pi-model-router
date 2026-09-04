---
date: 2026-08-29T11:37:58+0700
author: Yogiswara Utama
commit: 524afdec
branch: main
repository: pi-model-router
topic: 'scan external tier-classifier / LLM-routing approaches'
tags: [research, classifier, routing, tiers, external-scan, benchmarks]
status: ready
last_updated: 2026-08-29T11:37:58+0700
last_updated_by: Yogiswara Utama
---

# Research: External Scan — Tier-Classifier / LLM-Routing Approaches

Companion to `2026-07-21_19-14-23_classifier-routing-accuracy.md` (internal audit). That doc found our gaps; this one reports how external systems classify and route, with evidence.

Scope note: dates are publication dates from the source. "Measured" = benchmark/eval numbers from papers or vendor benchmark tables. "Vendor claim" = unverified marketing. Current as of access (Aug 2026 docs where noted).

## 1. RouteLLM (LMSYS / UC Berkeley / Anyscale — arXiv 2406.18665, Jun 2024; ICLR 2025; blog 2024-07-01)

- **Signal:** query text only. Model pair fixed in advance (GPT-4 vs Mixtral-8x7B in evals). Training signal: Chatbot Arena human preference votes (win/loss/tie per model pair).
- **Mechanism:** four trained routers compared: (1) similarity-weighted (SW) ranking — BERT-embedding cosine similarity to training queries + weighted Elo; (2) matrix factorization — learned query/user vectors predicting win probability; (3) BERT classifier; (4) causal LLM classifier. All output a probability that the strong model wins; route to strong model if p > threshold.
- **Granularity:** binary strong-vs-weak, per query. Single LLM call — explicitly designed against multi-LLM latency (contrasts FrugalGPT/AutoMix in their related-work).
- **Confidence:** continuous win-probability + a tunable threshold that sweeps the cost/quality curve. Metrics: CPT (fraction of strong-model calls to hit a performance target) and APGR (average performance gain recovered).
- **Fallback:** no per-request fallback; evaluation framing is a curve, not a point.
- **Feedback loop:** offline — routers trained on preference data; data augmentation (LLM-judge labels or ~1.5k golden labels, <2% of training data) flipped BERT router from APGR **-21.8%** to **+50.2%** vs random (measured, MT Bench). High-capacity classifiers are near-random in low-data regimes without augmentation.
- **Results (measured):** ≥2x cost reduction at equal quality; 95% of GPT-4 performance with 85%/45%/35% cost cuts on MT Bench/MMLU/GSM8K; generalizes to unseen model pairs (Claude 3 Opus vs Llama-3-8B) without retraining; beat Martian and Unify routers at equal quality for >40% less cost.
- **Cold start/latency:** needs preference data (they augment); SW/MF routers are the strongest cheap options pre-augmentation; BERT router is small, causal LLM router is the heaviest.

## 2. Hybrid LLM (ICLR 2024, arXiv 2404.14618, Microsoft/UBC)

- **Signal:** query text; router trained on synthetic preference labels (BARTScore) from MixInstruct.
- **Mechanism:** BERT-based router predicts the quality gap between small and large model; routes to small when predicted gap ≤ 0 at the desired quality level. The **desired quality level is a runtime parameter**, not a fixed threshold.
- **Granularity:** binary; also a cascade variant.
- **Confidence:** ensembles (deep ensembles + SAM fine-tuning) to get uncertainty on the router itself; cost-advantage vs quality-drop tradeoff measured.
- **Results (measured):** up to 40% fewer large-model calls with no quality drop (22% fewer with <1% BART-score drop on Llama-2-13B vs GPT-3.5).
- **Feedback:** none online; retraining with new labels.

## 3. Model cascades

**FrugalGPT (Stanford, arXiv 2305.05176, May 2023; TMLR 2024)**
- **Signal:** the *generated answer* at each cascade step, not the prompt.
- **Mechanism:** learned scoring function (DistilBERT regressor) judges answer reliability; accept if score > per-step threshold, else escalate. Cascade order and thresholds jointly learned (e.g., GPT-J @ 0.96 → J1-L @ 0.37 → GPT-4).
- **Granularity:** multi-tier by construction (cascade depth).
- **Confidence:** continuous score, **per-model thresholds**.
- **Fallback:** escalation *is* the fallback; final tier always answers.
- **Results (measured):** matches GPT-4 with up to 98% cost reduction on HEADLINES; +4% accuracy at equal cost.
- **Latency:** sequential — additive; weakest point of cascades.

**AutoMix (CMU/Google, arXiv 2310.12963, Oct 2023)**
- **Signal:** small model's answer + few-shot self-verification framed as entailment.
- **Mechanism:** self-verification probabilities (explicitly "noisy and ill-calibrated") feed a **POMDP router** that models difficulty as a hidden state; picks model size, including "route nowhere" for unsolvable queries.
- **Granularity:** multi-model (N-model chain).
- **Confidence:** treats all confidence as noisy observations; the decision layer accounts for miscalibration rather than trusting it.
- **Results (measured):** >50% cost reduction at comparable performance across 5 models/5 datasets.

## 4. GraphRouter (UIUC, arXiv 2410.03834, Oct 2024; ICLR 2025) + successors

- **Signal:** query + task type + **model descriptions** (GPT-4o-generated text on each model's strengths, pricing, context length) in a heterogeneous graph (task/query/LLM nodes).
- **Mechanism:** GNN edge-prediction predicts effect and cost per (query, LLM) pair; recommend by effect-cost preference. Inductive: new LLMs enter as new nodes with text-derived embeddings, no retraining.
- **Granularity:** multi-model (N-way).
- **Results (measured):** ≥12.3% improvement over prior routers; generalizes to unseen LLMs (+9.5% effect).
- **Related 2025–26 wave:** Router-R1 (NeurIPS 2025, arXiv 2506.09033 — RL-trained LLM that routes across multiple rounds and aggregates answers, reward from outcomes); CP-Router (arXiv 2505.19970 — conformal-prediction uncertainty to route between LLM and reasoning model); EntroRouter (arXiv 2606.29424 — token-entropy-based routing); IRT-Router (ACL 2025 — item response theory for interpretable multi-LLM routing). Common thread: routing framed as structured prediction with calibrated/derived uncertainty, not free-text judgment.

## 5. Production routers

**OpenRouter Auto (`openrouter/auto`; blog 2026-08-10; docs guide)**
- **Signal:** prompt text; community aggregate spend (trailing 7 days per task type); account policy.
- **Mechanism:** (1) fast, lightweight classifier assigns 1 of ~30 fine-grained task types (`code:debugging`, `agent:multi_step_planning`, `math`…); (2) look up community spend-share ranking for that task type (Pareto-optimal routing curve — "model rankings by task spend"); (3) apply your `cost_tier` band (low/medium/high/xhigh/max); (4) route primary + fallback chain, honoring allowlists/guardrails. Prompts "classified in-flight without retention."
- **Granularity:** ~30 task types × 5 cost tiers → effectively multi-tier.
- **Confidence:** no user-facing confidence; the knob is `cost_tier` (old router exposed continuous `cost_quality_tradeoff` 0–10).
- **Fallback:** ranked fallback list; "if classification or rankings are ever unavailable, the router degrades gracefully to a default model set — a request never fails because routing infrastructure hiccuped."
- **Feedback:** implicit and continuous — spend share updates within days as users migrate; no retraining.
- **Stickiness:** remembers the model a conversation landed on and reuses it *while it remains a top candidate* for the new prompt; re-ranks every turn.
- **Metadata:** `X-OpenRouter-Metadata: enabled` header returns `data.task_type`; per-model pricing/latency/throughput on `/models`; `model` field in response.
- **Measured:** blog benchmark table (MMLU-Pro, τ³-bench, WideSearch, DSQA, SWE-Atlas QnA with ±CI and $ cost) vs old router; explicit note that cache rebuilds from model switching are a real cost motivating stickiness.

**Martian (docs.withmartian.com; RouterBench arXiv 2403.12031, Mar 2024)**
- Gateway to 200+ models, OpenAI/Anthropic-compatible endpoints. Current router internals not documented publicly. Their published contribution is **RouterBench**: 405k pre-computed inference outcomes (11 models × 8 datasets) so routers can be trained/evaluated without live inference; theoretical framework where router quality = inference-dollar cost vs performance; found $2–5x cost variance at equal performance (measured, on their dataset). Earlier positioning: interpretability-based "model mapping" routing, "95%+ of GPT-4 quality at lower cost" (vendor claim, 2023 press; also the system RouteLLM benchmarked against and beat).
- **Granularity:** multi-model N-way. **Feedback:** RouterBench enables offline training loops; product-side not public.

**NotDiamond (docs.notdiamond.ai, accessed 2026)**
- **Signal:** messages + your declared candidate model list (`llm_providers`); tradeoff mode.
- **Mechanism:** pre-trained router returns recommended model + `session_id`; tradeoff parameter `"quality"` (default) / `"cost"` / `"latency"`, plus continuous `cost_quality_tradeoff` (0–10) and custom per-model cost/latency attributes. Custom routers trainable on your eval data (`/trainCustomRouter` endpoint) — explicit cold-start answer: bring your own preference/eval data.
- **Granularity:** N-way over your candidate set. **Fallback:** none published at the routing layer. **Feedback:** `session_id` ties recommendations together; positioning says "especially effective in long-running coding agent settings" (vendor claim).
- **Docs updated Dec 2025**; note the product's long-term availability is uncertain — verify before depending on it.

**Unify (llmreference.com profile, 2026-06-08 — secondary source; primary docs at unify.ai/docs not reachable in this scan)**
- **Signal:** prompt + live per-endpoint runtime benchmarks (latency, cost, quality) refreshed every 10 minutes across 100+ providers.
- **Mechanism:** neural scorer predicts per-prompt performance pre-generation; optimize for cost/quality/latency weights. **Granularity:** N-way × provider. **Feedback:** continuous re-benchmarking (runtime signal, not preference learning). Treat specifics as directory-sourced, not vendor-verified.

## 6. LiteLLM Router (docs.litellm.ai/docs/routing, accessed 2026)

- **Signal:** request metadata only — model alias, `rpm`/`tpm` health, tracked latency/cost/usage, tags. **No prompt-content classification at all.**
- **Mechanism:** config-declared strategies: `simple-shuffle` (weighted random by rpm/tpm, default), `usage-based-routing-v2`, `latency-based-routing`, `least-busy`, cost-based; `model_list` groups deployments under one alias; tag routing maps request metadata→model group.
- **Granularity:** deployment-level load balancing, not tier classification.
- **Fallback:** the strongest of any surveyed: ordered `fallbacks`, `allowed_fails` + `cooldown_time` (auto-quarantine of failing deployments), timeouts, retries with backoff; Redis-backed state.
- **Budget/rate-limit:** per-key/team `max_budget`, TPM/RPM ceilings — the closest analog to our session-budget downgrade, but enforced as rejection or group switch, not silent tier downgrade.
- **Feedback:** runtime telemetry (success, latency) feeds routing; no preference/quality learning. **Overhead:** in-process, ~free.

## 7. Embedding / similarity routers

- **semantic-router (aurelio-labs, created 2023-10, ~3.8k stars):** routes = lists of example utterances; decision = embedding similarity in vector space, threshold-gated; milliseconds, no LLM call; has a dedicated **threshold-optimization** feature (tune per-route thresholds from labeled data). Granularity: N-way route choice. Feedback: threshold optimization only. Fallback: no-match → default route.
- **RouteLLM SW-ranking** (above) is the same idea for model routing: nearest training queries (BERT embeddings) + their preference outcomes vote.
- **LlamaIndex selectors** (developers.llamaindex.ai router guide): same contract, two interchangeable implementations — `LLMSelector` (LLM-as-classifier over choices, structured output) vs `EmbeddingSelector` (top-k cosine over choice descriptions). Useful precedent for making the prompt-classifier and an embedding fallback drop-in swappable.

## 8. Coding agents' model pickers

- **Claude Code (code.claude.com/docs/en/model-config, accessed 2026):** manual `/model` picker with aliases (`sonnet` daily, `opus` complex, `haiku` simple/fast, `fable` hardest). One phase-aware composite: **`opusplan` = opus during plan mode, sonnet for execution** — a deterministic phase split, not a learned router. Fable 5: requests flagged by safety classifiers "trigger automatic model fallback." Pinning via env vars/settings; no published per-turn auto routing.
- **Cursor Router (cursor.com/docs/cursor-router, accessed 2026):** "runs a **classifier on each agent request** and routes it based on **task type and complexity**"; picks most cost-effective model with comparable quality; optimization modes Cost/Balance/Intelligence chosen by user; model pool managed by Cursor and changes over time; enterprise model-access controls constrain the router (blocking too many models "reduces routing quality and can disable the router"); option to show/hide which model was used per response; SDK exposes `auto-smart` + `optimize_for`. Practitioner report (secondary, Aug 2026): classifier trained on 600k+ real requests. Classifier features/weights not public.
- **GitHub Copilot auto model selection (docs.github.com; changelog 2026-05-20):** two combined systems — real-time system health/availability + task complexity — route each task; "routing occurs along natural cache boundaries" because mid-session model switching raises cost without quality gains; claims language invariance; 10% pricing discount for Auto use; policy filters (plan, admin, data-residency) applied after routing; "You can see which model was used for each Copilot response." Auto also operates inside third-party agents (Codex, Claude) with an explicit supported-model list.
- **Cline (docs.cline.bot/core-workflows/plan-and-act):** no auto routing; dual **Plan/Act** modes with independently configurable models per mode — user-manual phase routing, like `opusplan`.
- **aider (aider.chat/docs/config/options.html):** explicit **three-tier static split**: `--model` (main), `--weak-model` (commit messages + chat-history summarization), `--editor-model` (architect-mode edits). Tier assignment is by *function in the loop*, chosen once by the user — never by prompt classification.

## 9. Benchmarks for routers

RouterBench (Martian, arXiv 2403.12031) — 405k pre-computed outcomes; RouterEval (EMNLP 2025 Findings, arXiv 2503.10657) — large-scale routing benchmark for model-level scaling; LLMRouterBench (arXiv 2601.07206, Jan 2026) — "massive benchmark and unified framework"; RouteLLM's own framework + CPT/APGR metrics; OpenRouter's blog publishes task-domain benchmark tables with cost. Consensus evaluation shape: **cost ($) vs quality curve with confidence intervals, swept across the router's aggressiveness knob** — never a single operating point.

## Comparison table

| Approach | Signal | Mechanism | Granularity | Confidence/threshold | Fallback | Feedback loop | Overhead / cold start |
|---|---|---|---|---|---|---|---|
| RouteLLM | query text (+Arena prefs) | trained routers (SW/MF/BERT/LLM) | binary | win-prob + tunable threshold | none per-request | offline training + augmentation | BERT-class small; needs pref data |
| Hybrid LLM | query text | BERT gap predictor | binary/cascade | gap vs runtime quality knob | cascade variant | retrain | small; synthetic labels |
| FrugalGPT | generated answer | DistilBERT score gate | multi-tier cascade | per-step score thresholds | escalate = fallback | offline scorer training | sequential latency (main cost) |
| AutoMix | answer + self-verify | POMDP over noisy confidence | multi-model | treats confidence as noisy obs | escalate / abort | offline (small data) | verifier + POMDP; sequential |
| GraphRouter | query + task + model text | GNN edge prediction (effect, cost) | N-way | effect-cost preference weights | none published | offline; inductive to new models | GNN inference; needs graph data |
| Router-R1 | query + history | RL-trained LLM router | multi-round + aggregation | learned policy | aggregation path | RL from outcomes | LLM call per decision |
| OpenRouter Auto | prompt + 7-day spend share | task classifier → spend rank → cost band | ~30 tasks × 5 tiers | cost_tier band (user knob) | primary + fallback list; graceful default | implicit, continuous (spend) | fast classifier, in-flight |
| Martian | not public | not public (interpretability origin) | N-way | n/a | n/a | RouterBench offline | n/a |
| NotDiamond | messages + candidate set | pre-trained/custom router | N-way | tradeoff mode + 0–10 blend | none published | custom router on your data | pre-trained = no cold start |
| Unify | prompt + live runtime bench | neural scorer | N-way × provider | cost/latency/quality weights | provider redundancy | 10-min re-benchmark | scorer call; live probes |
| LiteLLM | request metadata only | rules (rpm/tpm/latency/cost/tags) | deployment-level | none (deterministic) | fallbacks + cooldowns + retries | runtime telemetry | ~zero, in-process |
| semantic-router | utterance embedding | cosine similarity + threshold | N-way routes | per-route threshold (optimizable) | default route | threshold optimization | ms, local; needs exemplars |
| Copilot Auto | task + system health | dual-system routing | multi-model | n/a (internal) | health-aware re-route | health + task metrics live | in-product |
| Cursor Router | agent request | trained classifier (task+complexity) | multi-model + 3 modes | mode = aggressiveness | access-control re-route | training on real requests | in-product |
| Claude Code / Cline / aider | user phase / function | manual pins, phase split | discrete tiers | none | Fable safety fallback (CC) | none | zero |

## Patterns that transfer to pi-model-router

1. **Make the threshold the user-facing knob, not the confidence word.** RouteLLM's CPT/APGR, Hybrid LLM's runtime quality level, OpenRouter `cost_tier`, NotDiamond `cost_quality_tradeoff` (0–10) all expose one continuous aggressiveness control and sweep it during eval. A `router/aggressiveness` or per-tier budget bias knob replaces hard-coded trust rules.
2. **Policy constrains; the classifier decides content.** In every classifier-bearing system (OpenRouter, Copilot, Cursor) the deterministic rules are *policy* — budget bands, allowlists, pins, data-residency — applied around/after classification. Manual pin and session-budget cap map cleanly; keyword *content* rules do not (see contradictions).
3. **Session stickiness with re-evaluation.** OpenRouter remembers the conversation's model but re-ranks every turn and only reuses it "while it is still a top candidate." Our phase-bias is right; gate it on the current turn's signal, not a blind N-turn lock. Copilot's cache-boundary finding (switching mid-session costs cache rebuilds) independently justifies stickiness.
4. **Structured output, never regex-on-prose.** LlamaIndex LLMSelector, Router-R1, and the MCQA-style routers all constrain classifier output (schema/choice-set). Keep the regex as an emergency fallback, but request JSON/tool-call schema with a closed enum for tier.
5. **Graceful degradation is table stakes.** OpenRouter: "a request never fails because routing infrastructure hiccuped." LiteLLM: cooldowns + fallback chains. Route the failure of the router itself to the heuristics tier with a logged marker.
6. **Expose routing metadata + a correlation ID.** OpenRouter's `task_type` metadata header, NotDiamond's `session_id`, Copilot's "see which model was used," Cursor's show/hide setting. The status line should show tier + one-line reason, and persist a decision log entry — this is also the substrate for any future learning.
7. **Cheap augmentation of the classifier prompt works.** RouteLLM's headline result: <2% augmented data flipped the BERT router from below-random to +50% APGR. For a prompt-based classifier, the analog is few-shot exemplars — and SW-ranking shows nearest-neighbor exemplar voting is the strongest no-training router. The heuristics tier can be upgraded to embedding-similarity exemplar matching (semantic-router does this in ms, locally).
8. **Evaluate as a curve, offline.** Adopt RouteLLM's framing (replay prompts, sweep the knob, plot cost vs quality with CIs) over any single-point test. RouterBench's trick — pre-computed outcomes so router variants are evaluable without inference — is directly reproducible for our three tiers.
9. **Cascade escalation is an alternative confidence consumer.** If we keep the classifier confidence, spend it on a FrugalGPT-style gate (low tier first, escalate on weak confidence) rather than on tier selection alone. AutoMix is the caution: verbalized/self-assessed confidence is ill-calibrated; a decision layer must assume noise.
10. **Runtime health as a routing input.** Copilot (system health) and Unify (10-min endpoint benchmarks) route around degraded providers. Our provider-failure retry chain covers the same need at the model layer.

## Contradictions with our current design

1. **Regex-parsed "Tier/Confidence" text lines.** No surveyed external system parses free-text tier/confidence lines from an LLM. Where an LLM is the classifier (LlamaIndex, Router-R1, RTLearner-style MCQA), output is schema-constrained or read as a probability; where latency matters (OpenRouter, Cursor, semantic-router), the per-request classifier is a fast trained/embedding model, not a prompted LLM. External evidence says: constrain the format, or don't use an LLM for the per-turn decision.
2. **Keyword veto overriding the classifier.** No external system lets cheap keyword rules override a classifier's content judgment. Deterministic layers exist everywhere, but they carry *policy* (budget, allowlist, pin, health) or *output-quality gates* (FrugalGPT scorer, AutoMix verifier) — never input-keyword content overrides. If keywords are predictive, RouteLLM's augmentation result says to move them into the classifier's signal (exemplars), not around it.
3. **Rules checked before the classifier.** Two consistent external orderings exist: all-rules (LiteLLM — no classifier), or classify-then-constrain (OpenRouter, Copilot, Cursor). Both OpenRouter and Copilot classify *every* prompt with no content-based short-circuit. Content rules that preempt the classifier have no precedent in the surveyed systems; policy rules (budget/pin) before it are fine and standard.
4. **A single confidence word controlling trust.** External systems use continuous scores with thresholds (RouteLLM win-prob, FrugalGPT 0.96/0.37, Hybrid LLM gap, NotDiamond 0–10 blend) or explicitly model confidence as noisy (AutoMix POMDP). A three-valued verbal confidence is strictly less information than a thresholded continuous score, and the one paper that measured self-reported confidence quality (AutoMix) found it noisy and ill-calibrated. Evidence favors: numeric confidence (or logprob margin where the API exposes it) + two thresholds, with the middle band resolved by stickiness or heuristics.

## Open questions not answerable from public sources

- Feature sets and training data of OpenRouter's ~30-class task classifier, Cursor's "task type and complexity" classifier, and NotDiamond's Code router — all closed.
- Martian's current production routing internals (docs describe gateway only).
- Classifier accuracy on *coding-agent* traffic (long prompts, tool results, multi-turn state) — published benchmarks are chat/QA; NotDiamond's coding-agent claims carry no public eval.
- Whether API-exposed logprobs can give a calibrated margin for a prompted tier classifier — no measured public data for modern chat models' verbalized vs logit confidence on routing tasks.
- Cold-start behavior of spend-share signals for niche task types (OpenRouter bootstrap unpublished).
- Cost of cache invalidation from tier switching in agent loops — Copilot states the concern qualitatively; no public measurements for local agent sessions.

## Sources

**Papers:** RouteLLM — arxiv.org/abs/2406.18665 (ICLR 2025), lmsys.org/blog/2024-07-01-routellm/ · FrugalGPT — arxiv.org/abs/2305.05176 (TMLR 2024) · Hybrid LLM — arxiv.org/abs/2404.14618 (ICLR 2024) · AutoMix — arxiv.org/abs/2310.12963 · GraphRouter — arXiv 2410.03834 (ICLR 2025) · RouterBench — arxiv.org/abs/2403.12031 · Router-R1 — arxiv.org/abs/2506.09033 (NeurIPS 2025) · RouterEval — arxiv.org/abs/2503.10657 (EMNLP 2025 Findings) · LLMRouterBench — arxiv.org/html/2601.07206v1 · CP-Router — arxiv.org/html/2505.19970v1 · EntroRouter — arxiv.org/html/2606.29424 · IRT-Router — aclanthology.org/2025.acl-long.761/

**Vendor docs/blogs (primary for their products):** openrouter.ai/docs/guides/routing/routers/auto-router · openrouter.ai/blog/announcements/introducing-the-new-auto-router/ (2026-08-10) · docs.notdiamond.ai/docs/what-is-model-routing, /docs/quickstart-routing, /docs/router-training-quickstart · docs.withmartian.com/gateway · docs.litellm.ai/docs/routing, /docs/proxy/tag_routing · cursor.com/docs/cursor-router, cursor.com/blog/router · docs.github.com/en/copilot/concepts/models/auto-model-selection · github.blog/changelog/2026-05-20-auto-model-selection-now-routes-based-on-your-task-in-vs-code/ · code.claude.com/docs/en/model-config · docs.cline.bot/core-workflows/plan-and-act · aider.chat/docs/config/options.html · docs.aurelio.ai/semantic-router/get-started/introduction, /user-guide/features/threshold-optimization · developers.llamaindex.ai/python/framework/module_guides/querying/router/

**Secondary/press (flagged as such above):** llmreference.com/router/unify (2026-06-08) · vibecodingacademy.ai Cursor Auto writeup (2026-08-03) · accessnewswire.com Martian funding press release · siliconangle.com/2023/11/15 (Martian launch)
