import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { capture, httpDispatcher, requireThat } from '../src/workflow.mjs';
import { openPlaybook, publish } from '../src/playbook.mjs';
import { arms, episode, maxTokens, maxTurns, modelArkClient, temperature } from './agent.mjs';
import { registry, startEvalFixture } from './fixture.mjs';
import { schedule, summarize } from './metrics.mjs';
import { cases, families } from './tasks.mjs';
import { auditCases, auditCollect, auditHttpTools, withAuditCollector } from './audit.mjs';
import { routeRequest } from '../src/host-routing.mjs';
import { learnAudit } from './learn.mjs';
import { historicalFxFamily, paraphraseCases } from './paraphrases.mjs';

function integer(value, min, max, name) {
  const number = Number(value);
  requireThat(Number.isInteger(number) && number >= min && number <= max, `${name} must be an integer from ${min} to ${max}`);
  return number;
}

const percentage = value => value === null ? '—' : `${(100 * value).toFixed(1)}%`;

async function main() {
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean' },
    'host-routed': { type: 'boolean' },
    'collector-ablation': { type: 'boolean' },
    paraphrases: { type: 'boolean' },
    list: { type: 'boolean' },
    family: { type: 'string', multiple: true },
    repeats: { type: 'string', default: '3' },
    workers: { type: 'string', default: '4' },
    seed: { type: 'string', default: '20261108' },
  } });
  const ablation = values['collector-ablation'];
  const wording = values.paraphrases;
  requireThat(!(ablation && wording), 'Select either collector ablation or paraphrases');
  const availableCases = wording ? paraphraseCases
    : ablation ? auditCases : values['host-routed'] ? [...cases, ...auditCases] : cases;
  const modes = ablation ? ['direct-projected', 'direct-collector', 'host-routed']
    : wording || values['host-routed'] ? ['direct-projected', 'host-routed'] : arms;
  for (const family of values.family ?? []) {
    requireThat(availableCases.some(entry => entry.family === family || entry.group === family), `Unknown task family ${family}`);
  }
  const selected = availableCases.filter(item => !values.family
    || values.family.includes(item.family) || values.family.includes(item.group));
  if (values.list) {
    for (const item of selected) console.log(`${item.id} · ${item.source}\n  ${item.prompt.replace('\n', '\n  ')}`);
    return;
  }
  const repeats = integer(values.repeats, 1, 8, 'repeats');
  const workers = integer(values.workers, 1, 6, 'workers');
  const seed = integer(values.seed, 0, 4294967295, 'seed');
  const plan = schedule(selected, repeats, modes, seed);
  const model = process.env.ARK_MODEL || 'deepseek-v4-1-flash-261017';
  const complete = values['dry-run'] ? null : modelArkClient({
    key: process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY, model,
  });
  const total = plan.length * modes.length;
  console.log(`ModelArk ${model} · ${selected.length} prompts · ${repeats} repeats · ${total} episodes · seed ${seed}`);
  const db = openPlaybook(':memory:');
  const fixture = await startEvalFixture();
  const httpRegistry = new Map([...registry, ...auditHttpTools]);
  const replayRegistry = new Map([...httpRegistry, ['audit_collect.v1', auditCollect]]);
  const dispatch = httpDispatcher(fixture.origin, httpRegistry);
  const route = (request, countedDispatch, choose) => routeRequest({
    request, searchText: request.split('\n', 1)[0], db, registry: replayRegistry, dispatch: countedDispatch, choose,
    match: wording ? undefined : text => {
      // This command form opts in to the workflow's documented fixed output contract.
      const [command, ...contract] = text.split('\n');
      const match = /^Run the overdue shipment audit for batch (AUD-[0-9]+[A-Z])\.$/.exec(command);
      const compatible = contract.length === 0 || contract.join('\n') === auditCases[0].prompt.split('\n').slice(1).join('\n');
      return match && compatible ? { route: 'shipment-audit', inputs: { batch: match[1] } } : null;
    },
  });
  try {
    const seedFamilies = wording ? [...families, historicalFxFamily] : families;
    for (const family of seedFamilies.filter(entry => entry.saved)) {
      const { spec, seed: sample, description } = family.saved;
      const recorded = await capture(spec, sample, registry, dispatch);
      publish(db, family.id, description, recorded.workflow);
    }
    if (values['dry-run']) {
      console.log(`Seeded ${db.prepare('SELECT count(*) AS count FROM routes').get().count} routes from separate fixture records. No API calls.`);
      return;
    }
    mkdirSync('.replay', { recursive: true });
    const output = mkdtempSync(join('.replay', 'modelark-'));
    const metadata = { model, seed, repeats, workers, arms: modes, temperature, thinking: 'disabled', maxTurns, maxTokens };
    writeFileSync(join(output, 'run.json'), JSON.stringify({
      ...metadata, cases: selected,
      schedule: plan.map(({ item, ...block }) => ({ caseId: item.id, ...block })),
    }, null, 2));
    console.log(`Writing trial results to ${output}`);
    let learning;
    if (selected.some(item => item.family === 'shipment-audit')) {
      learning = await learnAudit({ complete, db, dispatch, registry: replayRegistry });
      writeFileSync(join(output, 'learning.json'), JSON.stringify(learning, null, 2));
      console.log(`Published audit from live discovery and compilation · ${learning.compileUsage.total} extra model tokens`);
    }
    const rows = [];
    let next = 0;
    let failure;
    async function worker() {
      while (!failure && next < plan.length) {
        const block = next++;
        const { item, repeat, arms: order } = plan[block];
        for (const arm of order) {
          if (failure) return;
          try {
            const row = {
              ...await episode({ item, arm, complete, db, dispatch, route, extendDispatch: withAuditCollector }),
              repeat, block, group: item.group, variant: item.variant, origin: item.origin,
            };
            rows.push(row);
            appendFileSync(join(output, 'trials.jsonl'), JSON.stringify(row) + '\n');
            if (rows.length % 9 === 0 || rows.length === total) console.log(`Completed ${rows.length}/${total} episodes`);
          } catch (error) {
            failure ??= error;
            return;
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(workers, plan.length) }, () => worker()));
    const summary = summarize(rows, repeats, modes, learning);
    writeFileSync(join(output, 'summary.json'), JSON.stringify({
      ...metadata, planned: total, completed: rows.length, models: [...new Set(rows.map(row => row.model).filter(Boolean))],
      error: failure?.message, ...summary,
    }, null, 2));
    console.table(Object.fromEntries(Object.entries(summary.byArm).map(([arm, row]) => [arm, {
      correct: `${row.correct}/${row.trials}`, [`pass^${repeats}`]: percentage(row.passAll),
      'answer agreement': percentage(row.answerAgreement), 'trace agreement': percentage(row.traceAgreement),
      'mean tokens': Math.round(row.meanTokens ?? 0), 'median ms': row.medianMs, 'median turns': row.medianTurns,
    }])));
    for (const [baseline, result] of Object.entries(summary.pairedSavings)) {
      console.log(`Replay savings vs ${baseline}: ${percentage(result.fractionSaved)} across ${result.pairs} jointly correct pairs`);
    }
    const replay = summary.byArm['host-routed'] ?? summary.byArm.replay;
    console.log(`Replay expected-route hits: ${replay.expectedRouteHits}/${replay.eligibleRouteTrials}; unexpected routes: ${replay.unexpectedRouteTrials}`);
    if (summary.wording) {
      console.table(Object.fromEntries(Object.entries(summary.wording.byArm).map(([arm, row]) => [arm, {
        'cross-wording agreement': percentage(row.agreement),
        'all four correct': `${row.allCorrect}/${row.completeBlocks}`,
        'groups always correct': `${row.alwaysCorrect}/${row.completeGroups}`,
      }])));
    }
    for (const [size, stats] of Object.entries(summary.bySize)) {
      const results = modes.map(arm => {
        const statsForArm = stats[arm];
        return `${arm} ${Math.round(statsForArm.meanTokens ?? 0)} tokens (${statsForArm.correct}/${statsForArm.trials})`;
      });
      console.log(`${size} records · ${results.join(' · ')} · break-even vs compact repeats: ${stats.payback?.repeatsToBreakEven ?? '—'}`);
    }
    console.log(`Detailed results: ${join(output, 'summary.json')}`);
    if (failure) throw failure;
  } finally {
    db.close();
    await fixture.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
