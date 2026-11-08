import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { registry, startFixture } from '../src/fixture.mjs';
import { capture, execute, httpDispatcher, startRecording } from '../src/workflow.mjs';
import { load, lookup, openPlaybook, publish, renderPlaybook } from '../src/playbook.mjs';

const spec = JSON.parse(await readFile(new URL('../examples/account-health.json', import.meta.url)));
const alpha = { customer: 'alpha-demo' };
const beta = { customer: 'beta-demo' };
const exec = promisify(execFile);

async function fixtureFor(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  return { ...fixture, dispatch: httpDispatcher(fixture.origin, registry) };
}

test('records live calls and replays with new inputs and bounded dependency concurrency', async t => {
  const fixture = await fixtureFor(t);
  const recording = startRecording(spec.inputs, alpha, registry, fixture.dispatch);
  const first = await recording.call(spec.steps[0]);
  assert.equal(first.data.tier, 'pro');
  assert.ok(first.raw.notes.length > 1);
  first.data.id = 'tampered';
  await recording.call(spec.steps[1]);
  await recording.call(spec.steps[2]);
  const learned = recording.finish(spec.output);
  assert.deepEqual(learned.result, { tier: 'pro', overdue: 2, open: 4 });
  assert.doesNotMatch(JSON.stringify(learned.workflow), /alpha-demo|notes|tampered/);
  assert.throws(() => recording.finish(spec.output), /incomplete or failed/);
  const result = await execute(learned.workflow, beta, registry, fixture.dispatch, { concurrency: 2 });
  assert.deepEqual(result, { tier: 'basic', overdue: 0, open: 1 });
  const [account, billing, support] = fixture.events.slice(3);
  assert.equal(account.path, '/account');
  assert.equal(billing.path, '/billing');
  assert.equal(support.path, '/support');
  assert.ok(billing.start >= account.end && support.start >= account.end);
  assert.ok(billing.start < support.end && support.start < billing.end);
});

test('stores a single plan for renamed and reordered aliases, keeps different outputs separate', async t => {
  const { dispatch } = await fixtureFor(t);
  const db = openPlaybook(':memory:');
  t.after(() => db.close());
  const changed = JSON.parse(JSON.stringify(spec).replaceAll('"account"', '"profile"'));
  [changed.steps[1], changed.steps[2]] = [changed.steps[2], changed.steps[1]];
  const first = await capture(spec, alpha, registry, dispatch);
  const second = await capture(changed, beta, registry, dispatch);
  const third = await capture({ ...spec, output: { tier: spec.output.tier } }, beta, registry, dispatch);
  const health = publish(db, 'account-health', 'Account health summary', first.workflow);
  const renewal = publish(db, 'renewal-prep', 'Account renewal preparation', second.workflow);
  const tier = publish(db, 'account-tier', 'Account tier overview', third.workflow);
  assert.equal(health.digest, renewal.digest);
  assert.notEqual(health.digest, tier.digest);
  assert.equal(health.category, tier.category);
  assert.equal(db.prepare('SELECT count(*) AS count FROM plans').get().count, 2);
  assert.equal(db.prepare('SELECT count(*) AS count FROM graphs').get().count, 1);
  assert.deepEqual(load(db, renewal.route), first.workflow);
  assert.match(renderPlaybook(db), /renewal-prep/);
  assert.equal(renderPlaybook(db).match(/^#### Plan /gm).length, 2);
  assert.deepEqual(lookup(db, 'renewal')[0].inputs, { customer: 'string' });
  assert.deepEqual(lookup(db, 'renewal')[0].outputs, ['open', 'overdue', 'tier']);
  assert.deepEqual(lookup(db, 'unrelated'), []);
  assert.throws(() => publish(db, health.route, 'Different contract', third.workflow), /already published/);
  assert.equal(lookup(db, 'contract').length, 0);
  publish(db, health.route, 'Account health summary', first.workflow);
  for (const route of ['alias-one', 'alias-two', 'alias-three']) {
    publish(db, route, 'Account health alias', first.workflow);
  }
  assert.equal(lookup(db, 'account').length, 3);
});

test('rejects unknown capabilities, literal arguments and invalid projections before HTTP', async t => {
  const fixture = await fixtureFor(t);
  const unknown = structuredClone(spec);
  unknown.steps[1].op = 'https://example.org';
  await assert.rejects(capture(unknown, alpha, registry, fixture.dispatch), /Unregistered operation/);
  const literal = structuredClone(spec);
  literal.steps[0].args.customer = 'alpha-demo';
  await assert.rejects(execute(literal, alpha, registry, fixture.dispatch), /Invalid step reference/);
  const unsafeOutput = structuredClone(spec);
  unsafeOutput.output.notes = { step: 'account', field: 'notes' };
  await assert.rejects(capture(unsafeOutput, alpha, registry, fixture.dispatch), /unregistered result field/);
  const forwardReference = structuredClone(spec);
  forwardReference.steps.reverse();
  await assert.rejects(execute(forwardReference, alpha, registry, fixture.dispatch), /Unknown step/);
  assert.equal(fixture.events.length, 0);
  assert.throws(() => httpDispatcher('http://example.org', registry), /loopback/);
});

test('HTTP failure invalidates the recording and output drift fails replay', async t => {
  const { dispatch } = await fixtureFor(t);
  const missing = startRecording(spec.inputs, { customer: 'unknown' }, registry, dispatch);
  await assert.rejects(missing.call(spec.steps[0]), /HTTP 404/);
  assert.throws(() => missing.finish(spec.output), /incomplete or failed/);
  const { workflow } = await capture(spec, alpha, registry, dispatch);
  await assert.rejects(execute(workflow, { customer: 'drift-demo' }, registry, dispatch), /billing.v1.overdue/);
});

test('CLI learns and replays across processes using the same local playbook', async t => {
  const fixture = await fixtureFor(t);
  const directory = await mkdtemp(join(tmpdir(), 'workflow-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'playbook.sqlite');
  const run = (...args) => exec(process.execPath, ['--disable-warning=ExperimentalWarning', 'cli.mjs', ...args], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, REPLAY_DB: dbPath, REPLAY_ORIGIN: fixture.origin },
  });
  await run('learn', 'account-health', 'Account health summary', 'examples/account-health.json', 'examples/alpha.json');
  const { stdout } = await run('run', 'account-health', 'examples/beta.json');
  assert.deepEqual(JSON.parse(stdout), { tier: 'basic', overdue: 0, open: 1 });
  const playbook = await run('playbook');
  assert.match(playbook.stdout, /account-health/);
  const file = await readFile(dbPath);
  assert.doesNotMatch(file.toString('utf8'), /alpha-demo|beta-demo|Customer requested an updated copy/);
});
