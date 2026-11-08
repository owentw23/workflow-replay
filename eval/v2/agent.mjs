// DeepSeek V4.1 Flash via BytePlus ModelArk (OpenAI-compatible chat API) and a plain tool-calling agent loop.
import { canonical, requireThat } from '../../src/v2/util.mjs';

export const MODEL = process.env.ARK_MODEL || 'deepseek-v4-1-flash-261017';
const ENDPOINT = 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions';
export const TEMPERATURE = 0.3;
export const MAX_TOKENS = 400;
export const MAX_TURNS = 8;

export function createModel({ key = process.env.ARK_API_KEY || process.env.DEEPSEEK_API_KEY, model = MODEL } = {}) {
  requireThat(typeof key === 'string' && key.trim(), 'Set ARK_API_KEY (or DEEPSEEK_API_KEY) in cred.env');
  let inFlight = 0;
  return async function complete(body, attempt = 0) {
    inFlight++;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, thinking: { type: 'disabled' }, temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
          response_format: { type: 'json_object' }, ...body }),
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          return complete(body, attempt + 1);
        }
      }
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        const code = error?.error?.code;
        throw new Error(`ModelArk HTTP ${response.status}${typeof code === 'string' && /^[\w.-]{1,80}$/.test(code) ? ` (${code})` : ''}`);
      }
      return await response.json();
    } finally {
      inFlight--;
    }
  };
}

export const emptyUsage = () => ({ input: 0, output: 0, cached: 0, total: 0, calls: 0 });

export function addUsage(totals, usage) {
  if (!usage) return;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  totals.input += input;
  totals.output += output;
  totals.cached += cached;
  totals.total += input + output;
  totals.calls += 1;
}

export const SYSTEM = 'You are a support assistant with read-only access to a retailer\'s and an airline\'s systems. '
  + 'Use the tools as the source of truth for every fact. Lists of order ids and reservation ids are ordered oldest to newest. '
  + 'Each user message ends with the answer format. When you have the facts, reply with only a JSON object with exactly '
  + 'those keys. Use null for a fact that does not exist. Write numbers as JSON numbers.';

export const formatLine = keys => `\n\nAnswer format: a JSON object with exactly these keys: ${keys.join(', ')}.`;

const asTool = spec => ({ type: 'function', function: spec });

// Runs one user turn. `messages` is the conversation so far (mutated: the turn is appended).
export async function agentTurn({ complete, messages, tools, invoke, usage, maxTurns = MAX_TURNS }) {
  const trace = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await complete({ messages, tools: tools.map(asTool), tool_choice: turn === maxTurns ? 'none' : 'auto' });
    addUsage(usage, response.usage);
    const choice = response.choices?.[0];
    requireThat(choice?.message, 'ModelArk returned an incomplete completion');
    const calls = choice.message.tool_calls ?? [];
    if (!calls.length || turn === maxTurns) {
      messages.push({ role: 'assistant', content: choice.message.content ?? '' });
      let answer = null;
      try { answer = JSON.parse(choice.message.content); } catch { /* invalid JSON scores as wrong */ }
      return { answer: answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : null, trace, turns: turn };
    }
    messages.push({ role: 'assistant', content: choice.message.content ?? null,
      tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) });
    const replies = await Promise.all(calls.map(async call => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { error: 'Arguments were not valid JSON' }; }
      try { return await invoke(call.function.name, args); } catch (error) { return { error: String(error.message).slice(0, 200) }; }
    }));
    calls.forEach((call, index) => {
      trace.push({ name: call.function.name, ok: !replies[index]?.error, speculated: !!replies[index]?.workflow_result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: canonical(replies[index]) });
    });
  }
  return { answer: null, trace, turns: maxTurns };
}

// Router extraction call: small, temperature 0, JSON only.
export function extractor(complete) {
  return async ({ system, user }) => {
    const response = await complete({ temperature: 0, max_tokens: 200,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    let value = null;
    try { value = JSON.parse(response.choices?.[0]?.message?.content); } catch { value = null; }
    return { value, usage: response.usage };
  };
}
