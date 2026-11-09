#!/usr/bin/env node
// MCP gateway (stdio): exposes a profile's operations with projected results, run_workflow / find_workflow for
// learned workflows, mid-turn speculation, and commit_workflow_action for approval-gated writes.
// Register it as "workflow-replay":  node src/v2/hosts/mcp-gateway.mjs --profile NAME
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { canonical } from '../util.mjs';
import { loadHarness } from './profile.mjs';
import { decide, settingsSources } from './permissions.mjs';

export const SERVER = 'workflow-replay';
const zodFor = type => (type === 'integer' ? z.number().int() : type === 'number' ? z.number() : type === 'boolean' ? z.boolean()
  : type === 'json' ? z.any() : z.string().max(4096));

// Approval for a prepared write, in Claude Code terms:
//  1. If the user's Claude Code permissions deny the underlying write tool: refuse.
//  2. If they allow it (explicit allow rule or bypassPermissions): run it.
//  3. Otherwise ask the user: an MCP elicitation prompt when the client supports it; if not, hand the exact call
//     back so the model calls the write tool itself, which makes Claude Code show its own permission prompt.
export async function approveWrite({ harness, server, proposalId, sources = settingsSources() }) {
  const proposal = harness.getProposal(proposalId);
  if (!proposal) return { status: 'unknown_proposal' };
  if (proposal.status !== 'pending') return { status: proposal.status, id: proposal.id };
  const tool = `mcp__${SERVER}__${proposal.op}`;
  const permission = decide(tool, sources);
  if (permission.decision === 'deny') {
    return { status: 'refused', reason: `Claude Code permissions deny ${tool} (${permission.rule} in ${permission.source})` };
  }
  if (permission.decision === 'allow') {
    return { ...(await harness.commitById(proposal.id, { approve: async () => true })), approvedBy: `permission rule ${permission.rule}` };
  }
  const canElicit = !!server?.server?.getClientCapabilities?.()?.elicitation;
  if (canElicit) {
    const answer = await server.server.elicitInput({
      message: `Approve this action?\n${proposal.op} ${JSON.stringify(proposal.args)}\nPrepared by workflow ${proposal.route}. `
        + `Your Claude Code permissions do not allow ${tool} without asking.`,
      requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Run this action' } }, required: ['approve'] },
    });
    const approved = answer?.action === 'accept' && answer.content?.approve === true;
    return { ...(await harness.commitById(proposal.id, { approve: async () => approved })), approvedBy: approved ? 'user prompt' : null };
  }
  return { status: 'needs_user_approval', id: proposal.id, call: { tool, args: proposal.args },
    instructions: `Your permissions do not allow ${tool} without asking. Show the user this action. If they want it, call ${tool} `
      + 'with exactly these arguments; Claude Code will ask them to confirm.' };
}

export function makeGatewayServer(harness) {
  const server = new McpServer({ name: SERVER, version: '2.1.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  const reply = data => ({ content: [{ type: 'text', text: canonical(data) }] });
  for (const [op, tool] of harness.registry) {
    const write = tool.effect === 'write';
    const optional = new Set(tool.optional ?? []);
    const inputSchema = Object.fromEntries(Object.entries(tool.args).map(([name, type]) =>
      [name, optional.has(name) ? zodFor(type).optional() : zodFor(type)]));
    // Write tools are marked destructive, so Claude Code applies its own permission prompt to every direct call.
    server.registerTool(op, { description: tool.description, inputSchema, annotations: write ? destructive : readOnly }, async input => {
      const gate = harness.gateway({ request: '', record: false, speculate: false, allowWrites: write, principal: harness.defaultPrincipal });
      return reply(await gate.call(op, input));
    });
  }
  server.registerTool('find_workflow', { description: 'Search saved workflows by what you need. Returns up to 3 with inputs and outputs.',
    inputSchema: { query: z.string().max(200) }, annotations: readOnly }, async ({ query }) => reply(harness.findWorkflows(query)));
  server.registerTool('run_workflow', {
    description: 'Run a verified saved workflow in one call. Call with no route to list them. Read workflows return the result; '
      + 'write workflows return a proposal (nothing runs) to pass to commit_workflow_action.',
    inputSchema: { route: z.string().max(80).optional(), inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() },
    annotations: readOnly,
  }, async ({ route, inputs }) => {
    if (!route) {
      return reply(harness.routes(['live']).map(item => ({ route: item.id, description: item.description,
        inputs: Object.fromEntries(Object.entries(item.plan.inputs).map(([name, spec]) => [name, spec.type])),
        returns: Object.keys(item.plan.output) })));
    }
    return reply(await harness.gateway({ record: false, session: 'claude-code', principal: harness.defaultPrincipal }).runWorkflow(route, inputs ?? {}));
  });
  server.registerTool('commit_workflow_action', {
    description: 'Execute a write that run_workflow prepared. Checks the user\'s Claude Code permissions for the underlying tool '
      + 'and asks the user first when they do not allow it. Runs at most once per proposal.',
    inputSchema: { proposal_id: z.string().max(64) }, annotations: destructive,
  }, async ({ proposal_id: proposalId }) => reply(await approveWrite({ harness, server, proposalId })));
  return server;
}

if (process.argv[1]?.endsWith('mcp-gateway.mjs')) {
  const { values } = parseArgs({ options: { profile: { type: 'string' } } });
  const harness = await loadHarness(values.profile);
  await makeGatewayServer(harness).connect(new StdioServerTransport());
}
