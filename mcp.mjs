#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadProfile } from './src/profiles.mjs';
import { makeHttpServer, makeMcp, oauthConfig } from './src/mcp-service.mjs';
import { requireThat } from './src/workflow.mjs';

try {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' }, http: { type: 'boolean' }, port: { type: 'string', default: '8788' },
    'prepare-actions': { type: 'boolean' },
  } });
  requireThat(values.profile, 'Usage: workflow-replay-mcp --profile NAME [--prepare-actions | --http --port 8788]');
  requireThat(!values.http || !values['prepare-actions'], 'Action preparation is available only on stdio');
  const profile = await loadProfile(values.profile);
  requireThat(profile.contracts.size || (values['prepare-actions'] && profile.actions.size),
    'The profile needs a trusted request contract');
  const description = process.env.REPLAY_MCP_DESCRIPTION;
  requireThat(!description || description.length <= 360, 'Tool description must be at most 360 characters');
  if (!values.http) {
    await makeMcp(profile, { description, prepareActions: values['prepare-actions'] }).connect(new StdioServerTransport());
  } else {
    const authMode = process.env.REPLAY_MCP_AUTH_MODE || 'tool';
    requireThat(['tool', 'resource'].includes(authMode), 'REPLAY_MCP_AUTH_MODE must be tool or resource');
    const oauth = oauthConfig({
      publicUrl: process.env.REPLAY_PUBLIC_MCP_URL,
      issuer: process.env.REPLAY_OAUTH_ISSUER,
      jwksUrl: process.env.REPLAY_OAUTH_JWKS_URL,
      subject: process.env.REPLAY_OAUTH_SUBJECT,
    });
    const port = Number(values.port);
    requireThat(Number.isInteger(port) && port >= 1 && port <= 65535, 'Invalid port');
    const server = makeHttpServer(profile, oauth, { description, authMode });
    server.on('error', () => { console.error('Unable to bind the MCP listener'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.error(`MCP listening on 127.0.0.1:${port}/mcp`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
