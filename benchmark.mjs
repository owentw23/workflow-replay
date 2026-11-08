import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Tiktoken } from 'js-tiktoken/lite';
import encoding from 'js-tiktoken/ranks/o200k_base';
import { registry, startFixture } from './src/fixture.mjs';
import { load, lookup, openPlaybook, publish } from './src/playbook.mjs';
import { capture, execute, httpDispatcher, json } from './src/workflow.mjs';

const tokenizer = new Tiktoken(encoding);
const workflow = JSON.parse(readFileSync(new URL('./examples/account-health.json', import.meta.url)));
const route = 'account-health';
const description = 'Customer account health with billing and support';
const goal = 'Get customer account health';
const expected = {
  'alpha-demo': { tier: 'pro', overdue: 2, open: 4 },
  'beta-demo': { tier: 'basic', overdue: 0, open: 1 },
};
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const tokens = events => events.reduce((sum, event) => sum + tokenizer.encode(json(event)).length, 0);
const modes = ['serial raw', 'parallel raw', 'parallel projected', 'lookup + replay', 'known route'];

async function benchmark(verbose) {
  const fixture = await startFixture({ verbose });
  const dispatch = httpDispatcher(fixture.origin, registry);
  const db = openPlaybook(':memory:');
  const firstInput = { customer: 'alpha-demo' };
  try {
    const learningStart = performance.now();
    const learned = await capture(workflow, firstInput, registry, dispatch);
    const published = publish(db, route, description, learned.workflow);
    const learningMs = Math.round(performance.now() - learningStart);
    assert.deepEqual(learned.result, expected[firstInput.customer]);
    // Standalone learn CLI envelope, used only in the amortization calculation.
    const learningTokens = tokens([
      { tool: 'learn', route, description, workflow, inputs: firstInput },
      { ...published, result: learned.result },
    ]);

    async function trial(mode, customer) {
      const inputs = { customer };
      const startCalls = fixture.events.length;
      const transcript = [];
      const start = performance.now();
      let result;
      let batches = 0;
      if (mode === 'lookup + replay' || mode === 'known route') {
        if (mode === 'lookup + replay') {
          const candidates = lookup(db, goal);
          assert.equal(candidates[0]?.route, route);
          transcript.push({ tool: 'lookup', goal }, candidates);
          batches++;
        }
        result = await execute(load(db, route), inputs, registry, dispatch);
        transcript.push({ tool: 'run', route, inputs }, result);
        batches++;
      } else {
        result = await execute(workflow, inputs, registry, dispatch, {
          concurrency: mode === 'serial raw' ? 1 : 4,
          onBatch(calls, replies) {
            const callsVisible = calls.map(({ step, args }) => ({ tool: step.op, args }));
            const resultsVisible = replies.map(reply => mode === 'parallel projected' ? reply.data : reply.raw);
            // Call and result envelopes are counted separately, including singleton batches.
            transcript.push(callsVisible, resultsVisible);
            batches++;
          },
        });
      }
      const ms = performance.now() - start;
      assert.deepEqual(result, expected[customer]);
      return { ms, exchanges: batches, requests: fixture.events.length - startCalls, tokens: tokens(transcript) };
    }

    const samples = new Map(modes.map(mode => [mode, []]));
    for (const mode of modes) await trial(mode, firstInput.customer);
    for (let iteration = 0; iteration < 7; iteration++) {
      for (const offset of modes.keys()) {
        const mode = modes[(iteration + offset) % modes.length];
        samples.get(mode).push(await trial(mode, iteration % 2 ? 'alpha-demo' : 'beta-demo'));
      }
    }
    const rows = [...samples].map(([mode, trials]) => ({
      mode,
      'median ms': Math.round(median(trials.map(trial => trial.ms))),
      'tool exchanges': trials[0].exchanges,
      'HTTP requests': trials[0].requests,
      'tool text tokens': median(trials.map(trial => trial.tokens)),
    }));
    console.log(`\n${verbose ? 'Verbose' : 'Lean'} fixture | 7 trials per mode after warmup`);
    console.table(rows);
    console.log(`Standalone learn · ${learningMs} ms · ${learningTokens} tool text tokens · 3 HTTP requests`);
    for (const replay of rows.slice(3)) {
      for (const baseline of rows.slice(0, 3)) {
        const delta = baseline['tool text tokens'] - replay['tool text tokens'];
        const repeats = delta > 0 ? Math.ceil(learningTokens / delta) : 'none';
        console.log(`  ${replay.mode} vs ${baseline.mode} · saved ${delta} tokens/run · payback repeats: ${repeats}`);
      }
    }
  } finally {
    db.close();
    await fixture.close();
  }
}

console.log('Local loopback benchmark. o200k_base counts serialized tool payloads only.');
console.log('Latency excludes model calls. Each replay makes the same live HTTP requests.');
await benchmark(true);
await benchmark(false);

const catalog = openPlaybook(':memory:');
try {
  // Use synthetic route aliases and five distinct output contracts to isolate index growth.
  for (let index = 0; index < 1000; index++) {
    const plan = { ...workflow, output: { [`tier-${index % 5}`]: workflow.output.tier } };
    publish(catalog, `cohort-${index}`, `Account health for catalog${index}`, plan);
  }
  const plans = catalog.prepare('SELECT count(*) AS count FROM plans').get().count;
  const graphs = catalog.prepare('SELECT count(*) AS count FROM graphs').get().count;
  const routes = catalog.prepare('SELECT count(*) AS count FROM routes').get().count;
  assert.equal(plans, 5);
  assert.equal(graphs, 1);
  const samples = Array.from({ length: 100 }, (_, index) => {
    const start = performance.now();
    const candidates = lookup(catalog, `account health catalog${index * 10}`);
    assert.equal(candidates[0]?.route, `cohort-${index * 10}`);
    return performance.now() - start;
  });
  console.log(`\nCatalog · ${routes} routes · ${plans} plans · ${graphs} shared graph · ${median(samples).toFixed(2)} ms median lookup`);
} finally {
  catalog.close();
}
