// Host-side components: Claude Code permission checks for writes, hands-free learning in hooks, wrapping MCP
// servers and OpenAPI specs, and the transcript analyzer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHarness } from '../src/v2/harness.mjs';
import { saveRoute } from '../src/v2/store.mjs';
import { decide, ruleMatches } from '../src/v2/hosts/permissions.mjs';
import { approveWrite, makeGatewayServer } from '../src/v2/hosts/mcp-gateway.mjs';
import { onEnd, onPrompt, onStop } from '../src/v2/hosts/claude-hook.mjs';
import { classifyMcpTool, describeMcpServer, describeOpenApi, mcpUpstream, openApiUpstream } from '../src/v2/hosts/wrap.mjs';
import { analyze, turnsFromTranscript } from '../src/v2/hosts/analyze.mjs';

const settings = (permissions, path = 'test') => ({ path, permissions });

test('permission rules: deny beats ask beats allow; server-wide and wildcard MCP rules; bypass mode', () => {
  const tool = 'mcp__workflow-replay__cancel_order';
  assert.ok(ruleMatches('mcp__workflow-replay', tool));
  assert.ok(ruleMatches('mcp__workflow-replay__*', tool));
  assert.ok(!ruleMatches('mcp__other', tool));
  assert.equal(decide(tool, [settings({ allow: ['mcp__workflow-replay'] })]).decision, 'allow');
  assert.equal(decide(tool, [settings({ allow: ['mcp__workflow-replay'], deny: [tool] })]).decision, 'deny');
  assert.equal(decide(tool, [settings({ allow: [tool], ask: ['mcp__workflow-replay__*'] })]).decision, 'ask');
  assert.equal(decide(tool, [settings({})]).decision, 'ask');
  assert.equal(decide(tool, [settings({ defaultMode: 'bypassPermissions' })]).decision, 'allow');
});

function writeHarness() {
  const cancelled = [];
  const registry = new Map([
    ['get_order', { description: 'Get an order', args: { order_id: 'string' } }],
    ['cancel_order', { description: 'Cancel an order', args: { order_id: 'string' }, effect: 'write' }],
  ]);
  const upstream = async (op, args) => {
    if (op === 'get_order') return { order_id: args.order_id, status: 'pending' };
    cancelled.push(args.order_id);
    return { order_id: args.order_id, status: 'cancelled' };
  };
  return { harness: createHarness({ registry, upstream }), cancelled };
}

async function learnCancel(harness) {
  for (const order of ['o1', 'o2', 'o3']) {
    const gate = harness.gateway({ request: `Please cancel order ${order}`, speculate: false, allowWrites: true });
    await gate.call('get_order', { order_id: order });
    await gate.call('cancel_order', { order_id: order });
    gate.finish({ order_id: order, status: 'cancelled' }, { success: true });
  }
  await harness.learn();
  const route = harness.routes(['shadow']).find(item => item.plan.steps.at(-1).op === 'cancel_order');
  route.state = 'live';
  saveRoute(harness.store, route, 'test');
  return route;
}

test('writes in Claude Code: denied, allowed by permissions, or the user is asked (elicitation or native prompt)', async () => {
  const { harness, cancelled } = writeHarness();
  const route = await learnCancel(harness);
  cancelled.length = 0;
  const tool = 'mcp__workflow-replay__cancel_order';
  const propose = async () => (await harness.gateway({ request: 'Please cancel order o9', session: 'cc' }).runWorkflow(route.id, { order_id: 'o9' })).proposal;

  const denied = await approveWrite({ harness, proposalId: (await propose()).id, sources: [settings({ deny: [tool] })] });
  assert.equal(denied.status, 'refused');
  const fallback = await approveWrite({ harness, proposalId: (await propose()).id, sources: [settings({})] });
  assert.equal(fallback.status, 'needs_user_approval');
  assert.deepEqual(fallback.call, { tool, args: { order_id: 'o9' } });
  assert.equal(cancelled.length, 0, 'nothing ran without permission or approval');

  const allowed = await approveWrite({ harness, proposalId: (await propose()).id, sources: [settings({ allow: [tool] })] });
  assert.equal(allowed.status, 'completed');
  assert.deepEqual(cancelled, ['o9']);

  // Elicitation through a real MCP client: the user declines, then approves.
  const server = makeGatewayServer(harness);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'cc-test', version: '1' }, { capabilities: { elicitation: {} } });
  let answer = { action: 'decline' };
  client.setRequestHandler(ElicitRequestSchema, async () => answer);
  await client.connect(clientSide);
  const declined = await approveWrite({ harness, server, proposalId: (await propose()).id, sources: [settings({})] });
  assert.equal(declined.status, 'declined');
  answer = { action: 'accept', content: { approve: true } };
  const accepted = await approveWrite({ harness, server, proposalId: (await propose()).id, sources: [settings({})] });
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.approvedBy, 'user prompt');
  assert.deepEqual(cancelled, ['o9', 'o9']);
  const listed = await client.listTools();
  const commitTool = listed.tools.find(item => item.name === 'commit_workflow_action');
  assert.equal(commitTool.annotations.destructiveHint, true);
  await client.close();
});

test('hooks learn hands-free: shadow comparison on Stop, auto-learn and promotion, session cleanup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wr-hooks-'));
  process.env.WORKFLOW_REPLAY_HOME = home;
  try {
    const registry = new Map([['get_order', { description: 'Get an order', args: { order_id: 'string' } }]]);
    const orders = { '#W1': 3, '#W2': 5, '#W3': 2, '#W4': 7, '#W5': 1, '#W6': 4, '#W7': 6, '#W8': 9 };
    const upstream = async (op, { order_id: id }) => ({ order_id: id, items: orders[id] });
    const harness = createHarness({ registry, upstream, policy: { autoApprove: true, shadowTarget: 2, learnEvery: 3, answerMode: 'carry' } });
    const transcript = (id, prompt, reply, withCall = true) => {
      const path = join(home, `${id}.jsonl`);
      const lines = [{ type: 'user', message: { content: prompt } }];
      if (withCall) {
        lines.push({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id: `t${id}`, name: 'mcp__workflow-replay__get_order', input: { order_id: prompt.match(/#W\d/)[0] } }] } });
        lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${id}`, content: [{ type: 'text', text: JSON.stringify({ order_id: prompt.match(/#W\d/)[0], items: orders[prompt.match(/#W\d/)[0]] }) }] }] } });
      }
      lines.push({ type: 'assistant', message: { id: `r${id}`, content: [{ type: 'text', text: reply }] } });
      writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n'));
      return path;
    };
    let learned = null;
    for (const [i, id] of ['#W1', '#W2', '#W3', '#W4', '#W5'].entries()) {
      const out = await onStop(harness, { session_id: 's1', transcript_path: transcript(i, `How many items are in order ${id}?`, `Order ${id} has ${orders[id]} items.`) });
      learned ??= out.learned;
    }
    assert.ok(learned?.candidates >= 1, 'learning ran automatically after enough turns');
    const route = harness.routes(['shadow'])[0];
    assert.ok(route, 'a shadow route exists');

    // Shadow: the prompt hook remembers the match, the Stop hook compares with Claude's reply.
    for (const [i, id] of ['#W6', '#W7'].entries()) {
      const prompt = `How many items are in order ${id}?`;
      await onPrompt(harness, { hook_event_name: 'UserPromptSubmit', prompt, session_id: 's2' });
      const out = await onStop(harness, { session_id: 's2', transcript_path: transcript(10 + i, prompt, `Order ${id} contains ${orders[id]} items.`) });
      assert.equal(out.shadow, true);
    }
    assert.equal(harness.routes(['live']).length, 1, 'promoted after shadow agreements (read-only, auto-approve)');
    const injected = await onPrompt(harness, { hook_event_name: 'UserPromptSubmit', prompt: 'How many items are in order #W8?', session_id: 's3' });
    assert.match(injected.hookSpecificOutput.additionalContext, /items=9/);

    const carried = await onPrompt(harness, { hook_event_name: 'UserPromptSubmit', prompt: 'How many items are in order #W8?', session_id: 's4' }, 'carry');
    assert.equal(carried.decision, 'block');
    assert.equal(harness.carry.pending('s4').length, 1);
    onEnd(harness, { session_id: 's4' });
    assert.equal(harness.carry.pending('s4').length, 0, 'session end clears carried results');
  } finally {
    delete process.env.WORKFLOW_REPLAY_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('wrap: classifies and calls an existing MCP server; read-only mode drops writes', async () => {
  const fixture = new URL('../eval/v2/fixtures/mini-mcp.mjs', import.meta.url);
  const command = { command: process.execPath, args: [fixture.pathname.replace(/^\/([A-Za-z]:)/, '$1')] };
  const all = await describeMcpServer(command);
  const effects = Object.fromEntries(all.map(op => [op.name, op.entry.effect]));
  assert.deepEqual(effects, { item_details: 'read', list_items: 'read', delete_item: 'write' });
  assert.deepEqual(all.find(op => op.name === 'list_items').entry.optional, ['in_stock']);
  const readOnly = await describeMcpServer({ ...command, readOnly: true });
  assert.ok(!readOnly.some(op => op.name === 'delete_item'));
  assert.equal(classifyMcpTool({ name: 'frobnicate' }).effect, 'write', 'unclear tools are treated as writes');

  const upstream = mcpUpstream(command);
  try {
    const registry = new Map(all.map(op => [op.name, op.entry]));
    const harness = createHarness({ registry, upstream });
    const gate = harness.gateway({ request: 'x', speculate: false });
    assert.equal((await gate.call('item_details', { id: 'a1' })).name, 'Widget');
    assert.equal((await gate.call('list_items', {})).length, 2, 'optional argument may be omitted');
    assert.ok((await gate.call('delete_item', { id: 'a1' })).error, 'writes need the approval path');
  } finally {
    await upstream.close();
  }
});

test('wrap: OpenAPI operations become registry entries and calls; GET is read, others write', async () => {
  const spec = { openapi: '3.0.0', paths: {
    '/orders/{order_id}': { get: { operationId: 'getOrder', parameters: [{ name: 'order_id', in: 'path', required: true, schema: { type: 'string' } }] },
      delete: { operationId: 'cancelOrder', parameters: [{ name: 'order_id', in: 'path', required: true, schema: { type: 'string' } }] } },
    '/orders': { get: { operationId: 'listOrders', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }] } } } };
  const operations = describeOpenApi(spec);
  assert.deepEqual(Object.fromEntries(operations.map(op => [op.name, op.entry.effect])), { getOrder: 'read', cancelOrder: 'write', listOrders: 'read' });
  assert.equal(describeOpenApi(spec, { readOnly: true }).length, 2);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const upstream = openApiUpstream({ base: `http://127.0.0.1:${server.address().port}`, operations });
    assert.deepEqual(await upstream('getOrder', { order_id: '#W 1' }), { method: 'GET', url: '/orders/%23W%201' });
    assert.deepEqual(await upstream('listOrders', { status: 'pending' }), { method: 'GET', url: '/orders?status=pending' });
    assert.throws(() => openApiUpstream({ base: 'http://example.com', operations }), /HTTPS/);
  } finally {
    server.close();
  }
});

test('analyzer: finds repeated read-only external shapes and real token usage in transcripts', () => {
  const turn = (i, tool) => [
    { type: 'user', message: { content: `Status of order ${i}?` } },
    { type: 'assistant', message: { id: `a${i}`, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 },
      content: [{ type: 'tool_use', id: `t${i}`, name: tool, input: { order_id: String(i) } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }] } },
    { type: 'assistant', message: { id: `b${i}`, usage: { input_tokens: 50, output_tokens: 30 }, content: [{ type: 'text', text: 'done' }] } },
  ];
  const lines = [
    ...[1, 2, 3, 4].flatMap(i => turn(i, 'mcp__shop__get_order')),
    ...turn(5, 'Edit'),
    { type: 'user', message: { content: 'hello' } },
  ].map(line => JSON.stringify(line)).join('\n');
  const report = analyze(turnsFromTranscript(lines), { min: 3 });
  assert.equal(report.turns, 6);
  assert.equal(report.replayableTurns, 4);
  assert.equal(report.clusters[0].shape, 'mcp__shop__get_order');
  assert.equal(report.clusters[0].meanTokens, 1200);
});

test('default answer mode: the model always writes the answer from a compact receipt', async () => {
  const registry = new Map([['get_order', { description: 'Get an order', args: { order_id: 'string' } }]]);
  const harness = createHarness({ registry, upstream: async (op, { order_id: id }) => ({ order_id: id, items: 3, internal: 'x'.repeat(500) }) });
  for (const id of ['#A1', '#A2', '#A3']) {
    const gate = harness.gateway({ request: `How many items are in order ${id}?`, speculate: false });
    await gate.call('get_order', { order_id: id });
    gate.finish({ items: 3 }, { success: true });
  }
  await harness.learn();
  for (const route of harness.routes(['shadow'])) { route.state = 'live'; saveRoute(harness.store, route, 'test'); }
  const out = await harness.handle('How many items are in order #A9?', { session: 'd1', host: { canBlock: true, direct: true } });
  assert.equal(out.mode, 'inject', 'even a host that could skip the model gets inject by default');
  assert.match(out.context, /items=3/);
  assert.ok(!out.context.includes('xxxx'), 'only the fields the workflow returns are handed over');
  assert.ok(out.context.length < 400);
});
