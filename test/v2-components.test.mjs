// Components added after the first benchmark: loops, pagination, prose templates, write workflows with the
// approval ledger, partial reuse, find_workflow, feedback and embeddings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHarness } from '../src/v2/harness.mjs';
import { renderTemplate } from '../src/v2/miner.mjs';
import { saveRoute } from '../src/v2/store.mjs';
import { hashedEmbedding, vectorCosine } from '../src/v2/util.mjs';
import { CORRECTION } from '../src/v2/hosts/claude-hook.mjs';
import { createService, loadData, project, registry } from '../eval/v2/tau2-service.mjs';
import { buildTasks } from '../eval/v2/tasks.mjs';
import { scriptedEpisode } from '../eval/v2/scripted.mjs';

const skip = existsSync(new URL('../eval/v2/data/tau2/retail-db.json', import.meta.url)) ? false : 'run node eval/v2/fetch-data.mjs first';

function syntheticService() {
  const orders = { o1: { status: 'delivered' }, o2: { status: 'pending' }, o3: { status: 'delivered' }, o4: { status: 'cancelled' }, o5: { status: 'delivered' } };
  const users = { ann: ['o1', 'o2', 'o3'], bob: ['o4', 'o5'], cy: ['o2', 'o5', 'o1', 'o4'], eve: ['o3', 'o1'] };
  const tickets = { red: [1, 2, 3, 4, 5], blue: [6, 7, 11], green: [8, 9, 10, 13], gold: [21, 22, 23, 24, 25, 27] };
  const cancelled = [];
  const reg = new Map([
    ['get_user', { description: 'Get a user', args: { user_id: 'string' } }],
    ['get_order', { description: 'Get an order', args: { order_id: 'string' } }],
    ['list_tickets', { description: 'List tickets page by page', args: { team: 'string', page: 'integer' } }],
    ['cancel_order', { description: 'Cancel an order', args: { order_id: 'string' }, effect: 'write' }],
  ]);
  const upstream = async (op, a) => {
    if (op === 'get_user') return { user_id: a.user_id, orders: users[a.user_id] };
    if (op === 'get_order') return { order_id: a.order_id, ...orders[a.order_id] };
    if (op === 'list_tickets') return { tickets: tickets[a.team].slice((a.page - 1) * 2, a.page * 2).map(id => ({ id, open: id % 2 === 1 })) };
    if (op === 'cancel_order') { cancelled.push(a.order_id); return { order_id: a.order_id, status: 'cancelled' }; }
    throw new Error('unknown');
  };
  return { registry: reg, upstream, users, orders, tickets, cancelled };
}

async function record(harness, request, steps, answer, allowWrites = false) {
  const gate = harness.gateway({ request, speculate: false, allowWrites });
  for (const [op, args] of steps) await gate.call(op, args);
  gate.finish(answer, { success: true });
}

test('loops, pagination, string-filtered counts and prose templates are learned and replayed', async () => {
  const svc = syntheticService();
  const harness = createHarness({ registry: svc.registry, upstream: svc.upstream });
  for (const user of ['ann', 'bob', 'cy', 'eve']) {
    const list = svc.users[user];
    await record(harness, `How many of ${user} orders were delivered?`,
      [['get_user', { user_id: user }], ...list.map(order => ['get_order', { order_id: order }])],
      { delivered: list.filter(order => svc.orders[order].status === 'delivered').length });
  }
  for (const team of ['red', 'blue', 'green', 'gold']) {
    const all = svc.tickets[team];
    const pages = Math.ceil(all.length / 2) + 1;
    await record(harness, `How many open tickets does team ${team} have?`,
      Array.from({ length: pages }, (_, i) => ['list_tickets', { team, page: i + 1 }]),
      `Team ${team} has ${all.filter(id => id % 2 === 1).length} open tickets.`);
  }
  const log = await harness.learn();
  const routes = harness.routes(['shadow']);
  const loop = routes.find(route => route.plan.steps.some(step => step.forEach));
  const paged = routes.find(route => route.plan.steps.some(step => step.paginate));
  assert.ok(loop && paged, JSON.stringify(log.rejected));
  assert.deepEqual(loop.plan.output.delivered.where, { field: ['status'], equals: 'delivered' });
  assert.match(paged.stats.template, /\{count_open_true\} open tickets/);
  loop.state = 'live';
  paged.state = 'live';
  saveRoute(harness.store, loop, 'test');
  saveRoute(harness.store, paged, 'test');
  const counted = await harness.runRoute(loop.id, { user_id: 'cy' });
  assert.equal(counted.output.delivered, 2);
  const { output } = await harness.runRoute(paged.id, { team: 'gold' });
  assert.equal(output.count_open_true, 4);
  assert.match(renderTemplate(paged.stats.template, output), /has 4 open tickets/);
});

test('write workflows only prepare proposals; the ledger runs an approved proposal exactly once', async () => {
  const svc = syntheticService();
  const harness = createHarness({ registry: svc.registry, upstream: svc.upstream });
  for (const order of ['o1', 'o2', 'o3']) {
    await record(harness, `Please cancel order ${order}`, [['get_order', { order_id: order }], ['cancel_order', { order_id: order }]],
      { order_id: order, status: 'cancelled' }, true);
  }
  await harness.learn();
  svc.cancelled.length = 0;
  const route = harness.routes(['shadow']).find(item => item.plan.steps.at(-1).op === 'cancel_order');
  assert.ok(route, 'write workflow learned');
  route.state = 'live';
  saveRoute(harness.store, route, 'test');

  const blocked = await harness.gateway({ request: 'x' }).call('cancel_order', { order_id: 'o5' });
  assert.ok(blocked.error, 'gateway refuses writes without the host approval path');
  const handled = await harness.handle('Please cancel order o5', { session: 'w1' });
  assert.equal(handled.mode, 'approve');
  assert.deepEqual(handled.proposal.args, { order_id: 'o5' });
  const tool = await harness.gateway({ request: 'Please cancel order o5', session: 'w1' }).runWorkflow(route.id, { order_id: 'o5' });
  assert.equal(tool.status, 'needs_approval');
  assert.equal(svc.cancelled.length, 0, 'nothing ran before approval');

  assert.equal((await harness.commit(tool.proposal, { principal: 'w1', approve: async () => false })).status, 'declined');
  assert.equal((await harness.commit(handled.proposal, { principal: 'w1', approve: async () => true })).status, 'completed');
  assert.equal((await harness.commit(handled.proposal, { principal: 'w1', approve: async () => true })).status, 'completed');
  assert.deepEqual(svc.cancelled, ['o5'], 'executed exactly once');
  await assert.rejects(harness.commit({ ...handled.proposal, args: { order_id: 'o1' } }, { principal: 'w1', approve: async () => true }), /changed/);
  await assert.rejects(harness.commit(handled.proposal, { principal: 'someone-else', approve: async () => true }), /changed/);
});

test('partial reuse, find_workflow search mode, feedback and embeddings', { skip }, async () => {
  const data = loadData();
  const tasks = buildTasks(data);
  const productNames = Object.values(data.retail.products).map(p => p.name.toLowerCase());
  const near = tasks.test.find(t => t.kind === 'near-miss' && t.family === 'account-summary');
  const email = /([\w.]+@[\w.]+\w)/.exec(near.request)[1];
  let accountId;
  const extract = async () => ({ value: { route: null, inputs: {}, related: { route: accountId, inputs: { email } } }, usage: null });
  const harness = createHarness({ registry, upstream: createService(data), project, extract });
  for (const batch of tasks.learning.batches) for (const item of batch) await scriptedEpisode(harness, item, productNames);
  await harness.learn();
  for (const route of harness.routes(['shadow'])) { route.state = 'live'; saveRoute(harness.store, route, 'test'); }
  accountId = harness.routes(['live']).find(r => r.plan.steps[0].op === 'retail_find_user_id_by_email').id;

  const out = await harness.handle(near.request, { session: 'p1' });
  assert.equal(out.mode, 'fallback');
  assert.equal(out.partial, accountId);
  assert.match(out.context, /"zip"/, 'prefetched user record includes the zip the user asked for');

  const specs = harness.toolSpecs({ workflowMode: 'search' });
  assert.ok(specs.find(s => s.name === 'find_workflow'));
  assert.ok(!specs.find(s => s.name === 'run_workflow').description.includes('wf-'));
  assert.ok(harness.findWorkflows('item count and total price of an order').some(hit => hit.returns.includes('item_count')));

  const fresh = createHarness({ registry, upstream: createService(data), project });
  for (const item of tasks.learning.batches[0].filter(t => t.family === 'order-total')) await scriptedEpisode(fresh, item, productNames);
  fresh.feedback(1, false);
  const log = await fresh.learn();
  assert.equal(log.candidates.length, 0, 'a failed episode drops the cluster below minimum support');
  assert.ok(CORRECTION.test("No, that's the wrong order"));
  assert.ok(!CORRECTION.test('Now show me the total'));

  const a = hashedEmbedding('how many items were in my order and what did it cost');
  const b = hashedEmbedding('order total and item count');
  const c = hashedEmbedding('flight status on a date');
  assert.ok(vectorCosine(a, b) > vectorCosine(a, c));
});
