import { json } from '../src/workflow.mjs';

const sum = values => values.reduce((a, b) => a + b, 0);
const rate = (a, b) => b ? a / b : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

export function schedule(cases, repeats, arms, seed) {
  let state = seed >>> 0;
  const shuffle = items => {
    for (let index = items.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const other = Math.floor(state / 2 ** 32 * (index + 1));
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  };
  return shuffle(Array.from({ length: repeats }, (_, repeat) =>
    cases.map(item => ({ item, repeat, arms: shuffle([...arms]) }))).flat());
}

function agreement(groups, signature) {
  let pairs = 0;
  let same = 0;
  for (const group of groups) {
    for (const [index, first] of group.entries()) {
      for (const second of group.slice(index + 1)) {
        pairs++;
        if (signature(first) !== null && signature(first) === signature(second)) same++;
      }
    }
  }
  return rate(same, pairs);
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const id = item[key];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return groups;
}

function summarizeArm(rows, repeats) {
  const groups = [...groupBy(rows, 'caseId').values()].filter(group => group.length === repeats);
  const correct = rows.filter(row => row.correct).length;
  const total = sum(rows.map(row => row.usage.total));
  const cached = sum(rows.map(row => row.usage.cached));
  const input = sum(rows.map(row => row.usage.input));
  const routed = rows.filter(row => row.expectedRoute && row.routes.includes(row.expectedRoute)).length;
  return {
    trials: rows.length, correct, accuracy: rate(correct, rows.length),
    passAll: rate(groups.filter(group => group.every(row => row.correct)).length, groups.length),
    completeCases: groups.length,
    answerAgreement: agreement(groups, row => row.normalized),
    traceAgreement: agreement(groups, row => json(row.trace.map(batch => batch.map(call => json(call)).sort()))),
    meanTokens: rate(total, rows.length), medianTokens: median(rows.map(row => row.usage.total)),
    total, input, output: total - input, cached, uncachedInput: input - cached,
    tokensPerCorrect: rate(total, correct),
    medianTurns: median(rows.map(row => row.turns)), medianHttp: median(rows.map(row => row.httpCalls)),
    medianMs: median(rows.map(row => row.ms)),
    expectedRouteHits: routed, eligibleRouteTrials: rows.filter(row => row.expectedRoute).length,
    unexpectedRouteTrials: rows.filter(row => row.routes.some(route => route !== row.expectedRoute)).length,
  };
}

function summarizeWording(rows, repeats, arms) {
  const groups = groupBy(rows.filter(row => row.group), 'group');
  if (!groups.size) return;
  function metrics(grouped, arm) {
    const blocksByGroup = [...grouped.values()].map(group =>
      [...groupBy(group.filter(row => row.arm === arm), 'repeat').values()]
        .filter(block => block.length === 4 && new Set(block.map(row => row.variant)).size === 4));
    const blocks = blocksByGroup.flat();
    const complete = blocksByGroup.filter(group => group.length === repeats);
    return {
      agreement: agreement(blocks, row => row.normalized),
      allCorrect: blocks.filter(block => block.every(row => row.correct)).length,
      completeBlocks: blocks.length,
      alwaysCorrect: complete.filter(group => group.every(block => block.every(row => row.correct))).length,
      completeGroups: complete.length,
    };
  }
  return {
    byArm: Object.fromEntries(arms.map(arm => [arm, metrics(groups, arm)])),
    byGroup: Object.fromEntries([...groups].map(([id, group]) => [id, Object.fromEntries(arms.map(arm => [
      arm, { ...summarizeArm(group.filter(row => row.arm === arm), repeats),
        ...metrics(new Map([[id, group]]), arm) },
    ]))])),
  };
}

export function summarize(rows, repeats, arms, learning) {
  const byArm = Object.fromEntries(arms.map(arm => [arm, summarizeArm(rows.filter(row => row.arm === arm), repeats)]));
  const byFamily = Object.fromEntries([...groupBy(rows, 'family')].map(([family, trials]) => [
    family, Object.fromEntries(arms.map(arm => [arm, summarizeArm(trials.filter(row => row.arm === arm), repeats)])),
  ]));
  const harness = arms.includes('host-routed') ? 'host-routed' : 'replay';
  const pairedSavings = Object.fromEntries(arms.filter(arm => arm !== harness).map(arm => {
    const baselines = new Map(rows.filter(row => row.arm === arm && row.correct)
      .map(row => [`${row.caseId}:${row.repeat}`, row]));
    const replay = rows.filter(row => row.arm === harness && row.correct && baselines.has(`${row.caseId}:${row.repeat}`));
    const baselineTokens = sum(replay.map(row => baselines.get(`${row.caseId}:${row.repeat}`).usage.total));
    const replayTokens = sum(replay.map(row => row.usage.total));
    return [arm, { pairs: replay.length, baselineTokens, replayTokens,
      fractionSaved: rate(baselineTokens - replayTokens, baselineTokens) }];
  }));
  const bySize = Object.fromEntries([...groupBy(rows.filter(row => row.size), 'size')].map(([size, trials]) => {
    const stats = Object.fromEntries(arms.map(arm => [arm, summarizeArm(trials.filter(row => row.arm === arm), repeats)]));
    const baseline = stats['direct-projected'];
    const routed = stats[harness];
    const saving = baseline.meanTokens - routed.meanTokens;
    const payback = learning && baseline.correct && routed.correct && saving > 0 ? {
      repeatsToBreakEven: Math.ceil(learning.compileUsage.total / saving),
      projectedTotals: [1, 5, 10, 50, 100].map(count => ({
        repeats: count,
        direct: Math.round(learning.discoveryUsage.total + count * baseline.meanTokens),
        harness: Math.round(learning.discoveryUsage.total + learning.compileUsage.total + count * routed.meanTokens),
      })),
    } : null;
    return [size, { ...stats, payback }];
  }));
  return { byArm, byFamily, pairedSavings, bySize, wording: summarizeWording(rows, repeats, arms) };
}
