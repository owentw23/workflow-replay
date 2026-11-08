# Live ModelArk evaluation

This suite adapts published research tasks to the harness's read-only HTTP interface. Each family has two original prompt phrasings and distinct synthetic test inputs. The gold answers are explicit in [tasks.mjs](tasks.mjs). Weather, exchange rates, news and service records are fixed fixture data. The suite uses single user turns and scores the returned JSON. The published benchmarks use their own datasets, tools and scoring protocols.

| Task family | Research source | Adaptation |
| --- | --- | --- |
| Retail shipment tracking | [τ³-bench retail task 25](https://github.com/sierra-research/tau2-bench/blob/033bf082f48e4a3c6a1256208e93cf2ce9c3bb6f/data/tau2/domains/retail/tasks.json) | Resolve a shopper by name and postal code, find their latest order and return tracking and status. Uses the source task's information-gathering part. |
| Airline baggage allowance | [τ³-bench airline task 3](https://github.com/sierra-research/tau2-bench/blob/033bf082f48e4a3c6a1256208e93cf2ce9c3bb6f/data/tau2/domains/airline/tasks.json) | Fetch loyalty tier and reservation cabin, then look up included checked bags. One prompt gives an incorrect suspected tier. |
| Airline passenger count | [τ³-bench airline task 38](https://github.com/sierra-research/tau2-bench/blob/033bf082f48e4a3c6a1256208e93cf2ce9c3bb6f/data/tau2/domains/airline/tasks.json) | Find a traveler's latest reservation and verify the headcount. Uses the information-gathering part, including a mistaken passenger count in one prompt. |
| Two city temperatures | [BFCL live_parallel_1-0-1](https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_live_parallel.json) | Look up two cities with the same tool and preserve the requested order. |
| Two exchange rates | [BFCL parallel_58](https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_parallel.json) | Look up two currency pairs, preserving exact quoted decimal strings. |
| News and weather | [BFCL live_parallel_multiple_5-4-0](https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_live_parallel_multiple.json) | Fetch a headline and a temperature with different tools. This task has no saved route and can trigger direct fallback. |

The original [τ-bench paper](https://arxiv.org/abs/2406.12045) motivates the all-repeats-correct metric. The [BFCL paper](https://openreview.net/pdf?id=2GmDdhBdDk) motivates repeated invocations of the same tool and parallel calls across different tools.

## Run

Put `ARK_API_KEY` in the workspace's `cred.env`. The runner also recognizes the legacy `DEEPSEEK_API_KEY` variable in that file and uses it as a ModelArk credential. It calls the [BytePlus Singapore Chat API](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/chat-api) with the pinned model ID `deepseek-v4-1-flash-261017`. Set `ARK_MODEL` to select a different deployed model on that service. Provider calls may incur charges.

```powershell
npm.cmd run bench:live -- --list
npm.cmd run bench:live -- --dry-run
npm.cmd run bench:live
```

The first two commands run locally. For a short live check use `npm.cmd run bench:live -- --family weather-pair --repeats 1`. The default is 12 prompts × 3 repetitions × 3 modes for 108 episodes, with a cap of six completions per episode. Use `--seed` to change the schedule, `--workers` to control parallel episode blocks, and `--family` to repeatably select task families. The provider samples with temperature 0.5 and thinking disabled in all arms. The seed controls experiment ordering only.

## Compare

- **Direct raw** sends direct tool results including synthetic history to the model.
- **Direct projected** sends the same calls' useful fields and isolates the benefit of result projection.
- **Replay** adds playbook search and execution tools alongside projected direct fallback tools. The model chooses what to call. Five routes are compiled locally using separate fixture inputs before measurement. This evaluates warm replay and a catalog miss. Model-driven discovery and learning cost are outside this run.

The runner shuffles the prompt/repetition blocks and randomizes the arm order inside each block. A block runs its arms sequentially and the worker pool runs blocks concurrently. Each episode starts with a fresh model conversation and all arms see identical user text, the same fixture, and the same JSON answer contract.

- **Accuracy** is the fraction of episodes whose parsed JSON matches the expected answer, including types and exact field set. **Pass^k** is the fraction of exact prompts that pass every one of their k trials.
- **Answer agreement** compares pairs of repeated answers for the same exact prompt, ignoring JSON object key order. Missing or invalid JSON counts as disagreement. Stable wrong answers can agree, so read this with accuracy.
- **Trace agreement** compares tool names, arguments, success flags and the sequence of tool batches. Order within a parallel batch is ignored. Per-family results expose routing and fallback behavior.
- **Tokens** sum the provider's prompt and completion usage across all model turns. Cache hits are reported separately and are included in prompt tokens. Matched-pair savings compare trials where both arms were correct. Total token counts measure consumption. Cache discounts, rates and learning costs are separate from this comparison.

The runner writes the prompts, planned order, individual traces and usage, and a summary under `.replay/modelark-*/`. Credentials, raw responses, and provider reasoning content stay out of the reports. On a provider error, the runner stops scheduling new episodes and writes a partial summary.

## Host-routed scale experiment

```powershell
npm.cmd run bench:scale -- --list
npm.cmd run bench:scale
npm.cmd run bench:scale -- --family shipment-audit
```

The scale suite interleaves the 12 original short prompts with six synthetic reconciliation prompts. The two arms are compact direct calls and host-routed replay. Each audit reads a batch manifest, fetches paginated order and carrier data, joins by order ID, and returns the number, total cents and IDs of overdue unshipped orders. It covers 5, 25 and 100 orders, with a documented command form and a natural-language variant at each size. Both arms have the same source records and answer contract. Direct calls receive compact pages and have a calculator for summation, while replay executes a trusted collector in the harness and returns the typed report.

[Host routing](../src/host-routing.mjs) checks the documented command form before querying the local playbook. An exact match binds the batch ID and executes without a model request. Otherwise the model gets at most three candidate descriptions and schemas in one separate request, with no function definitions. The host validates that the selected route is in the shortlist and that the inputs fit the saved plan. A miss, decline or failed replay falls back to the compact direct arm's tools and original user prompt. Any routing usage still counts. The reported suite includes partial catalog matches on the compound news-and-weather prompts.

The model discovers the audit once through compact direct tools on a training batch. A separate compilation request builds a symbolic plan against a prewritten collector. The plan is captured on the training batch and checked on an independent verification batch before it is published. The five short routes use predefined seed plans. Audit learning usage is saved in `learning.json`. This tests plan induction around a trusted reducer. The development cost of implementing the reducer is outside the token measurement.

The summary breaks out tokens, correctness and actual HTTP requests by audit size. The payback projection starts with the observed discovery tokens on both sides, charges compilation once to the harness, then applies each arm's mean warm tokens at 1, 5, 10, 50 and 100 future repetitions. Report correctness and tokens per correct result alongside payback, since cheap wrong answers can otherwise skew the comparison. The 50- and 100-repeat totals are projections from the observed run.

## Collector ablation

Run `npm.cmd run bench:audit` for the six audit prompts at 5, 25, and 100 orders. The default schedule repeats each prompt three times and randomizes the order of compact direct, direct collector, and host-routed arms within each block.

The direct collector arm exposes exactly one model tool, `run_audit(batch)`. The tool calls the same manifest endpoint and executes the same collector as host replay, with the same projected result. DeepSeek chooses the batch argument and returns the final JSON after the tool runs. The direct collector has no catalog or route selection. The host-routed arm can bind an exact command locally, or ask the model for a route and arguments in one request, then return the typed result directly. This comparison measures the extra savings from host-side routing and direct rendering on this audit. The collector is prewritten for both arms. The reported audit compilation cost is incurred only by the host-routed arm. The existing payback projection compares replay against compact direct calls.

## Wording robustness

```powershell
npm.cmd run bench:wording -- --list
npm.cmd run bench:wording
```

[The prompt set](paraphrases.mjs) has nine groups of four. Within each group, inputs and expected JSON stay fixed while phrasing, sentence structure, and context vary. The 25- and 100-order audits share one plan across different batch inputs. Exact command routing is disabled across this suite. Both arms see the same task text and output contract. The baseline uses compact direct calls and the same audit calculator as the scale experiment. The host arm uses local search, an assisted route decision when candidates exist, and compact direct fallback.

| Groups | Prompt provenance |
| --- | --- |
| Weather pair, FX pair, and news with weather | Three original BFCL requests. The source rows are `live_parallel_1-0-1`, `parallel_58`, and `live_parallel_multiple_5-4-0`. See the pinned BFCL links in the task table above. The compound news and weather request has no saved route. |
| Historical FX | IBM Research's Apache-2.0 [BFCL-FC-Robustness](https://huggingface.co/datasets/ibm-research/BFCL-FC-robustness) row [`multiple_17`](https://huggingface.co/datasets/ibm-research/BFCL-FC-robustness/blob/2ec93e790cf5fa3753d477a83cd596115387f1c5/BFCL_v3_multiple_p_quest.json) supplies both an original request and the researchers' published paraphrase. [Rabinovich and Anaby Tavor, TrustNLP 2025](https://aclanthology.org/2025.trustnlp-main.20/) |
| Retail tracking, baggage allowance, and passenger count | Read-only adaptations of three τ³-bench scenarios from the pinned dataset above. We replaced identifiers with fixture identifiers and scoped the scenarios to one request. |
| 25- and 100-order audit | Synthetic multi-page joins. All audit phrasings are original. |

There are five published wordings, three adapted scenarios, and 28 authored wordings. All tool responses and gold answers use synthetic data. Each exact prompt runs three times per arm by default, with 216 scored episodes. The playbook is seeded before scoring, so the results measure reuse across phrasings. The audit is learned and verified on separate batches as in the scale experiment. The seven routes cover eight prompt groups.

`summary.json` reports cross-wording agreement between distinct prompts in each four-variant repeat block, all-four correctness per block, and groups that stayed correct on all variants in all repeats. Exact-prompt agreement and `pass^k` remain separate. The trial log records expected route hits and fallbacks. Agreement can include stable wrong answers, so compare it with correctness.

## Local routing with near misses

Run `npm.cmd run bench:routing`. This suite uses seven read-only workflows and 56 newly authored requests. Half are equivalent requests and half change a detail such as latest versus specific reservation, a date, units, quantity, a filter, or an additional requested action. The indexed examples are separate from the scored requests. Three positive requests per workflow exercise the supported grammar and a fourth uses freer wording. This evaluates the intentionally narrow prototype on its fixture domain.

Both arms run the same execution contracts. One retrieves candidates using the original keyword index. The other searches a second SQLite FTS index with curated example requests, stemming, and search-only aliases. Both execute against the same loopback records, and a positive counts as a correct replay only if the expected workflow returns the expected JSON. A near miss is counted as an unsafe replay if any workflow is attempted or any HTTP call is made. The previous wording suite is checked separately for shortlist recall. The benchmark uses no model, encoder, or API key.

To opt in from a chatbot host, call `indexRouteExamples(db, route, examples)` after publishing a workflow, then supply `local: { contracts, expand }` to `routeRequest`. Each configured contract receives the original request and returns validated argument candidates only for supported complete requests. Multiple matching contracts cause abstention. The harness checks the saved workflow schema before dispatch. When the returned outcome has no result, the host can fall back to its existing compact tool loop. See [fixture route contracts](routing-contracts.mjs) for the example grammars and aliases.

## Fresh four-way confirmation

`npm.cmd run bench:confirm` runs 16 weather prompts, three repeats, and four randomized arms. Use `--dry-run` to capture the seed plans without provider calls, or `--seed` to change the schedule. This uses a new weather-station fixture and report contract. Three requests come from pinned research datasets. The 4-city current report and 2-city three-hour series use BFCL [`parallel_199` and `parallel_28`](https://github.com/ShishirPatil/gorilla/blob/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_parallel.json). The New York seven-day prompt uses IBM Research's [`multiple_60` paraphrase](https://huggingface.co/datasets/ibm-research/BFCL-FC-robustness/blob/2ec93e790cf5fa3753d477a83cd596115387f1c5/BFCL_v3_multiple_p_quest.json). All 13 remaining requests and all station records are synthetic. Common JSON scoring instructions are appended to the user request. The router receives only the request text, and the benchmark controls the output schema separately.

| Arm | What runs |
| --- | --- |
| Compact direct | DeepSeek picks atomic station lookup and observation tools, then formats and computes the answer. |
| Collector only | Same direct path with one additional compound report tool, with no playbook. The tool computes the same report as the full harness. |
| Playbook only | Local routing replays the saved atomic calls. DeepSeek receives the fetched observations in one request and computes the final JSON. |
| Full harness | The same local routing and saved atomic calls, followed by the same deterministic report function as the collector arm. |

The report tasks cross **1, 4 and 8 cities** with **current versus seven-day forecast**, plus two phrasings per combination. The two time horizons use distinct routes over the same city lists. Four deliberately similar requests change the time horizon, requested fields, or both and should fall back to direct tools. Authored route grammars cover bounded request forms and city names. The plans are captured and indexed before scoring, using city lists different from the scored ones. The live measurements cover warm replay and fallback. They exclude plan authoring and induction cost.

The summary reports correctness, answer agreement, all-repeats success, usage, wall-clock time and HTTP calls. It also separates task size, controls, prompts with a matching workflow, and trials where both playbook arms actually ran the expected workflow. Savings compare paired correct trials. A wrong replay is recorded even if the attempted route later fails. See `run.json` for provenance, gold answers and the schedule, and `trials.jsonl` for the model and routing traces.

The scorer treats “New York City” and “New York” as the same city label. Use `npm.cmd run bench:confirm -- --rescore <run-directory>` to apply that rule to an earlier completed run without making provider calls. This saves a separate summary alongside the original records.
