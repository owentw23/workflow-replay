import { load, lookupWithExamples } from './playbook.mjs';
import { checkWorkflow, execute, requireThat } from './workflow.mjs';

export function parseRequest(pattern, request) {
  requireThat(pattern.source.startsWith('^') && pattern.source.endsWith('$')
    && !pattern.global && !pattern.sticky && !pattern.multiline, 'Route patterns must match the whole request');
  const match = pattern.exec(request);
  return match?.[0] === request ? match.groups : undefined;
}

export async function routeLocally({
  request, db, registry, dispatch, contracts, expand = value => value, search,
}) {
  if (typeof request !== 'string' || request.length > 256 || /[\r\n]/.test(request)) {
    return { kind: 'unsupported', candidates: [] };
  }
  const text = request.trim().normalize('NFC');
  const candidates = (search ? search(db, text) : lookupWithExamples(db, text, expand(text).slice(0, 256)))
    .map(candidate => candidate.route);
  const shortlisted = new Set(candidates);
  const matches = [];
  for (const route of candidates) {
    const inputs = contracts.get(route)?.(text);
    if (inputs) matches.push({ route, inputs });
  }
  if (matches.length !== 1) {
    return { kind: matches.length ? 'ambiguous' : candidates.length ? 'declined' : 'miss', candidates };
  }
  const { route, inputs } = matches[0];
  for (const [otherRoute, parse] of contracts) {
    if (!shortlisted.has(otherRoute) && parse(text)) return { kind: 'ambiguous', candidates };
  }
  let workflow;
  try {
    workflow = load(db, route);
    checkWorkflow(workflow, registry, inputs);
  } catch {
    return { kind: 'invalid-input', candidates };
  }
  try {
    return { kind: 'local', route, candidates, result: await execute(workflow, inputs, registry, dispatch) };
  } catch {
    return { kind: 'local-failed', route, candidates };
  }
}
