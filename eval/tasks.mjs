// Prompt adaptations and provenance are documented in eval/README.md.
const ref = (step, field) => ({ step, field });
const input = name => ({ input: name });
const step = (id, op, args) => ({ id, op: `${op}.v1`, args });
const spec = (seed, steps, output) => ({
  version: 1, inputs: Object.fromEntries(Object.keys(seed).map(key => [key, 'string'])), steps, output,
});
const saved = (description, seed, steps, output) => ({ description, seed, spec: spec(seed, steps, output) });
const example = (prompt, expected) => ({ prompt, expected });

export const families = [
  {
    id: 'retail-tracking', source: 'τ³-bench retail 25',
    saved: saved('Retail order shipment tracking number from customer name and zip', { name: 'Devon Yu', zip: '31001' }, [
      step('customer', 'retail_customer', { name: input('name'), zip: input('zip') }),
      step('order', 'retail_recent_order', { customer: ref('customer', 'customer') }),
      step('shipment', 'retail_shipment', { order: ref('order', 'order') }),
    ], { tracking: ref('shipment', 'tracking'), status: ref('shipment', 'status') }),
    examples: [
      example('I’m Ari Sol, ZIP 31002. I misplaced my last order number. Can you look up the shipment status and tracking number for that order?', { tracking: 'TRK-58203', status: 'in transit' }),
      example('My name is Jules Reed and my postal code is 31003. Where is my most recent order, and what is its tracking code? I don’t have the order ID.', { tracking: 'TRK-76319', status: 'delivered' }),
    ],
  },
  {
    id: 'airline-baggage', source: 'τ³-bench airline 3',
    saved: saved('Airline baggage allowance checked suitcase count by cabin and loyalty tier', { traveler: 'trav-a', reservation: 'R7A1' }, [
      step('booking', 'air_reservation', { reservation: input('reservation') }),
      step('profile', 'air_traveler', { traveler: input('traveler') }),
      step('rules', 'air_baggage', { cabin: ref('booking', 'cabin'), tier: ref('profile', 'tier') }),
    ], { bags: ref('rules', 'bags') }),
    examples: [
      example('My traveler ID is trav-b and the confirmation is R7B2. I think I’m Gold, but please check how many suitcases I personally can check for free on this reservation.', { bags: 2 }),
      example('For booking R7C3 and traveler trav-c, how many checked bags are included for that one traveler?', { bags: 3 }),
    ],
  },
  {
    id: 'airline-passengers', source: 'τ³-bench airline 38',
    saved: saved('Airline latest reservation passenger count from traveler ID', { traveler: 'trav-a' }, [
      step('profile', 'air_traveler', { traveler: input('traveler') }),
      step('booking', 'air_reservation', { reservation: ref('profile', 'latest') }),
    ], { passengers: ref('booking', 'passengers') }),
    examples: [
      example('I’m traveler trav-b. My most recent reservation had a delay, and I think there were three people on it. Can you check how many passengers were actually on that booking?', { passengers: 1 }),
      example('Could you verify the headcount on the latest booking for traveler trav-c? I don’t remember the confirmation number.', { passengers: 4 }),
    ],
  },
  {
    id: 'weather-pair', source: 'BFCL live_parallel_1-0-1',
    saved: saved('Current weather temperature comparison for two cities', { first: 'Austin', second: 'Miami' }, [
      step('first', 'weather', { city: input('first') }),
      step('second', 'weather', { city: input('second') }),
    ], { 'first-temp': ref('first', 'celsius'), 'second-temp': ref('second', 'celsius') }),
    examples: [
      example('What are the current temperatures in Boston and San Francisco, in Celsius, in that order?', { 'first-temp': 12, 'second-temp': 17 }),
      example('Give me the Celsius temperature readings for Seattle first and Portland second.', { 'first-temp': 9, 'second-temp': 13 }),
    ],
  },
  {
    id: 'fx-pair', source: 'BFCL parallel_58',
    saved: saved('Currency exchange rates from a base currency to two quote currencies', { base: 'USD', first: 'GBP', second: 'CHF' }, [
      step('first', 'fx_rate', { base: input('base'), quote: input('first') }),
      step('second', 'fx_rate', { base: input('base'), quote: input('second') }),
    ], { 'first-rate': ref('first', 'rate'), 'second-rate': ref('second', 'rate') }),
    examples: [
      example('Give me the exchange rates for USD into AUD, then USD into CAD. Use the quoted rate strings.', { 'first-rate': '1.53', 'second-rate': '1.36' }),
      example('For each euro, what rate is quoted in pounds sterling and then Japanese yen? Keep both rates as strings.', { 'first-rate': '0.86', 'second-rate': '162.40' }),
    ],
  },
  {
    id: 'news-and-weather', source: 'BFCL live_parallel_multiple_5-4-0',
    examples: [
      example('What’s the latest headline from Paris? Also, give me the current temperature in Celsius for Letterkenny.', { headline: 'Metro expands late service', celsius: 8 }),
      example('Fetch Lisbon’s newest local headline and the temperature in Celsius over in Cork.', { headline: 'Harbor ferry service resumes', celsius: 11 }),
    ],
  },
];

export const cases = families.flatMap(({ id, source, saved, examples }) =>
  examples.map((item, index) => ({
    ...item, id: `${id}-${index + 1}`, family: id, source, expectedRoute: saved ? id : null,
    prompt: item.prompt + '\nReturn a JSON object with exactly these fields and value types: '
      + Object.entries(item.expected).map(([key, value]) => `${key} (${typeof value})`).join(', ') + '.',
  })));
