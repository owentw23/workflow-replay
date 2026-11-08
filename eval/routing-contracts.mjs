import { parseRequest } from '../src/local-routing.mjs';

// These examples describe supported requests. They are separate from the scored suite.
export const requestExamples = {
  'airline-passengers': [
    'How many people are on my newest booking?',
    'Headcount for the last trip I booked',
    'Find the number of passengers on a traveler’s latest reservation',
  ],
  'airline-baggage': [
    'How many suitcases can I put in the hold without a fee?',
    'Complimentary checked pieces per passenger for a booking',
    'Find my personal luggage allowance for this confirmation',
  ],
  'retail-tracking': [
    'Find the carrier reference and delivery state for my newest purchase',
    'Parcel tracking and shipment status for the last order on my profile',
  ],
  'weather-pair': [
    'Compare the current thermometer readings in Celsius for two cities',
    'Report present-day air temperature in degrees C for two stops',
  ],
  'fx-pair': [
    'Price one unit of the base currency in two quote currencies',
    'Find today’s FX quotes for two pairs with a shared base',
  ],
  'historical-fx': [
    'Look up an archived conversion quote for one currency pair on a date',
    'Get the past FX rate as of a specified day',
  ],
  'shipment-audit': [
    'Flag orders still unshipped after their ship-by deadline in a batch',
    'Reconcile warehouse orders past deadline and not dispatched',
  ],
};

const searchAliases = [
  [/\b(?:headcounts?|people|travelers on)\b/gi, 'passenger count'],
  [/\b(?:newest booking|last booking|most recent trip|latest itinerary)\b/gi, 'latest reservation'],
  [/\b(?:suitcases|cases for the hold|checked pieces|luggage|hold bags)\b/gi, 'checked baggage'],
  [/\b(?:carrier reference|parcel code|delivery reference)\b/gi, 'shipment tracking'],
  [/\b(?:purchase|parcel|postal code)\b/gi, 'order shipment zip'],
  [/\b(?:thermometer|degrees c|celsius readings?)\b/gi, 'weather temperature celsius'],
  [/\b(?:fx|currency quote|conversion quote)\b/gi, 'currency exchange rates'],
  [/\b(?:archived|past quote|as of)\b/gi, 'historical date'],
  [/\b(?:past deadline|ship-by|not dispatched|still unshipped)\b/gi, 'overdue unshipped shipment audit'],
];

export function expandRequest(request) {
  return searchAliases.reduce((text, [pattern, canonical]) => text.replace(pattern, canonical), request);
}

// These patterns allow complete supported requests. Search expansion is absent
// here, so synonyms used in retrieval cannot discard constraints before replay.
function contract(source, bind) {
  const pattern = new RegExp('^(?:please )?' + source + '[?.!]?$', 'iu');
  return request => {
    const groups = parseRequest(pattern, request);
    return groups && bind(groups);
  };
}

const traveler = /(?<traveler>trav-[a-z]+)/.source;
const reservation = /(?<reservation>r[0-9][a-z][0-9])/.source;
const retailIdentity = /(?<name>\p{L}{2,24} \p{L}{2,24})(?:,)? (?:zip|postal code) (?<zip>\d{5})/u.source;
const city = '(?:Boston|San Francisco|Seattle|Portland|Austin|Miami|Paris|Lisbon|Letterkenny|Cork)';
const currency = '(?:USD|AUD|CAD|EUR|GBP|CHF|JPY)';
const latest = '(?:latest|newest|most recent|last)';
const booking = '(?:booking|reservation|itinerary)';
const headcount = '(?:passenger count|headcount|number of people)';
const batch = /(?<batch>AUD-\d{1,3}[A-Z])/.source;
const dateInput = /(?<date>\d{4}-\d{2}-\d{2})/.source;
const lower = text => text.toLowerCase();
const upper = text => text.toUpperCase();
const title = text => text.toLowerCase().replace(/(^| )\p{L}/gu, start => start.toUpperCase());
const prefix = '(?:(?:get|check|find|show me|look up|report) (?:the )?)?';

export const contracts = new Map([
  ['airline-passengers', contract(
    prefix + headcount + ' (?:on|for) (?:the )?' + latest + ' ' + booking + ' for (?:traveler )?' + traveler,
    ({ traveler }) => ({ traveler: lower(traveler) }),
  )],
  ['airline-baggage', contract(
    prefix + '(?:free checked bags|personal baggage allowance|complimentary hold bags|checked suitcase limit)'
      + ' for (?:traveler )?' + traveler + ' (?:on|for) (?:confirmation |booking |reservation )?' + reservation,
    ({ traveler, reservation }) => ({ traveler: lower(traveler), reservation: upper(reservation) }),
  )],
  ['retail-tracking', contract(
    prefix + '(?:tracking and status|carrier reference and delivery state|parcel code and shipment status)'
      + ' for (?:the )?' + latest + ' (?:order|purchase) (?:for|from) ' + retailIdentity,
    ({ name, zip }) => ({ name: title(name), zip }),
  )],
  ['weather-pair', contract(
    prefix + '(?:current temperatures|present air temperatures|thermometer readings) (?:in|for) (?<first>' + city + ')'
      + ' (?:and|then) (?<second>' + city + ') in (?:celsius|°c|degrees c)',
    ({ first, second }) => lower(first) === lower(second) ? undefined : { first: title(first), second: title(second) },
  )],
  ['fx-pair', contract(
    prefix + '(?:current exchange rates|today’s fx quotes|current conversion quotes) from (?<base>' + currency + ')'
      + ' (?:to|into) (?<first>' + currency + ') (?:and|then) (?<second>' + currency + ')',
    ({ base, first, second }) => {
      const normalized = [base, first, second].map(upper);
      if (new Set(normalized).size === 3) return { base: normalized[0], first: normalized[1], second: normalized[2] };
    },
  )],
  ['historical-fx', contract(
    prefix + '(?:historical exchange rate|archived currency quote|past fx rate) from (?<base>' + currency + ')'
      + ' to (?<quote>' + currency + ') (?:on|as of) ' + dateInput,
    ({ base, quote, date }) => {
      const timestamp = new Date(date);
      if (upper(base) !== upper(quote) && Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === date) {
        return { base: upper(base), quote: upper(quote), date };
      }
    },
  )],
  ['shipment-audit', contract(
    '(?:run the overdue shipment audit|report the overdue unshipped orders|flag orders past deadline and still unshipped'
      + '|reconcile the overdue shipment exceptions) (?:for|in) batch ' + batch,
    ({ batch }) => ({ batch: upper(batch) }),
  )],
]);
