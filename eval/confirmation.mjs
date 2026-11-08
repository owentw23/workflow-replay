import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { modelArkClient, temperature } from './agent.mjs';
import { confirmationEpisode } from './confirmation-agent.mjs';
import { confirmationCases, normalizeWeatherAnswer } from './confirmation-data.mjs';
import { weatherRegistry, weatherRoutes } from './confirmation-weather.mjs';
import { startEvalFixture } from './fixture.mjs';
import { schedule } from './metrics.mjs';
import { confirmationReport } from './confirmation-report.mjs';
import { indexRouteExamples, openPlaybook, publish } from '../src/playbook.mjs';
import { capture, httpDispatcher, json, requireThat } from '../src/workflow.mjs';

const arms = ['direct-projected', 'direct-collector', 'playbook-only', 'host-routed'];
const { values } = parseArgs({ options: {
  'dry-run': { type: 'boolean' },
  rescore: { type: 'string' },
  repeats: { type: 'string', default: '3' },
  seed: { type: 'string', default: '20261108' },
  workers: { type: 'string', default: '4' },
} });

function rescore(directory) {
  const { cases, schedule, ...metadata } = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
  const expected = new Map(cases.map(item => [item.id, json(item.expected)]));
  const original = readFileSync(join(directory, 'trials.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  requireThat(original.length === schedule.length * metadata.arms.length, 'Rescore requires a completed run');
  const rows = original.map(row => {
    const normalized = normalizeWeatherAnswer(row.normalized === null ? null : JSON.parse(row.normalized));
    return { ...row, normalized, correct: normalized === expected.get(row.caseId) };
  });
  const summary = confirmationReport(rows, metadata.repeats, metadata.arms);
  const output = join(directory, 'rescored-summary.json');
  writeFileSync(output, JSON.stringify({
    ...metadata, completed: rows.length, scoreChanges: rows.filter((row, i) => row.correct !== original[i].correct).length,
    cityAlias: 'New York City → New York', ...summary,
  }, null, 2));
  console.log(`Rescored ${rows.length} saved trials without API calls. Results in ${output}`);
}

if (values.rescore) rescore(values.rescore);
else await run();

async function run() {
  const repeats = Number(values.repeats);
  const seed = Number(values.seed);
  const workers = Number(values.workers);
  requireThat(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 8, 'Repeats must be 1–8');
  requireThat(Number.isSafeInteger(workers) && workers >= 1 && workers <= 6, 'Workers must be 1–6');
  requireThat(Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295, 'Seed must be a uint32');
  const plan = schedule(confirmationCases, repeats, arms, seed);
  const planned = plan.length * arms.length;
  const model = process.env.ARK_MODEL || 'deepseek-v4-1-flash-261017';
  const complete = values['dry-run'] ? null : modelArkClient({
    key: process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY, model,
  });
  const db = openPlaybook(':memory:');
  const fixture = await startEvalFixture(weatherRegistry);
  try {
    const dispatch = httpDispatcher(fixture.origin, weatherRegistry);
    const routes = weatherRoutes();
    for (const { route, description, examples, plan, seed } of routes) {
      const learned = await capture(plan, seed, weatherRegistry, dispatch);
      publish(db, route, description, learned.workflow);
      indexRouteExamples(db, route, examples);
    }
    console.log(`${model} · ${confirmationCases.length} fresh prompts · ${planned} episodes · seed ${seed}`);
    if (!complete) {
      console.log('Captured six seed plans on independent city lists. No API calls.');
    } else {
      mkdirSync('.replay', { recursive: true });
      const output = mkdtempSync(join('.replay', 'confirmation-'));
      const metadata = { model, seed, repeats, workers, arms, temperature, thinking: 'disabled', planned };
      writeFileSync(join(output, 'run.json'), JSON.stringify({
        ...metadata, cases: confirmationCases, schedule: plan.map(({ item, ...block }) => ({ caseId: item.id, ...block })),
      }, null, 2));
      console.log(`Writing results to ${output}`);
      const contracts = new Map(routes.map(({ route, contract }) => [route, contract]));
      const rows = [];
      let next = 0;
      let failure;
      async function worker() {
        while (!failure && next < plan.length) {
          const { item, repeat, arms: order } = plan[next++];
          for (const arm of order) {
            if (failure) return;
            try {
              const row = { ...await confirmationEpisode({
                item, arm, complete, db, registry: weatherRegistry, dispatch, contracts,
              }), repeat };
              rows.push(row);
              appendFileSync(join(output, 'trials.jsonl'), JSON.stringify(row) + '\n');
              if (rows.length % 24 === 0 || rows.length === planned) console.log(`Completed ${rows.length}/${planned}`);
            } catch (error) {
              failure ??= error;
              return;
            }
          }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => worker()));
      const summary = confirmationReport(rows, repeats, arms);
      writeFileSync(join(output, 'summary.json'), JSON.stringify({
        ...metadata, completed: rows.length, error: failure?.message, ...summary,
      }, null, 2));
      console.table(Object.fromEntries(Object.entries(summary.byArm).map(([arm, row]) => [arm, {
        correct: `${row.correct}/${row.trials}`, 'same answers': row.answerAgreement, 'all repeats pass': row.passAll,
        'mean tokens': Math.round(row.meanTokens ?? 0), 'median ms': row.medianMs, 'median turns': row.medianTurns,
      }])));
      console.table(summary.routeSafety);
      console.log(`Detailed results in ${join(output, 'summary.json')}`);
      if (failure) throw failure;
    }
  } finally {
    db.close();
    await fixture.close();
  }
}
