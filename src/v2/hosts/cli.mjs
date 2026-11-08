#!/usr/bin/env node
// Operator CLI for a v2 profile.
//   node src/v2/hosts/cli.mjs PROFILE status          routes and their states
//   node src/v2/hosts/cli.mjs PROFILE learn           mine recorded episodes, verify, consolidate
//   node src/v2/hosts/cli.mjs PROFILE approve ROUTE   promote a route that passed shadow mode
//   node src/v2/hosts/cli.mjs PROFILE ask "request"   route a request and show what the harness would do
//   node src/v2/hosts/cli.mjs PROFILE feedback EPISODE good|bad   rate a recorded episode
//   node src/v2/hosts/cli.mjs PROFILE commit PROPOSAL.json         review and approve a prepared write in this terminal
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { loadHarness } from './profile.mjs';

const [profile, command, argument] = process.argv.slice(2);
try {
  const harness = await loadHarness(profile);
  if (command === 'status') {
    console.log(JSON.stringify(harness.routes().map(route => ({ id: route.id, state: route.state, description: route.description,
      inputs: route.plan.inputs, outputs: Object.keys(route.plan.output), shadow: route.stats.shadow, ready: !!route.stats.ready,
      hits: route.stats.hits ?? 0 })), null, 2));
  } else if (command === 'learn') {
    console.log(JSON.stringify(await harness.learn(), (key, value) => (key === 'shape' ? undefined : value), 2));
  } else if (command === 'approve') {
    console.log(JSON.stringify(harness.approve(argument).state));
  } else if (command === 'ask') {
    const result = await harness.handle(argument, { session: 'cli', host: { canBlock: false } });
    console.log(JSON.stringify({ mode: result.mode, route: result.route, output: result.output, decision: result.decision }, null, 2));
  } else if (command === 'feedback') {
    harness.feedback(Number(argument), process.argv[5] === 'good');
    console.log('recorded');
  } else if (command === 'commit') {
    const proposal = JSON.parse(readFileSync(argument, 'utf8'));
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const result = await harness.commit(proposal, { principal: proposal.principal ?? 'local', approve: async item => {
      if (!process.stdin.isTTY) return false;
      return (await terminal.question(`${JSON.stringify(item, null, 2)}\nType approve to run this action: `)) === 'approve';
    } });
    terminal.close();
    console.log(JSON.stringify(result));
  } else {
    console.log('Usage: cli.mjs PROFILE status | learn | approve ROUTE | ask "request" | feedback EPISODE good|bad | commit PROPOSAL.json');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
