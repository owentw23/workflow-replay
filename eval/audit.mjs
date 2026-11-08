import { requireThat } from '../src/workflow.mjs';

const seeds = new Map([
  ['AUD-SEED', { count: 5, salt: 0 }],
  ['AUD-VERIFY', { count: 9, salt: 5 }],
  ...[5, 25, 100].flatMap(count => ['A', 'B'].map((suffix, index) => [
    `AUD-${count}${suffix}`, { count, salt: index + 5 },
  ])),
]);
const pageSize = 20;
const code = index => `O${String(index).padStart(3, '0')}`;
const amount = (index, salt) => 100 + 7 * index + 13 * salt;
const overdue = (index, salt) => (index + salt) % 3 === 0;
const unshipped = (index, salt) => (index + salt) % 4 < 2;

const scope = {
  description: 'Resolve an audit batch ID to its ledger key and number of pages. Pages start at 1.',
  args: { batch: 'string' }, fields: { key: 'string', pages: 'integer' }, path: '/audit_scope',
  get(params) {
    const batch = params.get('batch');
    const seed = seeds.get(batch);
    return seed && { key: `ledger-${batch}`, pages: Math.ceil(seed.count / pageSize) };
  },
};

function pageTool(description, fields, project, path) {
  return {
    description, fields, path, args: { key: 'string', page: 'string' },
    get(params) {
      const key = params.get('key');
      const seed = key?.startsWith('ledger-') && seeds.get(key.slice(7));
      const page = Number(params.get('page'));
      if (!seed || !Number.isSafeInteger(page) || page < 1 || page > Math.ceil(seed.count / pageSize)) return;
      const offset = (page - 1) * pageSize;
      const indices = Array.from({ length: Math.min(pageSize, seed.count - offset) }, (_, index) => offset + index + 1);
      return project(indices, seed.salt);
    },
  };
}

export const auditHttpTools = new Map([
  ['audit_scope.v1', scope],
  ['audit_ledger.v1', pageTool('Read one ledger page by key and page number as a string. Amounts are order-id:cents entries separated by commas. Overdue is a comma-separated list of order IDs past deadline, or "-" if empty.',
    { amounts: 'string', overdue: 'string' }, (ids, salt) => ({
      amounts: ids.map(index => `${code(index)}:${amount(index, salt)}`).join(','),
      overdue: ids.filter(index => overdue(index, salt)).map(code).join(',') || '-',
    }), '/audit_ledger')],
  ['audit_carrier.v1', pageTool('Read one carrier page by key and page number as a string. Unshipped is a comma-separated list of unshipped order IDs, or "-" if empty.',
    { unshipped: 'string' }, (ids, salt) => ({
      unshipped: ids.filter(index => unshipped(index, salt)).map(code).join(',') || '-',
    }), '/audit_carrier')],
]);

export const auditCollect = {
  args: { key: 'string', pages: 'integer' },
  fields: { count: 'integer', 'total-cents': 'integer', 'exception-ids': 'string' },
};

function idSet(list, amounts) {
  const ids = list === '-' ? [] : list.split(',');
  const set = new Set(ids);
  requireThat(set.size === ids.length && ids.every(id => amounts.has(id)), 'Invalid audit page IDs');
  return set;
}

export function withAuditCollector(http) {
  return async (op, args, signal) => {
    if (op !== 'audit_collect.v1') return http(op, args, signal);
    requireThat(Number.isSafeInteger(args.pages) && args.pages >= 1 && args.pages <= 5, 'Invalid audit page count');
    const seen = new Set();
    const exceptions = [];
    let cents = 0;
    // Process at most two pages (four HTTP reads) per wave. Never expose the rows to the model.
    for (let first = 1; first <= args.pages; first += 2) {
      const pages = Array.from({ length: Math.min(2, args.pages - first + 1) }, (_, index) => String(first + index));
      const requests = pages.flatMap(page => ['audit_ledger.v1', 'audit_carrier.v1']
        .map(readOp => http(readOp, { key: args.key, page }, signal)));
      const responses = await Promise.allSettled(requests);
      for (const response of responses) {
        if (response.status === 'rejected') throw response.reason;
      }
      for (const [index] of pages.entries()) {
        const ledger = responses[2 * index].value.data;
        const carrier = responses[2 * index + 1].value.data;
        const amounts = new Map();
        for (const row of ledger.amounts.split(',')) {
          const match = /^(O\d{3}):([0-9]{1,8})$/.exec(row);
          requireThat(match && !seen.has(match[1]), 'Invalid or repeated ledger order');
          seen.add(match[1]);
          amounts.set(match[1], Number(match[2]));
        }
        const overdue = idSet(ledger.overdue, amounts);
        const unshipped = idSet(carrier.unshipped, amounts);
        for (const id of overdue) {
          if (unshipped.has(id)) {
            exceptions.push(id);
            cents += amounts.get(id);
          }
        }
      }
    }
    const data = { count: exceptions.length, 'total-cents': cents, 'exception-ids': exceptions.sort().join(',') || '-' };
    return { data, raw: data };
  };
}

function auditCase(prompt, expected, size, id) {
  return {
    id, family: 'shipment-audit', source: 'Synthetic multi-page reconciliation workload',
    expectedRoute: 'shipment-audit', size, expected,
    prompt: prompt + '\nAn exception is an order that is both overdue and unshipped. '
      + 'Return only JSON: count (number), total-cents (sum of exception order amounts, number), '
      + 'exception-ids (order IDs sorted and comma-separated without spaces, or "-" if empty).',
  };
}

const cases = [
  [5, 'A', 1, 193, 'O004'],
  [5, 'B', 1, 199, 'O003'],
  [25, 'A', 4, 982, 'O004,O007,O016,O019'],
  [25, 'B', 4, 1006, 'O003,O006,O015,O018'],
  [100, 'A', 17, 8825, 'O004,O007,O016,O019,O028,O031,O040,O043,O052,O055,O064,O067,O076,O079,O088,O091,O100'],
  [100, 'B', 17, 8927, 'O003,O006,O015,O018,O027,O030,O039,O042,O051,O054,O063,O066,O075,O078,O087,O090,O099'],
];

export const auditCases = cases.map(([size, variant, count, total, ids]) => {
  const batch = `AUD-${size}${variant}`;
  const prompt = variant === 'A' ? `Run the overdue shipment audit for batch ${batch}.`
    : `Could you reconcile the carrier and order ledger for batch ${batch} and report the overdue shipment exceptions?`;
  return auditCase(prompt, { count, 'total-cents': total, 'exception-ids': ids }, size, `audit-${size}-${variant.toLowerCase()}`);
});
export const auditSeed = auditCase('Run the overdue shipment audit for batch AUD-SEED.',
  { count: 0, 'total-cents': 0, 'exception-ids': '-' }, 5, 'audit-seed');
export const auditDescription = 'Reconcile overdue shipment audit exceptions across order ledger and carrier pages by batch';
