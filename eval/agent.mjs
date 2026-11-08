import { load, lookup } from '../src/playbook.mjs';
import { execute, json, requireThat } from '../src/workflow.mjs';
import { registry } from './fixture.mjs';
import { auditHttpTools } from './audit.mjs';

const fields = keys => Object.fromEntries(keys.map(key => [key, { type: 'string' }]));
const schema = (name, description, properties) => ({
  type: 'function',
  function: { name, description, parameters: {
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
  } },
});

const operations = new Map([...registry, ...auditHttpTools].map(([op, tool]) => [op.slice(0, -3), { op, ...tool }]));
const directTools = [...operations].map(([name, tool]) => schema(name, tool.description, fields(Object.keys(tool.args))));
const auditSum = schema('audit_sum_amounts', 'Add integer cents exactly. Pass the amounts of all selected orders.',
  { amounts: { type: 'array', items: { type: 'integer' } } });
const runAudit = schema('run_audit',
  'Run the overdue shipment audit for a batch ID. Returns the count, total-cents, and sorted exception-ids of orders both overdue and unshipped.',
  fields(['batch']));
const replayTools = [
  schema('lookup_workflow', 'Search reusable workflows by task goal, using short keywords. Returns route IDs, required inputs, and output fields.', fields(['goal'])),
  schema('run_workflow', 'Execute a matching saved route with fresh inputs. Returns the requested JSON fields.', {
    route: { type: 'string' },
    inputs: { type: 'object', description: 'Named input values from the current request, per the route schema.' },
  }),
];

const basePrompt = 'You are evaluating a synthetic service. Use the tools as the source of truth for every requested fact. Return only the requested JSON object with exactly the specified fields. If the data cannot be found, return an empty JSON object.';
const replayPrompt = 'For a reusable task, first search the workflow catalog by goal. Run a candidate only if it covers the requested fields and you have its inputs. Use direct tools when the catalog has no matching workflow or replay fails.';

export const maxTurns = 6;
export const maxTokens = 320;
export const arms = ['direct-raw', 'direct-projected', 'replay'];
export const temperature = 0.5;

export function modelArkClient({ key, model }) {
  requireThat(typeof key === 'string' && key.trim(), 'Set ARK_API_KEY in cred.env (DEEPSEEK_API_KEY also works)');
  return async request => {
    const response = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model, thinking: { type: 'disabled' }, temperature, max_tokens: maxTokens,
        response_format: { type: 'json_object' }, ...request,
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      const code = error?.error?.code;
      const label = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? ` (${code})` : '';
      throw new Error(`ModelArk HTTP ${response.status}${label}`);
    }
    return response.json();
  };
}

function argumentsFor(call) {
  const args = JSON.parse(call.function.arguments);
  requireThat(args && typeof args === 'object' && !Array.isArray(args), 'Expected an argument object');
  return args;
}

export function addUsage(totals, usage) {
  const values = {
    input: usage?.prompt_tokens,
    output: usage?.completion_tokens,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
  };
  requireThat(Object.values(values).every(value => Number.isSafeInteger(value) && value >= 0)
    && values.cached <= values.input, 'ModelArk returned incomplete token usage');
  for (const [field, value] of Object.entries(values)) totals[field] += value;
  totals.total += values.input + values.output;
}

export async function episode({ item, arm, complete, db, dispatch, route, extendDispatch = base => base }) {
  const replay = arm === 'replay';
  const collector = arm === 'direct-collector';
  const available = directTools.filter(({ function: { name } }) =>
    name.startsWith('audit_') === (item.family === 'shipment-audit') && (name !== 'fx_history' || item.group));
  if (item.family === 'shipment-audit') available.push(auditSum);
  const allowed = new Set(available.map(tool => tool.function.name));
  const tools = collector ? [runAudit] : replay ? [...replayTools, ...available] : available;
  const messages = [
    { role: 'system', content: [
      basePrompt, replay && replayPrompt,
      item.family === 'shipment-audit' && !collector && 'Use the calculator tool to sum the selected order amounts.',
    ].filter(Boolean).join(' ') },
    { role: 'user', content: item.prompt },
  ];
  const usage = { input: 0, output: 0, cached: 0, total: 0 };
  const trace = [];
  const fingerprints = new Set();
  const routes = new Set();
  const start = performance.now();
  let httpCalls = 0;
  const countedDispatch = extendDispatch((...args) => {
    httpCalls++;
    return dispatch(...args);
  });
  let routing;
  let routingTurns = 0;
  let routingModel;
  if (arm === 'host-routed') {
    routing = await route(item.prompt, countedDispatch, async (request, candidates) => {
      const response = await complete({
        temperature: 0, max_tokens: 160,
        messages: [
          { role: 'system', content: 'Select a saved workflow only if it covers the entire user request, including all requested fields. Extract its inputs exactly from the request. Use null if any input is missing or no route fits. Return JSON as {"route":string or null,"inputs":object}.' },
          { role: 'user', content: json({ request, candidates: candidates.map(({ category, ...candidate }) => candidate) }) },
        ],
      });
      addUsage(usage, response.usage);
      routingTurns++;
      routingModel = response.model;
      if (response.choices?.[0]?.finish_reason !== 'stop') return null;
      try { return JSON.parse(response.choices[0].message.content); } catch { return null; }
    });
    if (routing.result) {
      const normalized = json(routing.result);
      return {
        arm, caseId: item.id, family: item.family, expectedRoute: item.expectedRoute, size: item.size,
        correct: normalized === json(item.expected), normalized, finish: 'stop',
        routes: [routing.route], trace: [[{ name: 'host_execute', route: routing.route, ok: true }]],
        routing: routing.kind, turns: routingTurns, httpCalls, usage, ms: Math.round(performance.now() - start),
        model: routingModel, fingerprints: [],
      };
    }
  }

  async function invoke(call) {
    const name = call.function.name;
    let args;
    try {
      args = argumentsFor(call);
      if (collector) {
        requireThat(name === 'run_audit' && Object.keys(args).length === 1 && typeof args.batch === 'string',
          'Expected one batch ID for run_audit');
        const signal = AbortSignal.timeout(5000);
        const { data: scope } = await countedDispatch('audit_scope.v1', args, signal);
        const { data: result } = await countedDispatch('audit_collect.v1', scope, signal);
        return { name, args, result };
      }
      if (replay && name === 'lookup_workflow') return { name, args, result: lookup(db, args.goal) };
      if (replay && name === 'run_workflow') {
        requireThat(typeof args.route === 'string', 'A route ID is required');
        const result = await execute(load(db, args.route), args.inputs, registry, countedDispatch);
        routes.add(args.route);
        return { name, args, result };
      }
      if (name === 'audit_sum_amounts' && allowed.has(name)) {
        const { amounts } = args;
        requireThat(Object.keys(args).length === 1 && Array.isArray(amounts) && amounts.length <= 100
          && amounts.every(value => Number.isSafeInteger(value) && Math.abs(value) <= 100_000_000),
        'Expected up to 100 integer amounts');
        return { name, args, result: { sum: amounts.reduce((total, value) => total + value, 0) } };
      }
      const tool = operations.get(name);
      requireThat(tool && allowed.has(name), 'Unknown tool');
      requireThat(Object.keys(args).length === Object.keys(tool.args).length
        && Object.keys(tool.args).every(key => Object.hasOwn(args, key)), 'Invalid tool arguments');
      const { raw, data } = await countedDispatch(tool.op, args, AbortSignal.timeout(5000));
      return { name, args, result: arm === 'direct-raw' ? raw : data };
    } catch {
      return { name, args, result: { error: 'Invalid arguments, unknown route, or no matching data' } };
    }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await complete({ messages, tools, tool_choice: turn === maxTurns ? 'none' : 'auto' });
    addUsage(usage, response.usage);
    if (response.system_fingerprint) fingerprints.add(response.system_fingerprint);
    const { message, finish_reason: finish } = response.choices?.[0] ?? {};
    requireThat(message && response.model, 'ModelArk returned an incomplete completion');
    const calls = message.tool_calls ?? [];
    if (!calls.length || turn === maxTurns) {
      let answer;
      if (finish === 'stop') {
        try { answer = JSON.parse(message.content); } catch { /* invalid JSON counts as a failed trial */ }
      }
      const normalized = answer && typeof answer === 'object' && !Array.isArray(answer) ? json(answer) : null;
      return {
        arm, caseId: item.id, family: item.family, expectedRoute: item.expectedRoute, size: item.size,
        correct: normalized === json(item.expected), normalized, finish,
        routes: [...routes], trace, routing: routing?.kind, turns: turn + routingTurns, httpCalls, usage,
        ms: Math.round(performance.now() - start),
        model: response.model, fingerprints: [...fingerprints],
      };
    }
    requireThat(calls.length <= 12 && calls.every(call => typeof call.id === 'string' && call.function),
      'ModelArk returned an invalid tool call batch');
    messages.push({
      role: 'assistant', content: message.content ?? null,
      tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })),
    });
    const replies = await Promise.all(calls.map(invoke));
    trace.push(replies.map(({ name, args, result }) => ({ name, args, ok: !result.error })));
    for (const [index, call] of calls.entries()) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: json(replies[index].result) });
    }
  }
}
