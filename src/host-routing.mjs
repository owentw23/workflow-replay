import { load, lookup } from './playbook.mjs';
import { execute } from './workflow.mjs';
import { routeLocally } from './local-routing.mjs';

export async function routeRequest({ request, searchText = request, db, registry, dispatch, match, choose, local }) {
  if (local) return routeLocally({ ...local, request, db, registry, dispatch });
  // A trusted command grammar can bind parameters without inference.
  const exact = match?.(request);
  if (exact) {
    try {
      return { kind: 'local', route: exact.route,
        result: await execute(load(db, exact.route), exact.inputs, registry, dispatch) };
    } catch {
      return { kind: 'local-failed' };
    }
  }

  const candidates = lookup(db, searchText.slice(0, 256));
  if (!candidates.length) return { kind: 'miss' };
  const selected = await choose(request, candidates);
  if (!candidates.some(candidate => candidate.route === selected?.route)) return { kind: 'declined' };
  try {
    return { kind: 'assisted', route: selected.route,
      result: await execute(load(db, selected.route), selected.inputs, registry, dispatch) };
  } catch {
    return { kind: 'assisted-failed' };
  }
}
