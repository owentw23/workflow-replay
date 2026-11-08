import { auditCases } from './audit.mjs';
import { cases } from './tasks.mjs';

function group(route, expected, positives, negatives) {
  return [
    ...positives.map((request, index) => ({ id: `${route}-positive-${index + 1}`, route, request, expected })),
    ...negatives.map((request, index) => ({ id: `${route}-near-miss-${index + 1}`, route: null, request })),
  ];
}

const answer = id => [...cases, ...auditCases].find(item => item.id === id).expected;

export const routingCases = [
  ...group('airline-passengers', answer('airline-passengers-1'), [
    'Find headcount on the newest booking for trav-b.',
    'Please report the number of people on the most recent itinerary for traveler trav-b.',
    'Check passenger count for the last reservation for trav-b.',
    'Pull up trav-b’s most recent trip and tell me how many seats are booked.',
  ], [
    'Find headcount on booking R7B2 for trav-b.',
    'Find headcount on the newest booking for trav-b, excluding children.',
    'Find headcount and names on the newest booking for trav-b.',
    'Find headcount on the newest booking for trav-b and trav-c.',
  ]),
  ...group('airline-baggage', answer('airline-baggage-1'), [
    'Please check complimentary hold bags for trav-b on R7B2.',
    'Show me the checked suitcase limit for traveler trav-b for confirmation R7B2.',
    'Find personal baggage allowance for trav-b on booking R7B2.',
    'How many suitcases could I send to the hold without a surcharge for my own seat? Booking R7B2, traveler trav-b.',
  ], [
    'Check complimentary hold bags for everyone on R7B2.',
    'Check carry-on bags for traveler trav-b on R7B2.',
    'Show me the checked suitcase limit for trav-b for R7B2 if I upgrade to business.',
    'Check complimentary hold bags for trav-b on R7B2 and the extra bag price.',
  ]),
  ...group('retail-tracking', answer('retail-tracking-1'), [
    'Look up the carrier reference and delivery state for the newest purchase for Ari Sol, postal code 31002.',
    'Report parcel code and shipment status for the last order from Ari Sol zip 31002.',
    'Check tracking and status for the most recent purchase for Ari Sol zip 31002.',
    'Ari Sol at 31002 here. Has my most recent parcel made it yet? I need the shipment code too.',
  ], [
    'Check tracking and status for the second newest purchase for Ari Sol zip 31002.',
    'Check tracking and status for order ord-c for Ari Sol zip 31002.',
    'Check tracking and status and change the delivery address for the latest order for Ari Sol zip 31002.',
    'Check tracking and status for the newest purchase for Ari Sol zip 31002, excluding gifts.',
  ]),
  ...group('weather-pair', answer('weather-pair-1'), [
    'Check the thermometer readings in Boston then San Francisco in °C.',
    'Find present air temperatures for Boston and San Francisco in degrees C.',
    'Please report current temperatures in Boston and San Francisco in Celsius.',
    'I’m calling someone on the other coast. How warm is it right now in Boston, then San Francisco? Give both numbers in Celsius.',
  ], [
    'Check the thermometer readings in Boston then San Francisco in Fahrenheit.',
    'Find tomorrow’s temperatures for Boston and San Francisco in degrees C.',
    'Report current temperatures and humidity in Boston and San Francisco in Celsius.',
    'Give the Paris headline and check current temperatures in Boston and San Francisco in Celsius.',
  ]),
  ...group('fx-pair', answer('fx-pair-1'), [
    'Find today’s FX quotes from USD into AUD then CAD.',
    'Show me the current conversion quotes from USD to AUD and CAD.',
    'Report current exchange rates from USD into AUD and CAD.',
    'One American dollar buys how much Australian and then Canadian currency right now?',
  ], [
    'Find exchange rates from USD into AUD then CAD as of 2022-01-01.',
    'Show me the current conversion quotes from USD to AUD and CAD after a 3% fee.',
    'Find today’s FX quotes from USD into AUD, CAD, and EUR.',
    'Find today’s FX quotes from USD into AUD then CAD and exchange 100 USD.',
  ]),
  ...group('historical-fx', { rate: '1.1370' }, [
    'Get the archived currency quote from EUR to USD on 2022-01-01.',
    'Find past FX rate from EUR to USD as of 2022-01-01.',
    'Report the historical exchange rate from EUR to USD on 2022-01-01.',
    'I have a euro receipt from New Year’s Day 2022. How many US dollars was a euro worth then?',
  ], [
    'Get the archived currency quote from EUR to USD on 2022-02-30.',
    'Find past FX rate from EUR to USD on 2022-01-01 and 2021-12-01.',
    'Get the archived currency quote from EUR to USD on 2022-01-01 with bank fees.',
    'Find the EUR to USD conversion right now and compare it to 2022-01-01.',
  ]),
  ...group('shipment-audit', answer('audit-100-b'), [
    'Please flag orders past deadline and still unshipped in batch AUD-100B.',
    'Report the overdue unshipped orders for batch AUD-100B.',
    'Reconcile the overdue shipment exceptions in batch AUD-100B.',
    'The warehouse owes us a list and value for everything in AUD-100B still sitting there past its shipping date.',
  ], [
    'Report the overdue unshipped orders for batch AUD-100B excluding orders under 500 cents.',
    'Flag orders past deadline but already shipped in batch AUD-100B.',
    'Reconcile the overdue shipment exceptions in batch AUD-100B and email the report.',
    'Report the overdue unshipped orders for batch AUD-100B and AUD-25B.',
  ]),
];
