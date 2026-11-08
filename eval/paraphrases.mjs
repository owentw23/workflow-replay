import { auditCases } from './audit.mjs';
import { cases } from './tasks.mjs';

// Published prompt IDs and pinned dataset revisions are recorded in README.md.
// Gold responses and tool records use synthetic fixtures in every group.
const published = (source, text) => ({ source, text, origin: 'published' });
const adapted = (source, text) => ({ source, text, origin: 'adapted' });
const synthetic = text => ({ text, origin: 'synthetic' });

export const historicalFxFamily = {
  id: 'historical-fx',
  saved: {
    description: 'Historical currency exchange conversion rate for one currency pair on a specified date',
    seed: { base: 'USD', quote: 'CAD', date: '2021-12-01' },
    spec: {
      version: 1, inputs: { base: 'string', quote: 'string', date: 'string' },
      steps: [{ id: 'quote', op: 'fx_history.v1', args: {
        base: { input: 'base' }, quote: { input: 'quote' }, date: { input: 'date' },
      } }],
      output: { rate: { step: 'quote', field: 'rate' } },
    },
  },
};

function group(id, wording, { groupId = id, source, expected, contract } = {}) {
  const template = [...cases, ...auditCases].find(item => item.id === id);
  const [ , templateContract ] = template?.prompt.split('\n') ?? [];
  return wording.map((variant, index) => ({
    ...template, id: `wording-${groupId}-${index + 1}`, group: groupId, variant: index + 1,
    family: template?.family ?? groupId, expectedRoute: template ? template.expectedRoute : groupId,
    source: variant.source ?? source ?? template.source, origin: variant.origin,
    expected: expected ?? template.expected, prompt: variant.text + '\n' + (contract ?? templateContract),
  }));
}

export const paraphraseCases = [
  ...group('weather-pair-1', [
    published('BFCL live_parallel_1-0-1', 'Could you tell me the current weather conditions for Boston, MA and also for San Francisco?'),
    synthetic('I’m packing for both coasts. Before I choose what to bring, check the thermometer in Boston first, then San Francisco. Give me Celsius readings.'),
    synthetic('Boston → San Francisco. Need one up-to-date air temperature for each stop, in °C and in itinerary order.'),
    synthetic('Populate two observation slots with the latest Celsius measurement. Slot one belongs to Boston and slot two to San Francisco.'),
  ], { groupId: 'weather-pair',
    contract: 'Return exactly first-temp and second-temp as JSON numbers, the current Celsius air temperatures in the requested city order.' }),
  ...group('fx-pair-1', [
    published('BFCL parallel_58', 'Get me the currency exchange rates of the following pairs: USD to AUD and USD to CAD?'),
    synthetic('I’m budgeting a trip. For one US dollar, what would I get in Australian dollars, then in Canadian dollars? Keep the exact quoted decimal strings.'),
    synthetic('Price one USD in AUD and CAD, respectively. Copy each quote as text.'),
    synthetic('Fill two rate slots from the same US-dollar base. The Australian currency goes in slot one and the Canadian currency goes in slot two. Preserve the quoted strings.'),
  ], { groupId: 'fx-pair' }),
  ...group('historical-fx', [
    published('IBM BFCL-FC-Robustness multiple_17 original', 'Find the conversion rate from Euro to Dollar at January 1, 2022'),
    published('IBM BFCL-FC-Robustness multiple_17 paraphrase', 'At what exchange rate could Euros be converted into Dollars on January 1st, 2022?'),
    synthetic('I’m reconciling a New Year’s Day 2022 receipt. How many US dollars was one euro worth on that date? Give me the recorded quote as text.'),
    synthetic('Use the archived quote for 2022-01-01, EUR as base and USD as quote. Copy the original decimal string.'),
  ], { source: 'IBM BFCL-FC-Robustness multiple_17', expected: { rate: '1.1370' },
    contract: 'Return a JSON object with exactly one field, rate (string). Dollar means US dollar.' }),
  ...group('retail-tracking-1', [
    adapted('τ³-bench retail 25, read-only lookup', 'My parcel may have gone to the wrong place. I’m Ari Sol in ZIP 31002 and I don’t have the number for my latest order. Find its tracking code and shipment status.'),
    synthetic('Can you check whether my newest purchase has arrived yet? Pull up the delivery reference too. The account is Ari Sol, postal code 31002.'),
    synthetic('Ari Sol / 31002 / most recent purchase. Need carrier reference and current delivery state.'),
    synthetic('Please locate the last purchase on the shopper profile for postal code 31002 and account holder Ari Sol, then tell me where the parcel stands and which code identifies it.'),
  ], { groupId: 'retail-tracking' }),
  ...group('airline-baggage-1', [
    adapted('τ³-bench airline 3, per-traveler allowance', 'I’m packing for confirmation R7B2. I’m pretty sure I’m Gold, but can you check the number of checked bags I personally get free? My traveler ID is trav-b.'),
    synthetic('If I show up with cases for the hold, how many can I hand over before paying? Use booking R7B2 and account trav-b, for that traveler only.'),
    synthetic('trav-b | R7B2 | individual complimentary checked-piece limit.'),
    synthetic('Determine the number of suitcases included for one passenger, traveler trav-b. Use their actual membership and the booked cabin on R7B2.'),
  ], { groupId: 'airline-baggage' }),
  ...group('airline-passengers-1', [
    adapted('τ³-bench airline 38, read-only passenger count', 'My last flight was delayed. I think there were three passengers on the reservation but could you check? The only ID I have is trav-b.'),
    synthetic('I can’t find the confirmation for the last trip I booked. I need the headcount on that booking. Look up my traveler profile, trav-b.'),
    synthetic('trav-b: headcount on the newest booking.'),
    synthetic('For traveler trav-b, find the latest ticketed itinerary and determine how many people are listed on its reservation.'),
  ], { groupId: 'airline-passengers' }),
  ...group('news-and-weather-1', [
    published('BFCL live_parallel_multiple_5-4-0', 'Could you fetch me the latest news from Paris, France, and also the current weather in Letterkenny, Ireland, in Celsius?'),
    synthetic('I need two unrelated briefing items: what’s the newest Paris headline, and what does the thermometer read in Letterkenny right now in Celsius?'),
    synthetic('Paris → newest local headline. Letterkenny → live air temperature, °C.'),
    synthetic('Prepare a two-field bulletin. Use the top current story for Paris and the latest Celsius reading for Letterkenny.'),
  ], { groupId: 'news-and-weather' }),
  ...[25, 100].flatMap(size => group(`audit-${size}-b`, [
    synthetic(`Reconcile the order ledger against the carrier feed for batch AUD-${size}B and report the overdue shipment exceptions.`),
    synthetic(`Dispatch is chasing orders from AUD-${size}B that should already have gone out. Cross-check what actually left and give us the exposure in cents and the affected order IDs and count.`),
    synthetic(`Batch AUD-${size}B. Past deadline ∩ still unshipped. Need number, IDs and combined order value.`),
    synthetic(`For AUD-${size}B, compare the sales records with the shipping records. Identify everything still in the warehouse after its ship-by date and quantify the affected orders and their total amount.`),
  ], { groupId: `shipment-audit-${size}` })),
];
