import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditCollect, auditDescription, auditHttpTools, withAuditCollector } from './audit.mjs';
import { registry, startEvalFixture } from './fixture.mjs';
import { historicalFxFamily, paraphraseCases } from './paraphrases.mjs';
import { contracts, expandRequest, requestExamples } from './routing-contracts.mjs';
import { routingCases } from './routing-cases.mjs';
import { families } from './tasks.mjs';
import { routeRequest } from '../src/host-routing.mjs';
import { indexRouteExamples, lookup, lookupWithExamples, openPlaybook, publish } from '../src/playbook.mjs';
import { capture, httpDispatcher, json, requireThat } from '../src/workflow.mjs';

const searchModes = {
  keyword: lookup,
  expanded: (db, text) => lookupWithExamples(db, text, expandRequest(text).slice(0, 256)),
};
const scopeRef = field => ({ step: 'scope', field });
const auditSpec = {
  version: 1, inputs: { batch: 'string' },
  steps: [
    { id: 'scope', op: 'audit_scope.v1', args: { batch: { input: 'batch' } } },
    { id: 'collect', op: 'audit_collect.v1', args: { key: scopeRef('key'), pages: scopeRef('pages') } },
  ],
  output: Object.fromEntries(Object.keys(auditCollect.fields).map(field => [field, { step: 'collect', field }])),
};

const db = openPlaybook(':memory:');
const fixture = await startEvalFixture();
try {
  const httpRegistry = new Map([...registry, ...auditHttpTools]);
  const workflowRegistry = new Map([...httpRegistry, ['audit_collect.v1', auditCollect]]);
  const http = httpDispatcher(fixture.origin, httpRegistry);
  const seedFamilies = [...families, historicalFxFamily, {
    id: 'shipment-audit', saved: { spec: auditSpec, seed: { batch: 'AUD-SEED' }, description: auditDescription },
  }];
  for (const { id, saved } of seedFamilies.filter(entry => entry.saved)) {
    const { workflow } = await capture(saved.spec, saved.seed, workflowRegistry, withAuditCollector(http));
    publish(db, id, saved.description, workflow);
    indexRouteExamples(db, id, requestExamples[id]);
  }

  const trials = [];
  for (const item of routingCases) {
    requireThat(!Object.values(requestExamples).flat().some(example => example.toLowerCase() === item.request.toLowerCase()),
      'A scored request appears in the index examples');
    for (const [mode, search] of Object.entries(searchModes)) {
      let httpCalls = 0;
      const dispatch = withAuditCollector((...args) => {
        httpCalls++;
        return http(...args);
      });
      const outcome = await routeRequest({
        request: item.request, db, registry: workflowRegistry, dispatch,
        local: { contracts, expand: expandRequest, search: mode === 'keyword' ? search : undefined },
      });
      trials.push({
        id: item.id, mode, expectedRoute: item.route, httpCalls, ...outcome,
        correct: item.route === null ? !outcome.route && !httpCalls
          : outcome.route === item.route && json(outcome.result) === json(item.expected),
      });
    }
  }

  const previous = paraphraseCases.filter(item => item.expectedRoute);
  const summary = Object.fromEntries(Object.entries(searchModes).map(([mode, search]) => {
    const positives = trials.filter(row => row.mode === mode && row.expectedRoute);
    const negatives = trials.filter(row => row.mode === mode && !row.expectedRoute);
    return [mode, {
      eligible: positives.length,
      shortlisted: positives.filter(row => row.candidates.includes(row.expectedRoute)).length,
      correctReplays: positives.filter(row => row.correct).length,
      wrongPositiveRoutes: positives.filter(row => row.route && row.route !== row.expectedRoute).length,
      nearMisses: negatives.length,
      nearMissesWithCandidates: negatives.filter(row => row.candidates.length).length,
      unsafeReplays: negatives.filter(row => row.route || row.httpCalls).length,
      previousEligible: previous.length,
      previousShortlisted: previous.filter(item => search(db, item.prompt.split('\n', 1)[0])
        .some(candidate => candidate.route === item.expectedRoute)).length,
    }];
  }));
  mkdirSync('.replay', { recursive: true });
  const output = mkdtempSync(join('.replay', 'routing-'));
  writeFileSync(join(output, 'results.json'), JSON.stringify({ summary, cases: routingCases, trials }, null, 2));
  console.table(summary);
  console.log(`Zero model calls. Results in ${join(output, 'results.json')}`);
  requireThat(Object.values(summary).every(row => !row.unsafeReplays && !row.wrongPositiveRoutes),
    'Unexpected workflow replay in routing suite');
} finally {
  db.close();
  await fixture.close();
}
