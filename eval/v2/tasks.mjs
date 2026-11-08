// Task set for the v2 test bench. Entities are real τ²-bench records; gold answers are computed from the database.
// Intents follow the information-gathering parts of τ²-bench retail and airline tasks (order status and tracking,
// order contents, product variants, account details, reservation details, flight status). Phrasings are authored;
// training, shadow and test use disjoint entities, and test phrasings differ from training phrasings except for
// the "exact-form" items, which reuse a training wording with a new entity.
import { round2 } from '../../src/v2/util.mjs';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function sampler(items, random) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let cursor = 0;
  return count => {
    if (cursor + count > pool.length) throw new Error('Entity pool exhausted');
    const slice = pool.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  };
}

const fill = (template, entity) => template.replace(/\{(\w+)\}/g, (_, key) => entity[key]);

export function buildTasks(data, { seed = 20261109 } = {}) {
  const { retail, airline } = data;
  const random = rng(seed);
  const users = Object.values(retail.users);
  const orders = retail.orders;
  const lastOrder = user => orders[user.orders.at(-1)];
  const trackOf = order => order?.fulfillments?.[0]?.tracking_id?.[0] ?? null;
  const name = user => ({ first: user.name.first_name, last: user.name.last_name, zip: user.address.zip });
  const uniqueNameZip = user => users.filter(other => other.name.first_name === user.name.first_name
    && other.name.last_name === user.name.last_name && other.address.zip === user.address.zip).length === 1;

  const families = [];

  // R1 latest order status and tracking (τ²-bench retail: "where is my most recent order").
  const r1Normal = users.filter(user => uniqueNameZip(user) && lastOrder(user)?.fulfillments.length === 1
    && lastOrder(user).fulfillments[0].tracking_id.length === 1);
  const r1Pending = users.filter(user => uniqueNameZip(user) && lastOrder(user)?.status === 'pending' && !lastOrder(user).fulfillments.length);
  const r1First = users.filter(user => uniqueNameZip(user) && user.orders.length >= 2
    && orders[user.orders[0]].fulfillments.length === 1 && user.orders[0] !== user.orders.at(-1));
  families.push({
    id: 'latest-order', domain: 'retail', keys: ['order_id', 'status', 'tracking_id'],
    pool: r1Normal, entity: user => name(user),
    gold: user => ({ order_id: lastOrder(user).order_id, status: lastOrder(user).status, tracking_id: trackOf(lastOrder(user)) }),
    train: ["Hi, I'm {first} {last}, zip {zip}. What's the status of my most recent order and its tracking number?",
      '{first} {last} here (ZIP {zip}). Can you check my latest order: its order id, status and tracking ID?',
      'My name is {first} {last} and my zip code is {zip}. Where is my last order? I need the order number, status and tracking number.'],
    test: ['This is {first} {last}, postal code {zip}. Could you look up the newest order on my account: what is it, what state is it in, and is there a tracking number?',
      'I placed an order recently. Name: {first} {last}, zip {zip}. Order id, status and tracking for the most recent one please.'],
    nearMiss: { pool: r1First, keys: ['order_id', 'status', 'tracking_id'],
      text: "I'm {first} {last}, zip {zip}. What's the order id, status and tracking number of the very first order I ever placed?",
      gold: user => { const o = orders[user.orders[0]]; return { order_id: o.order_id, status: o.status, tracking_id: trackOf(o) }; } },
    outliers: { pool: r1Pending },
  });

  // R2 order contents and total.
  const multiItem = Object.values(orders).filter(order => order.items.length >= 2);
  families.push({
    id: 'order-total', domain: 'retail', keys: ['item_count', 'total'],
    pool: multiItem, entity: order => ({ oid: order.order_id }),
    gold: order => ({ item_count: order.items.length, total: round2(order.items.reduce((s, i) => s + i.price, 0)) }),
    train: ['How much did order {oid} cost in total, and how many items were in it?',
      'For order {oid}: number of items and the total price?',
      'Can you tell me the item count and total amount for my order {oid}?'],
    test: ["I'm reviewing order {oid}. What was the sum of the item prices, and how many items did it contain?",
      'Order number {oid}: total cost and item count please.'],
    nearMiss: { pool: multiItem, keys: ['max_price'], text: 'For order {oid}, what is the price of the most expensive item?',
      gold: order => ({ max_price: Math.max(...order.items.map(i => i.price)) }) },
  });

  // R3 product variant availability.
  const products = Object.values(retail.products).filter(p => Object.values(p.variants).some(v => v.available));
  families.push({
    id: 'product-availability', domain: 'retail', keys: ['available_variants', 'cheapest_available_price'],
    pool: products, entity: product => ({ product: product.name.toLowerCase() }),
    gold: product => {
      const available = Object.values(product.variants).filter(v => v.available);
      return { available_variants: available.length, cheapest_available_price: Math.min(...available.map(v => v.price)) };
    },
    train: ["How many {product} variants are currently available, and what's the cheapest available price?",
      'For the {product}, how many options are in stock and the lowest price among them?',
      "I'm shopping for a {product}. How many variants can I buy right now, and the lowest available price?"],
    test: ['Which {product} options are in stock? Just give me how many there are and the lowest price among those.',
      'Count the available variants of the {product} and tell me the minimum available price.'],
    nearMiss: { pool: products.filter(p => Object.values(p.variants).some(v => !v.available)), keys: ['unavailable_variants'],
      text: 'How many {product} variants are unavailable right now?',
      gold: product => ({ unavailable_variants: Object.values(product.variants).filter(v => !v.available).length }) },
  });

  // R4 account summary by email.
  const emailUsers = users.filter(user => users.filter(other => other.email === user.email).length === 1);
  families.push({
    id: 'account-summary', domain: 'retail', keys: ['order_count', 'city'],
    pool: emailUsers, entity: user => ({ email: user.email }),
    gold: user => ({ order_count: user.orders.length, city: user.address.city }),
    train: ['My email is {email}. How many orders do I have, and what city is my address in?',
      'Look up the account with email {email}: number of orders and city.',
      'Using my email {email}, tell me my total order count and my city.'],
    test: ["Account email {email}: please tell me which city you have on file and how many orders I've placed.",
      "I'd like a quick summary for {email}: city on file and number of orders."],
    nearMiss: { pool: emailUsers, keys: ['zip'], text: "My email is {email}. What's the zip code on my account?",
      gold: user => ({ zip: user.address.zip }) },
  });

  // R5 delivered orders: needs one get_order call per order (a loop), then a filtered count.
  const loopUsers = emailUsers.filter(user => user.orders.length >= 2 && user.orders.length <= 5);
  const delivered = user => user.orders.filter(id => orders[id].status === 'delivered').length;
  families.push({
    id: 'delivered-orders', domain: 'retail', keys: ['delivered_orders'],
    pool: loopUsers, entity: user => ({ email: user.email }),
    gold: user => ({ delivered_orders: delivered(user) }),
    train: ['My email is {email}. How many of my orders have been delivered?',
      'Using the account {email}, count how many orders were delivered.',
      'For {email}: number of delivered orders?'],
    test: ["I'm the customer with email {email}. Of all my orders, how many show as delivered?",
      'How many delivered orders does {email} have?'],
    nearMiss: { pool: loopUsers, keys: ['pending_orders'], text: 'My email is {email}. How many of my orders are still pending?',
      gold: user => ({ pending_orders: user.orders.filter(id => orders[id].status === 'pending').length }) },
  });

  // A1 membership and latest reservation (τ²-bench airline: verify a booking's cabin and headcount).
  const airUsers = Object.values(airline.users).filter(user => user.reservations.length >= 1
    && airline.reservations[user.reservations.at(-1)]);
  const latestRes = user => airline.reservations[user.reservations.at(-1)];
  families.push({
    id: 'latest-reservation', domain: 'airline', keys: ['membership', 'cabin', 'passengers'],
    pool: airUsers, entity: user => ({ uid: user.user_id }),
    gold: user => ({ membership: user.membership, cabin: latestRes(user).cabin, passengers: latestRes(user).passengers.length }),
    train: ["I'm user {uid}. What's my membership level, and for my latest reservation, which cabin and how many passengers?",
      'User ID {uid}: membership tier plus the cabin class and passenger count of my most recent booking.',
      "Can you check user {uid}'s membership and the cabin and number of passengers on their newest reservation?"],
    test: ['My user id is {uid}. Please confirm my membership status, and on the most recent reservation, the cabin and how many people are travelling.',
      'For {uid}, I need membership, cabin and passenger count for the last reservation.'],
    nearMiss: { pool: airUsers, keys: ['reservation_count'], text: "I'm user {uid}. How many reservations do I have in total?",
      gold: user => ({ reservation_count: user.reservations.length }) },
  });

  // A2 flight status on a date (τ²-bench airline get_flight_status).
  const instances = Object.values(airline.flights).flatMap(flight => Object.entries(flight.dates)
    .map(([date, day]) => ({ fn: flight.flight_number, date, day })));
  const statusPool = date => instances.filter(item => item.date === date);
  families.push({
    id: 'flight-status', domain: 'airline', keys: ['status'],
    pool: instances.filter(item => !['2024-05-10', '2024-05-12'].includes(item.date)),
    batchPools: [statusPool('2024-05-10'), statusPool('2024-05-12')],
    entity: item => ({ fn: item.fn, date: item.date }),
    gold: item => ({ status: item.day.status }),
    train: ["What's the status of flight {fn} on {date}?",
      'Was flight {fn} on {date} on time, landed, delayed or cancelled? Give the status.',
      'Check flight {fn} for {date} and tell me its status.'],
    test: ['Can you tell me how flight {fn} did on {date}? Just the status.', 'Status for {fn}, {date}?'],
    nearMiss: { pool: instances.filter(item => item.day.status === 'landed' && item.date !== '2024-05-10' && item.date !== '2024-05-12'),
      keys: ['actual_departure'], text: 'What was the actual departure time of flight {fn} on {date}?',
      gold: item => ({ actual_departure: item.day.actual_departure_time_est ?? null }) },
  });

  // A3 reservation payments.
  const reservations = Object.values(airline.reservations).filter(r => r.payment_history.length >= 1);
  families.push({
    id: 'reservation-payment', domain: 'airline', keys: ['total_paid', 'flight_count'],
    pool: reservations, entity: r => ({ rid: r.reservation_id }),
    gold: r => ({ total_paid: round2(r.payment_history.reduce((s, p) => s + p.amount, 0)), flight_count: r.flights.length }),
    train: ['How much was paid in total for reservation {rid}, and how many flight segments does it have?',
      'Reservation {rid}: total payments and number of flights?',
      'For booking {rid}, tell me the total amount paid and the number of flights.'],
    test: ["I want to double-check reservation {rid}: what's the sum of all payments, and how many flights are on it?",
      'Total paid and flight count for confirmation {rid}, please.'],
    nearMiss: { pool: reservations, keys: ['cabin'], text: 'For reservation {rid}, what cabin class is it?',
      gold: r => ({ cabin: r.cabin }) },
  });

  // ---- Build splits with disjoint entities ----
  const learning = { batches: [[], []], shadow: [] };
  const test = [];
  for (const family of families) {
    const take = sampler(family.pool, random);
    const item = (entity, text, extra = {}) => ({
      family: family.id, request: fill(text, family.entity(entity)), keys: family.keys, gold: family.gold(entity), ...extra,
    });
    // Flight status trains on one date per batch, so the miner first sees the date as a constant (coincidence),
    // and consolidation has to merge the two plans into one with a date placeholder.
    const batchTakes = family.batchPools?.map(pool => sampler(pool, random));
    for (const [batch, list] of learning.batches.entries()) {
      const entities = batchTakes ? batchTakes[batch](3) : take(3);
      entities.forEach((entity, i) => list.push(item(entity, family.train[i], { split: `learn-${batch + 1}` })));
    }
    const shadowEntities = batchTakes ? [...batchTakes[0](2), ...batchTakes[1](1)] : take(3);
    shadowEntities.forEach((entity, i) => learning.shadow.push(item(entity, family.train[i], { split: 'shadow' })));
    const testEntities = take(5);
    testEntities.slice(0, 4).forEach((entity, i) => test.push(item(entity, family.test[i % 2], { kind: 'repeat-paraphrase', expectedHit: true })));
    test.push(item(testEntities[4], family.train[1], { kind: 'repeat-exact-form', expectedHit: true }));
    const near = sampler(family.nearMiss.pool, random)(2);
    for (const entity of near) {
      test.push({ family: family.id, kind: 'near-miss', expectedHit: false, keys: family.nearMiss.keys,
        request: fill(family.nearMiss.text, family.entity(entity)), gold: family.nearMiss.gold(entity) });
    }
    if (family.outliers) {
      for (const entity of sampler(family.outliers.pool, random)(3)) {
        test.push(item(entity, family.test[1], { kind: 'outlier', expectedHit: true }));
      }
    }
  }

  // Novel tasks: never seen in learning.
  const typeCount = Object.keys(retail.products).length;
  test.push({ family: 'novel', kind: 'novel', expectedHit: false, keys: ['product_types'],
    request: 'How many different product types does the store sell?', gold: { product_types: typeCount } });
  test.push({ family: 'novel', kind: 'novel', expectedHit: false, keys: ['product_types'],
    request: 'Count the distinct kinds of products in the catalog for me.', gold: { product_types: typeCount } });
  const takeAir = sampler(airUsers, random);
  for (const user of takeAir(2)) {
    test.push({ family: 'novel', kind: 'novel', expectedHit: false, keys: ['saved_passengers'],
      request: `For airline user ${user.user_id}, how many saved passengers are on the profile?`,
      gold: { saved_passengers: user.saved_passengers.length } });
  }
  const takeR1 = sampler(r1Normal, random);
  const takeProduct = sampler(products, random);
  for (const user of takeR1(2)) {
    const product = takeProduct(1)[0];
    const available = Object.values(product.variants).filter(v => v.available).length;
    test.push({ family: 'novel', kind: 'compound', expectedHit: false, keys: ['status', 'available_variants'],
      request: `I'm ${user.name.first_name} ${user.name.last_name}, zip ${user.address.zip}. What's the status of my most recent order, and how many ${product.name.toLowerCase()} variants are available?`,
      gold: { status: lastOrder(user).status, available_variants: available } });
  }

  // Follow-ups: two turns; the second refers to the first answer.
  for (const user of takeR1(2)) {
    const order = lastOrder(user);
    test.push({ family: 'latest-order', kind: 'follow-up', expectedHit: true, turns: [
      { request: `This is ${user.name.first_name} ${user.name.last_name}, postal code ${user.address.zip}. Could you look up the newest order on my account: what is it, what state is it in, and is there a tracking number?`,
        keys: ['order_id', 'status', 'tracking_id'], gold: { order_id: order.order_id, status: order.status, tracking_id: trackOf(order) } },
      { request: 'For that order, how many items were in it and what was the total?', keys: ['item_count', 'total'],
        gold: { item_count: order.items.length, total: round2(order.items.reduce((s, i) => s + i.price, 0)) } },
    ] });
  }
  for (const user of takeAir(2)) {
    const r = latestRes(user);
    test.push({ family: 'latest-reservation', kind: 'follow-up', expectedHit: true, turns: [
      { request: `My user id is ${user.user_id}. Please confirm my membership status, and on the most recent reservation, the cabin and how many people are travelling.`,
        keys: ['membership', 'cabin', 'passengers'], gold: { membership: user.membership, cabin: r.cabin, passengers: r.passengers.length } },
      { request: 'How much was paid in total for that latest reservation, and how many flights does it have?', keys: ['total_paid', 'flight_count'],
        gold: { total_paid: round2(r.payment_history.reduce((s, p) => s + p.amount, 0)), flight_count: r.flights.length } },
    ] });
  }
  test.forEach((item, index) => { item.id = `t${String(index + 1).padStart(3, '0')}-${item.family}-${item.kind}`; });
  return { learning, test, families: families.map(f => f.id) };
}
