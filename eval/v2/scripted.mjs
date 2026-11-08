// A scripted "agent" that makes the tool calls a competent agent makes for each family, through a gateway.
// Used by unit tests (no model) to exercise mining, consolidation, routing and speculation on real records.
const script = {
  'latest-order': async (call, entity) => {
    const uid = await call('retail_find_user_id_by_name_zip', { first_name: entity.first, last_name: entity.last, zip: entity.zip });
    const user = await call('retail_get_user_details', { user_id: uid });
    const order = await call('retail_get_order_details', { order_id: user.orders.at(-1) });
    return { order_id: order.order_id, status: order.status, tracking_id: order.fulfillments[0]?.tracking_id[0] ?? null };
  },
  'order-total': async (call, entity) => {
    const order = await call('retail_get_order_details', { order_id: entity.oid });
    return { item_count: order.items.length, total: Math.round(order.items.reduce((s, i) => s + i.price, 0) * 100) / 100 };
  },
  'product-availability': async (call, entity) => {
    const types = await call('retail_list_all_product_types', {});
    const id = Object.entries(types).find(([name]) => name.toLowerCase() === entity.product)[1];
    const product = await call('retail_get_product_details', { product_id: id });
    const available = product.variants.filter(v => v.available);
    return { available_variants: available.length, cheapest_available_price: Math.min(...available.map(v => v.price)) };
  },
  'account-summary': async (call, entity) => {
    const uid = await call('retail_find_user_id_by_email', { email: entity.email });
    const user = await call('retail_get_user_details', { user_id: uid });
    return { order_count: user.orders.length, city: user.address.city };
  },
  'delivered-orders': async (call, entity) => {
    const uid = await call('retail_find_user_id_by_email', { email: entity.email });
    const user = await call('retail_get_user_details', { user_id: uid });
    const list = await Promise.all(user.orders.map(order_id => call('retail_get_order_details', { order_id })));
    return { delivered_orders: list.filter(order => order.status === 'delivered').length };
  },
  'latest-reservation': async (call, entity) => {
    const user = await call('airline_get_user_details', { user_id: entity.uid });
    const r = await call('airline_get_reservation_details', { reservation_id: user.reservations.at(-1) });
    return { membership: user.membership, cabin: r.cabin, passengers: r.passengers.length };
  },
  'flight-status': async (call, entity) => {
    const f = await call('airline_get_flight_instance', { flight_number: entity.fn, date: entity.date });
    return { status: f.status };
  },
  'reservation-payment': async (call, entity) => {
    const r = await call('airline_get_reservation_details', { reservation_id: entity.rid });
    return { total_paid: Math.round(r.payment_history.reduce((s, p) => s + p.amount, 0) * 100) / 100, flight_count: r.flights.length };
  },
};

// Recover the template entity from a request (tests only; the real bench uses a model).
const patterns = {
  'latest-order': /(?:I'm|This is|Name:|name is|^)\s*([A-Z][a-z]+) ([A-Z][a-z]+)(?: here)?[^0-9]*?(\d{5})/,
  'order-total': /(#W\d+)/,
  'account-summary': /([\w.]+@[\w.]+\w)/,
  'delivered-orders': /([\w.]+@[\w.]+\w)/,
  'latest-reservation': /([a-z]+_[a-z]+_\d+)/,
  'flight-status': /(HAT\d+)\D+(\d{4}-\d{2}-\d{2})/,
  'reservation-payment': /\b([A-Z0-9]{6})\b/,
};

export function entityFromRequest(family, request, productNames) {
  const match = patterns[family]?.exec(request);
  switch (family) {
    case 'latest-order': return { first: match[1], last: match[2], zip: match[3] };
    case 'order-total': return { oid: match[1] };
    case 'account-summary':
    case 'delivered-orders': return { email: match[1] };
    case 'latest-reservation': return { uid: match[1] };
    case 'flight-status': return { fn: match[1], date: match[2] };
    case 'reservation-payment': return { rid: match[1] };
    case 'product-availability': return { product: productNames.find(name => request.toLowerCase().includes(name)) };
    default: throw new Error(`No script for ${family}`);
  }
}

export async function scriptedEpisode(harness, item, productNames) {
  const gate = harness.gateway({ request: item.request, speculate: false });
  const answer = await script[item.family](async (op, args) => {
    const result = await gate.call(op, args);
    if (result?.error) throw new Error(result.error);
    return result;
  }, entityFromRequest(item.family, item.request, productNames));
  gate.finish(answer, { success: true });
  return answer;
}
