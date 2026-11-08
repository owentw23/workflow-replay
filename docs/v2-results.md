# Workflow Replay v2: test bench results

## v2.2: the model writes every answer (current default)

Run `.replay/v2-9bb0d5/`, fresh learning plus test, same setup as v2.1. The harness no longer answers without the model. On a hit it hands the model a compact receipt (only the fields the workflow returns) plus the conversation so far, in one lean answer call with no tool list. Workflow descriptions no longer contain input values such as customer names.

| Arm | Accuracy | Mean tokens / task | Cost units / task* | Model calls / task | Median latency |
| --- | --- | --- | --- | --- | --- |
| baseline-raw | 99.3% | 4,026 | 814 | 2.97 | 2.6 s |
| baseline-projected | 96.4% | 3,828 | 815 | 2.97 | 2.6 s |
| **harness** | **100.0%** | **2,489 (−38%)** | **673 (−17%)** | 2.62 | **2.0 s** |

\* Cost units = uncached input + 0.1 × cached input + 2 × output.

| Kind | baseline-raw tokens | harness tokens | Change |
| --- | --- | --- | --- |
| Repeat, exact form | 3,761 | 191 | −95% |
| Repeat, paraphrased | 3,833 | 1,191 | −69% |
| Outlier | 5,298 | 651 | −88% |
| Follow-up (2 turns) | 6,597 | 7,660 | +16% |
| Compound | 7,541 | 8,175 | +8% |
| Near-miss | 3,613 | 4,363 | +21% |
| Novel | 2,476 | 3,339 | +35% |

- Pre-model hit rate on repeat tasks: 89.4%, all hits correct. Controls: 44 trials, 0 wrong answers after a replay. Follow-up second turns: 100%.
- Paired (both correct): −38.5% tokens versus baseline-raw, −63% on repeat tasks.
- Compared with skipping the model (v2.1: −42% tokens, −30% cost), letting the model write every answer costs about 4 points of token savings and 13 points of cost savings. In return, every answer is written and checked by the model, with the conversation's context.
- Uncached input per task is higher than the plain agent's (302 vs 202). The small answer and router prompts are mostly not cached by the provider; overall cost is still 17% lower.
- **An intermediate version (run `.replay/v2-a69ee8/`) did worse:** −14% tokens and 97.8% accuracy. It re-sent the full agent prompt and tools for the answer and labelled the receipt as earlier context, so the model often re-fetched the data, and three times answered "none". The lean answer call and the clear "data for this request" label fixed both.

## v2.1: all components, shipped defaults (final)

Run `.replay/v2-e2a6b4/`, fresh learning plus test, DeepSeek V4.1 Flash, same setup as below plus an eighth task family that needs a loop ("how many of my orders were delivered": one call per order, then a filtered count). 69 test items × 2 repeats × 3 arms. New in this build: loops and pagination, hybrid retrieval with local embeddings, partial reuse (prefetch for related requests), `find_workflow`, response templates, approval-gated writes, a feedback signal, and gates on mid-turn replays.

**Learning:** 48 agent episodes (46 correct) produced 8 workflows, including the loop (`forEach` over the customer's orders, then `count where status = "delivered"`). Consolidation merged the two coincidental flight-date plans into one. All 8 passed shadow mode (3/0) and went live.

| Arm | Accuracy | Mean tokens / task | Uncached input / task | Cost units / task* | Model calls / task | Median latency |
| --- | --- | --- | --- | --- | --- | --- |
| baseline-raw | 98.6% | 4,026 | 216 | 827 | 2.97 | 2.7 s |
| baseline-projected | 97.8% | 3,828 | 215 | 807 | 2.97 | 2.7 s |
| **harness** | **100.0%** | **2,339 (−42%)** | 245 (+13%) | **583 (−30%)** | **2.01** | **1.4 s** |

\* Cost units = uncached input + 0.1 × cached input + 2 × output, a rough model of prompt-cache pricing.

| Kind | baseline-raw tokens | harness tokens | Change | Harness accuracy |
| --- | --- | --- | --- | --- |
| Repeat, exact form | 3,761 | 0 | −100% | 100% |
| Repeat, paraphrased | 3,832 | 980 | −74% | 100% |
| Outlier | 5,298 | 1,979 | −63% | 100% |
| Follow-up (2 turns) | 6,596 | 6,427 | −3% | 100% |
| Compound | 7,538 | 7,632 | +1% | 100% |
| Near-miss | 3,613 | 4,361 | +21% (was +51% in run B) | 100% |
| Novel | 2,476 | 3,339 | +35% | 100% |

- Pre-model hit rate on repeat tasks: 90.4%, all hits correct. 78 turns were answered with zero model calls.
- Partial reuse ran on 26 declined turns with 100% accuracy, and cut the near-miss overhead from +51% to +21%.
- Controls: 44 trials, 0 wrong answers after a replay.
- Paired (both correct): −42.6% tokens versus baseline-raw overall, −67.7% on repeat tasks (2,808 tokens saved per repeat).
- **Uncached input is 13% higher** than the plain agent, from the router's per-request prompt and prefetched data, both of which the provider bills at full price. Total cost is still about 30% lower because far fewer cached and output tokens are used.

**Router prompt variant** (run `.replay/v2-b3a10a/`, same learned catalog): putting the whole catalog in a fixed, cacheable system prompt (`routerPrompt: 'catalog'`) cut uncached input to 210/task but raised total tokens to 3,148/task (−22% vs −42%), for similar cost (−23%). The default stays `shortlist`.

**Live Claude Code check:** inject, show-and-carry and a carried follow-up all worked in real `claude -p` sessions (see `docs/v2-build.md`).

The sections below are the earlier v2.0 runs, kept for comparison.

Model: DeepSeek V4.1 Flash (`deepseek-v4-1-flash-261017`, BytePlus ModelArk), thinking off, temperature 0.3. Date: 2026-11-09.
Raw records: `.replay/v2-26b860/` (learning + run A) and `.replay/v2-6a36bc/` (run B, final). Bench code: `eval/v2/`.

## Setup

**Data.** Real records from the public τ²-bench retail and airline databases (sierra-research/tau2-bench, MIT, commit `033bf082`, SHA-256 pinned): 500 retail customers, 1,000 orders, 50 products, 500 airline users, 2,000 reservations, 300 flights. Tool names and payloads follow τ²-bench (prefixed by domain). Gold answers are computed from the database.

**Tasks.** Seven read-only intents adapted from the information-gathering parts of τ²-bench tasks: latest order status and tracking, order item count and total, product variant availability and cheapest price, account order count and city, membership plus latest reservation cabin and passenger count, flight status on a date, reservation total paid and flight count. Phrasings are authored. Training, shadow and test use different customers, orders, products and flights.

| Test kind | Items | What it checks |
| --- | --- | --- |
| Repeat, paraphrased | 28 | Same intent, new entity, wording never seen in training |
| Repeat, exact form | 7 | A training wording reused with a new entity |
| Outlier | 3 | Latest order is pending with no tracking number |
| Follow-up (2 turns) | 4 | Second question refers to the first answer ("that order") |
| Near-miss | 14 | Similar wording, different question (first vs latest order, unavailable vs available, zip vs city, …) |
| Novel | 4 | Intents never seen in training |
| Compound | 2 | Two intents in one request |

62 items × 2 repeats × 3 arms = 372 test episodes per run.

**Arms.**
- **baseline-raw**: plain agent, atomic tools, full τ²-bench records (how most agents are wired today).
- **baseline-projected**: same agent, tools go through the gateway's projection (trimmed records).
- **harness**: full v2 (router before the model, direct replay with carry, inject on outliers, compiled `run_workflow` tool, gateway speculation, projection).

**Learning phase** (harness only, before testing): 42 ordinary agent episodes in two batches, mined after each batch; then 21 shadow requests. Success labels came from the gold answers, standing in for user feedback. Learning was frozen during testing.

## Learning results

- Batch 1: 21/21 episodes correct → 7 candidate workflows, all verified by replay.
- Batch 2: 19/21 correct → reinforced 6 workflows; flight status had been learned with a constant date (all batch-1 flights were on 2024-05-10), and the batch-2 plan had a different constant date. **Consolidation merged them into one workflow with a `date` placeholder** and retired both originals.
- Shadow: every workflow reached 3 agreements, 0 disagreements, and was promoted (auto-approval and widening were on for the bench).
- Final catalog: 7 live workflows, 2 retired. Learned plans include a negative-index lookup (`orders[-1]`), a product-name key lookup, and reducers (`len`, `count` where available, `min` price where available, `sum` of prices or payments).
- Learning traffic: 215,081 tokens over 171 model calls. That is ordinary agent work that would happen anyway. Extra cost of learning: 0 tokens, because the shadow requests reused training wording and matched templates, so no router model calls were needed.

## Main result (run B, final code)

| Arm | Accuracy | All repeats correct | Mean tokens / task | Mean uncached input | Model calls / task | Median latency |
| --- | --- | --- | --- | --- | --- | --- |
| baseline-raw | 96.8% | 95.2% | 3,840 | 232 | 2.85 | 2.8 s |
| baseline-projected | 94.4% | 93.5% | 3,682 | 224 | 2.85 | 2.9 s |
| **harness** | **98.4%** | **98.4%** | **2,494** | **168** | **2.15** | **1.3 s** |

Harness versus baseline-raw over the whole test set: **35% fewer tokens, 25% fewer model calls, 53% lower median latency, accuracy +1.6 points.**

| Kind | baseline-raw acc / tokens | harness acc / tokens | Token change |
| --- | --- | --- | --- |
| Repeat, exact form | 100% / 3,515 | 100% / **0** | −100% |
| Repeat, paraphrased | 100% / 3,532 | 100% / **783** | −78% |
| Outlier | 100% / 5,298 | 100% / 1,965 | −63% |
| Follow-up (2 turns) | 100% / 6,514 | 100% / 6,416 | −2% |
| Near-miss | 100% / 3,305 | 100% / 4,991 | **+51%** |
| Novel | 75% / 2,457 | 100% / 3,436 | **+40%** |
| Compound | 50% / 8,263 | 50% / 8,761 | +6% |

Paired comparison (same item and repeat, both arms correct):

| Versus | Pairs | Tokens saved, all tasks | Uncached tokens saved | Saved on repeat tasks | Mean tokens saved per repeat |
| --- | --- | --- | --- | --- | --- |
| baseline-raw | 120 | 37.3% | 35.7% | 67.7% | 2,666 |
| baseline-projected | 117 | 32.6% | 28.5% | 64.9% | 2,424 |

Harness behaviour:
- **Pre-model hit rate on repeat tasks: 95.2%, and 100% of those hits were correct.** 72 turns were answered with zero model calls; 8 outlier turns were injected so the model could explain the missing tracking number.
- Near-misses: all 28 trials correct. The router declined every near-miss before the model ran. Mid-turn, the gate refused the compiled tool and speculation where they didn't fit.
- Follow-ups: 100% correct on the second turn, including turns where the first answer was given without the model and carried into context.
- Compound: the same item failed in all three arms. Every arm counted 10 available tea-kettle variants instead of 11, a model counting error. The gate refuses partial workflows for two-part requests, so the harness did not use its exact workflow here.

## Run A, before the mid-turn gate fix

| Arm | Accuracy | Mean tokens / task | Model calls / task |
| --- | --- | --- | --- |
| baseline-raw | 96.8% | 3,840 | 2.85 |
| baseline-projected | 95.2% | 3,682 | 2.85 |
| harness | 97.6% | 2,102 | 1.96 |

Run A saved more tokens (−45%) but had **3 wrong replays**. On the "very first order" near-miss, the router correctly declined, but the model then called the compiled "latest order" workflow itself and returned the latest order. The compiled tool and speculation were not gated against the request. The fix applies the same gate mid-turn. That removed the wrong replays in run B (near-miss accuracy 89% → 100%), at the cost of some savings on compound requests, where run A had answered correctly with two workflow calls.

## What this means

- **Repeats are where the harness pays off.** Repeat tasks cost 65–78% fewer tokens. Exact-form repeats cost nothing, and answers came back in about half the time.
- **Non-repeats cost more.** Near-miss and novel tasks cost 40–51% more, from the router's model call, the longer tool list (`run_workflow` describes every live workflow) and refused workflow calls.
- **Break-even is about one third repeats.** Savings of about 2,700 tokens per repeat against about 1,400 extra tokens per non-repeat means the harness saves overall once roughly 35% of traffic is repeats. This test set had 68% repeats (42 of 62 items), so the overall figure (−35%) depends on that mix. Measure your own repeat share first (Phase 0 in the architecture doc).
- **Safety held once mid-turn replays were gated:** no wrong replays in the final run. That only holds for this near-miss set. Run A shows that any path that replays without checking the request will eventually answer the wrong question.

## Limits of this evaluation

- One model, 2 repeats per item, temperature 0.3. Small differences (±2 points of accuracy) are within noise.
- Phrasings and task mix are authored. Real users vary more, and pre-model hit rates on real traffic will be lower than 95%.
- Learning used gold answers as the success signal; a real deployment needs user feedback or another check.
- The shadow target was 3 agreements (20 or more recommended in production). Approval and widening were automatic.
- Token counts are provider-reported usage. Dollar costs are not computed. With prompt caching, cached input is cheaper, so the uncached columns matter most for cost.
- Claude Code and Codex hooks were not exercised in this bench. Hosts were simulated as "own agent" (direct mode).

## Reproduce

```bash
npm run bench:v2:fetch
```

```bash
npm run bench:v2 -- --repeats 2 --workers 4
```

To re-run only the test phase on an existing learned catalog:

```bash
npm run bench:v2 -- --learned .replay/v2-26b860/catalog.sqlite
```
