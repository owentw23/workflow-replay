import { addUsage } from './agent.mjs';
import { collectReport, readingsFromRoute } from './confirmation-weather.mjs';
import { formatReport, normalizeWeatherAnswer } from './confirmation-data.mjs';
import { routeRequest } from '../src/host-routing.mjs';
import { json, requireThat } from '../src/workflow.mjs';

const string = { type: 'string' };
const tool = (name, description, properties) => ({
  type: 'function', function: { name, description, parameters: {
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
  } },
});
const atomic = [
  tool('station_lookup', 'Resolve a city name to its simulated weather station ID.', { city: string }),
  tool('station_current', 'Current Celsius temperature and relative humidity at a station.', { station: string }),
  tool('station_forecast', 'Short-term forecast Celsius temperature and humidity at a station. Hours must be one of the strings 1, 2, 3 or 24.', { station: string, hours: string }),
  tool('station_week', 'Seven-day forecast Celsius temperature and relative humidity at a station.', { station: string }),
];
const collector = tool('weather_report', 'Get an ordered report for 1, 4 or 8 cities, with Celsius, humidity and the warmest city. Current or seven days from now.',
  { cities: { type: 'array', items: string }, kind: { type: 'string', enum: ['current', 'forecast'] } });
const ops = new Map(atomic.map(({ function: fn }) => [fn.name, Object.keys(fn.parameters.properties)]));
const system = 'Use simulated tool data for all weather facts. Use station_lookup to get station IDs before requesting observations. Return only the JSON requested, in the requested city order. Parallel independent calls are allowed.';

export async function confirmationEpisode({ item, arm, complete, db, registry, dispatch, contracts }) {
  const start = performance.now();
  const usage = { input: 0, output: 0, cached: 0, total: 0 };
  const trace = [];
  let httpCalls = 0;
  let turns = 0;
  let collectorCalls = 0;
  let routing;
  const http = (...args) => {
    httpCalls++;
    return dispatch(...args);
  };
  const user = { role: 'user', content: item.request + '\n' + item.output };
  async function call(request) {
    const response = await complete({ max_tokens: 900, ...request });
    addUsage(usage, response.usage);
    turns++;
    const choice = response.choices?.[0];
    requireThat(choice?.message, 'Provider returned an incomplete choice');
    return choice;
  }
  function done(answer) {
    const normalized = normalizeWeatherAnswer(answer);
    return {
      arm, caseId: item.id, family: item.kind, size: item.size, expectedRoute: item.expectedRoute,
      correct: normalized === json(item.expected), normalized, trace, turns, httpCalls, usage,
      routes: routing?.route ? [routing.route] : [], routing: routing?.kind,
      shortlisted: routing?.candidates, collectorCalls, ms: Math.round(performance.now() - start),
    };
  }
  function fromModel(choice) {
    if (choice.finish_reason === 'stop') {
      try { return done(JSON.parse(choice.message.content)); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return done(null);
  }

  if (arm === 'playbook-only' || arm === 'host-routed') {
    routing = await routeRequest({ request: item.request, db, registry, dispatch: http, local: { contracts } });
    if (routing.result) {
      trace.push([{ name: 'host_execute', route: routing.route, ok: true }]);
      const { cities, readings } = readingsFromRoute(routing, item.request, contracts);
      if (arm === 'host-routed') return done(formatReport(cities, readings));
      const choice = await call({ messages: [
        { role: 'system', content: 'Use the fetched weather records below to return the requested JSON. Infer the warmest city from the Celsius values.' },
        user,
        { role: 'user', content: json(cities.map((city, i) => ({ city, ...readings[i] }))) },
      ] });
      return fromModel(choice);
    }
  }

  const withCollector = arm === 'direct-collector';
  const tools = withCollector ? [collector, ...atomic] : atomic;
  const messages = [
    { role: 'system', content: withCollector
      ? system + ' Use weather_report when its fields and time horizon cover the requested report.' : system },
    user,
  ];
  for (let turn = 0; turn < 7; turn++) {
    const choice = await call({ messages, tools, tool_choice: turn === 6 ? 'none' : 'auto' });
    const calls = choice.message.tool_calls ?? [];
    if (!calls.length || turn === 6) return fromModel(choice);
    requireThat(calls.length <= 24 && calls.every(entry => typeof entry.id === 'string' && entry.function),
      'Provider returned an invalid tool batch');
    messages.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: calls });
    const results = await Promise.all(calls.map(async ({ id, function: fn }) => {
      const name = fn.name;
      let args;
      try {
        args = JSON.parse(fn.arguments);
        const keys = name === 'weather_report' && withCollector ? ['cities', 'kind'] : ops.get(name);
        requireThat(keys && args && !Array.isArray(args) && typeof args === 'object'
          && Object.keys(args).length === keys.length && keys.every(key => Object.hasOwn(args, key)),
        'Invalid tool arguments');
        if (name === 'weather_report') {
          collectorCalls++;
          return { id, name, args, data: await collectReport(args, http), ok: true };
        }
        const { data } = await http(`${name}.v1`, args, AbortSignal.timeout(5000));
        return { id, name, args, data, ok: true };
      } catch {
        return { id, name, args, data: { error: 'Invalid arguments or unavailable weather data' }, ok: false };
      }
    }));
    trace.push(results.map(({ name, args, ok }) => ({ name, args, ok })));
    for (const { id, data } of results) messages.push({ role: 'tool', tool_call_id: id, content: json(data) });
  }
}
