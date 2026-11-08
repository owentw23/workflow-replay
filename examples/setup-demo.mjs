import { copyFileSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataHome, loadProfile } from '../src/profiles.mjs';
import { indexRouteExamples, openPlaybook, publish } from '../src/playbook.mjs';
import { capture } from '../src/workflow.mjs';

const folder = join(dataHome, 'profiles');
mkdirSync(folder, { recursive: true, mode: 0o700 });
try {
  copyFileSync(new URL('./demo-profile.mjs', import.meta.url), join(folder, 'replay-demo.mjs'), constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const profile = await loadProfile('replay-demo');
const spec = {
  version: 1, inputs: { item: 'string' },
  steps: [{ id: 'stock', op: 'inventory.v1', args: { item: { input: 'item' } } }],
  output: { available: { step: 'stock', field: 'available' } },
};
const { workflow } = await capture(spec, { item: 'notebooks' }, profile.registry, profile.dispatch);
const db = openPlaybook(profile.database);
try {
  publish(db, 'demo-inventory', 'Check the synthetic demo inventory', workflow);
  indexRouteExamples(db, 'demo-inventory', ['How many items are in the demo inventory?']);
  console.log('Seeded replay-demo. Try: How many pencils are in the demo inventory?');
} finally {
  db.close();
}
