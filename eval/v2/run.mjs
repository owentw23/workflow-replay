// v2 test bench: with vs without the harness, on τ²-bench retail and airline records, using DeepSeek V4.1 Flash.
//
//   node --env-file-if-exists=cred.env eval/v2/run.mjs [--repeats 2] [--workers 4] [--limit N] [--seed S]
//        [--learned <store.sqlite>]   reuse a learned catalog and skip the learning phase
//
// Phase L (learning, harness only): normal agent traffic is recorded through the gateway, mined after each batch,
// consolidated, then routes earn promotion in shadow mode. Phase T (test, learning frozen): every test item runs
// in three arms, in randomized order: baseline-raw (atomic tools, full records), baseline-projected (atomic
// tools through the gateway's projection) and harness (router + replay + carry + compiled tools + speculation).
import { copyFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createHarness } from '../../src/v2/harness.mjs';
import { openStore, listRoutes } from '../../src/v2/store.mjs';
import { canonical, sameAnswer } from '../../src/v2/util.mjs';
import { createService, loadData, project, registry } from './tau2-service.mjs';
import { buildTasks } from './tasks.mjs';
import { MODEL, MAX_TOKENS, TEMPERATURE, SYSTEM, addUsage, agentTurn, createModel, emptyUsage, extractor, formatLine } from './agent.mjs';
import { summarize, renderReport } from './report.mjs';

const { values: options } = parseArgs({ options: {
  repeats: { type: 'string', default: '2' }, workers: { type: 'string', default: '4' }, limit: { type: 'string' },
  seed: { type: 'string', default: '20261109' }, learned: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
const repeats = Number(options.repeats);
const workers = Number(options.workers);
const seed = Number(options.seed);

const data = loadData();
const service = createService(data);
const tasks = buildTasks(data, { seed });
const ARMS = ['baseline-raw', 'baseline-projected', 'harness'];
let testItems = tasks.test;
if (options.limit) testItems = shuffle([...testItems], seed).slice(0, Number(options.limit));

if (options['dry-run']) {
  console.log(JSON.stringify({ learning: tasks.learning.batches.map(b => b.length), shadow: tasks.learning.shadow.length,
    test: testItems.length, repeats, arms: ARMS, episodes: testItems.length * repeats * ARMS.length }, null, 2));
  process.exit(0);
}

const runDir = new URL(`../../.replay/v2-${randomBytes(3).toString('hex')}/`, import.meta.url);
mkdirSync(runDir, { recursive: true });
const storePath = new URL('catalog.sqlite', runDir);
if (options.learned) copyFileSync(options.learned, storePath);
const complete = createModel();
const store = openStore(storePath.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const harness = createHarness({ registry, upstream: service, project, store, extract: extractor(complete),
  policy: { autoApprove: true, widenOnApprove: true, shadowTarget: 3 } });
const log = line => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
writeFileSync(new URL('run.json', runDir), JSON.stringify({ model: MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS,
  seed, repeats, workers, arms: ARMS, testItems: testItems.map(item => item.id), started: new Date().toISOString(),
  dataset: 'τ²-bench retail + airline db.json @ 033bf082 (MIT)', learnedFrom: options.learned ?? null }, null, 2));

function shuffle(items, s) {
  let state = s >>> 0;
  for (let i = items.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(state / 2 ** 32 * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function pool(items, size, worker) {
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const ANSWER_SYSTEM = 'You are a support assistant. Answer the request using the data provided for it and the conversation so far. '
  + 'Reply with only a JSON object with exactly the requested keys. Use null only where the data has no value. Write numbers as JSON numbers.';

const userContent = (request, keys, context) =>
  (context ? `[Context from earlier in this session]\n${context}\n\n[Request]\n` : '') + request + formatLine(keys);

// ---------------- Arms ----------------
async function baselineEpisode(item, arm) {
  const usage = emptyUsage();
  const messages = [{ role: 'system', content: SYSTEM }];
  const gate = harness.gateway({ request: item.request ?? item.turns[0].request, record: false, speculate: false });
  const tools = harness.toolSpecs({ includeWorkflows: false });
  let upstream = 0;
  const invoke = async (name, args) => {
    if (!registry.has(name)) return { error: 'Unknown tool' };
    upstream++;
    if (arm === 'baseline-raw') return service(name, args);
    return gate.call(name, args);
  };
  const turns = [];
  for (const turn of item.turns ?? [item]) {
    messages.push({ role: 'user', content: userContent(turn.request, turn.keys) });
    const result = await agentTurn({ complete, messages, tools, invoke, usage });
    turns.push({ correct: sameAnswer(result.answer, turn.gold) && Object.keys(result.answer ?? {}).length === turn.keys.length,
      answer: result.answer, mode: 'agent', modelTurns: result.turns, tools: result.trace });
  }
  return { usage, turns, upstream };
}

async function harnessEpisode(item, session) {
  const usage = emptyUsage();
  const messages = [{ role: 'system', content: SYSTEM }];
  const turns = [];
  let upstream = 0;
  for (const turn of item.turns ?? [item]) {
    const decision = await harness.handle(turn.request, { session, host: { canBlock: true, direct: true } });
    addUsage(usage, decision.routerUsage);
    const routerInfo = { kind: decision.decision.kind, reason: decision.decision.reason, method: decision.decision.method,
      route: decision.route ?? decision.decision.route };
    if (decision.mode === 'direct' || decision.mode === 'carry') {
      turns.push({ correct: sameAnswer(decision.output, turn.gold) && Object.keys(decision.output).length === turn.keys.length,
        answer: decision.output, mode: decision.mode, router: routerInfo, modelTurns: 0, tools: [] });
      continue;
    }
    if (decision.mode === 'inject') {
      // Lean answer call: the model writes the answer from the receipt and the conversation so far; no tool list.
      const content = [decision.previous && `[Earlier in this session]\n${decision.previous}`,
        `[Data for this request]\n${decision.receipt}`, `[Request]\n${turn.request}${formatLine(turn.keys)}`].filter(Boolean).join('\n\n');
      messages.push({ role: 'user', content });
      const response = await complete({ messages: [{ role: 'system', content: ANSWER_SYSTEM }, ...messages.slice(1)] });
      addUsage(usage, response.usage);
      const text = response.choices?.[0]?.message?.content ?? '';
      messages.push({ role: 'assistant', content: text });
      let answer = null;
      try { answer = JSON.parse(text); } catch { /* scored as wrong */ }
      turns.push({ correct: sameAnswer(answer, turn.gold) && Object.keys(answer ?? {}).length === turn.keys.length,
        answer, mode: 'inject', router: routerInfo, modelTurns: 1, tools: [] });
      continue;
    }
    const gate = harness.gateway({ request: turn.request, context: decision.context, record: false, speculate: true });
    const invoke = async (name, args) => {
      if (name === 'run_workflow') return gate.runWorkflow(args.route, args.inputs ?? {});
      if (name === 'find_workflow') return gate.findWorkflow(args.query);
      if (!registry.has(name)) return { error: 'Unknown tool' };
      upstream++;
      return gate.call(name, args);
    };
    messages.push({ role: 'user', content: userContent(turn.request, turn.keys, decision.context) });
    const result = await agentTurn({ complete, messages, tools: harness.toolSpecs(), invoke, usage });
    turns.push({ correct: sameAnswer(result.answer, turn.gold) && Object.keys(result.answer ?? {}).length === turn.keys.length,
      answer: result.answer, mode: decision.mode, partial: decision.partial ?? null, router: routerInfo, modelTurns: result.turns, tools: result.trace });
  }
  return { usage, turns, upstream };
}

// ---------------- Phase L: learning ----------------
const learning = { batches: [], shadow: null, usage: emptyUsage(), overhead: emptyUsage(), routes: null };
async function learningEpisode(item) {
  const usage = emptyUsage();
  const gate = harness.gateway({ request: item.request, record: true, speculate: false });
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent(item.request, item.keys) }];
  const result = await agentTurn({ complete, messages, tools: harness.toolSpecs({ includeWorkflows: false }),
    invoke: (name, args) => (registry.has(name) ? gate.call(name, args) : { error: 'Unknown tool' }), usage });
  const success = sameAnswer(result.answer, item.gold);
  gate.finish(result.answer, { success });
  return { usage, success };
}
const merge = (target, usage) => { for (const key of Object.keys(target)) target[key] += usage[key]; };

if (!options.learned) {
  for (const [index, batch] of tasks.learning.batches.entries()) {
    log(`learning batch ${index + 1}: ${batch.length} episodes`);
    const results = await pool(batch, workers, learningEpisode);
    results.forEach(result => merge(learning.usage, result.usage));
    const mined = await harness.learn();
    learning.batches.push({ episodes: batch.length, successful: results.filter(r => r.success).length,
      candidates: mined.candidates, rejected: mined.rejected, consolidated: mined.consolidated });
    log(`  ${results.filter(r => r.success).length}/${batch.length} correct; candidates ${mined.candidates.length}, `
      + `rejected clusters ${mined.rejected.length}, merges ${mined.consolidated.filter(c => c.merged).length}`);
  }
  log(`shadow phase: ${tasks.learning.shadow.length} requests`);
  const shadowResults = await pool(tasks.learning.shadow, workers, async item => {
    const usage = emptyUsage();
    const decision = await harness.handle(item.request, { session: `shadow-${randomBytes(4).toString('hex')}` });
    addUsage(usage, decision.routerUsage);
    addUsage(learning.overhead, decision.routerUsage);
    const episode = await learningEpisode(item);
    merge(usage, episode.usage);
    let agreed = null;
    if (decision.shadow) agreed = await harness.shadow(decision.shadow.route, decision.shadow.inputs, item.gold);
    return { usage, kind: decision.decision.kind, reason: decision.decision.reason, agreed };
  });
  shadowResults.forEach(result => merge(learning.usage, result.usage));
  learning.shadow = shadowResults.map(({ kind, reason, agreed }) => ({ kind, reason, agreed }));
  const final = await harness.learn();
  learning.final = { candidates: final.candidates, consolidated: final.consolidated };
}
learning.routes = listRoutes(store).map(route => ({ id: route.id, state: route.state, description: route.description,
  inputs: route.plan.inputs, outputs: Object.keys(route.plan.output), steps: route.plan.steps.map(step => step.op),
  shadow: route.stats.shadow, prefix: route.stats.prefix, mergedFrom: route.stats.mergedFrom, mergedInto: route.merged_into }));
writeFileSync(new URL('learning.json', runDir), JSON.stringify(learning, null, 2));
log(`routes: ${learning.routes.map(r => `${r.id}=${r.state}`).join(', ')}`);

// ---------------- Phase T: test ----------------
harness.settings.record = false;
const blocks = shuffle(Array.from({ length: repeats }, (_, repeat) => testItems.map(item => ({ item, repeat }))).flat(), seed + 1)
  .map(block => ({ ...block, arms: shuffle([...ARMS], seed + block.repeat * 7919 + block.item.id.length) }));
const trialsFile = new URL('trials.jsonl', runDir);
let done = 0;
const trials = (await pool(blocks, workers, async ({ item, repeat, arms }) => {
  const rows = [];
  for (const arm of arms) {
    const start = performance.now();
    let outcome;
    try {
      outcome = arm === 'harness' ? await harnessEpisode(item, `t-${item.id}-${repeat}-${randomBytes(3).toString('hex')}`)
        : await baselineEpisode(item, arm);
    } catch (error) {
      outcome = { usage: emptyUsage(), turns: [], upstream: 0, error: error.message };
    }
    const row = { arm, id: item.id, family: item.family, kind: item.kind, expectedHit: item.expectedHit, repeat,
      correct: !outcome.error && outcome.turns.length === (item.turns ?? [item]).length && outcome.turns.every(t => t.correct),
      ...outcome, ms: Math.round(performance.now() - start) };
    appendFileSync(trialsFile, canonical(row) + '\n');
    rows.push(row);
  }
  if (++done % 10 === 0) log(`test blocks ${done}/${blocks.length}`);
  return rows;
})).flat();

const summary = summarize(trials, learning, { arms: ARMS, repeats });
writeFileSync(new URL('summary.json', runDir), JSON.stringify(summary, null, 2));
writeFileSync(new URL('REPORT.md', runDir), renderReport(summary, { model: MODEL, runDir: runDir.pathname }));
log(`done: ${runDir.pathname}`);
for (const arm of ARMS) {
  const a = summary.arms[arm];
  log(`${arm}: accuracy ${(a.accuracy * 100).toFixed(1)}%, mean tokens ${Math.round(a.meanTokens)}, model calls ${a.meanModelCalls.toFixed(2)}`);
}
