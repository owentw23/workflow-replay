import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

export const registry = new Map(Object.entries({
  'account.v1': {
    path: '/account', args: { customer: 'string' },
    fields: { id: 'string', tier: 'string' },
  },
  'billing.v1': {
    path: '/billing', args: { id: 'string' }, fields: { overdue: 'integer' },
  },
  'support.v1': {
    path: '/support', args: { id: 'string' }, fields: { open: 'integer' },
  },
}));

const notes = Array.from({ length: 72 }, (_, index) => ({
  record: 1021 + index * 17,
  updated: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
  note: ['Follow-up pending after account review.',
    'Reviewed by finance for the monthly reporting cycle.',
    'Customer requested an updated copy of the original record.'][index % 3],
}));

export async function startFixture({ port = 0, delay = 40, verbose = true } = {}) {
  const events = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const arg = url.searchParams.get(url.pathname === '/account' ? 'customer' : 'id');
    const event = { path: url.pathname, start: performance.now() };
    events.push(event);
    await setTimeout(delay);
    const customer = url.pathname === '/account' ? arg : arg?.match(/^id:(.+)$/)?.[1];
    const profiles = new Map([
      ['alpha-demo', { tier: 'pro', overdue: 2, open: 4 }],
      ['beta-demo', { tier: 'basic', overdue: 0, open: 1 }],
      ['drift-demo', { tier: 'pro', overdue: 'unknown', open: 0 }],
    ]);
    const profile = profiles.get(customer);
    const payload = {
      '/account': () => ({ id: `id:${customer}`, tier: profile.tier }),
      '/billing': () => ({ overdue: profile.overdue }),
      '/support': () => ({ open: profile.open }),
    };
    const found = request.method === 'GET' && profile && Object.hasOwn(payload, url.pathname);
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    event.end = performance.now();
    response.end(JSON.stringify(found
      ? { ...payload[url.pathname](), ...(verbose ? { notes } : {}) }
      : { error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    events,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
