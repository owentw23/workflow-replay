// Summary statistics and Markdown report for the v2 test bench.
const sum = values => values.reduce((a, b) => a + b, 0);
const rate = (a, b) => (b ? a / b : null);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const replayed = row => row.turns.some(turn => ['direct', 'carry', 'inject'].includes(turn.mode)
  || turn.tools?.some(tool => tool.name === 'run_workflow' || tool.speculated));

function armStats(rows) {
  const usage = key => sum(rows.map(row => row.usage[key]));
  const input = usage('input');
  const cached = usage('cached');
  const byItem = new Map();
  for (const row of rows) {
    if (!byItem.has(row.id)) byItem.set(row.id, []);
    byItem.get(row.id).push(row);
  }
  return {
    trials: rows.length, correct: rows.filter(row => row.correct).length,
    accuracy: rate(rows.filter(row => row.correct).length, rows.length),
    passAll: rate([...byItem.values()].filter(group => group.every(row => row.correct)).length, byItem.size),
    meanTokens: rate(usage('total'), rows.length), totalTokens: usage('total'), input, output: usage('output'), cached,
    uncachedInput: input - cached, meanUncachedInput: rate(input - cached, rows.length),
    meanModelCalls: rate(usage('calls'), rows.length), zeroModelCallTrials: rows.filter(row => row.usage.calls === 0).length,
    medianMs: median(rows.map(row => row.ms)), meanUpstreamCallsByModel: rate(sum(rows.map(row => row.upstream ?? 0)), rows.length),
    errors: rows.filter(row => row.error).length,
  };
}

export function summarize(trials, learning, { arms, repeats }) {
  const result = { repeats, arms: {}, byKind: {}, harness: {}, paired: {}, learning: {} };
  for (const arm of arms) result.arms[arm] = armStats(trials.filter(row => row.arm === arm));
  const kinds = [...new Set(trials.map(row => row.kind))];
  for (const kind of kinds) {
    result.byKind[kind] = Object.fromEntries(arms.map(arm => {
      const rows = trials.filter(row => row.arm === arm && row.kind === kind);
      const stats = armStats(rows);
      return [arm, { trials: stats.trials, accuracy: stats.accuracy, meanTokens: stats.meanTokens,
        meanModelCalls: stats.meanModelCalls, medianMs: stats.medianMs }];
    }));
  }

  const harnessRows = trials.filter(row => row.arm === 'harness');
  const turns = harnessRows.flatMap(row => row.turns.map((turn, index) => ({ ...turn, row, index })));
  const modes = {};
  for (const turn of turns) modes[turn.mode] = (modes[turn.mode] ?? 0) + 1;
  const eligibleFirst = harnessRows.filter(row => row.expectedHit);
  const preModelHits = eligibleFirst.filter(row => ['direct', 'carry', 'inject'].includes(row.turns[0]?.mode));
  const anyReplay = eligibleFirst.filter(replayed);
  const controls = harnessRows.filter(row => !row.expectedHit);
  const unsafe = controls.filter(replayed);
  const reasons = {};
  for (const turn of turns.filter(t => t.mode === 'fallback')) {
    const key = `${turn.router?.kind}: ${String(turn.router?.reason ?? '').replace(/\d+|"[^"]*"/g, '…').slice(0, 70)}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  result.harness = {
    modes, fallbackReasons: reasons,
    preModelHitRate: rate(preModelHits.length, eligibleFirst.length),
    anyReplayRate: rate(anyReplay.length, eligibleFirst.length),
    preModelHitAccuracy: rate(preModelHits.filter(row => row.turns[0].correct).length, preModelHits.length),
    runWorkflowCalls: turns.reduce((n, t) => n + (t.tools ?? []).filter(tool => tool.name === 'run_workflow').length, 0),
    speculations: turns.reduce((n, t) => n + (t.tools ?? []).filter(tool => tool.speculated).length, 0),
    partialPrefetches: turns.filter(t => t.partial).length,
    partialAccuracy: rate(turns.filter(t => t.partial && t.correct).length, turns.filter(t => t.partial).length),
    controlTrials: controls.length, replayOnControls: unsafe.length,
    wrongReplaysOnControls: unsafe.filter(row => !row.correct).length,
    wrongReplayIds: unsafe.filter(row => !row.correct).map(row => `${row.id}#${row.repeat}`),
    followUpTurn2Accuracy: rate(harnessRows.filter(row => row.kind === 'follow-up' && row.turns[1]?.correct).length,
      harnessRows.filter(row => row.kind === 'follow-up').length),
  };
  for (const baseline of arms.filter(arm => arm !== 'harness')) {
    const pairs = [];
    for (const row of harnessRows) {
      const other = trials.find(item => item.arm === baseline && item.id === row.id && item.repeat === row.repeat);
      if (other && other.correct && row.correct) pairs.push([other, row]);
    }
    const base = sum(pairs.map(([b]) => b.usage.total));
    const ours = sum(pairs.map(([, h]) => h.usage.total));
    const baseUncached = sum(pairs.map(([b]) => b.usage.input - b.usage.cached + b.usage.output));
    const oursUncached = sum(pairs.map(([, h]) => h.usage.input - h.usage.cached + h.usage.output));
    const repeatPairs = pairs.filter(([b]) => b.expectedHit);
    result.paired[baseline] = {
      pairs: pairs.length, baselineTokens: base, harnessTokens: ours, fractionSaved: rate(base - ours, base),
      fractionSavedUncached: rate(baseUncached - oursUncached, baseUncached),
      repeatPairs: repeatPairs.length,
      repeatFractionSaved: rate(sum(repeatPairs.map(([b]) => b.usage.total)) - sum(repeatPairs.map(([, h]) => h.usage.total)),
        sum(repeatPairs.map(([b]) => b.usage.total))),
      meanSavedPerRepeat: rate(sum(repeatPairs.map(([b, h]) => b.usage.total - h.usage.total)), repeatPairs.length),
    };
  }
  const projected = result.paired['baseline-projected'];
  result.learning = {
    tokens: learning.usage?.total ?? null, modelCalls: learning.usage?.calls ?? null,
    overheadTokens: learning.overhead?.total ?? null,
    routes: learning.routes, batches: learning.batches?.map(b => ({ episodes: b.episodes, successful: b.successful,
      candidates: b.candidates.length, rejected: b.rejected, merges: b.consolidated.filter(c => c.merged) })),
    shadow: learning.shadow,
    paybackRepeats: projected?.meanSavedPerRepeat > 0 && learning.overhead ? learning.overhead.total / projected.meanSavedPerRepeat : null,
  };
  return result;
}

const pct = value => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const num = value => (value === null || value === undefined ? 'n/a' : Math.round(value).toLocaleString('en-US'));

export function renderReport(s, { model, runDir }) {
  const arms = Object.keys(s.arms);
  const lines = [`# Workflow Replay v2 test bench`, '', `Model: \`${model}\`. Run: \`${runDir}\`. Repeats per item: ${s.repeats}.`, '',
    '## Overall', '', '| Arm | Accuracy | All repeats correct | Mean tokens | Mean uncached input | Mean model calls | Zero-call trials | Median ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const arm of arms) {
    const a = s.arms[arm];
    lines.push(`| ${arm} | ${pct(a.accuracy)} | ${pct(a.passAll)} | ${num(a.meanTokens)} | ${num(a.meanUncachedInput)} | ${a.meanModelCalls?.toFixed(2)} | ${a.zeroModelCallTrials} | ${num(a.medianMs)} |`);
  }
  lines.push('', '## By task kind', '', `| Kind | ${arms.map(arm => `${arm} acc / tokens`).join(' | ')} |`, `| --- | ${arms.map(() => '---').join(' | ')} |`);
  for (const [kind, byArm] of Object.entries(s.byKind)) {
    lines.push(`| ${kind} | ${arms.map(arm => `${pct(byArm[arm]?.accuracy)} / ${num(byArm[arm]?.meanTokens)}`).join(' | ')} |`);
  }
  const h = s.harness;
  lines.push('', '## Harness behaviour', '',
    `- Pre-model hit rate on repeat tasks: ${pct(h.preModelHitRate)} (accuracy of those hits ${pct(h.preModelHitAccuracy)}); any replay incl. compiled tool or speculation: ${pct(h.anyReplayRate)}.`,
    `- Modes per turn: ${Object.entries(h.modes).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `- Compiled-tool calls: ${h.runWorkflowCalls}; gateway speculations: ${h.speculations}; partial prefetches: ${h.partialPrefetches} (accuracy ${pct(h.partialAccuracy)}).`,
    `- Controls (near-miss, novel, compound): ${h.controlTrials} trials; replay used on ${h.replayOnControls}; wrong answers after a replay: ${h.wrongReplaysOnControls}${h.wrongReplayIds.length ? ` (${h.wrongReplayIds.join(', ')})` : ''}.`,
    `- Follow-up second-turn accuracy: ${pct(h.followUpTurn2Accuracy)}.`,
    '', 'Fallback reasons:', '', ...Object.entries(h.fallbackReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k} (${v})`),
    '', '## Paired savings (both arms correct on the same item and repeat)', '',
    '| Versus | Pairs | Tokens saved | Uncached tokens saved | Repeat-task pairs | Saved on repeat tasks | Mean tokens saved per repeat |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [baseline, p] of Object.entries(s.paired)) {
    lines.push(`| ${baseline} | ${p.pairs} | ${pct(p.fractionSaved)} | ${pct(p.fractionSavedUncached)} | ${p.repeatPairs} | ${pct(p.repeatFractionSaved)} | ${num(p.meanSavedPerRepeat)} |`);
  }
  const l = s.learning;
  lines.push('', '## Learning phase', '',
    `- Learning traffic: ${num(l.tokens)} tokens over ${num(l.modelCalls)} model calls (ordinary agent work that would happen anyway, recorded).`,
    `- Extra cost of learning (router calls during shadow): ${num(l.overheadTokens)} tokens. Payback: ${l.paybackRepeats === null ? 'n/a' : `${l.paybackRepeats.toFixed(1)} repeat requests`}.`,
    ...(l.batches ?? []).map((b, i) => `- Batch ${i + 1}: ${b.successful}/${b.episodes} correct episodes, ${b.candidates} candidate plans, ${b.rejected.length} clusters rejected, ${b.merges.length} merges.`),
    '', '| Route | State | Steps | Inputs | Outputs | Shadow | Prefix rate |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...(l.routes ?? []).map(r => `| ${r.id} | ${r.state}${r.mergedInto ? ` → ${r.mergedInto}` : ''} | ${r.steps.join(' → ')} | ${Object.entries(r.inputs).map(([k, v]) => `${k}${v.allowed ? `∈{${v.allowed.join(',')}}` : ''}`).join(', ')} | ${r.outputs.join(', ')} | ${r.shadow ? `${r.shadow.agree}/${r.shadow.disagree}` : ''} | ${r.prefix ? r.prefix.rate.toFixed(2) : ''} |`));
  return lines.join('\n') + '\n';
}
