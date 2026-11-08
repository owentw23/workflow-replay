import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationEpisode } from '../eval/confirmation-agent.mjs';
import { confirmationCases, normalizeWeatherAnswer } from '../eval/confirmation-data.mjs';
import { collectReport, weatherRegistry, weatherRoutes } from '../eval/confirmation-weather.mjs';
import { startEvalFixture } from '../eval/fixture.mjs';
import { indexRouteExamples, openPlaybook, publish } from '../src/playbook.mjs';
import { httpDispatcher } from '../src/workflow.mjs';

test('scoring accepts the published city alias while preserving weather facts and answer shape', () => {
  const given = { readings: [{ city: 'New York City', celsius: 19, humidity: 59 }], warmest: 'New York City' };
  const expected = confirmationCases.find(entry => entry.id === 'forecast-1-a').expected;
  assert.equal(normalizeWeatherAnswer(given), normalizeWeatherAnswer(expected));
  assert.notEqual(normalizeWeatherAnswer({ ...given, warmest: 'London' }), normalizeWeatherAnswer(expected));
  assert.equal(normalizeWeatherAnswer([]), null);
});

test('collector and full replay return the same verified data, while playbook-only calls the model', async t => {
  const fixture = await startEvalFixture(weatherRegistry);
  t.after(() => fixture.close());
  const db = openPlaybook(':memory:');
  t.after(() => db.close());
  const dispatch = httpDispatcher(fixture.origin, weatherRegistry);
  const routes = weatherRoutes();
  const contracts = new Map(routes.map(({ route, contract }) => [route, contract]));
  for (const route of routes) {
    publish(db, route.route, route.description, route.plan);
    indexRouteExamples(db, route.route, route.examples);
  }
  const item = confirmationCases.find(entry => entry.id === 'forecast-8-b');
  const common = { item, db, registry: weatherRegistry, dispatch, contracts };
  const full = await confirmationEpisode({
    ...common, arm: 'host-routed', complete: () => assert.fail('Matched full replay should skip the model'),
  });
  assert.equal(full.correct, true);
  assert.equal(full.httpCalls, 16);
  assert.deepEqual(await collectReport({ cities: item.expected.readings.map(row => row.city), kind: 'forecast' }, dispatch),
    item.expected);
  const playbook = await confirmationEpisode({ ...common, arm: 'playbook-only', complete({ messages, tools }) {
    assert.equal(tools, undefined);
    assert.deepEqual(JSON.parse(messages.at(-1).content), item.expected.readings);
    return { choices: [{ message: { content: JSON.stringify(item.expected) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 30 } };
  } });
  assert.equal(playbook.correct, true);
  assert.equal(playbook.httpCalls, 16);
  assert.equal(playbook.turns, 1);

  for (const item of confirmationCases.filter(entry => entry.expectedRoute === null)) {
    let modelCalls = 0;
    const fallback = await confirmationEpisode({ ...common, item, arm: 'host-routed', complete() {
      modelCalls++;
      return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 } };
    } });
    assert.deepEqual(fallback.routes, []);
    assert.equal(fallback.httpCalls, 0);
    assert.equal(modelCalls, 1);
  }
});
