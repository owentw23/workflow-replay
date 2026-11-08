import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from '../src/v2/harness.mjs';
import { createCarry, ENTRY_CAP } from '../src/v2/carry.mjs';
import { executePlan, getPath } from '../src/v2/plan.mjs';
import { appearsIn, isoDates, sameAnswer } from '../src/v2/util.mjs';
import { createService, loadData, project, registry } from '../eval/v2/tau2-service.mjs';
import { buildTasks } from '../eval/v2/tasks.mjs';
import { entityFromRequest, scriptedEpisode } from '../eval/v2/scripted.mjs';

const dataReady = existsSync(new URL('../eval/v2/data/tau2/retail-db.json', import.meta.url));
const skip = dataReady ? false : 'run node eval/v2/fetch-data.mjs first';

test('paths support negative indexes and case-insensitive input keys', () => {
  const root = { orders: ['a', 'b', 'c'], map: { 'Electric Kettle': '1' } };
  assert.equal(getPath(root, ['orders', -1]), 'c');
  assert.equal(getPath(root, ['map', { input: 'name' }], { name: 'electric kettle' }), '1');
  assert.equal(getPath(root, ['missing', 0]), null);
});

test('value detection handles ids, numbers and written dates', () => {
  assert.ok(appearsIn('order W123 please', '#W123'));
  assert.ok(appearsIn('flight on May 10, 2024', '2024-05-10'));
  assert.ok(!appearsIn('order 1234', 123));
  assert.deepEqual([...isoDates('10 May 2024 and 2024-05-12')].sort(), ['2024-05-10', '2024-05-12']);
  assert.ok(sameAnswer({ a: 'Delivered', b: 1.004 }, { b: 1, a: 'delivered' }));
});

test('carry store refuses oversize entries and delivers pending results once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'carry-'));
  try {
    const carry = createCarry({ directory });
    assert.equal(carry.save('s1', { request: 'x', route: 'r', result: { big: 'x'.repeat(ENTRY_CAP) } }), false);
    assert.equal(carry.save('bad id!', { request: 'x', route: 'r', result: {} }), false);
    assert.ok(carry.save('s1', { request: 'q1', route: 'r', result: { a: 1 } }));
    assert.ok(carry.save('s1', { request: 'q2', route: 'r', result: { b: 2 } }));
    const context = carry.deliver('s1');
    assert.match(context, /q1/);
    assert.match(context, /q2/);
    assert.equal(carry.deliver('s1'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('declarative reducers compute counts, sums and filtered minimums', async () => {
  const reg = new Map([['p', { args: { id: 'string' } }]]);
  const plan = { version: 2, inputs: { id: { type: 'string', from: 'request' } },
    steps: [{ id: 's1', op: 'p', args: { id: { input: 'id' } } }],
    output: {
      n: { reduce: 'len', of: { step: 's1', path: ['v'] } },
      avail: { reduce: 'count', of: { step: 's1', path: ['v'] }, where: { field: ['ok'], equals: true } },
      cheapest: { reduce: 'min', of: { step: 's1', path: ['v'] }, field: ['price'], where: { field: ['ok'], equals: true } },
      total: { reduce: 'sum', of: { step: 's1', path: ['v'] }, field: ['price'] },
    } };
  const { output } = await executePlan(plan, { id: 'x' }, reg, async () => ({ v: [
    { ok: true, price: 3.1 }, { ok: false, price: 1 }, { ok: true, price: 2.2 }] }));
  assert.deepEqual(output, { n: 3, avail: 2, cheapest: 2.2, total: 6.3 });
});

function setup(policy = {}) {
  const data = loadData();
  const harness = createHarness({ registry, upstream: createService(data), project,
    policy: { autoApprove: true, widenOnApprove: true, ...policy } });
  const tasks = buildTasks(data);
  const productNames = Object.values(data.retail.products).map(p => p.name.toLowerCase());
  return { data, harness, tasks, productNames };
}

test('learns plans from recorded episodes, merges coincidental constants, and routes repeats', { skip }, async () => {
  const { harness, tasks, productNames } = setup({ answerMode: 'direct' });
  for (const item of tasks.learning.batches[0]) await scriptedEpisode(harness, item, productNames);
  const first = await harness.learn();
  assert.equal(first.candidates.filter(c => c.verified).length, tasks.families.length, JSON.stringify(first.rejected));
  const flight = harness.routes(['shadow']).find(route => route.plan.steps[0].op === 'airline_get_flight_instance');
  assert.deepEqual(flight.plan.steps[0].args.date, { const: '2024-05-10' }, 'date seen once is a constant');

  for (const item of tasks.learning.batches[1]) await scriptedEpisode(harness, item, productNames);
  const second = await harness.learn();
  const merge = second.consolidated.find(entry => entry.merged);
  assert.ok(merge, 'consolidation merged the two flight-status plans');
  assert.deepEqual(merge.placeholders, ['date']);
  const merged = harness.routes(['shadow']).find(route => route.id === merge.into);
  assert.deepEqual(merged.plan.inputs.date.allowed.sort(), ['2024-05-10', '2024-05-12']);

  // Shadow mode with the template router (no model): exact-form repeats promote the routes.
  for (const item of tasks.learning.shadow) {
    const decision = await harness.handle(item.request, { session: 's' });
    assert.equal(decision.mode, 'fallback');
    if (decision.shadow) await harness.shadow(decision.shadow.route, decision.shadow.inputs, item.gold);
  }
  const live = harness.routes(['live']);
  assert.ok(live.length >= 6, `live routes: ${live.map(r => r.id)}`);
  assert.equal(live.find(r => r.id === merge.into)?.plan.inputs.date.allowed, undefined, 'approval widened the date');

  // Exact-form repeats replay without any model; results match gold.
  for (const item of tasks.test.filter(t => t.kind === 'repeat-exact-form')) {
    const out = await harness.handle(item.request, { session: `x-${item.id}`, host: { canBlock: true, direct: true } });
    assert.equal(out.mode, 'direct', `${item.id}: ${out.decision.reason}`);
    assert.ok(sameAnswer(out.output, item.gold), `${item.id} ${JSON.stringify(out.output)}`);
  }

  // Outlier: pending order without tracking goes to inject mode with the result in context.
  const outlier = tasks.test.find(t => t.kind === 'outlier');
  const learnedForm = tasks.learning.batches[0].find(t => t.family === 'latest-order').request;
  const entity = entityFromRequest('latest-order', outlier.request, productNames);
  const sameForm = learnedForm.replace(/I'm \w+ \w+, zip \d+/, `I'm ${entity.first} ${entity.last}, zip ${entity.zip}`);
  const o = await harness.handle(sameForm, { session: 'o1', host: { canBlock: true, direct: true } });
  assert.equal(o.mode, 'inject');
  assert.equal(o.attention.field, 'tracking_id');
  assert.match(o.context, /tracking_id/);

  // Follow-up continuity: a direct answer is delivered to the next model turn.
  const direct = tasks.test.find(t => t.kind === 'repeat-exact-form' && t.family === 'order-total');
  const d = await harness.handle(direct.request, { session: 'f1', host: { canBlock: true, direct: true } });
  assert.equal(d.mode, 'direct');
  const next = await harness.handle('For that order, which item was the most expensive?', { session: 'f1' });
  assert.equal(next.mode, 'fallback');
  assert.match(next.context, /item_count/);
});

test('near-miss wording is declined by the gate even when the model picks the route', { skip }, async () => {
  const { harness, tasks, productNames } = setup();
  for (const batch of tasks.learning.batches) for (const item of batch) await scriptedEpisode(harness, item, productNames);
  await harness.learn();
  await harness.learn();
  for (const route of harness.routes(['shadow'])) {
    route.state = 'live';
    const { saveRoute } = await import('../src/v2/store.mjs');
    saveRoute(harness.store, route, 'test');
  }
  // A hostile extractor that always picks the most similar route with plausible inputs.
  const live = harness.routes(['live']);
  const latest = live.find(r => r.plan.steps[0].op === 'retail_find_user_id_by_name_zip');
  const near = tasks.test.find(t => t.kind === 'near-miss' && t.family === 'latest-order');
  const entity = entityFromRequest('latest-order', near.request, productNames);
  const { gate } = await import('../src/v2/router.mjs');
  const problem = gate(latest, near.request, { first_name: entity.first, last_name: entity.last, zip: entity.zip }, live);
  assert.match(problem, /first/);
  const zipNear = tasks.test.find(t => t.kind === 'near-miss' && t.family === 'account-summary');
  const account = live.find(r => r.plan.steps[0].op === 'retail_find_user_id_by_email');
  const email = /([\w.]+@[\w.]+\w)/.exec(zipNear.request)[1];
  assert.ok(gate(account, zipNear.request, { email }, live), 'zip question is not the account-summary workflow');
});

test('gateway speculation returns the whole plan on a known first call', { skip }, async () => {
  const { harness, tasks, productNames } = setup({ speculateRate: 0.5 });
  for (const batch of tasks.learning.batches) for (const item of batch) await scriptedEpisode(harness, item, productNames);
  await harness.learn();
  const { saveRoute } = await import('../src/v2/store.mjs');
  for (const route of harness.routes(['shadow'])) { route.state = 'live'; saveRoute(harness.store, route, 'test'); }
  const item = tasks.test.find(t => t.family === 'latest-order' && t.kind === 'repeat-paraphrase');
  const entity = entityFromRequest('latest-order', item.request, productNames);
  const gate = harness.gateway({ request: item.request, record: false });
  const reply = await gate.call('retail_find_user_id_by_name_zip', { first_name: entity.first, last_name: entity.last, zip: entity.zip });
  assert.ok(reply.workflow_result, 'speculative workflow result attached');
  assert.ok(sameAnswer(reply.workflow_result.output, item.gold));
  const specs = harness.toolSpecs();
  assert.ok(specs.find(spec => spec.name === 'run_workflow'));
});

test('Claude Code hook: inject by default, show-and-carry blocks and carries, transcript becomes an episode', { skip }, async () => {
  const { onPrompt, episodeFromTranscript } = await import('../src/v2/hosts/claude-hook.mjs');
  const { harness, tasks, productNames } = setup({ answerMode: 'carry' });
  for (const batch of tasks.learning.batches) for (const item of batch) await scriptedEpisode(harness, item, productNames);
  await harness.learn();
  await harness.learn();
  const { saveRoute } = await import('../src/v2/store.mjs');
  for (const route of harness.routes(['shadow'])) { route.state = 'live'; saveRoute(harness.store, route, 'test'); }
  const item = tasks.test.find(t => t.kind === 'repeat-exact-form' && t.family === 'order-total');
  const base = { hook_event_name: 'UserPromptSubmit', prompt: item.request };
  const injected = await onPrompt(harness, { ...base, session_id: 'cc1' }, 'inject');
  assert.match(injected.hookSpecificOutput.additionalContext, /item_count/);
  const blocked = await onPrompt(harness, { ...base, session_id: 'cc2' }, 'carry');
  assert.equal(blocked.decision, 'block');
  const followUp = await onPrompt(harness, { hook_event_name: 'UserPromptSubmit', prompt: 'Which item in that order cost the most?', session_id: 'cc2' }, 'carry');
  assert.match(followUp.hookSpecificOutput.additionalContext, /item_count/, 'carried result reaches the next model turn');
  assert.equal(await onPrompt(harness, { ...base, permission_mode: 'plan', session_id: 'cc3' }), null);

  const lines = [
    { type: 'user', message: { role: 'user', content: 'Where is order #W1?' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__workflow-replay__retail_get_order_details', input: { order_id: '#W1' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '{"order_id":"#W1","status":"delivered"}' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Order #W1 was delivered.' }] } },
  ].map(line => JSON.stringify(line));
  const episode = episodeFromTranscript(lines);
  assert.equal(episode.request, 'Where is order #W1?');
  assert.deepEqual(episode.calls[0], { op: 'retail_get_order_details', args: { order_id: '#W1' }, result: { order_id: '#W1', status: 'delivered' }, ok: true });
  assert.equal(episode.answer, 'Order #W1 was delivered.');
});

test('mid-turn replays are gated against the request: compiled tool and speculation refuse a near-miss', { skip }, async () => {
  const { harness, tasks, productNames } = setup({ speculateRate: 0.5 });
  for (const batch of tasks.learning.batches) for (const item of batch) await scriptedEpisode(harness, item, productNames);
  await harness.learn();
  const { saveRoute } = await import('../src/v2/store.mjs');
  for (const route of harness.routes(['shadow'])) { route.state = 'live'; saveRoute(harness.store, route, 'test'); }
  const near = tasks.test.find(t => t.kind === 'near-miss' && t.family === 'latest-order');
  const entity = entityFromRequest('latest-order', near.request, productNames);
  const args = { first_name: entity.first, last_name: entity.last, zip: entity.zip };
  const route = harness.routes(['live']).find(r => r.plan.steps[0].op === 'retail_find_user_id_by_name_zip');
  const gate = harness.gateway({ request: near.request, record: false });
  const tool = await gate.runWorkflow(route.id, args);
  assert.match(tool.error, /does not answer/);
  const reply = await gate.call('retail_find_user_id_by_name_zip', args);
  assert.equal(reply.workflow_result, undefined, 'no speculation for a near-miss');
  // A follow-up may use a value from carried context.
  const orderRoute = harness.routes(['live']).find(r => r.plan.steps[0].op === 'retail_get_order_details');
  const followGate = harness.gateway({ request: 'For that order, how many items and what total?', context: '{"order_id":"#W2611340"}', record: false });
  const ok = await followGate.runWorkflow(orderRoute.id, { order_id: '#W2611340' });
  assert.equal(ok.item_count, 2);
});
