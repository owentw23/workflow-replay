import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitAction, matchAction, prepareAction } from '../src/actions.mjs';
import { mcpAction } from '../src/mcp-action.mjs';
import { makeMcp } from '../src/mcp-service.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const route = 'email-owner';
const operation = 'send-email.v1';
const principal = 'account-owner';
const request = 'Email the owner of acct-17';
const inputs = { account: 'acct-17', message: 'There are two open tickets.' };

async function setup(t, call) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'replay-actions-'));
  assert.equal(dirname(await realpath(directory)), parent);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reads = [];
  const profile = {
    actionDatabase: join(directory, 'actions.sqlite'),
    registry: new Map([['owner.v1', { args: { account: 'string' }, fields: { email: 'string' } }]]),
    dispatch: async (_, args) => {
      reads.push(args.account);
      return { data: { email: 'owner@example.test' } };
    },
    actionTools: new Map([[operation, {
      args: { to: 'string', body: 'string' }, fields: { messageId: 'string' }, call,
    }]]),
    actions: new Map([[route, {
      match: text => text === request ? { account: 'acct-17' } : undefined,
      inputs: { account: { type: 'string' }, message: { type: 'string', source: 'model' } },
      prepare: {
        version: 1, inputs: { account: 'string' },
        steps: [{ id: 'owner', op: 'owner.v1', args: { account: { input: 'account' } } }],
        output: { email: { step: 'owner', field: 'email' } },
      },
      operation, args: { to: { prepared: 'email' }, body: { input: 'message' } },
    }]]),
  };
  return { profile, reads };
}

test('a matched workflow requests typed inputs and uses the frozen read result for approval and dispatch', async t => {
  const sent = [];
  const { profile, reads } = await setup(t, async (args, { idempotencyKey }) => {
    sent.push({ args, idempotencyKey });
    return { messageId: 'sent-1', raw: 'discard this' };
  });
  assert.deepEqual(matchAction(profile, request), { route, inputs: { account: 'acct-17' } });
  assert.equal(matchAction(profile, 'Show the owner of acct-17'), undefined);
  assert.deepEqual(await prepareAction(profile, route, { account: 'acct-17' }, principal), {
    status: 'needs_inputs', route, missing: { message: { type: 'string', source: 'model' } },
  });
  await assert.rejects(prepareAction(profile, route, { ...inputs, message: 3 }, principal), /Invalid message/);
  assert.deepEqual(reads, []);
  const { proposal } = await prepareAction(profile, route, inputs, principal);
  assert.deepEqual(reads, ['acct-17']);
  assert.deepEqual(sent, []);
  await assert.rejects(commitAction(profile, { ...proposal, args: { ...proposal.args, to: 'wrong@example.test' } }, {
    principal, approve: () => assert.fail('tampered proposal reached approval'),
  }), /changed/);
  await assert.rejects(commitAction(profile, proposal, { principal: 'other', approve: () => true }), /changed/);
  const declined = await prepareAction(profile, route, inputs, principal);
  assert.equal((await commitAction(profile, declined.proposal, { principal, approve: () => false })).status, 'declined');
  assert.equal((await commitAction(profile, declined.proposal, { principal, approve: () => true })).status, 'declined');
  assert.deepEqual(sent, []);
  const approve = preview => {
    assert.equal(preview.args.to, 'owner@example.test');
    preview.args.to = 'changed@example.test';
    return true;
  };
  const results = await Promise.all([commitAction(profile, proposal, { principal, approve }),
    commitAction(profile, proposal, { principal, approve })]);
  assert.deepEqual(results.find(receipt => receipt.result)?.result, { messageId: 'sent-1' });
  assert.deepEqual(sent, [{ args: { to: 'owner@example.test', body: inputs.message }, idempotencyKey: proposal.id }]);
  assert.deepEqual(await commitAction(profile, proposal, { principal, approve: () => assert.fail('repeat approval') }),
    { id: proposal.id, status: 'completed' });
});

test('a dispatch error is recorded as unknown and the proposal is never sent again', async t => {
  let calls = 0;
  const { profile } = await setup(t, async () => { calls++; throw new Error('Connection lost after send'); });
  const { proposal } = await prepareAction(profile, route, inputs, principal);
  const approval = { principal, approve: () => true };
  assert.equal((await commitAction(profile, proposal, approval)).status, 'unknown');
  assert.equal((await commitAction(profile, proposal, approval)).status, 'unknown');
  assert.equal(calls, 1);
});

test('a configured external MCP action receives approved inputs and the idempotency key', async t => {
  const call = mcpAction({ command: process.execPath, tool: 'send', idempotencyArgument: 'key',
    args: ['--input-type=module', '--eval', `
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
      import { z } from 'zod';
      const server = new McpServer({ name: 'mock-mail', version: '1.0.0' });
      server.registerTool('send', { inputSchema: { to: z.string(), body: z.string(), key: z.uuid() } },
        async ({ to, body, key }) => ({ content: [], structuredContent: { messageId: to + ':' + key, raw: body } }));
      await server.connect(new StdioServerTransport());
    `],
  });
  const { profile } = await setup(t, call);
  const { proposal } = await prepareAction(profile, route, inputs, principal);
  const receipt = await commitAction(profile, proposal, { principal, approve: () => true });
  assert.deepEqual(receipt.result, { messageId: 'owner@example.test:' + proposal.id });
});

test('opt-in local MCP provides draft inputs and a proposal without a commit tool', async t => {
  const { profile } = await setup(t, () => assert.fail('MCP preparation dispatched an action'));
  profile.actions.get(route).draftContext = ['email'];
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const server = makeMcp(profile, { prepareActions: true });
  const client = new Client({ name: 'action-preparation-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(remote);
  await client.connect(local);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ['replay_workflow', 'prepare_workflow_action']);
  const prepare = inputs => client.callTool({ name: 'prepare_workflow_action', arguments: { request, inputs } });
  const missing = JSON.parse((await prepare({})).content[0].text);
  assert.equal(missing.missing.message.source, 'model');
  assert.deepEqual(missing.context, { email: 'owner@example.test' });
  assert.equal((await prepare({ account: 'acct-18' })).isError, true);
  const preview = JSON.parse((await prepare({ message: inputs.message })).content[0].text);
  assert.equal(preview.status, 'needs_approval');
  assert.deepEqual(preview.proposal.args, { body: inputs.message, to: 'owner@example.test' });
});
