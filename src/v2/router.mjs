// Router: retrieve candidate routes, extract typed inputs, gate, decide.
import { appearsIn, canonical, hashedEmbedding, requireThat, terms, tfidfIndex, vectorCosine } from './util.mjs';
import { validateInputs } from './plan.mjs';

// Words that change what is being asked. If one appears in a request but never in a route's examples,
// the route is not used.
export const MODIFIERS = new Set(['first', 'oldest', 'earliest', 'second', 'third', 'previou', 'prior', 'cancel', 'refund',
  'return', 'exchange', 'modify', 'change', 'update', 'unavailable', 'not', 'never', 'without', 'except', 'excluding',
  'exclude', 'each', 'every', 'all', 'compare', 'versu', 'vs', 'expensive', 'cheapest', 'most', 'least', 'average',
  'unpaid', 'refunded', 'delete', 'remove', 'add', 'book', 'send', 'email', 'zip', 'address', 'phone', 'departure',
  'arrival', 'cabin', 'membership', 'tracking', 'status']);

export function routeDocument(route) {
  return `${route.description}\n${route.examples.join('\n')}`;
}

function templateMatch(route, request) {
  // Turn each example into a pattern by replacing its input values with capture groups.
  for (const [index, example] of route.examples.entries()) {
    const values = route.episodeInputs?.[index];
    if (!values) continue;
    let pattern = example.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = [];
    for (const [name, value] of Object.entries(values).sort((a, b) => String(b[1]).length - String(a[1]).length)) {
      // The pattern is an escaped copy of the example, so look for the escaped form of the value.
      const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const finder = new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (!finder.test(pattern)) { pattern = null; break; }
      pattern = pattern.replace(finder, `(?<${name}>.+?)`);
      names.push(name);
    }
    if (!pattern) continue;
    const match = new RegExp(`^${pattern.replace(/\s+/g, '\\s+')}$`, 'i').exec(request.trim());
    if (match) {
      const inputs = {};
      for (const name of names) {
        const raw = match.groups[name].trim();
        const type = route.plan.inputs[name]?.type;
        inputs[name] = type === 'integer' ? Number(raw) : raw;
      }
      return inputs;
    }
  }
  return null;
}

// valueText: where request-sourced values may come from (the request, plus carried context on follow-ups).
// Modifier and discriminator checks always use the request alone.
export function gate(route, request, inputs, neighbours, { valueText = request, valuesOnly = false } = {}) {
  try {
    validateInputs(route.plan, inputs);
  } catch (error) {
    return error.message;
  }
  for (const [name, spec] of Object.entries(route.plan.inputs)) {
    if (spec.from !== 'converted' && !appearsIn(valueText, inputs[name])) return `value for ${name} is not in the request`;
  }
  if (valuesOnly) return null;
  // A learned filter value is part of the question ("delivered" orders): the request must say it.
  for (const expr of Object.values(route.plan.output)) {
    const wanted = expr.where?.equals;
    if (typeof wanted === 'string' && !terms(request).some(term => terms(wanted).includes(term))) {
      return `workflow counts only "${wanted}", which the request does not mention`;
    }
  }
  const vocab = new Set(route.vocab);
  const valueTerms = new Set(Object.values(inputs).flatMap(value => terms(String(value))));
  const requestTerms = terms(request).filter(term => !valueTerms.has(term));
  for (const term of requestTerms) {
    if (MODIFIERS.has(term) && !vocab.has(term)) return `request says "${term}", which this workflow never handled`;
  }
  // Discriminators: only against competitors, i.e. routes that matched this request almost as well. A term that
  // belongs to a competitor and never to this route means the request may be the competitor's task.
  const own = new Set(route.vocab);
  for (const other of neighbours) {
    if (other.id === route.id) continue;
    for (const term of requestTerms) {
      if (!own.has(term) && other.vocab.includes(term) && !MODIFIERS.has(term)) {
        return `request mentions "${term}", which belongs to competing workflow ${other.id}`;
      }
    }
  }
  return null;
}

const EXTRACT_PROMPT = 'You route a user request to a saved read-only workflow. Choose a workflow only if it answers exactly '
  + 'what the user asks: the same question and the same facts, with nothing extra or different (for example "first" versus '
  + '"latest", or a different field). Copy input values exactly as written in the request; write dates as YYYY-MM-DD. '
  + 'If no workflow fits exactly, or you are unsure, return null. If none fits exactly but the request is about the same record '
  + '(same customer, order, reservation …) as a workflow whose inputs you can fill from the request, also return it as related. '
  + 'Reply with JSON only: {"route": string|null, "inputs": object, "related": {"route": string, "inputs": object}|null}.';

// promptMode 'shortlist' (default) sends only the shortlisted workflows per call: fewest total tokens.
// 'catalog' puts the whole catalog in a fixed system prompt: more tokens per call, but cacheable by providers
// with prompt caching, so fewer uncached tokens.
export function createRouter({ extract, embed = hashedEmbedding, threshold = 0.12, embedThreshold = 0.45, promptMode = 'shortlist' } = {}) {
  const vectors = new Map();
  const vectorFor = async (key, text) => {
    if (!vectors.has(key)) vectors.set(key, await embed(text));
    return vectors.get(key);
  };
  return async function route(request, routes) {
    requireThat(typeof request === 'string', 'Request must be a string');
    const usable = routes.filter(item => item.state === 'live' || item.state === 'shadow');
    if (!usable.length || request.length > 1000) return { kind: 'miss', reason: 'no routes', usage: null };
    // Hybrid retrieval: TF-IDF for exact vocabulary, embeddings for wording it has not seen. Either can shortlist.
    const index = tfidfIndex(usable.map(item => ({ id: item.id, text: routeDocument(item) })));
    const queryVector = await embed(request);
    const scored = await Promise.all(index.query(request).map(async hit => {
      const route = usable.find(item => item.id === hit.id);
      const semantic = vectorCosine(queryVector, await vectorFor(`${route.id}:${route.version}:${route.examples.length}`, routeDocument(route)));
      return { id: hit.id, score: (hit.score + semantic) / 2, lexical: hit.score, semantic };
    }));
    const ranked = scored.filter(hit => hit.lexical >= threshold || hit.semantic >= embedThreshold)
      .sort((a, b) => b.score - a.score).slice(0, 3);
    if (!ranked.length) return { kind: 'miss', reason: 'no candidate above threshold', usage: null };
    const candidates = ranked.map(hit => usable.find(item => item.id === hit.id));

    // 1. Free path: the request matches the wording of a past example with new values.
    const templated = candidates.map(item => ({ item, inputs: templateMatch(item, request) })).filter(hit => hit.inputs);
    let chosen;
    let inputs;
    let usage = null;
    let method = 'template';
    if (templated.length === 1) ({ item: chosen, inputs } = templated[0]);

    // 2. Small model call: choose among candidates and fill typed inputs.
    if (!chosen && extract) {
      method = 'model';
      const reply = await extract({
        // The whole catalog sits in a system prompt that is identical for every request (so providers can cache
        // it); each call only adds the request and the shortlist.
        system: promptMode === 'catalog' ? catalogPrompt(usable) : EXTRACT_PROMPT,
        user: promptMode === 'catalog' ? canonical({ request, shortlist: candidates.map(item => item.id) })
          : canonical({ request, workflows: candidates.map(workflowCard) }),
      });
      usage = reply.usage;
      const pick = reply.value;
      if (!pick?.route) {
        const related = relatedFrom(pick?.related, candidates, request);
        return { kind: 'declined', reason: 'model found no exact fit', candidates: ranked, usage, method, related };
      }
      chosen = candidates.find(item => item.id === pick.route);
      if (!chosen) return { kind: 'declined', reason: 'model picked a route outside the shortlist', usage, method };
      inputs = pick.inputs ?? {};
    }
    if (!chosen) return { kind: 'declined', reason: 'no template match and no extractor', usage, method };

    const chosenScore = ranked.find(hit => hit.id === chosen.id)?.score ?? 0;
    const competitors = ranked.filter(hit => hit.id !== chosen.id && hit.score >= 0.75 * chosenScore)
      .map(hit => usable.find(item => item.id === hit.id));
    const problem = gate(chosen, request, inputs, competitors);
    if (problem) {
      const related = relatedFrom({ route: chosen.id, inputs }, candidates, request);
      return { kind: 'declined', reason: problem, route: chosen.id, usage, method, related };
    }
    return { kind: chosen.state === 'live' ? 'live' : 'shadow', route: chosen.id, inputs, usage, method };
  };
}

function relatedFrom(related, candidates, request) {
  const route = candidates.find(item => item.id === related?.route);
  if (!route || !related.inputs || typeof related.inputs !== 'object') return null;
  return gate(route, request, related.inputs, [], { valuesOnly: true }) ? null : { route: route.id, inputs: related.inputs };
}

const catalogCache = new Map();
function catalogPrompt(routes) {
  const key = routes.map(item => `${item.id}:${item.version}:${item.examples.length}`).sort().join('|');
  if (!catalogCache.has(key)) {
    const workflows = [...routes].sort((a, b) => (a.id < b.id ? -1 : 1)).map(workflowCard);
    catalogCache.clear();
    catalogCache.set(key, `${EXTRACT_PROMPT}\nOnly choose from the shortlist given with the request.\nWorkflows: ${canonical(workflows)}`);
  }
  return catalogCache.get(key);
}

function workflowCard(item) {
  return {
    id: item.id, description: item.description,
    inputs: Object.fromEntries(Object.entries(item.plan.inputs).map(([name, spec]) => [name, {
      type: spec.type, examples: (item.episodeInputs ?? []).slice(0, 3).map(values => values?.[name]).filter(v => v !== undefined),
      ...(spec.allowed ? { allowed: spec.allowed } : {}),
    }])),
    answers: Object.keys(item.plan.output),
    example_requests: item.examples.slice(0, 2),
  };
}
