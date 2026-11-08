#!/usr/bin/env node
// Wrap an existing MCP server or OpenAPI service as a v2 profile, without hand-writing one.
//   node src/v2/hosts/wrap.mjs mcp NAME [--read-only] [--force] -- <command> [args...]
//   node src/v2/hosts/wrap.mjs openapi NAME --spec <file.json> --base <https://origin> [--token-env VAR] [--read-only] [--force]
// The generated profile lists every operation with effect "read" or "write" and the reason, so it can be reviewed
// and edited. Unclear operations default to "write" (approval required). --read-only drops write operations
// entirely, which is the right setting for systems that must never be changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireThat } from '../util.mjs';
import { v2Home } from './profile.mjs';

const READ_VERBS = new Set(['get', 'list', 'find', 'search', 'read', 'fetch', 'query', 'lookup', 'describe', 'show', 'count',
  'check', 'view', 'retrieve', 'browse', 'calculate', 'estimate', 'status']);
const WRITE_VERBS = new Set(['create', 'update', 'delete', 'remove', 'cancel', 'send', 'post', 'put', 'patch', 'modify', 'add',
  'set', 'write', 'insert', 'upsert', 'exchange', 'return', 'book', 'pay', 'refund', 'transfer', 'approve', 'reject', 'submit',
  'archive', 'move', 'rename', 'assign', 'close', 'open', 'reset', 'execute', 'run', 'trigger', 'publish', 'upload', 'import']);

const firstWord = name => String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  .find(word => READ_VERBS.has(word) || WRITE_VERBS.has(word));

export function classifyMcpTool(tool) {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === true) return { effect: 'read', reason: 'readOnlyHint' };
  if (hints.destructiveHint === true || hints.readOnlyHint === false) return { effect: 'write', reason: 'annotations' };
  const verb = firstWord(tool.name);
  if (verb && READ_VERBS.has(verb)) return { effect: 'read', reason: `name starts with "${verb}"` };
  if (verb && WRITE_VERBS.has(verb)) return { effect: 'write', reason: `name starts with "${verb}"` };
  return { effect: 'write', reason: 'unclear, treated as write (approval required)' };
}

const typeOf = schema => {
  const type = Array.isArray(schema?.type) ? schema.type.find(item => item !== 'null') : schema?.type;
  return type === 'integer' ? 'integer' : type === 'number' ? 'number' : type === 'boolean' ? 'boolean'
    : type === 'object' || type === 'array' ? 'json' : 'string';
};

export function registryEntryFromSchema(description, schema, effect) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const args = Object.fromEntries(Object.entries(properties).map(([name, prop]) => [name, typeOf(prop)]));
  const optional = Object.keys(args).filter(name => !required.has(name));
  return { description: String(description ?? '').slice(0, 500), args, ...(optional.length ? { optional } : {}), effect };
}

// ---------- MCP ----------
export function mcpUpstream({ command, args = [], env, cwd }) {
  let client;
  let connecting;
  async function connect() {
    if (client) return client;
    connecting ??= (async () => {
      const candidate = new Client({ name: 'workflow-replay-wrap', version: '2.1.0' });
      await candidate.connect(new StdioClientTransport({ command, args, env: env ? { ...process.env, ...env } : undefined, cwd }));
      client = candidate;
      return client;
    })();
    return connecting;
  }
  const upstream = async (op, input) => {
    const result = await (await connect()).callTool({ name: op, arguments: input ?? {} });
    if (result.isError) throw new Error(`Upstream tool ${op} failed`);
    if (result.structuredContent) return result.structuredContent;
    const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
    try { return JSON.parse(text); } catch { return text; }
  };
  upstream.close = async () => { await client?.close(); client = null; connecting = null; };
  upstream.listTools = async () => (await (await connect()).listTools()).tools;
  return upstream;
}

export async function describeMcpServer({ command, args, env, cwd, readOnly = false }) {
  const upstream = mcpUpstream({ command, args, env, cwd });
  try {
    const tools = await upstream.listTools();
    const operations = tools.map(tool => {
      const { effect, reason } = classifyMcpTool(tool);
      return { name: tool.name, reason, entry: registryEntryFromSchema(tool.description, tool.inputSchema, effect) };
    }).filter(item => !readOnly || item.entry.effect === 'read');
    return operations;
  } finally {
    await upstream.close();
  }
}

// ---------- OpenAPI ----------
export function describeOpenApi(spec, { readOnly = false } = {}) {
  requireThat(spec?.paths && typeof spec.paths === 'object', 'Expected an OpenAPI document with paths');
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method];
      if (!op) continue;
      const effect = method === 'get' || method === 'head' ? 'read' : 'write';
      if (readOnly && effect === 'write') continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].filter(param => ['path', 'query'].includes(param.in));
      const body = op.requestBody?.content?.['application/json']?.schema;
      const properties = { ...Object.fromEntries(params.map(param => [param.name, param.schema ?? { type: 'string' }])), ...(body?.properties ?? {}) };
      const required = [...params.filter(param => param.required || param.in === 'path').map(param => param.name), ...(body?.required ?? [])];
      const name = String(op.operationId ?? `${method}_${path}`).replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
      operations.push({
        name, reason: `HTTP ${method.toUpperCase()}`,
        entry: registryEntryFromSchema(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`, { properties, required }, effect),
        http: { method: method.toUpperCase(), path, path_params: params.filter(p => p.in === 'path').map(p => p.name),
          query_params: params.filter(p => p.in === 'query').map(p => p.name), body: Object.keys(body?.properties ?? {}) },
      });
    }
  }
  return operations;
}

export function openApiUpstream({ base, operations, tokenEnv }) {
  const origin = new URL(base);
  requireThat(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)),
    'The OpenAPI base must be HTTPS (or loopback HTTP for local testing)');
  const byName = new Map(operations.map(op => [op.name, op.http]));
  return async (op, input = {}) => {
    const http = byName.get(op);
    requireThat(http, `Unknown operation ${op}`);
    let path = http.path;
    for (const name of http.path_params) path = path.replace(`{${name}}`, encodeURIComponent(String(input[name])));
    const url = new URL(path.replace(/^\//, ''), origin.href.endsWith('/') ? origin.href : `${origin.href}/`);
    requireThat(url.origin === origin.origin, 'Operation must stay on the configured origin');
    for (const name of http.query_params) if (input[name] !== undefined && input[name] !== null) url.searchParams.set(name, String(input[name]));
    const body = http.body.length ? Object.fromEntries(http.body.filter(name => input[name] !== undefined).map(name => [name, input[name]])) : null;
    const token = tokenEnv ? process.env[tokenEnv] : null;
    requireThat(!tokenEnv || token, `Set ${tokenEnv} for this service`);
    const response = await fetch(url, { method: http.method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    requireThat(text.length <= 1024 * 1024, 'Response too large');
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${op}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

// ---------- Profile generation ----------
const moduleUrl = name => pathToFileURL(join(import.meta.dirname, name)).href;

export function renderProfile({ source, operations, upstreamCode }) {
  const lines = [
    `// Generated by workflow-replay wrap from ${source}.`,
    '// Review every operation: effect "read" replays automatically, "write" always needs approval. Edit as needed.',
    `import { mcpUpstream, openApiUpstream } from '${moduleUrl('wrap.mjs')}';`,
    '',
    'export const operations = [',
    ...operations.map(op => `  ${JSON.stringify({ name: op.name, ...op.entry, ...(op.http ? { http: op.http } : {}) })}, // ${op.reason}`),
    '];',
    'export const registry = new Map(operations.map(({ name, http, ...entry }) => [name, entry]));',
    upstreamCode,
    '',
  ];
  return lines.join('\n');
}

function writeProfile(name, text, force) {
  requireThat(/^[a-z][a-z0-9-]{0,47}$/.test(name), 'Profile names use lowercase letters, digits and dashes');
  const directory = join(v2Home, 'profiles');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.mjs`);
  requireThat(force || !existsSync(path), `${path} exists; pass --force to replace it`);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

if (process.argv[1]?.endsWith('wrap.mjs')) {
  const separator = process.argv.indexOf('--');
  const own = separator >= 0 ? process.argv.slice(2, separator) : process.argv.slice(2);
  const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
  const { positionals, values } = parseArgs({ args: own, allowPositionals: true, options: {
    spec: { type: 'string' }, base: { type: 'string' }, 'token-env': { type: 'string' }, 'read-only': { type: 'boolean' }, force: { type: 'boolean' } } });
  const [kind, name] = positionals;
  try {
    let operations;
    let text;
    if (kind === 'mcp') {
      requireThat(command.length, 'Give the MCP server command after --');
      operations = await describeMcpServer({ command: command[0], args: command.slice(1), readOnly: values['read-only'] });
      text = renderProfile({ source: `MCP server: ${command.join(' ')}`, operations,
        upstreamCode: `export const upstream = mcpUpstream(${JSON.stringify({ command: command[0], args: command.slice(1) })});` });
    } else if (kind === 'openapi') {
      requireThat(values.spec && values.base, 'Give --spec and --base');
      operations = describeOpenApi(JSON.parse(readFileSync(values.spec, 'utf8')), { readOnly: values['read-only'] });
      text = renderProfile({ source: `OpenAPI spec ${values.spec}`, operations,
        upstreamCode: `export const upstream = openApiUpstream({ ...${JSON.stringify({ base: values.base, tokenEnv: values['token-env'] })}, operations });` });
    } else {
      throw new Error('Usage: wrap.mjs mcp NAME [--read-only] [--force] -- <command> [args...] | wrap.mjs openapi NAME --spec FILE --base URL [--token-env VAR] [--read-only] [--force]');
    }
    const path = writeProfile(name, text, values.force);
    for (const op of operations) console.log(`${op.entry.effect.padEnd(5)}  ${op.name}  (${op.reason})`);
    console.log(`\nWrote ${path}. Review the read/write labels, then register the gateway: mcp-gateway.mjs --profile ${name}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
