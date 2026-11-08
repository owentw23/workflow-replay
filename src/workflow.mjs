import { createHash } from 'node:crypto';

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const TYPES = new Set(['string', 'integer', 'boolean']);

export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function json(value) {
  return JSON.stringify(value, (_, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

function exactKeys(object, keys, label) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)),
  `Invalid ${label} fields`);
}

export function validateValue(value, type, label, maxStringLength = 256) {
  const valid = type === 'integer' ? Number.isSafeInteger(value)
    : type === 'string' ? typeof value === 'string' && value.length > 0 && value.length <= maxStringLength
    : type === 'boolean' && typeof value === 'boolean';
  requireThat(valid, `Invalid ${label}. Expected ${type} (strings limited to 1–${maxStringLength} characters)`);
}

function resolve(ref, inputs, results) {
  return Object.hasOwn(ref, 'input') ? inputs[ref.input] : results.get(ref.step)[ref.field];
}

function referenceType(ref, inputs, stepTools) {
  if (ref && Object.hasOwn(ref, 'input')) {
    exactKeys(ref, ['input'], 'input reference');
    requireThat(typeof ref.input === 'string' && Object.hasOwn(inputs, ref.input), 'Unknown input');
    return inputs[ref.input];
  }
  exactKeys(ref, ['step', 'field'], 'step reference');
  const fields = stepTools.get(ref.step)?.fields;
  requireThat(fields && typeof ref.field === 'string' && Object.hasOwn(fields, ref.field),
    'Unknown step or unregistered result field');
  return fields[ref.field];
}

function checkInputs(schema, inputs) {
  requireThat(schema && !Array.isArray(schema) && typeof schema === 'object', 'Invalid input schema');
  const names = Object.keys(schema);
  requireThat(names.length <= 16 && names.every(name => NAME.test(name)
    && TYPES.has(schema[name])), 'Invalid input schema');
  exactKeys(inputs, names, 'inputs');
  for (const name of names) validateValue(inputs[name], schema[name], name);
}

function checkStep(step, schema, registry, stepTools) {
  exactKeys(step, ['id', 'op', 'args'], 'step');
  requireThat(typeof step.id === 'string' && NAME.test(step.id) && !stepTools.has(step.id),
    'Invalid or duplicate step id');
  const tool = registry.get(step.op);
  requireThat(tool, 'Unregistered operation');
  exactKeys(step.args, Object.keys(tool.args), 'operation arguments');
  for (const [name, type] of Object.entries(tool.args)) {
    requireThat(referenceType(step.args[name], schema, stepTools) === type,
      `Type mismatch for ${step.op}.${name}`);
  }
  return tool;
}

function checkOutput(output, schema, stepTools) {
  requireThat(output && !Array.isArray(output)
    && typeof output === 'object', 'Invalid output projection');
  const fields = Object.entries(output);
  requireThat(fields.length > 0 && fields.length <= 16, 'Expected 1–16 output fields');
  return Object.fromEntries(fields.map(([name, ref]) => {
    requireThat(NAME.test(name) && ref && !Object.hasOwn(ref, 'input'), 'Invalid output field');
    return [name, referenceType(ref, schema, stepTools)];
  }));
}

export function checkWorkflow(workflow, registry, inputs) {
  exactKeys(workflow, ['version', 'inputs', 'steps', 'output'], 'workflow');
  requireThat(workflow.version === 1, 'Unsupported workflow version');
  checkInputs(workflow.inputs, inputs);
  requireThat(Array.isArray(workflow.steps) && workflow.steps.length > 0
    && workflow.steps.length <= 32, 'Expected 1–32 steps');
  const stepTools = new Map();
  for (const step of workflow.steps) {
    const tool = checkStep(step, workflow.inputs, registry, stepTools);
    stepTools.set(step.id, tool);
  }
  return checkOutput(workflow.output, workflow.inputs, stepTools);
}

function bind(step, inputs, results) {
  return Object.fromEntries(Object.entries(step.args)
    .map(([name, ref]) => [name, resolve(ref, inputs, results)]));
}

function project(output, results) {
  return Object.fromEntries(Object.entries(output).map(([name, ref]) => [name, resolve(ref, {}, results)]));
}

export function compile(trace, inputs, output) {
  // Remove names assigned during discovery. Sort independent steps by their bound operation.
  const renamed = new Map();
  const rewrite = ref => Object.hasOwn(ref, 'input') ? ref
    : { step: renamed.get(ref.step), field: ref.field };
  let pending = [...trace];
  const steps = [];
  while (pending.length) {
    const ready = pending.filter(step => Object.values(step.args)
      .every(ref => Object.hasOwn(ref, 'input') || renamed.has(ref.step)));
    requireThat(ready.length > 0, 'Unresolved trace dependency');
    const ordered = ready.map(step => ({
      original: step.id,
      op: step.op,
      args: Object.fromEntries(Object.entries(step.args).map(([key, ref]) => [key, rewrite(ref)])),
    }));
    ordered.sort((a, b) => {
      const left = json([a.op, a.args]);
      const right = json([b.op, b.args]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const { original, op, args } of ordered) {
      const id = `step-${steps.length + 1}`;
      renamed.set(original, id);
      steps.push({ id, op, args });
    }
    pending = pending.filter(step => !renamed.has(step.id));
  }
  return {
    version: 1, inputs, steps,
    output: Object.fromEntries(Object.entries(output).map(([key, ref]) => [key, rewrite(ref)])),
  };
}

export function fingerprint(workflow) {
  return createHash('sha256').update(json(workflow)).digest('hex');
}

async function readJson(response) {
  const maxBytes = 256 * 1024;
  const reader = response.body?.getReader();
  requireThat(reader, 'Missing HTTP response body');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      requireThat(bytes <= maxBytes, 'HTTP response exceeded byte limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function httpDispatcher(origin, registry) {
  const base = new URL(origin);
  requireThat(base.protocol === 'http:' && base.hostname === '127.0.0.1'
    && base.href === base.origin + '/', 'The fixture origin must be loopback HTTP');
  return getDispatcher(base, registry);
}

export function httpsDispatcher(origin, registry, { tokenEnv } = {}) {
  const base = new URL(origin);
  requireThat(base.protocol === 'https:' && base.href === base.origin + '/', 'Expected a trusted HTTPS origin');
  requireThat(tokenEnv === undefined || /^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv), 'Invalid token variable name');
  return getDispatcher(base, registry, tokenEnv);
}

function getDispatcher(base, registry, tokenEnv) {
  return async (op, args, signal) => {
    const tool = registry.get(op);
    requireThat(tool, 'Unregistered operation');
    const url = new URL(tool.path, base);
    requireThat(url.origin === base.origin, 'Registered operation must stay on the configured origin');
    for (const [name, value] of Object.entries(args)) {
      validateValue(value, tool.args[name], name);
      url.searchParams.set(name, value);
    }
    const token = tokenEnv && process.env[tokenEnv];
    requireThat(!tokenEnv || token, 'The configured connector credential is missing');
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { redirect: 'error', signal, headers });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} for ${op}`);
    }
    const raw = await readJson(response);
    requireThat(raw && typeof raw === 'object' && !Array.isArray(raw), `Invalid HTTP JSON for ${op}`);
    const data = Object.fromEntries(Object.entries(tool.fields).map(([name, type]) => {
      const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
      validateValue(value, type, `${op}.${name}`);
      return [name, value];
    }));
    return { data, raw };
  };
}

export async function execute(workflow, inputs, registry, dispatch, {
  concurrency = 4, onBatch,
} = {}) {
  requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8,
    'Concurrency must be an integer from 1–8');
  checkWorkflow(workflow, registry, inputs);
  const results = new Map();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
  let pending = [...workflow.steps];
  while (pending.length) {
    // Calls in a batch have no data dependency on one another.
    const batch = pending.filter(step => Object.values(step.args)
      .every(ref => Object.hasOwn(ref, 'input') || results.has(ref.step))).slice(0, concurrency);
    const calls = batch.map(step => ({ step, args: bind(step, inputs, results) }));
    const tasks = calls.map(async ({ step, args }) => dispatch(step.op, args, signal));
    let replies;
    try {
      replies = await Promise.all(tasks);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(tasks);
      throw error;
    }
    for (const [index, { step }] of calls.entries()) {
      results.set(step.id, replies[index].data);
    }
    onBatch?.(calls, replies);
    pending = pending.filter(step => !results.has(step.id));
  }
  return project(workflow.output, results);
}

export function startRecording(schema, inputs, registry, dispatch) {
  checkInputs(schema, inputs);
  schema = structuredClone(schema);
  inputs = structuredClone(inputs);
  const stepTools = new Map();
  const results = new Map();
  const trace = [];
  let state = 'open';
  return {
    async call(step) {
      requireThat(state === 'open' && trace.length < 32, 'Recording cannot accept another call');
      step = structuredClone(step);
      const tool = checkStep(step, schema, registry, stepTools);
      state = 'running';
      try {
        const args = bind(step, inputs, results);
        const reply = await dispatch(step.op, args, AbortSignal.timeout(5000));
        results.set(step.id, structuredClone(reply.data));
        stepTools.set(step.id, tool);
        trace.push(step);
        state = 'open';
        return reply;
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    finish(output) {
      requireThat(state === 'open' && trace.length > 0, 'Recording is incomplete or failed');
      checkOutput(output, schema, stepTools);
      state = 'closed';
      return { result: project(output, results), workflow: compile(trace, schema, output) };
    },
  };
}

export async function capture(workflow, inputs, registry, dispatch) {
  checkWorkflow(workflow, registry, inputs);
  const recording = startRecording(workflow.inputs, inputs, registry, dispatch);
  for (const step of workflow.steps) await recording.call(step);
  return recording.finish(workflow.output);
}
