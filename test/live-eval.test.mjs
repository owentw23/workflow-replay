import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arms, episode } from '../eval/agent.mjs';
import { registry, startEvalFixture } from '../eval/fixture.mjs';
import { schedule, summarize } from '../eval/metrics.mjs';
import { cases, families } from '../eval/tasks.mjs';
import { indexRouteExamples, load, lookup, openPlaybook, publish } from '../src/playbook.mjs';
import { capture, execute, httpDispatcher } from '../src/workflow.mjs';
import { routeRequest } from '../src/host-routing.mjs';
import { auditCases, auditCollect, auditHttpTools, withAuditCollector } from '../eval/audit.mjs';
import { historicalFxFamily, paraphraseCases } from '../eval/paraphrases.mjs';
import { contracts, expandRequest, requestExamples } from '../eval/routing-contracts.mjs';

test('seeded randomized blocks cover every case, repeat and arm exactly once', () => {
  const plan = schedule(cases, 3, arms, 77);
  assert.deepEqual(plan, schedule(cases, 3, arms, 77));
  assert.notDeepEqual(plan, schedule(cases, 3, arms, 78));
  const ids = plan.flatMap(({ item, repeat, arms: order }) => order.map(arm => `${item.id}:${repeat}:${arm}`));
  assert.equal(ids.length, 108);
  assert.equal(new Set(ids).size, 108);
});

test('recorded routes replay against a separate fixture record', async t => {
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const dispatch = httpDispatcher(fixture.origin, registry);
  const db = openPlaybook(':memory:');
  t.after(() => db.close());
  const heldOut = [
    { name: 'Jules Reed', zip: '31003' },
    { traveler: 'trav-c', reservation: 'R7C3' },
    { traveler: 'trav-c' },
    { first: 'Seattle', second: 'Portland' },
    { base: 'EUR', first: 'GBP', second: 'JPY' },
  ];
  for (const [index, { id, saved, examples }] of families.filter(family => family.saved).entries()) {
    const learned = await capture(saved.spec, saved.seed, registry, dispatch);
    publish(db, id, saved.description, learned.workflow);
    const output = await execute(load(db, id), heldOut[index], registry, dispatch);
    assert.deepEqual(output, examples[1].expected);
  }
  assert.throws(() => load(db, 'news-and-weather'), /Unknown workflow/);
});

test('direct arms project the same fixture data and account for every completion', async t => {
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const dispatch = httpDispatcher(fixture.origin, registry);
  const item = cases.find(candidate => candidate.id === 'weather-pair-1');
  const calls = ['Boston', 'San Francisco'].map((city, index) => ({
    id: `call-${index}`, type: 'function', function: { name: 'weather', arguments: JSON.stringify({ city }) },
  }));
  const result = (message, finish_reason) => ({
    model: 'fixture', choices: [{ message, finish_reason }],
    usage: { prompt_tokens: 30, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
  });
  for (const arm of ['direct-raw', 'direct-projected']) {
    const row = await episode({ item, arm, dispatch, complete({ messages }) {
      if (messages.length === 2) return result({ tool_calls: calls }, 'tool_calls');
      const replies = messages.slice(-2).map(message => JSON.parse(message.content));
      assert.deepEqual(replies.map(reply => reply.celsius), [12, 17]);
      assert.equal(Object.hasOwn(replies[0], 'history'), arm === 'direct-raw');
      return result({ content: '{"second-temp":17,"first-temp":12}' }, 'stop');
    } });
    assert.equal(row.correct, true);
    assert.equal(row.httpCalls, 2);
    assert.deepEqual(row.usage, { input: 60, output: 20, cached: 10, total: 80 });
  }
});

test('metrics distinguish stable wrong answers from passing repeats and match successful pairs', () => {
  const row = (arm, repeat, correct, total) => ({
    arm, repeat, caseId: 'case', family: 'task', correct, normalized: correct ? '{"answer":1}' : '{"answer":0}',
    usage: { total, input: total - 5, cached: 3 }, routes: [], trace: [], turns: 2, httpCalls: 1, ms: 7,
  });
  const trials = [
    row('direct-raw', 0, true, 100), row('direct-raw', 1, true, 100),
    row('direct-projected', 0, false, 75), row('direct-projected', 1, false, 75),
    row('replay', 0, true, 50), row('replay', 1, false, 10),
  ];
  const summary = summarize(trials, 2, arms);
  assert.equal(summary.byArm['direct-projected'].answerAgreement, 1);
  assert.equal(summary.byArm['direct-projected'].passAll, 0);
  assert.equal(summary.byArm.replay.answerAgreement, 0);
  assert.equal(summary.byArm.replay.passAll, 0);
  assert.deepEqual(summary.pairedSavings['direct-raw'], { pairs: 1, baselineTokens: 100, replayTokens: 50, fractionSaved: 0.5 });
  assert.equal(summary.pairedSavings['direct-projected'].pairs, 0);
});

test('host routing executes explicit inputs locally, limits the shortlist and skips the chooser on misses', async t => {
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const dispatch = httpDispatcher(fixture.origin, registry);
  const db = openPlaybook(':memory:');
  t.after(() => db.close());
  const { saved } = families.find(entry => entry.id === 'weather-pair');
  const { workflow } = await capture(saved.spec, saved.seed, registry, dispatch);
  publish(db, 'weather-pair', saved.description, workflow);
  const inputs = { first: 'Seattle', second: 'Portland' };
  const options = { db, dispatch, registry };
  const noModel = async () => assert.fail('Chooser should not run');
  const request = 'temperatures';
  assert.deepEqual(await routeRequest({ ...options, request, choose: noModel,
    match: () => ({ route: 'weather-pair', inputs }) }), {
    kind: 'local', route: 'weather-pair', result: { 'first-temp': 9, 'second-temp': 13 },
  });
  assert.deepEqual(await routeRequest({ ...options, request: 'headlines', choose: noModel }), { kind: 'miss' });
  const assisted = await routeRequest({ ...options, request: 'weather temperature', choose: async (_, candidates) => {
    assert.equal(candidates.length, 1);
    return { route: candidates[0].route, inputs };
  } });
  assert.equal(assisted.kind, 'assisted');
  assert.deepEqual(await routeRequest({ ...options, request: 'weather',
    choose: async () => ({ route: 'unknown', inputs }) }), { kind: 'declined' });
  assert.deepEqual(await routeRequest({ ...options, request: 'weather',
    choose: async () => ({ route: 'weather-pair', inputs: { first: 'Seattle' } }) }), { kind: 'assisted-failed' });
});

test('audit collector joins all pages and preserves the HTTP request count at each workload size', async t => {
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const transport = httpDispatcher(fixture.origin, auditHttpTools);
  const replayRegistry = new Map([...auditHttpTools, ['audit_collect.v1', auditCollect]]);
  let count = 0;
  const dispatch = withAuditCollector((...args) => {
    count++;
    return transport(...args);
  });
  const ref = field => ({ step: 'scope', field });
  const spec = {
    version: 1, inputs: { batch: 'string' },
    steps: [
      { id: 'scope', op: 'audit_scope.v1', args: { batch: { input: 'batch' } } },
      { id: 'audit', op: 'audit_collect.v1', args: { key: ref('key'), pages: ref('pages') } },
    ],
    output: Object.fromEntries(Object.keys(auditCollect.fields).map(field => [field, { step: 'audit', field }])),
  };
  for (const item of auditCases) {
    count = 0;
    const batch = /AUD-\d+[AB]/.exec(item.prompt)[0];
    assert.deepEqual(await execute(spec, { batch }, replayRegistry, dispatch), item.expected);
    assert.equal(count, 1 + 2 * Math.ceil(item.size / 20));
  }
});

test('direct collector exposes a single tool and completes a full audit without a playbook', async t => {
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const dispatch = httpDispatcher(fixture.origin, auditHttpTools);
  const item = auditCases.find(entry => entry.id === 'audit-100-b');
  const row = await episode({
    item, arm: 'direct-collector', dispatch, extendDispatch: withAuditCollector,
    complete({ messages, tools }) {
      assert.deepEqual(tools.map(tool => tool.function.name), ['run_audit']);
      const result = messages.length === 2
        ? { message: { tool_calls: [{
          id: 'audit', type: 'function', function: { name: 'run_audit', arguments: '{"batch":"AUD-100B"}' },
        }] }, finish_reason: 'tool_calls' }
        : { message: { content: messages.at(-1).content }, finish_reason: 'stop' };
      return {
        model: 'fixture', choices: [result],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      };
    },
  });
  assert.equal(row.correct, true);
  assert.equal(row.httpCalls, 11);
  assert.equal(row.turns, 2);
  assert.deepEqual(row.routes, []);
});

test('wording suite fixes the gold answer and route across four distinct prompts per group', async t => {
  const groups = Map.groupBy(paraphraseCases, item => item.group);
  assert.equal(groups.size, 9);
  for (const group of groups.values()) {
    assert.equal(group.length, 4);
    assert.equal(new Set(group.map(item => item.prompt)).size, 4);
    assert.equal(new Set(group.map(item => item.expectedRoute)).size, 1);
    assert.equal(new Set(group.map(item => JSON.stringify(item.expected))).size, 1);
  }
  assert.equal(paraphraseCases.filter(item => item.origin === 'published').length, 5);
  const fixture = await startEvalFixture();
  t.after(() => fixture.close());
  const dispatch = httpDispatcher(fixture.origin, registry);
  const { spec, seed } = historicalFxFamily.saved;
  const { workflow } = await capture(spec, seed, registry, dispatch);
  const report = await execute(workflow, { base: 'EUR', quote: 'USD', date: '2022-01-01' }, registry, dispatch);
  assert.deepEqual(report, groups.get('historical-fx')[0].expected);
});

test('wording agreement compares distinct phrasings within each repeat block', () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    arm: 'host-routed', group: 'task', caseId: `case-${index % 4}`, family: 'task',
    variant: index % 4 + 1, repeat: Math.floor(index / 4), correct: index !== 7,
    normalized: index === 7 ? '{"result":"wrong"}' : '{"result":"right"}',
    routes: [], trace: [], turns: 1, httpCalls: 1, ms: 1,
    usage: { total: 1, input: 1, cached: 0 },
  }));
  const { wording } = summarize(rows, 2, ['host-routed']);
  assert.deepEqual(wording.byArm['host-routed'], {
    agreement: 0.75, allCorrect: 1, completeBlocks: 2, alwaysCorrect: 0, completeGroups: 1,
  });
});

test('expanded local routing checks the original request and abstains on contract conflicts', async t => {
  const db = openPlaybook(':memory:');
  t.after(() => db.close());
  const { saved } = families.find(family => family.id === 'airline-passengers');
  publish(db, 'airline-passengers', saved.description, saved.spec);
  indexRouteExamples(db, 'airline-passengers', ['Obsolete word for indexing']);
  indexRouteExamples(db, 'airline-passengers', requestExamples['airline-passengers']);
  const request = 'Report headcount on the newest booking for trav-b.';
  assert.deepEqual(lookup(db, request), []);
  let calls = 0;
  const options = {
    db, registry, request, local: { contracts, expand: expandRequest },
    choose: () => assert.fail('Local routing should skip the model chooser'),
    dispatch: async (operation, args) => {
      calls++;
      if (operation === 'air_traveler.v1') {
        assert.deepEqual(args, { traveler: 'trav-b' });
        return { data: { latest: 'R7B2' } };
      }
      assert.equal(operation, 'air_reservation.v1');
      assert.deepEqual(args, { reservation: 'R7B2' });
      return { data: { passengers: 1 } };
    },
  };
  const success = await routeRequest(options);
  assert.equal(success.route, 'airline-passengers');
  assert.deepEqual(success.result, { passengers: 1 });
  assert.equal(calls, 2);
  for (const unsupported of [
    'Report headcount on the newest booking for trav-b excluding children.',
    'Report headcount on the newest booking for trav-b.\nInclude passenger names.',
    'Report headcount on booking R7B2 for trav-b.',
  ]) {
    const outcome = await routeRequest({ ...options, request: unsupported });
    assert.equal(outcome.route, undefined);
  }
  publish(db, 'alternate', 'Alternate route', saved.spec);
  const conflicting = new Map(contracts);
  conflicting.set('alternate', contracts.get('airline-passengers'));
  const ambiguous = await routeRequest({ ...options, local: { ...options.local, contracts: conflicting } });
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(calls, 2);
});
