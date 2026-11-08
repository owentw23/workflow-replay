// Plan format v2: a typed DAG of registered operations with path references and declarative reducers.
// No arbitrary code: loops, filters and totals are interpreted operators.
import { canonical, digest, requireThat, round2 } from './util.mjs';

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'date']);
const REDUCERS = new Set(['len', 'count', 'sum', 'min', 'max']);

// Path segments: object key (string), array index (integer, negative counts from the end),
// or {input: name}, a key looked up case-insensitively from an input value.
export function getPath(root, path, inputs = {}) {
  let node = root;
  for (const segment of path) {
    if (node === null || node === undefined) return null;
    if (typeof segment === 'number') {
      if (!Array.isArray(node)) return null;
      node = node[segment < 0 ? node.length + segment : segment];
    } else if (segment && typeof segment === 'object') {
      if (typeof node !== 'object' || Array.isArray(node)) return null;
      const wanted = String(inputs[segment.input] ?? '').toLowerCase();
      const key = Object.keys(node).find(candidate => candidate.toLowerCase() === wanted);
      node = key === undefined ? null : node[key];
    } else {
      if (typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, segment)) return null;
      node = node[segment];
    }
  }
  return node === undefined ? null : node;
}

function checkPath(path, inputs) {
  requireThat(Array.isArray(path) && path.length <= 8, 'Invalid path');
  for (const segment of path) {
    if (typeof segment === 'number') requireThat(Number.isInteger(segment), 'Invalid path index');
    else if (segment && typeof segment === 'object') requireThat(Object.hasOwn(inputs, segment.input), 'Unknown path input');
    else requireThat(typeof segment === 'string' && segment.length <= 64, 'Invalid path key');
  }
}

function checkRef(ref, inputs, steps, { allowItem = false } = {}) {
  requireThat(ref && typeof ref === 'object', 'Invalid reference');
  if (Object.hasOwn(ref, 'input')) return requireThat(Object.hasOwn(inputs, ref.input), `Unknown input ${ref.input}`);
  if (Object.hasOwn(ref, 'const')) return requireThat(['string', 'number', 'boolean'].includes(typeof ref.const), 'Invalid constant');
  if (Object.hasOwn(ref, 'item')) {
    requireThat(allowItem, 'Item references are only valid inside forEach steps');
    return checkPath(ref.item, inputs);
  }
  requireThat(steps.has(ref.step), `Unknown step ${ref.step}`);
  checkPath(ref.path, inputs);
}

export const isWrite = (registry, op) => registry.get(op)?.effect === 'write';

// Supplied argument names must all be registered, and every non-optional argument must be present.
export function argumentsFit(tool, supplied) {
  const optional = new Set(tool.optional ?? []);
  return supplied.every(name => Object.hasOwn(tool.args, name))
    && Object.keys(tool.args).every(name => optional.has(name) || supplied.includes(name));
}

// Step kinds: a plain call; `forEach: ref` (one call per list element, args may use {item: path});
// `paginate: {arg, start, max, collect, stop}` (call with page = start, start+1, … until a page's collected list
// is empty or `stop` says so). A write operation may only be the final step and never runs without approval.
export function validatePlan(plan, registry) {
  requireThat(plan?.version === 2 && plan.inputs && Array.isArray(plan.steps) && plan.output, 'Invalid plan');
  for (const [name, spec] of Object.entries(plan.inputs)) {
    requireThat(NAME.test(name) && TYPES.has(spec.type), `Invalid input ${name}`);
    if (spec.allowed) requireThat(Array.isArray(spec.allowed) && spec.allowed.length <= 64, 'Invalid allowed list');
  }
  requireThat(plan.steps.length >= 1 && plan.steps.length <= 16, 'Expected 1–16 steps');
  const seen = new Set();
  for (const [index, step] of plan.steps.entries()) {
    requireThat(NAME.test(step.id) && !seen.has(step.id), 'Invalid or duplicate step id');
    const tool = registry.get(step.op);
    requireThat(tool, `Unregistered operation ${step.op}`);
    if (tool.effect === 'write') {
      requireThat(index === plan.steps.length - 1 && !step.forEach && !step.paginate, 'A write may only be the final, single step');
    }
    const supplied = step.paginate ? [...Object.keys(step.args), step.paginate.arg] : Object.keys(step.args);
    requireThat(argumentsFit(tool, supplied), `Arguments do not match ${step.op}`);
    if (step.forEach) checkRef(step.forEach, plan.inputs, seen);
    if (step.paginate) {
      const { arg, start = 1, max = 20, collect } = step.paginate;
      requireThat(tool.args[arg] === 'integer' && Number.isSafeInteger(start) && Number.isSafeInteger(max) && max >= 1 && max <= 50,
        'Invalid pagination');
      checkPath(collect, plan.inputs);
    }
    for (const ref of Object.values(step.args)) checkRef(ref, plan.inputs, seen, { allowItem: !!step.forEach });
    seen.add(step.id);
  }
  const fields = Object.entries(plan.output);
  requireThat(fields.length >= 1 && fields.length <= 16, 'Expected 1–16 output fields');
  for (const [name, expr] of fields) {
    requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(name), 'Invalid output field');
    if (expr.reduce) {
      requireThat(REDUCERS.has(expr.reduce), 'Unknown reducer');
      checkRef(expr.of, plan.inputs, seen);
      if (expr.field) checkPath(expr.field, plan.inputs);
      if (expr.where) checkPath(expr.where.field, plan.inputs);
    } else checkRef(expr, plan.inputs, seen);
  }
  return true;
}

export function validateInputs(plan, inputs) {
  requireThat(inputs && typeof inputs === 'object', 'Inputs required');
  for (const [name, spec] of Object.entries(plan.inputs)) {
    const value = inputs[name];
    requireThat(value !== undefined && value !== null && value !== '', `Missing input ${name}`);
    const ok = spec.type === 'integer' ? Number.isSafeInteger(value)
      : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : spec.type === 'boolean' ? typeof value === 'boolean'
          : spec.type === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
            : typeof value === 'string' && value.length <= 256;
    requireThat(ok, `Invalid ${spec.type} for ${name}`);
    if (spec.allowed) {
      requireThat(spec.allowed.some(item => String(item).toLowerCase() === String(value).toLowerCase()),
        `Value for ${name} is outside the verified list`);
    }
  }
  requireThat(Object.keys(inputs).every(name => Object.hasOwn(plan.inputs, name)), 'Unknown input supplied');
}

function resolve(ref, inputs, results, item) {
  if (Object.hasOwn(ref, 'input')) return inputs[ref.input];
  if (Object.hasOwn(ref, 'const')) return ref.const;
  if (Object.hasOwn(ref, 'item')) return getPath(item, ref.item, inputs);
  return getPath(results.get(ref.step), ref.path, inputs);
}

export function evaluate(expr, inputs, results) {
  if (!expr.reduce) return resolve(expr, inputs, results);
  const list = resolve(expr.of, inputs, results);
  if (!Array.isArray(list)) return null;
  if (expr.reduce === 'len') return list.length;
  const kept = expr.where ? list.filter(item => getPath(item, expr.where.field, inputs) === expr.where.equals) : list;
  if (expr.reduce === 'count') return kept.length;
  const values = kept.map(item => getPath(item, expr.field ?? [], inputs)).filter(value => typeof value === 'number');
  if (!values.length) return null;
  if (expr.reduce === 'sum') return round2(values.reduce((a, b) => a + b, 0));
  return expr.reduce === 'min' ? Math.min(...values) : Math.max(...values);
}

const dependsOn = step => [...Object.values(step.args), ...(step.forEach ? [step.forEach] : [])]
  .filter(ref => ref.step).map(ref => ref.step);
const MAX_LOOP = 50;

function bindArgs(step, inputs, results, item) {
  const args = Object.fromEntries(Object.entries(step.args).map(([name, ref]) => [name, resolve(ref, inputs, results, item)]));
  requireThat(Object.values(args).every(value => value !== null && value !== undefined),
    `A required argument for ${step.op} resolved to nothing`);
  return args;
}

async function runStep(step, inputs, results, call, calls) {
  if (step.forEach) {
    const list = resolve(step.forEach, inputs, results);
    requireThat(Array.isArray(list) && list.length <= MAX_LOOP, `forEach over ${step.op} needs a list of at most ${MAX_LOOP}`);
    const out = [];
    for (let start = 0; start < list.length; start += 4) {
      const batch = list.slice(start, start + 4).map(item => bindArgs(step, inputs, results, item));
      calls.push(...batch.map(args => ({ op: step.op, args })));
      out.push(...await Promise.all(batch.map(args => call(step.op, args))));
    }
    return out;
  }
  if (step.paginate) {
    const { arg, start = 1, max = 20, collect, stop } = step.paginate;
    const items = [];
    let pages = 0;
    for (let page = start; page < start + max; page++) {
      const args = { ...bindArgs(step, inputs, results), [arg]: page };
      calls.push({ op: step.op, args });
      const reply = await call(step.op, args);
      pages++;
      const chunk = getPath(reply, collect, inputs);
      if (!Array.isArray(chunk) || !chunk.length) break;
      items.push(...chunk);
      if (stop && getPath(reply, stop.path, inputs) === stop.equals) break;
    }
    return { items, pages };
  }
  const args = bindArgs(step, inputs, results);
  calls.push({ op: step.op, args });
  return call(step.op, args);
}

// writes: 'propose' (default) stops before a write step and returns the exact proposal; 'execute' runs it and is
// only used by commitProposal after approval.
export async function executePlan(plan, inputs, registry, call, { concurrency = 4, writes = 'propose' } = {}) {
  validatePlan(plan, registry);
  validateInputs(plan, inputs);
  const results = new Map();
  let pending = [...plan.steps];
  const calls = [];
  let proposal = null;
  while (pending.length) {
    const ready = pending.filter(step => dependsOn(step).every(id => results.has(id))).slice(0, concurrency);
    requireThat(ready.length, 'Plan has an unresolved dependency');
    const replies = await Promise.all(ready.map(async step => {
      if (isWrite(registry, step.op) && writes !== 'execute') {
        proposal = { op: step.op, args: bindArgs(step, inputs, results), stepId: step.id };
        return undefined;
      }
      return runStep(step, inputs, results, call, calls);
    }));
    ready.forEach((step, index) => results.set(step.id, replies[index]));
    pending = pending.filter(step => !results.has(step.id));
  }
  const output = Object.fromEntries(Object.entries(plan.output).map(([name, expr]) => [name, evaluate(expr, inputs, results)]));
  return { output, calls, results, proposal };
}

export const planHasWrite = (plan, registry) => plan.steps.some(step => isWrite(registry, step.op));

// Skeleton: the plan with literal constants replaced, used by consolidation to spot plans that differ only in values.
export function skeleton(plan) {
  const consts = [];
  const strip = ref => (Object.hasOwn(ref, 'const') ? (consts.push(ref.const), { const: '?' }) : ref);
  const body = {
    inputs: Object.fromEntries(Object.entries(plan.inputs).map(([name, spec]) => [name, spec.type])),
    steps: plan.steps.map(step => ({ id: step.id, op: step.op,
      args: Object.fromEntries(Object.entries(step.args).map(([key, ref]) => [key, strip(ref)])) })),
    output: plan.output,
  };
  return { key: digest(body), consts };
}

export const planDigest = plan => digest(plan);
export const planText = plan => canonical(plan);
