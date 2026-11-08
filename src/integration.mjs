import { DatabaseSync } from 'node:sqlite';
import { routeRequest } from './host-routing.mjs';
import { json } from './workflow.mjs';

export async function replayConfigured(profile, request) {
  if (!profile.contracts.size || typeof request !== 'string' || request.length > 256) return;
  const db = new DatabaseSync(profile.database, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 750');
    const outcome = await routeRequest({
      request, db, registry: profile.registry, dispatch: profile.dispatch,
      local: { contracts: profile.contracts, expand: profile.expand },
    });
    if (outcome.kind === 'local') return { route: outcome.route, result: outcome.result };
  } finally {
    db.close();
  }
}

export function compactReceipt(receipt) {
  if (!receipt) return;
  const data = json(receipt).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return Buffer.byteLength(data) <= 4096 ? data : undefined;
}
