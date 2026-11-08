#!/usr/bin/env node
import { capture, execute, httpDispatcher, requireThat } from './src/workflow.mjs';
import { indexRouteExamples, load, lookupWithExamples, openPlaybook, publish, renderPlaybook, validateRoute } from './src/playbook.mjs';
import { routeRequest } from './src/host-routing.mjs';
import { registry as demoRegistry, startFixture } from './src/fixture.mjs';
import { listProfiles, loadProfile, profileName, readJsonFile as read } from './src/profiles.mjs';
import { createInterface } from 'node:readline/promises';
import { commitAction, matchAction, prepareAction } from './src/actions.mjs';

const usage = `Workflow replay
  profiles
  demo
  PROFILE tools
  PROFILE lookup "task description"
  PROFILE route "task request"
  PROFILE run ROUTE INPUTS.json
  PROFILE learn ROUTE "description" WORKFLOW.json INPUTS.json
  PROFILE index ROUTE EXAMPLES.json
  PROFILE playbook
  PROFILE action-match "task request"
  PROFILE action-prepare ROUTE INPUTS.json
  PROFILE action-approve PREVIEW.json

Profiles and per-profile playbooks are stored in ~/.workflow-replay.`;
const arity = { tools: 0, lookup: 1, route: 1, run: 2, learn: 4, index: 2, playbook: 0 };
const actionArity = { 'action-match': 1, 'action-prepare': 2, 'action-approve': 1 };
const output = data => process.stdout.write(JSON.stringify(data) + '\n');

async function terminalApproval(proposal) {
  requireThat(process.stdin.isTTY && process.stderr.isTTY, 'Open a terminal to review and approve the action');
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const preview = JSON.stringify(proposal, null, 2).replace(/[\u2028-\u202e\u2066-\u2069]/g,
      char => '\\u' + char.charCodeAt(0).toString(16));
    return await terminal.question(preview + '\nType approve to execute this action: ') === 'approve';
  } finally {
    terminal.close();
  }
}

async function demo() {
  const spec = read(new URL('./examples/account-health.json', import.meta.url));
  const fixture = await startFixture({ delay: 1 });
  const db = openPlaybook(':memory:');
  try {
    const dispatch = httpDispatcher(fixture.origin, demoRegistry);
    const captured = await capture(spec, { customer: 'alpha-demo' }, demoRegistry, dispatch);
    publish(db, 'account-health', 'Read account health with billing and support', captured.workflow);
    indexRouteExamples(db, 'account-health', ['Check the account health report']);
    const request = 'Check account health for beta-demo';
    const receipt = await routeRequest({
      request, db, registry: demoRegistry, dispatch,
      local: { contracts: new Map([['account-health', text => {
        const match = /^Check account health for ((?:alpha|beta)-demo)$/.exec(text);
        return match ? { customer: match[1] } : undefined;
      }]]) },
    });
    requireThat(receipt.kind === 'local' && receipt.result.tier === 'basic'
      && receipt.result.overdue === 0 && receipt.result.open === 1, 'Replay demo failed');
    output({ profile: 'synthetic-demo', ...receipt });
  } finally {
    db.close();
    await fixture.close();
  }
}

async function main([profile, command, ...args]) {
  if (!profile || profile === '--help') {
    console.log(usage);
    return;
  }
  if (profile === 'profiles' && !command) {
    output(listProfiles());
    return;
  }
  if (profile === 'demo' && !command) return demo();
  requireThat(profileName.test(profile) && (Object.hasOwn(arity, command) && args.length === arity[command]
    || Object.hasOwn(actionArity, command) && args.length === actionArity[command]), usage);

  const config = await loadProfile(profile);
  const principal = 'local-cli';
  if (command === 'action-match') return output(matchAction(config, args[0]) ?? { status: 'no_match' });
  if (command === 'action-prepare') return output(await prepareAction(config, args[0], read(args[1]), principal));
  if (command === 'action-approve') {
    const { proposal } = read(args[0]);
    return output(await commitAction(config, proposal, { principal, approve: terminalApproval }));
  }
  const { registry, dispatch, contracts, expand, database } = config;
  if (command === 'tools') {
    output(Object.fromEntries([...registry].map(([op, { args, fields }]) => [op, { args, fields }])));
    return;
  }
  const db = openPlaybook(database);
  try {
    if (command === 'lookup') output(lookupWithExamples(db, args[0], expand?.(args[0]).slice(0, 256)));
    if (command === 'playbook') console.log(renderPlaybook(db));
    if (command === 'route') output(await routeRequest({
      request: args[0], db, registry, dispatch, local: { contracts, expand },
    }));
    if (command === 'index') {
      indexRouteExamples(db, args[0], read(args[1]));
      output({ route: args[0], indexed: true });
    }
    if (command === 'run') output(await execute(load(db, args[0]), read(args[1]), registry, dispatch));
    if (command === 'learn') {
      const [route, description, spec, inputs] = args;
      validateRoute(route, description);
      const recorded = await capture(read(spec), read(inputs), registry, dispatch);
      output({ ...publish(db, route, description, recorded.workflow), result: recorded.result });
    }
  } finally {
    db.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
