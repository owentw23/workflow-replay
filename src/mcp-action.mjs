import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute } from 'node:path';
import { requireThat } from './workflow.mjs';

// Configure these values in a trusted profile. Only typed tool arguments come from the prompt.
export function mcpAction({ command, args, cwd, env, tool, idempotencyArgument }) {
  requireThat(typeof command === 'string' && isAbsolute(command) && typeof tool === 'string' && tool.length,
    'Configure an absolute MCP server executable and a fixed tool name');
  return async (input, { idempotencyKey, signal }) => {
    requireThat(!idempotencyArgument || !Object.hasOwn(input, idempotencyArgument), 'Idempotency argument is reserved');
    const transport = new StdioClientTransport({ command, args, cwd, env });
    const client = new Client({ name: 'workflow-replay-action', version: '0.1.0' });
    const close = () => { void transport.close().catch(() => {}); };
    signal.throwIfAborted();
    signal.addEventListener('abort', close, { once: true });
    try {
      await client.connect(transport, { signal });
      const result = await client.callTool({ name: tool, arguments: idempotencyArgument
        ? { ...input, [idempotencyArgument]: idempotencyKey } : input }, undefined, { signal });
      requireThat(!result.isError && result.structuredContent, 'MCP action did not return a structured success result');
      return result.structuredContent;
    } finally {
      signal.removeEventListener('abort', close);
      await client.close();
    }
  };
}
