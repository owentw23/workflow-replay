import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { compactReceipt, replayConfigured } from './integration.mjs';
import { matchAction, prepareAction } from './actions.mjs';
import { json, requireThat } from './workflow.mjs';

const scope = 'workflow:read';
const metadataPath = '/.well-known/oauth-protected-resource/mcp';
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

export function makeMcp(profile, { authorize, challenge, description, prepareActions = false } = {}) {
  const server = new McpServer({ name: 'workflow-replay', version: '0.1.0' });
  const securitySchemes = authorize ? [{ type: 'oauth2', scopes: [scope] }] : [{ type: 'noauth' }];
  server.registerTool('replay_workflow', {
    title: 'Replay a read-only workflow',
    description: description || 'Run a configured read-only workflow for a complete, explicit request. '
      + 'If no workflow covers the request, continue with ordinary tools.',
    inputSchema: { request: z.string().min(1).max(256) },
    annotations,
    _meta: { securitySchemes },
  }, async ({ request }) => {
    if (authorize && !await authorize()) return {
      isError: true,
      content: [{ type: 'text', text: 'Sign in to use this connector.' }],
      _meta: { 'mcp/www_authenticate': [challenge] },
    };
    try {
      const data = compactReceipt(await replayConfigured(profile, request));
      return { content: [{ type: 'text', text: data ?? '{"status":"no_match"}' }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Workflow unavailable. Continue with ordinary tools.' }] };
    }
  });
  if (prepareActions && !authorize) {
    server.registerTool('prepare_workflow_action', {
      title: 'Prepare an external action for approval',
      description: 'Match the complete original user request against configured action workflows. '
        + 'Fill any returned typed placeholders, then show the returned proposal to the user for separate approval. '
        + 'This tool does not execute the action.',
      inputSchema: {
        request: z.string().min(1).max(256),
        inputs: z.record(z.string().max(48), z.union([z.string().max(4096), z.number().int(), z.boolean()])).optional(),
      },
      annotations,
    }, async ({ request, inputs = {} }) => {
      try {
        const matched = matchAction(profile, request);
        if (!matched) return { content: [{ type: 'text', text: '{"status":"no_match"}' }] };
        requireThat(Object.entries(matched.inputs).every(([field, value]) => !Object.hasOwn(inputs, field)
          || inputs[field] === value), 'Cannot change inputs taken from the request');
        const result = await prepareAction(profile, matched.route, { ...matched.inputs, ...inputs }, 'local-cli');
        return { content: [{ type: 'text', text: json(result) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Action preparation failed.' }] };
      }
    });
  }
  return server;
}

function secureUrl(value) {
  const url = new URL(value);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'Expected a configured HTTPS URL');
  return url;
}

export function oauthConfig({ publicUrl, issuer, jwksUrl, subject }) {
  const resource = secureUrl(publicUrl);
  secureUrl(issuer);
  const keys = createRemoteJWKSet(secureUrl(jwksUrl), { timeoutDuration: 3000 });
  requireThat(resource.pathname === '/mcp' && typeof subject === 'string' && subject.trim(),
    'Configure the public /mcp URL and one allowed OAuth subject');
  return {
    origin: resource.origin,
    metadata: { resource: resource.href, authorization_servers: [issuer], scopes_supported: [scope] },
    verify: authorization => verifyAccessToken(authorization, keys, { issuer, audience: resource.href, subject }),
  };
}

export async function verifyAccessToken(authorization, keys, expected) {
  if (typeof authorization !== 'string' || authorization.length > 8192) return false;
  const token = /^Bearer ([\w.-]+)$/i.exec(authorization)?.[1];
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, keys, {
      ...expected, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp'],
    });
    return typeof payload.scope === 'string' && payload.scope.split(' ').includes(scope);
  } catch { return false; }
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 64 * 1024) return;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function makeHttpServer(profile, oauth, { description, authMode = 'tool' } = {}) {
  let active = 0;
  const challenge = `Bearer resource_metadata="${oauth.origin}${metadataPath}", scope="${scope}", error="invalid_token", error_description="A valid workflow access token is required"`;
  return createServer({ requestTimeout: 10_000, headersTimeout: 8_000 }, async (request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== oauth.origin) return reply(response, 403, { error: 'Origin denied' });
    if (request.method === 'GET' && [metadataPath, '/.well-known/oauth-protected-resource'].includes(request.url)) {
      return reply(response, 200, oauth.metadata);
    }
    if (request.url !== '/mcp') return reply(response, 404, { error: 'Not found' });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return reply(response, 405, { error: 'Use POST' });
    }
    if (active >= 16) return reply(response, 503, { error: 'Server busy' });
    active++;
    let server;
    try {
      const verify = () => oauth.verify(request.headers.authorization);
      if (authMode === 'resource' && !await verify()) {
        response.setHeader('www-authenticate', challenge);
        return reply(response, 401, { error: 'invalid_token' });
      }
      let body;
      try { body = await readBody(request); } catch { return reply(response, 400, { error: 'Invalid JSON' }); }
      if (!body) return reply(response, 413, { error: 'Request too large' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      server = makeMcp(profile, { description, challenge,
        authorize: authMode === 'resource' ? () => true : verify });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) reply(response, 500, { error: 'Connector unavailable' });
      else if (!response.writableEnded) response.end();
    } finally {
      active--;
      await server?.close().catch(() => {});
    }
  });
}
