import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateKeyPair, SignJWT } from 'jose';
import { makeHttpServer, verifyAccessToken } from '../src/mcp-service.mjs';
import { openPlaybook } from '../src/playbook.mjs';
import * as demo from '../examples/demo-profile.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const prompt = 'How many pencils are in the demo inventory?';

async function localHome(t) {
  const temp = await realpath(tmpdir());
  const home = await mkdtemp(join(temp, 'workflow-replay-test-'));
  assert.equal(dirname(await realpath(home)), temp);
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKFLOW_REPLAY_HOME: join(home, 'replay'),
    CODEX_HOME: join(home, '.codex') };
  return { home, env };
}

function run(args, { env, input = '', executable = process.execPath, node = true }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, node ? ['--disable-warning=ExperimentalWarning', ...args] : args, {
      cwd: projectRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(15000),
    });
    const out = [];
    const err = [];
    child.stdout.on('data', value => out.push(value));
    child.stderr.on('data', value => err.push(value));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString())
      : reject(new Error(Buffer.concat(err).toString() || 'Command failed')));
    child.stdin.end(input);
  });
}

test('installers preserve other hooks, bind a workspace, and remove their own hook', async t => {
  const { home, env } = await localHome(t);
  const directory = join(home, 'project with spaces');
  await mkdir(directory);
  await mkdir(env.CODEX_HOME);
  const other = { hooks: [{ type: 'command', command: 'existing-command' }] };
  const config = join(env.CODEX_HOME, 'hooks.json');
  await writeFile(config, JSON.stringify({ hooks: { UserPromptSubmit: [other] } }));
  await run(['examples/setup-demo.mjs'], { env });
  const args = ['install.mjs', 'codex', '--project', directory, '--profile', 'replay-demo'];
  await run(args, { env });
  await run(args, { env });
  await run(['install.mjs', 'claude', ...args.slice(2)], { env });
  const installed = JSON.parse(await readFile(config, 'utf8')).hooks.UserPromptSubmit;
  assert.equal(installed.length, 2);
  assert.deepEqual(installed[0], other);
  const claude = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.hooks.UserPromptSubmit.length, 1);
  const [hook] = claude.hooks.UserPromptSubmit[0].hooks;
  const event = { hook_event_name: 'UserPromptSubmit', cwd: directory, prompt };
  const check = (input, override = {}) => run(hook.args, { env: { ...env, ...override }, input: JSON.stringify(input) });
  const result = JSON.parse(await check(event, { WORKFLOW_REPLAY_HOME: join(home, 'ignored') }));
  assert.match(result.hookSpecificOutput.additionalContext, /"available":27/);
  const codexHook = installed[1].hooks[0];
  const [executable, commandArgs] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', codexHook.commandWindows]]
    : ['/bin/sh', ['-c', codexHook.command]];
  assert.equal(await run(commandArgs, { executable, node: false, env, input: JSON.stringify(event) }),
    await check(event));
  assert.equal(await check({ ...event, cwd: home }), '');
  assert.equal(await check({ ...event, prompt: prompt + ' Email the result.' }), '');
  assert.equal(await check({ ...event, permission_mode: 'plan' }), '');
  await run(['install.mjs', 'codex', '--remove'], { env });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).hooks.UserPromptSubmit, [other]);
});

test('MCP stdio returns one compact receipt through the official SDK client', async t => {
  const { env } = await localHome(t);
  await run(['examples/setup-demo.mjs'], { env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, cwd: projectRoot, env,
    args: ['--disable-warning=ExperimentalWarning', 'mcp.mjs', '--profile', 'replay-demo'],
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['replay_workflow']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const result = await client.callTool({ name: 'replay_workflow', arguments: { request: prompt } });
  assert.deepEqual(JSON.parse(result.content[0].text), { route: 'demo-inventory', result: { available: 27 } });
});

test('remote MCP validates issuer, audience, expiry, subject and scope before dispatch', async t => {
  const { env } = await localHome(t);
  await run(['examples/setup-demo.mjs'], { env });
  const database = join(env.WORKFLOW_REPLAY_HOME, 'playbooks', 'replay-demo.sqlite');
  openPlaybook(database).close();
  let calls = 0;
  const profile = { ...demo, database, dispatch: (...args) => { calls++; return demo.dispatch(...args); } };
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const claims = { issuer: 'https://identity.example', audience: 'https://replay.example/mcp', subject: 'owner' };
  const sign = (subject, scope, expiry = '5m', audience = claims.audience, issuer = claims.issuer) => new SignJWT({ scope })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setExpirationTime(expiry).sign(privateKey);
  const oauth = { origin: 'https://replay.example', metadata: { resource: claims.audience },
    verify: value => verifyAccessToken(value, publicKey, claims) };
  const server = makeHttpServer(profile, oauth);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (method, params, token) => fetch(base + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal((await fetch(base + '/.well-known/oauth-protected-resource/mcp')).status, 200);
  const tools = await (await post('tools/list', {})).json();
  assert.equal(tools.result.tools[0]._meta.securitySchemes[0].type, 'oauth2');
  const args = { name: 'replay_workflow', arguments: { request: prompt } };
  for (const token of [undefined, await sign('other', 'workflow:read'), await sign('owner', 'other'),
    await sign('owner', 'workflow:read', '1s ago'), await sign('owner', 'workflow:read', '5m', 'https://other.example'),
    await sign('owner', 'workflow:read', '5m', claims.audience, 'https://other.example')]) {
    const denied = await (await post('tools/call', args, token)).json();
    assert.equal(denied.result.isError, true);
    assert.ok(denied.result._meta['mcp/www_authenticate']);
  }
  assert.equal(calls, 0);
  const allowed = await (await post('tools/call', args, await sign('owner', 'workflow:read'))).json();
  assert.equal(JSON.parse(allowed.result.content[0].text).result.available, 27);
  assert.equal(calls, 1);

  const protectedServer = makeHttpServer(profile, oauth, { authMode: 'resource' });
  await new Promise(resolve => protectedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => protectedServer.close(resolve)));
  const protectedUrl = new URL(`http://127.0.0.1:${protectedServer.address().port}/mcp`);
  const denied = await fetch(protectedUrl, { method: 'POST' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata="https:\/\/replay\.example\//);
  await denied.json();
  assert.equal(calls, 1);
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(protectedUrl, { requestInit: {
    headers: { authorization: 'Bearer ' + await sign('owner', 'workflow:read') },
  } });
  t.after(() => client.close());
  await client.connect(transport);
  const receipt = await client.callTool(args);
  assert.equal(JSON.parse(receipt.content[0].text).result.available, 27);
  assert.equal(calls, 2);
});
