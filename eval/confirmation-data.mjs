import { json } from '../src/workflow.mjs';

// Deterministic simulated station data. Values are not real weather forecasts.
export const stations = new Map([
  ['New York', [17, 61]], ['Los Angeles', [24, 48]], ['London', [12, 77]], ['Tokyo', [21, 68]],
  ['Seattle', [11, 84]], ['Oslo', [5, 65]], ['Madrid', [20, 44]], ['Singapore', [30, 79]],
  ['Denver', [15, 42]],
]);

const groups = {
  1: ['New York'],
  4: ['New York', 'Los Angeles', 'London', 'Tokyo'],
  8: ['Seattle', 'Oslo', 'Madrid', 'Singapore', 'New York', 'Los Angeles', 'London', 'Tokyo'],
};

const gold = {
  'New York': [17, 61, 19, 59], 'Los Angeles': [24, 48, 26, 46],
  London: [12, 77, 14, 75], Tokyo: [21, 68, 23, 66],
  Seattle: [11, 84, 13, 82], Oslo: [5, 65, 7, 63],
  Madrid: [20, 44, 22, 42], Singapore: [30, 79, 32, 77],
};
const warmestBySize = { 1: 'New York', 4: 'Los Angeles', 8: 'Singapore' };

export const identifier = city => city.toLowerCase().replaceAll(' ', '-');
export function observation(city, hours) {
  const [temperature, humidity] = stations.get(city);
  const change = Number(hours) === 168 ? 2 : Number(hours) === 24 ? -2 : Number(hours);
  return { celsius: temperature + change, humidity: humidity - change };
}

export function formatReport(cities, readings) {
  const warmest = cities.reduce((best, city, index) =>
    readings[index].celsius > readings[best].celsius ? index : best, 0);
  return { readings: cities.map((city, index) => ({ city, ...readings[index] })), warmest: cities[warmest] };
}

// The source dataset spells the city name out, while the fixture uses its short name.
const cityLabel = value => value === 'New York City' ? 'New York' : value;

export function normalizeWeatherAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const normalized = { ...answer };
  if (Object.hasOwn(normalized, 'warmest')) normalized.warmest = cityLabel(normalized.warmest);
  if (Array.isArray(normalized.readings)) normalized.readings = normalized.readings.map(reading =>
    reading && typeof reading === 'object' && Object.hasOwn(reading, 'city')
      ? { ...reading, city: cityLabel(reading.city) } : reading);
  return json(normalized);
}

function reportCase(kind, size, variant, request, source = 'synthetic') {
  const cities = groups[size];
  const offset = kind === 'current' ? 0 : 2;
  return {
    id: `${kind}-${size}-${variant}`, size, kind, source, request,
    expectedRoute: `weather-${kind}-${size}`,
    expected: { readings: cities.map(city => ({ city, celsius: gold[city][offset], humidity: gold[city][offset + 1] })),
      warmest: warmestBySize[size] },
    output: 'Return JSON with readings (array of {city,celsius,humidity} in the named city order) and warmest (city name; first in order on ties). Humidity is a whole percentage.',
  };
}

function nearMiss(id, request, output, expected, source = 'synthetic') {
  return { id, kind: 'near-miss', request, output, expected, source, expectedRoute: null };
}

export const confirmationCases = [
  ...Object.entries(groups).flatMap(([size, cities]) => {
    size = Number(size);
    const list = cities.join(', ');
    const current = size === 4
      ? 'What is the current temperature and humidity in New York, Los Angeles, London and Tokyo, if I want to include both temperature and humidity in the results?'
      : `Show current weather readings for ${list}.`;
    const forecast = size === 1
      ? 'How will the weather conditions change regarding humidity and temperature levels in New York City seven days from now?'
      : `Show seven-day weather readings for ${list}.`;
    return [
      reportCase('current', size, 'a', current, size === 4 ? 'BFCL parallel_199' : undefined),
      reportCase('current', size, 'b', `How warm and humid is it right now in ${list}?`),
      reportCase('forecast', size, 'a', forecast, size === 1 ? 'IBM BFCL-FC-Robustness multiple_60' : undefined),
      reportCase('forecast', size, 'b', `Give me the temperature and humidity one week from now for ${list}.`),
    ];
  }),
  nearMiss('three-hour-forecast', 'What is the temperature right now and for the next three hours in Seattle and Los Angeles?',
    'Return JSON with readings, an array of {city,now,next} in the requested city order. now is Celsius now. next is an array of Celsius temperatures at 1, 2 and 3 hours from now.',
    { readings: [
      { city: 'Seattle', now: 11, next: [12, 13, 14] }, { city: 'Los Angeles', now: 24, next: [25, 26, 27] },
    ] }, 'BFCL parallel_28'),
  nearMiss('humidity-only', 'Show current humidity only for New York, Los Angeles, London and Tokyo.',
    'Return JSON with readings, an array of {city,humidity} in the requested city order.',
    { readings: [{ city: 'New York', humidity: 61 }, { city: 'Los Angeles', humidity: 48 },
      { city: 'London', humidity: 77 }, { city: 'Tokyo', humidity: 68 }] }),
  nearMiss('tomorrow', 'Show tomorrow’s temperature and humidity for New York, Los Angeles, London and Tokyo.',
    'Return JSON with readings (array of {city,celsius,humidity} in the named city order) and warmest (city name). Tomorrow means 24 hours from now.',
    { readings: [{ city: 'New York', celsius: 15, humidity: 63 }, { city: 'Los Angeles', celsius: 22, humidity: 50 },
      { city: 'London', celsius: 10, humidity: 79 }, { city: 'Tokyo', celsius: 19, humidity: 70 }], warmest: 'Los Angeles' }),
  nearMiss('one-week-humidity', 'Give me the humidity only one week from now for New York.',
    'Return JSON with readings, an array containing one {city,humidity} record.',
    { readings: [{ city: 'New York', humidity: 59 }] }),
];
