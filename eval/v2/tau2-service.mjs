// Read-only tools over the public τ²-bench retail and airline databases (MIT, sierra-research/tau2-bench,
// commit 033bf082). Tool names and payloads follow τ²-bench; names are prefixed by domain so one agent can
// use both systems. `raw` returns the full record, as the τ²-bench tools do; `project` trims it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const COMMIT = '033bf082f48e4a3c6a1256208e93cf2ce9c3bb6f';
export const SOURCES = {
  'retail-db.json': { url: `https://raw.githubusercontent.com/sierra-research/tau2-bench/${COMMIT}/data/tau2/domains/retail/db.json`,
    sha256: '413a65160adbdb5fde0ffc0015c49b6d70250b10c18128de169b597af7766765' },
  'airline-db.json': { url: `https://raw.githubusercontent.com/sierra-research/tau2-bench/${COMMIT}/data/tau2/domains/airline/db.json`,
    sha256: '1af9fea6e03ca7ca15a22bb3fcaf3e351393e3fc9070b6777947da8996f7531b' },
};

export function loadData(directory = new URL('./data/tau2/', import.meta.url)) {
  const read = name => {
    const bytes = readFileSync(new URL(name, directory));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== SOURCES[name].sha256) throw new Error(`${name} does not match the pinned τ²-bench file. Run eval/v2/fetch-data.mjs`);
    return JSON.parse(bytes.toString('utf8'));
  };
  return { retail: read('retail-db.json'), airline: read('airline-db.json') };
}

export const registry = new Map([
  ['retail_find_user_id_by_name_zip', { description: 'Retail: find a customer user id by first name, last name and zip code.',
    args: { first_name: 'string', last_name: 'string', zip: 'string' } }],
  ['retail_find_user_id_by_email', { description: 'Retail: find a customer user id by email address.', args: { email: 'string' } }],
  ['retail_get_user_details', { description: 'Retail: get a customer profile, including address and order ids (oldest to newest).',
    args: { user_id: 'string' } }],
  ['retail_get_order_details', { description: 'Retail: get an order: status, items with prices, fulfillments with tracking ids, payments.',
    args: { order_id: 'string' } }],
  ['retail_list_all_product_types', { description: 'Retail: list all product types as a map from product name to product id.', args: {} }],
  ['retail_get_product_details', { description: 'Retail: get a product and its variants (options, availability, price).',
    args: { product_id: 'string' } }],
  ['airline_get_user_details', { description: 'Airline: get a user profile, including membership level, saved passengers and reservation ids (oldest to newest).',
    args: { user_id: 'string' } }],
  ['airline_get_reservation_details', { description: 'Airline: get a reservation: cabin, flights, passengers, payments.',
    args: { reservation_id: 'string' } }],
  ['airline_get_flight_instance', { description: 'Airline: get one flight on one date (YYYY-MM-DD): route, status and actual times.',
    args: { flight_number: 'string', date: 'string' } }],
]);

export function createService(data) {
  const { retail, airline } = data;
  const fail = message => { throw new Error(message); };
  const lower = value => String(value ?? '').trim().toLowerCase();
  const handlers = {
    retail_find_user_id_by_name_zip: ({ first_name, last_name, zip }) => Object.values(retail.users).find(user =>
      lower(user.name.first_name) === lower(first_name) && lower(user.name.last_name) === lower(last_name)
      && user.address.zip === String(zip).trim())?.user_id ?? fail('User not found'),
    retail_find_user_id_by_email: ({ email }) => Object.values(retail.users)
      .find(user => lower(user.email) === lower(email))?.user_id ?? fail('User not found'),
    retail_get_user_details: ({ user_id }) => retail.users[user_id] ?? fail('User not found'),
    retail_get_order_details: ({ order_id }) => {
      const id = String(order_id).trim().startsWith('#') ? String(order_id).trim() : `#${String(order_id).trim()}`;
      return retail.orders[id] ?? fail('Order not found');
    },
    retail_list_all_product_types: () => Object.fromEntries(Object.values(retail.products)
      .map(product => [product.name, product.product_id]).sort(([a], [b]) => (a < b ? -1 : 1))),
    retail_get_product_details: ({ product_id }) => retail.products[product_id] ?? fail('Product not found'),
    airline_get_user_details: ({ user_id }) => airline.users[user_id] ?? fail('User not found'),
    airline_get_reservation_details: ({ reservation_id }) => airline.reservations[String(reservation_id).trim()] ?? fail('Reservation not found'),
    airline_get_flight_instance: ({ flight_number, date }) => {
      const flight = airline.flights[String(flight_number).trim().toUpperCase()] ?? fail('Flight not found');
      const day = flight.dates[String(date).trim()] ?? fail('Flight does not operate on that date');
      return { flight_number: flight.flight_number, date: String(date).trim(), origin: flight.origin, destination: flight.destination,
        scheduled_departure_time_est: flight.scheduled_departure_time_est, scheduled_arrival_time_est: flight.scheduled_arrival_time_est,
        ...day };
    },
  };
  return async (op, args) => {
    const handler = handlers[op];
    if (!handler) throw new Error('Unknown tool');
    return structuredClone(handler(args ?? {}));
  };
}

// Gateway projection: keep the fields agents use, drop payment instruments, addresses and other noise.
export function project(op, raw) {
  if (raw === null || typeof raw !== 'object') return raw;
  switch (op) {
    case 'retail_get_user_details':
      return { user_id: raw.user_id, name: raw.name, email: raw.email,
        address: { city: raw.address.city, state: raw.address.state, zip: raw.address.zip }, orders: raw.orders };
    case 'retail_get_order_details':
      return { order_id: raw.order_id, user_id: raw.user_id, status: raw.status,
        items: raw.items.map(item => ({ name: item.name, product_id: item.product_id, item_id: item.item_id, price: item.price })),
        fulfillments: raw.fulfillments.map(entry => ({ tracking_id: entry.tracking_id })),
        payment_history: raw.payment_history.map(entry => ({ transaction_type: entry.transaction_type, amount: entry.amount })) };
    case 'retail_get_product_details':
      return { name: raw.name, product_id: raw.product_id, variants: Object.values(raw.variants)
        .map(variant => ({ item_id: variant.item_id, options: variant.options, available: variant.available, price: variant.price })) };
    case 'airline_get_user_details':
      return { user_id: raw.user_id, name: raw.name, membership: raw.membership,
        saved_passengers: raw.saved_passengers.map(p => ({ first_name: p.first_name, last_name: p.last_name })),
        reservations: raw.reservations };
    case 'airline_get_reservation_details':
      return { reservation_id: raw.reservation_id, user_id: raw.user_id, origin: raw.origin, destination: raw.destination,
        flight_type: raw.flight_type, cabin: raw.cabin,
        flights: raw.flights.map(f => ({ flight_number: f.flight_number, date: f.date, origin: f.origin, destination: f.destination, price: f.price })),
        passengers: raw.passengers.map(p => ({ first_name: p.first_name, last_name: p.last_name })),
        payment_history: raw.payment_history.map(entry => ({ amount: entry.amount })), total_baggages: raw.total_baggages };
    case 'airline_get_flight_instance':
      return { flight_number: raw.flight_number, date: raw.date, status: raw.status,
        actual_departure_time_est: raw.actual_departure_time_est ?? null, actual_arrival_time_est: raw.actual_arrival_time_est ?? null };
    default:
      return raw;
  }
}
