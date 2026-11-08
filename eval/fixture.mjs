import { createServer } from 'node:http';
import { json, requireThat } from '../src/workflow.mjs';
import { auditHttpTools } from './audit.mjs';

function tool(description, args, fields, rows) {
  const records = new Map(rows.map(([key, value]) => [json(key), value]));
  return {
    description,
    args: Object.fromEntries(args.map(key => [key, 'string'])),
    fields,
    get: values => records.get(json(args.map(key => values.get(key)))),
  };
}

export const registry = new Map(Object.entries({
  retail_customer: tool('Find a retail customer by full name and postal ZIP. Returns customer ID.',
    ['name', 'zip'], { customer: 'string' }, [
      [['Devon Yu', '31001'], { customer: 'cust-a' }],
      [['Ari Sol', '31002'], { customer: 'cust-b' }],
      [['Jules Reed', '31003'], { customer: 'cust-c' }],
    ]),
  retail_recent_order: tool('Find the latest retail order ID for a customer ID.',
    ['customer'], { order: 'string' }, [
      [['cust-a'], { order: 'ord-a' }], [['cust-b'], { order: 'ord-b' }], [['cust-c'], { order: 'ord-c' }],
    ]),
  retail_shipment: tool('Get shipment status and tracking number for a retail order ID.',
    ['order'], { tracking: 'string', status: 'string' }, [
      [['ord-a'], { tracking: 'TRK-19482', status: 'processing' }],
      [['ord-b'], { tracking: 'TRK-58203', status: 'in transit' }],
      [['ord-c'], { tracking: 'TRK-76319', status: 'delivered' }],
    ]),
  air_traveler: tool('Get airline loyalty tier and latest reservation ID (latest) for a traveler ID.',
    ['traveler'], { tier: 'string', latest: 'string' }, [
      [['trav-a'], { tier: 'standard', latest: 'R7A1' }],
      [['trav-b'], { tier: 'silver', latest: 'R7B2' }],
      [['trav-c'], { tier: 'gold', latest: 'R7C3' }],
    ]),
  air_reservation: tool('Get cabin and passenger count (passengers) for an airline reservation ID.',
    ['reservation'], { cabin: 'string', passengers: 'integer' }, [
      [['R7A1'], { cabin: 'economy', passengers: 2 }],
      [['R7B2'], { cabin: 'economy', passengers: 1 }],
      [['R7C3'], { cabin: 'business', passengers: 4 }],
    ]),
  air_baggage: tool('Get the total number of free checked bags per traveler using cabin and loyalty tier.',
    ['cabin', 'tier'], { bags: 'integer' }, [
      [['economy', 'standard'], { bags: 1 }], [['economy', 'silver'], { bags: 2 }],
      [['economy', 'gold'], { bags: 3 }], [['business', 'gold'], { bags: 3 }],
    ]),
  weather: tool('Get the current temperature in Celsius for one city by its name.',
    ['city'], { celsius: 'integer' }, [
      [['Austin'], { celsius: 24 }], [['Miami'], { celsius: 27 }],
      [['Boston'], { celsius: 12 }], [['San Francisco'], { celsius: 17 }],
      [['Seattle'], { celsius: 9 }], [['Portland'], { celsius: 13 }],
      [['Letterkenny'], { celsius: 8 }], [['Cork'], { celsius: 11 }],
    ]),
  fx_rate: tool('Get one currency exchange rate as a decimal string. Use ISO currency codes.',
    ['base', 'quote'], { rate: 'string' }, [
      [['USD', 'GBP'], { rate: '0.79' }], [['USD', 'CHF'], { rate: '0.90' }],
      [['USD', 'AUD'], { rate: '1.53' }], [['USD', 'CAD'], { rate: '1.36' }],
      [['EUR', 'GBP'], { rate: '0.86' }], [['EUR', 'JPY'], { rate: '162.40' }],
    ]),
  fx_history: tool('Get the archived currency exchange rate as a decimal string for a pair on an ISO YYYY-MM-DD date. Use ISO currency codes.',
    ['base', 'quote', 'date'], { rate: 'string' }, [
      [['USD', 'CAD', '2021-12-01'], { rate: '1.2790' }],
      [['EUR', 'USD', '2022-01-01'], { rate: '1.1370' }],
    ]),
  local_news: tool('Get the latest local news headline for one city by its name.',
    ['city'], { headline: 'string' }, [
      [['Paris'], { headline: 'Metro expands late service' }],
      [['Lisbon'], { headline: 'Harbor ferry service resumes' }],
    ]),
}).map(([name, definition]) => [`${name}.v1`, { ...definition, path: `/${name}` }]));

const history = Array.from({ length: 24 }, (_, index) => ({
  reference: 1021 + 17 * index,
  archived: `2026-10-${String(index + 1).padStart(2, '0')}`,
  note: ['Record was included in the previous snapshot.', 'Quality check completed during scheduled maintenance.',
    'This entry was migrated from a legacy data source.'][index % 3],
}));

export async function startEvalFixture(extraTools = new Map()) {
  const byPath = new Map([...registry.values(), ...auditHttpTools.values(), ...extraTools.values()]
    .map(entry => [entry.path, entry]));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const data = request.method === 'GET' ? byPath.get(url.pathname)?.get(url.searchParams) : null;
    response.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data ? { ...data, history } : { error: 'No fixture record' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  requireThat(address, 'Fixture failed to bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
