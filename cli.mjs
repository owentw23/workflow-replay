import { readFileSync } from 'node:fs';
import { capture, execute, httpDispatcher, requireThat } from './src/workflow.mjs';
import { load, lookup, openPlaybook, publish, renderPlaybook, validateRoute } from './src/playbook.mjs';
import { registry, startFixture } from './src/fixture.mjs';

const usage = `Commands
  tools
  fixture
  lookup "task description"
  learn ROUTE "description" WORKFLOW.json INPUTS.json
  run ROUTE INPUTS.json
  playbook

Set REPLAY_DB for the SQLite path (default .replay/playbook.sqlite).
Set REPLAY_ORIGIN for the fixture origin (default http://127.0.0.1:8787).
Set REPLAY_PORT to change the fixture's listening port.`;

const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const arity = { tools: 0, fixture: 0, lookup: 1, learn: 4, run: 2, playbook: 0 };

async function main([command, ...args]) {
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }
  requireThat(Object.hasOwn(arity, command) && args.length === arity[command], usage);
  if (command === 'fixture') {
    const fixture = await startFixture({ port: Number(process.env.REPLAY_PORT ?? 8787) });
    write({ origin: fixture.origin });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fixture.close());
    return;
  }
  if (command === 'tools') {
    write(Object.fromEntries([...registry].map(([op, { args, fields }]) => [op, { args, fields }])));
    return;
  }
  const db = openPlaybook(process.env.REPLAY_DB ?? '.replay/playbook.sqlite');
  try {
    if (command === 'lookup') write(lookup(db, args[0]));
    if (command === 'playbook') console.log(renderPlaybook(db));
    if (command === 'learn' || command === 'run') {
      const dispatch = httpDispatcher(process.env.REPLAY_ORIGIN ?? 'http://127.0.0.1:8787', registry);
      const [route] = args;
      if (command === 'learn') {
        const [, description, specPath, inputsPath] = args;
        validateRoute(route, description);
        const { result, workflow } = await capture(read(specPath), read(inputsPath), registry, dispatch);
        write({ ...publish(db, route, description, workflow), result });
      } else {
        write(await execute(load(db, route), read(args[1]), registry, dispatch));
      }
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
