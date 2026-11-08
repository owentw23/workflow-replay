# Workflow Replay v2: software, prerequisites and methods

This is the build specification for the implementation in `src/v2/`. The design rationale is in [architecture-v2.md](architecture-v2.md). Benchmark results are in [v2-results.md](v2-results.md).

## Prerequisites

| Need | Version / detail | Why |
| --- | --- | --- |
| Node.js | 24 or later | Built-in `node:sqlite`, `node:test`, global `fetch` |
| npm packages | `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 (already pinned in `package.json`) | MCP gateway server |
| A trusted profile | `~/.workflow-replay/v2/profiles/NAME.mjs` | Declares the read-only operations and how to call them |
| Optional: a small model | Any JSON-capable chat model | Router input extraction when wording differs from past examples |
| Bench only | ModelArk key in `cred.env` (`ARK_API_KEY` or `DEEPSEEK_API_KEY`), τ²-bench data via `npm run bench:v2:fetch` | Live with/without comparison |

No database server, embedding service, vector store or container is needed. Everything runs in one Node process with one SQLite file per profile.

## Software components

| Module | Role | Main exports |
| --- | --- | --- |
| `src/v2/util.mjs` | Canonical JSON, hashing, tokenising, TF-IDF index, date converter, value detection, answer comparison | `tfidfIndex`, `appearsIn`, `sameAnswer` |
| `src/v2/plan.mjs` | Plan format v2: typed DAG with path references and declarative reducers; validator and executor | `validatePlan`, `executePlan`, `skeleton` |
| `src/v2/store.mjs` | SQLite trace store and route catalog with version history | `recordEpisode`, `saveRoute`, `listRoutes` |
| `src/v2/miner.mjs` | Provenance analysis, clustering, input inference, answer derivation, replay verification | `mine`, `replayCheck`, `inputsForEpisode` |
| `src/v2/router.mjs` | Retrieve, extract (template or model), gate (values, modifiers, competitor discriminators) | `createRouter`, `gate`, `MODIFIERS` |
| `src/v2/carry.mjs` | Follow-up continuity store (memory or owner-only files), 4 KB / 12 KB caps | `createCarry` |
| `src/v2/harness.mjs` | Gateway, speculation, compiled-workflow tool, pre-model handling, shadow mode, learning loop, consolidation | `createHarness` |
| `src/v2/hosts/profile.mjs` | Loads a profile and opens its store and carry directory | `loadHarness` |
| `src/v2/hosts/mcp-gateway.mjs` | stdio MCP server: projected tools, `find_workflow`, `run_workflow`, speculation, `commit_workflow_action` | `makeGatewayServer`, `approveWrite` |
| `src/v2/hosts/permissions.mjs` | Reads Claude Code permission settings; decides allow / ask / deny for a tool | `decide`, `settingsSources` |
| `src/v2/hosts/claude-hook.mjs` | Claude Code / Codex hooks: `prompt` (route, inject or show-and-carry, write proposals, shadow), `stop` (record, shadow compare, auto-learn, purge), `end` (cleanup) | `onPrompt`, `onStop`, `onEnd` |
| `src/v2/hosts/wrap.mjs` | Generates a profile from an existing MCP server or OpenAPI spec, labelling each operation read or write | `describeMcpServer`, `describeOpenApi` |
| `src/v2/hosts/analyze.mjs` | Phase 0: measures the replayable share of past Claude Code transcripts | `analyze` |
| `src/v2/hosts/cli.mjs` | Operator CLI: `status`, `learn`, `approve`, `ask`, `feedback`, `commit` | — |

## Methods

### 1. Plan format v2

```json
{ "version": 2,
  "inputs": { "user_id": { "type": "string", "from": "request" } },
  "steps": [
    { "id": "s1", "op": "airline_get_user_details", "args": { "user_id": { "input": "user_id" } } },
    { "id": "s2", "op": "airline_get_reservation_details", "args": { "reservation_id": { "step": "s1", "path": ["reservations", -1] } } } ],
  "output": {
    "membership": { "step": "s1", "path": ["membership"] },
    "passengers": { "reduce": "len", "of": { "step": "s2", "path": ["passengers"] } } } }
```

- References: `{input}`, `{const}`, `{step, path}`, and `{item: path}` inside loops. Path segments are keys, array indexes (negative counts from the end) or `{input}` for a case-insensitive key lookup (for example product name → product id).
- Loops: `forEach: {step, path}` calls the operation once per list element (up to 50, 4 at a time) and returns the list of results.
- Pagination: `paginate: {arg, start, max, collect}` calls with page = start, start+1, … until a page's collected list is empty (up to 50 pages) and returns `{items, pages}`.
- Reducers: `len`, `count`, `sum`, `min`, `max`, with an optional `where` filter (boolean or text field, e.g. `status = "delivered"`) and a `field` path. Sums are rounded to cents.
- Writes: an operation registered with `effect: "write"` may only be the final step. Execution stops before it and returns the exact proposed call; it runs only through the approval ledger (section 9).
- No arbitrary code. Steps run in dependency batches (up to 4 at once). Any unresolved argument or schema problem aborts the run.

### 2. Recording

Every agent tool call goes through the gateway, which projects the result and appends `{op, args, result, ok}` to the episode. At the end of a turn the episode is stored with the request, the final answer and a success flag. Failed and duplicate calls are dropped before mining. The trace store is sensitive; `purgeTraces` enforces retention.

### 3. Mining

1. **Loops and pages**: consecutive calls to one operation collapse into one step when an integer argument counts up and each page holds a list (pagination), or when one argument walks the elements of a list from an earlier result (forEach).
2. **Provenance per argument**: every place the value appears in an earlier result (both index forms; dynamic keys for map-like objects whose key appears in the request), whether it appears in the request (directly, or as a date after conversion), and as a constant.
3. **Answer derivations**: for JSON answers, each field is matched to a result path or to a reducer whose value equals it. For prose answers, the facts are result values that appear in the reply text and not in the request, plus numbers in the reply that a reducer reproduces. Null and zero answers constrain nothing (verification still checks them). Among equally consistent filters, the one whose value the requests mention wins.
4. **Response template** (prose answers): the first reply with each fact replaced by `{field}`, used to phrase direct answers.
5. **Cluster** by call sequence (including loop and page markers) and answer shape.
6. **Intersect** candidate sets across the cluster; keep the best consistent option (step reference, then request input, then reducer, then constant; later steps and shorter paths first).
7. **Coincidence rule**: a request value that never varied becomes a constant.
8. **Support**: at least 3 successful episodes; newest third held out when the cluster is large enough. Episodes marked failed by feedback are excluded.
9. **Verify**: replay the plan for every member episode. JSON outputs must equal the recorded answers; prose answers must contain every returned fact. Write plans never execute during verification: the proposed call must equal the recorded one.

### 4. Catalog maintenance

- **Reinforce**: a candidate identical to, or reproduced by, an active route with the same shape adds examples, episodes and verified values to that route.
- **Consolidate (merge)**: routes with the same skeleton whose constants differ become one route with typed placeholders and a verified-value list. Members are retired and point to the merged route. Every member episode is replayed through the merged plan first.
- **Categories**: routes sharing a first step (operation and argument sources) get a category id.
- **Prefix statistics**: share of episodes starting with a route's first call that complete the route; gates speculation.

### 5. Promotion

`shadow` → (N agreements, 0 disagreements) → ready → approval → `live`. A disagreement retires the route. Approval can widen verified-value lists to the full type (`widenOnApprove`). Defaults: `shadowTarget` 3 in the bench; use 20 or more in production.

### 6. Routing

1. Retrieve up to 3 live or shadow routes with hybrid search: TF-IDF (score ≥ 0.12) or embeddings (cosine ≥ 0.45) can shortlist; ranking uses their average. The default embedding is local (hashed stemmed words plus character trigrams, no service); a profile can supply `embed(text)` for a real embedding model. No candidate means no model call.
2. Template match: past example wording with the input values replaced by capture groups. Free.
3. Otherwise one small model call picks a route and fills typed inputs, or returns null, optionally naming a related route about the same record.
4. Gate: types and verified-value lists; every request-sourced value must appear in the request; a learned filter value (e.g. "delivered") must be mentioned; any modifier word ("first", "cancel", "unavailable", "zip", …) not in the route's vocabulary declines; terms belonging only to a competing route (retrieval score within 75%) decline.
5. Partial reuse: when the request is declined but is about the same record as a live read-only route (values pass the gate), that route's steps run and their projected results (up to about 6 KB) go to the model as prefetched data, so it can answer with fewer tool calls.

### 7. Serving modes

| Mode | When | Model calls |
| --- | --- | --- |
| **Inject (default)** | Every live read hit | One answer-writing turn; no tool calls needed |
| Direct (opt-in, `answerMode: 'direct'`) | Own agent, live hit, no attention rule fired, result saved to carry | 0 |
| Show-and-carry (opt-in, `WORKFLOW_REPLAY_MODE=carry`) | Claude Code / Codex, same conditions | 0 |
| Approve | Live hit on a write workflow | 0 to prepare; the action runs only after approval |
| Fallback | Miss, decline, shadow route or replay failure | Ordinary agent with projected tools, `run_workflow`, speculation and any prefetched data |

By default the model writes every answer, so it can check the result, use the conversation's context and phrase the reply. The harness hands it a compact receipt for the current request: only the fields the workflow returns, labelled (for example `item_count=5; total=3819.12`). No raw records, and no tool calls needed. The zero-model modes stay available as opt-ins, and unusual results always go to the model with a note on what is unusual.

- **Own agents:** make the answer call lean. Send a short answering instruction, the conversation so far and the receipt, with no tool list (`handle()` returns `receipt` and `previous` separately for this). An earlier version that re-sent the full agent prompt and tools, with the receipt labelled as earlier context, cost far more, and the model often re-fetched the data anyway.
- **Claude Code / Codex:** the host always sends its own system prompt and tools. The receipt arrives as added context, so the saving there is the tool calls and raw results the model no longer needs.

Attention rules are generated per route: a field that was never null, a low-cardinality text field that gets an unseen value, or a number that was never zero.

### 8. Mid-turn routing

- `run_workflow` lists up to 12 live routes compactly in its description; with more, the description stays short and a `find_workflow(query)` tool searches them. The model can call one instead of several atomic tools.
- Speculation: when an agent's tool call matches the first step of a live route whose inputs are all bound by that call, and the route's prefix rate is at least 0.9, the gateway runs the whole route and attaches its output to that tool result.
- Both paths pass the same gate as pre-model routing, checked against the user's request (values may also come from carried context on follow-ups). A refused `run_workflow` call returns an error telling the model to use the other tools. This was added after the first benchmark run showed the model calling the "latest order" workflow for a "very first order" question.
- Where the gateway is not told the request (plain MCP use without the prompt hook), speculation is off and `run_workflow` relies on the model's judgement alone.

### 9. Writes and the approval ledger

- Register write operations with `effect: "write"`. The gateway refuses them unless the host's own approval path is in use (`allowWrites`, set by the MCP gateway, which marks write tools destructive so Claude Code asks the user before each call).
- A learned write workflow never runs from the router, the compiled tool or speculation. They return a proposal: the exact operation and arguments, computed from fresh reads.
- `commit(proposal, {principal, approve})` checks the proposal hash and principal, expires after 10 minutes, calls the trusted `approve` callback (never a model tool), claims the ledger row atomically and runs the call at most once. Outcomes: `completed`, `declined`, `unknown` (the call may have happened; check before retrying). The CLI's `commit` command asks for typed approval in the terminal.
- **In Claude Code**, the model passes the proposal id to `commit_workflow_action`. Before anything runs, the gateway reads the user's Claude Code permission settings (managed, `--settings` files listed in `WORKFLOW_REPLAY_CLAUDE_SETTINGS`, project local, project, user) for the underlying write tool, `mcp__workflow-replay__<op>`:
  - **deny** rule: refused.
  - **allow** rule, or `bypassPermissions` mode: runs once.
  - Anything else: **the user is asked first**, through an MCP elicitation prompt. If the client can't show one, the gateway returns the exact call and the model must call the write tool itself, which brings up Claude Code's own permission prompt.
  - Permissions granted interactively during a session aren't visible to this check, so it can only be stricter than Claude Code, never looser.
- The prompt hook turns a matching write request into a proposal and tells the model to use `commit_workflow_action`. Nothing runs at prompt time.
- Learned write workflows are never auto-promoted, even with `autoApprove`; a person approves them with `cli.mjs approve`.
- Read-only systems such as the company ERP must not register any write operation. `wrap.mjs --read-only` drops them when generating a profile.

### 11. Hands-free learning in hosts

- The prompt hook remembers a shadow-mode match per session. The `Stop` hook compares the workflow's answer with Claude's reply: every fact the workflow returns must appear in the reply (numbers match with or without thousands separators).
- Every `learnEvery` recorded turns (default 5), the `Stop` hook mines, verifies, consolidates, updates prefix statistics and purges traces older than `retentionDays` (default 30). The newest turn waits one round, so a correction in the next prompt can still mark it failed.
- Host defaults (`src/v2/hosts/profile.mjs`): `autoApprove: true` for read-only workflows, `shadowTarget: 5`. A profile can override them with `export const policy = { … }`.
- `SessionEnd` → `claude-hook.mjs end` deletes the session's carried results and pending files.

### 12. Wrapping existing services

```bash
node src/v2/hosts/wrap.mjs mcp NAME --read-only -- <server command> [args]
```

```bash
node src/v2/hosts/wrap.mjs openapi NAME --spec api.json --base https://api.example.com --token-env API_TOKEN
```

- MCP: connects, lists tools and labels each one: `readOnlyHint` gives read, `destructiveHint` gives write, otherwise the leading verb (get, list, search… gives read; create, update, cancel… gives write). **Anything unclear is labelled write.** Optional arguments are kept optional.
- OpenAPI (JSON): GET and HEAD are read, other methods write. Path, query and top-level JSON body fields become arguments. The base must be HTTPS (loopback HTTP is allowed for testing). Redirects are refused and responses are capped at 1 MB.
- The generated profile lists every operation with its label and the reason, for review before use.

### 13. Phase 0: measure first

```bash
node src/v2/hosts/analyze.mjs
```

Scans `~/.claude/projects/*/*.jsonl` and prints aggregates only: turns, tool use, real token usage, and the share of turns that are read-only, fetch external data (MCP or web) and repeat a call shape at least 3 times. It also estimates a savings ceiling. Prompts are shown only with `--show-prompts`.

On this machine's 97 transcripts (596 turns, mostly coding work), 0.5% of turns (3 repeated web searches) were replayable, so the savings ceiling is about 0%. The harness is not worth deploying for this kind of traffic. API reads done through Bash (curl or scripts) are not detected; they count as not replayable.

### 10. Success signal

- `feedback(episode, success)` sets the flag used by mining. The CLI exposes it (`feedback EPISODE good|bad`).
- The Claude Code hook marks the previous turn failed when the next prompt starts with a correction ("no", "wrong", "that's not right", "try again", …).

## Live check in Claude Code

Run on Claude Code 2.1.319 with `claude -p`, a temporary profile over the τ²-bench data, hooks and the MCP gateway passed with `--settings` and `--mcp-config` (the user's own configuration was not changed):

| Check | Result |
| --- | --- |
| Inject (default) on a repeat request | Correct answer in 1 turn, no tool calls; the model said it used the saved workflow result |
| Show-and-carry (`WORKFLOW_REPLAY_MODE=carry`) | Prompt blocked by the hook, answer shown, 0 model turns, $0; result saved under the session id |
| Follow-up in the same session (`--resume`) | Carried result delivered; the model used the order id from it, made one gateway call and answered correctly (Digital Camera, $2,850.32) |
| `Stop` hook | Recorded the follow-up turn (request, gateway call, reply) as a minable episode |
| Write, no allow rule for the write tool | "Please cancel order #W6779827": the hook prepared a proposal and the model called `commit_workflow_action`. The gateway found no allow rule and asked the user; headless `-p` can't show the prompt, so it was declined. Nothing ran (ledger: `declined`, no write logged) |
| Write, allow rule for the write tool | "Please cancel order #W7619352": the permission check passed and the cancellation ran exactly once (ledger: `completed`, one write logged) |

The writes ran against an in-memory copy of the τ²-bench data. The interactive elicitation prompt itself was not exercised: headless mode declines it, and an interactive session is needed to see it.

Codex was not tested; it uses the same `UserPromptSubmit` payload, but check its hook documentation before relying on blocking.

## Using it

```bash
npm run bench:v2:fetch
```

```bash
npm test
```

```bash
npm run bench:v2 -- --repeats 2 --workers 4
```

For your own service:
1. Run `analyze.mjs` to check that enough of your traffic repeats.
2. Generate a profile with `wrap.mjs` (or write one; see `src/v2/hosts/profile.mjs` for the exports) and review its read/write labels.
3. Register `src/v2/hosts/mcp-gateway.mjs --profile NAME` as an MCP server named `workflow-replay`.
4. Add the hooks: `claude-hook.mjs prompt --profile NAME` on `UserPromptSubmit`, `claude-hook.mjs stop --profile NAME` on `Stop`, and `claude-hook.mjs end --profile NAME` on `SessionEnd`.

Learning, shadow checks and promotion of read-only workflows then run by themselves. Approve write workflows with `cli.mjs NAME approve ROUTE`.

## Remaining gaps

- No arbitrary script plans. Loops, pagination, filters and reducers cover the common cases declaratively; logic beyond them (branching, nested reductions such as a sum of per-order totals) falls back to the agent.
- A loop must have at least two calls in a trace to be detected; single-element lists produce a separate, non-loop cluster.
- The local embedding is lexical-semantic (shared words and word pieces), not a trained model. Plug in a real one via `embed` for synonyms with no shared letters.
- The correction detector is a fixed phrase list; explicit feedback through the CLI or your app is more reliable.
- Codex hooks are untested.
- No installer yet: hooks and the MCP entry are added to settings by hand.
- The analyzer can't classify API reads made through Bash.
- OpenAPI wrapping reads JSON specs only (no YAML) and flattens only top-level body fields.
- The interactive elicitation prompt for writes hasn't been seen in a live interactive session (headless mode declines it, which is the safe outcome).
