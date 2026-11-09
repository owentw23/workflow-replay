// Miner: turns recorded agent episodes into candidate plans.
// 1. label where every argument value came from, 2. cluster by call shape, 3. keep only provenance that is
// consistent across the cluster, 4. infer inputs (values that vary with the request) vs constants,
// 5. derive each answer field from a result path or a declarative reducer.
import { appearsIn, canonical, digest, requireThat, round2, sameAnswer, terms } from './util.mjs';
import { evaluate, executePlan, validatePlan } from './plan.mjs';

const MAX_DEPTH = 6;
const DYN = '⟨k⟩';

function cleanCalls(calls) {
  const seen = new Set();
  return calls.filter(call => {
    if (!call.ok) return false;
    const key = canonical([call.op, call.args]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function equalValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return round2(a) === round2(b);
  return a === b;
}

// All paths in root whose value equals target. Each array index yields both its positive and negative form;
// keys of map-like objects that appear in the request yield a dynamic-key variant.
function findPaths(root, target, request) {
  const found = [];
  const walk = (node, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    if (equalValue(node, target)) found.push(prefix);
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, [...prefix, index], depth + 1);
        walk(item, [...prefix, index - node.length], depth + 1);
      });
    } else if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      // Map-like objects (keys are data such as product names, not field names) allow dynamic-key lookups.
      const mapLike = keys.length >= 5 && keys.filter(key => !/^[a-z_][a-z0-9_]*$/.test(key)).length >= keys.length / 2;
      for (const key of keys) {
        walk(node[key], [...prefix, key], depth + 1);
        if (mapLike && key.length >= 3 && appearsIn(request, key)) {
          walk(node[key], [...prefix, { [DYN]: key }], depth + 1);
        }
      }
    }
  };
  walk(root, [], 0);
  return found;
}

function arraysIn(root) {
  const arrays = [];
  const walk = (node, prefix, depth) => {
    if (depth > 4 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      arrays.push({ path: prefix, list: node });
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...prefix, key], depth + 1);
  };
  walk(root, [], 0);
  return arrays;
}

const pathKey = path => path.map(segment => (segment && typeof segment === 'object' ? DYN : segment));
const dynValues = path => path.filter(segment => segment && typeof segment === 'object').map(segment => segment[DYN]);

function outputCandidates(value, results, request) {
  const out = new Map();
  // Null and zero answers carry no evidence about where a value came from (a zero count matches any absent
  // filter value). They constrain nothing here; replay verification still checks them.
  if (value === null || value === undefined || value === 0) return '*';
  const add = (candidate, detail = {}) => out.set(canonical(candidate), detail);
  results.forEach((result, s) => {
    for (const path of findPaths(result, value, request)) add({ k: 'eq', s, p: pathKey(path) }, { dyn: dynValues(path) });
    if (typeof value !== 'number') return;
    for (const { path, list } of arraysIn(result)) {
      if (list.length === value) add({ k: 'len', s, p: path });
      const objects = list.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      if (!objects.length || objects.length !== list.length) continue;
      const fields = Object.keys(objects[0]);
      const bools = fields.filter(field => objects.every(item => typeof item[field] === 'boolean'));
      const nums = fields.filter(field => objects.every(item => typeof item[field] === 'number'));
      for (const field of bools) {
        for (const equals of [true, false]) {
          if (objects.filter(item => item[field] === equals).length === value) {
            add({ k: 'count', s, p: path, wf: [field], we: equals });
          }
        }
      }
      // Low-cardinality text fields (status and the like) can filter a count: "how many orders were delivered".
      const texts = fields.filter(field => objects.every(item => typeof item[field] === 'string'));
      for (const field of texts) {
        const distinct = [...new Set(objects.map(item => item[field]))];
        if (distinct.length > 6) continue;
        for (const equals of distinct) {
          if (objects.filter(item => item[field] === equals).length === value) add({ k: 'count', s, p: path, wf: [field], we: equals });
        }
      }
      for (const field of nums) {
        const filters = [null, ...bools.flatMap(b => [[b, true], [b, false]])];
        for (const filter of filters) {
          const kept = filter ? objects.filter(item => item[filter[0]] === filter[1]) : objects;
          const values = kept.map(item => item[field]);
          if (!values.length) continue;
          const where = filter ? { wf: [filter[0]], we: filter[1] } : {};
          if (round2(values.reduce((a, b) => a + b, 0)) === round2(value)) add({ k: 'sum', s, p: path, f: [field], ...where });
          if (round2(Math.min(...values)) === round2(value)) add({ k: 'min', s, p: path, f: [field], ...where });
          if (round2(Math.max(...values)) === round2(value)) add({ k: 'max', s, p: path, f: [field], ...where });
        }
      }
    }
  });
  return out;
}

// Repeated calls to one operation become a single loop step:
//  - pagination: an integer argument counts up (1, 2, 3 …) and each page holds a list at the same path;
//  - forEach: one argument walks the elements (or one field of the elements) of a list from an earlier result.
function sameArgsExcept(run, name) {
  return run.every(call => Object.keys(call.args).every(key => key === name
    || canonical(call.args[key]) === canonical(run[0].args[key])));
}

function detectPagination(run) {
  for (const name of Object.keys(run[0].args)) {
    const pages = run.map(call => call.args[name]);
    if (!pages.every((page, i) => Number.isSafeInteger(page) && page === pages[0] + i) || !sameArgsExcept(run, name)) continue;
    const lists = arraysIn(run[0].result).map(entry => entry.path)
      .filter(path => run.every(call => Array.isArray(pathValue(call.result, path))));
    if (!lists.length) continue;
    const collect = lists.find(path => !pathValue(run.at(-1).result, path).length) ?? lists[0];
    const items = run.flatMap(call => pathValue(call.result, collect));
    const others = Object.fromEntries(Object.entries(run[0].args).filter(([key]) => key !== name));
    return { op: run[0].op, args: others, ok: true, result: { items, pages: run.length },
      page: { arg: name, start: pages[0], collect } };
  }
  return null;
}

function detectLoop(run, previous) {
  for (const name of Object.keys(run[0].args)) {
    const values = run.map(call => call.args[name]);
    if (new Set(values.map(v => canonical(v))).size !== values.length || !sameArgsExcept(run, name)) continue;
    for (let s = previous.length - 1; s >= 0; s--) {
      for (const { path, list } of arraysIn(previous[s].result)) {
        if (list.length !== values.length) continue;
        const fields = [[], ...(list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).map(key => [key]) : [])];
        for (const field of fields) {
          const mapped = list.map(item => pathValue(item, field));
          const wanted = new Set(values.map(v => canonical(v)));
          if (!mapped.every(v => wanted.has(canonical(v)))) continue;
          // Results in list order, so positional answers line up with the list.
          const ordered = mapped.map(v => run[values.findIndex(value => canonical(value) === canonical(v))].result);
          const others = Object.fromEntries(Object.entries(run[0].args).filter(([key]) => key !== name));
          return { op: run[0].op, args: others, ok: true, result: ordered, loop: { arg: name, s, p: path, ip: field } };
        }
      }
    }
  }
  return null;
}

function pathValue(node, path) {
  for (const segment of path) {
    if (node === null || node === undefined) return null;
    node = node[segment];
  }
  return node ?? null;
}

function collapseRepeats(calls) {
  const out = [];
  for (let i = 0; i < calls.length;) {
    let j = i + 1;
    while (j < calls.length && calls[j].op === calls[i].op) j++;
    const collapsed = j - i >= 2 ? detectPagination(calls.slice(i, j)) ?? detectLoop(calls.slice(i, j), out) : null;
    if (collapsed) {
      out.push(collapsed);
      i = j;
    } else {
      out.push(calls[i]);
      i++;
    }
  }
  return out;
}

const loopTag = call => (call.loop ? `${call.op}[each ${call.loop.arg} of s${call.loop.s + 1}.${call.loop.p.join('.')}.${call.loop.ip.join('.')}]`
  : call.page ? `${call.op}[pages ${call.page.arg} collect ${call.page.collect.join('.')}]` : call.op);

// Per-episode analysis: provenance candidates for every argument and answer field.
export function analyzeEpisode(episode) {
  const calls = collapseRepeats(cleanCalls(episode.calls));
  const results = calls.map(call => call.result);
  const args = calls.map((call, index) => Object.fromEntries(Object.entries(call.args).map(([name, value]) => {
    const options = new Map();
    for (let s = 0; s < index; s++) {
      for (const path of findPaths(results[s], value, episode.request)) {
        options.set(canonical({ k: 'step', s, p: pathKey(path) }), { dyn: dynValues(path) });
      }
    }
    if (appearsIn(episode.request, value)) options.set(canonical({ k: 'req', name }), { value });
    options.set(canonical({ k: 'const', v: value }), {});
    return [name, options];
  })));
  const prose = typeof episode.answer === 'string' ? episode.answer
    : typeof episode.answer?.text === 'string' && Object.keys(episode.answer).length === 1 ? episode.answer.text : null;
  const answer = !prose && episode.answer && typeof episode.answer === 'object' && !Array.isArray(episode.answer) ? episode.answer : null;
  let outputs = null;
  if (answer) {
    outputs = Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, outputCandidates(value, results, episode.request)]));
  } else if (prose) {
    // Prose answers (e.g. a Claude Code reply): the facts are result values that appear in the answer text.
    outputs = { [PROSE]: proseFacts(prose, results, episode.request) };
  }
  const shape = canonical({ ops: calls.map(loopTag), out: answer ? Object.keys(answer).sort() : prose ? 'prose' : null });
  return { episode, calls, args, outputs, shape };
}

const PROSE = '⟨prose⟩';

function proseFacts(text, results, request) {
  const facts = new Map();
  const lower = text.toLowerCase();
  const visit = (node, path, s, depth) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, [...path, index], s, depth + 1);
        visit(item, [...path, index - node.length], s, depth + 1);
      });
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) visit(value, [...path, key], s, depth + 1);
    } else if ((typeof node === 'string' && node.length >= 3 && lower.includes(node.toLowerCase()) && !appearsIn(request, node))
      || (typeof node === 'number' && appearsIn(text, node) && !appearsIn(request, node))) {
      facts.set(canonical({ k: 'eq', s, p: path }), {});
    }
  };
  results.forEach((result, s) => visit(result, [], s, 0));
  // Numbers in the reply that are not stored anywhere may be computed: try the declarative reducers.
  for (const token of new Set(text.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) ?? [])) {
    const value = Number(token);
    if (appearsIn(request, value)) continue;
    const candidates = outputCandidates(value, results, request);
    if (candidates === '*') continue;
    for (const key of candidates.keys()) if (JSON.parse(key).k !== 'eq') facts.set(key, {});
  }
  return facts;
}

const exprFor = c => {
  const of = { step: `s${c.s + 1}`, path: c.p };
  return c.k === 'eq' ? of
    : { reduce: c.k, of, ...(c.f ? { field: c.f } : {}), ...(c.wf ? { where: { field: c.wf, equals: c.we } } : {}) };
};

function candidateValue(item, c) {
  if (c.k === 'eq') return getValue(item, c);
  const results = new Map(item.calls.map((call, i) => [`s${i + 1}`, call.result]));
  return evaluate(exprFor(c), {}, results);
}

function proseOutputs(cluster) {
  const keys = intersect(cluster.map(item => item.outputs[PROSE])) ?? [];
  // Keep one derivation per distinct value position: prefer positive indexes and later steps.
  const chosen = new Map();
  for (const key of [...keys].sort((a, b) => (rank(a).join() < rank(b).join() ? -1 : 1))) {
    const c = JSON.parse(key);
    const base = c.k === 'eq' ? [...c.p].reverse().find(segment => typeof segment === 'string') ?? `value_${c.s + 1}`
      : [c.k, ...(c.wf ?? []), c.we === undefined ? null : String(c.we), ...(c.f ?? [])].filter(v => v !== null && v !== '').join('_');
    const label = String(base).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'v_').slice(0, 40);
    const values = canonical(cluster.map(item => candidateValue(item, c)));
    if ([...chosen.values()].some(entry => entry.values === values)) continue;
    let name = label;
    for (let n = 2; chosen.has(name); n++) name = `${label}_${n}`;
    chosen.set(name, { c, values });
  }
  return chosen;
}

// Response template for direct answers: the first episode's reply with each fact replaced by {field}.
function proseTemplate(item, facts) {
  let text = typeof item.episode.answer === 'string' ? item.episode.answer : item.episode.answer?.text;
  if (typeof text !== 'string') return null;
  const entries = [...facts].map(([name, { c }]) => [name, candidateValue(item, c)])
    .filter(([, value]) => value !== null && value !== undefined)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [name, value] of entries) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(typeof value === 'number' ? `(?<![\\d.])${escaped}(?![\\d])` : escaped, 'i');
    if (!pattern.test(text)) return null;
    text = text.replace(pattern, `{${name}}`);
  }
  return text.length <= 2000 ? text : null;
}

export function renderTemplate(template, output) {
  if (!template) return null;
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (match, name) => (Object.hasOwn(output, name) ? String(output[name] ?? 'not available') : match));
}

function getValue(item, c) {
  let node = item.calls[c.s].result;
  for (const segment of c.p) {
    if (node === null || node === undefined) return null;
    node = typeof segment === 'number' && Array.isArray(node) ? node[segment < 0 ? node.length + segment : segment] : node[segment];
  }
  return node ?? null;
}

function intersect(maps) {
  const concrete = maps.filter(map => map !== '*');
  if (!concrete.length) return null;
  const [first, ...rest] = concrete;
  return [...first.keys()].filter(key => rest.every(map => map.has(key)));
}

const rank = key => {
  const c = JSON.parse(key);
  const kind = { step: 0, eq: 0, req: 1, len: 2, count: 3, sum: 4, min: 4, max: 4, const: 5 }[c.k];
  // Prefer later steps, then shorter paths, then positive indexes.
  const negatives = (c.p ?? []).filter(segment => typeof segment === 'number' && segment < 0).length;
  return [kind, -(c.s ?? 0), (c.p ?? []).length, negatives, key.length];
};
const best = keys => [...keys].sort((a, b) => {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a < b ? -1 : 1;
})[0];

function inferType(values) {
  if (values.every(value => Number.isSafeInteger(value))) return 'integer';
  if (values.every(value => typeof value === 'number')) return 'number';
  if (values.every(value => typeof value === 'boolean')) return 'boolean';
  if (values.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) return 'date';
  return 'string';
}

const dynName = owner => owner.replace(/_id$/, '') + '_name';

function attentionRules(plan, answers) {
  const rules = [];
  for (const field of Object.keys(plan.output)) {
    const values = answers.map(answer => answer?.[field]);
    if (values.every(value => value !== null && value !== undefined)) rules.push({ field, kind: 'null' });
    const strings = values.filter(value => typeof value === 'string');
    const distinct = [...new Set(strings.map(value => value.toLowerCase()))];
    if (strings.length >= 4 && strings.length === values.length && distinct.length <= 3) {
      rules.push({ field, kind: 'enum', values: distinct });
    }
    if (values.every(value => typeof value === 'number' && value !== 0)) rules.push({ field, kind: 'zero' });
  }
  return rules;
}

// Build a plan from a cluster of analysed episodes. Returns {plan, inputsFor} or {error}.
export function synthesize(cluster, { minSupport = 3 } = {}) {
  if (cluster.length < minSupport) return { error: `needs ${minSupport} successful episodes, has ${cluster.length}` };
  if (!cluster[0].outputs) return { error: 'episodes have no structured answer' };
  const steps = [];
  const inputs = {};
  const perEpisodeInputs = cluster.map(() => ({}));
  const ops = cluster[0].calls.map(call => call.op);

  for (let index = 0; index < ops.length; index++) {
    const args = {};
    for (const name of Object.keys(cluster[0].calls[index].args)) {
      const options = intersect(cluster.map(item => item.args[index][name]));
      if (!options?.length) return { error: `no consistent source for ${ops[index]}.${name}` };
      let choice = best(options);
      let parsed = JSON.parse(choice);
      const values = cluster.map(item => item.calls[index].args[name]);
      // Coincidence rule: a request value that never varied is kept as a constant (fixed by consolidation later).
      if (parsed.k === 'req' && new Set(values.map(v => canonical(v))).size < 2) {
        const constant = options.find(key => JSON.parse(key).k === 'const');
        if (constant) [choice, parsed] = [constant, JSON.parse(constant)];
      }
      if (parsed.k === 'step') {
        const path = parsed.p.map(segment => {
          if (segment !== DYN) return segment;
          const input = dynName(name);
          inputs[input] = { type: 'string', from: 'request' };
          cluster.forEach((item, e) => { perEpisodeInputs[e][input] = item.args[index][name].get(choice).dyn[0]; });
          return { input };
        });
        args[name] = { step: `s${parsed.s + 1}`, path };
      } else if (parsed.k === 'req') {
        // Every member saw this value in its request (directly or via a converter such as dates).
        inputs[name] = { type: inferType(values), from: 'request' };
        cluster.forEach((item, e) => { perEpisodeInputs[e][name] = item.calls[index].args[name]; });
        args[name] = { input: name };
      } else {
        args[name] = { const: parsed.v };
      }
    }
    const step = { id: `s${index + 1}`, op: ops[index], args };
    const first = cluster[0].calls[index];
    if (first.loop) {
      step.forEach = { step: `s${first.loop.s + 1}`, path: first.loop.p };
      step.args[first.loop.arg] = { item: first.loop.ip };
    }
    if (first.page) step.paginate = { arg: first.page.arg, start: first.page.start, max: 20, collect: first.page.collect };
    steps.push(step);
  }

  const output = {};
  if (cluster[0].outputs[PROSE]) {
    const facts = proseOutputs(cluster);
    if (!facts.size) return { error: 'no result value appears consistently in the answers' };
    for (const [name, { c }] of [...facts].slice(0, 16)) output[name] = exprFor(c);
    return { plan: { version: 2, inputs, steps, output }, inputsFor: perEpisodeInputs, template: proseTemplate(cluster[0], facts) };
  }
  for (const key of Object.keys(cluster[0].outputs)) {
    const options = intersect(cluster.map(item => item.outputs[key]));
    if (!options?.length) return { error: `no consistent derivation for answer field ${key}` };
    // Among equally consistent filters, prefer the filter value every request actually mentions ("delivered").
    const mentioned = options.filter(option => {
      const parsed = JSON.parse(option);
      return typeof parsed.we === 'string' && cluster.every(item => item.episode.request.toLowerCase().includes(parsed.we.toLowerCase()));
    });
    const choice = best(mentioned.length ? mentioned : options);
    const c = JSON.parse(choice);
    const path = (c.p ?? []).map(segment => {
      if (segment !== DYN) return segment;
      const input = dynName(key);
      inputs[input] = { type: 'string', from: 'request' };
      cluster.forEach((item, e) => {
        const detail = item.outputs[key] === '*' ? null : item.outputs[key].get(choice);
        if (detail) perEpisodeInputs[e][input] = detail.dyn[0];
      });
      return { input };
    });
    const of = { step: `s${c.s + 1}`, path };
    output[key] = c.k === 'eq' ? of
      : { reduce: c.k, of, ...(c.f ? { field: c.f } : {}), ...(c.wf ? { where: { field: c.wf, equals: c.we } } : {}) };
  }

  const plan = { version: 2, inputs, steps, output };
  return { plan, inputsFor: perEpisodeInputs };
}

// Description from the words the examples share, never from their input values (names, ids, emails).
export function describe(examples, inputValues = []) {
  const valueTerms = new Set(inputValues.filter(Boolean).flatMap(values => Object.values(values).flatMap(value => terms(String(value)))));
  const counts = new Map();
  for (const text of examples) for (const term of new Set(terms(text))) counts.set(term, (counts.get(term) ?? 0) + 1);
  const common = [...counts].filter(([term]) => !/\d/.test(term) && !term.includes('@') && !valueTerms.has(term))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([term]) => term);
  return common.join(' ');
}

export function vocabulary(examples, inputValues) {
  const valueTerms = new Set(inputValues.flatMap(values => Object.values(values).flatMap(value => terms(String(value)))));
  return [...new Set(examples.flatMap(text => terms(text)))].filter(term => !valueTerms.has(term)).sort();
}

// Mine all recorded episodes. Returns candidate routes plus a log of clusters that could not be compiled.
export function mine(episodes, { registry, minSupport = 3, holdOut = 0.34 } = {}) {
  const analysed = episodes.filter(episode => episode.success).map(analyzeEpisode).filter(item => item.calls.length);
  const clusters = new Map();
  for (const item of analysed) {
    if (!clusters.has(item.shape)) clusters.set(item.shape, []);
    clusters.get(item.shape).push(item);
  }
  const candidates = [];
  const rejected = [];
  for (const [shape, members] of clusters) {
    // Hold out the newest members for verification; mine from the rest.
    const holdCount = members.length >= minSupport + 1 ? Math.max(1, Math.floor(members.length * holdOut)) : 0;
    const train = members.slice(0, members.length - holdCount);
    const held = members.slice(members.length - holdCount);
    const built = synthesize(train, { minSupport });
    if (built.error) {
      rejected.push({ shape, size: members.length, reason: built.error });
      continue;
    }
    try {
      validatePlan(built.plan, registry);
    } catch (error) {
      rejected.push({ shape, size: members.length, reason: error.message });
      continue;
    }
    const examples = members.map(item => item.episode.request);
    candidates.push({
      shape, plan: built.plan, examples,
      trainEpisodes: train.map(item => item.episode), heldEpisodes: held.map(item => item.episode),
      trainInputs: built.inputsFor,
      attention: attentionRules(built.plan, train.map(item => item.episode.answer)),
      description: describe(examples, built.inputsFor), template: built.template ?? null,
      vocab: vocabulary(examples, built.inputsFor),
    });
  }
  return { candidates, rejected, analysed };
}

// Recover the inputs an existing plan would need for an episode, by re-running the provenance match.
export function inputsForEpisode(plan, episode) {
  const item = analyzeEpisode(episode);
  if (item.calls.length !== plan.steps.length || item.calls.some((call, i) => call.op !== plan.steps[i].op)) return null;
  const inputs = {};
  for (const [index, step] of plan.steps.entries()) {
    for (const [name, ref] of Object.entries(step.args)) {
      const value = item.calls[index].args[name];
      if (ref.input) inputs[ref.input] = value;
      if (ref.step) {
        for (const segment of ref.path) {
          if (segment && typeof segment === 'object' && !Object.hasOwn(inputs, segment.input)) {
            const option = [...item.args[index][name]].find(([key]) => JSON.parse(key).k === 'step'
              && JSON.parse(key).p.includes(DYN));
            if (option) inputs[segment.input] = option[1].dyn[0];
          }
        }
      }
    }
  }
  for (const expr of Object.values(plan.output)) {
    for (const segment of (expr.reduce ? expr.of.path : expr.path) ?? []) {
      if (segment && typeof segment === 'object' && !Object.hasOwn(inputs, segment.input)) return null;
    }
  }
  return Object.keys(plan.inputs).every(name => Object.hasOwn(inputs, name)) ? inputs : null;
}

// JSON answers must match exactly; prose answers must contain every fact the plan returns.
export function answersMatch(output, answer) {
  const text = typeof answer === 'string' ? answer : typeof answer?.text === 'string' && Object.keys(answer).length === 1 ? answer.text : null;
  if (text === null) return sameAnswer(output, answer);
  const values = Object.values(output ?? {}).filter(value => value !== null && value !== undefined);
  return values.length > 0 && values.every(value => appearsIn(text, value));
}

// Replays a plan for episodes and compares with their recorded answers.
export async function replayCheck(plan, episodes, registry, call) {
  const outcomes = [];
  for (const episode of episodes) {
    const inputs = inputsForEpisode(plan, episode);
    if (!inputs) {
      outcomes.push({ episode: episode.id, ok: false, reason: 'inputs not recoverable' });
      continue;
    }
    try {
      // Writes never run during verification: the proposed call must equal the recorded one, and every answer
      // field that does not depend on the write must match.
      const { output, proposal } = await executePlan(plan, inputs, registry, (op, args) => call(op, args, episode));
      if (proposal) {
        const recorded = cleanCalls(episode.calls).at(-1);
        const writeStep = proposal.stepId;
        const readOnly = Object.fromEntries(Object.entries(plan.output).filter(([, expr]) => (expr.reduce ? expr.of.step : expr.step) !== writeStep)
          .map(([name]) => [name, output[name]]));
        const expected = Object.fromEntries(Object.keys(readOnly).map(name => [name, episode.answer?.[name]]));
        const ok = recorded?.op === proposal.op && canonical(recorded.args) === canonical(proposal.args)
          && (!Object.keys(readOnly).length || sameAnswer(readOnly, expected));
        outcomes.push({ episode: episode.id, ok, output, proposal });
        continue;
      }
      outcomes.push({ episode: episode.id, ok: answersMatch(output, episode.answer), output });
    } catch (error) {
      outcomes.push({ episode: episode.id, ok: false, reason: error.message });
    }
  }
  return outcomes;
}

export const routeId = (plan, description) => {
  const slug = description.split(' ').slice(0, 3).join('-').replace(/[^a-z0-9-]/g, '') || 'workflow';
  return `wf-${slug}-${digest(plan).slice(0, 6)}`;
};

export function requireRegistry(registry) {
  requireThat(registry instanceof Map, 'Registry must be a Map');
}
