import { identifier, observation, formatReport, stations } from './confirmation-data.mjs';
import { parseRequest } from '../src/local-routing.mjs';
import { requireThat } from '../src/workflow.mjs';

const cityById = new Map([...stations.keys()].map(city => [identifier(city), city]));
const readings = { celsius: 'integer', humidity: 'integer' };
const cityFor = name => typeof name === 'string' && cityById.get(identifier(name.replace(/ city$/i, '')));

export const weatherRegistry = new Map([
  ['station_lookup.v1', {
    path: '/confirm/station', args: { city: 'string' }, fields: { station: 'string' },
    get(params) {
      const city = cityFor(params.get('city'));
      return city && { station: identifier(city) };
    },
  }],
  ['station_current.v1', {
    path: '/confirm/current', args: { station: 'string' }, fields: readings,
    get(params) {
      const city = cityById.get(params.get('station'));
      return city && observation(city, 0);
    },
  }],
  ['station_forecast.v1', {
    path: '/confirm/forecast', args: { station: 'string', hours: 'string' }, fields: readings,
    get(params) {
      const city = cityById.get(params.get('station'));
      const hours = params.get('hours');
      return city && ['1', '2', '3', '24'].includes(hours) && observation(city, hours);
    },
  }],
  ['station_week.v1', {
    path: '/confirm/week', args: { station: 'string' }, fields: readings,
    get(params) {
      const city = cityById.get(params.get('station'));
      return city && observation(city, 168);
    },
  }],
]);

function ref(step, field) {
  return { step, field };
}

export function weatherPlan(kind, size) {
  const inputs = {};
  const steps = [];
  const output = {};
  for (let index = 1; index <= size; index++) {
    const city = `city-${index}`;
    const station = `station-${index}`;
    const reading = `reading-${index}`;
    inputs[city] = 'string';
    steps.push({ id: station, op: 'station_lookup.v1', args: { city: { input: city } } });
    steps.push({ id: reading, op: readingOperation(kind), args: { station: ref(station, 'station') } });
    output[`temp-${index}`] = ref(reading, 'celsius');
    output[`humidity-${index}`] = ref(reading, 'humidity');
  }
  return { version: 1, inputs, steps, output };
}

const readingOperation = kind => kind === 'current' ? 'station_current.v1' : 'station_week.v1';

const patterns = {
  current: /^(?:Show current weather readings for|How warm and humid is it right now in) (?<cities>.+?)[?.]?$/iu,
  forecast: /^(?:Show seven-day weather readings for|Give me the temperature and humidity one week from now for) (?<cities>.+?)[?.]?$/iu,
};

export function weatherRoutes() {
  return ['current', 'forecast'].flatMap(kind => [1, 4, 8].map(size => ({
    route: `weather-${kind}-${size}`,
    description: `${kind === 'current' ? 'Current temperature humidity right now' : 'Seven-day weather forecast temperature humidity one week from now'} for ${size} cities`,
    examples: kind === 'current' ? ['Live Celsius readings and relative humidity now', 'Current warmth and humidity by city']
      : ['Get temperatures and humidity forecast in seven days', 'How warm and humid in one week'],
    plan: weatherPlan(kind, size),
    seed: Object.fromEntries([...stations.keys()].reverse().slice(0, size).map((city, i) => [`city-${i + 1}`, city])),
    contract(request) {
      const match = parseRequest(patterns[kind], request);
      const cities = match?.cities.split(/, | and /i).map(cityFor);
      if (cities?.length === size && cities.every(Boolean) && new Set(cities).size === size) {
        return Object.fromEntries(cities.map((city, i) => [`city-${i + 1}`, city]));
      }
    },
  })));
}

export function readingsFromRoute(outcome, request, contracts) {
  const cities = Object.values(contracts.get(outcome.route)(request));
  return {
    cities, readings: cities.map((_, i) => ({
      celsius: outcome.result[`temp-${i + 1}`], humidity: outcome.result[`humidity-${i + 1}`],
    })),
  };
}

export async function collectReport({ cities, kind }, dispatch) {
  requireThat(Array.isArray(cities) && [1, 4, 8].includes(cities.length)
    && cities.every(city => cityFor(city)) && ['current', 'forecast'].includes(kind), 'Invalid report arguments');
  const canonical = cities.map(cityFor);
  requireThat(new Set(canonical).size === cities.length, 'Repeated report city');
  const signal = AbortSignal.timeout(5000);
  const stationData = await Promise.all(canonical.map(city => dispatch('station_lookup.v1', { city }, signal)));
  const observations = await Promise.all(stationData.map(({ data }) =>
    dispatch(readingOperation(kind), data, signal)));
  return formatReport(canonical, observations.map(({ data }) => data));
}
