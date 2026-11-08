// A v2 profile is a trusted, user-owned module at ~/.workflow-replay/v2/profiles/NAME.mjs exporting:
//   registry  Map<op, {description, args: {name: type}}>   read-only operations only
//   upstream  async (op, args) => raw result               the real API / MCP / CLI call
//   project   (op, raw) => trimmed result                  optional
//   extract   async ({system, user}) => {value, usage}     optional small-model extractor for the router
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireThat } from '../util.mjs';
import { openStore } from '../store.mjs';
import { createCarry } from '../carry.mjs';
import { createHarness } from '../harness.mjs';

export const home = process.env.WORKFLOW_REPLAY_HOME ? resolve(process.env.WORKFLOW_REPLAY_HOME) : join(homedir(), '.workflow-replay');
export const v2Home = join(home, 'v2');
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

export async function loadHarness(name, policy = {}) {
  requireThat(typeof name === 'string' && NAME.test(name), 'Invalid profile name');
  const module = await import(pathToFileURL(join(v2Home, 'profiles', `${name}.mjs`)).href);
  requireThat(module.registry instanceof Map && typeof module.upstream === 'function', 'Profile must export registry and upstream');
  return createHarness({
    registry: module.registry, upstream: module.upstream, project: module.project, extract: module.extract,
    store: openStore(join(v2Home, 'stores', `${name}.sqlite`)), carry: createCarry({ directory: join(v2Home, 'carry', name) }),
    // Host defaults: hands-free learning for read-only workflows. A profile can override any of these.
    policy: { autoApprove: true, shadowTarget: 5, learnEvery: 5, retentionDays: 30, ...module.policy, ...policy },
  });
}
